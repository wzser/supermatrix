// tests/app/kimiAutonomousTurnStream.test.ts
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  isWireNotificationPrompt,
  peekTurnId,
  streamAutonomousTurn,
  translateWireLine,
} from "../../src/app/kimiAutonomousTurnStream.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";

const loop = (event: unknown) => JSON.stringify({ type: "context.append_loop_event", event });
const THINK = loop({ type: "content.part", turnId: "2", part: { type: "think", think: "想一下" } });
const TEXT = loop({ type: "content.part", turnId: "2", part: { type: "text", text: "最终答复" } });
const TOOL_CALL = loop({ type: "tool.call", turnId: "2", toolCallId: "tc1", name: "Bash", args: { command: "ls" } });
const TOOL_RESULT = loop({ type: "tool.result", turnId: "2", toolCallId: "tc1", result: { output: "ok" } });
const USAGE = JSON.stringify({ type: "usage.record", model: "kimi-code/k3", usage: { inputOther: 10, output: 5, inputCacheRead: 100, inputCacheCreation: 20 } });
// kimi-code 0.33.0 records an idle-launched autonomous turn as turn.prompt
// carrying the <notification> envelope (previously turn.steer).
const NOTIFICATION_PROMPT = JSON.stringify({
  type: "turn.prompt",
  input: [{ type: "text", text: "<notification id=\"task:bash-x:completed\" category=\"task\" type=\"task.completed\" source_kind=\"background_task\" source_id=\"bash-x\">\n轮询 completed." }],
});
const SM_PROMPT = JSON.stringify({
  type: "turn.prompt",
  input: [{ type: "text", text: "[System] When you need user input…" }],
});

describe("isWireNotificationPrompt", () => {
  test("matches only turn.prompt lines whose text starts with <notification", () => {
    expect(isWireNotificationPrompt(NOTIFICATION_PROMPT)).toBe(true);
    expect(isWireNotificationPrompt(SM_PROMPT)).toBe(false);
    expect(isWireNotificationPrompt(JSON.stringify({ type: "turn.steer", input: [{ type: "text", text: "<notification/>" }] }))).toBe(false);
    expect(isWireNotificationPrompt(JSON.stringify({ type: "turn.prompt" }))).toBe(false);
  });
});

describe("translateWireLine", () => {
  test("think part → thinking", () => {
    expect(translateWireLine(THINK, new Map())).toEqual({ kind: "thinking", text: "想一下" });
  });
  test("text part → assistant_message non-final", () => {
    expect(translateWireLine(TEXT, new Map())).toEqual({
      kind: "assistant_message", text: "最终答复", final: false,
    });
  });
  test("tool.call → tool_call; tool.result recovers the name via callId", () => {
    const names = new Map<string, string>();
    expect(translateWireLine(TOOL_CALL, names)).toMatchObject({
      kind: "tool_call", name: "Bash", callId: "tc1",
    });
    expect(translateWireLine(TOOL_RESULT, names)).toMatchObject({
      kind: "tool_result", name: "Bash", result: "ok", callId: "tc1",
    });
  });
  test("tool.result without a known callId falls back to generic name", () => {
    expect(translateWireLine(TOOL_RESULT, new Map())).toMatchObject({ name: "tool" });
  });
  test("usage.record → usage event", () => {
    expect(translateWireLine(USAGE, new Map())).toMatchObject({
      kind: "usage", model: "kimi-code/k3",
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20,
    });
  });
  test("unrelated lines → null", () => {
    expect(translateWireLine(JSON.stringify({ type: "turn.steer" }), new Map())).toBeNull();
    expect(translateWireLine("not json", new Map())).toBeNull();
  });
});

