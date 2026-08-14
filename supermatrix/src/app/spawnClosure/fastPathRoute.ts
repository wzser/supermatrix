import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Session } from "../../domain/session.ts";
import type { SessionId, Timestamp } from "../../domain/ids.ts";
import type {
  BindingStore,
  DeliverableSpawnAsyncItemStatus,
  SpawnAsyncItemRecord,
} from "../../ports/BindingStore.ts";
import type { Logger } from "../../ports/Logger.ts";
import {
  describeHeartbeatEnqueueFailure,
  HeartbeatEnqueueRejected,
  parseHeartbeatEnqueueConfirmation,
} from "./heartbeatEnqueue.ts";

const execFileAsync = promisify(execFile);

export type RouteCompletedSpawnClosureResult =
  | { action: "delivered"; ref: string; commId: string }
  | { action: "noop"; ref: string; commId: string; reason: string };

type FastPathStore = Pick<
  BindingStore,
  | "getSpawnAsyncItem"
  | "listResultSinkAttemptsBySpawn"
  | "claimSpawnAsyncItemForDelivery"
  | "markSpawnAsyncItemAdjudicationEscalated"
  | "markSpawnAsyncItemDelivered"
  | "parkSpawnAsyncItemDeliveryUnsupported"
  | "releaseSpawnAsyncItemDelivery"
  | "findSessionById"
>;

/**
 * Tells the caller (in its own bound group) that a completed result exists but
 * cannot be pushed, so it can pull it with take. Wired by bootstrap against the
 * console notifier; a throw here must never break the closure state machine.
 */
export type UndeliverableResultNotifier = (input: {
  callerSession: string;
  targetSession: string;
  commId: string;
  ref: string;
  reason: string;
}) => Promise<void>;

