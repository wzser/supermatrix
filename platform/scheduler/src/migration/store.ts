import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { TaskClass } from "../classes/types.js";
import type { MigrationAction, MigrationProposal, MigrationProposalStatus } from "./types.js";

export type MigrationStore = {
  scheduleProposal(params: {
    taskId: string;
    ownerSession: string;
    childSessionId: string | null;
    spawnedAt: number;
    suggestedClass: TaskClass;
    suggestedExpectedDurationMs: number;
  }): MigrationProposal;
  getProposal(id: string): MigrationProposal | undefined;
  listPending(): MigrationProposal[];
  listAll(status?: MigrationProposalStatus): MigrationProposal[];
  ownerHasPendingProposal(ownerSession: string): boolean;
  latestForTask(taskId: string): MigrationProposal | undefined;
  countLaterForTask(taskId: string): number;
  markReplied(id: string, action: MigrationAction, raw: string, repliedAt: number): void;
  markDefaultApplied(id: string, defaultAction: MigrationAction, appliedAt: number): void;
  isPreviewSent(ownerSession: string): boolean;
  markPreviewSent(ownerSession: string, atMs: number): void;
  firstSpawnedAtForTask(taskId: string): number | null;
};

function rowToProposal(row: Record<string, unknown>): MigrationProposal {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    ownerSession: row.owner_session as string,
    status: row.status as MigrationProposalStatus,
    childSessionId: (row.child_session_id as string | null) ?? null,
    spawnedAt: row.spawned_at as number,
    repliedAt: (row.replied_at as number | null) ?? null,
    replyAction: (row.reply_action as MigrationAction | null) ?? null,
    replyRaw: (row.reply_raw as string | null) ?? null,
    defaultAppliedAt: (row.default_applied_at as number | null) ?? null,
    suggestedClass: row.suggested_class as TaskClass,
    suggestedExpectedDurationMs: row.suggested_expected_duration_ms as number,
  };
}

export function createMigrationStore(db: Database.Database): MigrationStore {
  const insert = db.prepare(`
    INSERT INTO migration_proposals (id, task_id, owner_session, status, child_session_id, spawned_at, suggested_class, suggested_expected_duration_ms)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `);
  const getStmt = db.prepare("SELECT * FROM migration_proposals WHERE id = ?");
  const listPendingStmt = db.prepare("SELECT * FROM migration_proposals WHERE status = 'pending' ORDER BY spawned_at ASC");
  const ownerPendingStmt = db.prepare("SELECT COUNT(*) as n FROM migration_proposals WHERE owner_session = ? AND status = 'pending'");
  const latestForTaskStmt = db.prepare("SELECT * FROM migration_proposals WHERE task_id = ? ORDER BY spawned_at DESC LIMIT 1");
  const countLaterStmt = db.prepare("SELECT COUNT(*) as n FROM migration_proposals WHERE task_id = ? AND reply_action = 'LATER'");
  const markRepliedStmt = db.prepare(`
    UPDATE migration_proposals
    SET status = 'replied', reply_action = ?, reply_raw = ?, replied_at = ?
    WHERE id = ?
  `);
  const markDefaultStmt = db.prepare(`
    UPDATE migration_proposals
    SET status = 'default_applied', reply_action = ?, default_applied_at = ?
    WHERE id = ?
  `);
  const previewInsertStmt = db.prepare("INSERT OR REPLACE INTO migration_preview_sent (owner_session, sent_at) VALUES (?, ?)");
  const previewCheckStmt = db.prepare("SELECT owner_session FROM migration_preview_sent WHERE owner_session = ?");
  const firstSpawnedAtStmt = db.prepare("SELECT MIN(spawned_at) as ts FROM migration_proposals WHERE task_id = ?");
  const listAllStmt = db.prepare("SELECT * FROM migration_proposals ORDER BY spawned_at DESC");
  const listByStatusStmt = db.prepare("SELECT * FROM migration_proposals WHERE status = ? ORDER BY spawned_at DESC");

  return {
    scheduleProposal(params) {
      const id = randomUUID();
      insert.run(id, params.taskId, params.ownerSession, params.childSessionId, params.spawnedAt, params.suggestedClass, params.suggestedExpectedDurationMs);
      return {
        id,
        taskId: params.taskId,
        ownerSession: params.ownerSession,
        status: "pending",
        childSessionId: params.childSessionId,
        spawnedAt: params.spawnedAt,
        repliedAt: null,
        replyAction: null,
        replyRaw: null,
        defaultAppliedAt: null,
        suggestedClass: params.suggestedClass,
        suggestedExpectedDurationMs: params.suggestedExpectedDurationMs,
      };
    },
    getProposal(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToProposal(row) : undefined;
    },
    listPending() {
      return (listPendingStmt.all() as Record<string, unknown>[]).map(rowToProposal);
    },
    listAll(status) {
      const rows = (status ? listByStatusStmt.all(status) : listAllStmt.all()) as Record<string, unknown>[];
      return rows.map(rowToProposal);
    },
    ownerHasPendingProposal(ownerSession) {
      const row = ownerPendingStmt.get(ownerSession) as { n: number };
      return row.n > 0;
    },
    latestForTask(taskId) {
      const row = latestForTaskStmt.get(taskId) as Record<string, unknown> | undefined;
      return row ? rowToProposal(row) : undefined;
    },
    countLaterForTask(taskId) {
      const row = countLaterStmt.get(taskId) as { n: number };
      return row.n;
    },
    markReplied(id, action, raw, repliedAt) {
      markRepliedStmt.run(action, raw, repliedAt, id);
    },
    markDefaultApplied(id, defaultAction, appliedAt) {
      markDefaultStmt.run(defaultAction, appliedAt, id);
    },
    isPreviewSent(ownerSession) {
      return previewCheckStmt.get(ownerSession) !== undefined;
    },
    markPreviewSent(ownerSession, atMs) {
      previewInsertStmt.run(ownerSession, atMs);
    },
    firstSpawnedAtForTask(taskId) {
      const row = firstSpawnedAtStmt.get(taskId) as { ts: number | null };
      return row.ts ?? null;
    },
  };
}
