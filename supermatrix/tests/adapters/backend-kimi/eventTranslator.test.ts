// tests/adapters/backend-kimi/eventTranslator.test.ts
//
// Fixture-driven tests for eventTranslator.
// Fixtures were captured by T0 (scripts/probe-kimi-acp.mjs) against kimi-cli 1.37.0.
// The translator is a pure function: no spawning, no I/O.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  createTranslatorState,
  translateUpdate,
  flushTranslator,
} from "../../../src/adapters/backend-kimi/eventTranslator.ts";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), "samples-acp");

function loadUpdates(file: string): unknown[] {
  return readFileSync(join(SAMPLES, file), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (m) =>
        m._type === "notif" && m.method === "session/update",
    )
    .map((m) => m.params.update);
}

describe("translateUpdate", () => {
  test("agent_message_chunk events accumulate into pendingAssistant", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    for (const u of loadUpdates("acp-prompt.jsonl")) {
      for (const e of translateUpdate(u, state)) events.push(e);
    }
    // Chunks should not emit assistant_message with final=true — that comes at flush.
    expect(events.some((e) => e.kind === "assistant_message" && (e as any).final)).toBe(false);
    // pendingAssistant should hold the concatenated text.
    expect(state.pendingAssistant).toMatch(/.+/);
  });

  test("flushTranslator after 'end_turn' emits final assistant_message + completed", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    for (const u of loadUpdates("acp-prompt.jsonl")) {
      for (const e of translateUpdate(u, state)) events.push(e);
    }
    // Use "end_turn" — the literal value observed in T0 fixtures and ACP schema.
    for (const e of flushTranslator(state, "end_turn")) events.push(e);
    expect(events.some((e) => e.kind === "assistant_message" && (e as any).final)).toBe(true);
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("tool_call update emits AgentEvent kind=tool_call and kind=tool_result", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    for (const u of loadUpdates("acp-tool.jsonl")) {
      for (const e of translateUpdate(u, state)) events.push(e);
    }
    // acp-tool.jsonl has: tool_call (in_progress) + tool_call_update (in_progress x7) + tool_call_update (failed)
    expect(events.some((e) => e.kind === "tool_call")).toBe(true);
    // tool_call_update with status="failed" should emit tool_result
    expect(events.some((e) => e.kind === "tool_result")).toBe(true);
  });

  test("flush with 'cancelled' stopReason emits error event", () => {
    const state = createTranslatorState();
    state.sessionAnnounced = true;
    const events = flushTranslator(state, "cancelled");
    expect(events.some((e) => e.kind === "error" && /cancel/i.test((e as any).message))).toBe(
      true,
    );
  });

  test("flush with no pending content emits empty-completion error when sessionAnnounced", () => {
    const state = createTranslatorState();
    state.sessionAnnounced = true;
    const events = flushTranslator(state, "end_turn");
    expect(
      events.some((e) => e.kind === "error" && /empty completion/i.test((e as any).message)),
    ).toBe(true);
  });

  test("flush with no pending content and sessionAnnounced=false emits nothing", () => {
    const state = createTranslatorState();
    // sessionAnnounced defaults to false — no events expected
    const events = flushTranslator(state, "end_turn");
    expect(events).toHaveLength(0);
  });

  test("ignores unknown sessionUpdate types", () => {
    const state = createTranslatorState();
    expect(() =>
      translateUpdate({ sessionUpdate: "future_unknown_kind" } as unknown, state),
    ).not.toThrow();
  });

  test("thinking chunks are emitted as 'thinking' event on flush", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    // acp-prompt.jsonl has 22 agent_thought_chunk events before the message chunks
    for (const u of loadUpdates("acp-prompt.jsonl")) {
      for (const e of translateUpdate(u, state)) events.push(e);
    }
    for (const e of flushTranslator(state, "end_turn")) events.push(e);
    // After flush, thinking event should appear before assistant_message
    const thinkingIdx = events.findIndex((e) => e.kind === "thinking");
    const msgIdx = events.findIndex((e) => e.kind === "assistant_message");
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBeLessThan(msgIdx);
  });
});

