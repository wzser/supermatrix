import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";

// M2 regression: a failed steer write must poison the write chain so later
// queued steer payloads are never written to Claude's stdin. Reproducing a
// write-callback failure while the pipe stays otherwise healthy is not
// possible with a real subprocess, so this file mocks spawn with a scripted
// stdin whose write() fails for exactly one payload.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { spawnAndStream } from "../../../src/adapters/backend-claude/process.ts";

function userEnvelope(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n";
}

function makeFakeChild(failOn: (payload: string) => boolean) {
  const writes: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write(data: string, cb?: (err?: Error | null) => void): boolean {
      writes.push(data);
      if (failOn(data)) cb?.(new Error("synthetic stdin write failure"));
      else cb?.();
      return true;
    },
    end(): void {},
  });
  const stdout = Object.assign(new EventEmitter(), { setEncoding(): void {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding(): void {} });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    unref(): void {},
    kill(): void {},
  });
  return { child, writes };
}

describe("spawnAndStream steer write-chain poisoning", () => {
  test("a steer write failure short-circuits later queued steer payloads", async () => {
    const { child, writes } = makeFakeChild((data) => data.includes("steer-A"));
    spawnMock.mockReturnValue(child);
    const handle = spawnAndStream({
      command: "claude",
      args: [],
      cwd: "/tmp",
      stdin: userEnvelope("initial"),
    });

    // Both steers are queued before A's write fails; the failure settles both
    // rejections, and B's envelope must then never reach the child — a "❌
    // 注入失败" receipt with the text still injected is the bug under test.
    const a = handle.steer("steer-A");
    const b = handle.steer("steer-B");
    await expect(a).rejects.toThrow("synthetic stdin write failure");
    await expect(b).rejects.toThrow("synthetic stdin write failure");

    expect(writes.some((w) => w.includes("steer-A"))).toBe(true);
    expect(writes.some((w) => w.includes("steer-B"))).toBe(false);

    // A steer arriving after the poisoning rejects without writing either.
    await expect(handle.steer("steer-C")).rejects.toThrow("synthetic stdin write failure");
    expect(writes.some((w) => w.includes("steer-C"))).toBe(false);

    child.emit("close", 0);
    for await (const _ of handle.iterable) {
      // drain to completion
    }
  });
});
