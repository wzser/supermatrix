import { describe, expect, test, vi } from "vitest";
import { createReloadHandler } from "../../../src/app/commands/reload.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";

function msg(text: string) {
  return { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
}

function createMockLifecycle() {
  let pendingReason: string | undefined;
  let pendingForce = false;
  let pendingSource: string | undefined;
  return {
    requestRestart: vi.fn((reason: string, opts?: { force?: boolean; source?: string }) => {
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
  const handler = createReloadHandler({
    lifecycle,
    store: { listActiveSessions: async () => sessions },
  });
  return { lifecycle, handler };
}

describe("reload handler", () => {
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

  test("busy sessions block reload without --force", async () => {
    const busy = [{ name: "sess-a", status: "busy" }];
    const { handler, lifecycle } = setup(busy);
    const result = await handler({ args: { source: "scheduler" }, scope: "root", msg: msg("/reload --source scheduler") });
    expect((result as any).replyText).toContain("无法重启");
    expect(lifecycle.isPending()).toBe(false);
  });
});
