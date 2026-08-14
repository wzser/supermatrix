import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import {
  describeHeartbeatEnqueueFailure,
  HeartbeatEnqueueRejected,
} from "../../src/app/spawnClosure/heartbeatEnqueue.ts";

const execFileAsync = promisify(execFile);
const defaultHeartbeatEnqueuePath = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/scripts/enqueue-heartbeat-todo";
const defaultApiBase = "http://localhost:3501";
const defaultSourceSession = "supermatrix-root";
const defaultSopPath = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/socail-king/sop/spawn-exception-transaction.md";
const defaultAdjudicationSession = "sk-watcher";
const defaultAdjudicationStaleMs = 30 * 60 * 1000;
const defaultRedriveSpawnTimeoutMs = 45 * 1000;
const defaultDeliveryBackoffMs = 10 * 60 * 1000;
const defaultDeliveryMaxAttempts = 4;
// After a programmatic re-drive is issued, the retry has its own closure path.
// The watcher must not count another attempt or escalate until that closure
// window has elapsed — otherwise it burns its attempt budget faster than a
// single retry can settle.
const defaultRedriveGraceMs = 30 * 60 * 1000;

function cstDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
}

function spawn2ClientRequestId(prefix: string, ...parts: string[]): string {
  const safeParts = parts.map((part) => part.replace(/[^A-Za-z0-9:._-]/g, "_"));
  return `${cstDate()}:${prefix}:${safeParts.join(":")}`.slice(0, 240);
}

export type SpawnAsyncItem = {
  ref: string;
  comm_id: string;
  caller_session: string | null;
  target_session: string | null;
  client_request_id?: string | null;
  origin_run_id: string | null;
  failed_phase: "communication" | "execution" | "delivery";
  failure_kind:
    | "spawn_not_started"
    | "run_error"
    | "run_timeout"
    | "empty_output"
    | "delivery_missing"
    | "late_result";
  attempt_count: number;
  status: "pending" | "waiting_child" | "delivering" | "re_driving" | "adjudicating" | "closed" | "parked";
  verdict: string | null;
  verdict_reason: string | null;
  created_at: number;
  updated_at: number;
  last_attempt_at: number | null;
};

export type RouteDecision =
  | { route: "deliver"; logicalKey: string; targetSession: string; finalMessage: string; note: string }
  | { route: "failure_notice"; logicalKey: string; targetSession: string; note: string }
  | { route: "redrive"; logicalKey: string; targetSession: string; note: string }
  | { route: "redeliver"; logicalKey: string; note: string }
  | { route: "adjudicate"; reason: string }
  | { route: "noop"; reason: string; successfulCommId?: string; clientRequestId?: string };

export type RouteActionResult = {
  decision: RouteDecision;
  action: "deliver" | "failure_notice" | "redrive" | "redeliver" | "adjudicate" | "noop";
};

export type ClosureSnapshot = {
  commExists: boolean;
  commKind: string | null;
  childStarted: boolean;
  executionPassed: boolean;
  executionTerminal: boolean;
  finalMessage: string | null;
  messageRunId: string | null;
  childSessionId: string | null;
  deliveryPassed: boolean;
  allPassed: boolean;
};

type OrphanedSessionEndpoint = {
  role: "caller" | "target";
  sessionName: string;
};

type AdjudicationOriginalOutcome = {
  status: SpawnAsyncItem["status"];
  verdict: string | null;
};

export type RedeliverExecutor = (input: {
  item: SpawnAsyncItem;
  snapshot: ClosureSnapshot;
}) => Promise<{ ok: boolean; note?: string }>;

