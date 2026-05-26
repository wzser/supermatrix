import { describe, expect, test } from "vitest";
import { createStaWritebackHandler } from "../../../src/app/commands/staWriteback.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";

function makeSession(): Session {
  return {
    id: asSessionId("sess_huojian"),
    name: "huojian-king",
    alias: "货件王",
    avatar: "",
    category: "业务",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/huojian-king"),
    backendSessionId: null,
    chatName: null,
    purpose: "shipment workflow",
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

describe("/sta-writeback command", () => {
  test("runs the bound session writeback script with the raw message", async () => {
    const groupId = asLarkGroupId("oc_huojian");
    const store = createFakeBindingStore();
    const session = makeSession();
    store.seedSession(session);
    store.seedBinding({ groupId, sessionId: session.id, createdAt: asTimestamp(100) });
    const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
    const handler = createStaWritebackHandler({
      store,
      runScript: async (file, args, options) => {
        calls.push({ file, args, cwd: options.cwd });
        return { code: 0, stdout: '{"ok":true,"task_id":"698debdc"}\n', stderr: "" };
      },
    });

    const result = await handler({
      scope: "user",
      args: { payload: "task_id=698debdc" },
      msg: {
        groupId,
        messageId: "m1",
        userId: "cli_other_app",
        text: '/sta-writeback task_id="698debdc"',
        attachments: [],
        receivedAtMs: 1000,
      },
    });

    expect(calls).toEqual([
      {
        file: "/tmp/huojian-king/scripts/sta_writeback.py",
        args: ["--message", '/sta-writeback task_id="698debdc"'],
        cwd: "/tmp/huojian-king",
      },
    ]);
    expect(result).toEqual({ replyText: '{"ok":true,"task_id":"698debdc"}' });
  });
});
