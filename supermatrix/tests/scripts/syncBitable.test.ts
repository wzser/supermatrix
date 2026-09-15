import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/sync-bitable.sh");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("sync-bitable.sh", () => {
  test("updates synced_at only after a verified public queue receipt using parameterized ids", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "supermatrix.sqlite");
    const queueDbPath = join(dir, "sync-queue.sqlite");
    const statusLogPath = join(dir, "status-keys.log");
    const enqueueBin = writeFakeEnqueue(dir, { writeDoneReceipt: true });
    const statusBin = writeFakeStatus(dir, { keyLogPath: statusLogPath });
    const db = makeSuperMatrixDb(dbPath);

    seedSession(db, "caller", "codexroot");
    seedSession(db, "target", "wendangwang");
    seedComm(db, {
      id: "comm-'quoted",
      status: "completed",
      resultPreview: "first result",
      createdAt: 1000,
      finishedAt: 2000,
    });
    seedComm(db, {
      id: "already-synced",
      status: "completed",
      resultPreview: "do not touch",
      createdAt: 1500,
      finishedAt: null,
      syncedAt: 9999,
    });

    const result = runSync({ dbPath, queueDbPath, enqueueBin, statusBin, chunkSize: "1" });

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(result.stdout).toMatch(/UPSERT_ENQUEUED key=codexroot\.platform\.cross-session-log:comm-'quoted:comm-'quoted:count-1:v-[a-f0-9]{16} rows=1/u);

    const synced = db.prepare("SELECT synced_at FROM cross_session_log WHERE id = ?").get("comm-'quoted") as {
      synced_at: number | null;
    };
    const untouched = db.prepare("SELECT synced_at FROM cross_session_log WHERE id = ?").get("already-synced") as {
      synced_at: number | null;
    };
    expect(synced.synced_at).toBeGreaterThanOrEqual(1);
    expect(untouched.synced_at).toBe(9999);
    expect(readFileSync(statusLogPath, "utf8").trim()).toContain("comm-'quoted");
  });

  test("uses a new source-version queue key when mutable row content changes before retry", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "supermatrix.sqlite");
    const queueDbPath = join(dir, "sync-queue.sqlite");
    const keyLogPath = join(dir, "keys.log");
    const enqueueBin = writeFakeEnqueue(dir, { keyLogPath });
    const statusBin = writeFakeStatus(dir, { mode: "pending" });
    const db = makeSuperMatrixDb(dbPath);

    seedSession(db, "caller", "codexroot");
    seedSession(db, "target", "wendangwang");
    seedComm(db, {
      id: "comm-stable",
      status: "pending",
      resultPreview: "first result",
      createdAt: 1000,
      finishedAt: null,
    });

    const first = runSync({ dbPath, queueDbPath, enqueueBin, statusBin, chunkSize: "1" });
    db.prepare("UPDATE cross_session_log SET status = ?, result_preview = ?, finished_at = ? WHERE id = ?").run(
      "completed",
      "changed result",
      3000,
      "comm-stable",
    );
    const second = runSync({ dbPath, queueDbPath, enqueueBin, statusBin, chunkSize: "1" });

    expect(first.status).toBe(1);
    expect(second.status).toBe(1);
    expect(first.stderr).toContain("queued job did not produce a verified public receipt");
    expect(second.stderr).toContain("queued job did not produce a verified public receipt");
    const keys = readFileSync(keyLogPath, "utf8").trim().split("\n");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^codexroot\.platform\.cross-session-log:comm-stable:comm-stable:count-1:v-[a-f0-9]{16}$/u);
    expect(keys[1]).toMatch(/^codexroot\.platform\.cross-session-log:comm-stable:comm-stable:count-1:v-[a-f0-9]{16}$/u);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("does not mark a stale pending snapshot synced and selects the completed row next cycle", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "supermatrix.sqlite");
    const queueDbPath = join(dir, "sync-queue.sqlite");
    const rowsLogPath = join(dir, "rows.log");
    const db = makeSuperMatrixDb(dbPath);

    seedSession(db, "caller", "codexroot");
    seedSession(db, "target", "wendangwang");
    seedComm(db, {
      id: "comm-race",
      status: "pending",
      resultPreview: "initial result",
      createdAt: 1000,
      finishedAt: null,
    });

    const enqueueBin = writeFakeEnqueue(dir, {
      writeDoneReceipt: true,
      rowsLogPath,
      mutateSource: {
        dbPath,
        id: "comm-race",
        markerPath: join(dir, "source-mutated"),
      },
    });
    const statusBin = writeFakeStatus(dir);

    const first = runSync({ dbPath, queueDbPath, enqueueBin, statusBin, chunkSize: "1" });
    const afterFirst = db.prepare("SELECT status, result_preview, finished_at, synced_at FROM cross_session_log WHERE id = ?").get("comm-race") as {
      status: string;
      result_preview: string;
      finished_at: number | null;
      synced_at: number | null;
    };
    const second = runSync({ dbPath, queueDbPath, enqueueBin, statusBin, chunkSize: "1" });
    const afterSecond = db.prepare("SELECT synced_at FROM cross_session_log WHERE id = ?").get("comm-race") as {
      synced_at: number | null;
    };
    const rows = readFileSync(rowsLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { key: string; rows: Array<Record<string, string>> });

    expect(first.status, `${first.stderr}\n${first.stdout}`).toBe(0);
    expect(afterFirst).toMatchObject({ status: "completed", result_preview: "final result", finished_at: 3000, synced_at: null });
    expect(second.status, `${second.stderr}\n${second.stdout}`).toBe(0);
    expect(afterSecond.synced_at).toBeGreaterThanOrEqual(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((entry) => entry.rows[0]?.["状态"])).toEqual(["pending", "completed"]);
    expect(rows.map((entry) => entry.rows[0]?.["结果摘要"])).toEqual(["initial result", "final result"]);
    expect(rows[1]?.key).not.toBe(rows[0]?.key);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sm-sync-bitable-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSuperMatrixDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE cross_session_log (
      id TEXT PRIMARY KEY,
      from_session_id TEXT NOT NULL,
      to_session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      child_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result_preview TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      bitable_record_id TEXT,
      synced_at INTEGER,
      final_message TEXT,
      message_run_id TEXT,
      client_request_id TEXT,
      origin_run_id TEXT
    );
  `);
  return db;
}

function seedSession(db: Database.Database, id: string, name: string): void {
  db.prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run(id, name);
}

function seedComm(
  db: Database.Database,
  input: {
    id: string;
    status: string;
    resultPreview: string;
    createdAt: number;
    finishedAt: number | null;
    syncedAt?: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO cross_session_log (
      id, from_session_id, to_session_id, kind, prompt, status,
      result_preview, created_at, finished_at, synced_at
    ) VALUES (?, 'caller', 'target', 'spawn', 'prompt', ?, ?, ?, ?, ?)
  `).run(input.id, input.status, input.resultPreview, input.createdAt, input.finishedAt, input.syncedAt ?? null);
}

