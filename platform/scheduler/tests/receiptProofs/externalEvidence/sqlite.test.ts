import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateSqlite } from "../../../src/receiptProofs/externalEvidence/sqlite.js";

describe("evaluateSqlite", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-sqlite-"));
    dbPath = join(dir, "test.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE rows (v INTEGER); INSERT INTO rows (v) VALUES (10), (20), (30);");
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when count query satisfies >= 1", async () => {
    const r = await evaluateSqlite({
      target: { db: dbPath, sql: "SELECT COUNT(*) FROM rows" },
      expectation: ">= 1",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(true);
    expect(r.evidence).toMatchObject({ value: 3 });
  });

  it("fails when count query < threshold", async () => {
    const r = await evaluateSqlite({
      target: { db: dbPath, sql: "SELECT COUNT(*) FROM rows WHERE v > 999" },
      expectation: ">= 1",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
  });

  it("returns evidence.error on bad SQL", async () => {
    const r = await evaluateSqlite({
      target: { db: dbPath, sql: "NOT A QUERY" },
      expectation: ">= 1",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
    expect(r.evidence).toHaveProperty("error");
  });

  it("returns evidence.error on missing db file", async () => {
    const r = await evaluateSqlite({
      target: { db: "/nonexistent/path.db", sql: "SELECT 1" },
      expectation: ">= 1",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("error");
  });

  it("rejects mtime>trigger expectation for sqlite engine", async () => {
    const r = await evaluateSqlite({
      target: { db: dbPath, sql: "SELECT 1" },
      expectation: "mtime > trigger",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });
});
