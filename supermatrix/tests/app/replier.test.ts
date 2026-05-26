import { describe, expect, test } from "vitest";
import { createReplier, formatModel } from "../../src/app/replier.ts";
import { asLarkGroupId, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";

async function* mkStream(events: AgentEvent[], delayMs = 0): AsyncIterable<AgentEvent> {
  for (const e of events) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield e;
  }
}

describe("replier", () => {
  test("keeps non-final assistant_message text out of finalMessage", async () => {
    // Codex may stream process narration as non-final assistant_message.
    // Keep that trace in streamLog/processLog, but do not duplicate it into
    // the final card body.
    const lark = createFakeLarkGateway();
    const now = { value: 5_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-codex" },
      { kind: "assistant_message", text: "方案 A：宽表\n方案 B：明细\n方案 C：双表", final: false },
      { kind: "assistant_message", text: "等你确认按 A 执行", final: true },
      { kind: "completed", finalMessage: "等你确认按 A 执行" },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_join"),
      sessionId: asSessionId("s_join"),
      runId: asMessageRunId("mr1"),
      sessionName: "future-teller",
      sessionModel: "gpt-5-codex",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.finalMessage).toBe("等你确认按 A 执行");
    expect(result.streamLog).toEqual([
      { ts: 5_000, kind: "assistant_message", text: "方案 A：宽表\n方案 B：明细\n方案 C：双表", final: false },
      { ts: 5_000, kind: "assistant_message", text: "等你确认按 A 执行", final: true },
    ]);
    expect(lark.finalized[0]?.text).toBe("等你确认按 A 执行");
    expect(lark.finalized[0]?.processLog).toContain("方案 B");
  });

  test("streams events into a single card and finalizes with assistant_message", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "thinking", text: "let me think" },
      { kind: "assistant_message", text: "hello", final: true },
      { kind: "completed", finalMessage: "hello" },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "test-session",
      sessionModel: "claude-opus-4-6",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    expect(result.finalMessage).toBe("hello");
    expect([...lark.cards.values()].at(-1)).toContain("hello");
    expect(lark.finalized).toHaveLength(1);
    const [finalCall] = lark.finalized;
    expect(finalCall.text).toBe("hello");
    // processLog preserves the full streaming trace for the collapsed panel
    expect(finalCall.processLog).toContain("🔗 session 启动");
    expect(finalCall.processLog).toContain("💭 let me think");
    expect(finalCall.processLog).toContain("💬 hello");
  });

  // Repro for the yolo/future-teller "card says failed but body is the real
  // response" bug. Backend CLI streams a full response (completed +
  // final assistant_message), then exits non-zero for a CLI-level reason
  // (rate-limit message text already delivered, codex Reconnecting noise,
  // etc). process.ts pushes a trailing `error` event. Replier should not
  // mark the whole run failed — the assistant response is already in hand.
  test("trailing error after completed+final does not flip title to failed", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "assistant_message", text: "real response", final: true },
      { kind: "completed", finalMessage: "real response" },
      { kind: "error", message: "exit 1", recoverable: false },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    expect(result.finalMessage).toBe("real response");
    expect(result.error).toBeUndefined();
    const [finalCall] = lark.finalized;
    expect(finalCall.title).toMatch(/· done$/u);
  });

  // Regression for watchdog issue eee04198: backend delivered a completed
  // event, then the inactivity watchdog killed the run with a [TIMEOUT]
  // error. With the old guard (plain `!completedCleanly`) the error was
  // swallowed and the card landed on green "done" while the body shows
  // "❌ [TIMEOUT] …" — the exact visual divergence users reported.
  test("timeout error after completed flips title to timeout and propagates runStatus", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "assistant_message", text: "partial", final: true },
      { kind: "completed", finalMessage: "partial" },
      {
        kind: "error",
        message: "[TIMEOUT] inactivity: no output for 900s",
        recoverable: false,
      },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    expect(result.error).toBe("[TIMEOUT] inactivity: no output for 900s");
    expect(result.runStatus).toBe("timeout");
    const [finalCall] = lark.finalized;
    expect(finalCall.title).toMatch(/· timeout($| \|)/u);
    expect(finalCall.runStatus).toBe("timeout");
  });

  test("tool events in stream log include call id and command evidence", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-codex" },
      {
        kind: "tool_call",
        callId: "call_sqlite",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "SELECT 1;"',
        args: { cmd: 'sqlite3 /tmp/amz.db "SELECT 1;"' },
      },
      {
        kind: "tool_result",
        callId: "call_sqlite",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "SELECT 1;"',
        result: { output: "1\n" },
      },
      { kind: "assistant_message", text: "done", final: true },
      { kind: "completed", finalMessage: "done" },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "product-tracker",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.streamLog).toEqual([
      {
        ts: 1_000,
        kind: "tool_call",
        callId: "call_sqlite",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "SELECT 1;"',
        args: { cmd: 'sqlite3 /tmp/amz.db "SELECT 1;"' },
      },
      {
        ts: 1_000,
        kind: "tool_result",
        callId: "call_sqlite",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "SELECT 1;"',
        result: { output: "1\n" },
      },
      { ts: 1_000, kind: "assistant_message", text: "done", final: true },
    ]);
  });

  test("pending tool call timeout remains identifiable from stream log", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "product-tracker",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-codex" },
        {
          kind: "tool_call",
          callId: "call_pending",
          name: "exec_command",
          command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__inventory_info_snapshot_d);"',
          args: { cmd: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__inventory_info_snapshot_d);"' },
        },
        {
          kind: "error",
          message: "[TIMEOUT] inactivity: no output for 900s",
          recoverable: false,
        },
      ]),
    });

    const pending = new Map<string, Extract<(typeof result.streamLog)[number], { kind: "tool_call" }>>();
    for (const entry of result.streamLog) {
      if (entry.kind === "tool_call" && entry.callId) pending.set(entry.callId, entry);
      if (entry.kind === "tool_result" && entry.callId) pending.delete(entry.callId);
    }
    expect(result.runStatus).toBe("timeout");
    expect([...pending.values()]).toEqual([
      expect.objectContaining({
        callId: "call_pending",
        name: "exec_command",
        command: 'sqlite3 /tmp/amz.db "PRAGMA table_info(dwd__inventory_info_snapshot_d);"',
      }),
    ]);
  });

  test("cancelled-by-user error after completed flips title to cancelled", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "assistant_message", text: "half answer", final: true },
      { kind: "completed", finalMessage: "half answer" },
      { kind: "error", message: "cancelled by user", recoverable: false },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    expect(result.error).toBe("cancelled by user");
    expect(result.runStatus).toBe("cancelled");
    const [finalCall] = lark.finalized;
    expect(finalCall.title).toMatch(/· cancelled($| \|)/u);
    expect(finalCall.runStatus).toBe("cancelled");
  });

  // Repro for watchdog issue f023723e (run mr_452cff5f): codex CLI emits
  // 6× recoverable `error` events ("Reconnecting... 1-5/5 (stream
  // disconnected before completion: ...)") *before* the final
  // assistant_message. With the old guard, each Reconnecting event ran
  // through `!completedCleanly → error = event.message`, and the final=true
  // branch never reset it, so classifyRunStatus saw a non-empty error and
  // returned 'failed' even though the model delivered a complete reply.
  // Terminal errors ([TIMEOUT] / cancelled by user) must keep their existing
  // override semantics — covered by separate tests above.
  test("recoverable errors before final assistant_message do not mark run failed", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-codex" },
      {
        kind: "error",
        message:
          "Reconnecting... 1/5 (stream disconnected before completion: stream closed)",
        recoverable: true,
      },
      {
        kind: "error",
        message:
          "Reconnecting... 2/5 (stream disconnected before completion: stream closed)",
        recoverable: true,
      },
      {
        kind: "error",
        message:
          "Reconnecting... 3/5 (stream disconnected before completion: stream closed)",
        recoverable: true,
      },
      { kind: "thinking", text: "regrouping" },
      { kind: "assistant_message", text: "complete reply", final: true },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_codex"),
      sessionId: asSessionId("s_codex"),
      runId: asMessageRunId("mr1"),
      sessionName: "bresson",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.finalMessage).toBe("complete reply");
    expect(result.error).toBeUndefined();
    expect(result.runStatus).toBe("completed");
    const [finalCall] = lark.finalized;
    expect(finalCall.title).toMatch(/· done($| \|)/u);
    expect(finalCall.runStatus).toBe("completed");
  });

  test("error before completed still marks run failed", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "error", message: "API Error: upstream down", recoverable: false },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    expect(result.error).toBe("API Error: upstream down");
    const [finalCall] = lark.finalized;
    expect(finalCall.title).toMatch(/· failed$/u);
  });

  test("title includes context usage when usage present and model known (Opus 4.7 1M)", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    // 30000 + 15000 + 932 = 45932 → 45.9k
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "claude-opus-4-7",
        inputTokens: 30_000,
        outputTokens: 0,
        cacheReadTokens: 15_000,
        cacheWriteTokens: 932,
        reasoningTokens: 0,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("yolo | Opus 4.7 · done | 45.9k/1000k");
  });

  test("title omits context segment when no usage events seen", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("yolo | Opus 4.7 · done");
  });

  test("title omits context segment when no model limit is known", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "unknown-model",
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "code",
      sessionModel: "unknown-model",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).not.toMatch(/\dk\/\d+k/u);
    expect(final.title).toBe("code | unknown-model · done");
  });

  test("Codex title uses runtime context window from usage events", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "gpt-5.3-codex-spark",
        inputTokens: 17_173,
        outputTokens: 0,
        cacheReadTokens: 7_552,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        contextWindowTokens: 258_400,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "code",
      sessionModel: "gpt-5.3-codex-spark",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("code | GPT-5.3 Codex Spark · done | 24.7k/258k");
  });

  test("Codex title uses runtime context window even when model id is absent", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: null,
        inputTokens: 17_173,
        outputTokens: 0,
        cacheReadTokens: 7_552,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        contextWindowTokens: 258_400,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "code",
      sessionModel: null,
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("code | Codex · done | 24.7k/258k");
  });

  test("Codex title uses static model limit when runtime window is absent", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "gpt-5.5",
        inputTokens: 100_000,
        outputTokens: 0,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "code",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("code | GPT-5.5 · done | 120k/272k");
  });

  test("Codex title uses usage model when session model is absent", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "gpt-5.4",
        inputTokens: 17_937,
        outputTokens: 39,
        cacheReadTokens: 6_528,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "code",
      sessionModel: null,
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("code | GPT-5.4 · done | 24.5k/272k");
  });

  test("Codex title normalizes resumed cumulative usage using the previous raw watermark", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "gpt-5.5",
        inputTokens: 24_329_459,
        outputTokens: 70_367,
        cacheReadTokens: 23_105_664,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: {
          input_tokens: 24_329_459,
          cached_input_tokens: 23_105_664,
          output_tokens: 70_367,
        },
      },
      { kind: "assistant_message", text: "ok", final: true },
      { kind: "completed", finalMessage: "ok" },
    ];

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "amz-sql",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      usageBaseline: {
        inputTokens: 24_255_780,
        outputTokens: 69_736,
        cacheReadTokens: 23_092_608,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      stream: mkStream(events),
    });

    const [final] = lark.finalized;
    expect(final.title).toBe("amz-sql | GPT-5.5 · done | 86.7k/272k");
  });

  test("multiple running-phase usage events update the title live using latest context snapshot", async () => {
    // User-visible effect: while the backend streams, each per-turn usage
    // event from the parser should push the latest context snapshot into the
    // card title without summing repeated full-history input/cache fields.
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-1" },
      {
        kind: "usage",
        model: "claude-opus-4-7",
        inputTokens: 10_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: null,
      },
      {
        kind: "usage",
        model: "claude-opus-4-7",
        inputTokens: 20_000,
        outputTokens: 0,
        cacheReadTokens: 5_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        rawUsage: null,
      },
      { kind: "assistant_message", text: "hi", final: true },
      { kind: "completed", finalMessage: "hi" },
    ];
    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    // First usage snapshot → 10k/1000k
    // Second usage snapshot → 25k/1000k
    const titles = lark.titleHistory.map((t) => t.title ?? "");
    expect(titles.some((t) => t.includes("· running | 10k/1000k"))).toBe(true);
    expect(titles.some((t) => t.includes("· running | 25k/1000k"))).toBe(true);
    const [final] = lark.finalized;
    expect(final.title).toBe("yolo | Opus 4.7 · done | 25k/1000k");
  });

  test("emits reminder when no events for threshold", async () => {
    const lark = createFakeLarkGateway();
    let vtime = 0;
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(vtime) },
      monotonic: () => vtime,
      reminderSchedule: [100],
      idFactory: () => "mr1",
    });

    async function* slow(): AsyncIterable<AgentEvent> {
      yield { kind: "started", backendSessionId: "bks-1" };
      await new Promise<void>((resolve) => {
        // advance virtual time, then emit a completed to end stream
        setTimeout(() => {
          vtime = 200;
          resolve();
        }, 30);
      });
      yield { kind: "completed", finalMessage: "done" };
    }

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "test-session",
      sessionModel: null,
      sessionBackend: "claude",
      stream: slow(),
    });

    const values = [...lark.cards.values()];
    // At least one intermediate update should contain a reminder string
    expect(values.some((v) => v.includes("已运行"))).toBe(true);
  });

  describe("formatModel kimi backend", () => {
    test("returns 'Kimi' for kimi backend with no model", () => {
      expect(formatModel(null, "kimi")).toBe("Kimi");
    });
    test("kimi-k2-thinking falls through to stripped name", () => {
      expect(formatModel("kimi-k2-thinking", "kimi")).toBe("kimi-k2-thinking");
    });
  });
});
