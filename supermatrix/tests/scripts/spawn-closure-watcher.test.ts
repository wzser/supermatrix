import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../..", import.meta.url).pathname;

describe("scripts/spawn-closure-watcher.sh", () => {
  test("recovers orphan spawn comms, persists a caller failure notice, then parks the async item", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertOrphanSpawnComm(seeded.dbPath, {
        createdAt: Date.now() - 61_000,
        prompt: "orphan prompt",
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      expect(result.stdout).toContain('"event":"spawn_comm_orphan_recovered"');
      expect(result.stdout).toContain(`"comm_id":"${commId}"`);
      expect(result.stdout).toContain('"route":"failure_notice"');
      expect(result.stdout).toContain('"action":"failure_notice"');
      expect(api.calls).toHaveLength(0);
      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls).toContain(`--key ${commId}:failure-notice`);
      expect(calls).toContain(`--source-ref ${commId}`);
      expect(calls).toContain("--todo-type status_reconcile");
      expect(calls).toContain("--batch-mode single");
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({
        status: "parked",
        attempt_count: 0,
        verdict: "auto_redrive_suppressed",
        verdict_reason: "child session did not start; re-drive target session; set SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE=1 to allow watcher redrive",
      });
    } finally {
      await api.close();
    }
  });

  test("does not recover orphan spawn comms created before the max item age window", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
      const commId = insertOrphanSpawnComm(seeded.dbPath, {
        createdAt: sevenHoursAgo,
        prompt: "old orphan prompt",
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        maxItemAgeMs: 6 * 60 * 60 * 1000,
      });

      expect(result.stdout).not.toContain('"event":"spawn_comm_orphan_recovered"');
      expect(api.calls).toHaveLength(0);
      expect(countAsyncItemsForComm(seeded.dbPath, commId)).toBe(0);
    } finally {
      await api.close();
    }
  });

  test("scans open spawn_async_items and prints a tick summary", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      for (const status of ["pending", "waiting_child", "delivering", "re_driving", "adjudicating"] as const) {
        insertAsyncItem(seeded.dbPath, { status, failureKind: "spawn_not_started" });
      }
      insertAsyncItem(seeded.dbPath, { status: "closed", failureKind: "spawn_not_started" });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      expect(result.summary).toMatchObject({
        event: "spawn_closure_watcher_tick",
        scanned: 5,
      });
      const routed = result.summary.routed as Record<string, number>;
      expect(routed.deliver + routed.failure_notice + routed.redrive + routed.redeliver + routed.adjudicate + routed.noop).toBe(5);
    } finally {
      await api.close();
    }
  });

  test("ignores async items created before the max item age window", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "pending",
        failureKind: "spawn_not_started",
        createdAt: sevenHoursAgo,
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        maxItemAgeMs: 6 * 60 * 60 * 1000,
      });

      expect(result.summary).toMatchObject({
        event: "spawn_closure_watcher_tick",
        scanned: 0,
      });
      expect(api.calls).toHaveLength(0);
      expect(await readTextIfExists(heartbeat.callsPath)).toBe("");
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "pending", attempt_count: 0 });
    } finally {
      await api.close();
    }
  });

  test("does not reopen a delivery_unreachable item after the heartbeat fallback terminal state", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "pending",
        failureKind: "run_error",
        attemptCount: 4,
      });
      const db = new Database(seeded.dbPath);
      try {
        db.prepare(
          `UPDATE spawn_async_items
           SET status = 'parked', verdict = 'delivery_unreachable', verdict_reason = 'heartbeat unavailable'
           WHERE comm_id = ?`,
        ).run(commId);
      } finally {
        db.close();
      }

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      expect(result.summary).toMatchObject({ scanned: 0 });
      expect(await readTextIfExists(heartbeat.callsPath)).toBe("");
      expect(api.calls).toHaveLength(0);
      expect(readAsyncItem(seeded.dbPath, commId)).toMatchObject({
        status: "parked",
        attempt_count: 4,
        verdict: "delivery_unreachable",
      });
    } finally {
      await api.close();
    }
  });

  test("redrive route reposts the original spawn and marks item re_driving", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, { status: "pending", failureKind: "spawn_not_started" });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        autoRedrive: true,
      });

      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls).toBe("");
      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]).toMatchObject({
        target: "target",
        from: "caller",
      });
      expect(api.calls[0]).toHaveProperty("prompt");
      expect((api.calls[0] as Record<string, unknown>).prompt).toContain("test prompt");
      expect(api.calls[0]).not.toHaveProperty("supermatrix_internal");
      expect(result.stdout).toContain(`"comm_id":"${commId}"`);
      expect(result.stdout).toContain('"route":"redrive"');
      expect(result.stdout).toContain('"event":"spawn_closure_watcher_action"');
      expect(result.stdout).toContain('"action":"redrive"');
      expect(result.stdout).toContain('"event":"spawn_closure_state_transition"');
      expect(result.stdout).toContain('"to_status":"re_driving"');

      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "re_driving", attempt_count: 1 });
      expect(row.last_attempt_at).toEqual(expect.any(Number));
    } finally {
      await api.close();
    }
  });

  test("deliver route enqueues full result todo and closes item", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "waiting_child",
        failureKind: "late_result",
        childSessionId: "sess_child",
        finalMessage: "full watcher result",
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls).toContain("--session caller");
      expect(calls).toContain(`--key ${commId} `);
      expect(calls).not.toContain(`--key ${commId}:`);
      expect(calls).toContain(`--source-ref ${commId}`);
      expect(calls).toContain(`这是你请求〔${commId}〕的结果`);
      expect(calls).toContain("full watcher result");
      expect(result.stdout).toContain('"route":"deliver"');
      expect(result.stdout).toContain('"action":"deliver"');
      expect(result.stdout).toContain('"fullResultChars":19');
      expect(result.stdout).toContain('"to_status":"closed"');

      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "closed", attempt_count: 1 });
    } finally {
      await api.close();
    }
  });

  test("delivery-ready children bypass the low-frequency fallback scan limit", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const older = Date.now() - 10 * 60 * 1000;
      insertAsyncItem(seeded.dbPath, {
        status: "pending",
        failureKind: "spawn_not_started",
        createdAt: older,
      });
      const readyOne = insertAsyncItem(seeded.dbPath, {
        status: "waiting_child",
        failureKind: "late_result",
        childSessionId: "sess_ready_1",
        finalMessage: "ready one",
      });
      const readyTwo = insertAsyncItem(seeded.dbPath, {
        status: "waiting_child",
        failureKind: "run_timeout",
        childSessionId: "sess_ready_2",
        finalMessage: "ready two",
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        scanLimit: 1,
        deliveryScanLimit: 10,
      });

      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls).toContain(`--key ${readyOne} `);
      expect(calls).toContain("ready one");
      expect(calls).toContain(`--key ${readyTwo} `);
      expect(calls).toContain("ready two");
      expect(api.calls).toHaveLength(0);
      expect(result.summary).toMatchObject({ scanned: 3 });
      expect((result.summary.routed as Record<string, number>).deliver).toBe(2);
      expect((result.summary.routed as Record<string, number>).failure_notice).toBe(1);
      expect(calls).toContain(":failure-notice");
    } finally {
      await api.close();
    }
  });

  test("waiting_child run_timeout with completed output is enqueued back to caller", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "waiting_child",
        failureKind: "run_timeout",
        childSessionId: "sess_child",
        finalMessage: "timeout child finished later",
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls).toContain("--session caller");
      expect(calls).toContain(`--key ${commId} `);
      expect(calls).toContain("timeout child finished later");
      expect(result.stdout).toContain('"route":"deliver"');
      expect(result.stdout).toContain('"action":"deliver"');
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "closed", attempt_count: 1 });
    } finally {
      await api.close();
    }
  });

  test("late_result is enqueued once with a stable comm key and then closed", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "waiting_child",
        failureKind: "late_result",
        childSessionId: "sess_child",
        finalMessage: "only one copy",
      });

      await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        deliveryGraceMs: 1,
      });
      forcePastDeliveryGrace(seeded.dbPath, commId);
      await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        deliveryGraceMs: 1,
      });

      const calls = await readTextIfExists(heartbeat.callsPath);
      expect(calls.match(/--session caller --key /g)).toHaveLength(1);
      expect(calls).toContain(`--key ${commId} `);
      expect(calls).not.toContain(`--key ${commId}:`);
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "closed", attempt_count: 1 });
    } finally {
      await api.close();
    }
  });

  test("adjudicate route spawns sk-watcher child and marks item adjudicating", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "pending",
        failureKind: "run_error",
        attemptCount: 2,
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      expect(api.calls).toHaveLength(1);
      expect(api.calls[0]).toMatchObject({
        target: "sk-watcher",
        from: "sk-watcher",
      });
      expect(api.calls[0]).toMatchObject({
        verification_predicate: expect.objectContaining({ session_name: "sk-watcher" }),
      });
      expect(JSON.stringify(api.calls[0])).toContain(commId);
      expect(JSON.stringify(api.calls[0])).toContain("spawn-exception-transaction.md");
      expect(result.stdout).toContain('"route":"adjudicate"');

      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "adjudicating", attempt_count: 2 });
    } finally {
      await api.close();
    }
  });

  test("same client_request_id completed elsewhere closes item without adjudicating", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const clientRequestId = "biz-request-watcher-123";
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "pending",
        failureKind: "run_error",
        attemptCount: 2,
        clientRequestId,
      });
      const successfulCommId = insertCompletedBusinessComm(seeded.dbPath, clientRequestId);

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
      });

      expect(api.calls).toHaveLength(0);
      expect(result.stdout).toContain('"event":"business_satisfied_elsewhere"');
      expect(result.stdout).toContain(`"comm_id":"${commId}"`);
      expect(result.stdout).toContain(`"successful_comm_id":"${successfulCommId}"`);
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({
        status: "closed",
        attempt_count: 2,
        verdict: "business_satisfied_elsewhere",
        verdict_reason: `same client_request_id completed by ${successfulCommId}`,
      });
    } finally {
      await api.close();
    }
  });

  test("adjudicating item inside stale window is skipped without spawning sk-watcher", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const lastAttemptAt = Date.now() - 60_000;
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "adjudicating",
        failureKind: "run_error",
        attemptCount: 2,
        lastAttemptAt,
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        adjudicationStaleMs: 30 * 60 * 1000,
      });

      expect(api.calls).toHaveLength(0);
      expect(result.stdout).toContain(`"comm_id":"${commId}"`);
      expect(result.stdout).toContain('"route":"noop"');
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "adjudicating", attempt_count: 2, last_attempt_at: lastAttemptAt });
    } finally {
      await api.close();
    }
  });

  test("stale adjudicating item is routed to sk-watcher again", async () => {
    const seeded = await seedWatcherDb();
    const heartbeat = await makeHeartbeatStub(seeded.dir);
    const api = await startMockApi();
    try {
      const lastAttemptAt = Date.now() - 60_000;
      const commId = insertAsyncItem(seeded.dbPath, {
        status: "adjudicating",
        failureKind: "run_error",
        attemptCount: 2,
        lastAttemptAt,
      });

      const result = await runWatcher(seeded.dbPath, {
        heartbeatPath: heartbeat.scriptPath,
        apiBase: api.baseUrl,
        adjudicationStaleMs: 1,
      });

      expect(api.calls).toHaveLength(1);
      expect(JSON.stringify(api.calls[0])).toContain(commId);
      expect(result.stdout).toContain('"route":"adjudicate"');
      const row = readAsyncItem(seeded.dbPath, commId);
      expect(row).toMatchObject({ status: "adjudicating", attempt_count: 2 });
      expect(row.last_attempt_at).toBeGreaterThan(lastAttemptAt);
    } finally {
      await api.close();
    }
  });
});

