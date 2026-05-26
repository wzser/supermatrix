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

  test("returns empty finalMessage when stream is empty", async () => {
    const result = await collectStream(events());
    expect(result.finalMessage).toBe("");
    expect(result.backendSessionId).toBeNull();
    expect(result.streamLog).toEqual([]);
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
