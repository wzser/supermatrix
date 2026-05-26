import { describe, expect, test } from "vitest";
import { createNextHandler } from "../../../src/app/commands/next.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

const USER_GROUP = asLarkGroupId("user_group");
const SESSION_ID = asSessionId("sess_next");

function makeSession(status: Session["status"]): Session {
  return {
    id: SESSION_ID,
    name: "next-session",
    alias: "",
    avatar: "",
    category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/next-session"),
    backendSessionId: null,
    chatName: null,
    purpose: "testing /next",
    status,
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
    createdAt: asTimestamp(100),
    updatedAt: asTimestamp(100),
  };
}

function msg(text: string) {
  return {
    groupId: USER_GROUP,
    messageId: "msg_next",
    userId: "user1",
    text,
    attachments: [],
    receivedAtMs: 1000,
  };
}

describe("/next command", () => {
  test("queues multiple messages for a busy session instead of rejecting the second", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession("busy"));
    const queued: Array<{ text: string; groupId: typeof USER_GROUP; userId: string }> = [];
    const handler = createNextHandler({
      store,
      resolveUserGroupSession: async () => ({ name: "next-session", id: SESSION_ID }),
      enqueuePendingNext: (_id, entry) => {
        queued.push(entry);
      },
    });

    const first = await handler({ args: { text: "first queued prompt" }, scope: "user", msg: msg("/next first") });
    const second = await handler({ args: { text: "second queued prompt" }, scope: "user", msg: msg("/next second") });

    expect(first).toEqual({ replyText: "✓ 已排队，将在当前任务完成后执行" });
    expect(second).toEqual({ replyText: "✓ 已排队，将在当前任务完成后执行" });
    expect(queued.map((entry) => entry.text)).toEqual([
      "first queued prompt",
      "second queued prompt",
    ]);
  });
});
