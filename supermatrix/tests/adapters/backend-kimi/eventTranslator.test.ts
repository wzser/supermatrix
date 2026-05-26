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
