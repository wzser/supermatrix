import { afterEach, describe, expect, test } from "vitest";
import { createReplier, formatContextUsage, formatModel } from "../../src/app/replier.ts";
import { asLarkGroupId, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../src/ports/BackendRuntimeDefaults.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";

async function* mkStream(events: AgentEvent[], delayMs = 0): AsyncIterable<AgentEvent> {
  for (const e of events) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield e;
  }
}

describe("replier", () => {
  afterEach(() => {
    resetConfiguredBackendRuntimeDefaultsForTests();
  });

  test("Codex titles keep the frozen execution effort while runtime model display updates", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_branch"),
      sessionName: "codexroot",
      branchName: "plan-a",
      sessionModel: "gpt-5.6-sol",
      sessionEffort: "ultra",
      sessionBackend: "codex",
      execution: { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
      stream: (async function* () {
        yield { kind: "started", backendSessionId: "bks-plan-a" } satisfies AgentEvent;
        // These mutable defaults change after the CLI execution tuple was frozen.
        setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.5", effort: "high" });
        yield {
          kind: "usage",
          model: "gpt-5.5",
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          rawUsage: null,
        } satisfies AgentEvent;
        yield { kind: "assistant_message", text: "done", final: true } satisfies AgentEvent;
        yield { kind: "completed", finalMessage: "done" } satisfies AgentEvent;
      })(),
    } as Parameters<typeof replier.consume>[0] & {
      execution: { backend: "codex"; model: string; effort: "ultra" };
    });

    const titles = lark.titleHistory.map((t) => t.title);
    expect(titles[0]).toBe("codexroot@plan-a | GPT-5.6 Sol · running | ULTRA | mr_branch");
    expect(titles).toContain("codexroot@plan-a | GPT-5.5 · running | ULTRA | mr_branch");
    const [final] = lark.finalized;
    expect(final.title).toBe("codexroot@plan-a | GPT-5.5 · done | ULTRA | mr_branch");
  });

  test("completedTemplate override is forwarded to finalizeCard", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("auto-turn-7"),
      sessionName: "kimiroot",
      sessionModel: "kimi-code/kimi-for-coding",
      sessionBackend: "kimi",
      completedTemplate: "violet",
      stream: mkStream([
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.finalized[0]?.runStatus).toBe("completed");
    expect(lark.finalized[0]?.completedTemplate).toBe("violet");
  });

  test("completedTemplate defaults to undefined for ordinary runs", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_plain"),
      sessionName: "kimiroot",
      sessionModel: "kimi-code/kimi-for-coding",
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.finalized[0]?.runStatus).toBe("completed");
    expect(lark.finalized[0]?.completedTemplate).toBeUndefined();
  });

  test("failed Codex card titles keep the frozen execution effort", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_failed_effort"),
      sessionName: "codexroot",
      sessionModel: "gpt-5.6-sol",
      sessionEffort: "ultra",
      sessionBackend: "codex",
      execution: { backend: "codex", model: "gpt-5.6-sol", effort: "ultra" },
      stream: mkStream([{ kind: "error", message: "boom", recoverable: false }]),
    } as Parameters<typeof replier.consume>[0] & {
      execution: { backend: "codex"; model: string; effort: "ultra" };
    });

    expect(lark.finalized[0]?.title).toBe(
      "codexroot | GPT-5.6 Sol · failed | ULTRA | mr_failed_effort",
    );
  });

  test("Claude titles use configured global execution effort when the session has none", async () => {
    setConfiguredBackendRuntimeDefaults("claude", { model: null, effort: "high" });
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_claude_effort"),
      sessionName: "writer",
      sessionModel: "claude-opus-4-8",
      sessionEffort: null,
      sessionBackend: "claude",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-claude" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.titleHistory[0]?.title).toBe("writer | Opus 4.8 · running | HIGH | mr_claude_effort");
    expect(lark.finalized[0]?.title).toBe("writer | Opus 4.8 · done | HIGH | mr_claude_effort");
  });

  test("Kimi model-null titles stay DEFAULT even with a persisted effort (level only shows once the ACP model is known K3)", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_effort"),
      sessionName: "kimi",
      sessionModel: null,
      sessionEffort: "high",
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    // The execution config passes the raw effort through for the backend to
    // resolve against the ACP-observed model; the title never sees that
    // observation, so it must not advertise a level a K2.7 fixed-on session
    // cannot apply.
    expect(lark.titleHistory[0]?.title).toBe("kimi | Kimi · running | DEFAULT | mr_kimi_effort");
    expect(lark.finalized[0]?.title).toBe("kimi | Kimi · done | DEFAULT | mr_kimi_effort");
  });

  test("Kimi K3 titles show the effective K3 effort instead of DEFAULT, default resolving to native high", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_k3"),
      sessionName: "kimi",
      sessionModel: "kimi-code/k3",
      sessionEffort: null,
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.titleHistory[0]?.title).toBe("kimi | K3 · running | HIGH | mr_kimi_k3");
    expect(lark.finalized[0]?.title).toBe("kimi | K3 · done | HIGH | mr_kimi_k3");
  });

  test("Kimi K3 titles map a requested level to the native K3 level", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_k3_low"),
      sessionName: "kimi",
      sessionModel: "kimi-code/k3",
      sessionEffort: "low",
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.titleHistory[0]?.title).toBe("kimi | K3 · running | LOW | mr_kimi_k3_low");
    expect(lark.finalized[0]?.title).toBe("kimi | K3 · done | LOW | mr_kimi_k3_low");
  });

  test("Kimi K2.7 titles stay DEFAULT (thinking fixed on)", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_k27"),
      sessionName: "kimi",
      sessionModel: "kimi-code/kimi-for-coding",
      sessionEffort: null,
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.titleHistory[0]?.title).toBe("kimi | K2.7 Coding · running | DEFAULT | mr_kimi_k27");
    expect(lark.finalized[0]?.title).toBe("kimi | K2.7 Coding · done | DEFAULT | mr_kimi_k27");
  });

  test("Kimi model-null title resolves effort against the runtime model from the started event (K3 → HIGH default)", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_rt_k3"),
      sessionName: "kimi",
      sessionModel: null,
      sessionEffort: null,
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi", model: "kimi-code/k3" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    // Before the started event the model is unknown → DEFAULT; once the
    // backend reports K3 the title shows the actual native level (default
    // high).
    expect(lark.titleHistory[0]?.title).toBe("kimi | Kimi · running | DEFAULT | mr_kimi_rt_k3");
    expect(lark.finalized[0]?.title).toBe("kimi | K3 · done | HIGH | mr_kimi_rt_k3");
  });

  test("Kimi model-null title maps the persisted request to the native level of the started-event model (k3 + max → MAX)", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_kimi_rt_max"),
      sessionName: "kimi",
      sessionModel: null,
      sessionEffort: "max",
      sessionBackend: "kimi",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-kimi", model: "kimi-code/k3" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(lark.finalized[0]?.title).toBe("kimi | K3 · done | MAX | mr_kimi_rt_max");
  });

  test("Kimi model-null title stays DEFAULT when the started event reports K2.7 or an unknown model", async () => {
    for (const [runId, model] of [
      ["mr_kimi_rt_k27", "kimi-code/kimi-for-coding"],
      ["mr_kimi_rt_unknown", "kimi-code/k9"],
    ] as const) {
      const lark = createFakeLarkGateway();
      const replier = createReplier({
        lark,
        clock: { now: () => asTimestamp(1_000) },
        monotonic: () => 1_000,
      });

      await replier.consume({
        groupId: asLarkGroupId("oc_1"),
        sessionId: asSessionId("s1"),
        runId: asMessageRunId(runId),
        sessionName: "kimi",
        sessionModel: null,
        sessionEffort: "low",
        sessionBackend: "kimi",
        stream: mkStream([
          { kind: "started", backendSessionId: "bks-kimi", model },
          { kind: "assistant_message", text: "done", final: true },
          { kind: "completed", finalMessage: "done" },
        ]),
      });

      // K2.7 (fixed-on) and unrecognized models can never apply a level —
      // the card must not advertise the persisted request.
      expect(lark.finalized[0]?.title).toContain("| DEFAULT |");
    }
  });

  test("title includes full run id on initial running updates and final title without usage", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const runId = "mr_full_length_run_id_abcdefghijklmnopqrstuvwxyz_0123456789";

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId(runId),
      sessionName: "watchdog",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-codex" },
        { kind: "thinking", text: "checking" },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    const titles = lark.titleHistory.map((t) => t.title);
    expect(titles[0]).toBe(`watchdog | GPT-5.5 · running | DEFAULT | ${runId}`);
    expect(titles).toContain(`watchdog | GPT-5.5 · running | DEFAULT | ${runId}`);
    const [final] = lark.finalized;
    expect(final.title).toBe(`watchdog | GPT-5.5 · done | DEFAULT | ${runId}`);
  });

  test("title omits context usage and keeps full run id when usage is present", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const runId = "mr_context_order_run_id_abcdefghijklmnopqrstuvwxyz_0123456789";

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId(runId),
      sessionName: "watchdog",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-codex" },
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
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    const titles = lark.titleHistory.map((t) => t.title);
    expect(titles).toContain(`watchdog | GPT-5.5 · running | DEFAULT | ${runId}`);
    const [final] = lark.finalized;
    expect(final.title).toBe(`watchdog | GPT-5.5 · done | DEFAULT | ${runId}`);
  });

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

  test("Claude assistant text before tool_use survives the final short result", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 5_500 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_claude_tool_text"),
      sessionId: asSessionId("s_claude_tool_text"),
      runId: asMessageRunId("mr_d2fe7853"),
      sessionName: "zedong",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-claude" },
        { kind: "assistant_message", text: "正文先出来，后面还会读文件。", final: false },
        {
          kind: "tool_call",
          callId: "toolu_read",
          name: "Read",
          args: { file_path: "/tmp/source.md" },
        },
        {
          kind: "tool_result",
          callId: "toolu_read",
          name: "Read",
          result: "file body",
        },
        { kind: "assistant_message", text: "短尾巴", final: true },
        { kind: "completed", finalMessage: "短尾巴" },
      ]),
    });

    expect(result.finalMessage).toBe("正文先出来，后面还会读文件。\n\n短尾巴");
    expect(lark.finalized[0]?.text).toBe("正文先出来，后面还会读文件。\n\n短尾巴");
    expect(result.streamLog).toEqual([
      { ts: 5_500, kind: "assistant_message", text: "正文先出来，后面还会读文件。", final: false },
      {
        ts: 5_500,
        kind: "tool_call",
        callId: "toolu_read",
        name: "Read",
        args: { file_path: "/tmp/source.md" },
      },
      {
        ts: 5_500,
        kind: "tool_result",
        callId: "toolu_read",
        name: "Read",
        result: "file body",
      },
      { ts: 5_500, kind: "assistant_message", text: "短尾巴", final: true },
    ]);
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
    // processLog preserves the user-facing narrative for the collapsed panel.
    expect(finalCall.processLog).toContain("🔗 session 启动");
    expect(finalCall.processLog).toContain("💭 let me think");
    expect(finalCall.processLog).toContain("💬 hello");
  });

  test("marks a silently terminated zero-byte stream failed without terminal evidence", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });

    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_forced_stop"),
      sessionName: "codexroot",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      stream: mkStream([{ kind: "started", backendSessionId: "bks-forced-stop" }]),
    });

    expect(result.error).toBe("backend stream ended without final output or completion receipt");
    expect(result.runStatus).toBe("failed");
    expect(result.finalMessage).toBe("❌ backend stream ended without final output or completion receipt");
    expect(lark.finalized[0]).toMatchObject({
      runStatus: "failed",
      text: "❌ backend stream ended without final output or completion receipt",
    });
  });

  test("runs auto file delivery after finalizing the card", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const delivered: unknown[] = [];
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
      autoFileDelivery: {
        deliver: async (input) => {
          delivered.push({
            finalizedCardsBeforeDelivery: lark.finalized.length,
            input,
          });
        },
      },
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_auto_hook"),
      sessionName: "codexroot",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      runStartedAtMs: 123_456,
      stream: mkStream([
        { kind: "assistant_message", text: "/tmp/out.md", final: true },
        { kind: "completed", finalMessage: "/tmp/out.md" },
      ]),
    });

    expect(delivered).toEqual([
      {
        finalizedCardsBeforeDelivery: 1,
        input: {
          groupId: "oc_1",
          sessionName: "codexroot",
          runId: "mr_auto_hook",
          runStartedAtMs: 123_456,
          finalMessage: "/tmp/out.md",
        },
      },
    ]);
  });

  test("auto file delivery failure does not change the final result", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
      autoFileDelivery: {
        deliver: async () => {
          throw new Error("lark-cli attachment failed");
        },
      },
    });

    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr_auto_skip"),
      sessionName: "codexroot",
      sessionModel: "gpt-5.5",
      sessionBackend: "codex",
      runStartedAtMs: 123_456,
      stream: mkStream([
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    expect(result.finalMessage).toBe("done");
    expect(result.error).toBeUndefined();
    expect(lark.finalized[0]?.text).toBe("done");
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
    expect(finalCall.title).toMatch(/· done \| DEFAULT \| mr1$/u);
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

  test("posts AskUserQuestion options as a plain text question", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const askUserArgs = {
      questions: [
        {
          header: "选择方案",
          id: "plan_choice",
          question: "这次 mr_6fef35af 要按哪个方案继续？",
          options: [
            { label: "方案 A", description: "保守修复" },
            { label: "方案 B", description: "补完整桥接" },
            { label: "方案 C", description: "只保留文字 fallback" },
            { label: "暂不处理", description: "停止本次修改" },
          ],
        },
      ],
    };

    await replier.consume({
      groupId: asLarkGroupId("oc_ask_user"),
      sessionId: asSessionId("sess_ask_user"),
      runId: asMessageRunId("mr_6fef35af"),
      sessionName: "amzdata",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-ask-user" },
        {
          kind: "tool_call",
          callId: "toolu_ask_user",
          name: "AskUserQuestion",
          args: askUserArgs,
        },
        {
          kind: "tool_result",
          callId: "toolu_ask_user",
          name: "AskUserQuestion",
          result: "Answer questions?",
        },
        { kind: "assistant_message", text: "等你选择", final: true },
        { kind: "completed", finalMessage: "等你选择" },
      ]),
    });

    expect(lark.sent).toEqual([
      {
        groupId: asLarkGroupId("oc_ask_user"),
        text: [
          "选择方案",
          "这次 mr_6fef35af 要按哪个方案继续？",
          "",
          "1. 方案 A - 保守修复",
          "2. 方案 B - 补完整桥接",
          "3. 方案 C - 只保留文字 fallback",
          "4. 暂不处理 - 停止本次修改",
        ].join("\n"),
      },
    ]);
  });

  test("suppresses the plain text question mirror when AskUserQuestion is card-routed", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_ask_user"),
      sessionId: asSessionId("sess_ask_user"),
      runId: asMessageRunId("mr_card_routed"),
      sessionName: "product-info",
      sessionModel: "kimi-code/k3",
      sessionBackend: "kimi",
      askUserQuestionCardRouted: true,
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-card-routed" },
        {
          kind: "tool_call",
          callId: "toolu_ask_user",
          name: "AskUserQuestion",
          args: {
            questions: [
              {
                header: "选择方案",
                question: "要按哪个方案继续？",
                options: [
                  { label: "方案 A", description: "保守修复" },
                  { label: "方案 B", description: "补完整桥接" },
                ],
              },
            ],
          },
        },
        { kind: "assistant_message", text: "等你选择", final: true },
        { kind: "completed", finalMessage: "等你选择" },
      ]),
    });

    // The question reached the user as an interactive card via the broker —
    // mirroring it as plain text would show it twice.
    expect(lark.sent).toEqual([]);
  });

  test("posts the mr_6fef35af AskUserQuestion fixture as a four-option plain text question", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_ask_user_fixture"),
      sessionId: asSessionId("sess_ask_user_fixture"),
      runId: asMessageRunId("mr_6fef35af"),
      sessionName: "amzdata",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream([
        {
          kind: "tool_call",
          callId: "toolu_01SJoHFDx8yX4ribGKkMgh41",
          name: "AskUserQuestion",
          args: {
            questions: [
              {
                question: "这套日常流水线里，你希望「人工确认」最终保留在哪个程度？(决定整个框架的自动化边界)",
                header: "自动化边界",
                multiSelect: false,
                options: [
                  {
                    label: "全自动+异常才找我",
                    description: "新规则转化、反馈迭代、分析过滤、历史翻牌全部自动跑，只有出错或低置信度的边界 case 才升级给我确认。日常零打扰。",
                  },
                  {
                    label: "只在「改规则语义」处留人工",
                    description: "分析/过滤/翻牌/反馈搬运全自动；唯独「新规则转化成SQL」和「反馈要改规则逻辑」这两步生成草稿后等我一次性批准。",
                  },
                  {
                    label: "自动跑+每日一次汇总确认",
                    description: "全流程自动产出，但每天结束汇总成一份「待确认清单」(新规则草稿/规则变更/异常)，我一次性过目，而不是过程中反复打断。",
                  },
                  {
                    label: "保持现状的人工密度",
                    description: "维持现在每步都可能找我确认的模式，只修复闭环裂缝(游离规则、翻牌缺失)，不改人工边界。",
                  },
                ],
              },
            ],
          },
        },
        { kind: "assistant_message", text: "等你选择", final: true },
        { kind: "completed", finalMessage: "等你选择" },
      ]),
    });

    expect(lark.sent).toEqual([
      {
        groupId: asLarkGroupId("oc_ask_user_fixture"),
        text: [
          "自动化边界",
          "这套日常流水线里，你希望「人工确认」最终保留在哪个程度？(决定整个框架的自动化边界)",
          "",
          "1. 全自动+异常才找我 - 新规则转化、反馈迭代、分析过滤、历史翻牌全部自动跑，只有出错或低置信度的边界 case 才升级给我确认。日常零打扰。",
          "2. 只在「改规则语义」处留人工 - 分析/过滤/翻牌/反馈搬运全自动；唯独「新规则转化成SQL」和「反馈要改规则逻辑」这两步生成草稿后等我一次性批准。",
          "3. 自动跑+每日一次汇总确认 - 全流程自动产出，但每天结束汇总成一份「待确认清单」(新规则草稿/规则变更/异常)，我一次性过目，而不是过程中反复打断。",
          "4. 保持现状的人工密度 - 维持现在每步都可能找我确认的模式，只修复闭环裂缝(游离规则、翻牌缺失)，不改人工边界。",
        ].join("\n"),
      },
    ]);
  });

  test("falls back to a plain question when AskUserQuestion has no options", async () => {
    const lark = createFakeLarkGateway();
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(1_000) },
      monotonic: () => 1_000,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });

    await replier.consume({
      groupId: asLarkGroupId("oc_ask_user_fallback"),
      sessionId: asSessionId("sess_ask_user_fallback"),
      runId: asMessageRunId("mr_ask_user_fallback"),
      sessionName: "amzdata",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream([
        {
          kind: "tool_call",
          callId: "toolu_ask_user_empty",
          name: "AskUserQuestion",
          args: {
            questions: [
              {
                header: "确认",
                id: "confirm",
                question: "是否继续？",
                options: [],
              },
            ],
          },
        },
        { kind: "assistant_message", text: "等你回复", final: true },
        { kind: "completed", finalMessage: "等你回复" },
      ]),
    });

    expect(lark.sent).toEqual([
      {
        groupId: asLarkGroupId("oc_ask_user_fallback"),
        text: "确认\n是否继续？",
      },
    ]);
  });

  for (const config of [
    { backend: "claude" as const, model: "claude-opus-4-7" },
    { backend: "codex" as const, model: "gpt-5.6-sol" },
    { backend: "kimi" as const, model: "kimi-code/k3" },
  ]) {
    test(`${config.backend} final process log keeps narrative and hides tool details`, async () => {
      const lark = createFakeLarkGateway();
      const now = { value: 1_000 };
      const replier = createReplier({
        lark,
        clock: { now: () => asTimestamp(now.value) },
        monotonic: () => now.value,
        reminderSchedule: [60_000],
        idFactory: () => "mr1",
      });
      const narrative =
        "先按三个验证点推进：定位数据源、构造只读复现、再结合同一轮日志判断丢失阶段。" +
        "这段过程说明必须完整保留，不能再被单条一百二十字的展示摘要截断。".repeat(3);

      const result = await replier.consume({
        groupId: asLarkGroupId("oc_1"),
        sessionId: asSessionId("s1"),
        runId: asMessageRunId("mr1"),
        sessionName: "yolo",
        sessionModel: config.model,
        sessionBackend: config.backend,
        stream: mkStream([
          { kind: "started", backendSessionId: `bks-${config.backend}` },
          { kind: "thinking", text: narrative },
          {
            kind: "tool_call",
            callId: "toolu_abc",
            name: "Bash",
            command: "pwd && npm test",
            args: { command: "pwd && npm test" },
          },
          {
            kind: "tool_result",
            callId: "toolu_abc",
            name: "Bash",
            command: "pwd && npm test",
            result: "private tool output",
          },
          { kind: "error", message: "temporary warning", recoverable: true },
          { kind: "assistant_message", text: "done", final: true },
          { kind: "completed", finalMessage: "done" },
        ]),
      });

      const liveCard = [...lark.cards.values()].at(-1);
      expect(liveCard).toContain("🔧 Bash: pwd && npm test");
      expect(liveCard).toContain("✅ Bash: pwd && npm test");

      const [finalCall] = lark.finalized;
      expect(finalCall.processLog).toContain(`🔗 session 启动 (bks-${config.backend})`);
      expect(finalCall.processLog).toContain(`💭 ${narrative}`);
      expect(finalCall.processLog).toContain("❌ temporary warning");
      expect(finalCall.processLog).toContain("💬 done");
      expect(finalCall.processLog).not.toContain("pwd && npm test");
      expect(finalCall.processLog).not.toContain("private tool output");
      expect(finalCall.processLog).toContain("已隐藏 1 次工具调用和 1 次工具结果");
      expect(finalCall.processLog).toContain("DB message_runs");

      expect(result.streamLog).toContainEqual({
        ts: 1_000,
        kind: "tool_call",
        callId: "toolu_abc",
        name: "Bash",
        command: "pwd && npm test",
        args: { command: "pwd && npm test" },
      });
      expect(result.streamLog).toContainEqual({
        ts: 1_000,
        kind: "tool_result",
        callId: "toolu_abc",
        name: "Bash",
        command: "pwd && npm test",
        result: "private tool output",
      });
    });
  }

  for (const config of [
    { backend: "claude" as const, model: "claude-opus-4-7" },
    { backend: "codex" as const, model: "gpt-5.6-sol" },
    { backend: "kimi" as const, model: "kimi-code/k3" },
  ]) {
    test(`${config.backend} stream exceptions remain visible in the final process log`, async () => {
      const lark = createFakeLarkGateway();
      const replier = createReplier({
        lark,
        clock: { now: () => asTimestamp(1_000) },
        monotonic: () => 1_000,
      });

      const result = await replier.consume({
        groupId: asLarkGroupId("oc_1"),
        sessionId: asSessionId("s1"),
        runId: asMessageRunId(`mr_${config.backend}_throw`),
        sessionName: "yolo",
        sessionModel: config.model,
        sessionBackend: config.backend,
        stream: (async function* (): AsyncIterable<AgentEvent> {
          yield { kind: "started", backendSessionId: `bks-${config.backend}` };
          yield { kind: "thinking", text: "正在验证 backend 流异常路径" };
          throw new Error(`${config.backend} transport exploded`);
        })(),
      });

      expect(lark.finalized[0]?.processLog).toContain(
        `❌ ${config.backend} transport exploded`,
      );
      expect(result.streamLog).toContainEqual({
        ts: 1_000,
        kind: "error",
        text: `${config.backend} transport exploded`,
      });
    });
  }

  test("long tool command labels are truncated in the live card", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    const longCommand = `npm test -- ${"tests/app/replier.test.ts ".repeat(10)}`;

    await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream([
        { kind: "tool_call", callId: "toolu_long", name: "Bash", command: longCommand, args: {} },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      ]),
    });

    const liveCard = [...lark.cards.values()].at(-1);
    const toolLine = liveCard?.split("\n").find((line) => line.startsWith("🔧 Bash:"));
    expect(toolLine).toBeTruthy();
    expect(toolLine?.length).toBeLessThanOrEqual(150);
    expect(toolLine).toContain("…");
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
    expect(finalCall.title).toMatch(/· failed \| DEFAULT \| mr1$/u);
  });

  // Live mr_f9c9e220: codex emitted the capacity error FIRST, then a
  // secondary codex_models_manager child-exit-timeout error. The old
  // last-error-wins guard let the second error clobber the capacity root
  // cause. Aligned with collectStream, the FIRST non-terminal error wins.
  test("first non-terminal error wins; later noise does not mask the root cause", async () => {
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
      {
        kind: "error",
        message: "Selected model is at capacity. Please try a different model.",
        recoverable: false,
      },
      {
        kind: "error",
        message:
          "failed to refresh available models: timeout waiting for child process to exit",
        recoverable: false,
      },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "gpt-5.6-terra",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.error).toBe("Selected model is at capacity. Please try a different model.");
    expect(result.runStatus).toBe("failed");
  });

  // Repro: capacity retry ALSO fails. codexRuntimeRecovery emits a non-final
  // "正在自动重试一次…" notice (assistant_message final:false), then the second
  // capacity error passes through. The run is failed, but the old finalText
  // preferred `assistantFallback` over the error, so the card body showed the
  // stale "retrying" notice instead of the actual second capacity error. Body
  // must be the error-prefixed message, not the notice.
  test("failed capacity retry shows the error, not the stale retry notice", async () => {
    const lark = createFakeLarkGateway();
    const now = { value: 1_000 };
    const replier = createReplier({
      lark,
      clock: { now: () => asTimestamp(now.value) },
      monotonic: () => now.value,
      reminderSchedule: [60_000],
      idFactory: () => "mr1",
    });
    // Mirrors CAPACITY_RETRY_NOTICE from codexRuntimeRecovery.ts.
    const retryNotice = "⚠️ codex 模型当前繁忙（at capacity），正在自动重试一次…";
    const events: AgentEvent[] = [
      { kind: "assistant_message", text: retryNotice, final: false },
      { kind: "error", message: "Selected model is at capacity. Please try a different model.", recoverable: false },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "gpt-5.6-terra",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.error).toBe("Selected model is at capacity. Please try a different model.");
    expect(result.runStatus).toBe("failed");
    const [finalCall] = lark.finalized;
    expect(finalCall.text).toBe("❌ Selected model is at capacity. Please try a different model.");
    expect(finalCall.text).not.toContain("正在自动重试一次");
  });

  // Terminal errors still override even after a prior non-terminal first error.
  test("terminal error overrides a prior non-terminal first error", async () => {
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
      { kind: "error", message: "Selected model is at capacity. Please try a different model.", recoverable: false },
      { kind: "error", message: "[TIMEOUT] inactivity: no output for 900s", recoverable: false },
    ];
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "gpt-5.6-terra",
      sessionBackend: "codex",
      stream: mkStream(events),
    });
    expect(result.error).toBe("[TIMEOUT] inactivity: no output for 900s");
    expect(result.runStatus).toBe("timeout");
  });

  test("title omits context usage when usage present and model known", async () => {
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
        model: "claude-opus-4-8",
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
      sessionModel: "claude-opus-4-8",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    const [final] = lark.finalized;
    expect(final.title).toBe("yolo | Opus 4.8 · done | DEFAULT | mr1");
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
    expect(final.title).toBe("yolo | Opus 4.7 · done | DEFAULT | mr1");
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
    expect(final.title).toBe("code | unknown-model · done | DEFAULT | mr1");
  });

  test("Codex title uses runtime model from usage events without context segment", async () => {
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
    expect(final.title).toBe("code | GPT-5.3 Codex Spark · done | DEFAULT | mr1");
  });

  test("Codex title omits context segment even when runtime window is present", async () => {
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
    expect(final.title).toBe("code | Codex · done | DEFAULT | mr1");
  });

  test("Codex title omits context segment when usage lacks runtime window", async () => {
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
    expect(final.title).toBe("code | GPT-5.5 · done | DEFAULT | mr1");
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
    expect(final.title).toBe("code | GPT-5.4 · done | DEFAULT | mr1");
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

    const result = await replier.consume({
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
    expect(result.usage?.latestInputTokens).toBe(73_679);
    expect(result.usage?.latestCacheReadTokens).toBe(13_056);
    expect(result.usage?.latestCacheWriteTokens).toBe(0);
    expect(final.title).toBe("amz-sql | GPT-5.5 · done | DEFAULT | mr1");
  });

  test("multiple running-phase usage events keep title stable and preserve latest usage snapshot", async () => {
    // Usage events still update the collected usage snapshot, but they should
    // not change the card title with context/cache figures.
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
    const result = await replier.consume({
      groupId: asLarkGroupId("oc_1"),
      sessionId: asSessionId("s1"),
      runId: asMessageRunId("mr1"),
      sessionName: "yolo",
      sessionModel: "claude-opus-4-7",
      sessionBackend: "claude",
      stream: mkStream(events),
    });
    const titles = lark.titleHistory.map((t) => t.title ?? "");
    expect(titles).toContain("yolo | Opus 4.7 · running | DEFAULT | mr1");
    expect(titles.some((t) => /\d+(?:\.\d+)?k\/\d+k/u.test(t))).toBe(false);
    expect(result.usage?.latestInputTokens).toBe(20_000);
    expect(result.usage?.latestCacheReadTokens).toBe(5_000);
    const [final] = lark.finalized;
    expect(final.title).toBe("yolo | Opus 4.7 · done | DEFAULT | mr1");
  });

  test("assistant text events stay out of thinking stream log", async () => {
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
      sessionName: "zedong",
      sessionModel: "claude-opus-4-8",
      sessionBackend: "claude",
      stream: mkStream([
        { kind: "started", backendSessionId: "bks-1" },
        { kind: "assistant_message", text: "OK", final: true },
        { kind: "completed", finalMessage: "OK" },
      ]),
    });

    expect(result.finalMessage).toBe("OK");
    expect(result.streamLog).toEqual([
      { ts: 1_000, kind: "assistant_message", text: "OK", final: true },
    ]);
    expect(lark.finalized[0]?.processLog).not.toContain("💭 OK");
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

  describe("formatModel claude latest aliases", () => {
    test("bare aliases display Opus 5 and Sonnet 5 while explicit older models remain supported", () => {
      expect(formatModel("opus", "claude")).toBe("Opus 5");
      expect(formatModel("sonnet", "claude")).toBe("Sonnet 5");
      expect(formatModel("claude-opus-5", "claude")).toBe("Opus 5");
      expect(formatModel("claude-sonnet-5", "claude")).toBe("Sonnet 5");
      expect(formatModel("claude-opus-4-8", "claude")).toBe("Opus 4.8");
      expect(formatModel("claude-opus-4-7", "claude")).toBe("Opus 4.7");
      expect(formatModel("claude-sonnet-4-6", "claude")).toBe("Sonnet 4.6");
    });

    test("uses the verified 1M context window for Opus 5 and Sonnet 5", () => {
      const usage = {
        model: null,
        inputTokens: 1_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        latestInputTokens: 1_000,
        latestCacheReadTokens: 0,
        latestCacheWriteTokens: 0,
        latestContextWindowTokens: null,
        rawUsageJson: null,
      };
      expect(formatContextUsage(usage, "claude-opus-5", "claude")).toBe("1k/1000k");
      expect(formatContextUsage(usage, "claude-sonnet-5", "claude")).toBe("1k/1000k");
    });
  });

  describe("formatContextUsage kimi backend", () => {
    test("uses the confirmed 256K context window for k3-256k", () => {
      const usage = {
        model: null,
        inputTokens: 1_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        latestInputTokens: 1_000,
        latestCacheReadTokens: 0,
        latestCacheWriteTokens: 0,
        latestContextWindowTokens: null,
        rawUsageJson: null,
      };
      expect(formatContextUsage(usage, "kimi-code/k3-256k", "kimi")).toBe("1k/262k");
    });
  });
});
