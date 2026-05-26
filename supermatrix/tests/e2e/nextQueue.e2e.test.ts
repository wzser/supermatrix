import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { asLarkGroupId, asTimestamp } from "../../src/domain/ids.ts";
import type { RunInput } from "../../src/ports/AgentBackend.ts";

describe("e2e /next queue", () => {
  let h: Harness;
  const prompts: string[] = [];

  beforeEach(async () => {
    prompts.length = 0;
    h = await createHarness({
      script: (input: RunInput) => {
        prompts.push(input.prompt);
        return [
          { kind: "started", backendSessionId: "bks_next" },
          { kind: "completed", finalMessage: `done: ${input.prompt}` },
        ];
      },
    });
  });

  afterEach(async () => { await h.cleanup(); });

  it("runs multiple /next messages for the same session in FIFO order", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new",
      userId: "u_owner",
      text: "/new claude next-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("next-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_next_1",
      userId: "u_owner",
      text: "/next queued one",
      attachments: [],
      receivedAtMs: 1,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_next_2",
      userId: "u_owner",
      text: "/next queued two",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(2));
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_status",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 3,
    });

    expect(prompts).toEqual([
      "queued one",
      "queued two",
    ]);
    expect(h.lark.sent.map((m) => m.text)).not.toContain("已有一条排队消息在等待，请等待消化后再提交");
  });

  it("/cancel clears pending /next messages for the session", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new_cancel",
      userId: "u_owner",
      text: "/new claude cancel-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("cancel-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_next_cancel_1",
      userId: "u_owner",
      text: "/next should be cleared one",
      attachments: [],
      receivedAtMs: 1,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_next_cancel_2",
      userId: "u_owner",
      text: "/next should be cleared two",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_cancel",
      userId: "u_owner",
      text: "/cancel",
      attachments: [],
      receivedAtMs: 3,
    });

    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(4));
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_status_after_cancel",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 5,
    });

    expect(prompts).toEqual([]);
    expect(h.lark.sent.map((m) => m.text)).toContain("✓ 已请求取消 session 「cancel-target」，已清空 2 条排队消息");
  });

  it("/cancel next clears pending /next messages without cancelling the running task", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new_cancel_next",
      userId: "u_owner",
      text: "/new claude cancel-next-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("cancel-next-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_cancel_next_queued_1",
      userId: "u_owner",
      text: "/next should be cleared one",
      attachments: [],
      receivedAtMs: 1,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_cancel_next_queued_2",
      userId: "u_owner",
      text: "/next should be cleared two",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_cancel_next_only",
      userId: "u_owner",
      text: "/cancel next",
      attachments: [],
      receivedAtMs: 3,
    });

    const afterCancelNext = await h.store.findSessionByName("cancel-next-target");
    expect(afterCancelNext?.status).toBe("busy");

    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(4));
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_status_after_cancel_next",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 5,
    });

    expect(prompts).toEqual([]);
    expect(h.lark.sent.map((m) => m.text)).toContain("✓ 已清空 2 条排队消息");
  });
});