describe("translateUpdate streaming enrichment", () => {
  const thought = (text: string) => ({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  });
  const message = (text: string) => ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
  const toolStart = (id: string, title: string) => ({
    sessionUpdate: "tool_call",
    toolCallId: id,
    title,
    status: "in_progress",
    content: [],
  });
  const toolUpdate = (id: string, text: string, status = "in_progress", title?: string) => ({
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status,
    content: [{ type: "content", content: { type: "text", text } }],
    ...(title ? { title } : {}),
  });

  test("tool_call emitted exactly once, when the streamed args JSON parses, with command + callId", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    const feed = (u: unknown) => events.push(...translateUpdate(u, state));

    feed(toolStart("t1", "Shell"));
    expect(events).toHaveLength(0); // buffered — args not in yet
    // kimi streams args as cumulative snapshots: each update carries the full
    // JSON text so far, not a delta.
    feed(toolUpdate("t1", '{"command": "ec', "in_progress", "Shell"));
    feed(toolUpdate("t1", '{"command": "echo hi"}', "in_progress", "Shell: echo hi"));

    const calls = events.filter((e) => e.kind === "tool_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "tool_call",
      name: "Shell",
      args: { command: "echo hi" },
      command: "echo hi",
      callId: "t1",
    });

    feed(toolUpdate("t1", "irrelevant later update"));
    expect(events.filter((e) => e.kind === "tool_call")).toHaveLength(1);
  });

  test("tool call without streamed args is emitted at completion, before its tool_result", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    const feed = (u: unknown) => events.push(...translateUpdate(u, state));

    feed(toolStart("t2", "TodoList"));
    feed(toolUpdate("t2", "all done", "completed"));

    expect(events.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
    expect(events[0]).toMatchObject({ kind: "tool_call", name: "TodoList", args: {}, callId: "t2" });
    expect(events[1]).toMatchObject({
      kind: "tool_result",
      name: "TodoList",
      result: { output: "all done", exitCode: 0 },
      callId: "t2",
    });
  });

  test("tool_result correlates command and callId from the pending call", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    const feed = (u: unknown) => events.push(...translateUpdate(u, state));

    feed(toolStart("t3", "Shell"));
    feed(toolUpdate("t3", '{"command": "ls -la"}'));
    feed(toolUpdate("t3", "total 42", "completed"));

    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ callId: "t3", command: "ls -la" });
    expect(events.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
  });

  test("thinking flushes live at the first answer text, not at turn end", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    const feed = (u: unknown) => events.push(...translateUpdate(u, state));

    feed(thought("The user"));
    feed(thought(" wants a fix"));
    expect(events).toHaveLength(0);
    feed(message("done"));

    expect(events.map((e) => e.kind)).toEqual(["thinking"]);
    expect((events[0] as { text: string }).text).toBe("The user wants a fix");
    events.push(...flushTranslator(state, "end_turn"));
    expect(events.map((e) => e.kind)).toEqual(["thinking", "assistant_message", "completed"]);
  });

  test("thinking flushes before the tool event it precedes", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    const feed = (u: unknown) => events.push(...translateUpdate(u, state));

    feed(thought("let me run it"));
    feed(toolStart("t4", "Shell"));
    feed(toolUpdate("t4", '{"command": "pwd"}'));

    expect(events.map((e) => e.kind)).toEqual(["thinking", "tool_call"]);
  });

  test("pending tool call with unparseable args is still surfaced at turn end", () => {
    const state = createTranslatorState();
    translateUpdate(toolStart("t5", "Read"), state);
    translateUpdate(toolUpdate("t5", '{"file_path": "/etc/pa'), state);

    const events = flushTranslator(state, "end_turn");
    expect(events.some((e) => e.kind === "tool_call" && (e as { name?: string }).name === "Read")).toBe(true);
  });

  test("fixture acp-tool.jsonl now carries args detail on the card line", () => {
    const state = createTranslatorState();
    const events: AgentEvent[] = [];
    for (const u of loadUpdates("acp-tool.jsonl")) {
      for (const e of translateUpdate(u, state)) events.push(e);
    }
    const call = events.find((e) => e.kind === "tool_call");
    expect(call).toMatchObject({ name: "Shell", command: "echo hi", args: { command: "echo hi" } });
    const result = events.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ name: "Shell", command: "echo hi" });
  });
});
