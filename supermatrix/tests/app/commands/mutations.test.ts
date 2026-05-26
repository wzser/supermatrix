import { describe, expect, test, vi } from "vitest";
import { createNewHandler } from "../../../src/app/commands/newSession.ts";
import { createDeleteHandler } from "../../../src/app/commands/deleteSession.ts";
import { createCancelHandler } from "../../../src/app/commands/cancelSession.ts";
import { createResetHandler } from "../../../src/app/commands/resetSession.ts";
import { createRestartHandler } from "../../../src/app/commands/restartSession.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function msg(groupId: string, text: string) {
  return { groupId: asLarkGroupId(groupId), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
}

describe("mutation handlers", () => {
  test("/new in root delegates to lifecycle.create", async () => {
    const create = vi.fn(async ({ name }: { name: string }) => ({ session: { name } as any }));
    const handler = createNewHandler({ lifecycle: { create } });
    const result = await handler({ args: { backend: "claude", name: "foo", purpose: "hi" }, scope: "root", msg: msg("oc_root", "/new claude foo hi") });
    expect(create).toHaveBeenCalledWith({ backend: "claude", name: "foo", purpose: "hi" });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("foo");
  });

  test("/new in user scope rejects", async () => {
    const handler = createNewHandler({ lifecycle: { create: async () => ({ session: { name: "x" } as any }) } });
    await expect(handler({ args: { backend: "claude", name: "foo" }, scope: "user", msg: msg("oc_user", "/new claude foo") })).rejects.toThrow(UserError);
  });

  test("/delete in root delegates", async () => {
    const del = vi.fn();
    const handler = createDeleteHandler({ lifecycle: { delete: del }, resolveUserGroupSession: async () => null });
    await handler({ args: { name: "foo" }, scope: "root", msg: msg("oc_root", "/delete foo") });
    expect(del).toHaveBeenCalledWith({ name: "foo" });
  });

  test("/delete in user scope resolves session from group", async () => {
    const del = vi.fn();
    const resolveUserGroupSession = vi.fn(async () => ({ name: "bar", id: "s2" }));
    const handler = createDeleteHandler({ lifecycle: { delete: del }, resolveUserGroupSession });
    await handler({ args: {}, scope: "user", msg: msg("oc_bar", "/delete") });
    expect(del).toHaveBeenCalledWith({ name: "bar" });
  });

  test("/delete in user scope throws when no binding", async () => {
    const del = vi.fn();
    const handler = createDeleteHandler({ lifecycle: { delete: del }, resolveUserGroupSession: async () => null });
    await expect(handler({ args: {}, scope: "user", msg: msg("oc_none", "/delete") })).rejects.toThrow(UserError);
  });

  test("/cancel in user scope resolves session from group", async () => {
    const store = createFakeBindingStore();
    const cancel = vi.fn();
    const resolveUserGroupSession = vi.fn(async () => ({ name: "foo", id: "s1" }));
    // seed a foo session so findSessionByName succeeds
    store.seedSession({
      id: "s1" as any, name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: "/ws/foo" as any, backendSessionId: null, chatName: null, purpose: "",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null, createdAt: 1 as any, updatedAt: 1 as any,
    });
    const handler = createCancelHandler({ store, cancel, resolveUserGroupSession });
    await handler({ args: {}, scope: "user", msg: msg("oc_foo", "/cancel") });
    expect(cancel).toHaveBeenCalledWith("s1");
  });

  test("/cancel clears pending /next queue before cancelling backend", async () => {
    const store = createFakeBindingStore();
    const events: string[] = [];
    const cancel = vi.fn(async () => {
      events.push("cancel");
    });
    const clearPendingNext = vi.fn(() => {
      events.push("clear");
      return 2;
    });
    const resolveUserGroupSession = vi.fn(async () => ({ name: "foo", id: "s1" }));
    store.seedSession({
      id: "s1" as any, name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: "/ws/foo" as any, backendSessionId: null, chatName: null, purpose: "",
      status: "busy", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null, createdAt: 1 as any, updatedAt: 1 as any,
    });
    const handler = createCancelHandler({ store, cancel, clearPendingNext, resolveUserGroupSession });
    const result = await handler({ args: {}, scope: "user", msg: msg("oc_foo", "/cancel") });

    expect(clearPendingNext).toHaveBeenCalledWith("s1");
    expect(cancel).toHaveBeenCalledWith("s1");
    expect(events).toEqual(["clear", "cancel"]);
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已清空 2 条排队消息");
  });

  test("/cancel next in user scope only clears pending /next queue", async () => {
    const store = createFakeBindingStore();
    const cancel = vi.fn();
    const clearPendingNext = vi.fn(() => 2);
    const resolveUserGroupSession = vi.fn(async () => ({ name: "foo", id: "s1" }));
    store.seedSession({
      id: "s1" as any, name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: "/ws/foo" as any, backendSessionId: null, chatName: null, purpose: "",
      status: "busy", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null, createdAt: 1 as any, updatedAt: 1 as any,
    });
    const handler = createCancelHandler({ store, cancel, clearPendingNext, resolveUserGroupSession });
    const result = await handler({ args: { target: "next" }, scope: "user", msg: msg("oc_foo", "/cancel next") });

    expect(clearPendingNext).toHaveBeenCalledWith("s1");
    expect(cancel).not.toHaveBeenCalled();
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已清空 2 条排队消息");
  });

  test("/reset in user delegates to lifecycle.reset with resolved name", async () => {
    const reset = vi.fn();
    const handler = createResetHandler({
      lifecycle: { reset },
      resolveUserGroupSession: async () => ({ name: "foo", id: "s1" }),
    });
    await handler({ args: {}, scope: "user", msg: msg("oc_foo", "/reset") });
    expect(reset).toHaveBeenCalledWith({ name: "foo" });
  });

  test("/reset foo in root delegates to lifecycle.reset", async () => {
    const reset = vi.fn();
    const handler = createResetHandler({
      lifecycle: { reset },
      resolveUserGroupSession: async () => null,
    });
    await handler({ args: { name: "foo" }, scope: "root", msg: msg("oc_root", "/reset foo") });
    expect(reset).toHaveBeenCalledWith({ name: "foo" });
  });

  test("/restart in user delegates to lifecycle.restart", async () => {
    const restart = vi.fn();
    const handler = createRestartHandler({
      lifecycle: { restart },
      resolveUserGroupSession: async () => ({ name: "foo", id: "s1" }),
    });
    await handler({ args: {}, scope: "user", msg: msg("oc_foo", "/restart") });
    expect(restart).toHaveBeenCalledWith({ name: "foo" });
  });

  test("/restart foo in root delegates to lifecycle.restart", async () => {
    const restart = vi.fn();
    const handler = createRestartHandler({
      lifecycle: { restart },
      resolveUserGroupSession: async () => null,
    });
    await handler({ args: { name: "foo" }, scope: "root", msg: msg("oc_root", "/restart foo") });
    expect(restart).toHaveBeenCalledWith({ name: "foo" });
  });
});
