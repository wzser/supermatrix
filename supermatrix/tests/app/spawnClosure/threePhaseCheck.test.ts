import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import type { SpawnChildCompletedResult } from "../../../src/app/childSession.ts";
import { runThreePhaseCheck } from "../../../src/app/spawnClosure/threePhaseCheck.ts";
import type { ResultSink } from "../../../src/domain/childCapabilities.ts";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE message_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      final_message TEXT,
      error_message TEXT,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE result_sink_attempts (
      id TEXT PRIMARY KEY,
      spawn_comm_id TEXT,
      child_session_id TEXT NOT NULL,
      message_run_id TEXT,
      sink_index INTEGER NOT NULL,
      sink_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

const httpResponseSink: ResultSink = { kind: "http_response" };
const auditOnlySink: ResultSink = { kind: "audit_only" };
const chatPostSink: ResultSink = { kind: "chat_post", chatRef: { kind: "explicit", chatId: "oc_x" }, identity: "bot" };

function mkSession(resultSinks: ResultSink[] = [httpResponseSink]): Session {
  return {
    id: asSessionId("sess_child_test"),
    name: "child_target_123456",
    scope: "child",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/child"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "deleted",
    parentId: asSessionId("sess_target"),
    depth: 1,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: "one_shot_delegation",
    triggerKind: "session",
    postIdentity: null,
    callerInvocation: "sync_inline",
    continuationHook: "none",
    capabilityPayload: { resultSinks },
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(2),
  };
}

function mkResult(finalMessage = "done", resultSinks: ResultSink[] = [httpResponseSink]): SpawnChildCompletedResult {
  return {
    session: mkSession(resultSinks),
    finalMessage,
    backendSessionId: null,
    messageRunId: asMessageRunId("mr_child_test"),
    spawnCommId: "comm_child_test_123",
  };
}

function recordDeliveredSink(db: Database.Database, sinkKind: ResultSink["kind"], sinkIndex = 0): void {
  db.prepare(
    `INSERT INTO result_sink_attempts
     (id, spawn_comm_id, child_session_id, message_run_id, sink_index, sink_kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`sink_${sinkIndex}`, "comm_child_test_123", "sess_child_test", "mr_child_test", sinkIndex, sinkKind, "delivered", 1);
}

describe("runThreePhaseCheck", () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  test("passes communication, execution, and delivery when output was delivered to the declared address", () => {
    db = mkDb();
    db.prepare(
      `INSERT INTO result_sink_attempts
       (id, spawn_comm_id, child_session_id, message_run_id, sink_index, sink_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("sink_1", "comm_child_test_123", "sess_child_test", "mr_child_test", 0, "chat_post", "delivered", 1);

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("delivered"),
      declaredResultSinks: [chatPostSink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
    expect(result.results.map((r) => [r.phase, r.passed])).toEqual([
      ["communication", true],
      ["execution", true],
      ["delivery", true],
    ]);
  });

  test("fails communication when the child never starts", () => {
    db = mkDb();

    const result = runThreePhaseCheck({
      childSpawnResult: { error: "spawn_failed" },
      declaredResultSinks: [{ kind: "http_response" }],
      db,
    });

    expect(result.allPassed).toBe(false);
    expect(result.firstFailure).toMatchObject({
      phase: "communication",
      passed: false,
      failureKind: "spawn_not_started",
    });
  });

  test("fails execution when the child run errors", () => {
    db = mkDb();

    const result = runThreePhaseCheck({
      childSpawnResult: { error: "run_error", reason: "backend failed" },
      declaredResultSinks: [{ kind: "http_response" }],
      db,
    });

    expect(result.firstFailure).toMatchObject({
      phase: "execution",
      passed: false,
      failureKind: "run_error",
    });
  });

  test("fails execution when final output is empty", () => {
    db = mkDb();

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("  \n\t"),
      declaredResultSinks: [{ kind: "http_response" }],
      db,
    });

    expect(result.firstFailure).toMatchObject({
      phase: "execution",
      passed: false,
      failureKind: "empty_output",
    });
  });

  test("passes audit-only children with empty final output", () => {
    db = mkDb();
    recordDeliveredSink(db, "audit_only");

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("  \n\t", [auditOnlySink]),
      callerInvocation: "fire_and_forget",
      declaredResultSinks: [auditOnlySink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("passes audit-only children with non-empty final output", () => {
    db = mkDb();
    recordDeliveredSink(db, "audit_only");

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("audit complete", [auditOnlySink]),
      callerInvocation: "fire_and_forget",
      declaredResultSinks: [auditOnlySink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("passes fire-and-forget chat delivery when final output is empty", () => {
    db = mkDb();
    recordDeliveredSink(db, "chat_post");

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("  \n\t", [chatPostSink]),
      callerInvocation: "fire_and_forget",
      declaredResultSinks: [chatPostSink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("passes fire-and-forget chat delivery when final output is non-empty", () => {
    db = mkDb();
    recordDeliveredSink(db, "chat_post");

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("ready to post", [chatPostSink]),
      callerInvocation: "fire_and_forget",
      declaredResultSinks: [chatPostSink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("passes multi-sink fire-and-forget delivery when final output is empty", () => {
    db = mkDb();
    recordDeliveredSink(db, "audit_only", 0);
    recordDeliveredSink(db, "chat_post", 1);

    const sinks = [auditOnlySink, chatPostSink];
    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("  \n\t", sinks),
      callerInvocation: "fire_and_forget",
      declaredResultSinks: sinks,
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("passes audit-only empty output regardless of caller invocation", () => {
    db = mkDb();
    recordDeliveredSink(db, "audit_only");

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("  \n\t", [auditOnlySink]),
      callerInvocation: "async_kickoff",
      declaredResultSinks: [auditOnlySink],
      db,
    });

    expect(result.allPassed).toBe(true);
    expect(result.firstFailure).toBeUndefined();
  });

  test("still fails fire-and-forget execution when the child run errors", () => {
    db = mkDb();

    const result = runThreePhaseCheck({
      childSpawnResult: { error: "run_error", reason: "backend failed" },
      callerInvocation: "fire_and_forget",
      declaredResultSinks: [{ kind: "http_response" }],
      db,
    });

    expect(result.firstFailure).toMatchObject({
      phase: "execution",
      passed: false,
      failureKind: "run_error",
    });
  });

  test("fails delivery when no delivered sink attempt exists for the declared address", () => {
    db = mkDb();

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("done"),
      declaredResultSinks: [chatPostSink],
      db,
    });

    expect(result.firstFailure).toMatchObject({
      phase: "delivery",
      passed: false,
      failureKind: "delivery_missing",
    });
  });

  test("fails delivery when a delivered sink attempt exists only for a different address kind", () => {
    db = mkDb();
    db.prepare(
      `INSERT INTO result_sink_attempts
       (id, spawn_comm_id, child_session_id, message_run_id, sink_index, sink_kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("sink_1", "comm_child_test_123", "sess_child_test", "mr_child_test", 0, "eventbus_publish", "delivered", 1);

    const result = runThreePhaseCheck({
      childSpawnResult: mkResult("done"),
      declaredResultSinks: [chatPostSink],
      db,
    });

    expect(result.firstFailure).toMatchObject({
      phase: "delivery",
      failureKind: "delivery_missing",
    });
  });
});
