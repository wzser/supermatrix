import { describe, expect, test } from "vitest";
import { createListHandler } from "../../../src/app/commands/listSessions.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function ctx() {
  return {
    msg: { groupId: asLarkGroupId("oc_root"), messageId: "m", userId: "u", text: "/list", attachments: [], receivedAtMs: 0 },
    scope: "root" as const,
    args: {},
  };
}

describe("list handler", () => {
  test("empty store prints friendly message", async () => {
    const store = createFakeBindingStore();
    const handler = createListHandler({ store, clock: { now: () => asTimestamp(1_700_000_000_000) } });
    const result = await handler(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("没有");
  });

  test("lists sessions with names and backends", async () => {
    const store = createFakeBindingStore();
    store.seedSession({
      id: asSessionId("s1"), name: "foo", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "claude",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/foo"), backendSessionId: null, chatName: null, purpose: "",
      status: "idle", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000 - 60_000), updatedAt: asTimestamp(1_700_000_000_000 - 60_000),
    });
    store.seedSession({
      id: asSessionId("s2"), name: "bar", alias: "", avatar: "", category: "", fpManaged: null, scope: "user", backend: "codex",
      model: null, effort: null, thinking: false, modelLocked: false,
      workdir: asAbsolutePath("/ws/bar"), backendSessionId: null, chatName: null, purpose: "",
      status: "busy", parentId: null, depth: 0, inactivityTimeoutS: null, maxRuntimeS: null, childType: null, triggerKind: null, postIdentity: null, callerInvocation: null, continuationHook: null, capabilityPayload: null,
      createdAt: asTimestamp(1_700_000_000_000 - 3600_000), updatedAt: asTimestamp(1_700_000_000_000 - 3600_000),
    });
    const handler = createListHandler({ store, clock: { now: () => asTimestamp(1_700_000_000_000) } });
    const result = await handler(ctx());
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("foo");
    expect(result.replyText).toContain("bar");
    expect(result.replyText).toContain("claude");
    expect(result.replyText).toContain("codex");
    expect(result.replyText).toContain("busy");
    expect(result.replyText).not.toContain("tokens:");
  });
});
