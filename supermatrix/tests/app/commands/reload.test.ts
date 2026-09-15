import { describe, expect, test, vi } from "vitest";
import { createReloadHandler } from "../../../src/app/commands/reload.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";

function msg(text: string, receivedAtMs = 0) {
  return { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text, attachments: [], receivedAtMs };
}

const TEST_PERMIT = "smrp_0123456789abcdef0123456789abcdef";
const TEST_GRANT = {
  callerRunId: "run_codexroot_test",
  callerSessionId: "sess_codexroot_test",
};

function activeSession(name: string, status: string) {
  return { id: `id_${name}`, name, status };
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
    inFlightCountExcluding: vi.fn().mockReturnValue(0),
  };
}

function setup(sessions: Array<{ id: string; name: string; status: string }> = []) {
  const lifecycle = createMockLifecycle();
  const writeNudge = vi.fn();
  const handler = createReloadHandler({
    lifecycle,
    store: { listActiveSessions: async () => sessions },
    consumePermit: vi.fn(async () => TEST_GRANT),
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
      consumePermit: vi.fn(async () => TEST_GRANT),
      now: () => now,
    });

    const result = await handler({
      args: { source: "scheduled-daily", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --source scheduled-daily", now - 300_001),
    });

    expect((result as any).replyText).toContain("已忽略过期重启命令");
    expect((result as any).replyText).toContain("scheduled-daily");
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects non-root scope", async () => {
    const { handler } = setup();
    await expect(handler({ args: {}, scope: "user", msg: msg("/reload") })).rejects.toThrow(UserError);
  });

  test("rejects direct manual reload before reading sessions or signaling restart", async () => {
    const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "idle")]);
    const lifecycle = createMockLifecycle();
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions },
      consumePermit: vi.fn(async () => TEST_GRANT),
    });

    await expect(handler({ args: {}, scope: "root", msg: msg("/reload") })).rejects.toThrow(
      "全局 reload 已收口到 codexroot",
    );
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects direct manual force before reading sessions or signaling restart", async () => {
    const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "busy")]);
    const lifecycle = createMockLifecycle();
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions },
      consumePermit: vi.fn(async () => TEST_GRANT),
    });

    await expect(
      handler({ args: { name: "force" }, scope: "root", msg: msg("/reload force") }),
    ).rejects.toThrow("全局 reload 已收口到 codexroot");
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("accepts the one scheduler-owned daily source", async () => {
    const { handler, lifecycle } = setup();
    const result = await handler({
      args: { source: "scheduled-daily", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source scheduled-daily --permit ${TEST_PERMIT}`),
    });
    expect((result as any).replyText).toContain("来源：scheduled-daily");
    expect(lifecycle.source()).toBe("scheduled-daily");
  });

  test("accepts the codexroot maintenance gate source", async () => {
    const { handler, lifecycle } = setup();
    const result = await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source codexroot-maintenance --permit ${TEST_PERMIT}`),
    });
    expect((result as any).replyText).toContain("来源：codexroot-maintenance");
    expect(lifecycle.source()).toBe("codexroot-maintenance");
  });

  test("rejects unapproved automatic sources before reading sessions or signaling restart", async () => {
    const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "busy")]);
    const lifecycle = createMockLifecycle();
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions },
      consumePermit: vi.fn(async () => TEST_GRANT),
    });

    await expect(
      handler({ args: { source: "localwatch-kimi-health" }, scope: "root", msg: msg("/reload --source localwatch-kimi-health") }),
    ).rejects.toThrow(UserError);
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects force on the scheduler-owned daily source", async () => {
    const busy = [activeSession("sess-a", "busy")];
    const { handler, lifecycle } = setup(busy);
    await expect(handler({
      args: { name: "--force", source: "scheduled-daily" },
      scope: "root",
      msg: msg("/reload --force --source scheduled-daily"),
    })).rejects.toThrow(UserError);
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects an allowed source without a one-shot gate permit", async () => {
    const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "idle")]);
    const lifecycle = createMockLifecycle();
    const consumePermit = vi.fn(async () => TEST_GRANT);
    const handler = createReloadHandler({ lifecycle, store: { listActiveSessions }, consumePermit });

    await expect(handler({
      args: { source: "codexroot-maintenance" },
      scope: "root",
      msg: msg("/reload --source codexroot-maintenance"),
    })).rejects.toThrow("一次性 permit");
    expect(consumePermit).not.toHaveBeenCalled();
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("rejects a forged or already-consumed permit before reading sessions", async () => {
    const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "idle")]);
    const lifecycle = createMockLifecycle();
    const consumePermit = vi.fn(async () => false as const);
    const handler = createReloadHandler({ lifecycle, store: { listActiveSessions }, consumePermit });

    await expect(handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source codexroot-maintenance --permit ${TEST_PERMIT}`),
    })).rejects.toThrow("无效、过期或已消费");
    expect(consumePermit).toHaveBeenCalledWith({
      nonce: TEST_PERMIT,
      source: "codexroot-maintenance",
      force: false,
      receivedAtMs: 0,
    });
    expect(listActiveSessions).not.toHaveBeenCalled();
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("a busy race rejects safe reload without leaving a pending restart", async () => {
    const busy = [activeSession("sess-a", "busy")];
    const { handler, lifecycle } = setup(busy);
    const result = await handler({
      args: { source: "scheduled-daily", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source scheduled-daily --permit ${TEST_PERMIT}`),
    });
    // Gate-side idle can race with a new run; the handler is the final fail-closed check.
    expect((result as any).replyText).toContain("已拒绝重启");
    expect((result as any).replyText).toContain("sess-a");
    expect((result as any).replyText).toContain("未登记 pending reload");
    expect(lifecycle.isPending()).toBe(false);
    expect(lifecycle.isForce()).toBe(false);
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("an in-flight race with no top-level busy session rejects without pending", async () => {
    // The exact skew that produced the incident: DB shows every top-level
    // session idle, but the lifecycle counter has runs in flight.
    const lifecycle = createMockLifecycle();
    lifecycle.inFlightCount.mockReturnValue(3);
    lifecycle.inFlightCountExcluding.mockReturnValue(3);
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions: async () => [activeSession("sess-a", "idle")] },
      consumePermit: vi.fn(async () => TEST_GRANT),
    });
    const result = await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --source codexroot-maintenance"),
    });
    expect((result as any).replyText).toContain("已拒绝重启");
    expect((result as any).replyText).toContain("3 个 run 在飞");
    expect((result as any).replyText).toContain("未登记 pending reload");
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
    expect(lifecycle.isPending()).toBe(false);
    expect(lifecycle.isForce()).toBe(false);
  });

  test("allows only the exact attested maintenance run to be excluded from in-flight", async () => {
    const lifecycle = createMockLifecycle();
    lifecycle.inFlightCount.mockReturnValue(1);
    lifecycle.inFlightCountExcluding.mockReturnValue(0);
    const consumePermit = vi.fn(async () => TEST_GRANT);
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions: async () => [] },
      consumePermit,
    });

    const result = await handler({
      args: { source: "scheduled-daily", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source scheduled-daily --permit ${TEST_PERMIT}`),
    });

    expect((result as any).replyText).toContain("重启中");
    expect(lifecycle.inFlightCountExcluding).toHaveBeenCalledWith("run_codexroot_test");
    expect(lifecycle.requestRestart).toHaveBeenCalledWith("/reload", {
      force: false,
      source: "scheduled-daily",
      ignoreInFlightRunId: "run_codexroot_test",
    });
  });

  test("does not count the exact permit caller session as a busy reload blocker", async () => {
    const lifecycle = createMockLifecycle();
    lifecycle.inFlightCountExcluding.mockReturnValue(0);
    const handler = createReloadHandler({
      lifecycle,
      store: {
        listActiveSessions: async () => [
          { id: "sess_codexroot_test", name: "codexroot", status: "busy" },
        ],
      },
      consumePermit: vi.fn(async () => ({
        callerRunId: "run_codexroot_test",
        callerSessionId: "sess_codexroot_test",
      })),
    });

    const result = await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source codexroot-maintenance --permit ${TEST_PERMIT}`),
    });

    expect((result as any).replyText).toContain("重启中");
    expect(lifecycle.requestRestart).toHaveBeenCalledWith("/reload", {
      force: false,
      source: "codexroot-maintenance",
      ignoreInFlightRunId: "run_codexroot_test",
    });
  });

  test("still blocks when another run in the permit caller session is in flight", async () => {
    const lifecycle = createMockLifecycle();
    lifecycle.inFlightCountExcluding.mockReturnValue(1);
    const handler = createReloadHandler({
      lifecycle,
      store: {
        listActiveSessions: async () => [
          { id: "sess_codexroot_test", name: "codexroot", status: "busy" },
        ],
      },
      consumePermit: vi.fn(async () => TEST_GRANT),
    });

    const result = await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg(`/reload --source codexroot-maintenance --permit ${TEST_PERMIT}`),
    });

    expect((result as any).replyText).toContain("1 个 run 在飞");
    expect((result as any).replyText).not.toContain("busy session：codexroot");
    expect(lifecycle.requestRestart).not.toHaveBeenCalled();
  });

  test("force reload with busy sessions does not write or promise a nudge", async () => {
    const busy = [
      activeSession("sess-a", "busy"),
      activeSession("sess-b", "busy"),
      activeSession("sess-c", "idle"),
    ];
    const { handler, lifecycle, writeNudge } = setup(busy);
    const result = await handler({
      args: { name: "--force", source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --force --source codexroot-maintenance"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("催一句");
    expect((result as any).replyText).not.toContain("完成了吗？没完成就继续");
    expect(lifecycle.isPending()).toBe(true);
    expect(lifecycle.isForce()).toBe(true);
  });

  test("force reload without any busy session does not write nudge", async () => {
    const { handler, writeNudge } = setup([activeSession("sess-a", "idle")]);
    const result = await handler({
      args: { name: "--force", source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --force --source codexroot-maintenance"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("催一句");
  });

  test("non-force reload never writes nudge", async () => {
    const { handler, writeNudge } = setup([activeSession("sess-a", "idle")]);
    await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --source codexroot-maintenance"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
  });

  test("force reload ignores legacy nudge writer dependency", async () => {
    const busy = [activeSession("sess-a", "busy")];
    const lifecycle = createMockLifecycle();
    const writeNudge = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const handler = createReloadHandler({
      lifecycle,
      store: { listActiveSessions: async () => busy },
      consumePermit: vi.fn(async () => TEST_GRANT),
      writeNudge,
    });
    const result = await handler({
      args: { name: "--force", source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --force --source codexroot-maintenance"),
    });
    expect(writeNudge).not.toHaveBeenCalled();
    expect((result as any).replyText).not.toContain("nudge");
    expect((result as any).replyText).not.toContain("催一句");
    expect(lifecycle.isPending()).toBe(true);
  });

  test("explicit force tokens force the restart", async () => {
    for (const token of ["force", "强制", "--强制", "FORCE", "ＦＯＲＣＥ"]) {
      const busy = [activeSession("sess-a", "busy")];
      const { handler, lifecycle } = setup(busy);
      const result = await handler({
        args: { name: token, source: "codexroot-maintenance", permit: TEST_PERMIT },
        scope: "root",
        msg: msg(`/reload ${token} --source codexroot-maintenance`),
      });
      expect((result as any).replyText).toContain("强制重启");
      expect(lifecycle.isForce()).toBe(true);
    }
  });

  test.each(["frce", "--forc", "sess-a"])(
    "/reload %s fails closed before any restart signal",
    async (token) => {
      const listActiveSessions = vi.fn(async () => [activeSession("sess-a", "busy")]);
      const lifecycle = createMockLifecycle();
      const handler = createReloadHandler({
        lifecycle,
        store: { listActiveSessions },
        consumePermit: vi.fn(async () => TEST_GRANT),
      });
      await expect(
        handler({ args: { name: token }, scope: "root", msg: msg(`/reload ${token}`) }),
      ).rejects.toThrow(UserError);
      expect(listActiveSessions).not.toHaveBeenCalled();
      expect(lifecycle.requestRestart).not.toHaveBeenCalled();
      expect(lifecycle.isPending()).toBe(false);
      expect(lifecycle.isForce()).toBe(false);
    },
  );

  test("codexroot gate source performs a normal safe reload", async () => {
    const { handler, lifecycle } = setup([activeSession("sess-a", "idle")]);
    const result = await handler({
      args: { source: "codexroot-maintenance", permit: TEST_PERMIT },
      scope: "root",
      msg: msg("/reload --source codexroot-maintenance"),
    });
    expect((result as any).replyText).toContain("重启中");
    expect(lifecycle.isForce()).toBe(false);
    expect(lifecycle.isPending()).toBe(true);
  });
});
