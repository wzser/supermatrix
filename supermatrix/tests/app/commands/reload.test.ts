import { describe, expect, test, vi } from "vitest";
import { createReloadHandler } from "../../../src/app/commands/reload.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";

function msg(text: string, receivedAtMs = 0) {
  return { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text, attachments: [], receivedAtMs };
}

function createMockLifecycle() {
  let pendingReason: string | undefined;
  let pendingForce = false;
  let pendingSource: string | undefined;
  return {
    requestRestart: vi.fn((reason: string, opts?: { force?: boolean; source?: string; drainTimeoutMs?: number }) => {
      pendingReason = reason;
      pendingForce = opts?.force ?? false;
      pendingSource = opts?.source;
    }),
    isPending: vi.fn(() => pendingReason !== undefined),
    isForce: vi.fn(() => pendingForce),
    reason: vi.fn(() => pendingReason),
    source: vi.fn(() => pendingSource),
    runStarted: vi.fn(),
    runFinished: vi.fn(),
    inFlightCount: vi.fn().mockReturnValue(0),
  };
}

function setup(sessions: Array<{ name: string; status: string }> = []) {
  const lifecycle = createMockLifecycle();
  const writeNudge = vi.fn();
  const handler = createReloadHandler({
    lifecycle,
    store: { listActiveSessions: async () => sessions },
    dbPath: "/tmp/test/sm.db",
    writeNudge,
  });
  return { lifecycle, handler, writeNudge };
}

