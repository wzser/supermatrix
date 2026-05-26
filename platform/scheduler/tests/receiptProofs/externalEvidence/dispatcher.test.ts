import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExternalEvidence } from "../../../src/receiptProofs/externalEvidence/index.js";

describe("evaluateExternalEvidence dispatcher", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-dispatch-"));
    dbPath = join(dir, "d.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (n INT); INSERT INTO t (n) VALUES (7);");
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dispatches sqlite engine", async () => {
    const r = await evaluateExternalEvidence({
      proof: { kind: "external_evidence", engine: "sqlite", target: { db: dbPath, sql: "SELECT COUNT(*) FROM t" }, expectation: ">= 1" },
      ctx: { taskId: "t", runId: "r", triggeredAt: 0 },
    });
    expect(r.passed).toBe(true);
  });

  it("passes sqlite with exit_zero fallback when target is unconfigured and exitCode=0", async () => {
    const r = await evaluateExternalEvidence({
      proof: { kind: "external_evidence", engine: "sqlite", target: {}, expectation: ">= 1" },
      ctx: { taskId: "t", runId: "r", triggeredAt: 0, exitCode: 0 },
    });
    expect(r.passed).toBe(true);
    expect(r.evidence).toMatchObject({ exitCode: 0, note: expect.stringContaining("exit_zero fallback") });
  });

  it("fails sqlite with unconfigured target when exitCode is non-zero", async () => {
    const r = await evaluateExternalEvidence({
      proof: { kind: "external_evidence", engine: "sqlite", target: {}, expectation: ">= 1" },
      ctx: { taskId: "t", runId: "r", triggeredAt: 0, exitCode: 1 },
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note", "sqlite engine requires target.db + target.sql");
  });

  it("returns stub for bitable engine", async () => {
    const r = await evaluateExternalEvidence({
      proof: { kind: "external_evidence", engine: "bitable", target: { base: "b", table: "t" }, expectation: ">= 1" },
      ctx: { taskId: "t", runId: "r", triggeredAt: 0 },
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });
});
