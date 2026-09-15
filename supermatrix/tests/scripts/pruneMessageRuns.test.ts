import DatabaseConstructor from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { classifyCanonicalHistory, runPrune, writePruneReceipt } from "../../scripts/prune-message-runs.ts";

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
  test("canonical classifier keeps backend-session-only history ambiguous", () => {
    const root = tempRoot();
    const dbPath = join(root, "supermatrix.db");
    const stateDbPath = join(root, "state_5.sqlite");
    const outputDir = join(root, "reports");
    const db = new DatabaseConstructor(dbPath);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, backend TEXT NOT NULL, backend_session_id TEXT);
      CREATE TABLE message_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT, final_message TEXT,
        stream_log TEXT, started_at INTEGER NOT NULL, status TEXT NOT NULL
      );
    `);
    const stateDb = new DatabaseConstructor(stateDbPath);
    stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    for (let i = 0; i < 3; i += 1) {
      const sessionId = `s${i}`;
      const backendSessionId = `thread${i}`;
      const turnId = `turn${i}`;
      const prompt = `prompt${i}`;
      const finalMessage = `final${i}`;
      const rolloutPath = join(root, `rollout${i}.jsonl`);
      writeFileSync(rolloutPath, [
        JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } }),
        JSON.stringify({ type: "response_item", payload: {
          type: "message", role: "user", content: [{ type: "input_text", text: prompt }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        } }),
        JSON.stringify({ type: "event_msg", payload: {
          type: "task_complete", turn_id: turnId, last_agent_message: finalMessage,
        } }),
      ].join("\n") + "\n");
      db.prepare("INSERT INTO sessions VALUES (?, 'codex', ?)").run(sessionId, backendSessionId);
      db.prepare("INSERT INTO message_runs VALUES (?, ?, ?, ?, NULL, ?, 'completed')")
        .run(`mr${i}`, sessionId, prompt, finalMessage, NOW_MS + i);
      stateDb.prepare("INSERT INTO threads VALUES (?, ?)").run(backendSessionId, rolloutPath);
    }
    db.close();
    stateDb.close();

    const summary = classifyCanonicalHistory({
      dbPath, stateDbPath, outputDir, nowMs: NOW_MS, samplePerBand: 1,
    });

    expect(summary.classification).toEqual({ exact_reconstructible: 0, ambiguous: 3, unique_db_state: 0 });
    expect(summary.reconstructionSampleTotal).toBe(3);
    expect(summary.reconstructionHashMatches).toBe(3);
    expect(summary.productionRowsModified).toBe(0);
    const report = JSON.parse(readFileSync(summary.classificationReport, "utf8")) as {
      entries: Array<{ classification: string; reason: string }>;
    };
    expect(report.entries.every((row) => row.classification === "ambiguous")).toBe(true);
    expect(report.entries.every((row) => row.reason.includes("backend_session_id_only"))).toBe(true);
  });

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
