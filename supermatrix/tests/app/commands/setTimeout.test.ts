import { describe, expect, test } from "vitest";
import { createSetTimeoutHandler } from "../../../src/app/commands/setTimeout.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function makeMsg(groupId: string, text: string) {
  return {
    groupId: asLarkGroupId(groupId),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

function seedFoo(store: ReturnType<typeof createFakeBindingStore>) {
  store.seedSession({
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/foo"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
    parentId: null,
    depth: 0,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: null,
    triggerKind: null,
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
  });
}

describe("/timeout command handler", () => {
  test("sets inactivity timeout in seconds", async () => {
    const store = createFakeBindingStore();
    seedFoo(store);
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: { timeout: "300" },
      scope: "user",
      msg: makeMsg("oc_foo", "/timeout 300"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("300s");
    expect(result.replyText).toContain("已更新");

    const updated = await store.findSessionById(asSessionId("s1"));
    expect(updated?.inactivityTimeoutS).toBe(300);
  });

  test("resets inactivity timeout to default", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"),
      name: "foo",
      alias: "",
      avatar: "", category: "", fpManaged: null,
      scope: "user",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"),
      backendSessionId: null,
      chatName: null,
      purpose: "",
      status: "idle",
      parentId: null,
      depth: 0,
      inactivityTimeoutS: 600,
      maxRuntimeS: null,
      childType: null,
      triggerKind: null,
      postIdentity: null,
      callerInvocation: null,
      continuationHook: null,
      capabilityPayload: null,
      createdAt: asTimestamp(1),
      updatedAt: asTimestamp(1),
    });
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: { timeout: "default" },
      scope: "user",
      msg: makeMsg("oc_foo", "/timeout default"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("默认 (900s)");

    const updated = await store.findSessionById(asSessionId("s1"));
    expect(updated?.inactivityTimeoutS).toBeNull();
  });

  test("disables inactivity timeout with 0", async () => {
    const store = createFakeBindingStore();
    seedFoo(store);
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: { timeout: "0" },
      scope: "user",
      msg: makeMsg("oc_foo", "/timeout 0"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("已禁用");

    const updated = await store.findSessionById(asSessionId("s1"));
    expect(updated?.inactivityTimeoutS).toBe(0);
  });

  test("sets max runtime via --maxrun", async () => {
    const store = createFakeBindingStore();
    seedFoo(store);
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: { maxrun: "1800" },
      scope: "user",
      msg: makeMsg("oc_foo", "/timeout --maxrun 1800"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("1800s");
    expect(result.replyText).toContain("已更新");

    const updated = await store.findSessionById(asSessionId("s1"));
    expect(updated?.maxRuntimeS).toBe(1800);
  });

  test("root scope sets timeout by session name", async () => {
    const store = createFakeBindingStore();
    seedFoo(store);
    const handler = createSetTimeoutHandler({ store });
    const result = await handler({
      args: { name: "foo", timeout: "120" },
      scope: "root",
      msg: makeMsg("oc_root", "/timeout foo 120"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("120s");

    const updated = await store.findSessionById(asSessionId("s1"));
    expect(updated?.inactivityTimeoutS).toBe(120);
  });

  test("rejects non-numeric timeout value", async () => {
    const store = createFakeBindingStore();
    seedFoo(store);
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    await expect(
      handler({
        args: { timeout: "abc" },
        scope: "user",
        msg: makeMsg("oc_foo", "/timeout abc"),
      }),
    ).rejects.toThrow(UserError);
  });

  test("shows current timeout config when no args given", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"),
      name: "foo",
      alias: "",
      avatar: "", category: "", fpManaged: null,
      scope: "user",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"),
      backendSessionId: null,
      chatName: null,
      purpose: "",
      status: "idle",
      parentId: null,
      depth: 0,
      inactivityTimeoutS: 450,
      maxRuntimeS: 3600,
      childType: null,
      triggerKind: null,
      postIdentity: null,
      callerInvocation: null,
      continuationHook: null,
      capabilityPayload: null,
      createdAt: asTimestamp(1),
      updatedAt: asTimestamp(1),
    });
    const handler = createSetTimeoutHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "foo", id: asSessionId("s1") }),
    });
    const result = await handler({
      args: {},
      scope: "user",
      msg: makeMsg("oc_foo", "/timeout"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("超时配置");
    expect(result.replyText).toContain("450s");
    expect(result.replyText).toContain("3600s");
    // Should NOT say "已更新"
    expect(result.replyText).not.toContain("已更新");
  });
});
