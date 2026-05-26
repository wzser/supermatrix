#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

TSX_BIN="./node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  TSX_BIN="tsx"
fi

"$TSX_BIN" <<'TS'
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { loadSqlitePredicateDbRegistry } from "./src/adapters/predicate-db/sqliteRegistry.ts";
import { recoverSpawnCommOrphans } from "./src/app/spawnClosure/orphanSweep.ts";
import { evaluateSpawnPredicate } from "./src/app/spawnPredicate/evaluate.ts";
import type {
  PredicateEvaluationResult,
  PredicateTriggerSignal,
  SpawnPredicate,
} from "./src/domain/spawnPredicate.ts";
import type { Logger } from "./src/ports/Logger.ts";

const dbPath = process.env.SM_DB_PATH ?? "<SM_RUNTIME_ROOT>/data/supermatrix.db";
const taskId = process.env.SCHEDULER_TASK_ID ?? process.env.TASK_ID ?? "manual-watcher-tick";
const runId = process.env.SCHEDULER_RUN_ID ?? process.env.TASK_RUN_ID ?? process.env.RUN_ID ?? null;
const tickLimit = Number.parseInt(process.env.SPAWN_WATCHER_SCAN_LIMIT ?? "100", 10);
const routeLimit = positiveInteger(process.env.SPAWN_WATCHER_ROUTE_LIMIT, 3);
const cronPeriodSec = positiveInteger(process.env.SPAWN_WATCHER_CRON_PERIOD_SEC, 300);
const strictPredicateCutoverMs = positiveInteger(process.env.SPAWN_WATCHER_STRICT_CUTOVER_MS, 1778828828000);
const spawnOrphanThresholdSec = positiveInteger(process.env.SM_SPAWN_ORPHAN_THRESHOLD_SEC, 60);
const apiBase = process.env.SM_API_BASE ?? "http://localhost:3501";
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
const oneHourMs = 60 * 60 * 1000;
const oneDayMs = 24 * 60 * 60 * 1000;
const maxSignalAttempts24h = 3;
const skTarget = "socail-king";
const sourceSession = "supermatrix-root";
const sopPath = "<SM_WORKSPACE_ROOT>/socail-king/sop/spawn-exception-transaction.md";

const signalHints: Record<PredicateTriggerSignal, string[]> = {
  predicate_long_false: ["A", "E"],
  predicate_patch_churn: ["A"],
  child_unhealthy: ["B", "D"],
  delivery_failed: ["C", "D"],
  spawn_creation_missing_child: ["D"],
};

type OpenPredicateRow = {
  spawn_comm_id: string;
  predicate_json: string;
  predicate_hash: string;
  predicate_version: number;
  predicate_created_at: number;
  spawn_created_at: number | null;
  spawn_status: string | null;
  result_preview: string | null;
  final_message: string | null;
  message_run_id: string | null;
  from_session_name: string | null;
  to_session_name: string | null;
  child_session_id: string | null;
  child_session_name: string | null;
  child_session_status: string | null;
  last_run_at: number | null;
  last_run_result: PredicateEvaluationResult["result"] | null;
  last_run_error: string | null;
  last_run_duration_ms: number | null;
  consecutive_false_count: number | null;
  consecutive_transient_fail_count: number | null;
  patch_count_24h: number | null;
  transaction_started_at: number | null;
  last_trigger_signal: PredicateTriggerSignal | null;
  next_eligible_at: number | null;
  closed_at: number | null;
};

type TickSummary = {
  scannedCount: number;
  evaluatedCount: number;
  routedCount: number;
  status: "completed" | "failed";
  errorMessage: string | null;
};

type WatcherCounts = {
  consecutiveFalseCount: number;
  consecutiveTransientFailCount: number;
  patchCount: number;
  closedAt: number | null;
};

type SignalCandidate = {
  signal: PredicateTriggerSignal;
  reason: string;
};

type MessageRunSnapshot = {
  id: string;
  status: string;
  final_message: string | null;
  error_message: string | null;
  started_at: number;
  stream_log: string | null;
};

