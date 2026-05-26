import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type Issue = {
  id: string;
  title: string;
  source: string;
  description: string;
  verification: string | null;
  status: "open" | "in_progress" | "done" | "failed" | "pending";
  createdAt: number;
  finishedAt: number | null;
  result: string | null;
  retryCount: number;
};

export type NewIssueInput = {
  title: string;
  source: string;
  description: string;
  verification: string | null;
};

export type IssueStore = {
  createIssue(input: NewIssueInput): Issue;
  getIssue(id: string): Issue;
  nextOpen(): Issue | null;
  listByStatus(status: Issue["status"]): Issue[];
  listAll(): Issue[];
  listRecent(days: number): Issue[];
  updateStatus(id: string, status: Issue["status"]): Issue;
  setVerification(id: string, verification: string): Issue;
  markDone(id: string, result: string): Issue;
  markFailed(id: string, result: string): Issue;
  incrementRetry(id: string): Issue;
};

function rowToIssue(row: Record<string, unknown>): Issue {
  return {
    id: row.id as string,
    title: row.title as string,
    source: row.source as string,
    description: row.description as string,
    verification: (row.verification as string) ?? null,
    status: row.status as Issue["status"],
    createdAt: row.created_at as number,
    finishedAt: (row.finished_at as number) ?? null,
    result: (row.result as string) ?? null,
    retryCount: (row.retry_count as number) ?? 0,
  };
}

export function createIssueStore(db: Database.Database): IssueStore {
  const insertIssue = db.prepare(`
    INSERT INTO issues (id, title, source, description, verification, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?)
  `);

  const selectById = db.prepare("SELECT * FROM issues WHERE id = ?");

  const selectByStatus = db.prepare(
    "SELECT * FROM issues WHERE status = ? ORDER BY created_at ASC"
  );

  const selectNextOpen = db.prepare(
    "SELECT * FROM issues WHERE status = 'open' ORDER BY created_at ASC LIMIT 1"
  );

  const selectAll = db.prepare("SELECT * FROM issues ORDER BY created_at ASC");

  const selectRecent = db.prepare(
    "SELECT * FROM issues WHERE created_at >= ? ORDER BY created_at DESC"
  );

  const updateStatusStmt = db.prepare(
    "UPDATE issues SET status = ? WHERE id = ?"
  );

  const updateVerificationStmt = db.prepare(
    "UPDATE issues SET verification = ? WHERE id = ?"
  );

  const finishIssue = db.prepare(
    "UPDATE issues SET status = ?, finished_at = ?, result = ? WHERE id = ?"
  );

  const incrementRetryStmt = db.prepare(
    "UPDATE issues SET retry_count = retry_count + 1 WHERE id = ?"
  );

  function getOrThrow(id: string): Issue {
    const row = selectById.get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Issue not found: ${id}`);
    return rowToIssue(row);
  }

  return {
    createIssue(input) {
      const id = randomUUID();
      const now = Date.now();
      insertIssue.run(id, input.title, input.source, input.description, input.verification, now);
      return getOrThrow(id);
    },

    getIssue(id) {
      return getOrThrow(id);
    },

    nextOpen() {
      const row = selectNextOpen.get() as Record<string, unknown> | undefined;
      return row ? rowToIssue(row) : null;
    },

    listByStatus(status) {
      return (selectByStatus.all(status) as Record<string, unknown>[]).map(rowToIssue);
    },

    listAll() {
      return (selectAll.all() as Record<string, unknown>[]).map(rowToIssue);
    },

    listRecent(days) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      return (selectRecent.all(cutoff) as Record<string, unknown>[]).map(rowToIssue);
    },

    updateStatus(id, status) {
      getOrThrow(id);
      updateStatusStmt.run(status, id);
      return getOrThrow(id);
    },

    setVerification(id, verification) {
      getOrThrow(id);
      updateVerificationStmt.run(verification, id);
      return getOrThrow(id);
    },

    markDone(id, result) {
      getOrThrow(id);
      finishIssue.run("done", Date.now(), result, id);
      return getOrThrow(id);
    },

    markFailed(id, result) {
      getOrThrow(id);
      finishIssue.run("failed", Date.now(), result, id);
      return getOrThrow(id);
    },

    incrementRetry(id) {
      getOrThrow(id);
      incrementRetryStmt.run(id);
      return getOrThrow(id);
    },
  };
}
