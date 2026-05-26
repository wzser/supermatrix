import { randomUUID } from "node:crypto";
import type { ResultSink } from "../domain/childCapabilities.ts";
import type { LarkGroupId, MessageRunId, SessionId, Timestamp } from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import type { TopicBus } from "../ports/TopicBus.ts";

/**
 * Writes the child's final message to every declared resultSink destination.
 *
 * Wiring plan:
 *  - step 5 (this file): dispatch structure + no-side-effects sinks.
 *  - step 6 adds `parent_continuation_inject` (synthetic inbox injection).
 *  - step 7 adds `chat_post` (user / bot identity, via lark-cli).
 *  - step 8 adds `eventbus_publish` (named topic payload).
 *
 * `http_response`, `pollable_endpoint`, `audit_only` are intentional
 * no-ops: their "delivery" is already covered by the returned promise,
 * the DB row, or `cross_session_log` respectively.
 *
 * Sync-inline caller invocation short-circuits the engine entirely — for
 * `sync_inline` children, the HTTP / command handler owns delivery and
 * routing the finalMessage via sinks would double-post.
 */

export type ResultSinkDeps = {
  store: BindingStore;
  eventBus?: EventBus;
  topicBus?: TopicBus;
  logger?: Logger;
  /**
   * Chat-post delivery is pluggable so tests and future types can stub it.
   * Production wiring will pass a `lark.sendMessage`-shaped function (step 7).
   */
  postToChat?: (groupId: LarkGroupId, text: string, identity: "bot" | "user") => Promise<void>;
  /**
   * Continuation delivery is pluggable. Production wiring will pass a
   * "synthesize inbox message" function (step 6 subsystem).
   */
  injectContinuation?: (info: {
    parentSessionId: SessionId;
    childSession: Session;
    finalMessage: string;
  }) => Promise<void>;
};

export type DeliverySummary = {
  delivered: Array<{ sinkKind: ResultSink["kind"]; ok: boolean; note?: string; errorMessage?: string }>;
};

export async function deliverResultSinks(
  session: Session,
  finalMessage: string,
  deps: ResultSinkDeps,
): Promise<DeliverySummary> {
  return deliverDeclaredResultSinks(session, finalMessage, deps, { respectSyncInline: true });
}

export async function redeliverResultSinks(input: {
  session: Session;
  finalMessage: string;
  messageRunId: MessageRunId;
  spawnCommId: string | null;
  deps: ResultSinkDeps;
  now?: () => Timestamp;
  idFactory?: (sinkIndex: number) => string;
}): Promise<DeliverySummary> {
  const summary = await deliverDeclaredResultSinks(input.session, input.finalMessage, input.deps, {
    respectSyncInline: false,
  });
  const createdAt = input.now ? input.now() : Date.now() as Timestamp;
  for (const [sinkIndex, outcome] of summary.delivered.entries()) {
    await input.deps.store.recordResultSinkAttempt({
      id: input.idFactory ? input.idFactory(sinkIndex) : `sink_redeliver_${randomUUID()}`,
      spawnCommId: input.spawnCommId,
      childSessionId: input.session.id,
      messageRunId: input.messageRunId,
      sinkIndex,
      sinkKind: outcome.sinkKind,
      status: statusForOutcome(outcome),
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      createdAt,
    });
  }
  return summary;
}

async function deliverDeclaredResultSinks(
  session: Session,
  finalMessage: string,
  deps: ResultSinkDeps,
  options: { respectSyncInline: boolean },
): Promise<DeliverySummary> {
  const summary: DeliverySummary = { delivered: [] };

  // Sync_inline: the HTTP / command handler owns delivery via its return
  // value. Engine stays out of the way.
  if (options.respectSyncInline && session.callerInvocation === "sync_inline") {
    summary.delivered.push({ sinkKind: "http_response", ok: true, note: "skipped: sync_inline handler owns delivery" });
    return summary;
  }

  const sinks = session.capabilityPayload?.resultSinks ?? [];
  if (sinks.length === 0) {
    deps.logger?.warn("deliverResultSinks called with empty sinks", { sessionId: session.id });
    return summary;
  }

  for (const sink of sinks) {
    const outcome = await deliverOneSafely(sink, session, finalMessage, deps);
    summary.delivered.push({ sinkKind: sink.kind, ...outcome });
  }
  return summary;
}

async function deliverOneSafely(
  sink: ResultSink,
  session: Session,
  finalMessage: string,
  deps: ResultSinkDeps,
): Promise<{ ok: boolean; note?: string; errorMessage?: string }> {
  try {
    return await deliverOne(sink, session, finalMessage, deps);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, note: "delivery failed", errorMessage };
  }
}

async function deliverOne(
  sink: ResultSink,
  session: Session,
  finalMessage: string,
  deps: ResultSinkDeps,
): Promise<{ ok: boolean; note?: string }> {
  switch (sink.kind) {
    case "http_response":
    case "pollable_endpoint":
    case "audit_only":
      return { ok: true, note: "no-op by design" };

    case "chat_post": {
      if (!deps.postToChat) {
        return { ok: false, note: "postToChat not wired (step 7)" };
      }
      const chatId = await resolveChatRef(sink.chatRef, session, deps);
      if (!chatId) {
        return { ok: false, note: "could not resolve chat reference" };
      }
      await deps.postToChat(chatId, finalMessage, sink.identity);
      return { ok: true };
    }

    case "eventbus_publish": {
      if (!deps.topicBus) {
        return { ok: false, note: "topicBus not wired" };
      }
      // Payload shape is fixed here: subscribers can expect the contract.
      // Publishers that need richer metadata can carry it in the child's
      // final_message (JSON-in-string) or extend the shape later by adding
      // new fields — kind + child_session_id + final_message stay stable.
      await deps.topicBus.publish(sink.topic, {
        kind: "child_final_message",
        childSessionId: session.id,
        childName: session.name,
        childType: session.childType,
        finalMessage,
        publishedAtMs: Date.now(),
      });
      return { ok: true };
    }

    case "parent_continuation_inject": {
      if (!deps.injectContinuation) {
        return { ok: false, note: "injectContinuation not wired (step 6)" };
      }
      await deps.injectContinuation({
        parentSessionId: sink.parentSessionId,
        childSession: session,
        finalMessage,
      });
      return { ok: true };
    }
  }
}

async function resolveChatRef(
  chatRef: Extract<ResultSink, { kind: "chat_post" }>["chatRef"],
  session: Session,
  deps: ResultSinkDeps,
): Promise<LarkGroupId | null> {
  switch (chatRef.kind) {
    case "explicit":
      return chatRef.chatId as LarkGroupId;
    case "parent": {
      if (!session.parentId) return null;
      const binding = await deps.store.findBySession(session.parentId);
      return binding?.groupId ?? null;
    }
    case "requester":
    case "reply_to":
      // These refs require spawn-time context the engine doesn't have yet.
      // Step 7 extends capability_payload with resolved chat ids so the
      // engine can look them up directly.
      deps.logger?.warn("chat_post chatRef not yet resolvable by engine", {
        sessionId: session.id,
        refKind: chatRef.kind,
      });
      return null;
  }
}

function statusForOutcome(
  outcome: DeliverySummary["delivered"][number],
): "delivered" | "skipped" | "failed" {
  if (!outcome.ok) return "failed";
  if (outcome.note?.startsWith("skipped:")) return "skipped";
  return "delivered";
}