export async function routeCompletedSpawnClosure(input: {
  ref: string;
  commId: string;
  store: FastPathStore;
  heartbeatEnqueuePath: string;
  sourceSession: string;
  now: Timestamp;
  logger?: Logger;
  notifyUndeliverable?: UndeliverableResultNotifier;
}): Promise<RouteCompletedSpawnClosureResult> {
  const item = await input.store.claimSpawnAsyncItemForDelivery(input.ref, input.now);
  if (!item) return { action: "noop", ref: input.ref, commId: input.commId, reason: "async item is not deliverable" };

  const previousStatus = item.status as DeliverableSpawnAsyncItemStatus;
  let enqueued = false;
  try {
    if (item.commId !== input.commId) {
      await input.store.releaseSpawnAsyncItemDelivery(input.ref, previousStatus, input.now);
      return { action: "noop", ref: input.ref, commId: input.commId, reason: "comm id mismatch" };
    }
    if (item.commStatus !== "completed" || !item.finalMessage?.trim()) {
      await input.store.releaseSpawnAsyncItemDelivery(input.ref, previousStatus, input.now);
      return { action: "noop", ref: input.ref, commId: input.commId, reason: "completed result is not ready" };
    }
    if (await hasWrittenSyncInlineResponse(input.store, item.commId, input.logger)) {
      const finalized = await input.store.markSpawnAsyncItemDelivered(input.ref, {
        verdict: "delivered",
        reason: "sync_inline response already written; caller received the result over HTTP",
      }, input.now);
      if (!finalized) {
        input.logger?.warn("delivery finalize lost; concurrent consumption may have occurred", {
          comm_id: input.commId,
          ref: input.ref,
        });
      }
      input.logger?.info("spawn closure fast-path suppressed already-written sync_inline response", {
        comm_id: input.commId,
        ref: input.ref,
        caller_session: item.callerSession,
        target_session: item.targetSession,
      });
      return {
        action: "noop",
        ref: input.ref,
        commId: input.commId,
        reason: "sync_inline response already written; heartbeat delivery suppressed",
      };
    }
    const pushedSink = await hasSuccessfulPushSink(input.store, item.commId, input.logger);
    if (pushedSink) {
      const finalized = await input.store.markSpawnAsyncItemDelivered(input.ref, {
        verdict: "delivered",
        reason: `${pushedSink} delivery already completed; heartbeat delivery suppressed`,
      }, input.now);
      if (!finalized) {
        input.logger?.warn("delivery finalize lost; concurrent consumption may have occurred", {
          comm_id: input.commId,
          ref: input.ref,
        });
      }
      input.logger?.info("spawn closure fast-path suppressed already-delivered push sink", {
        comm_id: input.commId,
        ref: input.ref,
        sink_kind: pushedSink,
        caller_session: item.callerSession,
        target_session: item.targetSession,
      });
      return {
        action: "noop",
        ref: input.ref,
        commId: input.commId,
        reason: `${pushedSink} delivery already completed; heartbeat delivery suppressed`,
      };
    }
    if (isSpawnAdjudicationClientRequestId(item.clientRequestId)) {
      const adjudicationResult = await finalizeCompletedAdjudication(input.store, item, input.now);
      const finalized = await input.store.markSpawnAsyncItemDelivered(input.ref, {
        verdict: "adjudication_result_recorded",
        reason: adjudicationResult.reason,
      }, input.now);
      if (!finalized) {
        input.logger?.warn("delivery finalize lost; concurrent consumption may have occurred", {
          comm_id: input.commId,
          ref: input.ref,
        });
      }
      input.logger?.info("spawn closure fast-path suppressed adjudication heartbeat todo", {
        comm_id: input.commId,
        ref: input.ref,
        caller_session: item.callerSession,
        target_session: item.targetSession,
        reason: adjudicationResult.reason,
      });
      return {
        action: "noop",
        ref: input.ref,
        commId: input.commId,
        reason: adjudicationResult.reason,
      };
    }

    // Re-check claim ownership before enqueue: take may have stolen the
    // delivering item since claim. Do not release — the new owner owns state.
    const stillClaimed = await input.store.getSpawnAsyncItem(input.ref);
    if (!stillClaimed || stillClaimed.status !== "delivering") {
      return {
        action: "noop",
        ref: input.ref,
        commId: input.commId,
        reason: "delivery claim lost before enqueue",
      };
    }

    const childSession = item.childSessionId
      ? await input.store.findSessionById(item.childSessionId as SessionId)
      : null;
    await enqueueHeartbeatTodo({
      item,
      finalMessage: item.finalMessage,
      childSession,
      heartbeatEnqueuePath: input.heartbeatEnqueuePath,
      sourceSession: input.sourceSession,
    });
    enqueued = true;
    const finalized = await input.store.markSpawnAsyncItemDelivered(input.ref, {
      verdict: "delivered",
      reason: "fast-path heartbeat todo enqueued for caller",
    }, input.now);
    if (!finalized) {
      input.logger?.warn("delivery finalize lost; concurrent consumption may have occurred", {
        comm_id: input.commId,
        ref: input.ref,
      });
    }
    input.logger?.info("spawn closure fast-path delivered", {
      comm_id: input.commId,
      ref: input.ref,
      caller_session: item.callerSession,
      target_session: item.targetSession,
    });
    return { action: "delivered", ref: input.ref, commId: input.commId };
  } catch (err) {
    if (enqueued) throw err;
    const failure = describeHeartbeatEnqueueFailure(err);
    if (!failure.callerHeartbeatDisabled) {
      await input.store.releaseSpawnAsyncItemDelivery(input.ref, previousStatus, input.now);
      throw err;
    }
    // Deterministic dead end: the caller cannot accept heartbeat todos at all,
    // so releasing the claim would only hand the watcher an identical failure
    // to repeat until the attempt budget is gone. Settle terminally instead and
    // point the caller at take.
    const reason = `${failure.message}; caller must fetch the result via POST /api/spawn_async_items/${input.ref}/take`;
    const parked = await input.store.parkSpawnAsyncItemDeliveryUnsupported(input.ref, reason, input.now);
    if (!parked) {
      input.logger?.warn("undeliverable park lost; concurrent consumption may have occurred", {
        comm_id: input.commId,
        ref: input.ref,
      });
    }
    input.logger?.error("spawn closure fast-path cannot deliver to a heartbeat-disabled caller", {
      comm_id: input.commId,
      ref: input.ref,
      caller_session: item.callerSession,
      target_session: item.targetSession,
      enqueue_status: failure.status,
      err: failure.message,
    });
    if (parked && input.notifyUndeliverable) {
      try {
        await input.notifyUndeliverable({
          callerSession: item.callerSession,
          targetSession: item.targetSession,
          commId: input.commId,
          ref: input.ref,
          reason: failure.message,
        });
      } catch (notifyErr) {
        input.logger?.warn("undeliverable result notice failed", {
          comm_id: input.commId,
          ref: input.ref,
          err: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        });
      }
    }
    return {
      action: "noop",
      ref: input.ref,
      commId: input.commId,
      reason: "caller session has heartbeat delivery disabled; result parked for take",
    };
  }
}

