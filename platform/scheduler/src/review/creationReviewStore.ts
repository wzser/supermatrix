import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type CreationReviewStatus =
  | "pending"
  | "dispatched"
  | "approved"
  | "patched"
  | "rejected"
  | "escalated"
  | "expired";

export type CreationReview = {
  id: string;
  taskId: string;
  trigger: "post_create" | "post_patch";
  taskSnapshot: Record<string, unknown>;
  l1Report: Record<string, unknown> | null;
  status: CreationReviewStatus;
  dispatchedAt: number | null;
  decidedAt: number | null;
  decisionReason: string | null;
  decisionPatch: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

export type CreationReviewStore = {
  create(input: {
    taskId: string;
    trigger: "post_create" | "post_patch";
    taskSnapshot: Record<string, unknown>;
    l1Report?: Record<string, unknown>;
  }): CreationReview;
  get(id: string): CreationReview | null;
  listByStatus(status: CreationReviewStatus, limit?: number): CreationReview[];
  listPending(limit?: number): CreationReview[];
  listAll(status?: CreationReviewStatus, limit?: number): CreationReview[];
  markDispatched(id: string): void;
  decide(
    id: string,
    decision: {
      status: Exclude<CreationReviewStatus, "pending" | "dispatched">;
      reason: string;
      patch?: Record<string, unknown>;
    },
  ): void;
  expirePending(olderThanMs: number, nowMs: number): number;
};

function rowToReview(row: Record<string, unknown>): CreationReview {
  const snapshotRaw = row.task_snapshot as string;
  const reportRaw = row.l1_report as string | null;
  const patchRaw = row.decision_patch as string | null;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    trigger: row.trigger as "post_create" | "post_patch",
    taskSnapshot: JSON.parse(snapshotRaw) as Record<string, unknown>,
    l1Report: reportRaw ? (JSON.parse(reportRaw) as Record<string, unknown>) : null,
    status: row.status as CreationReviewStatus,
    dispatchedAt: (row.dispatched_at as number | null) ?? null,
    decidedAt: (row.decided_at as number | null) ?? null,
    decisionReason: (row.decision_reason as string | null) ?? null,
    decisionPatch: patchRaw ? (JSON.parse(patchRaw) as Record<string, unknown>) : null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function createCreationReviewStore(db: Database.Database): CreationReviewStore {
  const insertStmt = db.prepare(`
    INSERT INTO creation_reviews (
      id, task_id, trigger, task_snapshot, l1_report,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const getStmt = db.prepare("SELECT * FROM creation_reviews WHERE id = ?");
  const listByStatusStmt = db.prepare(
    "SELECT * FROM creation_reviews WHERE status = ? ORDER BY created_at ASC",
  );
  const listByStatusLimitStmt = db.prepare(
    "SELECT * FROM creation_reviews WHERE status = ? ORDER BY created_at ASC LIMIT ?",
  );
  const listAllStmt = db.prepare(
    "SELECT * FROM creation_reviews ORDER BY created_at ASC",
  );
  const listAllLimitStmt = db.prepare(
    "SELECT * FROM creation_reviews ORDER BY created_at ASC LIMIT ?",
  );
  const markDispatchedStmt = db.prepare(`
    UPDATE creation_reviews
    SET status = 'dispatched', dispatched_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const decideStmt = db.prepare(`
    UPDATE creation_reviews
    SET status = ?, decision_reason = ?, decision_patch = ?, decided_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const expireStmt = db.prepare(`
    UPDATE creation_reviews
    SET status = 'expired', updated_at = ?
    WHERE status = 'pending' AND created_at < ?
  `);

  return {
    create(input) {
      const id = randomUUID();
      const now = Date.now();
      const snapshotJson = JSON.stringify(input.taskSnapshot);
      const reportJson = input.l1Report ? JSON.stringify(input.l1Report) : null;
      insertStmt.run(id, input.taskId, input.trigger, snapshotJson, reportJson, now, now);
      return {
        id,
        taskId: input.taskId,
        trigger: input.trigger,
        taskSnapshot: input.taskSnapshot,
        l1Report: input.l1Report ?? null,
        status: "pending",
        dispatchedAt: null,
        decidedAt: null,
        decisionReason: null,
        decisionPatch: null,
        createdAt: now,
        updatedAt: now,
      };
    },
    get(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToReview(row) : null;
    },
    listByStatus(status, limit) {
      const rows =
        limit === undefined
          ? (listByStatusStmt.all(status) as Record<string, unknown>[])
          : (listByStatusLimitStmt.all(status, limit) as Record<string, unknown>[]);
      return rows.map(rowToReview);
    },
    listPending(limit) {
      return this.listByStatus("pending", limit);
    },
    listAll(status, limit) {
      if (status !== undefined) {
        return this.listByStatus(status, limit);
      }
      const rows =
        limit === undefined
          ? (listAllStmt.all() as Record<string, unknown>[])
          : (listAllLimitStmt.all(limit) as Record<string, unknown>[]);
      return rows.map(rowToReview);
    },
    markDispatched(id) {
      const now = Date.now();
      markDispatchedStmt.run(now, now, id);
    },
    decide(id, decision) {
      const now = Date.now();
      const patchJson = decision.patch ? JSON.stringify(decision.patch) : null;
      decideStmt.run(decision.status, decision.reason, patchJson, now, now, id);
    },
    expirePending(olderThanMs, nowMs) {
      const threshold = nowMs - olderThanMs;
      const result = expireStmt.run(nowMs, threshold);
      return result.changes;
    },
  };
}
