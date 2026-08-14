import { describe, expect, test } from "vitest";
import { createWorkspaceLockHandler } from "../../../src/app/commands/workspaceLock.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

const GROUP_ID = asLarkGroupId("oc_lock");
const SESSION_ID = asSessionId("sess_lock");

function makeSession(): Session {
  return {
    id: SESSION_ID,
    name: "lock-session",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/lock-session"),
    backendSessionId: null,
    chatName: null,
    purpose: "workspace lock command test",
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
    createdAt: asTimestamp(100),
    updatedAt: asTimestamp(100),
  };
}

function msg(text: "/lock" | "/unlock") {
  return {
    groupId: GROUP_ID,
    messageId: `msg_${text.slice(1)}`,
    userId: "ou_any_member",
    text,
    origin: "lark_user" as const,
    attachments: [],
    receivedAtMs: 1000,
  };
}

describe("workspace lock commands", () => {
  test("/lock and /unlock persist the bound session state without sender authorization", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession());
    store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(100) });
    const deps = {
      store,
      resolveUserGroupSession: async () => ({ name: "lock-session", id: SESSION_ID }),
    };

    const lockResult = await createWorkspaceLockHandler(deps, true)({
      args: {},
      scope: "user",
      msg: msg("/lock"),
    });
    expect(lockResult).toEqual({ replyText: "✓ 工作区已锁定" });
    await expect(store.getSessionWorkspaceLocked(SESSION_ID)).resolves.toBe(true);

    const unlockResult = await createWorkspaceLockHandler(deps, false)({
      args: {},
      scope: "user",
      msg: msg("/unlock"),
    });
    expect(unlockResult).toEqual({ replyText: "✓ 工作区已解锁" });
    await expect(store.getSessionWorkspaceLocked(SESSION_ID)).resolves.toBe(false);
  });

  test("rejects a command from an unbound group", async () => {
    const store = createFakeBindingStore();
    const handler = createWorkspaceLockHandler({
      store,
      resolveUserGroupSession: async () => null,
    }, true);

    await expect(handler({
      args: {},
      scope: "user",
      msg: msg("/lock"),
    })).rejects.toThrow(new UserError("当前群未绑定 session"));
  });
});
