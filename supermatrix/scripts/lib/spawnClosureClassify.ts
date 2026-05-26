import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";

const execFileAsync = promisify(execFile);
const defaultHeartbeatEnqueuePath = "<SM_WORKSPACE_ROOT>/heartbeat/scripts/enqueue-heartbeat-todo";
const defaultApiBase = "http://localhost:3501";
const defaultSourceSession = "supermatrix-root";
const defaultSopPath = "<SM_WORKSPACE_ROOT>/socail-king/sop/spawn-exception-transaction.md";
const defaultAdjudicationStaleMs = 30 * 60 * 1000;
const defaultRedriveSpawnTimeoutMs = 45 * 1000;
// After a programmatic re-drive is issued, the retry has its own closure path.
// The watcher must not count another attempt or escalate until that closure
// window has elapsed — otherwise it burns its attempt budget faster than a
// single retry can settle.
const defaultRedriveGraceMs = 30 * 60 * 1000;

export type SpawnAsyncItem = {
  ref: string;
  comm_id: string;
  caller_session: string | null;
  target_session: string | null;
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
  | { route: "redrive"; logicalKey: string; targetSession: string; note: string }
  | { route: "redeliver"; logicalKey: string; note: string }
  | { route: "adjudicate"; reason: string }
  | { route: "noop"; reason: string; successfulCommId?: string; clientRequestId?: string };

export type RouteActionResult = {
  decision: RouteDecision;
  action: "deliver" | "redrive" | "redeliver" | "adjudicate" | "noop";
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
    closeAsyncItem(db, item.ref);
    return { route: "noop", reason: "delivery todo already enqueued; closing async item" };
  }

  if (!targetSession || !callerSession) {
    return { route: "adjudicate", reason: "spawn_async_items row is missing caller_session or target_session" };
  }

  const snapshot = readClosureSnapshot(item, db);
  if (!snapshot.commExists) {
    return { route: "adjudicate", reason: "cross_session_log row is missing" };
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

  const staleMs = positiveInteger(process.env.SPAWN_CLOSURE_STALE_MS, 24 * 60 * 60 * 1000);
  if (Date.now() - item.created_at > staleMs) {
    return { route: "adjudicate", reason: "spawn_async_items row is stale" };
  }

  if (item.attempt_count >= 2) {
    return { route: "adjudicate", reason: `attempt budget exhausted for ${item.failure_kind}` };
  }

  if (snapshot.allPassed && item.failure_kind !== "late_result") {
    closeAsyncItem(db, item.ref);
    return { route: "noop", reason: "spawn closure already verified" };
  }

  if (item.status === "waiting_child") {
    if (snapshot.executionPassed && snapshot.finalMessage) {
      if (snapshot.commKind !== "continuation") {
        closeAsyncItemAsLateResultStored(db, item.ref);
        return { route: "noop", reason: "late result stored in cross_session_log; no caller injection" };
      }
      return deliver(logicalKey, callerSession, snapshot.finalMessage, "child completed after caller stopped waiting; deliver full result to caller");
    }
    if (snapshot.executionTerminal) {
      return redrive(logicalKey, targetSession, "waiting child finished without usable output; re-drive original spawn");
    }
    return { route: "noop", reason: "child still running; waiting for completion" };
  }

  if (item.failure_kind === "late_result" && snapshot.executionPassed) {
    if (snapshot.commKind !== "continuation") {
      closeAsyncItemAsLateResultStored(db, item.ref);
      return { route: "noop", reason: "late result stored in cross_session_log; no caller injection" };
    }
    return deliver(logicalKey, callerSession, snapshot.finalMessage ?? "", "late result is now present; deliver it to caller");
  }

  if (item.failure_kind === "late_result") {
    if (!snapshot.executionTerminal) {
      return { route: "noop", reason: "late result: child still running; waiting for completion" };
    }
    return redrive(logicalKey, targetSession, "late result: child finished without usable output; re-drive");
  }

  if (item.failure_kind === "spawn_not_started") {
    return redrive(logicalKey, targetSession, "child session did not start; re-drive target session");
  }

  if (item.failure_kind === "run_error" || item.failure_kind === "run_timeout" || item.failure_kind === "empty_output") {
    return redrive(logicalKey, targetSession, `${item.failure_kind}; re-drive target session`);
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
  if (decision.route === "deliver") {
    await enqueueHeartbeatTodo({
      item: input.item,
      decision,
      db: input.db,
      heartbeatEnqueuePath: input.heartbeatEnqueuePath ?? defaultHeartbeatEnqueuePath,
      sourceSession: input.sourceSession ?? defaultSourceSession,
    });
    input.db
      .prepare(
        `UPDATE spawn_async_items
         SET attempt_count = attempt_count + 1,
             status = 'closed',
             last_attempt_at = ?,
             updated_at = ?
         WHERE ref = ?`
      )
      .run(now, now, input.item.ref);
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
        .prepare("UPDATE spawn_async_items SET status = 'closed', last_attempt_at = ?, updated_at = ? WHERE ref = ?")
        .run(now, now, input.item.ref);
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

function deliver(logicalKey: string, targetSession: string, finalMessage: string, note: string): RouteDecision {
  return {
    route: "deliver",
    logicalKey,
    targetSession,
    finalMessage,
    note,
  };
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
  const { stdout } = await execFileAsync(
    input.heartbeatEnqueuePath,
    [
      "--session",
      input.decision.targetSession,
      "--key",
      input.decision.logicalKey,
      "--message",
      message,
      "--source",
      "spawn-closure-watcher",
      "--source-session",
      input.sourceSession,
      "--source-ref",
      input.item.comm_id,
      "--todo-type",
      "spawn_closure",
    ],
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
  const confirmation = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!confirmation) {
    throw new Error("heartbeat todo enqueue did not return a confirmation");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(confirmation);
  } catch {
    throw new Error(`heartbeat todo enqueue returned invalid confirmation JSON: ${confirmation}`);
  }
  if (!isRecord(payload) || payload.ok !== true) {
    const error = isRecord(payload) && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`heartbeat todo enqueue was not confirmed${error}`);
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
  const redriveToken = `spawn-redrive:${input.decision.logicalKey}`;
  const prompt = buildRedrivePrompt(originalPrompt, redriveToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), defaultRedriveSpawnTimeoutMs);
  let response: Response;
  try {
    response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        target: targetSession,
        from: callerSession,
        prompt,
        client_request_id: redriveToken,
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

  const response = await fetch(`${input.apiBase.replace(/\/$/u, "")}/api/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: "socail-king",
      from: input.sourceSession,
      supermatrix_internal: { caller_invocation: "async_kickoff" },
      prompt,
      verification_predicate: {
        type: "inbox-message",
        session_name: "socail-king",
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

function logWatcherAction(item: SpawnAsyncItem, action: "redrive" | "deliver" | "redeliver" | "adjudicate", fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    event: "spawn_closure_watcher_action",
    comm_id: item.comm_id,
    ref: item.ref,
    action,
    ...fields,
  }));
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

function closeAsyncItem(db: Database.Database, ref: string): void {
  db.prepare("UPDATE spawn_async_items SET status = 'closed', updated_at = ? WHERE ref = ?").run(Date.now(), ref);
}

function closeAsyncItemAsLateResultStored(db: Database.Database, ref: string): void {
  db.prepare(
    `UPDATE spawn_async_items
     SET status = 'closed',
         verdict = 'late_result_stored',
         verdict_reason = 'late result stored in cross_session_log; no caller injection',
         updated_at = ?
     WHERE ref = ?`
  ).run(Date.now(), ref);
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