type PendingToolCallSnapshot = {
  callId: string;
  name: string;
  command?: string;
  ts: number | null;
};

type SinkAttemptSnapshot = {
  sink_kind: string;
  status: string;
  note: string | null;
  error_message: string | null;
  created_at: number;
};

type ContinuationFailureSnapshot = {
  id: string;
  status: string;
  error_message: string | null;
  created_at: number;
};

type PredicatePatchSnapshot = {
  version: number;
  actor_role: string;
  tx_id: string | null;
  reason: string;
  created_at: number;
};

type SkPayload = {
  kind: "spawn_exception_transaction";
  schema_version: 1;
  tx_id: string;
  dedupe_key: string;
  sop_path: string;
  trigger: {
    signal: PredicateTriggerSignal;
    sk_pattern_hints: string[];
    detected_at: number;
    reason: string;
  };
  spawn: {
    comm_id: string;
    from_session: string | null;
    to_session: string | null;
    created_at: number | null;
    status: string | null;
    child_session_id: string | null;
    child_session_name: string | null;
  };
  predicate: {
    version: number;
    hash: string;
    json: SpawnPredicate;
  };
  watcher_history: Array<{
    run_at: number | null;
    result: PredicateEvaluationResult["result"] | "unknown";
    duration_ms: number | null;
    error: string | null;
  }>;
  child: {
    status: string | null;
    latest_message_run_status: string | null;
    final_message_preview: string;
    pending_tool_calls: PendingToolCallSnapshot[];
  };
  delivery: {
    sink_attempts: Array<{
      sink_kind: string;
      status: string;
      note: string | null;
    }>;
  };
  patches: PredicatePatchSnapshot[];
};

type CurlJsonResult = {
  curlOk: boolean;
  httpStatus: number | null;
  bodyText: string;
  json: Record<string, unknown> | null;
  errorMessage: string | null;
};

let txSequenceOffset = 0;
const tableColumnCache = new Map<string, Set<string>>();

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberValue(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function createJsonLogger(): Logger {
  const write = (level: "debug" | "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => {
    const event = fields && typeof fields.closure_event === "string" ? fields.closure_event : message;
    console.log(JSON.stringify({ level, event, message, ...(fields ?? {}) }));
  };
  const logger: Logger = {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: () => logger,
  };
  return logger;
}

function parsePredicate(row: OpenPredicateRow): SpawnPredicate {
  return JSON.parse(row.predicate_json) as SpawnPredicate;
}

function assertRequiredWatcherStateColumns(db: Database.Database): void {
  const columns = tableColumns(db, "watcher_state");
  const required = [
    "last_trigger_signal",
    "next_eligible_at",
    "consecutive_false_count",
    "consecutive_transient_fail_count",
    "patch_count_24h",
    "transaction_started_at",
  ];
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`prompt drift: watcher_state missing fields: ${missing.join(", ")}`);
  }
}

