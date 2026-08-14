import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_REDACTION_MARKER_PREFIX } from "../../src/scripts/secret-redaction.js";
import { redactChatSecretsDatabase } from "../../src/scripts/redact-chat-secrets.js";

const OPENAI_KEY = "sk-proj-TEST_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const ANTHROPIC_KEY = "sk-ant-api03-TEST_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
const GENERIC_KEY = "hf_TEST_abCDef1234567890abcdef1234567890";

describe("redact chat secrets database script", () => {
  let dir: string;
  let dbPath: string;
  let reportDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-secret-redaction-"));
    dbPath = join(dir, "supermatrix.db");
    reportDir = join(dir, "reports");

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE message_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        card_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL,
        final_message TEXT,
        error_message TEXT,
        stream_log TEXT,
        sender_id TEXT
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
        final_message TEXT,
        message_run_id TEXT
      );
    `);
    db.prepare(`
      INSERT INTO message_runs
        (id, session_id, group_id, prompt, started_at, status, final_message, stream_log)
      VALUES
        ('mr_one', 'sess_one', 'oc_one', ?, 1, 'done', ?, ?),
        ('mr_two', 'sess_one', 'oc_one', 'keep mr_a719e551 and oc_REDACTEDCHATID', 2, 'done', NULL, NULL)
    `).run(
      `please use OPENAI_API_KEY=${OPENAI_KEY}`,
      `assistant mentions ${ANTHROPIC_KEY}`,
      JSON.stringify([{ kind: "assistant_message", text: `api_key: ${GENERIC_KEY}` }]),
    );
    db.prepare(`
      INSERT INTO cross_session_log
        (id, from_session_id, to_session_id, kind, prompt, status, result_preview, created_at, final_message)
      VALUES
        ('csl_one', 'sess_a', 'sess_b', 'spawn', ?, 'done', 'clean preview', 1, 'clean final')
    `).run(`child prompt ${OPENAI_KEY}`);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry-runs without mutating chat tables or leaking raw secrets into reports", async () => {
    const summary = await redactChatSecretsDatabase({
      dbPath,
      reportDir,
      apply: false,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(summary.mode).toBe("dry-run");
    expect(summary.secretsFound).toBe(4);
    expect(summary.rowsChanged).toBe(2);
    expect(summary.fieldsChanged).toBe(4);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT prompt, final_message, stream_log FROM message_runs WHERE id = 'mr_one'").get() as {
      prompt: string;
      final_message: string;
      stream_log: string;
    };
    db.close();

    expect(row.prompt).toContain(OPENAI_KEY);
    expect(row.final_message).toContain(ANTHROPIC_KEY);
    expect(row.stream_log).toContain(GENERIC_KEY);
    expect(existsSync(summary.reportPath)).toBe(true);
    const report = readFileSync(summary.reportPath, "utf-8");
    expect(report).not.toContain(OPENAI_KEY);
    expect(report).not.toContain(ANTHROPIC_KEY);
    expect(report).not.toContain(GENERIC_KEY);
  });

  it("applies targeted redactions while preserving rows and non-secret identifiers", async () => {
    const summary = await redactChatSecretsDatabase({
      dbPath,
      reportDir,
      apply: true,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(summary.mode).toBe("apply");
    expect(summary.secretsFound).toBe(4);
    expect(summary.rowsChanged).toBe(2);
    expect(summary.fieldsChanged).toBe(4);

    const db = new Database(dbPath, { readonly: true });
    const messageRows = db.prepare("SELECT id, prompt, final_message, stream_log FROM message_runs ORDER BY id").all() as Array<{
      id: string;
      prompt: string;
      final_message: string | null;
      stream_log: string | null;
    }>;
    const crossRow = db.prepare("SELECT prompt FROM cross_session_log WHERE id = 'csl_one'").get() as { prompt: string };
    db.close();

    expect(messageRows).toHaveLength(2);
    expect(messageRows[0]?.prompt).toContain(SECRET_REDACTION_MARKER_PREFIX);
    expect(messageRows[0]?.prompt).not.toContain(OPENAI_KEY);
    expect(messageRows[0]?.final_message).not.toContain(ANTHROPIC_KEY);
    expect(messageRows[0]?.stream_log).not.toContain(GENERIC_KEY);
    expect(messageRows[1]?.prompt).toContain("mr_a719e551");
    expect(messageRows[1]?.prompt).toContain("oc_REDACTEDCHATID");
    expect(crossRow.prompt).toContain(SECRET_REDACTION_MARKER_PREFIX);
    expect(crossRow.prompt).not.toContain(OPENAI_KEY);
  });
});
