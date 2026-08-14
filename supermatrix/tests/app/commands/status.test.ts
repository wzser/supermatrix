import { describe, expect, test } from "vitest";
import { createStatusHandler } from "../../../src/app/commands/status.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function ctx(args: Record<string, string> = {}) {
  return {
    msg: { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text: "/status", attachments: [], receivedAtMs: 0 },
    scope: "root" as const,
    args,
  };
}

describe("status handler", () => {
  test("no name returns console summary", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"), backendSessionId: null, chatName: null, purpose: "",
      status: "busy", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1), updatedAt: asTimestamp(1),
    });
    const handler = createStatusHandler({ store, clock: { now: () => asTimestamp(2) } });
    const result = await handler(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toMatch(/1 active/);
    expect(result.replyText).toMatch(/1 busy/);
  });

  test("with name returns full details including model and thinking", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: "opus-4-6", effort: null, thinking: true, modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"), backendSessionId: "bks-1", chatName: null, purpose: "test",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000), updatedAt: asTimestamp(1_700_000_000_000),
    });
    const handler = createStatusHandler({ store, clock: { now: () => asTimestamp(1_700_000_000_000) } });
    const result = await handler(ctx({ name: "foo" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("foo");
    expect(result.replyText).toContain("claude");
    expect(result.replyText).toContain("Opus (opus-4-6)");
    expect(result.replyText).toContain("thinking: on");
    expect(result.replyText).toContain("bks-1");
    expect(result.replyText).toContain("test");
  });

  test("default model and thinking off", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "bar", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/bar"), backendSessionId: null, chatName: null, purpose: "",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000), updatedAt: asTimestamp(1_700_000_000_000),
    });
    const handler = createStatusHandler({ store, clock: { now: () => asTimestamp(1_700_000_000_000) } });
    const result = await handler(ctx({ name: "bar" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("model:   default");
    expect(result.replyText).toContain("thinking: off");
  });

  test("sonnet model formatted correctly", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "baz", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: "sonnet-4-6", effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/baz"), backendSessionId: null, chatName: null, purpose: "",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000), updatedAt: asTimestamp(1_700_000_000_000),
    });
    const handler = createStatusHandler({ store, clock: { now: () => asTimestamp(1_700_000_000_000) } });
    const result = await handler(ctx({ name: "baz" }));
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("Sonnet (sonnet-4-6)");
  });

  test("with unknown name throws UserError", async () => {
    const store = createFakeBindingStore();
    const handler = createStatusHandler({ store, clock: { now: () => asTimestamp(1) } });
    await expect(handler(ctx({ name: "nope" }))).rejects.toThrow(UserError);
  });

  test("user scope resolves session from group", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"), backendSessionId: null, chatName: null, purpose: "test",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000), updatedAt: asTimestamp(1_700_000_000_000),
    });
    const handler = createStatusHandler({
      store,
      clock: { now: () => asTimestamp(1_700_000_000_000) },
      resolveUserGroupSession: async () => ({ name: "foo", id: "s1" }),
    });
    const result = await handler({
      msg: { groupId: asLarkGroupId("oc_foo"), messageId: "m", userId: "u", text: "/status", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: {},
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("foo");
    expect(result.replyText).toContain("claude");
  });

  test("user scope with unbound group throws UserError", async () => {
    const store = createFakeBindingStore();
    const handler = createStatusHandler({
      store,
      clock: { now: () => asTimestamp(1) },
      resolveUserGroupSession: async () => null,
    });
    await expect(handler({
      msg: { groupId: asLarkGroupId("oc_unknown"), messageId: "m", userId: "u", text: "/status", attachments: [], receivedAtMs: 0 },
      scope: "user",
      args: {},
    })).rejects.toThrow(UserError);
  });
});
