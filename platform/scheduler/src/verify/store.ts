import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { PendingVerification } from "./types.js";

export type VerifyStore = {
  scheduleVerification(runId: string, dueAt: number): PendingVerification;
  getVerification(id: string): PendingVerification | undefined;
  pollDue(now: number): PendingVerification[];
  rescheduleVerification(id: string, newDueAt: number): void;
  finalizeVerification(id: string): void;
};

function rowToVerification(row: Record<string, unknown>): PendingVerification {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    dueAt: row.due_at as number,
    attempts: row.attempts as number,
    status: row.status as PendingVerification["status"],
    createdAt: row.created_at as number,
  };
}

export function createVerifyStore(db: Database.Database): VerifyStore {
  const insertStmt = db.prepare(`
    INSERT INTO task_verifications (id, run_id, due_at, attempts, status, created_at)
    VALUES (?, ?, ?, 0, 'pending', ?)
  `);
  const getStmt = db.prepare("SELECT * FROM task_verifications WHERE id = ?");
  const pollStmt = db.prepare(`
    SELECT * FROM task_verifications
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC
  `);
  const rescheduleStmt = db.prepare(`
    UPDATE task_verifications
    SET due_at = ?, attempts = attempts + 1
    WHERE id = ?
  `);
  const finalizeStmt = db.prepare("UPDATE task_verifications SET status = 'done' WHERE id = ?");

  return {
    scheduleVerification(runId, dueAt) {
      const id = randomUUID();
      const now = Date.now();
      insertStmt.run(id, runId, dueAt, now);
      return { id, runId, dueAt, attempts: 0, status: "pending", createdAt: now };
    },

    getVerification(id) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToVerification(row) : undefined;
    },

    pollDue(now) {
      return (pollStmt.all(now) as Record<string, unknown>[]).map(rowToVerification);
    },

    rescheduleVerification(id, newDueAt) {
      rescheduleStmt.run(newDueAt, id);
    },

    finalizeVerification(id) {
      finalizeStmt.run(id);
    },
  };
}
