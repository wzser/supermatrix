import type { ChildSessionType } from "../domain/childCapabilities.ts";
import type { LarkGroupId, SessionId } from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { InboundMessage } from "../ports/LarkGateway.ts";
import type { Logger } from "../ports/Logger.ts";

/**
 * Continuation dispatcher — step 6 of the scenario-driven child-session redesign.
 *
 * When a child session with `continuation_hook='inject_result'` completes, we
 * need a way to wake the parent session's backend and let it react to the
 * child's output. The plan chose "synthetic inbox injection": we synthesize
 * an InboundMessage that looks like a user message but carries a structured
 * system envelope (XML-ish), then feed it into the existing dispatcher so the
 * parent's normal run pipeline processes it.
 *
 * Tracking lives in `cross_session_log` with `kind='continuation'`, reusing
 * the existing columns:
 *   - from_session_id = the child session (the "sender" of the completion)
 *   - to_session_id   = the parent session (receiver)
 *   - child_session_id = child.id (redundant with from for this kind, kept
 *                        for compatibility with the spawn-kind semantics)
 *   - message_run_id   = parent's run id after it processes the envelope
 *                        (note: for spawn-kind this is the child's run id;
 *                        the column has always been shape-first, not semantics-first)
 *   - final_message    = parent's response text, when a run completes
 *
 * If the parent is busy when the continuation fires, we record the failed
 * delivery attempt and register it for watcher follow-up. Terminal parents
 * remain failed rows for adjudication.
 */

export type ContinuationDispatcherDeps = {
  store: BindingStore;
  clock: Clock;
  idFactory: () => string;
  /** Parent's normal inbound pipeline. */
  dispatcher: {
    handleInbound(msg: InboundMessage): Promise<void>;
  };
  /**
   * Synthetic messages still need a Feishu group to route through — we use
   * the parent's bound group. If the parent has no binding (e.g. a child
   * of a child), we fall back to a synthetic marker so the NOT-NULL column
   * has a value (same pattern childSession.ts already uses).
   */
  logger?: Logger;
};

export type ContinuationTriggerInfo = {
  parentSessionId: SessionId;
  childSession: Session;
  finalMessage: string;
};

