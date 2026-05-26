import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import { canonicalJsonStringify, predicateHash } from "../../src/app/spawnPredicate/schema.ts";
import type { FileMtimePredicate, PredicateTriggerSignal } from "../../src/domain/spawnPredicate.ts";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const oneHourMs = 60 * 60 * 1000;

type ApiCall = {
  path: string;
  body: Record<string, unknown>;
};

type MockApi = {
  baseUrl: string;
  calls: ApiCall[];
  close(): Promise<void>;
};

type ScenarioSeed = {
  signal: PredicateTriggerSignal;
  expectedWindowSec?: number;
  initialFalseCount?: number;
  patchCount?: number;
  childStatus?: "idle" | "error" | "deleted";
  childSessionId?: string | null;
  failedSink?: boolean;
  spawnAgeMs?: number;
  spawnCreatedAt?: number;
  emptyPredicateJson?: boolean;
  streamLog?: unknown[];
};

type SeededDb = {
  dbPath: string;
  dir: string;
  rootPath: string;
  spawnCommId: string;
};

const signalCases: ScenarioSeed[] = [
  {
    signal: "predicate_long_false",
    expectedWindowSec: 600,
    initialFalseCount: 2,
  },
  {
    signal: "predicate_patch_churn",
    patchCount: 3,
  },
  {
    signal: "child_unhealthy",
    childStatus: "error",
  },
  {
    signal: "delivery_failed",
    failedSink: true,
  },
  {
    signal: "spawn_creation_missing_child",
    childSessionId: null,
    spawnAgeMs: oneHourMs + 5_000,
  },
];

