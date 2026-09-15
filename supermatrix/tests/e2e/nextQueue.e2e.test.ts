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

  it("queues a synthetic Δ/next message while the session is busy", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new_synthetic_next",
      userId: "u_owner",
      text: "/new claude synthetic-next-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("synthetic-next-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_synthetic_next",
      userId: "u_owner",
      text: "Δ/next heartbeat todo",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_synthetic_next_2",
      userId: "u_owner",
      text: "Δ/next second heartbeat todo",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 3,
    });

    expect(h.pendingNextCount(session!.id)).toBe(2);
    expect(h.lark.sent.map((m) => m.text)).toContain("✓ 已排队，将在当前任务完成后执行");

    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(4));
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_trigger_synthetic_next_drain",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 5,
    });

    expect(prompts).toEqual(["heartbeat todo", "second heartbeat todo"]);
  });

  it("restores the shifted FIFO head when a concurrent prompt wins admission", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new_drain_race",
      userId: "u_owner",
      text: "/new claude drain-race-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("drain-race-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_drain_race_next_1",
      userId: "u_owner",
      text: "/next queued one",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_drain_race_next_2",
      userId: "u_owner",
      text: "/next queued two",
      attachments: [],
      receivedAtMs: 3,
    });

    let releaseDrainAdmission!: () => void;
    const drainAdmissionReleased = new Promise<void>((resolve) => {
      releaseDrainAdmission = resolve;
    });
    let signalDrainAdmission!: () => void;
    const drainAdmissionStarted = new Promise<void>((resolve) => {
      signalDrainAdmission = resolve;
    });
    let releaseWinnerAdmission!: () => void;
    const winnerAdmissionReleased = new Promise<void>((resolve) => {
      releaseWinnerAdmission = resolve;
    });
    let signalWinnerAdmission!: () => void;
    const winnerAdmissionStarted = new Promise<void>((resolve) => {
      signalWinnerAdmission = resolve;
    });
    const admitMessageRun = h.store.admitMessageRun.bind(h.store);
    h.store.admitMessageRun = async (input) => {
      if (input.prompt === "queued one") {
        signalDrainAdmission();
        await drainAdmissionReleased;
      }
      const result = await admitMessageRun(input);
      if (input.prompt === "winner" && result.kind === "admitted") {
        signalWinnerAdmission();
        await winnerAdmissionReleased;
      }
      return result;
    };

    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(4));
    const drain = h.emitInbound({
      groupId: userGroup,
      messageId: "m_trigger_drain_race",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 5,
    });
    await drainAdmissionStarted;

    const winner = h.emitInbound({
      groupId: userGroup,
      messageId: "m_drain_race_winner",
      userId: "u_owner",
      text: "winner",
      attachments: [],
      receivedAtMs: 6,
    });
    await winnerAdmissionStarted;
    releaseDrainAdmission();
    await drain;

    expect(prompts).toEqual([]);
    expect(h.pendingNextCount(session!.id)).toBe(2);

    releaseWinnerAdmission();
    await winner;

    expect(prompts).toEqual(["winner", "queued one", "queued two"]);
    expect(h.pendingNextCount(session!.id)).toBe(0);
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

  it("enqueues /next when it appears on a non-first line of a multiline message", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new_embedded",
      userId: "u_owner",
      text: "/new claude embedded-target",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    const session = await h.store.findSessionByName("embedded-target");
    expect(session).not.toBeNull();
    await h.store.updateSessionStatus(session!.id, "busy", asTimestamp(1));

    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_embedded_next",
      userId: "u_owner",
      text: "这是背景说明，请完成后再做下面的事\n\n/next embedded task content",
      attachments: [],
      receivedAtMs: 2,
    });

    const replies = h.lark.sent.map((m) => m.text);
    expect(replies).not.toContain("⏳ 当前 session 正忙，请等待上一条消息完成");
    expect(replies).toContain("✓ 已排队，将在当前任务完成后执行");

    await h.store.updateSessionStatus(session!.id, "idle", asTimestamp(3));
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_trigger_drain",
      userId: "u_owner",
      text: "/status",
      attachments: [],
      receivedAtMs: 4,
    });

    expect(prompts).toEqual(["embedded task content"]);
  });
});
