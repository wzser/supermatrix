import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createClaudeStreamState,
  parseClaudeStream,
} from "../../../src/adapters/backend-claude/streamParser.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "samples");

async function load(name: string): Promise<string[]> {
  const text = await readFile(join(SAMPLES, name), "utf8");
  return text.split(/\r?\n/u).filter((l) => l.trim().length > 0);
}

describe("parseClaudeStream", () => {
  test("init.jsonl yields a started event and a final completed event", async () => {
    const events = parseClaudeStream(await load("init.jsonl"));
    expect(events[0]?.kind).toBe("started");
    const last = events.at(-1);
    expect(last?.kind === "completed" || last?.kind === "assistant_message").toBe(true);
  });

  test("emits exactly one started event even when every line has session_id", async () => {
    // Real claude CLI stream-json has session_id on every line (system/init,
    // assistant, user, result). Our parser must not re-announce `started`
    // per line OR per chunk.
    const events = parseClaudeStream(await load("normal.jsonl"));
    const started = events.filter((e) => e.kind === "started");
    expect(started).toHaveLength(1);
  });

  test("shared state across parseClaudeStream calls dedupes started", async () => {
    // Simulate stdout arriving in two chunks — the second chunk would
    // normally reset sessionAnnounced if state were per-call.
    const allLines = await load("long_task.jsonl");
    const firstHalf = allLines.slice(0, 2);
    const secondHalf = allLines.slice(2);
    const state = createClaudeStreamState();
    const e1 = parseClaudeStream(firstHalf, state);
    const e2 = parseClaudeStream(secondHalf, state);
    const startedCount = [...e1, ...e2].filter((e) => e.kind === "started").length;
    expect(startedCount).toBe(1);
  });

  test("normal.jsonl ends in completed with a non-empty finalMessage", async () => {
    const events = parseClaudeStream(await load("normal.jsonl"));
    const completed = events.find((e) => e.kind === "completed");
    expect(completed).toBeTruthy();
    if (completed && completed.kind === "completed") {
      expect(completed.finalMessage.trim().length).toBeGreaterThan(0);
    }
  });

  test("tool_call.jsonl contains at least one tool_call event", async () => {
    const events = parseClaudeStream(await load("tool_call.jsonl"));
    expect(events.some((e) => e.kind === "tool_call")).toBe(true);
  });

  test("error.jsonl yields an error event", async () => {
    const events = parseClaudeStream(await load("error.jsonl"));
    expect(events.some((e) => e.kind === "error")).toBe(true);
  });

  test("malformed lines are skipped without throwing", () => {
    const events = parseClaudeStream(["not json", '{"type":"unknown"}']);
    expect(events).toEqual([]);
  });

  test("emits usage event when result carries a usage record", () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sid","model":"claude-opus-4-7"}',
      '{"type":"result","subtype":"success","session_id":"sid","result":"ok","usage":{"input_tokens":120,"output_tokens":40,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}}',
    ];
    const events = parseClaudeStream(lines);
    const usage = events.find((e) => e.kind === "usage");
    expect(usage).toBeTruthy();
    if (usage && usage.kind === "usage") {
      expect(usage.inputTokens).toBe(120);
      expect(usage.outputTokens).toBe(40);
      expect(usage.cacheReadTokens).toBe(80);
      expect(usage.cacheWriteTokens).toBe(10);
      expect(usage.reasoningTokens).toBe(0);
      expect(usage.model).toBe("claude-opus-4-7");
    }
  });

  test("does not emit usage event when result has no usage record or all zeros", () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sid","model":"claude-opus-4-7"}',
      '{"type":"result","subtype":"success","session_id":"sid","result":"ok"}',
    ];
    const events = parseClaudeStream(lines);
    expect(events.some((e) => e.kind === "usage")).toBe(false);
  });

  test("emits per-turn usage from assistant records and skips result usage to avoid double-count", () => {
    // Real Claude stream-json carries `message.usage` on every assistant
    // envelope (cumulative for that LLM call) and the terminal `result`
    // carries the run-total. The replier accumulator sums usage events,
    // so emitting both would double the totals. We want: one usage event
    // per assistant turn (for live card-title updates), none at result.
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sid","model":"claude-opus-4-7"}',
      '{"type":"assistant","session_id":"sid","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"one"}],"usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":5}}}',
      '{"type":"assistant","session_id":"sid","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"two"}],"usage":{"input_tokens":200,"output_tokens":20,"cache_read_input_tokens":150,"cache_creation_input_tokens":0}}}',
      '{"type":"result","subtype":"success","session_id":"sid","result":"two","usage":{"input_tokens":300,"output_tokens":30,"cache_read_input_tokens":200,"cache_creation_input_tokens":5}}',
    ];
    const events = parseClaudeStream(lines);
    const usageEvents = events.filter((e) => e.kind === "usage");
    expect(usageEvents).toHaveLength(2);
    if (usageEvents[0].kind === "usage") {
      expect(usageEvents[0].inputTokens).toBe(100);
      expect(usageEvents[0].cacheReadTokens).toBe(50);
      expect(usageEvents[0].cacheWriteTokens).toBe(5);
      expect(usageEvents[0].model).toBe("claude-opus-4-7");
    }
    if (usageEvents[1].kind === "usage") {
      expect(usageEvents[1].inputTokens).toBe(200);
      expect(usageEvents[1].cacheReadTokens).toBe(150);
      expect(usageEvents[1].cacheWriteTokens).toBe(0);
    }
  });

  test("falls back to result.usage when no assistant-turn usage was emitted (legacy fixture shape)", () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"sid","model":"claude-opus-4-7"}',
      '{"type":"assistant","session_id":"sid","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","session_id":"sid","result":"hi","usage":{"input_tokens":12,"output_tokens":4,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}',
    ];
    const events = parseClaudeStream(lines);
    const usageEvents = events.filter((e) => e.kind === "usage");
    expect(usageEvents).toHaveLength(1);
    if (usageEvents[0].kind === "usage") {
      expect(usageEvents[0].inputTokens).toBe(12);
    }
  });
});