describe("scripts/watcher-tick.sh trigger routing", () => {
  test("recovers old orphan spawn comms before scanning predicates", async () => {
    const seeded = await seedWatcherDb({
      signal: "predicate_long_false",
      expectedWindowSec: 600,
      initialFalseCount: 2,
    });
    const orphanCommId = seedOrphanSpawnComm(seeded.dbPath, Date.now() - 61_000);
    const api = await startMockApi();
    try {
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath);

      expect(result.stdout).toContain("\"event\":\"spawn_comm_orphan_recovered\"");
      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 1,
        evaluatedCount: 1,
        routedCount: 1,
      });
      const recovered = readSpawnAsyncItem(seeded.dbPath, orphanCommId);
      expect(recovered).toMatchObject({
        comm_id: orphanCommId,
        caller_session: "supermatrix-root",
        target_session: "target-session",
        failed_phase: "communication",
        failure_kind: "spawn_not_started",
        status: "pending",
      });
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test("skips active predicate rows created before the strict cutover timestamp", async () => {
    const now = Date.now();
    const seeded = await seedWatcherDb({
      signal: "predicate_long_false",
      expectedWindowSec: 600,
      initialFalseCount: 99,
      spawnCreatedAt: now - 10_000,
    });
    const api = await startMockApi();
    try {
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath, {
        strictCutoverMs: now - 5_000,
      });

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 0,
        evaluatedCount: 0,
        routedCount: 0,
      });
      expect(api.calls).toHaveLength(0);
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test("skips active predicate rows with empty predicate JSON", async () => {
    const now = Date.now();
    const seeded = await seedWatcherDb({
      signal: "predicate_long_false",
      expectedWindowSec: 600,
      initialFalseCount: 99,
      spawnCreatedAt: now,
      emptyPredicateJson: true,
    });
    const api = await startMockApi();
    try {
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath, {
        strictCutoverMs: now - 5_000,
      });

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 0,
        evaluatedCount: 0,
        routedCount: 0,
      });
      expect(api.calls).toHaveLength(0);
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test.each(signalCases)("$signal routes to SK and writes watcher_state dedup", async (scenario) => {
    const seeded = await seedWatcherDb(scenario);
    const api = await startMockApi();
    try {
      const startedAt = Date.now();
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath);

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 1,
        evaluatedCount: 1,
        routedCount: 1,
      });
      expect(api.calls.filter((call) => call.path === "/api/spawn")).toHaveLength(1);
      expect(api.calls.filter((call) => call.path === "/api/notify")).toHaveLength(0);

      const spawnCall = api.calls.find((call) => call.path === "/api/spawn")!;
      expect(spawnCall.body).toMatchObject({
        target: "socail-king",
        from: "supermatrix-root",
        supermatrix_internal: { caller_invocation: "async_kickoff" },
      });
      expect(spawnCall.body.mode).toBeUndefined();
      const skPayload = parseSkPayload(spawnCall.body.prompt);
      expect(skPayload).toMatchObject({
        kind: "spawn_exception_transaction",
        dedupe_key: `${seeded.spawnCommId}:${scenario.signal}`,
        trigger: {
          signal: scenario.signal,
        },
        spawn: {
          comm_id: seeded.spawnCommId,
          from_session: "supermatrix-root",
          to_session: "target-session",
        },
      });

      const watcherState = readWatcherState(seeded.dbPath, seeded.spawnCommId);
      expect(watcherState).toMatchObject({
        last_trigger_signal: scenario.signal,
      });
      expect(watcherState.next_eligible_at).toBeGreaterThan(startedAt);
      expect(watcherState.transaction_started_at).toBeGreaterThanOrEqual(startedAt);
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test("routes pending tool-call evidence from message_runs.stream_log", async () => {
    const streamLog = [
      {
        ts: 1_700_000_100_000,
        kind: "tool_call",
        callId: "call_pending",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
        args: {
          cmd: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
        },
      },
      {
        ts: 1_700_000_101_000,
        kind: "thinking",
        text: "waiting on sqlite",
      },
    ];
    const seeded = await seedWatcherDb({
      signal: "child_unhealthy",
      streamLog,
    });
    const api = await startMockApi();
    try {
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath);

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 1,
        evaluatedCount: 1,
        routedCount: 1,
      });
      const spawnCall = api.calls.find((call) => call.path === "/api/spawn")!;
      const skPayload = parseSkPayload(spawnCall.body.prompt);
      const child = skPayload.child as Record<string, unknown>;
      expect(child.pending_tool_calls).toEqual([
        {
          callId: "call_pending",
          name: "exec_command",
          command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__business_report_asin_shop_d);"',
          ts: 1_700_000_100_000,
        },
      ]);
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test("falls back to /api/notify and records watcher_exceptions when SK spawn is unavailable", async () => {
    const seeded = await seedWatcherDb({
      signal: "child_unhealthy",
      childStatus: "error",
    });
    const api = await startMockApi({
      dbPath: seeded.dbPath,
      spawnStatus: 503,
      spawnBody: { ok: false, error: "SK unavailable" },
    });

    try {
      const startedAt = Date.now();
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath);

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 1,
        evaluatedCount: 1,
        routedCount: 1,
      });
      expect(api.calls.filter((call) => call.path === "/api/spawn")).toHaveLength(1);
      expect(api.calls.filter((call) => call.path === "/api/notify")).toHaveLength(1);

      const notifyCall = api.calls.find((call) => call.path === "/api/notify")!;
      expect(notifyCall.body).toMatchObject({
        kind: "spawn_exception_transaction_fallback",
        spawn_comm_id: seeded.spawnCommId,
        trigger_signal: "child_unhealthy",
      });
      expect(String(notifyCall.body.summary)).toContain("SK spawn failed");

      const watcherState = readWatcherState(seeded.dbPath, seeded.spawnCommId);
      expect(watcherState).toMatchObject({
        last_trigger_signal: "child_unhealthy",
      });
      expect(watcherState.next_eligible_at).toBeGreaterThan(startedAt);
      expect(watcherState.transaction_started_at).toBeGreaterThanOrEqual(startedAt);

      const exception = readWatcherException(seeded.dbPath, seeded.spawnCommId);
      expect(exception).toMatchObject({
        spawn_comm_id: seeded.spawnCommId,
        trigger_signal: "child_unhealthy",
        dedupe_key: `${seeded.spawnCommId}:child_unhealthy`,
        lark_message_id: "om_mock_notify",
      });
      expect(exception.tx_id).toMatch(/^tx-spawn-\d{8}-001$/);
      expect(exception.summary).toContain("SK fallback for child_unhealthy");
      expect(exception.payload).toContain("SK spawn failed");
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });

  test("route limit prevents multiple SK routes in one watcher tick", async () => {
    const seeded = await seedWatcherDb({
      signal: "predicate_long_false",
      expectedWindowSec: 600,
      initialFalseCount: 2,
      childStatus: "error",
    });
    const api = await startMockApi();

    try {
      const result = await runWatcherTick(seeded.dbPath, api.baseUrl, seeded.rootPath, {
        routeLimit: 1,
      });

      expect(result.summary).toMatchObject({
        ok: true,
        scannedCount: 1,
        evaluatedCount: 1,
        routedCount: 1,
      });
      expect(api.calls.filter((call) => call.path === "/api/spawn")).toHaveLength(1);
      expect(api.calls.filter((call) => call.path === "/api/notify")).toHaveLength(0);
      expect(result.stderr).toContain("route limit 1 reached for this watcher tick");
    } finally {
      await api.close();
      await rm(seeded.dir, { force: true, recursive: true });
    }
  });
});

