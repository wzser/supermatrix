import { describe, expect, test, vi } from "vitest";
import { createCancelHandler } from "../../../src/app/commands/cancelSession.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function makeMsg(groupId: string, text: string) {
  return { groupId: asLarkGroupId(groupId), messageId: "m", userId: "u", text, attachments: [], receivedAtMs: 0 };
}

function seed(store: ReturnType<typeof createFakeBindingStore>, id: string, name: string) {
  store.seedSession({
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/ws/${name}`),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "busy",
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

function build(store: ReturnType<typeof createFakeBindingStore>) {
  const cancel = vi.fn(async () => {});
  const clearPendingNext = vi.fn(() => 2);
  const handler = createCancelHandler({
    store,
    cancel,
    clearPendingNext,
    resolveUserGroupSession: async () => null,
  });
  return { handler, cancel, clearPendingNext };
}

describe("/cancel root next keyword", () => {
  test("/cancel NEXT amz-sql clears the queue, does not cancel, applies no new fold to the name", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "amz-sql");
    const { handler, cancel, clearPendingNext } = build(store);

    const r = await handler({
      scope: "root",
      args: { target: "NEXT amz-sql" },
      msg: makeMsg("oc_root", "/cancel NEXT amz-sql"),
    });

    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(r.replyText).toContain("已清空 2 条排队消息");
    expect(clearPendingNext).toHaveBeenCalledWith(asSessionId("s1"));
    expect(cancel).not.toHaveBeenCalled();
  });

  test("/cancel NEXT Amz-SQL folds only next; the session name keeps its case", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "Amz-SQL");
    const { handler, cancel, clearPendingNext } = build(store);

    const r = await handler({
      scope: "root",
      args: { target: "NEXT Amz-SQL" },
      msg: makeMsg("oc_root", "/cancel NEXT Amz-SQL"),
    });

    if (!("replyText" in r)) throw new Error("expected replyText");
    expect(clearPendingNext).toHaveBeenCalledWith(asSessionId("s1"));
    expect(cancel).not.toHaveBeenCalled();
    expect(r.replyText).toContain("已清空 2 条排队消息");
  });

  test("/cancel next amz-sql (lowercase) behaves identically", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "amz-sql");
    const { handler, cancel } = build(store);

    await handler({
      scope: "root",
      args: { target: "next amz-sql" },
      msg: makeMsg("oc_root", "/cancel next amz-sql"),
    });

    expect(cancel).not.toHaveBeenCalled();
  });

  test("/cancel amz-sql cancels the running session", async () => {
    const store = createFakeBindingStore();
    seed(store, "s1", "amz-sql");
    const { handler, cancel } = build(store);

    await handler({
      scope: "root",
      args: { target: "amz-sql" },
      msg: makeMsg("oc_root", "/cancel amz-sql"),
    });

    expect(cancel).toHaveBeenCalledWith(asSessionId("s1"));
  });

  test("/cancel next (no name) errors", async () => {
    const store = createFakeBindingStore();
    const { handler } = build(store);

    await expect(
      handler({
        scope: "root",
        args: { target: "next" },
        msg: makeMsg("oc_root", "/cancel next"),
      }),
    ).rejects.toThrow(UserError);
  });
});