export function classifyAsyncItem(item: SpawnAsyncItem, db: Database.Database): RouteDecision {
  const logicalKey = item.comm_id;
  const targetSession = item.target_session;
  const callerSession = item.caller_session;

  const orphaned = readOrphanedSessionEndpoint(item, db);
  if (orphaned) {
    parkAsyncItemAsOrphanedSession(db, item.ref, orphaned);
    return {
      route: "noop",
      reason: `${orphaned.role} session is missing or deleted; parking orphaned async item`,
    };
  }

  const satisfiedElsewhere = readBusinessSatisfiedElsewhere(item, db);
  if (satisfiedElsewhere) {
    closeAsyncItemAsBusinessSatisfiedElsewhere(db, item.ref, satisfiedElsewhere.commId);
    return {
      route: "noop",
      reason: "business request already satisfied by another completed comm",
      successfulCommId: satisfiedElsewhere.commId,
      clientRequestId: satisfiedElsewhere.clientRequestId,
    };
  }

  if (item.verdict === "boot_orphaned_failure") {
    return { route: "noop", reason: "boot reconcile failure receipt is parked for caller take" };
  }

  if (item.status === "adjudicating") {
    const adjudicationStaleMs = positiveInteger(
      process.env.SPAWN_CLOSURE_ADJUDICATION_STALE_MS,
      defaultAdjudicationStaleMs,
    );
    const adjudicationStartedAt = item.last_attempt_at ?? item.updated_at;
    if (Date.now() - adjudicationStartedAt < adjudicationStaleMs) {
      return { route: "noop", reason: "adjudication already in progress" };
    }
  }

  if (item.status === "re_driving") {
    const redriveSucceeded = readRedriveSucceeded(item, db);
    if (redriveSucceeded) {
      closeAsyncItemAsBusinessSatisfiedElsewhere(db, item.ref, redriveSucceeded.commId);
      return {
        route: "noop",
        reason: "redrive comm completed; original item closed",
        successfulCommId: redriveSucceeded.commId,
      };
    }
    const redriveGraceMs = positiveInteger(
      process.env.SPAWN_CLOSURE_REDRIVE_GRACE_MS,
      defaultRedriveGraceMs,
    );
    const lastDriveAt = item.last_attempt_at ?? item.updated_at;
    if (Date.now() - lastDriveAt < redriveGraceMs) {
      return { route: "noop", reason: "re-drive in flight; waiting for spawned retry closure" };
    }
  }

  if (item.status === "delivering") {
    closeAsyncItemAsDelivered(db, item.ref, "delivery todo already enqueued; closing async item");
    return { route: "noop", reason: "delivery todo already enqueued; closing async item" };
  }

  if (!targetSession || !callerSession) {
    return { route: "adjudicate", reason: "spawn_async_items row is missing caller_session or target_session" };
  }

  const snapshot = readClosureSnapshot(item, db);
  if (!snapshot.commExists) {
    return { route: "adjudicate", reason: "cross_session_log row is missing" };
  }

  const clientRequestId = item.client_request_id ?? readClientRequestId(item, db);
  if (clientRequestId && isSpawnAdjudicationClientRequestId(clientRequestId) && snapshot.executionPassed) {
    const result = finalizeAdjudicationResult(db, item.ref, clientRequestId);
    return { route: "noop", reason: result.reason };
  }

  const staleMs = positiveInteger(process.env.SPAWN_CLOSURE_STALE_MS, 24 * 60 * 60 * 1000);
  if (Date.now() - item.created_at > staleMs) {
    return { route: "adjudicate", reason: "spawn_async_items row is stale" };
  }

  if (item.status === "waiting_child") {
    if (snapshot.executionPassed && snapshot.finalMessage) {
      return deliverOrBackoff(item, logicalKey, callerSession, snapshot.finalMessage, "child completed after caller stopped waiting; deliver full result to caller");
    }
    if (item.attempt_count >= 2 && !isFailureNoticeRetryPending(item) && snapshot.executionTerminal) {
      return { route: "adjudicate", reason: `attempt budget exhausted for ${item.failure_kind}` };
    }
    if (snapshot.executionTerminal) {
      return redriveOrPark({
        item,
        logicalKey,
        callerSession,
        targetSession,
        note: "waiting child finished without usable output; re-drive original spawn",
      });
    }
    return { route: "noop", reason: "child still running; waiting for completion" };
  }

  if (item.failure_kind === "late_result" && snapshot.executionPassed) {
    return deliverOrBackoff(item, logicalKey, callerSession, snapshot.finalMessage ?? "", "late result is now present; deliver it to caller");
  }

  if (item.attempt_count >= 2 && !isFailureNoticeRetryPending(item)) {
    return { route: "adjudicate", reason: `attempt budget exhausted for ${item.failure_kind}` };
  }

  if (snapshot.allPassed && item.failure_kind !== "late_result") {
    closeAsyncItemAsDelivered(db, item.ref, "spawn closure already verified");
    return { route: "noop", reason: "spawn closure already verified" };
  }

  if (item.failure_kind === "late_result") {
    if (!snapshot.executionTerminal) {
      return { route: "noop", reason: "late result: child still running; waiting for completion" };
    }
    return redriveOrPark({
      item,
      logicalKey,
      callerSession,
      targetSession,
      note: "late result: child finished without usable output; re-drive",
    });
  }

  if (item.failure_kind === "spawn_not_started") {
    return redriveOrPark({
      item,
      logicalKey,
      callerSession,
      targetSession,
      note: "child session did not start; re-drive target session",
    });
  }

  if (item.failure_kind === "run_error" || item.failure_kind === "run_timeout" || item.failure_kind === "empty_output") {
    return redriveOrPark({
      item,
      logicalKey,
      callerSession,
      targetSession,
      note: `${item.failure_kind}; re-drive target session`,
    });
  }

  if (item.failure_kind === "delivery_missing") {
    if (snapshot.executionPassed) {
      return {
        route: "redeliver",
        logicalKey,
        note: "execution output exists but delivery is missing; redeliver declared address",
      };
    }
    return { route: "adjudicate", reason: "delivery_missing but execution output is not available" };
  }

  return { route: "adjudicate", reason: `unhandled failure_kind: ${item.failure_kind}` };
}