async function runWatcherTick(
  dbPath: string,
  apiBase: string,
  pathAllowlist: string,
  options: { routeLimit?: number; strictCutoverMs?: number } = {}
): Promise<{ stdout: string; stderr: string; summary: Record<string, unknown> }> {
  const { stdout, stderr } = await execFileAsync("bash", ["scripts/watcher-tick.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SM_DB_PATH: dbPath,
      SM_API_BASE: apiBase,
      TASK_ID: "vitest-watcher-tick",
      RUN_ID: "vitest-watcher-tick",
      SPAWN_WATCHER_SCAN_LIMIT: "1",
      ...(options.routeLimit ? { SPAWN_WATCHER_ROUTE_LIMIT: String(options.routeLimit) } : {}),
      ...(options.strictCutoverMs ? { SPAWN_WATCHER_STRICT_CUTOVER_MS: String(options.strictCutoverMs) } : {}),
      SPAWN_WATCHER_CRON_PERIOD_SEC: "300",
      SM_WATCHER_PATH_ALLOWLIST: pathAllowlist,
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  const summaryLine = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!summaryLine) {
    throw new Error(`watcher-tick did not print a summary; stderr=${stderr}`);
  }
  return {
    stdout,
    stderr,
    summary: JSON.parse(summaryLine) as Record<string, unknown>,
  };
}

async function seedWatcherDb(scenario: ScenarioSeed): Promise<SeededDb> {
  const dir = await mkdtemp(join(tmpdir(), "sm-watcher-tick-"));
  const dbPath = join(dir, "supermatrix.db");
  const rootPath = join(dir, "predicate-root");
  await mkdir(rootPath);

  const store = new SqliteBindingStore(dbPath);
  await store.init();
  await store.close();

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  try {
    const now = Date.now();
    const spawnCommId = `comm_${scenario.signal}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const childSessionId =
      scenario.childSessionId === null ? null : scenario.childSessionId ?? `sess_child_${randomUUID().slice(0, 8)}`;
    const spawnCreatedAt = scenario.spawnCreatedAt ?? now - (scenario.spawnAgeMs ?? 5_000);
    const predicate = falseFilePredicate(rootPath, scenario.expectedWindowSec ?? 3_600);
    const canonicalPredicate = canonicalJsonStringify(predicate);

    insertSession(db, "sess_from", "supermatrix-root", "idle", now);
    insertSession(db, "sess_to", "target-session", "idle", now);
    if (childSessionId) {
      insertSession(db, childSessionId, "target-session-child", scenario.childStatus ?? "idle", now);
    }

    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status, created_at)
       VALUES (?, ?, ?, 'spawn', 'test prompt', ?, 'pending', ?)`
    ).run(spawnCommId, "sess_from", "sess_to", childSessionId, spawnCreatedAt);

    db.prepare(
      `INSERT INTO spawn_predicates
         (spawn_comm_id, owner_session_id, created_by_session_id, last_patched_by_session_id,
          predicate_json, predicate_hash, version, status, created_at, updated_at)
       VALUES (?, 'sess_from', 'sess_from', NULL, ?, ?, 1, 'active', ?, ?)`
    ).run(spawnCommId, canonicalPredicate, predicateHash(predicate), spawnCreatedAt, spawnCreatedAt);

    if (scenario.emptyPredicateJson) {
      db.prepare("UPDATE spawn_predicates SET predicate_json = '' WHERE spawn_comm_id = ?").run(spawnCommId);
    }

    if ((scenario.initialFalseCount ?? 0) > 0) {
      db.prepare(
        `INSERT INTO watcher_state
           (spawn_comm_id, consecutive_false_count, consecutive_transient_fail_count,
            patch_count_24h, created_at, updated_at)
         VALUES (?, ?, 0, 0, ?, ?)`
      ).run(spawnCommId, scenario.initialFalseCount, now - 1_000, now - 1_000);
    }

    for (let i = 0; i < (scenario.patchCount ?? 0); i += 1) {
      db.prepare(
        `INSERT INTO spawn_predicate_patches
           (id, spawn_comm_id, version, actor_session_id, actor_role, tx_id,
            old_predicate_json, new_predicate_json, reason, created_at)
         VALUES (?, ?, ?, 'sess_from', 'owner', NULL, ?, ?, ?, ?)`
      ).run(
        `patch_${randomUUID()}`,
        spawnCommId,
        i + 2,
        canonicalPredicate,
        canonicalPredicate,
        `test patch ${i + 1}`,
        now - i * 1_000
      );
    }

    if (scenario.failedSink) {
      if (!childSessionId) throw new Error("failedSink scenario requires a child session");
      db.prepare(
        `INSERT INTO result_sink_attempts
           (id, spawn_comm_id, child_session_id, message_run_id, sink_index,
            sink_kind, status, note, error_message, created_at)
         VALUES (?, ?, ?, NULL, 0, 'parent_continuation_inject', 'failed',
                 'vitest failed sink', 'mock delivery failure', ?)`
      ).run(`sink_${randomUUID()}`, spawnCommId, childSessionId, now);
    }

    if (scenario.streamLog) {
      if (!childSessionId) throw new Error("streamLog scenario requires a child session");
      db.prepare(
        `INSERT INTO message_runs
           (id, session_id, group_id, prompt, card_id, started_at, finished_at,
            status, final_message, error_message, stream_log)
         VALUES (?, ?, 'oc_test', 'test prompt', NULL, ?, ?, 'timeout',
                 NULL, '[TIMEOUT] inactivity', ?)`
      ).run(
        `mr_${randomUUID()}`,
        childSessionId,
        now - 2_000,
        now - 1_000,
        JSON.stringify(scenario.streamLog)
      );
    }

    return { dbPath, dir, rootPath, spawnCommId };
  } finally {
    db.close();
  }
}

