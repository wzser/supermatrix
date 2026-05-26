import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import { spawnAndStream } from "../../../src/adapters/backend-codex/process.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeCodex.sh");

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

  test("known stderr noise filtered + stdout API error wins (5/7 21:22 regression)", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["noise-with-api-error"], cwd: "/tmp" });
    const { events } = await collectAll(handle);
    const errors = events.filter((e) => e.kind === "error");
    // Only ONE error pushed: the API error. The "Reading additional input
    // from stdin..." noise is filtered, and `exit 1` is suppressed because
    // sawError=true and filteredStderr is empty.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      kind: "error",
      message: expect.stringContaining("gpt-5.3 not supported"),
    });
    expect(errors.some((e) => e.kind === "error" && e.message.includes("Reading additional input"))).toBe(false);
    expect(errors.some((e) => e.kind === "error" && e.message === "exit 1")).toBe(false);
  });

  test("noise-only stderr + exit!=0 still pushes exit code (no real failure swallowed)", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["noise-only-no-stdout-error"], cwd: "/tmp" });
    const { events } = await collectAll(handle);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: "error", message: "exit 2" });
  });

  test("real stderr + exit!=0 still surfaces the real stderr content", async () => {
    const handle = spawnAndStream({ command: FAKE, args: ["real-stderr-and-exit"], cwd: "/tmp" });
    const { events } = await collectAll(handle);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    // "Reading additional input..." stripped, "permission denied" preserved.
    expect(errors[0]?.kind).toBe("error");
    if (errors[0]?.kind === "error") {
      expect(errors[0].message).toContain("permission denied");
      expect(errors[0].message).not.toContain("Reading additional input");
    }
  });

  test("mirrors lowercase proxy vars into uppercase for the Codex child", async () => {
    const handle = spawnAndStream({
      command: FAKE,
      args: ["env-proxy"],
      cwd: "/tmp",
      env: {
        https_proxy: "http://127.0.0.1:7897",
        http_proxy: "http://127.0.0.1:7897",
        all_proxy: "socks5://127.0.0.1:7897",
      },
    });
    const { events } = await collectAll(handle);
    const final = events.find((event) => event.kind === "completed");
    expect(final).toMatchObject({
      kind: "completed",
      finalMessage:
        "HTTPS_PROXY=http://127.0.0.1:7897;HTTP_PROXY=http://127.0.0.1:7897;ALL_PROXY=socks5://127.0.0.1:7897",
    });
  });

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
