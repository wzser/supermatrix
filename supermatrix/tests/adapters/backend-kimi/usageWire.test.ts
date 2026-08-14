// tests/adapters/backend-kimi/usageWire.test.ts
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createKimiUsageTracker } from "../../../src/adapters/backend-kimi/usageWire.ts";

function mkKimiHome(): string {
  return mkdtempSync(join(tmpdir(), "kimi-usage-wire-"));
}

function addSession(home: string, sessionId: string, agents: string[]): string {
  const sessionDir = join(home, "sessions", `wd_test_deadbeefcafe`, sessionId);
  for (const agent of agents) {
    mkdirSync(join(sessionDir, "agents", agent), { recursive: true });
  }
  appendFileSync(
    join(home, "session_index.jsonl"),
    JSON.stringify({ sessionId, sessionDir, workDir: "/tmp" }) + "\n",
  );
  return sessionDir;
}

function wireOf(sessionDir: string, agent: string): string {
  return join(sessionDir, "agents", agent, "wire.jsonl");
}

function usageRecord(input: number, output: number, cacheRead = 0, cacheWrite = 0): string {
  return JSON.stringify({
    type: "usage.record",
    model: "kimi-code/k3",
    usage: {
      inputOther: input,
      output,
      inputCacheRead: cacheRead,
      inputCacheCreation: cacheWrite,
    },
    usageScope: "turn",
    time: 1784362877075,
  });
}

describe("createKimiUsageTracker", () => {
  test("collects only records appended after beginTurn, summed across fields", async () => {
    const home = mkKimiHome();
    const dir = addSession(home, "session_a", ["main"]);
    writeFileSync(wireOf(dir, "main"), usageRecord(100, 10) + "\n");

    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_a");
    // History must not be attributed to this turn.
    expect(await tracker.collectTurnUsage("session_a")).toBeNull();

    appendFileSync(wireOf(dir, "main"), usageRecord(200, 20, 1000, 50) + "\n");
    appendFileSync(wireOf(dir, "main"), usageRecord(300, 30, 2000, 0) + "\n");
    const usage = await tracker.collectTurnUsage("session_a");
    expect(usage).toMatchObject({
      model: "kimi-code/k3",
      inputTokens: 500,
      outputTokens: 50,
      cacheReadTokens: 3000,
      cacheWriteTokens: 50,
      recordCount: 2,
    });
    // Second collect with nothing new → null (no double counting).
    expect(await tracker.collectTurnUsage("session_a")).toBeNull();
  });

  test("aggregates records across main and sub-agent wire logs", async () => {
    const home = mkKimiHome();
    const dir = addSession(home, "session_b", ["main", "sub-1"]);
    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_b");

    appendFileSync(wireOf(dir, "main"), usageRecord(100, 10) + "\n");
    appendFileSync(wireOf(dir, "sub-1"), usageRecord(400, 40) + "\n");
    const usage = await tracker.collectTurnUsage("session_b");
    expect(usage).toMatchObject({ inputTokens: 500, outputTokens: 50, recordCount: 2 });
  });

  test("a wire file created mid-turn (new sub-agent) is picked up with offset 0", async () => {
    const home = mkKimiHome();
    const dir = addSession(home, "session_c", ["main"]);
    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_c");

    mkdirSync(join(dir, "agents", "sub-2"), { recursive: true });
    writeFileSync(wireOf(dir, "sub-2"), usageRecord(700, 70) + "\n");
    const usage = await tracker.collectTurnUsage("session_c");
    expect(usage).toMatchObject({ inputTokens: 700, outputTokens: 70, recordCount: 1 });
  });

  test("a trailing partial line is left for the next collect", async () => {
    const home = mkKimiHome();
    const dir = addSession(home, "session_d", ["main"]);
    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_d");

    const full = usageRecord(100, 10);
    writeFileSync(wireOf(dir, "main"), full + "\n" + usageRecord(999, 99).slice(0, 20));
    expect(await tracker.collectTurnUsage("session_d")).toMatchObject({
      inputTokens: 100,
      recordCount: 1,
    });
    // Complete the partial line — it becomes visible now.
    appendFileSync(wireOf(dir, "main"), usageRecord(999, 99).slice(20) + "\n");
    expect(await tracker.collectTurnUsage("session_d")).toMatchObject({
      inputTokens: 999,
      recordCount: 1,
    });
  });

  test("unknown session (no index entry) yields null, never throws", async () => {
    const home = mkKimiHome();
    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_missing");
    expect(await tracker.collectTurnUsage("session_missing")).toBeNull();
  });

  test("non-usage lines and malformed JSON are ignored", async () => {
    const home = mkKimiHome();
    const dir = addSession(home, "session_e", ["main"]);
    const tracker = createKimiUsageTracker({ kimiHome: home });
    await tracker.beginTurn("session_e");

    appendFileSync(
      wireOf(dir, "main"),
      JSON.stringify({ type: "llm.request", foo: 1 }) + "\n" +
        "{not json\n" +
        usageRecord(50, 5) + "\n",
    );
    expect(await tracker.collectTurnUsage("session_e")).toMatchObject({
      inputTokens: 50,
      recordCount: 1,
    });
  });
});