async function seedWatcherDb(): Promise<{ dir: string; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-watcher-"));
  const dbPath = join(dir, "supermatrix.db");
  const store = new SqliteBindingStore(dbPath);
  await store.init();
  await store.close();

  const db = new Database(dbPath);
  try {
    const now = Date.now();
    insertSession(db, "sess_caller", "caller", now);
    insertSession(db, "sess_target", "target", now);
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function insertSession(db: Database.Database, id: string, name: string, now: number): void {
  db.prepare(
    `INSERT INTO sessions
       (id, name, scope, backend, workdir, purpose, status, created_at, updated_at)
     VALUES (?, ?, 'user', 'codex', ?, '', 'idle', ?, ?)`
  ).run(id, name, repoRoot, now, now);
}

function insertAsyncItem(
  dbPath: string,
  input: {
    status: "pending" | "waiting_child" | "delivering" | "re_driving" | "adjudicating" | "closed";
    failureKind: string;
    attemptCount?: number;
    lastAttemptAt?: number | null;
    childSessionId?: string | null;
    finalMessage?: string | null;
    clientRequestId?: string | null;
    createdAt?: number;
  },
): string {
  const db = new Database(dbPath);
  try {
    ensureClientRequestIdColumn(db);
    const now = Date.now();
    const createdAt = input.createdAt ?? now;
    const commId = `comm_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (input.childSessionId) {
      db.prepare(
        `INSERT OR IGNORE INTO sessions
           (id, name, scope, backend, workdir, purpose, status, parent_id, depth, created_at, updated_at)
         VALUES (?, ?, 'child', 'codex', ?, '', 'deleted', 'sess_target', 1, ?, ?)`
      ).run(input.childSessionId, `${input.childSessionId}_name`, repoRoot, now, now);
      db.prepare(
        `INSERT INTO message_runs
           (id, session_id, group_id, prompt, started_at, finished_at, status, final_message, error_message)
         VALUES (?, ?, 'oc_test', 'test prompt', ?, ?, 'completed', ?, NULL)`
      ).run(`mr_${commId}`, input.childSessionId, now - 100, now, input.finalMessage ?? null);
    }
    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status, result_preview,
          final_message, message_run_id, client_request_id, created_at, finished_at)
       VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'test prompt', ?, 'completed', ?, ?, ?, ?, ?, ?)`
    ).run(
      commId,
      input.childSessionId ?? null,
      input.finalMessage ?? null,
      input.finalMessage ?? null,
      input.childSessionId ? `mr_${commId}` : null,
      input.clientRequestId ?? null,
      createdAt,
      input.childSessionId ? now : null,
    );
    db.prepare(
      `INSERT INTO spawn_async_items
         (ref, comm_id, caller_session, target_session, failed_phase, failure_kind,
          attempt_count, status, created_at, updated_at, last_attempt_at)
       VALUES (?, ?, 'caller', 'target', 'communication', ?, ?, ?, ?, ?, ?)`
    ).run(
      `async_${commId}`,
      commId,
      input.failureKind,
      input.attemptCount ?? 0,
      input.status,
      createdAt,
      input.lastAttemptAt ?? now,
      input.lastAttemptAt ?? null,
    );
    return commId;
  } finally {
    db.close();
  }
}

function insertOrphanSpawnComm(
  dbPath: string,
  input: {
    createdAt: number;
    prompt: string;
  },
): string {
  const db = new Database(dbPath);
  try {
    const commId = `comm_orphan_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status, created_at)
       VALUES (?, 'sess_caller', 'sess_target', 'spawn', ?, NULL, 'pending', ?)`
    ).run(commId, input.prompt, input.createdAt);
    return commId;
  } finally {
    db.close();
  }
}