export function createContinuationDispatcher(deps: ContinuationDispatcherDeps) {
  const log = deps.logger?.child({ mod: "continuation" });

  async function injectContinuation(info: ContinuationTriggerInfo): Promise<void> {
    const { parentSessionId, childSession, finalMessage } = info;
    const commId = `comm_cont_${deps.idFactory()}`;
    const now = deps.clock.now();

    const envelope = buildContinuationEnvelope({
      childSessionId: childSession.id,
      childSessionName: childSession.name,
      childType: childSession.childType,
      finalMessage,
    });

    // Always record the continuation attempt so operators can audit it later.
    await deps.store.logCrossSessionComm({
      id: commId,
      fromSessionId: childSession.id,
      toSessionId: parentSessionId,
      kind: "continuation",
      prompt: envelope,
      createdAt: now,
    });

    const parent = await deps.store.findSessionById(parentSessionId);
    if (!parent) {
      const msg = `parent session not found: ${parentSessionId}`;
      log?.warn("continuation skipped: parent missing", {
        parentSessionId,
        childSessionId: childSession.id,
      });
      await deps.store.finishCrossSessionComm(
        commId, "failed", childSession.id, undefined, msg,
      );
      await recordFailedSinkAttempt(commId, childSession, msg);
      return;
    }
    if (parent.status === "deleted" || parent.status === "error") {
      const msg = `parent status=${parent.status}; continuation requires adjudication`;
      log?.info("continuation skipped: parent terminal", {
        commId,
        parentSessionId,
        parentStatus: parent.status,
        childSessionId: childSession.id,
      });
      await deps.store.finishCrossSessionComm(
        commId, "failed", childSession.id, undefined, msg,
      );
      await recordFailedSinkAttempt(commId, childSession, msg);
      return;
    }
    if (parent.status === "busy") {
      const msg = "parent busy; continuation deferred to watcher delivery";
      log?.info("continuation skipped: parent busy", {
        commId,
        parentSessionId,
        childSessionId: childSession.id,
      });
      await deps.store.finishCrossSessionComm(
        commId,
        "failed",
        childSession.id,
        previewText(finalMessage),
        msg,
        finalMessage,
      );
      await recordFailedSinkAttempt(commId, childSession, msg);
      await deps.store.registerSpawnAsyncItem({
        ref: `async_${commId}`,
        commId,
        callerSession: parent.name,
        targetSession: parent.name,
        failedPhase: "delivery",
        failureKind: "late_result",
        status: "waiting_child",
        createdAt: now,
        updatedAt: now,
      });
      return;
    }

    const parentBinding = await deps.store.findBySession(parent.id);
    const groupId: LarkGroupId =
      parentBinding?.groupId ?? (`cont:${parent.id}` as LarkGroupId);

    // Synthesize an inbound message. We mark the messageId and userId with a
    // `continuation_` prefix so ops logs make it easy to distinguish these
    // from real user input.
    const synthetic: InboundMessage = {
      groupId,
      messageId: `continuation_${commId}`,
      userId: `continuation:${childSession.id}`,
      text: envelope,
      attachments: [],
      receivedAtMs: Date.now(),
    };

    log?.info("continuation injecting", {
      parentSessionId,
      childSessionId: childSession.id,
      commId,
      groupId,
      hasParentBinding: Boolean(parentBinding),
    });

    try {
      await deps.dispatcher.handleInbound(synthetic);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn("continuation handleInbound threw", {
        commId,
        parentSessionId,
        err: errMsg,
      });
      await deps.store.finishCrossSessionComm(
        commId, "failed", childSession.id, undefined, errMsg,
      );
      await recordFailedSinkAttempt(commId, childSession, "handleInbound threw", errMsg);
      return;
    }

    // After handleInbound returns, the parent's latest run should be the one
    // that processed this continuation. Pull its outcome to complete the log.
    const latestRun = await deps.store.findLatestMessageRunBySession(parent.id);
    if (!latestRun) {
      await deps.store.finishCrossSessionComm(
        commId, "completed", childSession.id, undefined, undefined,
        undefined, undefined,
      );
      return;
    }

    const preview = latestRun.finalMessage
      ? latestRun.finalMessage.length > 500
        ? latestRun.finalMessage.slice(0, 500) + "..."
        : latestRun.finalMessage
      : undefined;

    await deps.store.finishCrossSessionComm(
      commId,
      latestRun.status === "completed" ? "completed" : "failed",
      childSession.id,
      preview,
      latestRun.errorMessage ?? undefined,
      latestRun.finalMessage ?? undefined,
      latestRun.id,
    );
  }

  async function recordFailedSinkAttempt(
    commId: string,
    childSession: Session,
    note: string,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await deps.store.recordResultSinkAttempt({
        id: `sink_${commId}_parent_continuation_inject`,
        spawnCommId: commId,
        childSessionId: childSession.id,
        sinkIndex: 0,
        sinkKind: "parent_continuation_inject",
        status: "failed",
        note,
        ...(errorMessage ? { errorMessage } : {}),
        createdAt: deps.clock.now(),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn("recordResultSinkAttempt failed for continuation", {
        commId,
        childSessionId: childSession.id,
        err: errMsg,
      });
    }
  }

  return { injectContinuation };
}

export type ContinuationEnvelopeInput = {
  childSessionId: SessionId;
  childSessionName: string;
  childType: ChildSessionType | null;
  finalMessage: string;
};

/**
 * Builds the XML-ish envelope injected into the parent's message queue.
 * Structured tags let the parent's LLM backend distinguish "system
 * notification of a child's completion" from "user input", without
 * introducing a new cross-backend concept.
 */
export function buildContinuationEnvelope(input: ContinuationEnvelopeInput): string {
  const type = input.childType ?? "unknown";
  return [
    `<sm-child-completed child_id="${input.childSessionId}" child_name="${escapeAttr(input.childSessionName)}" child_type="${type}">`,
    `<result>`,
    input.finalMessage,
    `</result>`,
    `</sm-child-completed>`,
  ].join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function previewText(value: string): string {
  return value.length > 500 ? value.slice(0, 500) + "..." : value;
}
