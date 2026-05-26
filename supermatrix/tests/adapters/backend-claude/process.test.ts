import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import { spawnAndStream } from "../../../src/adapters/backend-claude/process.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeClaude.sh");

async function collectAll(handle: Awaited<ReturnType<typeof spawnAndStream>>): Promise<{ events: AgentEvent[]; done: true }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.iterable) {
    events.push(e);
  }
  return { events, done: true };
}

describe("spawnAndStream", () => {
  test("happy path yields started + completed", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["happy"], cwd: "/tmp" });
    const { events } = await collectAll(handle);
    expect(events[0]?.kind).toBe("started");
    expect(events.some((e) => e.kind === "completed")).toBe(true);
  });

  test("writes provided stdin to the subprocess", async () => {
    const handle = spawnAndStream({
      command: "/bin/sh",
      args: [
        "-c",
        "if IFS= read -r line && [ \"$line\" = expected ]; then printf '%s\\n' '{\"type\":\"system\",\"session_id\":\"s\"}' '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"stdin-ok\",\"session_id\":\"s\"}'; else exit 7; fi",
      ],
      cwd: "/tmp",
      stdin: "expected\n",
    });
    const { events } = await collectAll(handle);

    expect(events.some((e) => e.kind === "completed" && e.finalMessage === "stdin-ok")).toBe(true);
  });

  test("cancel terminates a slow process", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["slow"], cwd: "/tmp" });
    const events: AgentEvent[] = [];
    const collectP = (async () => {
      for await (const e of handle.iterable) {
        events.push(e);
      }
    })();
    // Cancel after 100ms
    await new Promise((r) => setTimeout(r, 100));
    handle.cancel();
    await collectP;
    // After cancel, the stream should end; should have at least started event
    expect(events.some((e) => e.kind === "error" || e.kind === "started")).toBe(true);
  }, 10_000);

  test("SIGKILL fallback if SIGTERM is ignored", async () => {
    const handle = spawnAndStream({
      command: FAKE,
      args: ["ignore-sigterm"],
      cwd: "/tmp",
      killGraceMs: 500,
    });
    // Collect events in background, cancel after 100ms
    const events: AgentEvent[] = [];
    const collectP = (async () => {
      for await (const e of handle.iterable) {
        events.push(e);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    handle.cancel();
    await collectP;
    // Should have received an error event (cancelled by user)
    expect(events.some((e) => e.kind === "error")).toBe(true);
  }, 10_000);
});