function patchCount24h(db: Database.Database, spawnCommId: string, now: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM spawn_predicate_patches
       WHERE spawn_comm_id = ? AND created_at >= ?`
    )
    .get(spawnCommId, now - oneDayMs) as { count: number };
  return row.count;
}

function upsertWatcherState(
  db: Database.Database,
  row: OpenPredicateRow,
  result: PredicateEvaluationResult,
  patchCount: number,
  now: number
): WatcherCounts {
  const currentFalseCount = row.consecutive_false_count ?? 0;
  const currentTransientCount = row.consecutive_transient_fail_count ?? 0;
  const consecutiveFalseCount = result.result === "false" ? currentFalseCount + 1 : 0;
  const consecutiveTransientFailCount =
    result.result === "transient_fail" ? currentTransientCount + 1 : 0;
  const closedAt = result.result === "true" ? now : row.closed_at;

  db.prepare(
    `INSERT INTO watcher_state
       (spawn_comm_id, last_run_at, last_run_result, last_run_error, last_run_duration_ms,
        consecutive_false_count, consecutive_transient_fail_count, patch_count_24h,
        transaction_started_at, last_trigger_signal, next_eligible_at, closed_at,
        lease_owner, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)
     ON CONFLICT(spawn_comm_id) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_run_result = excluded.last_run_result,
       last_run_error = excluded.last_run_error,
       last_run_duration_ms = excluded.last_run_duration_ms,
       consecutive_false_count = excluded.consecutive_false_count,
       consecutive_transient_fail_count = excluded.consecutive_transient_fail_count,
       patch_count_24h = excluded.patch_count_24h,
       closed_at = COALESCE(excluded.closed_at, watcher_state.closed_at),
       updated_at = excluded.updated_at`
  ).run(
    row.spawn_comm_id,
    now,
    result.result,
    result.error_message ?? result.reason ?? null,
    result.duration_ms,
    consecutiveFalseCount,
    consecutiveTransientFailCount,
    patchCount,
    closedAt ?? null,
    now,
    now
  );

  return {
    consecutiveFalseCount,
    consecutiveTransientFailCount,
    patchCount,
    closedAt: closedAt ?? null,
  };
}

function insertTick(db: Database.Database, summary: TickSummary): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO watcher_ticks
       (id, ts, task_id, run_id, scanned_count, evaluated_count, routed_count, status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `watcher_tick_${randomUUID()}`,
    now,
    taskId,
    runId,
    summary.scannedCount,
    summary.evaluatedCount,
    summary.routedCount,
    summary.status,
    summary.errorMessage
  );
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const cached = tableColumnCache.get(table);
  if (cached) return cached;
  const rows = db.pragma(`table_info(${quoteSqlIdentifier(table)})`) as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  tableColumnCache.set(table, columns);
  return columns;
}

function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function getLatestMessageRun(db: Database.Database, row: OpenPredicateRow): MessageRunSnapshot | null {
  const selectColumns = messageRunSnapshotColumns(db);
  if (row.message_run_id) {
    const byId = db
      .prepare(
        `SELECT ${selectColumns}
         FROM message_runs
         WHERE id = ?`
      )
      .get(row.message_run_id) as MessageRunSnapshot | undefined;
    if (byId) return byId;
  }
  if (!row.child_session_id) return null;
  return (
    (db
      .prepare(
        `SELECT ${selectColumns}
         FROM message_runs
         WHERE session_id = ?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(row.child_session_id) as MessageRunSnapshot | undefined) ?? null
  );
}

function messageRunSnapshotColumns(db: Database.Database): string {
  const columns = ["id", "status", "final_message", "error_message", "started_at"];
  if (tableColumns(db, "message_runs").has("stream_log")) {
    columns.push("stream_log");
  } else {
    columns.push("NULL AS stream_log");
  }
  return columns.join(", ");
}

