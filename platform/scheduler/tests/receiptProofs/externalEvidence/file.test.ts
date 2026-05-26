import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFile } from "../../../src/receiptProofs/externalEvidence/file.js";

describe("evaluateFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scheduler-file-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes when mtime > trigger", async () => {
    const file = join(dir, "a.json");
    writeFileSync(file, "{}");
    utimesSync(file, new Date(5000), new Date(5000));
    const r = await evaluateFile({
      target: { path: file },
      expectation: "mtime > trigger",
      triggeredAt: 1000,
    });
    expect(r.passed).toBe(true);
  });

  it("fails when mtime <= trigger", async () => {
    const file = join(dir, "b.json");
    writeFileSync(file, "{}");
    utimesSync(file, new Date(1), new Date(1));
    const r = await evaluateFile({
      target: { path: file },
      expectation: "mtime > trigger",
      triggeredAt: 10_000_000_000,
    });
    expect(r.passed).toBe(false);
  });

  it("fails when file missing", async () => {
    const r = await evaluateFile({
      target: { path: join(dir, "missing.json") },
      expectation: "mtime > trigger",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });

  it("supports numeric expectation as file size in bytes", async () => {
    const file = join(dir, "c.txt");
    writeFileSync(file, "hello world");
    const r = await evaluateFile({
      target: { path: file },
      expectation: ">= 1",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(true);
    expect(r.evidence).toMatchObject({ sizeBytes: 11 });
  });

  it("returns non-retriable for bad target shape", async () => {
    const r = await evaluateFile({
      target: {},
      expectation: "mtime > trigger",
      triggeredAt: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
  });
});