describe("reload handler", () => {
  test("ignores a reload message that arrived more than five minutes late", async () => {
    const now = 1_800_000;
    const lifecycle = createMockLifecycle();
    const listActiveSessions = vi.fn(async () => []);
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions },
      now: () => now,
    });

    const result = await handler({
      args: { source: "watchdog-kimi-acp-982f503" },
      scope: "root",
      msg: msg("/reload --source watchdog-kimi-acp-982f503", now - 300_001),
    });

    expect((result as any).replyText).toContain("已忽略过期重启命令");
    expect((result as any).replyText).toContain("watchdog-kimi-acp-982f503");
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects non-root scope", async () => {
    const { handler } = setup();
    await expect(handler({ args: {}, scope: "user", msg: msg("/reload") })).rejects.toThrow(UserError);
  });

  test("default source is 'user (console)'", async () => {
    const { handler, lifecycle } = setup();
    const result = await handler({ args: {}, scope: "root", msg: msg("/reload") });
    expect((result as any).replyText).toContain("来源：user (console)");
    expect(lifecycle.source()).toBe("user (console)");
  });

  test("--source flag sets custom source", async () => {
    const { handler, lifecycle } = setup();
    const result = await handler({ args: { source: "scheduler" }, scope: "root", msg: msg("/reload --source scheduler") });
    expect((result as any).replyText).toContain("来源：scheduler");
    expect(lifecycle.source()).toBe("scheduler");
  });

  test("--source with --force shows source in reply", async () => {
    const busy = [{ name: "sess-a", status: "busy" }];
    const { handler, lifecycle } = setup(busy);
    const result = await handler({
      args: { name: "--force", source: "watchdog-daily-restart" },
      scope: "root",
      msg: msg("/reload --force --source watchdog-daily-restart"),
    });
    expect((result as any).replyText).toContain("来源：watchdog-daily-restart");
    expect((result as any).replyText).toContain("强制重启");
    expect(lifecycle.source()).toBe("watchdog-daily-restart");
    expect(lifecycle.isForce()).toBe(true);
  });

  test("busy sessions queue a drained reload instead of a silent hang or hard reject", async () => {
    const busy = [{ name: "sess-a", status: "busy" }];
    const { handler, lifecycle } = setup(busy);
    const result = await handler({ args: { source: "scheduler" }, scope: "root", msg: msg("/reload --source scheduler") });
    // Truthful, non-silent: names what's blocking and states the drain→force behavior.
    expect((result as any).replyText).toContain("已排队重启");
    expect((result as any).replyText).toContain("sess-a");
    expect((result as any).replyText).toMatch(/force/i);
    // Accepted with a bounded drain window (no longer a hard rejection).
    expect(lifecycle.isPending()).toBe(true);
    expect(lifecycle.isForce()).toBe(false);
    expect(lifecycle.requestRestart).toHaveBeenCalledWith(
      "/reload",
      expect.objectContaining({ force: false, drainTimeoutMs: expect.any(Number) }),
    );
  });

  test("in-flight runs with no top-level busy session still report queued (not silent accept)", async () => {
    // The exact skew that produced the incident: DB shows every top-level
    // session idle, but the lifecycle counter has runs in flight.
    const lifecycle = createMockLifecycle();
    lifecycle.inFlightCount.mockReturnValue(3);
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions: async () => [{ name: "sess-a", status: "idle" }] },
    });
    const result = await handler({ args: {}, scope: "root", msg: msg("/reload") });
    expect((result as any).replyText).toContain("已排队重启");
    expect((result as any).replyText).toContain("3 个 run 在飞");
    expect(lifecycle.isPending()).toBe(true);
    expect(lifecycle.isForce()).toBe(false);
  });

  test("force reload with busy sessions does not write or promise a nudge", async () => {
    const busy = [
      { name: "sess-a", status: "busy" },
      { name: "sess-b", status: "busy" },
      { name: "sess-c", status: "idle" },
    ];
    const { handler, lifecycle, writeNudge } = setup(busy);
    const result = await handler({
      args: { name: "--force", source: "watchdog-daily-restart" },
      scope: "root",
      msg: msg("/reload --force --source watchdog-daily-restart"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("催一句");
    expect((result as any).replyText).not.toContain("完成了吗？没完成就继续");
    expect(lifecycle.isPending()).toBe(true);
    expect(lifecycle.isForce()).toBe(true);
  });

  test("force reload without any busy session does not write nudge", async () => {
    const { handler, writeNudge } = setup([{ name: "sess-a", status: "idle" }]);
    const result = await handler({
      args: { name: "--force" },
      scope: "root",
      msg: msg("/reload --force"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("催一句");
  });

  test("non-force reload never writes nudge", async () => {
    const { handler, writeNudge } = setup([{ name: "sess-a", status: "idle" }]);
    await handler({ args: {}, scope: "root", msg: msg("/reload") });
    expect(writeNudge).not.toHaveBeenCalled();
  });

  test("force reload ignores legacy nudge writer dependency", async () => {
    const busy = [{ name: "sess-a", status: "busy" }];
    const lifecycle = createMockLifecycle();
    const writeNudge = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions: async () => busy },
      writeNudge,
    });
    const result = await handler({
      args: { name: "--force" },
      scope: "root",
      msg: msg("/reload --force"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("nudge");
    expect((result as any).replyText).not.toContain("催一句");
    expect(lifecycle.isPending()).toBe(true);
  });

  test("explicit force tokens force the restart", async () => {
    for (const token of ["force", "强制", "--强制", "FORCE", "ＦＯＲＣＥ"]) {
      const busy = [{ name: "sess-a", status: "busy" }];
      const { handler, lifecycle } = setup(busy);
      const result = await handler({ args: { name: token }, scope: "root", msg: msg(`/reload ${token}`) });
      expect((result as any).replyText).toContain("强制重启");
      expect(lifecycle.isForce()).toBe(true);
    }
  });

  test.each(["frce", "--forc", "sess-a"])(
    "/reload %s fails closed before any restart signal",
    async (token) => {
      const listActiveSessions = vi.fn(async () => [{ name: "sess-a", status: "busy" }]);
      const lifecycle = createMockLifecycle();
      const handler = createReloadHandler({ lifecycle, store: { listActiveSessions } });
      await expect(
        handler({ args: { name: token }, scope: "root", msg: msg(`/reload ${token}`) }),
      ).rejects.toThrow(UserError);
      expect(listActiveSessions).not.toHaveBeenCalled();
      expect(lifecycle.requestRestart).not.toHaveBeenCalled();
      expect(lifecycle.isPending()).toBe(false);
      expect(lifecycle.isForce()).toBe(false);
    },
  );

  test("no argument remains a normal safe reload", async () => {
    const { handler, lifecycle } = setup([{ name: "sess-a", status: "idle" }]);
    const result = await handler({ args: {}, scope: "root", msg: msg("/reload") });
    expect((result as any).replyText).toContain("重启中");
    expect(lifecycle.isForce()).toBe(false);
    expect(lifecycle.isPending()).toBe(true);
  });
});