export async function classifyAndRoute(input: {
  item: SpawnAsyncItem;
  db: Database.Database;
  now?: number;
  heartbeatEnqueuePath?: string;
  apiBase?: string;
  sourceSession?: string;
  sopPath?: string;
  redeliver?: RedeliverExecutor;
}): Promise<RouteActionResult> {
  const decision = classifyAsyncItem(input.item, input.db);
  const now = input.now ?? Date.now();
  if (decision.route === "failure_notice") {
    try {
      await enqueueHeartbeatFailureNotice({
        item: input.item,
        decision,
        db: input.db,
        heartbeatEnqueuePath: input.heartbeatEnqueuePath ?? defaultHeartbeatEnqueuePath,
        sourceSession: input.sourceSession ?? defaultSourceSession,
      });
    } catch (err) {
      const enqueueFailure = describeHeartbeatEnqueueFailure(err);
      const errorMessage = enqueueFailure.message;
      const failure = recordFailureNoticeEnqueueFailure(input.db, input.item, now, errorMessage);
      logWatcherAction(input.item, "failure_notice", {
        targetSession: decision.targetSession,
        logicalKey: decision.logicalKey,
        result: failure.parked && failure.transitioned ? "giving_up" : "enqueue_failed",
        error: errorMessage,
        enqueueStatus: enqueueFailure.status,
        attemptCount: failure.attemptCount,
        maxAttempts: failure.maxAttempts,
      });
      if (failure.parked && failure.transitioned) {
        logStateTransition(input.item, "parked", errorMessage);
        logDeliveryGivingUp(input.item, errorMessage, failure.attemptCount, failure.maxAttempts);
        try {
          await postFailureNoticeDeliveryFallback({
            item: input.item,
            db: input.db,
            apiBase: input.apiBase ?? defaultApiBase,
            errorMessage,
          });
        } catch (fallbackError) {
          console.error(JSON.stringify({
            event: "spawn_closure_failure_notice_fallback_error",
            comm_id: input.item.comm_id,
            ref: input.item.ref,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          }));
        }
      }
      logRoute(input.item, decision);
      return { decision, action: "failure_notice" };
    }
    if (!parkAsyncItemAsAutoRedriveSuppressed(input.db, input.item, decision.note)) {
      const concurrentDecision: Extract<RouteDecision, { route: "noop" }> = {
        route: "noop",
        reason: "failure notice persisted but async item changed before it could be parked",
      };
      logRoute(input.item, concurrentDecision);
      return { decision: concurrentDecision, action: "noop" };
    }
    logStateTransition(input.item, "parked", decision.note);
    logWatcherAction(input.item, "failure_notice", {
      targetSession: decision.targetSession,
      logicalKey: decision.logicalKey,
      result: "persisted_then_parked",
    });
    logRoute(input.item, decision);
    return { decision, action: "failure_notice" };
  }
  if (decision.route === "deliver") {
    try {
      await enqueueHeartbeatTodo({
        item: input.item,
        decision,
        db: input.db,
        heartbeatEnqueuePath: input.heartbeatEnqueuePath ?? defaultHeartbeatEnqueuePath,
        sourceSession: input.sourceSession ?? defaultSourceSession,
      });
    } catch (err) {
      const enqueueFailure = describeHeartbeatEnqueueFailure(err);
      const errorMessage = enqueueFailure.message;
      if (enqueueFailure.callerHeartbeatDisabled) {
        // Deterministic dead end: retrying this channel can never succeed, so
        // settle terminally on the first failure instead of burning the
        // attempt budget on identical rejections. The completed result stays
        // readable via take.
        const reason = `${errorMessage}; caller must fetch the result via POST /api/spawn_async_items/${input.item.ref}/take`;
        const parked = parkAsyncItemAsDeliveryUnsupported(input.db, input.item, reason, now);
        logWatcherAction(input.item, "deliver", {
          targetSession: decision.targetSession,
          logicalKey: decision.logicalKey,
          result: parked ? "delivery_unsupported" : "delivery_unsupported_park_lost",
          error: errorMessage,
          enqueueStatus: enqueueFailure.status,
          attemptCount: input.item.attempt_count,
        });
        if (parked) {
          logStateTransition(input.item, "parked", reason);
          await notifyUndeliverableResult({
            item: input.item,
            db: input.db,
            apiBase: input.apiBase ?? defaultApiBase,
            reason,
          }).catch((notifyError) => {
            console.error(JSON.stringify({
              event: "spawn_closure_delivery_unsupported_notify_error",
              comm_id: input.item.comm_id,
              ref: input.item.ref,
              error: notifyError instanceof Error ? notifyError.message : String(notifyError),
            }));
          });
        }
        logRoute(input.item, decision);
        return { decision, action: "deliver" };
      }
      const failure = recordDeliveryFailure(input.db, input.item, now, errorMessage);
      logWatcherAction(input.item, "deliver", {
        targetSession: decision.targetSession,
        logicalKey: decision.logicalKey,
        result: failure.parked ? "giving_up" : "enqueue_failed",
        error: errorMessage,
        enqueueStatus: enqueueFailure.status,
        attemptCount: failure.attemptCount,
        maxAttempts: failure.maxAttempts,
      });
      if (failure.parked) {
        logStateTransition(input.item, "parked", errorMessage);
        logDeliveryGivingUp(input.item, errorMessage, failure.attemptCount, failure.maxAttempts);
      }
      logRoute(input.item, decision);
      return { decision, action: "deliver" };
    }
    input.db
      .prepare(
        `UPDATE spawn_async_items
         SET attempt_count = attempt_count + 1,
             status = 'closed',
             verdict = 'delivered',
             verdict_reason = ?,
             last_attempt_at = ?,
             updated_at = ?
         WHERE ref = ?`
      )
      .run(decision.note, now, now, input.item.ref);
    logStateTransition(input.item, "closed", decision.note);
    logWatcherAction(input.item, "deliver", {
      targetSession: decision.targetSession,
      logicalKey: decision.logicalKey,
      fullResultChars: decision.finalMessage.length,
      hasFullResult: decision.finalMessage.length > 0,
    });
    logRoute(input.item, decision);
    return { decision, action: "deliver" };
  }
  if (decision.route === "redrive") {
    input.db
      .prepare(
        `UPDATE spawn_async_items
         SET attempt_count = attempt_count + 1,
             status = 're_driving',
             last_attempt_at = ?,
             updated_at = ?
         WHERE ref = ?`
      )
      .run(now, now, input.item.ref);
    logStateTransition(input.item, "re_driving", decision.note);
    logWatcherAction(input.item, "redrive", {
      targetSession: decision.targetSession,
      logicalKey: decision.logicalKey,
    });
    logRoute(input.item, decision);
    spawnRedrive({
      item: input.item,
      decision,
      db: input.db,
      apiBase: input.apiBase ?? defaultApiBase,
      sourceSession: input.sourceSession ?? defaultSourceSession,
    }).catch((err) => {
      console.error(JSON.stringify({
        event: "spawn_closure_redrive_fire_and_forget_error",
        comm_id: input.item.comm_id,
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    return { decision, action: "redrive" };
  }
  if (decision.route === "redeliver") {
    const snapshot = readClosureSnapshot(input.item, input.db);
    const redelivery = await (input.redeliver ?? defaultRedeliver)({ item: input.item, snapshot });
    if (redelivery.ok) {
      input.db
        .prepare(
          "UPDATE spawn_async_items SET status = 'closed', verdict = 'delivered', verdict_reason = ?, last_attempt_at = ?, updated_at = ? WHERE ref = ?",
        )
        .run(decision.note, now, now, input.item.ref);
      logStateTransition(input.item, "closed", decision.note);
      logWatcherAction(input.item, "redeliver", {
        logicalKey: decision.logicalKey,
        result: "delivered",
        note: redelivery.note ?? null,
      });
      logRoute(input.item, decision);
      return { decision, action: "redeliver" };
    }
    const adjudicationDecision: Extract<RouteDecision, { route: "adjudicate" }> = {
      route: "adjudicate",
      reason: `redelivery failed: ${redelivery.note ?? "unknown error"}`,
    };
    input.db
      .prepare("UPDATE spawn_async_items SET status = 'adjudicating', last_attempt_at = ?, updated_at = ? WHERE ref = ?")
      .run(now, now, input.item.ref);
    logStateTransition(input.item, "adjudicating", adjudicationDecision.reason);
    logWatcherAction(input.item, "adjudicate", {
      reason: adjudicationDecision.reason,
    });
    logRoute(input.item, adjudicationDecision);
    spawnAdjudication({
      item: input.item,
      decision: adjudicationDecision,
      apiBase: input.apiBase ?? defaultApiBase,
      sourceSession: input.sourceSession ?? defaultSourceSession,
      sopPath: input.sopPath ?? defaultSopPath,
    }).catch((err) => {
      console.error(JSON.stringify({
        event: "spawn_closure_adjudication_fire_and_forget_error",
        comm_id: input.item.comm_id,
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    return { decision: adjudicationDecision, action: "adjudicate" };
  }
  if (decision.route === "adjudicate") {
    input.db
      .prepare("UPDATE spawn_async_items SET status = 'adjudicating', last_attempt_at = ?, updated_at = ? WHERE ref = ?")
      .run(now, now, input.item.ref);
    logStateTransition(input.item, "adjudicating", decision.reason);
    logWatcherAction(input.item, "adjudicate", {
      reason: decision.reason,
    });
    logRoute(input.item, decision);
    spawnAdjudication({
      item: input.item,
      decision,
      apiBase: input.apiBase ?? defaultApiBase,
      sourceSession: input.sourceSession ?? defaultSourceSession,
      sopPath: input.sopPath ?? defaultSopPath,
    }).catch((err) => {
      console.error(JSON.stringify({
        event: "spawn_closure_adjudication_fire_and_forget_error",
        comm_id: input.item.comm_id,
        error: err instanceof Error ? err.message : String(err),
      }));
    });
    return { decision, action: "adjudicate" };
  }
  if (decision.route === "noop" && decision.successfulCommId) {
    logBusinessSatisfiedElsewhere(input.item, decision.successfulCommId, decision.clientRequestId);
  }
  logRoute(input.item, decision);
  return { decision, action: decision.route };
}

function redrive(logicalKey: string, targetSession: string, note: string): RouteDecision {
  return {
    route: "redrive",
    logicalKey,
    targetSession,
    note,
  };
}

function failureNotice(logicalKey: string, targetSession: string, note: string): RouteDecision {
  return {
    route: "failure_notice",
    logicalKey,
    targetSession,
    note,
  };
}

function redriveOrPark(input: {
  item: SpawnAsyncItem;
  logicalKey: string;
  callerSession: string;
  targetSession: string;
  note: string;
}): RouteDecision {
  if (autoRedriveEnabled()) {
    return redrive(input.logicalKey, input.targetSession, input.note);
  }
  if (failureNoticeRetryBackoffActive(input.item)) {
    return { route: "noop", reason: "failure notice delivery retry backoff active" };
  }
  // classifyAndRoute persists this caller-facing notice before it can park the
  // item. Keeping the operation async prevents a suppressed redrive from
  // becoming an invisible terminal state.
  return failureNotice(failureNoticeLogicalKey(input.item), input.callerSession, input.note);
}

function failureNoticeLogicalKey(item: SpawnAsyncItem): string {
  const clientRequestId = item.client_request_id?.trim();
  return `${clientRequestId || item.comm_id}:failure-notice`;
}

function autoRedriveEnabled(): boolean {
  const raw = process.env.SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function deliver(logicalKey: string, targetSession: string, finalMessage: string, note: string): RouteDecision {
  return {
    route: "deliver",
    logicalKey,
    targetSession,
    finalMessage,
    note,
  };
}

function deliverOrBackoff(
  item: SpawnAsyncItem,
  logicalKey: string,
  targetSession: string,
  finalMessage: string,
  note: string,
): RouteDecision {
  if (deliveryRetryBackoffActive(item)) {
    return { route: "noop", reason: "delivery retry backoff active" };
  }
  return deliver(logicalKey, targetSession, finalMessage, note);
}

function deliveryRetryBackoffActive(item: SpawnAsyncItem): boolean {
  if (item.attempt_count <= 0 || item.last_attempt_at === null) return false;
  if (item.status !== "pending" && item.status !== "waiting_child") return false;
  const backoffMs = positiveInteger(process.env.SPAWN_CLOSURE_DELIVERY_BACKOFF_MS, defaultDeliveryBackoffMs);
  return Date.now() - item.last_attempt_at < backoffMs;
}

function isFailureNoticeRetryPending(item: SpawnAsyncItem): boolean {
  return item.verdict === "failure_notice_pending";
}

function failureNoticeRetryBackoffActive(item: SpawnAsyncItem): boolean {
  return isFailureNoticeRetryPending(item) && deliveryRetryBackoffActive(item);
}

function recordDeliveryFailure(
  db: Database.Database,
  item: SpawnAsyncItem,
  now: number,
  errorMessage: string,
): { attemptCount: number; maxAttempts: number; parked: boolean } {
  const maxAttempts = positiveInteger(process.env.SPAWN_CLOSURE_DELIVERY_MAX_ATTEMPTS, defaultDeliveryMaxAttempts);
  db.prepare(
    `UPDATE spawn_async_items
     SET attempt_count = attempt_count + 1,
         status = CASE WHEN attempt_count + 1 >= ? THEN 'parked' ELSE status END,
         verdict = CASE WHEN attempt_count + 1 >= ? THEN 'delivery_unreachable' ELSE verdict END,
         verdict_reason = CASE WHEN attempt_count + 1 >= ? THEN ? ELSE verdict_reason END,
         last_attempt_at = ?,
         updated_at = ?
     WHERE ref = ?
       AND status = ?`
  ).run(maxAttempts, maxAttempts, maxAttempts, errorMessage, now, now, item.ref, item.status);
  const row = db
    .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE ref = ?")
    .get(item.ref) as { status: SpawnAsyncItem["status"]; attempt_count: number } | undefined;
  return {
    attemptCount: row?.attempt_count ?? item.attempt_count,
    maxAttempts,
    parked: row?.status === "parked",
  };
}

/**
 * Terminal settle for a delivery channel the caller can never accept (caller
 * heartbeat disabled). attempt_count is deliberately left untouched: this is
 * not a spent retry, it is an unsupported channel.
 */
function parkAsyncItemAsDeliveryUnsupported(
  db: Database.Database,
  item: SpawnAsyncItem,
  reason: string,
  now: number,
): boolean {
  const result = db.prepare(
    `UPDATE spawn_async_items
     SET status = 'parked',
         verdict = 'delivery_unsupported_caller_heartbeat_disabled',
         verdict_reason = ?,
         last_attempt_at = ?,
         updated_at = ?
     WHERE ref = ?
       AND status = ?`
  ).run(reason, now, now, item.ref, item.status);
  return result.changes === 1;
}

function recordFailureNoticeEnqueueFailure(
  db: Database.Database,
  item: SpawnAsyncItem,
  now: number,
  errorMessage: string,
): { attemptCount: number; maxAttempts: number; parked: boolean; transitioned: boolean } {
  const maxAttempts = positiveInteger(process.env.SPAWN_CLOSURE_DELIVERY_MAX_ATTEMPTS, defaultDeliveryMaxAttempts);
  const update = db.prepare(
    `UPDATE spawn_async_items
     SET attempt_count = attempt_count + 1,
         status = CASE WHEN attempt_count + 1 >= ? THEN 'parked' ELSE status END,
         verdict = CASE
           WHEN attempt_count + 1 >= ? THEN 'delivery_unreachable'
           ELSE 'failure_notice_pending'
         END,
         verdict_reason = ?,
         last_attempt_at = ?,
         updated_at = ?
     WHERE ref = ?
       AND status = ?`
  ).run(maxAttempts, maxAttempts, errorMessage, now, now, item.ref, item.status);
  const row = db
    .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE ref = ?")
    .get(item.ref) as { status: SpawnAsyncItem["status"]; attempt_count: number } | undefined;
  return {
    attemptCount: row?.attempt_count ?? item.attempt_count,
    maxAttempts,
    parked: row?.status === "parked",
    transitioned: update.changes === 1,
  };
}

async function enqueueHeartbeatFailureNotice(input: {
  item: SpawnAsyncItem;
  decision: Extract<RouteDecision, { route: "failure_notice" }>;
  db: Database.Database;
  heartbeatEnqueuePath: string;
  sourceSession: string;
}): Promise<void> {
  const clientRequestId = input.item.client_request_id ?? readClientRequestId(input.item, input.db) ?? "unavailable";
  const message = [
    "Spawn 请求失败，框架未自动重投，需由 caller 显式裁决。",
    `comm_id: ${input.item.comm_id}`,
    `async_ref: ${input.item.ref}`,
    `caller: ${input.item.caller_session ?? "unknown"}`,
    `target: ${input.item.target_session ?? "unknown"}`,
    `失败原因: ${input.item.failure_kind}; ${input.decision.note}`,
    "verdict: auto_redrive_suppressed",
    `client_request_id: ${clientRequestId}`,
    "",
    "执行状态未知，先核业务副作用，再由 caller 显式决定是否用原 client_request_id 重试。",
  ].join("\n");
  const args = [
    "--session",
    input.decision.targetSession,
    "--key",
    input.decision.logicalKey,
    "--message",
    message,
    "--source",
    "spawn-closure-watcher",
    "--source-session",
    input.item.target_session ?? input.sourceSession,
    "--source-ref",
    input.item.comm_id,
    "--todo-type",
    "status_reconcile",
    "--batch-mode",
    "single",
  ];
  const { stdout } = await execFileAsync(
    input.heartbeatEnqueuePath,
    args,
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assertHeartbeatFailureNoticeEnqueued(String(stdout));
}

async function enqueueHeartbeatTodo(input: {
  item: SpawnAsyncItem;
  decision: Extract<RouteDecision, { route: "deliver" }>;
  db: Database.Database;
  heartbeatEnqueuePath: string;
  sourceSession: string;
}): Promise<void> {
  const message = [
    `这是你请求〔${input.item.comm_id}〕的结果,框架兜底送回。`,
    input.decision.note,
    "",
    buildRenderableChildCompletedEnvelope(input.item, input.decision.finalMessage, input.db),
  ].join("\n");
  const args = [
    "--session",
    input.decision.targetSession,
    "--key",
    input.decision.logicalKey,
    "--message",
    message,
    "--source",
    "spawn-closure-watcher",
    "--source-session",
    input.item.target_session ?? input.sourceSession,
    "--source-ref",
    input.item.comm_id,
    "--todo-type",
    "spawn_closure",
  ];
  const originRunId = input.item.origin_run_id?.trim();
  if (originRunId) {
    args.push("--batch-key", originRunId);
  }
  const { stdout } = await execFileAsync(
    input.heartbeatEnqueuePath,
    args,
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  assertHeartbeatTodoEnqueued(String(stdout));
}

function buildRenderableChildCompletedEnvelope(
  item: SpawnAsyncItem,
  finalMessage: string,
  db: Database.Database,
): string {
  const provenance = readChildCompletionProvenance(item, db);
  return [
    `comm_id: ${item.comm_id}`,
    `<sm-child-completed child_id="${escapeAttr(provenance.childId)}" child_name="${escapeAttr(provenance.childName)}" child_type="${escapeAttr(provenance.childType)}">`,
    "<result>",
    finalMessage,
    "</result>",
    "</sm-child-completed>",
  ].join("\n");
}

function readChildCompletionProvenance(
  item: SpawnAsyncItem,
  db: Database.Database,
): { childId: string; childName: string; childType: string } {
  try {
    const row = db
      .prepare(
        `SELECT c.child_session_id AS childId,
                s.name AS childName,
                s.child_type AS childType
         FROM cross_session_log c
         LEFT JOIN sessions s ON s.id = c.child_session_id
         WHERE c.id = ?`
      )
      .get(item.comm_id) as
      | { childId: string | null; childName: string | null; childType: string | null }
      | undefined;
    return {
      childId: row?.childId ?? "unknown",
      childName: row?.childName ?? "unknown",
      childType: row?.childType ?? "unknown",
    };
  } catch {
    return { childId: "unknown", childName: "unknown", childType: "unknown" };
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function assertHeartbeatTodoEnqueued(stdout: string): void {
  const payload = parseHeartbeatTodoConfirmation(stdout);
  if (!isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new HeartbeatEnqueueRejected(
      `heartbeat todo enqueue was not confirmed${error}`,
      isRecord(payload) ? { status: payload.status, error: payload.error } : undefined,
    );
  }
}

function assertHeartbeatFailureNoticeEnqueued(stdout: string): void {
  const payload = parseHeartbeatTodoConfirmation(stdout);
  if (!isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new HeartbeatEnqueueRejected(
      `heartbeat failure notice enqueue was not confirmed${error}`,
      isRecord(payload) ? { status: payload.status, error: payload.error } : undefined,
    );
  }
  if (payload.status !== "inserted" && payload.status !== "duplicate") {
    throw new Error(`heartbeat failure notice was not persisted: status ${String(payload.status)}`);
  }
}

function parseHeartbeatTodoConfirmation(stdout: string): unknown {
  const confirmation = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!confirmation) {
    throw new Error("heartbeat todo enqueue did not return a confirmation");
  }
  try {
    return JSON.parse(confirmation);
  } catch {
    throw new Error(`heartbeat todo enqueue returned invalid confirmation JSON: ${confirmation}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function spawnRedrive(input: {
  item: SpawnAsyncItem;
  decision: Extract<RouteDecision, { route: "redrive" }>;
  db: Database.Database;
  apiBase: string;
  sourceSession: string;
}): Promise<void> {
  const row = input.db
    .prepare("SELECT prompt FROM cross_session_log WHERE id = ?")
    .get(input.item.comm_id) as { prompt: string | null } | undefined;
  const originalPrompt = row?.prompt;
  const targetSession = input.item.target_session;
  const callerSession = input.item.caller_session;
  if (!originalPrompt || !targetSession || !callerSession) {
    throw new Error("cannot redrive spawn without original prompt, caller_session, and target_session");
  }
  const redriveToken = spawn2ClientRequestId("spawn-redrive", input.decision.logicalKey);
  const prompt = buildRedrivePrompt(originalPrompt, redriveToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), defaultRedriveSpawnTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/spawn2.0`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        target: targetSession,
        from: callerSession,
        prompt,
        client_request_id: redriveToken,
        closure: { kind: "message", target: { type: "todo_pool" } },
        verification_predicate: {
          type: "inbox-message",
          session_name: targetSession,
          field: "final_message",
          contains_all: [redriveToken],
          expected_window_sec: 3600,
        },
      }),
    });
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`redrive spawn failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
}

function buildRedrivePrompt(originalPrompt: string, redriveToken: string): string {
  return [
    originalPrompt,
    "",
    "[SuperMatrix redrive closure]",
    "When you produce the final answer, include this exact verification token on its own line:",
    redriveToken,
  ].join("\n");
}

async function defaultRedeliver(): Promise<{ ok: boolean; note: string }> {
  return { ok: false, note: "redelivery executor not wired" };
}

async function spawnAdjudication(input: {
  item: SpawnAsyncItem;
  decision: Extract<RouteDecision, { route: "adjudicate" }>;
  apiBase: string;
  sourceSession: string;
  sopPath: string;
}): Promise<void> {
  const adjudicationTarget = adjudicationSession();
  const prompt = [
    "请按裁决 SOP 处理一条 spawn closure async item。",
    "",
    `SOP: ${input.sopPath}`,
    `comm_id: ${input.item.comm_id}`,
    `async_ref: ${input.item.ref}`,
    `failure_kind: ${input.item.failure_kind}`,
    `failed_phase: ${input.item.failed_phase}`,
    `attempt_count: ${input.item.attempt_count}`,
    `reason: ${input.decision.reason}`,
    "",
    "请读取 SuperMatrix DB 中对应记录，按 SOP 收集证据、裁决责任归属，并回写 spawn_async_items.verdict/verdict_reason/status。",
  ].join("\n");

  const response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/spawn2.0`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: adjudicationTarget,
      from: adjudicationTarget,
      client_request_id: spawn2ClientRequestId("spawn-adjudication", input.item.comm_id, input.item.ref),
      prompt,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: adjudicationTarget,
        field: "prompt",
        contains_all: [input.item.comm_id],
        expected_window_sec: 600,
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`adjudication spawn failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
}

function adjudicationSession(): string {
  return process.env.SPAWN_CLOSURE_ADJUDICATION_SESSION?.trim() || defaultAdjudicationSession;
}

function logRoute(item: SpawnAsyncItem, decision: RouteDecision): void {
  console.log(JSON.stringify({
    event: "spawn_closure_watcher_route",
    comm_id: item.comm_id,
    route: decision.route,
    decision,
  }));
}

function logStateTransition(item: SpawnAsyncItem, toStatus: SpawnAsyncItem["status"], reason: string): void {
  console.log(JSON.stringify({
    event: "spawn_closure_state_transition",
    comm_id: item.comm_id,
    ref: item.ref,
    from_status: item.status,
    to_status: toStatus,
    reason,
  }));
}

function logWatcherAction(
  item: SpawnAsyncItem,
  action: "redrive" | "deliver" | "failure_notice" | "redeliver" | "adjudicate",
  fields: Record<string, unknown>,
): void {
  console.log(JSON.stringify({
    event: "spawn_closure_watcher_action",
    comm_id: item.comm_id,
    ref: item.ref,
    action,
    ...fields,
  }));
}

function logDeliveryGivingUp(
  item: SpawnAsyncItem,
  errorMessage: string,
  attemptCount: number,
  maxAttempts: number,
): void {
  console.error(JSON.stringify({
    event: "spawn_closure_delivery_giving_up",
    comm_id: item.comm_id,
    ref: item.ref,
    target_session: item.caller_session,
    attempt_count: attemptCount,
    max_attempts: maxAttempts,
    verdict: "delivery_unreachable",
    error: errorMessage,
  }));
}

/**
 * The result exists but no push channel can reach the caller. Tell the caller
 * in its own bound group so a completed result never dies silently in a parked
 * item — the take URL is the recovery path.
 */
async function notifyUndeliverableResult(input: {
  item: SpawnAsyncItem;
  db: Database.Database;
  apiBase: string;
  reason: string;
}): Promise<void> {
  const targetChatId = readCallerTargetChatId(input.db, input.item);
  const body = {
    kind: "spawn_exception_transaction_fallback",
    tx_id: `tx-spawn-closure-delivery-unsupported-${input.item.comm_id}`,
    dedupe_key: `${input.item.comm_id}:delivery-unsupported-caller-heartbeat-disabled`,
    spawn_comm_id: input.item.comm_id,
    trigger_signal: "delivery_unsupported_caller_heartbeat_disabled",
    summary: [
      "spawn result is ready but the caller cannot receive heartbeat todos",
      `spawn ${input.item.caller_session ?? "unknown"} -> ${input.item.target_session ?? "unknown"} (${input.item.comm_id})`,
      `取结果: curl -sX POST http://localhost:3501/api/spawn_async_items/${input.item.ref}/take`,
    ].join(" | "),
    payload: {
      async_ref: input.item.ref,
      caller_session: input.item.caller_session,
      target_session: input.item.target_session,
      failure_kind: input.item.failure_kind,
      failure_reason: input.reason,
      verdict: "delivery_unsupported_caller_heartbeat_disabled",
      result_url: `/api/spawn_async_items/${input.item.ref}/take`,
    },
    ...(targetChatId ? { target_chat_id: targetChatId } : {}),
  };
  const response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/watcher-exception-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isRecord(responseBody) || responseBody.ok !== true) {
    const responseError = isRecord(responseBody) && typeof responseBody.error === "string"
      ? `: ${responseBody.error}`
      : "";
    throw new Error(`watcher-exception undeliverable result notice failed: HTTP ${response.status}${responseError}`);
  }
  console.log(JSON.stringify({
    event: "spawn_closure_delivery_unsupported_notified",
    comm_id: input.item.comm_id,
    ref: input.item.ref,
    target_chat_id: targetChatId ?? null,
  }));
}

async function postFailureNoticeDeliveryFallback(input: {
  item: SpawnAsyncItem;
  db: Database.Database;
  apiBase: string;
  errorMessage: string;
}): Promise<void> {
  const targetChatId = readCallerTargetChatId(input.db, input.item);
  const body = {
    kind: "spawn_exception_transaction_fallback",
    tx_id: `tx-spawn-closure-failure-notice-${input.item.comm_id}`,
    dedupe_key: `${input.item.comm_id}:failure-notice-delivery-unreachable`,
    spawn_comm_id: input.item.comm_id,
    trigger_signal: "failure_notice_delivery_unreachable",
    summary: [
      "spawn closure failure notice could not be persisted to heartbeat",
      `spawn ${input.item.caller_session ?? "unknown"} -> ${input.item.target_session ?? "unknown"} (${input.item.comm_id})`,
      input.errorMessage,
    ].join(" | "),
    payload: {
      async_ref: input.item.ref,
      caller_session: input.item.caller_session,
      target_session: input.item.target_session,
      failure_kind: input.item.failure_kind,
      failure_reason: input.errorMessage,
      verdict: "delivery_unreachable",
    },
    ...(targetChatId ? { target_chat_id: targetChatId } : {}),
  };
  const response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/watcher-exception-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isRecord(responseBody) || responseBody.ok !== true) {
    const responseError = isRecord(responseBody) && typeof responseBody.error === "string"
      ? `: ${responseBody.error}`
      : "";
    throw new Error(`watcher-exception failure notice fallback failed: HTTP ${response.status}${responseError}`);
  }
  console.log(JSON.stringify({
    event: "spawn_closure_failure_notice_fallback_notified",
    comm_id: input.item.comm_id,
    ref: input.item.ref,
    target_chat_id: targetChatId ?? null,
  }));
}

function readCallerTargetChatId(db: Database.Database, item: SpawnAsyncItem): string | undefined {
  if (!item.caller_session) return undefined;
  try {
    const row = db
      .prepare(
        `SELECT b.group_id
         FROM bindings b
         JOIN sessions s ON s.id = b.session_id
         WHERE s.name = ?
         LIMIT 1`,
      )
      .get(item.caller_session) as { group_id: string } | undefined;
    return row?.group_id?.startsWith("oc_") ? row.group_id : undefined;
  } catch {
    return undefined;
  }
}

function readClosureSnapshot(item: SpawnAsyncItem, db: Database.Database): ClosureSnapshot {
  const row = db
    .prepare(
      `SELECT c.kind, c.child_session_id, c.message_run_id, c.status AS comm_status, c.final_message AS comm_final_message,
              mr.status AS run_status, mr.final_message AS run_final_message, mr.error_message AS run_error_message
       FROM cross_session_log c
       LEFT JOIN message_runs mr ON mr.id = c.message_run_id
       WHERE c.id = ?`
    )
    .get(item.comm_id) as
    | {
        kind: string;
        child_session_id: string | null;
        message_run_id: string | null;
        comm_status: string | null;
        comm_final_message: string | null;
        run_status: string | null;
        run_final_message: string | null;
        run_error_message: string | null;
      }
    | undefined;

  if (!row) {
      return {
        commExists: false,
        commKind: null,
        childStarted: false,
        executionPassed: false,
        executionTerminal: false,
        finalMessage: null,
        messageRunId: null,
        childSessionId: null,
        deliveryPassed: false,
        allPassed: false,
      };
  }

  const finalMessage = row.run_final_message ?? row.comm_final_message ?? "";
  const status = row.run_status ?? row.comm_status ?? "";
  const continuationFallbackPassed =
    row.kind === "continuation" &&
    finalMessage.trim().length > 0 &&
    row.run_error_message === null;
  const executionPassed =
    continuationFallbackPassed ||
    (
      finalMessage.trim().length > 0 &&
      status !== "failed" &&
      status !== "timeout" &&
      status !== "error" &&
      row.run_error_message === null
    );
  const executionTerminal =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout" ||
    status === "error";
  const deliveryPassed =
    item.failure_kind === "delivery_missing" ? hasDeliveredSinkAttempt(db, item.comm_id) : true;
  const childStarted = row.child_session_id !== null;

  return {
    commExists: true,
    commKind: row.kind,
    childStarted,
    executionPassed,
    executionTerminal,
    finalMessage: finalMessage.trim().length > 0 ? finalMessage : null,
    messageRunId: row.message_run_id,
    childSessionId: row.child_session_id,
    deliveryPassed,
    allPassed: childStarted && executionPassed && deliveryPassed,
  };
}

function hasDeliveredSinkAttempt(db: Database.Database, commId: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS matched FROM result_sink_attempts WHERE spawn_comm_id = ? AND (status = 'delivered' OR (status = 'skipped' AND note LIKE '%sync_inline handler owns delivery%')) LIMIT 1")
      .get(commId) as { matched: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

function readBusinessSatisfiedElsewhere(
  item: SpawnAsyncItem,
  db: Database.Database,
): { commId: string; clientRequestId: string } | null {
  try {
    const current = db
      .prepare("SELECT client_request_id FROM cross_session_log WHERE id = ?")
      .get(item.comm_id) as { client_request_id: string | null } | undefined;
    const clientRequestId = current?.client_request_id?.trim();
    if (!clientRequestId) return null;

    const successful = db
      .prepare(
        `SELECT id
         FROM cross_session_log
         WHERE client_request_id = ?
           AND status = 'completed'
           AND id <> ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(clientRequestId, item.comm_id) as { id: string } | undefined;
    return successful ? { commId: successful.id, clientRequestId } : null;
  } catch {
    return null;
  }
}

function readRedriveSucceeded(
  item: SpawnAsyncItem,
  db: Database.Database,
): { commId: string } | null {
  // The redrive spawn is posted with client_request_id = "YYYY-MM-DD:spawn-redrive:<original-comm-id>".
  // GLOB avoids treating underscores in comm_id as SQL LIKE wildcards.
  try {
    const successful = db
      .prepare(
        `SELECT id
         FROM cross_session_log
         WHERE client_request_id GLOB '*:spawn-redrive:' || ?
           AND status = 'completed'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(item.comm_id) as { id: string } | undefined;
    return successful ? { commId: successful.id } : null;
  } catch {
    return null;
  }
}

function readClientRequestId(item: SpawnAsyncItem, db: Database.Database): string | null {
  try {
    const row = db
      .prepare("SELECT client_request_id FROM cross_session_log WHERE id = ?")
      .get(item.comm_id) as { client_request_id: string | null } | undefined;
    return row?.client_request_id?.trim() || null;
  } catch {
    return null;
  }
}

function isSpawnAdjudicationClientRequestId(clientRequestId: string | null | undefined): boolean {
  return Boolean(clientRequestId?.includes(":spawn-adjudication:"));
}

function finalizeAdjudicationResult(
  db: Database.Database,
  adjudicationRef: string,
  clientRequestId: string,
): { reason: string } {
  const original = parseSpawnAdjudicationClientRequestId(clientRequestId);
  if (!original) {
    closeAsyncItemAsAdjudicationRecorded(db, adjudicationRef, clientRequestId);
    return { reason: "adjudication result recorded; heartbeat delivery suppressed" };
  }

  const outcome = readAdjudicationOriginalOutcome(db, original.ref);
  if (outcome && isValidAdjudicationOutcome(outcome)) {
    closeAsyncItemAsAdjudicationRecorded(db, adjudicationRef, clientRequestId);
    return { reason: "adjudication result recorded; heartbeat delivery suppressed" };
  }

  if (outcome) {
    closeOriginalAdjudicationAsEscalated(db, original.ref, invalidAdjudicationReason(clientRequestId));
  }
  closeAsyncItemAsAdjudicationRecorded(db, adjudicationRef, clientRequestId);
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

function readAdjudicationOriginalOutcome(
  db: Database.Database,
  ref: string,
): AdjudicationOriginalOutcome | null {
  try {
    const row = db
      .prepare("SELECT status, verdict FROM spawn_async_items WHERE ref = ?")
      .get(ref) as AdjudicationOriginalOutcome | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function isValidAdjudicationOutcome(outcome: AdjudicationOriginalOutcome): boolean {
  if (!outcome.verdict) return false;
  const expectedStatusByVerdict: Record<string, SpawnAsyncItem["status"]> = {
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
  return expectedStatusByVerdict[outcome.verdict] === outcome.status;
}

function invalidAdjudicationReason(clientRequestId: string): string {
  return `adjudication spawn ${clientRequestId} completed without a valid status/verdict transition`;
}

function readOrphanedSessionEndpoint(item: SpawnAsyncItem, db: Database.Database): OrphanedSessionEndpoint | null {
  if (item.caller_session && isSessionMissingOrDeleted(db, item.caller_session)) {
    return { role: "caller", sessionName: item.caller_session };
  }
  if (item.target_session && isSessionMissingOrDeleted(db, item.target_session)) {
    return { role: "target", sessionName: item.target_session };
  }
  return null;
}

function isSessionMissingOrDeleted(db: Database.Database, sessionName: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT status
         FROM sessions
         WHERE name = ? OR alias = ?
         ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1`
      )
      .get(sessionName, sessionName, sessionName) as { status: string | null } | undefined;
    return !row || row.status === "deleted";
  } catch {
    return false;
  }
}

function closeAsyncItemAsDelivered(db: Database.Database, ref: string, reason: string): void {
  db.prepare(
    "UPDATE spawn_async_items SET status = 'closed', verdict = 'delivered', verdict_reason = ?, updated_at = ? WHERE ref = ?",
  ).run(reason, Date.now(), ref);
}

function parkAsyncItemAsOrphanedSession(
  db: Database.Database,
  ref: string,
  orphaned: OrphanedSessionEndpoint,
): void {
  db.prepare(
    `UPDATE spawn_async_items
     SET status = 'parked',
         verdict = 'orphaned_session',
         verdict_reason = ?,
         updated_at = ?
     WHERE ref = ?`
  ).run(`${orphaned.role} session ${orphaned.sessionName} is missing or deleted; redrive suppressed`, Date.now(), ref);
}

function parkAsyncItemAsAutoRedriveSuppressed(
  db: Database.Database,
  item: SpawnAsyncItem,
  note: string,
): boolean {
  const result = db.prepare(
    `UPDATE spawn_async_items
     SET status = 'parked',
         verdict = 'auto_redrive_suppressed',
         verdict_reason = ?,
         updated_at = ?
     WHERE ref = ?
       AND status = ?`
  ).run(
    `${note}; set SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE=1 to allow watcher redrive`,
    Date.now(),
    item.ref,
    item.status,
  );
  return result.changes === 1;
}

function closeAsyncItemAsBusinessSatisfiedElsewhere(
  db: Database.Database,
  ref: string,
  successfulCommId: string,
): void {
  db.prepare(
    `UPDATE spawn_async_items
     SET status = 'closed',
         verdict = 'business_satisfied_elsewhere',
         verdict_reason = ?,
         updated_at = ?
     WHERE ref = ?`
  ).run(`same client_request_id completed by ${successfulCommId}`, Date.now(), ref);
}

function closeAsyncItemAsAdjudicationRecorded(
  db: Database.Database,
  ref: string,
  clientRequestId: string,
): void {
  db.prepare(
    `UPDATE spawn_async_items
     SET status = 'closed',
         verdict = 'adjudication_result_recorded',
         verdict_reason = ?,
         updated_at = ?
     WHERE ref = ?`
  ).run(`adjudication spawn ${clientRequestId} completed; heartbeat delivery suppressed`, Date.now(), ref);
}

function closeOriginalAdjudicationAsEscalated(
  db: Database.Database,
  ref: string,
  reason: string,
): void {
  // Never overwrite a terminal success verdict: delivered/caller_consumed
  // rows are the read-only transport delivery proof for callers.
  db.prepare(
    `UPDATE spawn_async_items
     SET status = 'closed',
         verdict = 'escalated',
         verdict_reason = ?,
         updated_at = ?
     WHERE ref = ?
       AND NOT (status = 'closed' AND verdict IN ('delivered', 'caller_consumed'))`
  ).run(reason, Date.now(), ref);
}

function logBusinessSatisfiedElsewhere(
  item: SpawnAsyncItem,
  successfulCommId: string,
  clientRequestId: string | undefined,
): void {
  console.log(JSON.stringify({
    event: "business_satisfied_elsewhere",
    comm_id: item.comm_id,
    ref: item.ref,
    successful_comm_id: successfulCommId,
    ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
  }));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
