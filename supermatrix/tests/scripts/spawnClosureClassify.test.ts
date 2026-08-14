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
  delete process.env.SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE;
  delete process.env.SPAWN_CLOSURE_DELIVERY_BACKOFF_MS;
  delete process.env.SPAWN_CLOSURE_DELIVERY_MAX_ATTEMPTS;
});

describe("spawnClosureClassify", () => {
  test("D1 routes a late_result with completed output back to the caller", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      childSessionId: "sess_child",
      finalMessage: "late done",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "deliver",
      logicalKey: item.comm_id,
      targetSession: "caller",
      finalMessage: "late done",
      note: "late result is now present; deliver it to caller",
    });
  });

  test("D2 classifies spawn_not_started as a caller failure notice when automatic re-drive is disabled", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "failure_notice",
      logicalKey: `${item.comm_id}:failure-notice`,
      targetSession: "caller",
      note: "child session did not start; re-drive target session",
    });
    expectPendingFailureNoticeRetry(db, item.ref);
  });

  test("D2 can still route spawn_not_started to re-drive when explicitly enabled", async () => {
    process.env.SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE = "1";
    const { db } = await makeDb();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });

    expect(classifyAsyncItem(item, db)).toMatchObject({
      route: "redrive",
      logicalKey: item.comm_id,
      targetSession: "target",
    });
  });

  test("D3 classifies run_error and run_timeout as caller failure notices while attempts remain", async () => {
    const { db } = await makeDb();
    const runError = seedAsyncItem(db, { failureKind: "run_error", attemptCount: 1 });
    const timeout = seedAsyncItem(db, { failureKind: "run_timeout", attemptCount: 1 });

    expect(classifyAsyncItem(runError, db)).toEqual({
      route: "failure_notice",
      logicalKey: `${runError.comm_id}:failure-notice`,
      targetSession: "caller",
      note: "run_error; re-drive target session",
    });
    expectPendingFailureNoticeRetry(db, runError.ref, { attemptCount: 1 });

    expect(classifyAsyncItem(timeout, db)).toEqual({
      route: "failure_notice",
      logicalKey: `${timeout.comm_id}:failure-notice`,
      targetSession: "caller",
      note: "run_timeout; re-drive target session",
    });
    expectPendingFailureNoticeRetry(db, timeout.ref, { attemptCount: 1 });
  });

  test("persists the caller failure notice before parking an automatic re-drive suppression", async () => {
    const { db } = await makeDb();
    const { callsPath, heartbeatPath } = await makeHeartbeatEnqueueStub("inserted");
    const item = seedAsyncItem(db, {
      failureKind: "run_timeout",
      clientRequestId: "2026-08-05:caller:target:retry-me",
    });

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({
      action: "failure_notice",
      decision: {
        route: "failure_notice",
        logicalKey: `${item.client_request_id}:failure-notice`,
        targetSession: "caller",
      },
    });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("--session caller");
    expect(calls).toContain(`--key ${item.client_request_id}:failure-notice`);
    expect(calls).toContain(`--source-ref ${item.comm_id}`);
    expect(calls).toContain("--todo-type status_reconcile");
    expect(calls).toContain("--batch-mode single");
    expect(calls).toContain(`comm_id: ${item.comm_id}`);
    expect(calls).toContain(`async_ref: ${item.ref}`);
    expect(calls).toContain("caller: caller");
    expect(calls).toContain("target: target");
    expect(calls).toContain("失败原因:");
    expect(calls).toContain("auto_redrive_suppressed");
    expect(calls).toContain("执行状态未知，先核业务副作用，再由 caller 显式决定是否用原 client_request_id 重试");
    expectParkedAutoRedriveSuppressed(db, item.ref, "run_timeout; re-drive target session");
  });

  test("treats a duplicate caller failure notice as persisted before parking", async () => {
    const { db } = await makeDb();
    const { callsPath, heartbeatPath } = await makeHeartbeatEnqueueStub("duplicate");
    const item = seedAsyncItem(db, { failureKind: "empty_output" });

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({ action: "failure_notice" });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain(`--key ${item.comm_id}:failure-notice`);
    expectParkedAutoRedriveSuppressed(db, item.ref, "empty_output; re-drive target session");
  });

  test("keeps an automatic re-drive suppression retryable when heartbeat returns an unrecognized success status", async () => {
    const { db } = await makeDb();
    const { heartbeatPath } = await makeHeartbeatEnqueueStub("enqueued");
    const item = seedAsyncItem(db, { failureKind: "run_error" });

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({ action: "failure_notice" });

    const row = db
      .prepare("SELECT status, attempt_count, verdict, verdict_reason, last_attempt_at FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as {
        status: string;
        attempt_count: number;
        verdict: string | null;
        verdict_reason: string | null;
        last_attempt_at: number | null;
      };
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 1,
      verdict: "failure_notice_pending",
    });
    expect(row.verdict_reason).toContain("status enqueued");
    expect(row.last_attempt_at).toEqual(expect.any(Number));

    const retryItem: SpawnAsyncItem = {
      ...item,
      status: row.status as SpawnAsyncItem["status"],
      attempt_count: row.attempt_count,
      verdict: row.verdict,
      verdict_reason: row.verdict_reason,
      last_attempt_at: row.last_attempt_at,
    };
    expect(classifyAsyncItem(retryItem, db)).toEqual({
      route: "noop",
      reason: "failure notice delivery retry backoff active",
    });

    const retryDueAt = Date.now() - 11 * 60 * 1000;
    db.prepare("UPDATE spawn_async_items SET last_attempt_at = ? WHERE ref = ?").run(retryDueAt, item.ref);
    expect(classifyAsyncItem({ ...retryItem, last_attempt_at: retryDueAt }, db)).toMatchObject({
      route: "failure_notice",
      logicalKey: `${item.comm_id}:failure-notice`,
    });
  });

  test("falls back to a caller-targeted watcher exception when failure notice delivery becomes unreachable", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-failure-fallback-"));
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"ok":false,"error":"heartbeat disabled"}\\n'
`,
      { mode: 0o755 },
    );
    db.prepare("INSERT INTO bindings (group_id, session_id, created_at) VALUES ('oc_caller', 'sess_caller', ?)").run(Date.now());
    const seeded = seedAsyncItem(db, { failureKind: "run_error", attemptCount: 3 });
    db.prepare("UPDATE spawn_async_items SET verdict = 'failure_notice_pending' WHERE ref = ?").run(seeded.ref);
    const item = { ...seeded, verdict: "failure_notice_pending" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      apiBase: "http://fallback.test/",
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({ action: "failure_notice" });

    const row = db
      .prepare("SELECT status, attempt_count, verdict FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number; verdict: string | null };
    expect(row).toEqual({ status: "parked", attempt_count: 4, verdict: "delivery_unreachable" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://fallback.test/api/watcher-exception-notify");
    expect(init.method).toBe("POST");
    const fallback = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(fallback).toMatchObject({
      kind: "spawn_exception_transaction_fallback",
      spawn_comm_id: item.comm_id,
      trigger_signal: "failure_notice_delivery_unreachable",
      target_chat_id: "oc_caller",
      dedupe_key: `${item.comm_id}:failure-notice-delivery-unreachable`,
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

  test("waiting_child with completed output delivers the full result to caller", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "full child output",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "deliver",
      logicalKey: item.comm_id,
      targetSession: "caller",
      finalMessage: "full child output",
      note: "child completed after caller stopped waiting; deliver full result to caller",
    });
  });

  test("waiting_child run_timeout with completed output delivers instead of closing as verified", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "run_timeout",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "timeout child eventually completed",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "deliver",
      logicalKey: item.comm_id,
      targetSession: "caller",
      finalMessage: "timeout child eventually completed",
      note: "child completed after caller stopped waiting; deliver full result to caller",
    });
    const row = db
      .prepare("SELECT status FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string };
    expect(row.status).toBe("waiting_child");
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

  test("waiting_child with failed child classifies as a caller failure notice instead of automatically re-driving", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "run_timeout",
      status: "waiting_child",
      childSessionId: "sess_child",
      runStatus: "failed",
      finalMessage: null,
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "failure_notice",
      logicalKey: `${item.comm_id}:failure-notice`,
      targetSession: "caller",
      note: "waiting child finished without usable output; re-drive original spawn",
    });
    expectPendingFailureNoticeRetry(db, item.ref, { status: "waiting_child" });
  });

  test("parks orphaned async items when the caller session is deleted", async () => {
    const { db } = await makeDb();
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE name = 'caller'").run();
    const item = seedAsyncItem(db, { failureKind: "spawn_not_started" });
    const { callsPath, heartbeatPath } = await makeHeartbeatEnqueueStub("inserted");

    await expect(classifyAndRoute({ item, db, heartbeatEnqueuePath: heartbeatPath })).resolves.toEqual({
      decision: {
        route: "noop",
        reason: "caller session is missing or deleted; parking orphaned async item",
      },
      action: "noop",
    });
    await expect(readFile(callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

  test("suppresses heartbeat delivery for completed adjudication spawn results with a valid original outcome", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const original = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 2,
      status: "adjudicating",
    });
    db.prepare("UPDATE spawn_async_items SET status = 'closed', verdict = 'false_alarm', verdict_reason = 'already handled' WHERE ref = ?")
      .run(original.ref);
    const clientRequestId = `2026-06-01:spawn-adjudication:${original.comm_id}:${original.ref}`;
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "adjudication done",
      clientRequestId,
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "adjudication result recorded; heartbeat delivery suppressed",
    });
    const row = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      verdict: "adjudication_result_recorded",
      verdict_reason: `adjudication spawn ${clientRequestId} completed; heartbeat delivery suppressed`,
    });
  });

  test("escalates the original async item when adjudication completes without a valid outcome", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const original = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 2,
      status: "adjudicating",
    });
    const clientRequestId = `2026-06-01:spawn-adjudication:${original.comm_id}:${original.ref}`;
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "adjudication done",
      clientRequestId,
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "adjudication completed without valid state transition; original escalated",
    });
    const originalRow = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(original.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(originalRow).toEqual({
      status: "closed",
      verdict: "escalated",
      verdict_reason: `adjudication spawn ${clientRequestId} completed without a valid status/verdict transition`,
    });
    const childRow = db
      .prepare("SELECT status, verdict FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null };
    expect(childRow).toEqual({
      status: "closed",
      verdict: "adjudication_result_recorded",
    });
  });

  test("keeps the delivered verdict on an original that reached terminal success during adjudication", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const original = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 2,
      status: "adjudicating",
    });
    db.prepare("UPDATE spawn_async_items SET status = 'closed', verdict = 'delivered', verdict_reason = 'fast-path heartbeat todo enqueued for caller' WHERE ref = ?")
      .run(original.ref);
    const clientRequestId = `2026-06-01:spawn-adjudication:${original.comm_id}:${original.ref}`;
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "adjudication done",
      clientRequestId,
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "adjudication result recorded; heartbeat delivery suppressed",
    });
    const originalRow = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(original.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(originalRow).toEqual({
      status: "closed",
      verdict: "delivered",
      verdict_reason: "fast-path heartbeat todo enqueued for caller",
    });
  });

  test("closes adjudicating items immediately when the same client_request_id completed elsewhere", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const item = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 2,
      status: "adjudicating",
      clientRequestId: "biz-request-adjudicating-123",
    });
    const successfulCommId = seedCompletedBusinessComm(db, "biz-request-adjudicating-123");

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

  test("closes re-driving items immediately when the same client_request_id completed elsewhere", async () => {
    const { db } = await makeDb();
    ensureClientRequestIdColumn(db);
    const item = seedAsyncItem(db, {
      failureKind: "run_error",
      attemptCount: 1,
      status: "re_driving",
      clientRequestId: "biz-request-redriving-123",
    });
    const successfulCommId = seedCompletedBusinessComm(db, "biz-request-redriving-123");

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
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      verdict: "delivered",
      verdict_reason: "spawn closure already verified",
    });
  });

  test("closes a stuck delivering item as delivered", async () => {
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "delivering",
      childSessionId: "sess_child",
      finalMessage: "todo already enqueued",
    });

    expect(classifyAsyncItem(item, db)).toEqual({
      route: "noop",
      reason: "delivery todo already enqueued; closing async item",
    });
    const row = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      verdict: "delivered",
      verdict_reason: "delivery todo already enqueued; closing async item",
    });
  });

  test("adjudication spawn uses spawn2.0 todo-pool closure instead of internal async flags", async () => {
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
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://sm.test/api/spawn2.0");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      client_request_id?: string;
      mode?: string;
      supermatrix_internal?: { caller_invocation?: string };
      closure?: { kind?: string; target?: { type?: string } };
    };
    expect(body.mode).toBeUndefined();
    expect(body.supermatrix_internal).toBeUndefined();
    expect(body.client_request_id).toMatch(/^20\d\d-\d\d-\d\d:spawn-adjudication:/u);
    expect(body.closure).toEqual({ kind: "message", target: { type: "todo_pool" } });
  });

  test("redrive route posts a spawn2.0 todo-pool request instead of enqueueing a command todo", async () => {
    process.env.SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE = "1";
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
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://sm.test/api/spawn2.0");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      target: string;
      from: string;
      prompt: string;
      client_request_id: string;
      closure?: { kind?: string; target?: { type?: string } };
      verification_predicate?: {
        type: string;
        session_name: string;
        field: string;
        contains_all?: string[];
        expected_window_sec?: number;
      };
      supermatrix_internal?: { caller_invocation?: string };
    };
    expect(body.client_request_id).toMatch(new RegExp(`^20\\d\\d-\\d\\d-\\d\\d:spawn-redrive:${item.comm_id}$`, "u"));
    const redriveToken = body.client_request_id;
    expect(body).toMatchObject({
      target: "target",
      from: "caller",
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: "target",
        field: "final_message",
        contains_all: [redriveToken],
        expected_window_sec: 3600,
      },
    });
    expect(body.prompt).toContain("test prompt");
    expect(body.prompt).toContain(redriveToken);
    expect(body.supermatrix_internal).toBeUndefined();
    const row = db
      .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number };
    expect(row).toEqual({ status: "re_driving", attempt_count: 1 });
  });

  test("redrive aborts a hanging spawn request before it can hold the watcher tick", async () => {
    process.env.SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE = "1";
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

  test("deliver route enqueues a todo containing the full child result and provenance", async () => {
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
      originRunId: "mr_caller_batch_1",
    });

    await classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    });

    const calls = await readFile(callsPath, "utf8");
    expect(calls).toContain("--session caller");
    expect(calls).toContain("--source-session target");
    expect(calls).toContain(`--source-ref ${item.comm_id}`);
    expect(calls).toContain("--batch-key mr_caller_batch_1");
    expect(calls).toContain(`这是你请求〔${item.comm_id}〕的结果`);
    expect(calls).toContain("line 1");
    expect(calls).toContain("line 2 full result");
    const row = db
      .prepare("SELECT status, attempt_count, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as { status: string; attempt_count: number; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      attempt_count: 1,
      verdict: "delivered",
      verdict_reason: "child completed after caller stopped waiting; deliver full result to caller",
    });
  });

  test("deliver route records rejected heartbeat enqueue attempts without throwing", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-deliver-rejected-"));
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"ok":false,"error":"heartbeat disabled"}\\n'
`,
      { mode: 0o755 },
    );
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "child result",
    });

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({ action: "deliver" });

    const row = db
      .prepare("SELECT status, attempt_count, last_attempt_at, verdict FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as {
        status: string;
        attempt_count: number;
        last_attempt_at: number | null;
        verdict: string | null;
      };
    expect(row.status).toBe("waiting_child");
    expect(row.attempt_count).toBe(1);
    expect(row.last_attempt_at).toEqual(expect.any(Number));
    expect(row.verdict).toBeNull();
  });

  test("deliver route settles terminally without burning an attempt when the caller has heartbeat disabled", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-deliver-hb-off-"));
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    // Mirrors the real enqueue-heartbeat-todo contract: exit 3, reason on stdout.
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
printf '{"ok":false,"status":"target_not_heartbeat_enabled","target_session":"caller"}\\n'
exit 3
`,
      { mode: 0o755 },
    );
    db.prepare("INSERT INTO bindings (group_id, session_id, created_at) VALUES ('oc_caller', 'sess_caller', ?)").run(Date.now());
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      childSessionId: "sess_child",
      finalMessage: "child result",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      apiBase: "http://fallback.test/",
      sourceSession: "supermatrix-root",
    })).resolves.toMatchObject({ action: "deliver" });

    const row = db
      .prepare("SELECT status, attempt_count, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as {
        status: string;
        attempt_count: number;
        verdict: string | null;
        verdict_reason: string | null;
      };
    expect(row.status).toBe("parked");
    expect(row.attempt_count).toBe(0);
    expect(row.verdict).toBe("delivery_unsupported_caller_heartbeat_disabled");
    expect(row.verdict_reason).toContain("target_not_heartbeat_enabled");
    expect(row.verdict_reason).toContain(`/api/spawn_async_items/${item.ref}/take`);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://fallback.test/api/watcher-exception-notify");
    const notice = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(notice).toMatchObject({
      kind: "spawn_exception_transaction_fallback",
      spawn_comm_id: item.comm_id,
      trigger_signal: "delivery_unsupported_caller_heartbeat_disabled",
      target_chat_id: "oc_caller",
      dedupe_key: `${item.comm_id}:delivery-unsupported-caller-heartbeat-disabled`,
    });
  });

  test("deliver route keeps the enqueue script's own failure reason in verdict_reason", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-deliver-reason-"));
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
printf '{"ok":false,"error":"heartbeat state db is locked"}\\n'
exit 1
`,
      { mode: 0o755 },
    );
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      attemptCount: 3,
      childSessionId: "sess_child",
      finalMessage: "child result",
    });

    await classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    });

    const row = db
      .prepare("SELECT status, attempt_count, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as {
        status: string;
        attempt_count: number;
        verdict: string | null;
        verdict_reason: string | null;
      };
    expect(row).toMatchObject({ status: "parked", attempt_count: 4, verdict: "delivery_unreachable" });
    expect(row.verdict_reason).toContain("heartbeat state db is locked");
  });

  test("deliver route parks unreachable delivery after the retry budget is exhausted", async () => {
    const { db } = await makeDb();
    const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-deliver-park-"));
    const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
    await writeFile(
      heartbeatPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '{"ok":false,"error":"heartbeat disabled"}\\n'
`,
      { mode: 0o755 },
    );
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      attemptCount: 3,
      childSessionId: "sess_child",
      finalMessage: "child result",
    });

    await classifyAndRoute({
      item,
      db,
      heartbeatEnqueuePath: heartbeatPath,
      sourceSession: "supermatrix-root",
    });

    const row = db
      .prepare("SELECT status, attempt_count, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(item.ref) as {
        status: string;
        attempt_count: number;
        verdict: string | null;
        verdict_reason: string | null;
      };
    expect(row).toEqual({
      status: "parked",
      attempt_count: 4,
      verdict: "delivery_unreachable",
      verdict_reason: "heartbeat todo enqueue was not confirmed: heartbeat disabled",
    });
  });

  test("deliver candidates wait for delivery backoff before retrying heartbeat enqueue", async () => {
    process.env.SPAWN_CLOSURE_DELIVERY_BACKOFF_MS = "60000";
    const { db } = await makeDb();
    const item = seedAsyncItem(db, {
      failureKind: "late_result",
      status: "waiting_child",
      attemptCount: 1,
      childSessionId: "sess_child",
      finalMessage: "child result",
    });
    const lastAttemptAt = Date.now() - 5_000;
    db.prepare("UPDATE spawn_async_items SET last_attempt_at = ? WHERE ref = ?").run(lastAttemptAt, item.ref);

    expect(classifyAsyncItem({ ...item, last_attempt_at: lastAttemptAt }, db)).toEqual({
      route: "noop",
      reason: "delivery retry backoff active",
    });
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

  test("re_driving item is closed immediately when its redrive comm has completed", async () => {
    const { db } = await makeDb();
    const seeded = seedAsyncItem(db, {
      failureKind: "late_result",
      attemptCount: 1,
      status: "re_driving",
    });
    // Seed a completed comm whose client_request_id matches the spawn-redrive pattern
    const redriveCommId = `comm_redrive_${Math.random().toString(36).slice(2, 12)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
          result_preview, final_message, message_run_id, client_request_id, created_at, finished_at)
       VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'redrive prompt', 'sess_child', 'completed',
               'done', 'business result', NULL, ?, ?, ?)`
    ).run(redriveCommId, `2099-01-01:spawn-redrive:${seeded.comm_id}`, now - 100, now);

    const result = classifyAsyncItem({ ...seeded, last_attempt_at: now - 5_000 }, db);
    expect(result).toMatchObject({
      route: "noop",
      reason: "redrive comm completed; original item closed",
      successfulCommId: redriveCommId,
    });
    const row = db
      .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
      .get(seeded.ref) as { status: string; verdict: string | null; verdict_reason: string | null };
    expect(row).toEqual({
      status: "closed",
      verdict: "business_satisfied_elsewhere",
      verdict_reason: `same client_request_id completed by ${redriveCommId}`,
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

async function makeHeartbeatEnqueueStub(status: "inserted" | "duplicate" | "enqueued"): Promise<{
  callsPath: string;
  heartbeatPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-failure-notice-"));
  const callsPath = join(dir, "calls.txt");
  const heartbeatPath = join(dir, "enqueue-heartbeat-todo");
  await writeFile(
    heartbeatPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
printf '{"ok":true,"status":"${status}"}\\n'
`,
    { mode: 0o755 },
  );
  return { callsPath, heartbeatPath };
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
    originRunId?: string | null;
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
        result_preview, final_message, message_run_id, client_request_id, origin_run_id, created_at, finished_at)
     VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'test prompt', ?, 'completed',
             ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    commId,
    input.childSessionId ?? null,
    input.finalMessage ?? null,
    input.finalMessage ?? null,
    runId,
    input.clientRequestId ?? null,
    input.originRunId ?? null,
    now - 1_000,
    now,
  );
  const item: SpawnAsyncItem = {
    ref: `async_${commId}`,
    comm_id: commId,
    caller_session: "caller",
    target_session: "target",
    client_request_id: input.clientRequestId ?? null,
    origin_run_id: input.originRunId ?? null,
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

function expectParkedAutoRedriveSuppressed(db: Database.Database, ref: string, note: string): void {
  const row = db
    .prepare("SELECT status, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
    .get(ref) as { status: string; verdict: string | null; verdict_reason: string | null };
  expect(row).toEqual({
    status: "parked",
    verdict: "auto_redrive_suppressed",
    verdict_reason: `${note}; set SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE=1 to allow watcher redrive`,
  });
}

function expectPendingFailureNoticeRetry(
  db: Database.Database,
  ref: string,
  expected: { status?: SpawnAsyncItem["status"]; attemptCount?: number } = {},
): void {
  const row = db
    .prepare("SELECT status, attempt_count, verdict, verdict_reason FROM spawn_async_items WHERE ref = ?")
    .get(ref) as {
      status: string;
      attempt_count: number;
      verdict: string | null;
      verdict_reason: string | null;
    };
  expect(row).toEqual({
    status: expected.status ?? "pending",
    attempt_count: expected.attemptCount ?? 0,
    verdict: null,
    verdict_reason: null,
  });
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
    origin_run_id: null,
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