describe("streamAutonomousTurn", () => {
  function mkSessionDir() {
    const dir = mkdtempSync(join(tmpdir(), "kimi-stream-"));
    mkdirSync(join(dir, "agents", "main"), { recursive: true });
    return { dir, wirePath: join(dir, "agents", "main", "wire.jsonl") };
  }

  async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const e of stream) events.push(e);
    return events;
  }

  test("streams wire content as AgentEvents and completes with the last text", async () => {
    const { dir, wirePath } = mkSessionDir();
    const steer = JSON.stringify({ type: "turn.steer" }) + "\n";
    writeFileSync(wirePath, steer + THINK + "\n" + TOOL_CALL + "\n" + TOOL_RESULT + "\n" + TEXT + "\n" + USAGE + "\n");
    const events = await drain(streamAutonomousTurn({
      sessionDir: dir,
      backendSessionId: "acp-sid-1",
      startOffset: 0,
      quietMs: 200,
      pollMs: 30,
    }));
    expect(events[0]).toEqual({ kind: "started", backendSessionId: "acp-sid-1" });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    const last = events.at(-1)!;
    expect(last).toEqual({ kind: "completed", finalMessage: "最终答复" });
  });

  test("no text content → completed with fallback, never a zero-byte run", async () => {
    const { dir, wirePath } = mkSessionDir();
    writeFileSync(wirePath, TOOL_CALL + "\n");
    const events = await drain(streamAutonomousTurn({
      sessionDir: dir, backendSessionId: "s", startOffset: 0, quietMs: 200, pollMs: 30,
    }));
    const last = events.at(-1)!;
    expect(last.kind).toBe("completed");
    expect((last as { finalMessage: string }).finalMessage.length).toBeGreaterThan(0);
  });

  test("a new turn.prompt mid-stream ends the episode promptly", async () => {
    const { dir, wirePath } = mkSessionDir();
    writeFileSync(wirePath, THINK + "\n");
    const stream = streamAutonomousTurn({
      sessionDir: dir, backendSessionId: "s", startOffset: 0, quietMs: 60_000, pollMs: 30,
    });
    const drained = drain(stream);
    await new Promise((r) => setTimeout(r, 150));
    appendFileSync(wirePath, JSON.stringify({ type: "turn.prompt" }) + "\n");
    const events = await drained;
    expect(events.at(-1)!.kind).toBe("completed");
  });

  test("0.33 notification-prompt at the stream start does NOT end the episode; a later SM prompt does", async () => {
    const { dir, wirePath } = mkSessionDir();
    writeFileSync(wirePath, NOTIFICATION_PROMPT + "\n" + THINK + "\n");
    const stream = streamAutonomousTurn({
      sessionDir: dir, backendSessionId: "s", startOffset: 0, quietMs: 60_000, pollMs: 30,
    });
    const drained = drain(stream);
    let finished = false;
    void drained.then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 200));
    // The notification-prompt is the autonomous turn's own start marker —
    // the stream must still be alive and streaming.
    expect(finished).toBe(false);
    appendFileSync(wirePath, TEXT + "\n" + SM_PROMPT + "\n");
    const events = await drained;
    expect(events.map((e) => e.kind)).toContain("assistant_message");
    expect(events.at(-1)).toEqual({ kind: "completed", finalMessage: "最终答复" });
  });

  test("stays alive while the subagent wire is active, main wire quiet", async () => {
    const { dir, wirePath } = mkSessionDir();
    mkdirSync(join(dir, "agents", "agent-1"), { recursive: true });
    const agentWire = join(dir, "agents", "agent-1", "wire.jsonl");
    writeFileSync(wirePath, THINK + "\n");
    writeFileSync(agentWire, THINK + "\n");
    const stream = streamAutonomousTurn({
      sessionDir: dir, backendSessionId: "s", startOffset: 0, quietMs: 300, pollMs: 40,
    });
    const drained = drain(stream);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 120));
      appendFileSync(agentWire, THINK + "\n");
    }
    const events = await drained;
    // ~480ms of subagent activity with quietMs=300 proves the episode held.
    expect(events.at(-1)!.kind).toBe("completed");
  });

  test("peekTurnId finds the first turnId at/after the steer offset", async () => {
    const { dir, wirePath } = mkSessionDir();
    const steer = JSON.stringify({ type: "turn.steer" }) + "\n";
    writeFileSync(wirePath, steer + loop({ type: "step.begin", turnId: "7", step: 1 }) + "\n");
    expect(await peekTurnId(dir, 0)).toBe("7");
    expect(await peekTurnId(dir, Buffer.byteLength(steer + loop({ type: "step.begin", turnId: "7", step: 1 }) + "\n", "utf-8"))).toBeNull();
  });

  test("bg mode: turn.prompt does not end the stream, isComplete does", async () => {
    const { dir, wirePath } = mkSessionDir();
    writeFileSync(wirePath, THINK + "\n");
    let done = false;
    const stream = streamAutonomousTurn({
      sessionDir: dir,
      backendSessionId: "s",
      startOffset: 0,
      wirePath,
      quietScope: "wire",
      endOnTurnPrompt: false,
      isComplete: () => done,
      quietMs: 60_000,
      pollMs: 30,
    });
    const drained = drain(stream);
    let finished = false;
    void drained.then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 150));
    // An agent wire's turn.prompt marks the task start, not an SM takeover.
    appendFileSync(wirePath, JSON.stringify({ type: "turn.prompt" }) + "\n" + TEXT + "\n");
    await new Promise((r) => setTimeout(r, 200));
    expect(finished).toBe(false);
    done = true;
    const events = await drained;
    expect(events.at(-1)).toEqual({ kind: "completed", finalMessage: "最终答复" });
  });

  test("quietScope=wire: activity on other wires does not keep the stream alive", async () => {
    const { dir, wirePath } = mkSessionDir();
    mkdirSync(join(dir, "agents", "agent-9"), { recursive: true });
    const otherWire = join(dir, "agents", "agent-9", "wire.jsonl");
    writeFileSync(wirePath, THINK + "\n");
    const stream = streamAutonomousTurn({
      sessionDir: dir,
      backendSessionId: "s",
      startOffset: 0,
      wirePath,
      quietScope: "wire",
      quietMs: 300,
      pollMs: 40,
    });
    const drained = drain(stream);
    // Fresh activity on an unrelated agent wire right before the quiet
    // deadline must not extend this stream (it would under "session" scope).
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(otherWire, THINK + "\n");
    const events = await drained;
    expect(events.at(-1)!.kind).toBe("completed");
  });
});
