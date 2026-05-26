import { describe, expect, test } from "vitest";
import { createSetModelHandler } from "../../../src/app/commands/setModel.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
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

function seed(
  store: ReturnType<typeof createFakeBindingStore>,
  id: string,
  name: string,
  backend: "claude" | "codex",
  extra: Partial<Session> = {},
) {
  store.seedSession({
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend,
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/ws/${name}`),
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
    ...extra,
  });
}

describe("/model Fixed / Unfixed", () => {
  test("user-scope /model Fixed locks current session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "mysess", "claude", { model: "claude-opus-4-7" });
    const handler = createSetModelHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "mysess", id: asSessionId("s1") }),
    });
    const result = await handler({
      scope: "user",
      args: { name: "", model: "Fixed" },
      msg: makeMsg("oc_user", "/model Fixed"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("🔒");
    expect(result.replyText).toContain("mysess");
    expect(result.replyText).toContain("claude-opus-4-7");
    expect((await store.findSessionByName("mysess"))?.modelLocked).toBe(true);
  });

  test("user-scope /model Unfixed unlocks current session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "mysess", "claude", { modelLocked: true });
    const handler = createSetModelHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "mysess", id: asSessionId("s1") }),
    });
    const result = await handler({
      scope: "user",
      args: { name: "", model: "Unfixed" },
      msg: makeMsg("oc_user", "/model Unfixed"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("🔓");
    expect((await store.findSessionByName("mysess"))?.modelLocked).toBe(false);
  });

  test("/model Fixed shows 'backend 默认' when model is null", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "mysess", "claude", { model: null });
    const handler = createSetModelHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "mysess", id: asSessionId("s1") }),
    });
    const result = await handler({
      scope: "user",
      args: { name: "", model: "Fixed" },
      msg: makeMsg("oc_user", "/model Fixed"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("backend 默认");
  });

  test("root-scope /model <session> Fixed locks named session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s2", "target-sess", "codex", { model: "gpt-5.5" });
    const handler = createSetModelHandler({ store });
    const result = await handler({
      scope: "root",
      args: { name: "target-sess", model: "Fixed" },
      msg: makeMsg("oc_root", "/model target-sess Fixed"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("target-sess");
    expect(result.replyText).toContain("🔒");
    expect((await store.findSessionByName("target-sess"))?.modelLocked).toBe(true);
  });

  test("root-scope /model all Fixed throws UserError", async () => {
    const store = createFakeBindingStore();
    const handler = createSetModelHandler({ store });
    await expect(
      handler({
        scope: "root",
        args: { name: "all", model: "Fixed" },
        msg: makeMsg("oc_root", "/model all Fixed"),
      }),
    ).rejects.toBeInstanceOf(UserError);
  });

  test("/model Fixed on already-locked session is idempotent", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "mysess", "claude", { modelLocked: true, model: "claude-opus-4-7" });
    const handler = createSetModelHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "mysess", id: asSessionId("s1") }),
    });
    const result = await handler({
      scope: "user",
      args: { name: "", model: "Fixed" },
      msg: makeMsg("oc_user", "/model Fixed"),
    });
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("🔒");
    expect((await store.findSessionByName("mysess"))?.modelLocked).toBe(true);
  });
});
