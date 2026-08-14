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
import Database from "better-sqlite3";
import { recoverSpawnCommOrphans } from "./src/app/spawnClosure/orphanSweep.ts";
import { classifyAndRoute, type SpawnAsyncItem } from "./scripts/lib/spawnClosureClassify.ts";
import type { Logger } from "./src/ports/Logger.ts";

const dbPath = process.env.SM_DB_PATH ?? "/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db";
const scanLimit = positiveInteger(process.env.SPAWN_CLOSURE_SCAN_LIMIT, 100);
const deliveryScanLimit = positiveInteger(
  process.env.SPAWN_CLOSURE_DELIVERY_SCAN_LIMIT,
  Math.max(scanLimit, 25),
);
const maxItemAgeMs = positiveInteger(process.env.SPAWN_CLOSURE_MAX_ITEM_AGE_MS, 6 * 60 * 60 * 1000);
const spawnOrphanThresholdSec = positiveInteger(process.env.SM_SPAWN_ORPHAN_THRESHOLD_SEC, 60);
const heartbeatEnqueuePath =
  process.env.SPAWN_CLOSURE_HEARTBEAT_ENQUEUE ??
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/scripts/enqueue-heartbeat-todo";
const apiBase = process.env.SM_API_BASE ?? "http://localhost:3501";
const sourceSession = process.env.SPAWN_CLOSURE_SOURCE_SESSION ?? "supermatrix-root";
const sopPath =
  process.env.SPAWN_CLOSURE_ADJUDICATION_SOP ??
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/socail-king/sop/spawn-exception-transaction.md";

type TickSummary = {
  event: "spawn_closure_watcher_tick";
  scanned: number;
  routed: { deliver: number; failure_notice: number; redrive: number; redeliver: number; adjudicate: number; noop: number; failed: number };
  status: "completed" | "failed";
  errorMessage: string | null;
};

const summary: TickSummary = {
  event: "spawn_closure_watcher_tick",
  scanned: 0,
  routed: { deliver: 0, failure_notice: 0, redrive: 0, redeliver: 0, adjudicate: 0, noop: 0, failed: 0 },
  status: "completed",
  errorMessage: null,
};

const db = new Database(dbPath);
try {
  recoverSpawnCommOrphans({
    db,
    now: Date.now(),
    thresholdSec: spawnOrphanThresholdSec,
    source: "watcher_tick",
    logger: createJsonLogger(),
    maxAgeMs: maxItemAgeMs,
  });
  const cutoff = Date.now() - maxItemAgeMs;
  const deliveryReadyRows = db
    .prepare(
      `SELECT sai.ref, sai.comm_id, sai.caller_session, sai.target_session,
              c.client_request_id, c.origin_run_id,
              sai.failed_phase, sai.failure_kind, sai.attempt_count, sai.status,
              sai.verdict, sai.verdict_reason, sai.created_at, sai.updated_at,
              sai.last_attempt_at
       FROM spawn_async_items sai
       JOIN cross_session_log c ON c.id = sai.comm_id
       LEFT JOIN message_runs mr ON mr.id = c.message_run_id
       WHERE sai.status IN ('pending', 'waiting_child')
         AND sai.created_at >= ?
         AND TRIM(COALESCE(mr.final_message, c.final_message, '')) <> ''
         AND COALESCE(mr.status, c.status) NOT IN ('failed', 'timeout', 'error', 'cancelled')
       ORDER BY sai.updated_at ASC
       LIMIT ?`
    )
    .all(cutoff, deliveryScanLimit) as SpawnAsyncItem[];

  const deliveryReadyRefs = deliveryReadyRows.map((row) => row.ref);
  const excludeReadyRefsSql = deliveryReadyRefs.length > 0
    ? `AND ref NOT IN (${deliveryReadyRefs.map(() => "?").join(", ")})`
    : "";
  const normalRows = db
    .prepare(
      `SELECT sai.ref, sai.comm_id, sai.caller_session, sai.target_session,
              c.client_request_id, c.origin_run_id, sai.failed_phase, sai.failure_kind,
              sai.attempt_count, sai.status, sai.verdict, sai.verdict_reason,
              sai.created_at, sai.updated_at, sai.last_attempt_at
       FROM spawn_async_items sai
       LEFT JOIN cross_session_log c ON c.id = sai.comm_id
       WHERE sai.status IN ('pending', 'waiting_child', 'delivering', 're_driving', 'adjudicating')
         AND sai.created_at >= ?
         ${excludeReadyRefsSql}
       ORDER BY sai.updated_at ASC
       LIMIT ?`
    )
    .all(cutoff, ...deliveryReadyRefs, scanLimit) as SpawnAsyncItem[];

  const rows = [...deliveryReadyRows, ...normalRows];

  summary.scanned = rows.length;
  for (const item of rows) {
    try {
      const result = await classifyAndRoute({
        item,
        db,
        heartbeatEnqueuePath,
        apiBase,
        sourceSession,
        sopPath,
      });
      summary.routed[result.action] += 1;
    } catch (err) {
      summary.routed.failed += 1;
      console.error(JSON.stringify({
        event: "spawn_closure_watcher_item_failed",
        comm_id: item.comm_id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }
} catch (err) {
  summary.status = "failed";
  summary.errorMessage = err instanceof Error ? err.message : String(err);
  process.exitCode = 1;
} finally {
  db.close();
  console.log(JSON.stringify(summary));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
TS
