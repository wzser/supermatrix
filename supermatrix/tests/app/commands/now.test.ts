import { describe, expect, test, vi } from "vitest";
import { createNowHandler } from "../../../src/app/commands/now.ts";
import { buildCommandRegistry } from "../../../src/app/commandRegistry.ts";
import { createCommandRouter } from "../../../src/app/commandRouter.ts";
import { createDispatcher } from "../../../src/app/dispatcher.ts";
import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type {
  AgentBackend,
  BackendRegistry,
  RunInput,
  SteerInput,
} from "../../../src/ports/AgentBackend.ts";
import { SteerWindowClosedError } from "../../../src/ports/AgentBackend.ts";
import type { InboundMessage } from "../../../src/ports/LarkGateway.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { createFakeLarkGateway } from "../../fakes/fakeLarkGateway.ts";
import { createFakeReplier } from "../../fakes/fakeReplier.ts";

const GROUP_ID = asLarkGroupId("now_group");
const SESSION_ID = asSessionId("sess_now");
const RUN_ID = asMessageRunId("mr_now_active");

function makeSession(
  status: Session["status"],
  backend: Session["backend"] = "claude",
): Session {
  return {
    id: SESSION_ID,
    name: "now-session",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend,
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/now-session"),
    backendSessionId: null,
    chatName: null,
    purpose: "testing /now",
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

function message(
  text = "/now 补充当前任务",
  origin: InboundMessage["origin"] = "lark_user",
): InboundMessage {
  return {
    groupId: GROUP_ID,
    messageId: "msg_now",
    userId: "user_now",
    text,
    origin,
    attachments: [],
    receivedAtMs: 1_000,
  };
}

function backendRegistry(
  kind: Session["backend"],
  steer?: AgentBackend["steer"],
): BackendRegistry {
  const backend: AgentBackend = {
    kind,
    run(_input: RunInput): AsyncIterable<AgentEvent> {
      return (async function* () {})();
    },
    async cancel() {},
    ...(steer ? { steer } : {}),
  };
  return { get: () => backend, cancel: async () => {} };
}

async function seedRunning(
  store: ReturnType<typeof createFakeBindingStore>,
  backend: Session["backend"] = "claude",
) {
  store.seedSession(makeSession("busy", backend));
  store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(100) });
  await store.startMessageRun({
    id: RUN_ID,
    sessionId: SESSION_ID,
    groupId: GROUP_ID,
    prompt: "original task",
    startedAt: asTimestamp(200),
    senderId: "user_now",
  });
}

function invoke(
  handler: ReturnType<typeof createNowHandler>,
  msg = message(),
) {
  return handler({
    args: { text: "补充当前任务" },
    scope: "user",
    msg,
  });
}