function falseFilePredicate(rootPath: string, expectedWindowSec: number): FileMtimePredicate {
  return {
    type: "file-mtime",
    root_path: rootPath,
    path_glob: "missing.txt",
    since: { kind: "timestamp_ms", value: 0 },
    min_count: 1,
    min_size_bytes: 0,
    expected_window_sec: expectedWindowSec,
    evaluation_timeout_ms: 1_000,
    retry_on_transient_fail: 2,
  };
}

function insertSession(
  db: Database.Database,
  id: string,
  name: string,
  status: string,
  now: number
): void {
  db.prepare(
    `INSERT INTO sessions
       (id, name, scope, backend, workdir, purpose, status, created_at, updated_at)
     VALUES (?, ?, ?, 'codex', ?, '', ?, ?, ?)`
  ).run(id, name, id.startsWith("sess_child_") ? "child" : "user", repoRoot, status, now, now);
}

async function startMockApi(options: {
  spawnStatus?: number;
  spawnBody?: Record<string, unknown>;
  dbPath?: string;
} = {}): Promise<MockApi> {
  const calls: ApiCall[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const body = await readJsonBody(req);
    calls.push({ path, body });

    if (path === "/api/spawn") {
      writeJson(res, options.spawnStatus ?? 202, options.spawnBody ?? {
        ok: true,
        childSessionId: "sess_sk_child",
      });
      return;
    }

    if (path === "/api/notify") {
      if (options.dbPath) {
        insertWatcherExceptionFromNotify(options.dbPath, body);
      }
      writeJson(res, 200, {
        ok: true,
        exception_id: "watcher_exception_mock",
        lark_message_id: "om_mock_notify",
      });
      return;
    }

    writeJson(res, 404, { ok: false, error: `unexpected path: ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => closeServer(server),
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
  }
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
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

function parseSkPayload(prompt: unknown): Record<string, unknown> {
  if (typeof prompt !== "string") throw new Error("SK spawn prompt must be a string");
  const match = prompt.match(/```json\n([\s\S]+)\n```/u);
  if (!match) throw new Error(`SK spawn prompt did not contain JSON payload: ${prompt}`);
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

function readWatcherState(dbPath: string, spawnCommId: string): {
  last_trigger_signal: string | null;
  next_eligible_at: number | null;
  transaction_started_at: number | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT last_trigger_signal, next_eligible_at, transaction_started_at
         FROM watcher_state
         WHERE spawn_comm_id = ?`
      )
      .get(spawnCommId) as ReturnType<typeof readWatcherState> | undefined;
    if (!row) throw new Error(`watcher_state row missing for ${spawnCommId}`);
    return row;
  } finally {
    db.close();
  }
}

function readWatcherException(dbPath: string, spawnCommId: string): {
  spawn_comm_id: string | null;
  trigger_signal: string;
  tx_id: string | null;
  dedupe_key: string | null;
  summary: string;
  payload: string | null;
  lark_message_id: string | null;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT spawn_comm_id, trigger_signal, tx_id, dedupe_key, summary, payload, lark_message_id
         FROM watcher_exceptions
         WHERE spawn_comm_id = ?
         ORDER BY ts DESC
         LIMIT 1`
      )
      .get(spawnCommId) as ReturnType<typeof readWatcherException> | undefined;
    if (!row) throw new Error(`watcher_exceptions row missing for ${spawnCommId}`);
    return row;
  } finally {
    db.close();
  }
}

function seedOrphanSpawnComm(dbPath: string, createdAt: number): string {
  const db = new Database(dbPath);
  try {
    const commId = `comm_orphan_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    db.prepare(
      `INSERT INTO cross_session_log
         (id, from_session_id, to_session_id, kind, prompt, child_session_id, status, created_at)
       VALUES (?, 'sess_from', 'sess_to', 'spawn', 'orphan prompt', NULL, 'pending', ?)`
    ).run(commId, createdAt);
    return commId;
  } finally {
    db.close();
  }
}

function readSpawnAsyncItem(dbPath: string, commId: string): {
  comm_id: string;
  caller_session: string | null;
  target_session: string | null;
  failed_phase: string;
  failure_kind: string;
  status: string;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT comm_id, caller_session, target_session, failed_phase, failure_kind, status
         FROM spawn_async_items
         WHERE comm_id = ?`
      )
      .get(commId) as ReturnType<typeof readSpawnAsyncItem> | undefined;
    if (!row) throw new Error(`spawn_async_items row missing for ${commId}`);
    return row;
  } finally {
    db.close();
  }
}

function insertWatcherExceptionFromNotify(dbPath: string, body: Record<string, unknown>): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO watcher_exceptions
         (id, ts, spawn_comm_id, trigger_signal, tx_id, dedupe_key, summary,
          payload, lark_message_id, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'om_mock_notify', NULL)`
    ).run(
      `watcher_exception_${randomUUID()}`,
      Date.now(),
      asNullableString(body.spawn_comm_id),
      String(body.trigger_signal),
      asNullableString(body.tx_id),
      asNullableString(body.dedupe_key),
      String(body.summary),
      body.payload === undefined ? null : JSON.stringify(body.payload)
    );
  } finally {
    db.close();
  }
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
