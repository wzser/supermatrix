import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import {
  classifyAndRoute,
  classifyAsyncItem,
  type RedeliverExecutor,
  type SpawnAsyncItem,
} from "../../scripts/lib/spawnClosureClassify.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("spawnClosureClassify", () => {
  test("D1 closes a spawn late_result with completed output without caller injection", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      childSessionId: "sess_child",
      finalMessage: "late done",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "late result stored in cross_session_log; no caller injection",
    });
  });

  test("D2 routes spawn_not_started to re-drive the target session", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });

    expect(classifyAsyncItem(item, db)).toMatchObject({
      route: "redrive",
      logicalKey: item.comm_id,
      targetSession: "target",
    });
  });

  test("D3 routes run_error and run_timeout for re-drive while attempts remain", async () => {
    const { db } = await makeDb();
    const runError = seedAsyncItem(db, { failureKind: "run_error", attemptCount: 1 });
    const timeout = seedAsyncItem(db, { failureKind: "run_timeout", attemptCount: 1 });

    expect(classifyAsyncItem(runError, db)).toMatchObject({
      route: "redrive",
      logicalKey: runError.comm_id,
      targetSession: "target",
    });
    expect(classifyAsyncItem(timeout, db)).toMatchObject({
      route: "redrive",
      logicalKey: timeout.comm_id,
      targetSession: "target",
    });
  });

  test("D4 routes delivery_missing to re-deliver when execution output exists", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "delivery_missing",
      childSessionId: "sess_child",
      finalMessage: "ready to redeliver",
    });

    expect(classifyAsyncItem(item, db)).toMatchObject({
      route: "redeliver",
      logicalKey: item.comm_id,
    });
  });

  test("waiting_child spawn with completed output closes without caller injection", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "full child output",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "late result stored in cross_session_log; no caller injection",
    });
  });

  test("failed continuation from busy parent is treated as deliverable full result", async () => {
    const { db } = await makeDb();
    const item = seedContinuationAsyncItem(db, {
      finalMessage: "child result for busy parent",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "deliver",
      logicalKey: item.comm_id,
      targetSession: "caller",
      finalMessage: "child result for busy parent",
      note: "child completed after caller stopped waiting; deliver full result to caller",
    });
  });

  test("waiting_child with still-running child does not re-drive", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "run_timeout",
      status: "waiting_child",
      childSessionId: "sess_child",
      runStatus: "running",
      finalMessage: null,
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "child still running; waiting for completion",
    });
  });

  test("waiting_child with failed child re-drives the original spawn", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "run_timeout",
      status: "waiting_child",
      childSessionId: "sess_child",
      runStatus: "failed",
      finalMessage: null,
    });

    expect(classifyAsyncItem(item, db)).toMatchObject({
      route: "redrive",
      logicalKey: item.comm_id,
      targetSession: "target",
    });
  });

  test("parks orphaned async items when the caller session is deleted", async () => {
    const { db } = await makeDb();
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE name = 'caller'").run();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "caller session is missing or deleted; parking orphaned async item",
    });
    const row = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "parked",
      verdict: "orphaned_session",
      verdict_reason: "caller session caller is missing or deleted; redrive suppressed",
    });
  });

  test("routes exhausted attempts to adjudication", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "run_error", attemptCount: 2 });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "adjudicate",
      reason: "attempt budget exhausted for run_error",
    });
  });

  test("routes repeated empty_output to adjudication after attempt budget is exhausted", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "empty_output", attemptCount: 2 });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "adjudicate",
      reason: "attempt budget exhausted for empty_output",
    });
  });

  test("closes exhausted failures when the same client_request_id completed in another comm", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const item = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 2,
      clientRequestId: "biz-request-123",
    });
    const successfulCommId = seedCompletedBusinessComm(db, "biz-request-123");

    expect(classifyAsyncItem(item, db)).toMatchObject({
      route: "noop",
      reason: "business request already satisfied by another completed comm",
      successfulCommId,
    });
    const row = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      verdict: "business_satisfied_elsewhere",
      verdict_reason: `same client_request_id completed by ${successfulCommId}`,
    });
  });

  test("routes structurally missing comm rows to adjudication", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "run_error" });
    const missingComm = { ...item, comm_id: "comm_missing" };

    expect(classifyAsyncItem(missingComm, db)).toEqual({
      route: "adjudicate",
      reason: "cross_session_log row is missing",
    });
  });

  test("routes stale async items to adjudication", async () => {
    const previous = process.env.SPAWN_CLOSURE_STALE_MS;
    process.env.SPAWN_CLOSURE_STALE_MS = "1";
    try {
      const { db } = await makeDb();
      const item = seedAsyncItem(db, { failureKind: "run_error" });

      expect(classifyAsyncItem(item, db)).toEqual({
        route: "adjudicate",
        reason: "spawn_async_items row is stale",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.SPAWN_CLOSURE_STALE_MS;
      } else {
        process.env.SPAWN_CLOSURE_STALE_MS = previous;
      }
    }
  });

  test("closes non-late-result items once rerun checks are all passed", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "run_error",
      childSessionId: "sess_child",
      finalMessage: "now done",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "spawn closure already verified",
    });
    const row = db
      .prepare("SELECT status FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string };
    expect(row.status).toBe("closed");
  });

  test("adjudication spawn uses the internal async flag instead of public mode", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "run_error", attemptCount: 2 });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);

    await classifyAndRoute({
      item,
      db,
      apiBase: "http://sm.test",
      sourceSession: "supermatrix-root",
      sopPath: "/tmp/sop.md",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      mode?: string;
      supermatrix_internal?: { caller_invocation?: string };
    };
    expect(body.mode).toBeUndefined();
    expect(body.supermatrix_internal).toEqual({ caller_invocation: "async_kickoff" });
  });

  test("redrive route posts the original spawn instead of enqueueing a command todo", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);

    await classifyAndRoute({
      item,
      db,
      apiBase: "http://sm.test",
      sourceSession: "supermatrix-root",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      target: string;
      from: string;
      prompt: string;
      client_request_id: string;
      verification_predicate?: {
        type: string;
        session_name: string;
        field: string;
        contains_all?: string[];
        expected_window_sec?: number;
      };
      supermatrix_internal?: { caller_invocation?: string };
    };
    expect(body).toMatchObject({
      target: "target",
      from: "caller",
      client_request_id: `spawn-redrive:${item.comm_id}`,
      verification_predicate: {
        type: "inbox-message",
        session_name: "target",
        field: "final_message",
        contains_all: [`spawn-redrive:${item.comm_id}`],
        expected_window_sec: 3600,
      },
    });
    expect(body.prompt).toContain("test prompt");
    expect(body.prompt).toContain(`spawn-redrive:${item.comm_id}`);
    expect(body.supermatrix_internal).toBeUndefined();
    const row = db
      .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number };
    expect(row).toEqual({ status: "re_driving", attempt_count: 1 });
  });

  test("redrive aborts a hanging spawn request before it can hold the watcher tick", async () => {
    vi.useFakeTimers();
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });
    let capturedSignal: AbortSignal | undefined;
    let resolved: unknown;
    let rejected: unknown;
    const fetchSpy = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener(
          "abort",
          () => {
            const error = new Error("redrive request aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const routePromise = classifyAndRoute({
      item,
      db,
      apiBase: "http://sm.test",
      sourceSession: "supermatrix-root",
    });
    routePromise.then(
      (result) => {
        resolved = result;
      },
      (err) => {
        rejected = err;
      },
    );

    await vi.advanceTimersByTimeAsync(45_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedSignal?.aborted).toBe(true);
    expect(rejected).toBeUndefined();
    expect(resolved).toMatchObject({ action: "redrive" });
    const row = db
      .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number };
    expect(row).toEqual({ status: "re_driving", attempt_count: 1 });
  });

  test("sync spawn late_result closes without enqueueing a heartbeat todo", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-deliver-"));
    const callsPath = join(dir, "calls.txt");
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
printf '{"ok":true,"status":"inserted"}\\n'
`,
      { mode: 0o755 },
    );
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "line 1\nline 2 full result",
    });

    await classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    });

    await expect(readFile(callsPath, "utf8")).rejects.toThrow();
    const row = db
      .prepare("SELECT status, attempt_count, verdict FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number; verdict: string | null };
    expect(row).toEqual({ status: "closed", attempt_count: 0, verdict: "late_result_stored" });
  });

  test("delivery_missing invokes redelivery and closes the item on success", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "delivery_missing",
      childSessionId: "sess_child",
      finalMessage: "ready to redeliver",
    });
    const redeliver = vi.fn<RedeliverExecutor>(async () => ({ ok: true, note: "delivered" }));

    await classifyAndRoute({ item, db, redeliver });

    expect(redeliver).toHaveBeenCalledOnce();
    expect(redeliver.mock.calls[0]?.[0].snapshot).toMatchObject({
      finalMessage: "ready to redeliver",
      childSessionId: "sess_child",
    });
    const row = db
      .prepare("SELECT status FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string };
    expect(row.status).toBe("closed");
  });

  test("re_driving item within the grace window is left in flight", async () => {
    const { db } = await makeDb();
    const seeded = seedAsyncItem(db, {
      failureKind: "delivery_missing",
      childSessionId: "sess_child",
      finalMessage: "output exists",
    });
    const inFlight: SpawnAsyncItem = {
      ...seeded,
      status: "re_driving",
      attempt_count: 1,
      last_attempt_at: Date.now() - 60_000,
    };

    expect(classifyAsyncItem(inFlight, db)).toEqual({
      route: "noop",
      reason: "re-drive in flight; waiting for spawned retry closure",
    });
  });

  test("re_driving item past the grace window is re-evaluated", async () => {
    const previous = process.env.SPAWN_CLOSURE_REDRIVE_GRACE_MS;
    process.env.SPAWN_CLOSURE_REDRIVE_GRACE_MS = "1";
    try {
      const { db } = await makeDb();
      const seeded = seedAsyncItem(db, {
        failureKind: "delivery_missing",
        childSessionId: "sess_child",
        finalMessage: "output exists",
      });
      const pastGrace: SpawnAsyncItem = {
        ...seeded,
        status: "re_driving",
        attempt_count: 1,
        last_attempt_at: Date.now() - 10_000,
      };

      expect(classifyAsyncItem(pastGrace, db)).toMatchObject({
        route: "redeliver",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.SPAWN_CLOSURE_REDRIVE_GRACE_MS;
      } else {
        process.env.SPAWN_CLOSURE_REDRIVE_GRACE_MS = previous;
      }
    }
  });
});

async function makeDb(): Promise<{ db: Database.Database }> {
  const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-classify-"));
  const dbPath = join(dir, "supermatrix.db");
  const store = new SqliteBindingStore(dbPath);
  await store.init();
  await store.close();
  const db = new Database(dbPath);
  const now = Date.now();
  insertSession(db, "sess_caller", "caller", now);
  insertSession(db, "sess_target", "target", now);
  insertSession(db, "sess_child", "target-child", now, "child");
  db.prepare("UPDATE sessions SET child_type = 'one_shot_delegation' WHERE id = 'sess_child'").run();
  return { db };
}

function insertSession(
  db: Database.Database,
  id: string,
  name: string,
  now: number,
  scope: "user" | "child" = "user",
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, name, scope, backend, workdir, purpose, status, parent_id, depth, created_at, updated_at)
     VALUES (?, ?, ?, 'codex', ?, '', 'idle', NULL, 0, ?, ?)`
  ).run(id, name, scope, "/tmp/sm-spawn-closure-classify", now, now);
}

