import DatabaseConstructor from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runPrune, writePruneReceipt } from "../../scripts/prune-message-runs.ts";

const NOW_MS = new Date("2026-07-03T12:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "prune-message-runs-test-"));
  tempDirs.push(dir);
  return dir;
}

function createDb(path: string): void {
  const db = new DatabaseConstructor(path);
  db.exec(`
    CREATE TABLE message_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      final_message TEXT,
      stream_log TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO message_runs (id, session_id, group_id, prompt, started_at, status, final_message, stream_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("old-with-log", "s1", "g1", "old prompt", NOW_MS - 30 * DAY_MS, "succeeded", "old final", "x".repeat(1000));
  insert.run("old-no-log", "s1", "g1", "old prompt 2", NOW_MS - 30 * DAY_MS, "succeeded", "old final 2", null);
  insert.run("new-with-log", "s1", "g1", "new prompt", NOW_MS - 1 * DAY_MS, "succeeded", "new final", "y".repeat(500));
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("prune-message-runs", () => {
  test("dry-run counts stale stream_log rows without modifying them", () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    createDb(dbPath);

    const summary = runPrune({ dbPath, apply: false, vacuum: false, retentionDays: 14, nowMs: NOW_MS });

    expect(summary.mode).toBe("dry-run");
    expect(summary.candidateRows).toBe(1);
    expect(summary.candidateStreamBytes).toBe(1000);
    expect(summary.prunedRows).toBe(0);

    const db = new DatabaseConstructor(dbPath, { readonly: true });
    const row = db.prepare("SELECT stream_log FROM message_runs WHERE id = 'old-with-log'").get() as { stream_log: string | null };
    db.close();
    expect(row.stream_log).toHaveLength(1000);
  });

  test("apply nulls only stale stream_log and preserves prompt/final_message", () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    createDb(dbPath);

    const summary = runPrune({ dbPath, apply: true, vacuum: false, retentionDays: 14, nowMs: NOW_MS });

    expect(summary.prunedRows).toBe(1);

    const db = new DatabaseConstructor(dbPath, { readonly: true });
    const oldRow = db.prepare("SELECT prompt, final_message, stream_log FROM message_runs WHERE id = 'old-with-log'").get() as {
      prompt: string;
      final_message: string;
      stream_log: string | null;
    };
    const newRow = db.prepare("SELECT stream_log FROM message_runs WHERE id = 'new-with-log'").get() as { stream_log: string | null };
    db.close();

    expect(oldRow.stream_log).toBeNull();
    expect(oldRow.prompt).toBe("old prompt");
    expect(oldRow.final_message).toBe("old final");
    expect(newRow.stream_log).toHaveLength(500);
  });

  test("apply with vacuum runs vacuum and reports it", () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    createDb(dbPath);

    const summary = runPrune({ dbPath, apply: true, vacuum: true, retentionDays: 14, nowMs: NOW_MS });

    expect(summary.vacuum).toMatchObject({ requested: true, ran: true });
    expect(summary.dbFileBytesAfter).toBeGreaterThan(0);
  });

  test("missing db throws instead of silently succeeding", () => {
    const root = tempRoot();
    expect(() => runPrune({ dbPath: join(root, "nope.db"), apply: false, vacuum: false, retentionDays: 14, nowMs: NOW_MS })).toThrow(
      /db not found/u,
    );
  });

  test("writePruneReceipt persists the summary", () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    createDb(dbPath);
    const summary = runPrune({ dbPath, apply: false, vacuum: false, retentionDays: 14, nowMs: NOW_MS });

    const receiptPath = writePruneReceipt(summary, join(root, "receipts"), NOW_MS);

    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { mode: string; candidateRows: number };
    expect(receipt).toMatchObject({ mode: "dry-run", candidateRows: 1 });
  });
});
