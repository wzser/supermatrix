import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { HealAction, HealProposal, HealProposalStatus } from "./types.js";

export type HealStore = {
  scheduleProposal(params: {
    taskId: string;
    runId: string;
    reason: string;
    spawnedAt: number;
    childSessionId: string | null;
  }): HealProposal;
  getProposal(id: string): HealProposal | undefined;
  listPending(): HealProposal[];
  listPendingRetry(): HealProposal[];
  listAll(status?: HealProposalStatus): HealProposal[];
  markReplied(id: string, action: HealAction, raw: string, repliedAt: number): void;
  markDefaultApplied(id: string, defaultAction: HealAction, appliedAt: number): void;
  markPendingRetry(id: string, newChildSessionId?: string | null): void;
  countSkipsLast30Days(taskId: string, nowMs: number): number;
  /**
   * Counts how many of the task's most-recent runs were resolved SKIP, walking
   * back from the latest run and stopping at the first successful run. Runs that
   * neither succeeded nor were SKIP'd (pending heal, retry, trigger_failed) are
   * ignored — they neither extend nor break the streak. Frequency-independent:
   * scattered SKIPs on a high-cadence task reset to 0 as soon as one run succeeds.
   */
  countConsecutiveSkippedRunsSinceSuccess(taskId: string): number;
  promoteToPending(id: string, newChildSessionId: string): void;
};

function rowToProposal(row: Record<string, unknown>): HealProposal {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    reason: row.reason as string,
    spawnedAt: row.spawned_at as number,
    childSessionId: (row.child_session_id as string | null) ?? null,
    status: row.status as HealProposalStatus,
    spawnRetryCount: (row.spawn_retry_count as number) ?? 0,
    replyAction: (row.reply_action as HealAction | null) ?? null,
    replyRaw: (row.reply_raw as string | null) ?? null,
    repliedAt: (row.replied_at as number | null) ?? null,
    defaultAppliedAt: (row.default_applied_at as number | null) ?? null,
  };
}

export function createHealStore(db: Database.Database): HealStore {
  const insert = db.prepare(`
    INSERT INTO heal_proposals (id, task_id, run_id, reason, spawned_at, child_session_id, status, spawn_retry_count)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
  `);
  const getStmt = db.prepare("SELECT * FROM heal_proposals WHERE id = ?");
  const listPendingStmt = db.prepare("SELECT * FROM heal_proposals WHERE status = 'pending' ORDER BY spawned_at ASC");
  const listRetryStmt = db.prepare("SELECT * FROM heal_proposals WHERE status = 'pending_retry' ORDER BY spawned_at ASC");
  const markRepliedStmt = db.prepare(`
    UPDATE heal_proposals
    SET status = 'replied', reply_action = ?, reply_raw = ?, replied_at = ?
    WHERE id = ?
  `);
  const markDefaultStmt = db.prepare(`
    UPDATE heal_proposals
    SET status = 'default_applied', reply_action = ?, default_applied_at = ?
    WHERE id = ?
  `);
  const markRetryStmt = db.prepare(`
    UPDATE heal_proposals
    SET status = 'pending_retry', spawn_retry_count = spawn_retry_count + 1, child_session_id = COALESCE(?, child_session_id)
    WHERE id = ?
  `);
  const promoteStmt = db.prepare(`
    UPDATE heal_proposals
    SET status = 'pending', child_session_id = ?
    WHERE id = ?
  `);
  const countSkipsStmt = db.prepare(`
    SELECT COUNT(*) as n FROM heal_proposals
    WHERE task_id = ?
      AND reply_action = 'SKIP'
      AND COALESCE(replied_at, default_applied_at, 0) >= ?
  `);
  const consecutiveSkipStmt = db.prepare(`
    SELECT r.final_status AS final_status,
      EXISTS(
        SELECT 1 FROM heal_proposals h
        WHERE h.run_id = r.id AND h.reply_action = 'SKIP'
      ) AS is_skip
    FROM task_runs r
    WHERE r.task_id = ?
    ORDER BY r.started_at DESC, r.rowid DESC
  `);
  const listAllStmt = db.prepare("SELECT * FROM heal_proposals ORDER BY spawned_at DESC");
  const listByStatusStmt = db.prepare("SELECT * FROM heal_proposals WHERE status = ? ORDER BY spawned_at DESC");

  return {
    scheduleProposal(params) {
      const id = randomUUID();
      insert.run(id, params.taskId, params.runId, params.reason, params.spawnedAt, params.childSessionId);
      return {
        id,
        taskId: params.taskId,
        runId: params.runId,
        reason: params.reason,
        spawnedAt: params.spawnedAt,
        childSessionId: params.childSessionId,
        status: "pending",
        spawnRetryCount: 0,
        replyAction: null,
        replyRaw: null,
        repliedAt: null,
        defaultAppliedAt: null,
      };
    },
    getProposal(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToProposal(row) : undefined;
    },
    listPending() {
      return (listPendingStmt.all() as Record<string, unknown>[]).map(rowToProposal);
    },
    listPendingRetry() {
      return (listRetryStmt.all() as Record<string, unknown>[]).map(rowToProposal);
    },
    markReplied(id, action, raw, repliedAt) {
      markRepliedStmt.run(action, raw, repliedAt, id);
    },
    markDefaultApplied(id, defaultAction, appliedAt) {
      markDefaultStmt.run(defaultAction, appliedAt, id);
    },
    markPendingRetry(id, newChildSessionId) {
      markRetryStmt.run(newChildSessionId ?? null, id);
    },
    countSkipsLast30Days(taskId, nowMs) {
      const threshold = nowMs - 30 * 24 * 3600_000;
      const row = countSkipsStmt.get(taskId, threshold) as { n: number };
      return row.n;
    },
    countConsecutiveSkippedRunsSinceSuccess(taskId) {
      const rows = consecutiveSkipStmt.all(taskId) as Array<{ final_status: string; is_skip: number }>;
      let streak = 0;
      for (const row of rows) {
        if (row.final_status === "success") break;
        if (row.is_skip) streak++;
      }
      return streak;
    },
    promoteToPending(id, newChildSessionId) {
      promoteStmt.run(newChildSessionId, id);
    },
    listAll(status) {
      const rows = (status ? listByStatusStmt.all(status) : listAllStmt.all()) as Record<string, unknown>[];
      return rows.map(rowToProposal);
    },
  };
}