function seedAsyncItem(
  db: Database.Database,
  input: {
    failureKind: SpawnAsyncItem["failure_kind"];
    status?: SpawnAsyncItem["status"];
    attemptCount?: number;
    childSessionId?: string | null;
    runStatus?: "running" | "completed" | "failed" | "cancelled" | "timeout";
    finalMessage?: string | null;
    clientRequestId?: string | null;
  },
): SpawnAsyncItem {
  ensureClientRequestIdColumn(db);
  const now = Date.now();
  const commId = `comm_${Math.random().toString(36).slice(2, 12)}`;
  const runId = input.childSessionId ? `mr_${Math.random().toString(36).slice(2, 12)}` : null;
  if (runId && input.childSessionId) {
    db.prepare(
      `INSERT INTO message_runs
         (id, session_id, group_id, prompt, started_at, finished_at, status, final_message, error_message)
       VALUES (?, ?, 'oc_test', 'test prompt', ?, ?, ?, ?, NULL)`
    ).run(runId, input.childSessionId, now - 100, now, input.runStatus ?? "completed", input.finalMessage ?? null);
  }
  db.prepare(
    `INSERT INTO cross_session_log
       (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
        result_preview, final_message, message_run_id, client_request_id, created_at, finished_at)
     VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'test prompt', ?, 'completed',
             ?, ?, ?, ?, ?, ?)`
  ).run(
    commId,
    input.childSessionId ?? null,
    input.finalMessage ?? null,
    input.finalMessage ?? null,
    runId,
    input.clientRequestId ?? null,
    now - 1_000,
    now,
  );
  const item: SpawnAsyncItem = {
    ref: `async_${commId}`,
    comm_id: commId,
    caller_session: "caller",
    target_session: "target",
    failed_phase: input.failureKind === "spawn_not_started" ? "communication" : "execution",
    failure_kind: input.failureKind,
    attempt_count: input.attemptCount ?? 0,
    status: input.status ?? "pending",
    verdict: null,
    verdict_reason: null,
    created_at: now - 1_000,
    updated_at: now - 1_000,
    last_attempt_at: null,
  };
  db.prepare(
    `INSERT INTO spawn_async_items
       (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
        attempt_count, status, created_at, updated_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    item.ref,
    item.comm_id,
    item.caller_session,
    item.target_session,
    item.failed_phase,
    item.failure_kind,
    item.attempt_count,
    item.status,
    item.created_at,
    item.updated_at,
  );
  return item;
}

function seedCompletedBusinessComm(db: Database.Database, clientRequestId: string): string {
  const now = Date.now();
  const commId = `comm_success_${Math.random().toString(36).slice(2, 12)}`;
  db.prepare(
    `INSERT INTO cross_session_log
       (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
        result_preview, final_message, message_run_id, client_request_id, created_at, finished_at)
     VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'successful retry', 'sess_child', 'completed',
             'business done', 'business done', NULL, ?, ?, ?)`
  ).run(commId, clientRequestId, now - 100, now);
  return commId;
}

function ensureClientRequestIdColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(cross_session_log)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "client_request_id")) {
    db.exec("ALTER TABLE cross_session_log ADD COLUMN client_request_id TEXT");
  }
}

function seedContinuationAsyncItem(
  db: Database.Database,
  input: {
    finalMessage: string;
  },
): SpawnAsyncItem {
  const now = Date.now();
  const commId = `comm_cont_${Math.random().toString(36).slice(2, 12)}`;
  db.prepare(
    `INSERT INTO cross_session_log
       (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
        result_preview, final_message, message_run_id, error_message, created_at, finished_at)
     VALUES (?, 'sess_child', 'sess_caller', 'continuation', 'continuation envelope', 'sess_child', 'failed',
             ?, ?, NULL, 'parent busy; continuation deferred to watcher delivery', ?, ?)`
  ).run(commId, input.finalMessage, input.finalMessage, now - 1_000, now);
  const item: SpawnAsyncItem = {
    ref: `async_${commId}`,
    comm_id: commId,
    caller_session: "caller",
    target_session: "caller",
    failed_phase: "delivery",
    failure_kind: "late_result",
    attempt_count: 0,
    status: "waiting_child",
    verdict: null,
    verdict_reason: null,
    created_at: now - 1_000,
    updated_at: now - 1_000,
    last_attempt_at: null,
  };
  db.prepare(
    `INSERT INTO spawn_async_items
       (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
        attempt_count, status, created_at, updated_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(
    item.ref,
    item.comm_id,
    item.caller_session,
    item.target_session,
    item.failed_phase,
    item.failure_kind,
    item.attempt_count,
    item.status,
    item.created_at,
    item.updated_at,
  );
  return item;
}