describe("/now command", () => {
  test("is registered as a user-only command with required rest text", () => {
    const command = buildCommandRegistry()["now"]?.command;

    expect(command).toMatchObject({
      name: "now",
      scope: ["user"],
      params: [{ name: "text", type: "string", required: true, kind: "rest" }],
    });
  });

  test("rejects idle without starting a new turn", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession("idle"));
    store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(100) });
    const get = vi.fn(() => backendRegistry("claude").get("claude"));
    const handler = createNowHandler({
      store,
      backendRegistry: { get, cancel: async () => {} },
    });

    expect(await invoke(handler)).toEqual({
      replyText: "❌ 当前 session 不忙，/now 只能注入正在执行的任务",
    });
    expect(get).not.toHaveBeenCalled();
    expect(store._listMessageRuns()).toEqual([]);
  });

  test("rejects a busy session with no running message row", async () => {
    const store = createFakeBindingStore();
    store.seedSession(makeSession("busy"));
    store.seedBinding({ groupId: GROUP_ID, sessionId: SESSION_ID, createdAt: asTimestamp(100) });
    const get = vi.fn(() => backendRegistry("claude").get("claude"));
    const handler = createNowHandler({
      store,
      backendRegistry: { get, cancel: async () => {} },
    });

    expect(await invoke(handler)).toEqual({
      replyText: "❌ 当前任务已结束或已切换，未注入；请重试或使用 /next",
    });
    expect(get).not.toHaveBeenCalled();
  });

  test("returns the explicit Kimi unsupported response", async () => {
    const store = createFakeBindingStore();
    await seedRunning(store, "kimi");
    const get = vi.fn(() => backendRegistry("kimi").get("kimi"));
    const handler = createNowHandler({
      store,
      backendRegistry: { get, cancel: async () => {} },
    });

    expect(await invoke(handler)).toEqual({
      replyText: "❌ kimi 暂不支持 /now，请使用 /next 或 /cancel",
    });
    expect(get).not.toHaveBeenCalled();
  });

  test.each(["claude", "codex"] as const)(
    "accepts an exact-run %s steer capability",
    async (kind) => {
      const store = createFakeBindingStore();
      await seedRunning(store, kind);
      const calls: SteerInput[] = [];
      const handler = createNowHandler({
        store,
        backendRegistry: backendRegistry(kind, async (input) => {
          calls.push(input);
          return { accepted: true, backendTurnId: `${kind}-turn` };
        }),
      });

      expect(await invoke(handler)).toEqual({
        replyText: "✓ 已注入当前正在执行的任务",
      });
      expect(calls).toEqual([{
        sessionId: SESSION_ID,
        expectedMessageRunId: RUN_ID,
        text: "补充当前任务",
      }]);
    },
  );

  test("reports an ended/switched race when the persisted running row changes during rejection", async () => {
    const store = createFakeBindingStore();
    await seedRunning(store);
    const replacementRunId = asMessageRunId("mr_now_replacement");
    const handler = createNowHandler({
      store,
      backendRegistry: backendRegistry("claude", async () => {
        await store.finishMessageRun(RUN_ID, "completed", "done");
        await store.startMessageRun({
          id: replacementRunId,
          sessionId: SESSION_ID,
          groupId: GROUP_ID,
          prompt: "replacement task",
          startedAt: asTimestamp(300),
          senderId: "user_now",
        });
        throw new Error("active backend handle is stale");
      }),
    });

    expect(await invoke(handler)).toEqual({
      replyText: "❌ 当前任务已结束或已切换，未注入；请重试或使用 /next",
    });
  });

  test("reports an actionable window-closed reply instead of the raw backend string", async () => {
    // Live incident 2026-08-10 (adjust3 / mr_ddbb2fd2): the turn's terminal
    // result had already closed claude's stdin (verified via lsof: the child's
    // stdin peer was gone) while the run row still read `running`, so all three
    // freshness guards passed and the user got the raw internal string
    // "claude run is no longer accepting injected messages" with no guidance.
    // The text is definitively NOT in the turn, so the reply must say so and
    // point at /next or /cancel rather than inviting a blind /now retry.
    const store = createFakeBindingStore();
    await seedRunning(store);
    const handler = createNowHandler({
      store,
      backendRegistry: backendRegistry("claude", async () => {
        throw new SteerWindowClosedError(
          "claude",
          "claude run is no longer accepting injected messages",
        );
      }),
    });

    expect(await invoke(handler)).toEqual({
      replyText:
        "❌ 本轮已无法注入：当前任务的输入窗口已关闭，指令未进入任务；请用 /next 排到下一轮，或 /cancel 叫停",
    });
  });

  test("returns a bounded backend rejection reason while the exact run is still active", async () => {
    const store = createFakeBindingStore();
    await seedRunning(store);
    const handler = createNowHandler({
      store,
      backendRegistry: backendRegistry("claude", async () => {
        throw new Error(`protocol rejected ${"x".repeat(300)}`);
      }),
    });

    const result = await invoke(handler);
    expect(result).toHaveProperty("replyText");
    const replyText = "replyText" in result ? result.replyText : "";
    expect(replyText).toMatch(/^❌ 注入失败：protocol rejected x+$/u);
    expect(replyText.length).toBeLessThanOrEqual("❌ 注入失败：".length + 160);
  });

  test("bounds the acknowledgement wait and reports 未确认 when the backend never settles", async () => {
    vi.useFakeTimers();
    try {
      const store = createFakeBindingStore();
      await seedRunning(store);
      const handler = createNowHandler({
        store,
        backendRegistry: backendRegistry("claude", () => new Promise<never>(() => {})),
      });

      const resultP = invoke(handler);
      // CLI ≥2.1.228 queues mid-turn messages and may consume them only at the
      // next tool boundary — measured 15s+ on a sleep-30 tool call — so the
      // window must comfortably cover a long tool step. 60s, not 10s.
      await vi.advanceTimersByTimeAsync(59_000);
      let settled = false;
      void resultP.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      // The queued message can be silently dropped by the CLI (observed
      // enqueue→remove with no consumption), so "请勿原样重发" was actively
      // wrong advice. Tell the user how to verify and what the reliable
      // fallback is instead.
      expect(await resultP).toEqual({
        replyText:
          "❌ 注入未确认：60 秒内未收到 backend 回执。指令可能已排队、延迟生效，也可能被丢弃；" +
          "请观察任务是否按新指令调整，若无变化，用 /cancel 叫停后重新下达",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails explicitly when the selected backend has no steer capability", async () => {
    const store = createFakeBindingStore();
    await seedRunning(store);
    const handler = createNowHandler({
      store,
      backendRegistry: backendRegistry("claude"),
    });

    expect(await invoke(handler)).toEqual({
      replyText: "❌ 注入失败：claude backend 当前运行不支持 /now",
    });
  });

  test("ignores commands that are not trusted Lark-user inbound", async () => {
    const store = createFakeBindingStore();
    const findByGroup = vi.spyOn(store, "findByGroup");
    const handler = createNowHandler({
      store,
      backendRegistry: backendRegistry("claude", async () => ({ accepted: true })),
    });

    const missingOrigin = message();
    delete missingOrigin.origin;
    expect(await invoke(handler, missingOrigin)).toEqual({ handled: true });
    expect(await invoke(handler, message("/now synthetic", "framework_synthetic"))).toEqual({ handled: true });
    expect(findByGroup).not.toHaveBeenCalled();
  });

  test("is routed before the ordinary busy-message guard", async () => {
    const store = createFakeBindingStore();
    await seedRunning(store);
    const backend = backendRegistry("claude", async () => ({ accepted: true }));
    const registry = buildCommandRegistry();
    registry["now"].handler = createNowHandler({ store, backendRegistry: backend });
    const lark = createFakeLarkGateway();
    const dispatcher = createDispatcher({
      store,
      lark,
      router: createCommandRouter(registry),
      backend,
      replier: createFakeReplier(),
      rootGroupId: asLarkGroupId("root_group"),
      clock: { now: () => asTimestamp(1_000) },
      idFactory: () => "unused",
    });

    await dispatcher.handleInbound(message());

    expect(lark.sent.map((entry) => entry.text)).toEqual([
      "✓ 已注入当前正在执行的任务",
    ]);
  });
});
