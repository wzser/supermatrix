import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asLarkGroupId,
  asMessageRunId,
  asTimestamp,
  type LarkGroupId,
  type MessageRunId,
  type SessionId,
} from "../../src/domain/ids.ts";
import type { BackendKind, Session } from "../../src/domain/session.ts";
import { createHarness, type Harness } from "./harness.ts";

const ACCEPTED_REPLY = "✓ 已注入当前正在执行的任务";
const IDLE_REPLY = "❌ 当前 session 不忙，/now 只能注入正在执行的任务";
const ENDED_REPLY = "❌ 当前任务已结束或已切换，未注入；请重试或使用 /next";
const KIMI_REPLY = "❌ kimi 暂不支持 /now，请使用 /next 或 /cancel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("e2e /now live steer", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({});
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function createBoundSession(backend: BackendKind, name: string) {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: `m_new_${name}`,
      userId: "u_owner",
      text: `/new ${backend} ${name}`,
      attachments: [],
      receivedAtMs: 0,
    });
    const session = await h.store.findSessionByName(name);
    expect(session).not.toBeNull();
    return {
      session: session!,
      groupId: asLarkGroupId(h.lark.createdGroups.at(-1)!),
    };
  }

  async function seedActiveRun(
    backend: BackendKind,
    name: string,
    runId: MessageRunId = asMessageRunId(`mr_${name}`),
  ): Promise<{ session: Session; groupId: LarkGroupId; runId: MessageRunId }> {
    const { session, groupId } = await createBoundSession(backend, name);
    await h.store.updateSessionStatus(session.id, "busy", asTimestamp(1));
    await h.store.startMessageRun({
      id: runId,
      sessionId: session.id,
      groupId,
      prompt: "original task",
      startedAt: asTimestamp(1),
      senderId: "u_owner",
    });
    return { session, groupId, runId };
  }

  async function sendNow(groupId: LarkGroupId, text = "use the new constraint") {
    await h.emitInbound({
      groupId,
      messageId: `m_now_${text.replace(/\W+/gu, "_")}`,
      userId: "u_owner",
      text: `/now ${text}`,
      attachments: [],
      receivedAtMs: 2,
    });
  }

  function expectNoFallback(sessionId: SessionId) {
    expect(h.pendingNextCount(sessionId)).toBe(0);
    expect(h.cancelCalls).toEqual([]);
    expect(h.runInputs).toEqual([]);
  }

  it.each(["claude", "codex"] as const)(
    "routes busy %s /now to the exact active run and replies only after backend acknowledgement",
    async (backend) => {
      const runId = asMessageRunId(`mr_now_exact_${backend}`);
      const { session, groupId } = await seedActiveRun(backend, `now-${backend}`, runId);
      const acknowledgement = deferred<void>();
      const order: string[] = [];
      h.setSteer(async () => {
        await acknowledgement.promise;
        order.push("backend-ack");
        return { accepted: true, backendTurnId: `${backend}-turn` };
      });

      const inbound = sendNow(groupId, `nonce-${backend}`);
      await vi.waitFor(() => expect(h.steerCalls).toHaveLength(1));

      expect(h.lark.sent.map((entry) => entry.text)).not.toContain(ACCEPTED_REPLY);
      acknowledgement.resolve();
      await inbound;
      order.push("accepted-response-observed");

      expect(order).toEqual(["backend-ack", "accepted-response-observed"]);
      expect(h.backendGets.at(-1)).toBe(backend);
      expect(h.steerCalls).toEqual([{
        sessionId: session.id,
        expectedMessageRunId: runId,
        text: `nonce-${backend}`,
      }]);
      expect(h.lark.sent.at(-1)?.text).toBe(ACCEPTED_REPLY);
      expectNoFallback(session.id);
    },
  );

  it("rejects idle without steering, queueing, cancelling, or starting a turn", async () => {
    const { session, groupId } = await createBoundSession("claude", "now-idle");

    await sendNow(groupId);

    expect(h.lark.sent.at(-1)?.text).toBe(IDLE_REPLY);
    expect(h.backendGets).toEqual([]);
    expect(h.steerCalls).toEqual([]);
    expect(await h.store.findLatestMessageRunBySession(session.id)).toBeNull();
    expectNoFallback(session.id);
  });

  it("rejects busy state with a missing active run without any fallback", async () => {
    const { session, groupId } = await createBoundSession("claude", "now-missing");
    await h.store.updateSessionStatus(session.id, "busy", asTimestamp(1));

    await sendNow(groupId);

    expect(h.lark.sent.at(-1)?.text).toBe(ENDED_REPLY);
    expect(h.backendGets).toEqual([]);
    expect(h.steerCalls).toEqual([]);
    expectNoFallback(session.id);
  });

  it.each([
    { label: "ended", replacementRunId: null },
    { label: "switched", replacementRunId: asMessageRunId("mr_now_replacement") },
  ])("reports an $label race when the exact run changes before backend rejection", async ({ replacementRunId }) => {
    const { session, groupId, runId } = await seedActiveRun("claude", "now-race");
    const rejection = deferred<never>();
    h.setSteer(async () => await rejection.promise);

    const inbound = sendNow(groupId);
    await vi.waitFor(() => expect(h.steerCalls).toHaveLength(1));
    await h.store.finishMessageRun(runId, "completed", "finished during steer");
    if (replacementRunId) {
      await h.store.startMessageRun({
        id: replacementRunId,
        sessionId: session.id,
        groupId,
        prompt: "replacement task",
        startedAt: asTimestamp(3),
        senderId: "u_owner",
      });
    }
    rejection.reject(new Error("backend handle is stale"));
    await inbound;

    expect(h.steerCalls[0]?.expectedMessageRunId).toBe(runId);
    expect(h.lark.sent.at(-1)?.text).toBe(ENDED_REPLY);
    expectNoFallback(session.id);
  });

  it("surfaces backend rejection while the exact run stays active and never falls back", async () => {
    const { session, groupId, runId } = await seedActiveRun("codex", "now-rejected");
    h.setSteer(async () => {
      throw new Error("turn/steer rejected nonce-rejected");
    });

    await sendNow(groupId, "nonce-rejected");

    expect(h.steerCalls[0]?.expectedMessageRunId).toBe(runId);
    expect(h.lark.sent.at(-1)?.text).toBe(
      "❌ 注入失败：turn/steer rejected nonce-rejected",
    );
    expect((await h.store.findRunningMessageRunBySession(session.id))?.id).toBe(runId);
    expectNoFallback(session.id);
  });

  it("returns the exact Kimi rejection and never calls steer or /next fallback", async () => {
    const { session, groupId, runId } = await seedActiveRun("kimi", "now-kimi");

    await sendNow(groupId);

    expect(h.lark.sent.at(-1)?.text).toBe(KIMI_REPLY);
    expect(h.backendGets).toEqual([]);
    expect(h.steerCalls).toEqual([]);
    expect((await h.store.findRunningMessageRunBySession(session.id))?.id).toBe(runId);
    expectNoFallback(session.id);
  });
});