function pendingToolCallsFromStreamLog(streamLog: string | null | undefined): PendingToolCallSnapshot[] {
  if (!streamLog) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(streamLog);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const pending = new Map<string, PendingToolCallSnapshot>();
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const callId = stringValue(entry.callId);
    if (!callId) continue;
    if (entry.kind === "tool_call") {
      const name = stringValue(entry.name) ?? "tool_call";
      const command = stringValue(entry.command);
      const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : null;
      pending.set(callId, {
        callId,
        name,
        ...(command ? { command } : {}),
        ts,
      });
    } else if (entry.kind === "tool_result") {
      pending.delete(callId);
    }
  }
  return [...pending.values()].slice(-10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function listDeliveryAttempts(db: Database.Database, row: OpenPredicateRow): SinkAttemptSnapshot[] {
  return db
    .prepare(
      `SELECT sink_kind, status, note, error_message, created_at
       FROM result_sink_attempts
       WHERE spawn_comm_id = ?
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(row.spawn_comm_id) as SinkAttemptSnapshot[];
}

function listContinuationFailures(db: Database.Database, row: OpenPredicateRow): ContinuationFailureSnapshot[] {
  if (!row.child_session_id) return [];
  return db
    .prepare(
      `SELECT id, status, error_message, created_at
       FROM cross_session_log
       WHERE kind = 'continuation'
         AND status = 'failed'
         AND (child_session_id = ? OR from_session_id = ?)
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(row.child_session_id, row.child_session_id) as ContinuationFailureSnapshot[];
}

function listPredicatePatches(db: Database.Database, spawnCommId: string): PredicatePatchSnapshot[] {
  return db
    .prepare(
      `SELECT version, actor_role, tx_id, reason, created_at
       FROM spawn_predicate_patches
       WHERE spawn_comm_id = ?
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(spawnCommId) as PredicatePatchSnapshot[];
}

function detectTriggerSignals(
  row: OpenPredicateRow,
  predicate: SpawnPredicate,
  counts: WatcherCounts,
  latestRun: MessageRunSnapshot | null,
  deliveryAttempts: SinkAttemptSnapshot[],
  continuationFailures: ContinuationFailureSnapshot[],
  now: number
): SignalCandidate[] {
  const signals: SignalCandidate[] = [];
  const expectedWindowSec = positiveNumberValue(predicate.expected_window_sec, 3600);
  const retryThreshold = positiveNumberValue(predicate.retry_on_transient_fail, 2);
  const longFalseThreshold = Math.ceil((expectedWindowSec * 1.5) / cronPeriodSec);

  if (counts.consecutiveFalseCount >= longFalseThreshold) {
    signals.push({
      signal: "predicate_long_false",
      reason: `predicate false for ${counts.consecutiveFalseCount} consecutive watcher runs (threshold ${longFalseThreshold})`,
    });
  }

  if (counts.patchCount >= 3) {
    signals.push({
      signal: "predicate_patch_churn",
      reason: `predicate patched ${counts.patchCount} times in the last 24h`,
    });
  }

  const childReasons: string[] = [];
  if (counts.closedAt === null && (row.child_session_status === "error" || row.child_session_status === "deleted")) {
    childReasons.push(`child session status=${row.child_session_status}`);
  }
  if (latestRun && (latestRun.status === "failed" || latestRun.status === "fail" || latestRun.status === "timeout")) {
    childReasons.push(`latest message_run status=${latestRun.status}`);
  }
  if (counts.consecutiveTransientFailCount > retryThreshold) {
    childReasons.push(
      `evaluator transient failures ${counts.consecutiveTransientFailCount} > retry threshold ${retryThreshold}`
    );
  }
  if (childReasons.length > 0) {
    signals.push({
      signal: "child_unhealthy",
      reason: childReasons.join("; "),
    });
  }

  const failedSinkAttempts = deliveryAttempts.filter((attempt) => attempt.status === "failed");
  if (failedSinkAttempts.length > 0 || continuationFailures.length > 0) {
    const reasons = [
      failedSinkAttempts.length > 0 ? `${failedSinkAttempts.length} failed result_sink_attempts` : null,
      continuationFailures.length > 0 ? `${continuationFailures.length} failed continuation rows` : null,
    ].filter((reason): reason is string => Boolean(reason));
    signals.push({
      signal: "delivery_failed",
      reason: reasons.join("; "),
    });
  }

  if (row.spawn_created_at !== null && now - row.spawn_created_at > oneHourMs && !row.child_session_id) {
    signals.push({
      signal: "spawn_creation_missing_child",
      reason: "spawn row older than 1h and child_session_id is null",
    });
  }

  return signals;
}

function isSignalEligible(
  db: Database.Database,
  row: OpenPredicateRow,
  signal: PredicateTriggerSignal,
  now: number
): { eligible: boolean; reason: string | null } {
  const recentRoutes = countRecentSignalRoutes(db, row.spawn_comm_id, signal, now, oneHourMs);
  if (recentRoutes > 0) {
    return {
      eligible: false,
      reason: `${signal} already routed for ${row.spawn_comm_id} in the last hour`,
    };
  }
  if (row.last_trigger_signal === signal && row.next_eligible_at !== null && row.next_eligible_at > now) {
    return {
      eligible: false,
      reason: `${signal} next eligible at ${row.next_eligible_at}`,
    };
  }
  return { eligible: true, reason: null };
}

function countRecentSignalRoutes(
  db: Database.Database,
  spawnCommId: string,
  signal: PredicateTriggerSignal,
  now: number,
  windowMs: number
): number {
  const columns = tableColumns(db, "watcher_exceptions");
  if (!columns.has("spawn_comm_id") || !columns.has("trigger_signal")) return 0;
  const timeColumn = columns.has("ts")
    ? "ts"
    : columns.has("created_at")
      ? "created_at"
      : columns.has("detected_at")
        ? "detected_at"
        : null;
  if (!timeColumn) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM watcher_exceptions
       WHERE spawn_comm_id = ?
         AND trigger_signal = ?
         AND ${quoteSqlIdentifier(timeColumn)} >= ?`
    )
    .get(spawnCommId, signal, now - windowMs) as { count: number } | undefined;
  return row?.count ?? 0;
}

function updateTriggerState(
  db: Database.Database,
  spawnCommId: string,
  signal: PredicateTriggerSignal,
  now: number
): void {
  db.prepare(
    `UPDATE watcher_state
     SET transaction_started_at = ?,
         last_trigger_signal = ?,
         next_eligible_at = ?,
         updated_at = ?
     WHERE spawn_comm_id = ?`
  ).run(now, signal, now + oneHourMs, now, spawnCommId);
}

function nextTxId(db: Database.Database, now: number): string {
  const prefix = `tx-spawn-${formatLocalDateYmd(now)}`;
  const columns = tableColumns(db, "watcher_exceptions");
  let existingCount = 0;
  if (columns.has("tx_id")) {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM watcher_exceptions WHERE tx_id LIKE ?")
      .get(`${prefix}-%`) as { count: number } | undefined;
    existingCount = row?.count ?? 0;
  }
  txSequenceOffset += 1;
  return `${prefix}-${String(existingCount + txSequenceOffset).padStart(3, "0")}`;
}

function formatLocalDateYmd(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function buildSkPayload(
  row: OpenPredicateRow,
  predicate: SpawnPredicate,
  result: PredicateEvaluationResult,
  counts: WatcherCounts,
  candidate: SignalCandidate,
  latestRun: MessageRunSnapshot | null,
  deliveryAttempts: SinkAttemptSnapshot[],
  patches: PredicatePatchSnapshot[],
  txId: string,
  now: number
): SkPayload {
  return {
    kind: "spawn_exception_transaction",
    schema_version: 1,
    tx_id: txId,
    dedupe_key: `${row.spawn_comm_id}:${candidate.signal}`,
    sop_path: sopPath,
    trigger: {
      signal: candidate.signal,
      sk_pattern_hints: signalHints[candidate.signal],
      detected_at: now,
      reason: candidate.reason,
    },
    spawn: {
      comm_id: row.spawn_comm_id,
      from_session: row.from_session_name,
      to_session: row.to_session_name,
      created_at: row.spawn_created_at ?? row.predicate_created_at,
      status: row.spawn_status,
      child_session_id: row.child_session_id,
      child_session_name: row.child_session_name,
    },
    predicate: {
      version: row.predicate_version,
      hash: row.predicate_hash,
      json: predicate,
    },
    watcher_history: buildWatcherHistory(row, result, counts, now),
    child: {
      status: row.child_session_status,
      latest_message_run_status: latestRun?.status ?? null,
      final_message_preview: previewText(row.final_message ?? latestRun?.final_message ?? row.result_preview ?? ""),
      pending_tool_calls: pendingToolCallsFromStreamLog(latestRun?.stream_log),
    },
    delivery: {
      sink_attempts: deliveryAttempts.slice(0, 10).map((attempt) => ({
        sink_kind: attempt.sink_kind,
        status: attempt.status,
        note: attempt.note ?? attempt.error_message,
      })),
    },
    patches,
  };
}

function buildWatcherHistory(
  row: OpenPredicateRow,
  result: PredicateEvaluationResult,
  counts: WatcherCounts,
  now: number
): SkPayload["watcher_history"] {
  const history: SkPayload["watcher_history"] = [];
  if (row.last_run_at !== null) {
    history.push({
      run_at: row.last_run_at,
      result: row.last_run_result ?? "unknown",
      duration_ms: row.last_run_duration_ms,
      error: row.last_run_error,
    });
  }
  history.push({
    run_at: now,
    result: result.result,
    duration_ms: result.duration_ms,
    error: result.error_message ?? result.reason ?? null,
  });
  const latest = history[history.length - 1];
  if (latest && result.result === "false" && latest.error === null && counts.consecutiveFalseCount > history.length) {
    latest.error = `consecutive_false_count=${counts.consecutiveFalseCount}`;
  }
  return history.slice(-5);
}

function previewText(text: string): string {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

async function routeToSkOrFallback(db: Database.Database, payload: SkPayload): Promise<boolean> {
  const attempts24h = countRecentSignalRoutes(
    db,
    payload.spawn.comm_id,
    payload.trigger.signal,
    payload.trigger.detected_at,
    oneDayMs
  );
  if (attempts24h >= maxSignalAttempts24h) {
    const reason = `${payload.trigger.signal} retried ${attempts24h} times in 24h; using /api/notify fallback`;
    return postNotifyFallback(payload, reason);
  }

  const requestBody = {
    target: skTarget,
    from: sourceSession,
    supermatrix_internal: { caller_invocation: "async_kickoff" },
    prompt: `STRUCTURED_SPAWN_EXCEPTION_TRANSACTION_PAYLOAD\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    verification_predicate: {
      type: "inbox-message",
      session_name: skTarget,
      field: "prompt",
      contains_all: ["spawn_exception_transaction", payload.tx_id, payload.spawn.comm_id],
      expected_window_sec: 600,
    },
  };

  const spawnResult = curlPostJson(`${apiBase}/api/spawn`, requestBody, 30);
  if (!isHttpJsonOk(spawnResult)) {
    const reason = `SK spawn failed: ${spawnResult.errorMessage ?? `HTTP ${spawnResult.httpStatus}`}`;
    console.error(JSON.stringify({ level: "error", tx_id: payload.tx_id, error: reason }));
    postNotifyFallback(payload, reason);
    return false;
  }

  const childSessionId = await waitForChildSessionId(db, spawnResult.json);
  if (!childSessionId) {
    const reason = "SK spawn returned ok=true but child_session_id was not visible within 10s";
    console.error(JSON.stringify({ level: "error", tx_id: payload.tx_id, error: reason }));
    postNotifyFallback(payload, reason);
    return false;
  }

  return true;
}

function curlPostJson(url: string, body: unknown, timeoutSec: number): CurlJsonResult {
  const proc = spawnSync(
    "curl",
    [
      "-sS",
      "-m",
      String(timeoutSec),
      "-w",
      "\n__HTTP_STATUS__:%{http_code}",
      "-X",
      "POST",
      url,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      JSON.stringify(body),
    ],
    { encoding: "utf8" }
  );

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const marker = "\n__HTTP_STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  const bodyText = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const httpStatus =
    markerIndex >= 0 ? Number.parseInt(stdout.slice(markerIndex + marker.length).trim(), 10) : null;
  let json: Record<string, unknown> | null = null;
  if (bodyText.trim()) {
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
  }
  const errorMessage =
    proc.error?.message ??
    (proc.status === 0 ? null : stderr.trim() || `curl exited ${proc.status}`) ??
    null;

  return {
    curlOk: proc.status === 0 && !proc.error,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    bodyText,
    json,
    errorMessage,
  };
}

function isHttpJsonOk(result: CurlJsonResult): boolean {
  if (!result.curlOk) return false;
  if (result.httpStatus === null || result.httpStatus < 200 || result.httpStatus >= 300) return false;
  if (result.json?.ok !== true) return false;
  return true;
}

async function waitForChildSessionId(
  db: Database.Database,
  response: Record<string, unknown> | null
): Promise<string | null> {
  const immediate = response?.childSessionId;
  if (typeof immediate === "string" && immediate.length > 0) return immediate;
  const responseSpawnCommId = response?.spawnCommId;
  const deadline = Date.now() + 10_000;
  if (typeof responseSpawnCommId !== "string" || responseSpawnCommId.length === 0) {
    await sleep(10_000);
    return null;
  }
  while (Date.now() < deadline) {
    const row = db
      .prepare("SELECT child_session_id FROM cross_session_log WHERE id = ?")
      .get(responseSpawnCommId) as { child_session_id: string | null } | undefined;
    if (row?.child_session_id) return row.child_session_id;
    await sleep(500);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postNotifyFallback(payload: SkPayload, reason: string): boolean {
  const body = {
    kind: "spawn_exception_transaction_fallback",
    tx_id: payload.tx_id,
    dedupe_key: payload.dedupe_key,
    spawn_comm_id: payload.spawn.comm_id,
    trigger_signal: payload.trigger.signal,
    summary: [
      `SK fallback for ${payload.trigger.signal}`,
      `spawn ${payload.spawn.from_session ?? "unknown"} -> ${payload.spawn.to_session ?? "unknown"} (${payload.spawn.comm_id})`,
      reason,
    ].join(" | "),
    payload: {
      fallback_reason: reason,
      sk_payload: payload,
    },
  };
  const notifyResult = curlPostJson(`${apiBase}/api/notify`, body, 15);
  if (!isHttpJsonOk(notifyResult)) {
    const error = notifyResult.errorMessage ?? `HTTP ${notifyResult.httpStatus}`;
    console.error(JSON.stringify({ level: "error", tx_id: payload.tx_id, error: `/api/notify failed: ${error}` }));
    return false;
  }
  return true;
}

async function runTick(db: Database.Database): Promise<TickSummary> {
  const now = Date.now();
  const cutoff = now - sevenDaysMs;
  assertRequiredWatcherStateColumns(db);
  const rows = db
    .prepare(
      `SELECT
         p.spawn_comm_id,
         p.predicate_json,
         p.predicate_hash,
         p.version AS predicate_version,
         p.created_at AS predicate_created_at,
         c.created_at AS spawn_created_at,
         c.status AS spawn_status,
         c.result_preview,
         c.final_message,
         c.message_run_id,
         from_session.name AS from_session_name,
         to_session.name AS to_session_name,
         c.child_session_id,
         child_session.name AS child_session_name,
         child_session.status AS child_session_status,
         w.last_run_at,
         w.last_run_result,
         w.last_run_error,
         w.last_run_duration_ms,
         w.consecutive_false_count,
         w.consecutive_transient_fail_count,
         w.patch_count_24h,
         w.transaction_started_at,
         w.last_trigger_signal,
         w.next_eligible_at,
         w.closed_at
       FROM spawn_predicates p
       LEFT JOIN cross_session_log c ON c.id = p.spawn_comm_id
       LEFT JOIN sessions from_session ON from_session.id = c.from_session_id
       LEFT JOIN sessions to_session ON to_session.id = c.to_session_id
       LEFT JOIN sessions child_session ON child_session.id = c.child_session_id
       LEFT JOIN watcher_state w ON w.spawn_comm_id = p.spawn_comm_id
       WHERE p.status = 'active'
         AND p.predicate_json IS NOT NULL
         AND TRIM(p.predicate_json) != ''
         AND COALESCE(w.closed_at, 0) = 0
         AND COALESCE(c.created_at, p.created_at) >= ?
         AND COALESCE(c.created_at, p.created_at) >= ?
       ORDER BY p.created_at ASC
       LIMIT ?`
    )
    .all(
      cutoff,
      strictPredicateCutoverMs,
      Number.isFinite(tickLimit) && tickLimit > 0 ? tickLimit : 100
    ) as OpenPredicateRow[];

  let evaluatedCount = 0;
  let routedCount = 0;
  let routingStoppedReason: string | null = null;
  const dbRegistry = loadSqlitePredicateDbRegistry({
    logger: {
      warn(message, metadata) {
        console.warn(JSON.stringify({ level: "warn", message, metadata }));
      },
    },
  });

  for (const row of rows) {
    const predicate = parsePredicate(row);
    const result = await evaluateSpawnPredicate(predicate, {
      dbRegistry,
      env: process.env,
      spawnCreatedAtMs: row.spawn_created_at ?? row.predicate_created_at,
    });
    const completedAt = Date.now();
    const patchCount = patchCount24h(db, row.spawn_comm_id, completedAt);
    const counts = upsertWatcherState(db, row, result, patchCount, completedAt);
    evaluatedCount += 1;

    const latestRun = getLatestMessageRun(db, row);
    const deliveryAttempts = listDeliveryAttempts(db, row);
    const continuationFailures = listContinuationFailures(db, row);
    const patches = listPredicatePatches(db, row.spawn_comm_id);
    const signalCandidates = detectTriggerSignals(
      row,
      predicate,
      counts,
      latestRun,
      deliveryAttempts,
      continuationFailures,
      completedAt
    );
    const routeState = { ...row };
    for (const candidate of signalCandidates) {
      if (routingStoppedReason) {
        console.warn(JSON.stringify({
          level: "warn",
          spawn_comm_id: row.spawn_comm_id,
          signal: candidate.signal,
          skipped: true,
          reason: routingStoppedReason,
        }));
        continue;
      }
      if (routedCount >= routeLimit) {
        routingStoppedReason = `route limit ${routeLimit} reached for this watcher tick`;
        console.warn(JSON.stringify({
          level: "warn",
          spawn_comm_id: row.spawn_comm_id,
          signal: candidate.signal,
          skipped: true,
          reason: routingStoppedReason,
        }));
        continue;
      }
      const eligibility = isSignalEligible(db, routeState, candidate.signal, completedAt);
      if (!eligibility.eligible) {
        console.warn(JSON.stringify({
          level: "warn",
          spawn_comm_id: row.spawn_comm_id,
          signal: candidate.signal,
          deduped: true,
          reason: eligibility.reason,
        }));
        continue;
      }
      const txId = nextTxId(db, completedAt);
      const payload = buildSkPayload(
        row,
        predicate,
        result,
        counts,
        candidate,
        latestRun,
        deliveryAttempts,
        patches,
        txId,
        completedAt
      );
      updateTriggerState(db, row.spawn_comm_id, candidate.signal, completedAt);
      routeState.last_trigger_signal = candidate.signal;
      routeState.next_eligible_at = completedAt + oneHourMs;
      routeState.transaction_started_at = completedAt;
      routedCount += 1;
      const routed = await routeToSkOrFallback(db, payload);
      if (!routed) {
        routingStoppedReason = `SK route failed for ${row.spawn_comm_id}:${candidate.signal}; stopping watcher routing for this tick`;
      }
    }
  }

  return {
    scannedCount: rows.length,
    evaluatedCount,
    routedCount,
    status: "completed",
    errorMessage: null,
  };
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

let summary: TickSummary = {
  scannedCount: 0,
  evaluatedCount: 0,
  routedCount: 0,
  status: "failed",
  errorMessage: null,
};

try {
  recoverSpawnCommOrphans({
    db,
    now: Date.now(),
    thresholdSec: spawnOrphanThresholdSec,
    source: "watcher_tick",
    logger: createJsonLogger(),
  });
  summary = await runTick(db);
} catch (error) {
  summary = {
    ...summary,
    status: "failed",
    errorMessage: compactError(error),
  };
  console.error(JSON.stringify({ level: "error", error: summary.errorMessage }));
} finally {
  try {
    insertTick(db, summary);
    console.log(JSON.stringify({
      ok: summary.status === "completed",
      dbPath,
      taskId,
      runId,
      ...summary,
    }));
  } finally {
    db.close();
  }
}
TS
