import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SqliteBindingStore } from "../../src/adapters/store-sqlite/index.ts";
import type { SpawnChildInput } from "../../src/app/childSession.ts";
import { startApiServer, type ApiDeps } from "../../src/cli/apiServer.ts";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { Logger } from "../../src/ports/Logger.ts";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("../..", import.meta.url).pathname;

describe("e2e spawn closure async watcher path", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteBindingStore;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let baseUrl: string;
  let previousPatchToken: string | undefined;

  beforeEach(async () => {
    previousPatchToken = process.env.SM_PREDICATE_PATCH_TOKEN;
    process.env.SM_PREDICATE_PATCH_TOKEN = "test-predicate-token";
    dir = await mkdtemp(join(tmpdir(), "sm-spawn-closure-e2e-"));
    dbPath = join(dir, "supermatrix.db");
    store = new SqliteBindingStore(dbPath);
    await store.init();
    seedSession(store.db, mkSession("sess_caller", "caller"));
    seedSession(store.db, mkSession("sess_target", "target"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await store.close();
    if (previousPatchToken === undefined) {
      delete process.env.SM_PREDICATE_PATCH_TOKEN;
    } else {
      process.env.SM_PREDICATE_PATCH_TOKEN = previousPatchToken;
    }
  });

  test("empty sync spawn switches async, watcher re-posts original spawn, and trace stays keyed by comm_id", async () => {
    const logRows: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
    let attempts = 0;
    const deps: ApiDeps = {
      store,
      closureDb: store.db,
      childSession: {
        async spawnChild(input: SpawnChildInput) {
          attempts += 1;
          const commId = `comm_e2e_${attempts}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const child = mkSession(`sess_child_${attempts}`, `child_${attempts}`, "child");
          seedSession(store.db, child);
          const runId = asMessageRunId(`mr_child_${attempts}`);
          store.db
            .prepare(
              `INSERT INTO message_runs
                 (id, session_id, group_id, prompt, started_at, finished_at, status, final_message, error_message)
               VALUES (?, ?, 'oc_test', ?, ?, ?, 'completed', '', NULL)`
            )
            .run(runId, child.id, input.prompt, Date.now() - 10, Date.now());
          store.db
            .prepare(
              `INSERT INTO cross_session_log
                 (id, from_session_id, to_session_id, kind, prompt, child_session_id, status,
                  result_preview, final_message, message_run_id, created_at, finished_at)
               VALUES (?, 'sess_caller', 'sess_target', 'spawn', ?, ?, 'completed',
                       '', '', ?, ?, ?)`
            )
            .run(commId, input.prompt, child.id, runId, Date.now() - 10, Date.now());
          return {
            session: child,
            finalMessage: "",
            backendSessionId: null,
            messageRunId: runId,
            spawnCommId: commId,
          };
        },
      },
      runOnSession: async () => {
        throw new Error("runOnSession should not be called");
      },
      notifier: {
        async notify() {
          throw new Error("notifier should not be called");
        },
      },
      logger: captureLogger(logRows),
    };
    server = await startApiServer(deps, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${baseUrl}/api/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "target",
        from: "caller",
        prompt: "return an empty result",
        verification_predicate: {
          type: "inbox-message",
          session_name: "target",
          field: "prompt",
          contains_all: ["comm_e2e_predicate"],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; spawnCommId: string };
    expect(body).toMatchObject({ ok: false, status: "switched_async" });
    expect(body.spawnCommId).toMatch(/^comm_e2e_2_/u);

    const asyncRow = store.db
      .prepare("SELECT * FROM spawn_async_items WHERE comm_id = ?")
      .get(body.spawnCommId) as { failure_kind: string; status: string; attempt_count: number } | undefined;
    expect(asyncRow).toMatchObject({ failure_kind: "empty_output", status: "pending", attempt_count: 0 });

    const heartbeat = await makeHeartbeatStub(dir);
    const watcher = await runWatcher(dbPath, {
      heartbeatPath: heartbeat.scriptPath,
      apiBase: baseUrl,
    });
    await expect(readFile(heartbeat.callsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(watcher.stdout).toContain(`"comm_id":"${body.spawnCommId}"`);
    expect(watcher.stdout).toContain('"route":"redrive"');
    expect(attempts).toBe(4);

    const updated = store.db
      .prepare("SELECT status, attempt_count FROM spawn_async_items WHERE comm_id = ?")
      .get(body.spawnCommId) as { status: string; attempt_count: number };
    expect(updated).toEqual({ status: "re_driving", attempt_count: 1 });

    const closureEvents = logRows
      .filter((row) => row.message === "spawn closure" && row.fields?.comm_id === body.spawnCommId)
      .map((row) => row.fields?.closure_event);
    expect(closureEvents).toEqual(expect.arrayContaining(["phase_check", "sync_retry", "async_switch"]));
  });
});

function mkSession(id: string, name: string, scope: "user" | "child" = "user"): Session {
  return {
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope,
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(repoRoot),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: scope === "child" ? asSessionId("sess_target") : null,
    depth: scope === "child" ? 1 : 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(Date.now()),
    updatedAt: asTimestamp(Date.now()),
  };
}

function seedSession(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions
       (id, name, alias, avatar, category, scope, backend, model, workdir, backend_session_id,
        purpose, status, parent_id, depth, heartbeat_enabled, created_at, updated_at)
     VALUES (?, ?, '', '', '', ?, ?, NULL, ?, NULL, '', ?, ?, ?, 1, ?, ?)`
  ).run(
    session.id,
    session.name,
    session.scope,
    session.backend,
    session.workdir,
    session.status,
    session.parentId,
    session.depth,
    session.createdAt,
    session.updatedAt,
  );
}

function captureLogger(rows: Array<{ level: string; message: string; fields?: Record<string, unknown> }>): Logger {
  const logger: Logger = {
    debug() {},
    info(message, fields) {
      rows.push(fields === undefined ? { level: "info", message } : { level: "info", message, fields });
    },
    warn(message, fields) {
      rows.push(fields === undefined ? { level: "warn", message } : { level: "warn", message, fields });
    },
    error(message, fields) {
      rows.push(fields === undefined ? { level: "error", message } : { level: "error", message, fields });
    },
    child() {
      return logger;
    },
  };
  return logger;
}

async function makeHeartbeatStub(dir: string): Promise<{ scriptPath: string; callsPath: string }> {
  const scriptPath = join(dir, "enqueue-heartbeat-todo");
  const callsPath = join(dir, "heartbeat-calls.jsonl");
  await writeFile(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${callsPath}"
printf '{"ok":true,"status":"enqueued"}\\n'
`,
    { mode: 0o755 },
  );
  return { scriptPath, callsPath };
}

async function runWatcher(
  dbPath: string,
  options: { heartbeatPath: string; apiBase: string },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("bash", ["scripts/spawn-closure-watcher.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SM_DB_PATH: dbPath,
      SM_API_BASE: options.apiBase,
      SPAWN_CLOSURE_HEARTBEAT_ENQUEUE: options.heartbeatPath,
      SPAWN_CLOSURE_SCAN_LIMIT: "10",
      SPAWN_CLOSURE_STALE_MS: String(24 * 60 * 60 * 1000),
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  return { stdout, stderr };
}