function writeFakeEnqueue(
  dir: string,
  options: {
    writeDoneReceipt?: boolean;
    keyLogPath?: string;
    rowsLogPath?: string;
    mutateSource?: { dbPath: string; id: string; markerPath: string };
  },
): string {
  const file = join(dir, "fake-feishu-sync-enqueue.mjs");
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { createRequire } from "node:module";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const require = createRequire(${JSON.stringify(resolve(REPO_ROOT, "package.json"))});
const Database = require("better-sqlite3");
const args = process.argv.slice(2);
const valueAfter = (name) => args[args.indexOf(name) + 1];
const key = valueAfter("--key");
const dbPath = valueAfter("--db");
${options.keyLogPath ? `appendFileSync(${JSON.stringify(options.keyLogPath)}, key + "\\n");` : ""}
${options.rowsLogPath ? `appendFileSync(${JSON.stringify(options.rowsLogPath)}, JSON.stringify({ key, rows: JSON.parse(readFileSync(valueAfter("--rows"), "utf8")) }) + "\\n");` : ""}
${options.mutateSource ? `
if (!existsSync(${JSON.stringify(options.mutateSource.markerPath)})) {
  const sourceDb = new Database(${JSON.stringify(options.mutateSource.dbPath)});
  sourceDb.prepare("UPDATE cross_session_log SET status = 'completed', result_preview = 'final result', finished_at = 3000 WHERE id = ?").run(${JSON.stringify(options.mutateSource.id)});
  sourceDb.close();
  writeFileSync(${JSON.stringify(options.mutateSource.markerPath)}, "mutated\\n");
}
` : ""}
${options.writeDoneReceipt ? `
const db = new Database(dbPath);
db.exec("CREATE TABLE IF NOT EXISTS sync_jobs (dedupe_key TEXT PRIMARY KEY, status TEXT NOT NULL, receipt_ref TEXT)");
db.prepare("INSERT OR REPLACE INTO sync_jobs (dedupe_key, status, receipt_ref) VALUES (?, 'done', 'receipt-for-test')").run(key);
db.close();
` : ""}
process.stdout.write(JSON.stringify({ ok: true, accepted: true, status: "accepted", key }) + "\\n");
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function writeFakeStatus(
  dir: string,
  options: { keyLogPath?: string; mode?: "verified" | "pending" } = {},
): string {
  const file = join(dir, "fake-feishu-sync-status.mjs");
  const verified = options.mode !== "pending";
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const key = args[args.indexOf("--key") + 1];
${options.keyLogPath ? `appendFileSync(${JSON.stringify(options.keyLogPath)}, key + "\\n");` : ""}
process.stdout.write(JSON.stringify({
  ok: true,
  found: 1,
  terminal: ${verified},
  job_states: { ${verified ? "done: 1" : "pending: 1"} },
  jobs: [{
    dedupe_key: key,
    status: ${JSON.stringify(verified ? "done" : "pending")},
    terminal: ${verified},
    receipt_ref: ${JSON.stringify(verified ? "receipts/test.ndjson" : "")},
    receipt_id: ${JSON.stringify(verified ? "receipt-for-test" : "")},
    read_back_verified: ${verified},
    receipt_job_verified: ${verified},
  }],
}) + "\\n");
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function runSync(input: {
  dbPath: string;
  queueDbPath: string;
  enqueueBin: string;
  statusBin: string;
  chunkSize: string;
}): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SM_DB_PATH: input.dbPath,
      SM_FEISHU_SYNC_QUEUE_DB: input.queueDbPath,
      SM_FEISHU_SYNC_ENQUEUE_BIN: input.enqueueBin,
      SM_FEISHU_SYNC_STATUS_BIN: input.statusBin,
      SM_BITABLE_CHUNK_SIZE: input.chunkSize,
    },
    encoding: "utf8",
  });
}
