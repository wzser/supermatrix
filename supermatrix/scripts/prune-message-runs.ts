#!/usr/bin/env tsx
// Prunes message_runs.stream_log payloads past a retention window so the live
// supermatrix.db stops growing unbounded (stream logs are debugging aids with
// no long-term value; prompt/final_message stay untouched for traceability).
// Freed pages go to the SQLite freelist and get reused by new runs; the file
// only shrinks under an explicit --vacuum, which takes an exclusive lock and
// must only run in a low-traffic window.
import DatabaseConstructor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_BUSY_TIMEOUT_MS = 60_000;

export type PruneSummary = {
  mode: "dry-run" | "apply";
  dbPath: string;
  retentionDays: number;
  cutoffMs: number;
  candidateRows: number;
  candidateStreamBytes: number;
  prunedRows: number;
  walCheckpoint?: string;
  vacuum?: { requested: boolean; ran: boolean; error?: string };
  dbFileBytesBefore: number;
  dbFileBytesAfter: number;
};

type CliOptions = {
  apply: boolean;
  json: boolean;
  vacuum: boolean;
  retentionDays: number;
  dbPath: string;
  receiptDir: string;
  nowMs: number;
};

function defaultDbPath(env: Record<string, string | undefined>): string {
  const runtimeRoot = env.SM_RUNTIME_ROOT?.trim() || "/Users/LOCAL_USER/SuperMatrixRuntime";
  return join(runtimeRoot, "data", "supermatrix.db");
}

function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions {
  let apply = false;
  let json = false;
  let vacuum = false;
  let retentionDays = DEFAULT_RETENTION_DAYS;
  let dbPath = defaultDbPath(env);
  let receiptDir = env.SM_PRUNE_MESSAGE_RUNS_RECEIPT_DIR ?? "/Users/LOCAL_USER/SuperMatrixRuntime/data/prune-message-runs";
  let nowMs = Date.now();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--vacuum") {
      vacuum = true;
    } else if (arg === "--retention-days") {
      const next = argv[i + 1];
      if (!next) throw new Error("--retention-days requires a number");
      retentionDays = Number(next);
      if (!Number.isFinite(retentionDays) || retentionDays < 1) throw new Error("--retention-days must be >= 1");
      i += 1;
    } else if (arg === "--db") {
      const next = argv[i + 1];
      if (!next) throw new Error("--db requires a path");
      dbPath = resolve(next);
      i += 1;
    } else if (arg === "--receipt-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--receipt-dir requires a path");
      receiptDir = resolve(next);
      i += 1;
    } else if (arg === "--now-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error("--now-ms requires a timestamp");
      nowMs = Number(next);
      if (!Number.isFinite(nowMs)) throw new Error("--now-ms must be numeric");
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (vacuum && !apply) throw new Error("--vacuum requires --apply (it takes an exclusive lock on the live db)");
  return { apply, json, vacuum, retentionDays, dbPath, receiptDir, nowMs };
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function runPrune(options: {
  dbPath: string;
  apply: boolean;
  vacuum: boolean;
  retentionDays: number;
  nowMs: number;
  busyTimeoutMs?: number;
}): PruneSummary {
  if (!existsSync(options.dbPath)) throw new Error(`db not found: ${options.dbPath}`);
  const cutoffMs = options.nowMs - options.retentionDays * DAY_MS;
  const summary: PruneSummary = {
    mode: options.apply ? "apply" : "dry-run",
    dbPath: options.dbPath,
    retentionDays: options.retentionDays,
    cutoffMs,
    candidateRows: 0,
    candidateStreamBytes: 0,
    prunedRows: 0,
    dbFileBytesBefore: fileBytes(options.dbPath),
    dbFileBytesAfter: 0,
  };

  const db: Database = new DatabaseConstructor(options.dbPath, { readonly: !options.apply });
  try {
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(stream_log)), 0) AS bytes FROM message_runs WHERE started_at < ? AND stream_log IS NOT NULL",
      )
      .get(cutoffMs) as { n: number; bytes: number };
    summary.candidateRows = row.n;
    summary.candidateStreamBytes = row.bytes;

    if (options.apply && row.n > 0) {
      const result = db
        .prepare("UPDATE message_runs SET stream_log = NULL WHERE started_at < ? AND stream_log IS NOT NULL")
        .run(cutoffMs);
      summary.prunedRows = result.changes;
      try {
        const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as unknown;
        summary.walCheckpoint = JSON.stringify(checkpoint);
      } catch (err) {
        summary.walCheckpoint = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (options.vacuum) {
      summary.vacuum = { requested: true, ran: false };
      try {
        db.exec("VACUUM");
        summary.vacuum.ran = true;
      } catch (err) {
        summary.vacuum.error = err instanceof Error ? err.message : String(err);
      }
    }
  } finally {
    db.close();
  }

  summary.dbFileBytesAfter = fileBytes(options.dbPath);
  return summary;
}

export function writePruneReceipt(summary: PruneSummary, receiptDir: string, nowMs: number): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
  const receiptPath = join(receiptDir, `${stamp}-${summary.mode}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return receiptPath;
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2), process.env);
  const summary = runPrune(options);
  const receiptPath = writePruneReceipt(summary, options.receiptDir, options.nowMs);
  if (options.json) {
    console.log(JSON.stringify({ ...summary, receiptPath }, null, 2));
    return;
  }
  console.log(`[prune-message-runs] mode=${summary.mode} db=${summary.dbPath}`);
  console.log(
    `[prune-message-runs] candidates=${summary.candidateRows} streamBytes=${formatMiB(summary.candidateStreamBytes)} pruned=${summary.prunedRows}`,
  );
  if (summary.vacuum) {
    console.log(`[prune-message-runs] vacuum ran=${summary.vacuum.ran}${summary.vacuum.error ? ` error=${summary.vacuum.error}` : ""}`);
  }
  console.log(
    `[prune-message-runs] dbFile ${formatMiB(summary.dbFileBytesBefore)} -> ${formatMiB(summary.dbFileBytesAfter)} receipt=${receiptPath}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
