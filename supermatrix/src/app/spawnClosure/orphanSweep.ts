import type Database from "better-sqlite3";
import type { Timestamp } from "../../domain/ids.ts";
import type { Logger } from "../../ports/Logger.ts";
import { logClosureEvent } from "./closureLog.ts";

export type SpawnCommOrphanSweepSource = "startup" | "watcher_tick";

export type RecoveredSpawnCommOrphan = {
  commId: string;
  callerSession: string | null;
  targetSession: string | null;
  createdAt: number;
  ageSeconds: number;
  ref: string;
};

type CandidateRow = {
  comm_id: string;
  caller_session: string | null;
  target_session: string | null;
  created_at: number;
};

export function recoverSpawnCommOrphans(input: {
  db: Database.Database;
  now: Timestamp | number;
  thresholdSec: number;
  source: SpawnCommOrphanSweepSource;
  logger?: Logger;
  limit?: number;
}): RecoveredSpawnCommOrphan[] {
  const now = Number(input.now);
  const thresholdSec = positiveNumber(input.thresholdSec, 60);
  const cutoff = now - thresholdSec * 1000;
  const limit = Math.max(1, Math.trunc(input.limit ?? 1000));
  const candidates = input.db
    .prepare(
      `SELECT c.id AS comm_id,
              fs.name AS caller_session,
              ts.name AS target_session,
              c.created_at
       FROM cross_session_log c
       LEFT JOIN sessions fs ON fs.id = c.from_session_id
       LEFT JOIN sessions ts ON ts.id = c.to_session_id
       WHERE c.kind = 'spawn'
         AND c.status = 'pending'
         AND c.child_session_id IS NULL
         AND c.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM spawn_async_items sai WHERE sai.comm_id = c.id
         )
       ORDER BY c.created_at ASC
       LIMIT ?`
    )
    .all(cutoff, limit) as CandidateRow[];

  const inserted = input.db.transaction((rows: CandidateRow[]) => {
    const recovered: RecoveredSpawnCommOrphan[] = [];
    const insert = input.db.prepare(
      `INSERT INTO spawn_async_items
         (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
          attempt_count, status, verdict, verdict_reason, created_at, updated_at, last_attempt_at)
       SELECT ?, c.id, ?, ?, 'communication', 'spawn_not_started',
              0, 'pending', NULL, NULL, ?, ?, NULL
       FROM cross_session_log c
       WHERE c.id = ?
         AND c.kind = 'spawn'
         AND c.status = 'pending'
         AND c.child_session_id IS NULL
         AND c.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM spawn_async_items sai WHERE sai.comm_id = c.id
         )`
    );

    for (const row of rows) {
      const ref = `async_orphan_${row.comm_id}`;
      const result = insert.run(
        ref,
        row.caller_session,
        row.target_session,
        now,
        now,
        row.comm_id,
        cutoff,
      );
      if (result.changes === 0) continue;
      recovered.push({
        commId: row.comm_id,
        callerSession: row.caller_session,
        targetSession: row.target_session,
        createdAt: row.created_at,
        ageSeconds: Math.floor((now - row.created_at) / 1000),
        ref,
      });
    }
    return recovered;
  })(candidates);

  for (const row of inserted) {
    if (!input.logger) continue;
    logClosureEvent(input.logger, {
      event: "spawn_comm_orphan_recovered",
      commId: row.commId,
      callerSession: row.callerSession,
      targetSession: row.targetSession,
      createdAt: row.createdAt,
      ageSeconds: row.ageSeconds,
      source: input.source,
    });
  }

  return inserted;
}

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
