import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { evaluateInboxMessagePredicate } from "../../../../src/app/spawnPredicate/evaluators/inboxMessage.ts";
import { validateSpawnPredicate } from "../../../../src/app/spawnPredicate/schema.ts";
import type { PredicateDbRegistry } from "../../../../src/ports/PredicateDbRegistry.ts";

function seedDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        parent_id TEXT
      );
      CREATE TABLE message_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        final_message TEXT,
        error_message TEXT
      );
      INSERT INTO sessions (id, name, parent_id) VALUES ('sess_target', 'target-session', NULL);
      INSERT INTO sessions (id, name, parent_id) VALUES ('sess_child', 'child_target-session_a1b2c3', 'sess_target');
      INSERT INTO message_runs
        (id, session_id, group_id, prompt, started_at, status, final_message, error_message)
      VALUES
        ('mr_1', 'sess_target', 'oc_test', 'input prompt', 1700000000000, 'completed',
         'done for comm_msg_1700000000', NULL),
        ('mr_child', 'sess_child', 'oc_test', 'child prompt', 1700000000100, 'completed',
         'child done for spawn-redrive:comm_child_1700000001', NULL);
    `);
  } finally {
    db.close();
  }
}

function registryFor(dbPath: string): PredicateDbRegistry {
  return {
    resolve(dbRef) {
      if (dbRef !== "framework:supermatrix") return undefined;
      return { dbRef, kind: "sqlite", path: dbPath, readonly: true };
    },
  };
}

describe("inbox-message predicate evaluator", () => {
  test("matches session message_runs by session name, field, and since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-inbox-"));
    const dbPath = join(dir, "supermatrix.db");
    seedDb(dbPath);
    const dbRegistry = registryFor(dbPath);
    try {
      const predicate = validateSpawnPredicate({
        type: "inbox-message",
        session_name: "target-session",
        field: "final_message",
        since: { kind: "timestamp_ms", value: 1_699_999_999_999 },
        contains_all: ["comm_msg_1700000000"],
      }).predicate;
      if (predicate.type !== "inbox-message") throw new Error("expected inbox-message predicate");

      await expect(evaluateInboxMessagePredicate(predicate, { dbRegistry })).resolves.toMatchObject({
        matched: true,
        observed_count: 1,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("rejects rows older than since", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-inbox-"));
    const dbPath = join(dir, "supermatrix.db");
    seedDb(dbPath);
    const dbRegistry = registryFor(dbPath);
    try {
      const predicate = validateSpawnPredicate({
        type: "inbox-message",
        session_name: "target-session",
        field: "final_message",
        since: { kind: "timestamp_ms", value: 1_700_000_000_001 },
        contains_all: ["comm_msg_1700000000"],
      }).predicate;
      if (predicate.type !== "inbox-message") throw new Error("expected inbox-message predicate");

      await expect(evaluateInboxMessagePredicate(predicate, { dbRegistry })).resolves.toMatchObject({
        matched: false,
        observed_count: 0,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("matches child message_runs when the predicate names the parent target session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sm-predicate-inbox-"));
    const dbPath = join(dir, "supermatrix.db");
    seedDb(dbPath);
    const dbRegistry = registryFor(dbPath);
    try {
      const predicate = validateSpawnPredicate({
        type: "inbox-message",
        session_name: "target-session",
        field: "final_message",
        since: { kind: "timestamp_ms", value: 1_699_999_999_999 },
        contains_all: ["spawn-redrive:comm_child_1700000001"],
      }).predicate;
      if (predicate.type !== "inbox-message") throw new Error("expected inbox-message predicate");

      await expect(evaluateInboxMessagePredicate(predicate, { dbRegistry })).resolves.toMatchObject({
        matched: true,
        observed_count: 1,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
