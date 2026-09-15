import { describe, expect, test } from "vitest";
import { collectStream } from "../../src/app/streamCollector.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";

async function* events(...items: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const item of items) yield item;
}

describe("collectStream", () => {
  test("joins all assistant_message texts into finalMessage (codex commentary + final)", async () => {
    const result = await collectStream(
      events(
        { kind: "started", backendSessionId: "bks-1" },
        { kind: "assistant_message", text: "partial", final: false },
        { kind: "assistant_message", text: "done", final: true },
        { kind: "completed", finalMessage: "done" },
      )
    );
    expect(result.finalMessage).toBe("partial\n\ndone");
    expect(result.backendSessionId).toBe("bks-1");
    expect(result.streamLog).toHaveLength(2);
  });

  test("keeps assistant text before tool_use when completed carries only the short result", async () => {
    const result = await collectStream(
      events(
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
      ),
    );

    expect(result.finalMessage).toBe("正文先出来，后面还会读文件。\n\n短尾巴");
    expect(result.streamLog).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        text: "正文先出来，后面还会读文件。",
        final: false,
      }),
      expect.objectContaining({
        kind: "tool_call",
        callId: "toolu_read",
        name: "Read",
      }),
      expect.objectContaining({
        kind: "tool_result",
        callId: "toolu_read",
        name: "Read",
      }),
      expect.objectContaining({
        kind: "assistant_message",
        text: "短尾巴",
        final: true,
      }),
    ]);
  });

  test("uses final assistant_message when no completed event", async () => {
    const result = await collectStream(
      events(
        { kind: "started", backendSessionId: "bks-2" },
        { kind: "assistant_message", text: "answer", final: true },
      )
    );
    expect(result.finalMessage).toBe("answer");
    expect(result.backendSessionId).toBe("bks-2");
  });

  test("captures error", async () => {
    const result = await collectStream(
      events(
        { kind: "started", backendSessionId: "bks-3" },
        { kind: "error", message: "boom", recoverable: false },
      )
    );
    expect(result.error).toBe("boom");
    expect(result.backendSessionId).toBe("bks-3");
    expect(result.streamLog).toEqual([
      expect.objectContaining({ kind: "error", text: "boom" }),
    ]);
  });

  test("preserves usage observed before the stream iterator throws", async () => {
    async function* brokenStream(): AsyncIterable<AgentEvent> {
      yield { kind: "started", backendSessionId: "bks-partial" };
      yield {
        kind: "usage",
        model: "gpt-5.6-terra",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        rawUsage: { input_tokens: 180, cached_input_tokens: 80, output_tokens: 25 },
      };
      throw new Error("transport lost");
    }

    const result = await collectStream(brokenStream());
    expect(result.error).toBe("transport lost");
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      reasoningTokens: 5,
    });
  });

  test("marks a stream with no final output or completion receipt as failed", async () => {
    const result = await collectStream(events());
    expect(result.finalMessage).toBe("");
    expect(result.backendSessionId).toBeNull();
    expect(result.error).toBe("backend stream ended without final output or completion receipt");
    expect(result.streamLog).toEqual([
      expect.objectContaining({
        kind: "error",
        text: "backend stream ended without final output or completion receipt",
      }),
    ]);
  });

  test("first non-terminal error wins; later non-terminal errors do not overwrite", async () => {
    // Repro of the 21:22 incident: codex 400 (gpt-5.3 not supported) fires
    // first, then codex CLI's "Reading additional input from stdin..." stderr
    // arrives as a second error event. Without this guard the useless second
    // one overwrites the informative first one in error_message.
    const result = await collectStream(
      events(
        { kind: "started", backendSessionId: "bks-err" },
        {
          kind: "error",
          message: "gpt-5.3 not supported with ChatGPT account",
          recoverable: false,
        },
        {
          kind: "error",
          message: "Reading additional input from stdin...",
          recoverable: false,
        },
      ),
    );
    expect(result.error).toBe("gpt-5.3 not supported with ChatGPT account");
    expect(result.streamLog).toHaveLength(2);
  });

  test("terminal error ([TIMEOUT]) overrides a prior non-terminal error", async () => {
    const result = await collectStream(
      events(
        { kind: "started", backendSessionId: "bks-term" },
        { kind: "error", message: "transient blip", recoverable: false },
        { kind: "error", message: "[TIMEOUT] inactivity: no output for 60s", recoverable: false },
      ),
    );
    expect(result.error).toBe("[TIMEOUT] inactivity: no output for 60s");
  });

  test("terminal error (cancelled by user) overrides a prior non-terminal error", async () => {
    const result = await collectStream(
      events(
        { kind: "error", message: "transient blip", recoverable: false },
        { kind: "error", message: "cancelled by user", recoverable: false },
      ),
    );
    expect(result.error).toBe("cancelled by user");
  });
});
