import { describe, expect, test, vi } from "vitest";
import { createStaWritebackPoller } from "../../src/app/staWritebackPoller.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

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

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("sta writeback polling fallback", () => {
  test("seeds existing app command cards without executing them, then routes new cards", async () => {
    const groupId = asLarkGroupId("oc_huojian");
    const store = createFakeBindingStore();
    const session = makeSession();
    store.seedSession(session);
    store.seedBinding({ groupId, sessionId: session.id, createdAt: asTimestamp(100) });

    const routed: string[] = [];
    const replies: string[] = [];
    const batches = [
      [
        {
          chat_id: groupId,
          message_id: "om_old",
          msg_type: "interactive",
          sender: { id: "cli_other_app", sender_type: "app" },
          content: "<card>\n/sta-writeback task_id=oldtask\n---\n</card>",
        },
      ],
      [
        {
          chat_id: groupId,
          message_id: "om_old",
          msg_type: "interactive",
          sender: { id: "cli_other_app", sender_type: "app" },
          content: "<card>\n/sta-writeback task_id=oldtask\n---\n</card>",
        },
        {
          chat_id: groupId,
          message_id: "om_new",
          msg_type: "interactive",
          sender: { id: "cli_other_app", sender_type: "app" },
          content: "<card>\n/sta-writeback task_id=698debdc\n---\n</card>",
        },
      ],
    ];

    const poller = createStaWritebackPoller({
      larkCliPath: "lark-cli",
      botAppId: "cli_self",
      store,
      router: {
        route: async ({ msg }) => {
          routed.push(msg.text);
          return { replyText: `handled ${msg.messageId}` };
        },
      },
      lark: {
        sendMessage: async (_groupId, text) => {
          replies.push(text);
        },
        postCard: async () => undefined,
      },
      logger: makeLogger(),
      listMessages: async () => batches.shift() ?? [],
    });

    await poller.pollOnce({ seedOnly: true });
    await poller.pollOnce();

    expect(routed).toEqual(["/sta-writeback task_id=698debdc"]);
    expect(replies).toEqual(["handled om_new"]);
  });
});