function insertCompletedBusinessComm(dbPath: string, clientRequestId: string): string {
  const db = new Database(dbPath);
  try {
    ensureClientRequestIdColumn(db);
    const now = Date.now();
    const commId = `comm_success_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
          result_preview, final_message, message_run_id, client_request_id, created_at, finished_at)
       VALUES (?, 'sess_caller', 'sess_target', 'spawn', 'successful retry', 'sess_child_success',
               'completed', 'business done', 'business done', NULL, ?, ?, ?)`
    ).run(commId, clientRequestId, now - 100, now);
    return commId;
  } finally {
    db.close();
  }
}

function readAsyncItem(dbPath: string, commId: string): {
  status: string;
  attempt_count: number;
  last_attempt_at: number | null;
  verdict: string | null;
  verdict_reason: string | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT status, attempt_count, last_attempt_at, verdict, verdict_reason FROM spawn_async_items WHERE comm_id = ?")
      .get(commId) as ReturnType<typeof readAsyncItem> | undefined;
    if (!row) throw new Error(`missing async item for ${commId}`);
    return row;
  } finally {
    db.close();
  }
}

function countAsyncItemsForComm(dbPath: string, commId: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM spawn_async_items WHERE comm_id = ?")
      .get(commId) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function ensureClientRequestIdColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(cross_session_log)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "client_request_id")) {
    db.exec("ALTER TABLE cross_session_log ADD COLUMN client_request_id TEXT");
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function makeHeartbeatStub(dir: string): Promise<{ scriptPath: string; callsPath: string }> {
  const scriptPath = join(dir, "enqueue-heartbeat-todo");
  const callsPath = join(dir, "heartbeat-calls.jsonl");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
printf '{"ok":true,"status":"inserted"}\\n'
`,
    { mode: 0o755 },
  );
  return { scriptPath, callsPath };
}

async function runWatcher(
  dbPath: string,
  options: {
    heartbeatPath: string;
    apiBase: string;
    adjudicationStaleMs?: number;
    deliveryGraceMs?: number;
    maxItemAgeMs?: number;
    scanLimit?: number;
    deliveryScanLimit?: number;
    autoRedrive?: boolean;
  },
): Promise<{ stdout: string; stderr: string; summary: Record<string, unknown> }> {
  const { stdout, stderr } = await execFileAsync("bash", ["scripts/spawn-closure-watcher.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SM_DB_PATH: dbPath,
      SM_API_BASE: options.apiBase,
      SPAWN_CLOSURE_HEARTBEAT_ENQUEUE: options.heartbeatPath,
      SPAWN_CLOSURE_SCAN_LIMIT: String(options.scanLimit ?? 50),
      SPAWN_CLOSURE_DELIVERY_SCAN_LIMIT: options.deliveryScanLimit === undefined
        ? undefined
        : String(options.deliveryScanLimit),
      SPAWN_CLOSURE_STALE_MS: String(24 * 60 * 60 * 1000),
      SPAWN_CLOSURE_ADJUDICATION_STALE_MS: options.adjudicationStaleMs === undefined
        ? undefined
        : String(options.adjudicationStaleMs),
      SPAWN_CLOSURE_DELIVERY_GRACE_MS: options.deliveryGraceMs === undefined
        ? undefined
        : String(options.deliveryGraceMs),
      SPAWN_CLOSURE_MAX_ITEM_AGE_MS: options.maxItemAgeMs === undefined
        ? undefined
        : String(options.maxItemAgeMs),
      SPAWN_CLOSURE_ENABLE_AUTO_REDRIVE: options.autoRedrive ? "1" : undefined,
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  const summaryLine = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!summaryLine) throw new Error(`watcher printed no summary; stderr=${stderr}`);
  return { stdout, stderr, summary: JSON.parse(summaryLine) as Record<string, unknown> };
}

function forcePastDeliveryGrace(dbPath: string, commId: string): void {
  const db = new Database(dbPath);
  try {
    const old = Date.now() - 10_000;
    db.prepare("UPDATE spawn_async_items SET last_attempt_at = ?, updated_at = ? WHERE comm_id = ?")
      .run(old, old, commId);
  } finally {
    db.close();
  }
}

async function startMockApi(): Promise<{ baseUrl: string; calls: unknown[]; close: () => Promise<void> }> {
  const calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    calls.push(await readJsonBody(req));
    writeJson(res, 202, { ok: true, childSessionId: "sess_sk_child" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => closeServer(server),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