async function hasWrittenSyncInlineResponse(
  store: FastPathStore,
  commId: string,
  logger: Logger | undefined,
): Promise<boolean> {
  try {
    const attempts = await store.listResultSinkAttemptsBySpawn(commId);
    return attempts.some((attempt) =>
      attempt.spawnCommId === commId
      && attempt.sinkKind === "http_response"
      && attempt.status === "delivered"
      && attempt.note === "sync_inline response written"
    );
  } catch (err) {
    logger?.warn("spawn closure fast-path could not verify sync_inline response evidence; using Heartbeat delivery", {
      comm_id: commId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function hasSuccessfulPushSink(
  store: FastPathStore,
  commId: string,
  logger: Logger | undefined,
): Promise<"parent_continuation_inject" | "chat_post" | "eventbus_publish" | null> {
  try {
    const attempts = await store.listResultSinkAttemptsBySpawn(commId);
    const attempt = attempts.find((candidate) =>
      candidate.spawnCommId === commId
      && candidate.status === "delivered"
      && (candidate.sinkKind === "parent_continuation_inject"
        || candidate.sinkKind === "chat_post"
        || candidate.sinkKind === "eventbus_publish")
    );
    return attempt?.sinkKind === "parent_continuation_inject"
      || attempt?.sinkKind === "chat_post"
      || attempt?.sinkKind === "eventbus_publish"
      ? attempt.sinkKind
      : null;
  } catch (err) {
    logger?.warn("spawn closure fast-path could not verify declared push sink; using Heartbeat delivery", {
      comm_id: commId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function enqueueHeartbeatTodo(input: {
  item: SpawnAsyncItemRecord;
  finalMessage: string;
  childSession: Session | null;
  heartbeatEnqueuePath: string;
  sourceSession: string;
}): Promise<void> {
  const message = [
    `这是你请求〔${input.item.commId}〕的结果，框架自动送回。`,
    "child completed; deliver full result to caller",
    "",
    buildRenderableChildCompletedEnvelope(input.item, input.finalMessage, input.childSession),
  ].join("\n");
  const args = [
    "--session",
    input.item.callerSession,
    "--key",
    input.item.commId,
    "--message",
    message,
    "--source",
    "spawn-closure-fast-path",
    "--source-session",
    input.item.targetSession,
    "--source-ref",
    input.item.commId,
    "--todo-type",
    "spawn_closure",
  ];
  if (input.item.originRunId) {
    args.push("--batch-key", input.item.originRunId);
  }
  const { stdout } = await execFileAsync(
    input.heartbeatEnqueuePath,
    args,
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assertHeartbeatTodoEnqueued(String(stdout));
}

function buildRenderableChildCompletedEnvelope(
  item: SpawnAsyncItemRecord,
  finalMessage: string,
  childSession: Session | null,
): string {
  const childId = item.childSessionId ?? "unknown";
  const childName = childSession?.name ?? "unknown";
  const childType = childSession?.childType ?? "unknown";
  return [
    `comm_id: ${item.commId}`,
    `<sm-child-completed child_id="${escapeAttr(childId)}" child_name="${escapeAttr(childName)}" child_type="${escapeAttr(childType)}">`,
    "<result>",
    finalMessage,
    "</result>",
    "</sm-child-completed>",
  ].join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertHeartbeatTodoEnqueued(stdout: string): void {
  const payload = parseHeartbeatEnqueueConfirmation(stdout);
  if (!payload) {
    throw new Error(
      `heartbeat todo enqueue did not return a parseable confirmation: ${stdout.trim().slice(-200) || "<empty>"}`,
    );
  }
  if (payload.ok !== true) {
    const error = typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new HeartbeatEnqueueRejected(
      `heartbeat todo enqueue was not confirmed${error}`,
      { status: payload.status, error: payload.error },
    );
  }
}

function isSpawnAdjudicationClientRequestId(clientRequestId: string | null | undefined): boolean {
  return Boolean(clientRequestId?.includes(":spawn-adjudication:"));
}

async function finalizeCompletedAdjudication(
  store: FastPathStore,
  item: SpawnAsyncItemRecord,
  now: Timestamp,
): Promise<{ reason: string }> {
  const clientRequestId = item.clientRequestId;
  if (!clientRequestId) return { reason: "adjudication result recorded; heartbeat delivery suppressed" };
  const original = parseSpawnAdjudicationClientRequestId(clientRequestId);
  if (!original) return { reason: "adjudication result recorded; heartbeat delivery suppressed" };

  const originalItem = await store.getSpawnAsyncItem(original.ref);
  if (originalItem && isValidAdjudicationOutcome(originalItem)) {
    return { reason: "adjudication result recorded; heartbeat delivery suppressed" };
  }
  if (originalItem) {
    await store.markSpawnAsyncItemAdjudicationEscalated(
      original.ref,
      invalidAdjudicationReason(clientRequestId),
      now,
    );
  }
  return { reason: "adjudication completed without valid state transition; original escalated" };
}

function parseSpawnAdjudicationClientRequestId(
  clientRequestId: string,
): { commId: string; ref: string } | null {
  const marker = ":spawn-adjudication:";
  const markerIndex = clientRequestId.indexOf(marker);
  if (markerIndex < 0) return null;
  const tail = clientRequestId.slice(markerIndex + marker.length);
  const [commId, ref] = tail.split(":");
  return commId && ref ? { commId, ref } : null;
}

function isValidAdjudicationOutcome(item: SpawnAsyncItemRecord): boolean {
  if (!item.verdict) return false;
  const expectedStatusByVerdict: Record<string, SpawnAsyncItemRecord["status"]> = {
    false_alarm: "closed",
    business_satisfied_elsewhere: "closed",
    escalated: "closed",
    retrying: "re_driving",
    contract_fixed: "pending",
    parked: "parked",
    // Terminal success reached while the adjudication was in flight: the
    // original no longer needs adjudication and must not be escalated.
    delivered: "closed",
    caller_consumed: "closed",
  };
  return expectedStatusByVerdict[item.verdict] === item.status;
}

function invalidAdjudicationReason(clientRequestId: string): string {
  return `adjudication spawn ${clientRequestId} completed without a valid status/verdict transition`;
}
