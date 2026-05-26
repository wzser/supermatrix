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

const dbPath = process.env.SM_DB_PATH ?? "<SM_RUNTIME_ROOT>/data/supermatrix.db";
const scanLimit = positiveInteger(process.env.SPAWN_CLOSURE_SCAN_LIMIT, 100);
const spawnOrphanThresholdSec = positiveInteger(process.env.SM_SPAWN_ORPHAN_THRESHOLD_SEC, 60);
const heartbeatEnqueuePath =
  process.env.SPAWN_CLOSURE_HEARTBEAT_ENQUEUE ??
  "<SM_WORKSPACE_ROOT>/heartbeat/scripts/enqueue-heartbeat-todo";
const apiBase = process.env.SM_API_BASE ?? "http://localhost:3501";
const sourceSession = process.env.SPAWN_CLOSURE_SOURCE_SESSION ?? "supermatrix-root";
const sopPath =
  process.env.SPAWN_CLOSURE_ADJUDICATION_SOP ??
  "<SM_WORKSPACE_ROOT>/socail-king/sop/spawn-exception-transaction.md";

type TickSummary = {
  event: "spawn_closure_watcher_tick";
  scanned: number;
  routed: { deliver: number; redrive: number; redeliver: number; adjudicate: number; noop: number; failed: number };
  status: "completed" | "failed";
  errorMessage: string | null;
};

const summary: TickSummary = {
  event: "spawn_closure_watcher_tick",
  scanned: 0,
  routed: { deliver: 0, redrive: 0, redeliver: 0, adjudicate: 0, noop: 0, failed: 0 },
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
  });
  const rows = db
    .prepare(
      `SELECT ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
              attempt_count, status, verdict, verdict_reason, created_at, updated_at, last_attempt_at
       FROM spawn_async_items
       WHERE status IN ('pending', 'waiting_child', 'delivering', 're_driving', 'adjudicating')
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .all(scanLimit) as SpawnAsyncItem[];

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
