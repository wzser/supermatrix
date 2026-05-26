import type { SessionEvent } from "../domain/events/sessionEvent.ts";
import {
  asMessageRunId,
  type LarkGroupId,
  type MessageRunId,
  type SessionId,
} from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type { BackendRegistry } from "../ports/AgentBackend.ts";
import type { BindingStore, RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import { classifyRunStatus } from "./runStatus.ts";
import { collectStream } from "./streamCollector.ts";

// runOnSession: drive a prompt on an EXISTING user-scope session, resuming
// its main backend_session_id. Mirrors dispatcher.handleInbound's run loop
// but skips the chat-coupled bits (Lark card postCard/updateCard, slash
// command routing, attachment ingestion). Used by POST /api/run so a
// sibling session can ask, e.g., amzdata to follow up in its own context
// without polluting amzdata's chat with a synthetic --as-user message.
//
// Status semantics intentionally mirror an in-chat user prompt:
//   idle → busy → idle, message_runs row, cross_session_log if requested.
// Concurrent runs are rejected (kind="busy") rather than queued — API
// callers handle 409 retry; chat queueing via PendingNext stays a chat-only
// concern.

export type RunOnSessionDeps = {
  store: BindingStore;
  backendRegistry: BackendRegistry;
  clock: Clock;
  idFactory: () => string;
  eventBus?: EventBus;
  logger?: Logger;
  monotonic?: () => number;
};

export type RunOnSessionInput = {
  session: Session;
  prompt: string;
  groupId: LarkGroupId;
  requesterSessionId?: SessionId;
};

export type RunOnSessionResult =
  | {
      kind: "ok";
      runId: MessageRunId;
      finalMessage: string;
      backendSessionId: string | null;
      runStatus: RunStatus;
    }
  | {
      kind: "error";
      runId: MessageRunId;
      finalMessage: string;
      error: string;
      runStatus: RunStatus;
    }
  | { kind: "busy"; currentRunId: MessageRunId | null };

export async function runOnSession(
  deps: RunOnSessionDeps,
  input: RunOnSessionInput,
): Promise<RunOnSessionResult> {
  const { store, backendRegistry, clock, idFactory } = deps;
  const session = input.session;
  const log = deps.logger?.child({ mod: "runOnSession" });
  const monotonic = deps.monotonic ?? (() => Date.now());

  // Busy gate — refuse rather than queue. PendingNext is chat-only, where
  // overwriting a stale queued entry is fine; API callers want explicit
  // 409 so they can decide whether to retry.
  if (session.status === "busy") {
    const running = await store.findRunningMessageRunBySession(session.id);
    return { kind: "busy", currentRunId: running?.id ?? null };
  }
  const lingering = await store.findRunningMessageRunBySession(session.id);
  if (lingering) {
    return { kind: "busy", currentRunId: lingering.id };
  }

  const emit = (event: SessionEvent) =>
    deps.eventBus ? deps.eventBus.publish(event) : Promise.resolve();

  // Open cross-session log if a requester was supplied.
  const commId = input.requesterSessionId
    ? `comm_run_${session.id.slice(-8)}_${Date.now()}`
    : null;
  if (commId && input.requesterSessionId) {
    await store.logCrossSessionComm({
      id: commId,
      fromSessionId: input.requesterSessionId,
      toSessionId: session.id,
      kind: "resume_main",
      prompt: input.prompt,
      childModel: session.model,
      createdAt: clock.now(),
    });
  }

  const runId = asMessageRunId(idFactory());
  await store.startMessageRun({
    id: runId,
    sessionId: session.id,
    groupId: input.groupId,
    prompt: input.prompt,
    startedAt: clock.now(),
  });
  await store.updateSessionStatus(session.id, "busy", clock.now());
  await emit({
    kind: "session_status_changed",
    sessionId: session.id,
    from: "idle",
    to: "busy",
  });
  log?.info("run started", {
    runId,
    sessionId: session.id,
    sessionName: session.name,
    backend: session.backend,
    resume: session.backendSessionId ?? null,
    requestedBy: input.requesterSessionId ?? null,
  });
  const runStartedAtMs = monotonic();

  const concludeIdle = async (wasCleared: boolean) => {
    if (wasCleared) return;
    await store.updateSessionStatus(session.id, "idle", clock.now());
    await emit({
      kind: "session_status_changed",
      sessionId: session.id,
      from: "busy",
      to: "idle",
    });
  };

  try {
    const usageBaseline =
      session.backend === "codex"
        ? await store.getLatestTokenUsageRawTotals(session.id)
        : null;
    const stream = backendRegistry.get(session.backend).run({
      session,
      prompt: input.prompt,
      attachments: [],
    });
    const collected = await collectStream(stream, {
      ...(usageBaseline
        ? { usageBaseline, normalizeCumulativeUsage: true }
        : {}),
    });

    // Re-read so a /restart or /reset that landed mid-run isn't clobbered
    // (mirrors dispatcher.handleInbound's wasCleared check).
    const afterRun = await store.findSessionById(session.id);
    const wasCleared =
      afterRun?.backendSessionId === null && afterRun?.status === "idle";

    if (collected.backendSessionId && !wasCleared) {
      await store.updateSessionBackendSessionId(
        session.id,
        collected.backendSessionId,
      );
    }
    if (collected.usage && !wasCleared) {
      await store.recordTokenUsage({
        sessionId: session.id,
        messageRunId: runId,
        backend: session.backend,
        model: collected.usage.model ?? session.model ?? null,
        inputTokens: collected.usage.inputTokens,
        outputTokens: collected.usage.outputTokens,
        cacheReadTokens: collected.usage.cacheReadTokens,
        cacheWriteTokens: collected.usage.cacheWriteTokens,
        reasoningTokens: collected.usage.reasoningTokens,
        rawUsageJson: collected.usage.rawUsageJson,
        createdAt: clock.now(),
      });
    }

    const streamLogJson =
      collected.streamLog && collected.streamLog.length > 0
        ? JSON.stringify(collected.streamLog)
        : undefined;
    const runStatus = classifyRunStatus(collected.error);

    if (collected.error) {
      await store.finishMessageRun(
        runId,
        runStatus,
        collected.finalMessage,
        collected.error,
        streamLogJson,
      );
      if (commId) {
        await store.finishCrossSessionComm(
          commId,
          "failed",
          undefined,
          collected.finalMessage
            ? collected.finalMessage.slice(0, 500)
            : undefined,
          collected.error,
          collected.finalMessage || undefined,
          runId,
        );
      }
      await concludeIdle(wasCleared);
      log?.warn("run finished with error", {
        runId,
        sessionId: session.id,
        durationMs: monotonic() - runStartedAtMs,
        error: collected.error,
        cleared: wasCleared,
      });
      return {
        kind: "error",
        runId,
        finalMessage: collected.finalMessage,
        error: collected.error,
        runStatus,
      };
    }

    await store.finishMessageRun(
      runId,
      "completed",
      collected.finalMessage,
      undefined,
      streamLogJson,
    );
    if (commId) {
      const preview =
        collected.finalMessage.length > 500
          ? collected.finalMessage.slice(0, 500) + "..."
          : collected.finalMessage;
      await store.finishCrossSessionComm(
        commId,
        "completed",
        undefined,
        preview,
        undefined,
        collected.finalMessage,
        runId,
      );
    }
    await concludeIdle(wasCleared);
    log?.info("run completed", {
      runId,
      sessionId: session.id,
      durationMs: monotonic() - runStartedAtMs,
      backendSessionId: collected.backendSessionId ?? null,
      finalLength: collected.finalMessage.length,
      cleared: wasCleared,
    });
    return {
      kind: "ok",
      runId,
      finalMessage: collected.finalMessage,
      backendSessionId: collected.backendSessionId,
      runStatus: "completed",
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const runStatus = classifyRunStatus(errMsg);
    try {
      await store.finishMessageRun(runId, runStatus, undefined, errMsg);
    } catch {
      // best-effort — store may be closing during shutdown
    }
    if (commId) {
      try {
        await store.finishCrossSessionComm(
          commId,
          "failed",
          undefined,
          undefined,
          errMsg,
          undefined,
          runId,
        );
      } catch {
        // best-effort
      }
    }
    try {
      await store.updateSessionStatus(session.id, "idle", clock.now());
      await emit({
        kind: "session_status_changed",
        sessionId: session.id,
        from: "busy",
        to: "idle",
      });
    } catch {
      // best-effort
    }
    log?.error("run threw", {
      runId,
      sessionId: session.id,
      durationMs: monotonic() - runStartedAtMs,
      error: errMsg,
    });
    return { kind: "error", runId, finalMessage: "", error: errMsg, runStatus };
  }
}
