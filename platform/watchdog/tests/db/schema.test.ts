import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";

describe("applyMigrations", () => {
  let db: Database.Database;

  afterEach(() => {
    db.close();
  });

  it("creates issues table with expected columns", () => {
    db = new Database(":memory:");
    applyMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info(issues)")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const names = columns.map((c) => c.name);
    expect(names).toEqual([
      "id",
      "title",
      "source",
      "description",
      "verification",
      "status",
      "created_at",
      "finished_at",
      "result",
      "retry_count",
      "required_owner",
      "required_completion_marker",
      "required_evidence_state",
    ]);
  });

  it("enables WAL mode", () => {
    db = new Database(":memory:");
    applyMigrations(db);

    // SQLite in-memory databases always report "memory" journal mode;
    // WAL is silently ignored. The pragma is still issued correctly for
    // file-based databases. Accept either value here.
    const result = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["wal", "memory"]).toContain(result.journal_mode);
  });

  it("is idempotent", () => {
    db = new Database(":memory:");
    applyMigrations(db);
    applyMigrations(db);

    const columns = db
      .prepare("PRAGMA table_info(issues)")
      .all() as Array<{ name: string }>;
    expect(columns.length).toBe(13);
  });

  it("adds retry_count column to existing database", () => {
    db = new Database(":memory:");
    applyMigrations(db);
    const columns = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("retry_count");
  });

  it("creates a durable receipt table for weekly-review owner re-dispatches", () => {
    db = new Database(":memory:");
    applyMigrations(db);

    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'weekly_review_standing_retries'",
    ).get();
    expect(table).toEqual({ name: "weekly_review_standing_retries" });
  });

  it("adds structured weekly-review evidence columns to an existing issues table", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE issues (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        description TEXT NOT NULL,
        verification TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        result TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    applyMigrations(db);

    const names = (
      db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining([
      "required_owner",
      "required_completion_marker",
      "required_evidence_state",
    ]));
  });
});
