import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  recoverCompletedUnstartedSpawn,
  type CompletedUnstartedSpawnRecoveryInput,
} from "../../scripts/lib/reopenCompletedUnstartedSpawn.ts";

const input: CompletedUnstartedSpawnRecoveryInput = {
  commId: "comm-old-refusal",
  fromSessionName: "hualin001",
  toSessionName: "hrhrhrhrhr",
  childSessionName: "child_hrhrhrhrhr_12f3d5",
  messageRunId: "mr-old-refusal",
  clientRequestId: "2026-07-27:hualin001:hrhrhrhrhr:previous-milestone-context",
  refusalMarker: "无法验证为",
  forbiddenStreamMarker: "weekly_report_v1.py",
};

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await rm(cleanup.pop()!, { force: true, recursive: true });
  }
});

describe("recoverCompletedUnstartedSpawn", () => {
  test("marks only a verified pre-business completed spawn as failed and frees its original key", async () => {
    const db = await seededDb();
    try {
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: false })).toMatchObject({
        outcome: "eligible",
        applied: false,
        keyRetryable: false,
        wouldMakeKeyRetryable: true,
      });
      expect(readComm(db, input.commId)).toMatchObject({ status: "completed" });

      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true })).toMatchObject({
        outcome: "recovered",
        applied: true,
        keyRetryable: true,
        clientRequestId: input.clientRequestId,
      });
      expect(readComm(db, input.commId)).toEqual({
        status: "failed",
        client_request_id: input.clientRequestId,
        final_message: "无法验证为 hualin001 的 Spawn2.0 来源",
      });
    } finally {
      db.close();
    }
  });

  test("refuses to reopen when the child stream shows the business CLI", async () => {
    const db = await seededDb({ streamLog: "tool: python3 scripts/weekly_report_v1.py previous-milestone-context" });
    try {
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true })).toMatchObject({
        outcome: "blocked",
        applied: false,
        blocker: "forbidden_stream_marker_present",
        keyRetryable: false,
      });
      expect(readComm(db, input.commId)?.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("is an idempotent no-op after it has already released the key", async () => {
    const db = await seededDb();
    try {
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true }).outcome).toBe("recovered");
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true })).toMatchObject({
        outcome: "already_recovered",
        applied: false,
        keyRetryable: true,
        wouldMakeKeyRetryable: true,
      });
      expect(readComm(db, input.commId)?.status).toBe("failed");
    } finally {
      db.close();
    }
  });

  test("refuses to free a key that is still held by another non-failed comm", async () => {
    const db = await seededDb({ anotherNonFailedWithSameKey: true });
    try {
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true })).toMatchObject({
        outcome: "blocked",
        applied: false,
        blocker: "another_nonfailed_comm_uses_client_request_id",
        keyRetryable: false,
      });
      expect(readComm(db, input.commId)?.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  test("refuses a route whose child is not parented by the target session", async () => {
    const db = await seededDb({ childParentId: "session-not-hr" });
    try {
      expect(recoverCompletedUnstartedSpawn(db, input, { apply: true })).toMatchObject({
        outcome: "blocked",
        applied: false,
        blocker: "child_parent_does_not_match_target",
      });
      expect(readComm(db, input.commId)?.status).toBe("completed");
    } finally {
      db.close();
    }
  });
});

async function seededDb(options: {
  streamLog?: string;
  anotherNonFailedWithSameKey?: boolean;
  childParentId?: string;
} = {}): Promise<Database.Database> {
  const dir = await mkdtemp(join(tmpdir(), "sm-reopen-completed-spawn-"));
  cleanup.push(dir);
  const db = new Database(join(dir, "supermatrix.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      parent_id TEXT,
      trigger_kind TEXT,
      child_type TEXT
    );
    CREATE TABLE cross_session_log (
      id TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL,
      to_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      child_session_id TEXT,
      status TEXT NOT NULL,
      final_message TEXT,
      error_message TEXT,
      message_run_id TEXT,
      client_request_id TEXT
    );
    CREATE TABLE message_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      final_message TEXT,
      error_message TEXT,
      stream_log TEXT
    );
  `);
  db.prepare("INSERT INTO sessions (id, name, scope) VALUES (?, ?, ?)").run("source", input.fromSessionName, "user");
  db.prepare("INSERT INTO sessions (id, name, scope) VALUES (?, ?, ?)").run("target", input.toSessionName, "user");
  db.prepare(
    "INSERT INTO sessions (id, name, scope, parent_id, trigger_kind, child_type) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "child",
    input.childSessionName,
    "child",
    options.childParentId ?? "target",
    "session",
    "one_shot_delegation",
  );
  db.prepare(
    "INSERT INTO message_runs (id, session_id, status, final_message, error_message, stream_log) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    input.messageRunId,
    "child",
    "completed",
    "无法验证为 hualin001 的 Spawn2.0 来源",
    null,
    options.streamLog ?? "assistant refusal before any tool call",
  );
  db.prepare(
    `INSERT INTO cross_session_log
      (id, from_session_id, to_session_id, kind, child_session_id, status, final_message, error_message, message_run_id, client_request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.commId,
    "source",
    "target",
    "spawn",
    "child",
    "completed",
    "无法验证为 hualin001 的 Spawn2.0 来源",
    null,
    input.messageRunId,
    input.clientRequestId,
  );
  if (options.anotherNonFailedWithSameKey) {
    db.prepare(
      `INSERT INTO cross_session_log
        (id, from_session_id, to_session_id, kind, status, client_request_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("comm-still-active", "source", "target", "spawn", "pending", input.clientRequestId);
  }
  return db;
}

function readComm(db: Database.Database, commId: string): {
  status: string;
  client_request_id: string;
  final_message: string | null;
} | undefined {
  return db.prepare(
    "SELECT status, client_request_id, final_message FROM cross_session_log WHERE id = ?",
  ).get(commId) as {
    status: string;
    client_request_id: string;
    final_message: string | null;
  } | undefined;
}
