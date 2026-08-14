import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AppServerNotification } from "../../../src/adapters/backend-codex/appServerProtocol.ts";
import {
  spawnAppServerProcess,
  type AppServerProcessOptions,
} from "../../../src/adapters/backend-codex/appServerProcess.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeCodexAppServer.mjs");

function notificationCollector() {
  const seen: AppServerNotification[] = [];
  const waiters: { method: string; resolve: (n: AppServerNotification) => void }[] = [];
  const onNotification = (n: AppServerNotification): void => {
    seen.push(n);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.method === n.method) {
        waiters.splice(i, 1)[0]!.resolve(n);
      }
    }
  };
  const waitFor = (method: string): Promise<AppServerNotification> => {
    const already = seen.find((n) => n.method === method);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => waiters.push({ method, resolve }));
  };
  return { seen, waitFor, onNotification };
}

function spawnFake(scenario: string, extra?: Partial<AppServerProcessOptions>) {
  return spawnAppServerProcess({
    command: process.execPath,
    args: [FAKE, scenario],
    cwd: "/tmp",
    ...extra,
  });
}

describe("spawnAppServerProcess", () => {
  test("full lifecycle: initialize/initialized, thread/start, turn/start, steer, graceful EOF exit", async () => {
    const collector = notificationCollector();
    const handle = spawnFake("happy", { onNotification: collector.onNotification });
    expect(handle.pid).toBeGreaterThan(0);

    await expect(
      handle.protocol.initialize({ clientInfo: { name: "supermatrix", version: "0.0.0-test" } }),
    ).resolves.toEqual({ userAgent: "fake-codex-app-server" });
    handle.protocol.initialized();
    // The fake acknowledges the id-less `initialized` notification.
    await expect(collector.waitFor("fake/ack")).resolves.toEqual({
      method: "fake/ack",
      params: { seen: "initialized" },
    });

    // The fake emits thread/started BEFORE the thread/start response: the
    // response still correlates and the notification is not lost.
    await expect(handle.protocol.threadStart({ cwd: "/tmp" })).resolves.toMatchObject({
      thread: { id: "fake-thread-1" },
    });
    await expect(collector.waitFor("thread/started")).resolves.toMatchObject({
      params: { thread: { id: "fake-thread-1" } },
    });

    await expect(
      handle.protocol.turnStart({ threadId: "fake-thread-1", input: [{ type: "text", text: "hello" }] }),
    ).resolves.toMatchObject({ turn: { id: "fake-turn-1", status: "inProgress" } });
    await expect(collector.waitFor("item/completed")).resolves.toMatchObject({
      params: { item: { type: "agentMessage", text: "echo:hello" } },
    });
    await expect(collector.waitFor("turn/completed")).resolves.toMatchObject({
      params: { turn: { id: "fake-turn-1", status: "completed" } },
    });

    await expect(
      handle.protocol.turnSteer({
        threadId: "fake-thread-1",
        expectedTurnId: "fake-turn-1",
        input: [{ type: "text", text: "nudge" }],
      }),
    ).resolves.toEqual({ turnId: "fake-turn-1" });

    expect(handle.protocol.pendingCount()).toBe(0);
    handle.endInput();
    await expect(handle.exited).resolves.toEqual({ code: 0, signal: null, stderr: "" });
  });

  test("thread/resume flows through with the persisted thread id", async () => {
    const handle = spawnFake("happy");
    await handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    await expect(handle.protocol.threadResume({ threadId: "persisted-thread-42" })).resolves.toMatchObject({
      thread: { id: "persisted-thread-42" },
    });
    // One transport = one run: no second establishment on the same process.
    await expect(handle.protocol.threadStart({})).rejects.toThrow("one app-server transport serves one run");
    handle.endInput();
    await handle.exited;
  });

  test("out-of-order responses over real stdio correlate by id", async () => {
    const collector = notificationCollector();
    const handle = spawnFake("out-of-order", { onNotification: collector.onNotification });
    // Fire two requests concurrently; the fake parks the first and answers
    // the second first, with a notification interleaved between them.
    const initP = handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    const threadP = handle.protocol.threadStart({});
    await expect(initP).resolves.toEqual({ method: "initialize", order: "responded-second" });
    await expect(threadP).resolves.toEqual({ method: "thread/start", order: "responded-first" });
    await expect(collector.waitFor("fake/interleaved")).resolves.toMatchObject({
      params: { between: [1, 2] },
    });
    handle.endInput();
    await handle.exited;
  });

  test("JSON-RPC error response rejects only that request; process stays usable", async () => {
    const handle = spawnFake("rpc-error");
    await handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    await expect(handle.protocol.threadStart({})).rejects.toMatchObject({
      name: "AppServerRpcError",
      code: -32000,
      message: "thread/start: thread/start rejected by fake",
    });
    // The transport is not poisoned by a JSON-RPC-level error.
    await expect(handle.protocol.turnInterrupt({ threadId: "t" })).rejects.toMatchObject({ code: -32000 });
    handle.endInput();
    await expect(handle.exited).resolves.toMatchObject({ code: 0 });
  });

  test("process close mid-request rejects pending requests and poisons the handle", async () => {
    const handle = spawnFake("close-mid-request");
    await handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    const p = handle.protocol.threadStart({});
    await expect(p).rejects.toThrow(/thread\/start failed before response: codex app-server closed \(exit 3\)/u);
    await expect(p).rejects.toThrow(/fake app-server exploding/u);
    const exit = await handle.exited;
    expect(exit.code).toBe(3);
    expect(exit.stderr).toContain("fake app-server exploding");
    // Requests after close reject immediately without hanging.
    await expect(handle.protocol.turnStart({ threadId: "t", input: [] })).rejects.toThrow(
      "codex app-server closed (exit 3)",
    );
    expect(handle.protocol.pendingCount()).toBe(0);
  });

  test("spawn failure rejects pending requests instead of hanging", async () => {
    const handle = spawnAppServerProcess({
      command: "/nonexistent/definitely-not-codex",
      args: [],
      cwd: "/tmp",
    });
    const p = handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    await expect(p).rejects.toThrow(/initialize failed before response/u);
    const exit = await handle.exited;
    expect(exit.code).toBeNull();
    expect(exit.stderr).toContain("ENOENT");
  });

  test("kill() terminates the process group and rejects pending requests", async () => {
    const handle = spawnFake("hang-after-initialize");
    await handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } }); // child is up
    const steerP = handle.protocol.turnSteer({ threadId: "t", expectedTurnId: "x", input: [] });
    // The fake parks turn/steer forever, so it is still pending at kill time.
    handle.kill();
    await expect(steerP).rejects.toThrow(/codex app-server killed|turn\/steer failed before response/u);
    const exit = await handle.exited;
    expect(exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code !== 0).toBe(true);
  }, 10_000);

  test("SIGKILL fallback when SIGTERM is ignored", async () => {
    const handle = spawnFake("ignore-sigterm", { killGraceMs: 300 });
    const p = handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    // Give the child a moment to install its SIGTERM trap.
    await new Promise((r) => setTimeout(r, 200));
    handle.kill();
    await expect(p).rejects.toThrow(/codex app-server killed|initialize failed before response/u);
    const exit = await handle.exited;
    expect(exit.signal).toBe("SIGKILL");
  }, 10_000);

  test("asynchronous stdin EPIPE fails pending requests instead of crashing the parent", async () => {
    // The child answers initialize, then closes its stdin READ end while
    // staying alive (`exec 0<&-`; a node fake cannot do this — closing fd 0
    // under libuv aborts the child). The next parent write passes the
    // synchronous destroyed/writable guard and hits an asynchronous EPIPE;
    // without an stdin error handler that is an uncaughtException that takes
    // down the whole parent process.
    const initReply = '{"jsonrpc":"2.0","id":1,"result":{"userAgent":"fake-sh-app-server"}}';
    const handle = spawnAppServerProcess({
      command: "/bin/sh",
      args: ["-c", `IFS= read -r line; printf '%s\\n' '${initReply}'; exec 0<&-; sleep 5`],
      cwd: "/tmp",
    });
    await handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } });
    const outcomes: Promise<unknown>[] = [];
    let poisoned = false;
    for (let i = 0; i < 40; i++) {
      outcomes.push(
        handle.protocol.turnInterrupt({ threadId: "t" }).then(
          () => "resolved",
          (err: unknown) => err,
        ),
      );
      await new Promise((r) => setTimeout(r, 25));
      if (handle.protocol.pendingCount() === 0) {
        poisoned = true;
        break;
      }
    }
    expect(poisoned).toBe(true);
    const settled = await Promise.all(outcomes);
    expect(settled.every((v) => v instanceof Error)).toBe(true);
    // The transport is poisoned: later requests reject immediately.
    await expect(
      handle.protocol.turnSteer({ threadId: "t", expectedTurnId: "x", input: [] }),
    ).rejects.toThrow();
    handle.kill();
    await handle.exited;
  }, 10_000);

  test("mirrors lowercase proxy vars into uppercase for the app-server child", async () => {
    const handle = spawnFake("env-proxy", {
      env: {
        https_proxy: "http://127.0.0.1:7897",
        http_proxy: "http://127.0.0.1:7897",
        all_proxy: "socks5://127.0.0.1:7897",
      },
    });
    await expect(handle.protocol.initialize({ clientInfo: { name: "sm", version: "1" } })).resolves.toEqual({
      httpsProxy: "http://127.0.0.1:7897",
      httpProxy: "http://127.0.0.1:7897",
      allProxy: "socks5://127.0.0.1:7897",
    });
    handle.endInput();
    await handle.exited;
  });
});
