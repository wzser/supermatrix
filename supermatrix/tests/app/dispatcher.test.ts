import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpawnChildInput } from "../../src/app/childSession.ts";
import { createDispatcher, type DispatcherDeps } from "../../src/app/dispatcher.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import {
  asAbsolutePath,
  asCardId,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { AgentBackend, BackendRegistry, RunInput } from "../../src/ports/AgentBackend.ts";
import type { InboundMessage } from "../../src/ports/LarkGateway.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeReplier } from "../fakes/fakeReplier.ts";

const ROOT_GROUP = asLarkGroupId("root_group");
const USER_GROUP = asLarkGroupId("user_group");

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClock() {
  return { now: () => asTimestamp(1000) };
}

function makeIdFactory() {
  let n = 0;
  return () => `id_${++n}`;
}

function makeMsg(
  groupId: ReturnType<typeof asLarkGroupId>,
  text: string,
  overrides: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    groupId,
    messageId: "msg1",
    userId: "user1",
    text,
    attachments: [],
    receivedAtMs: 1000,
    ...overrides,
  };
}

function makeSession(id: string, status: Session["status"] = "idle"): Session {
  return {
    id: asSessionId(id),
    name: "test-session",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/work"),
    backendSessionId: null,
    chatName: null,
    purpose: "testing",
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

function makeFakeBackendRegistry(events: AgentEvent[] = []): BackendRegistry {
  const backend: AgentBackend = {
    kind: "claude",
    run(_input: RunInput): AsyncIterable<AgentEvent> {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    async cancel(_sessionId) {},
  };
  return {
    get: () => backend,
    cancel: async () => {},
  };
}

function makeCapturingBackendRegistry(
  events: AgentEvent[] = [],
): { registry: BackendRegistry; captured: RunInput[] } {
  const captured: RunInput[] = [];
  const backend: AgentBackend = {
    kind: "claude",
    run(input: RunInput): AsyncIterable<AgentEvent> {
      captured.push(input);
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    async cancel(_sessionId) {},
  };
  return {
    registry: { get: () => backend, cancel: async () => {} },
    captured,
  };
}

describe("dispatcher", () => {
  it("routes slash command to router, not backend", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: { scope: unknown; msg: InboundMessage }) {
        return { replyText: "✅ command handled" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "/help"));

    expect(lark.sent).toHaveLength(1);
    expect(lark.sent[0].text).toBe("✅ command handled");
    expect(replier.consumed).toHaveLength(0);
  });

  it("routes bare stop heartbeat shortcut to router", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const router = {
      async route(input: { scope: unknown; msg: InboundMessage }) {
        routedTexts.push(input.msg.text);
        return { replyText: "✅ heartbeat paused" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "stop heartbeat 100"));

    expect(routedTexts).toEqual(["/heartbeat stop 100"]);
    expect(lark.sent[0].text).toBe("✅ heartbeat paused");
    expect(replier.consumed).toHaveLength(0);
  });

  it("routes bare resume heartbeat shortcut to router", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const router = {
      async route(input: { scope: unknown; msg: InboundMessage }) {
        routedTexts.push(input.msg.text);
        return { replyText: "✅ heartbeat resumed" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "resume heartbeat"));

    expect(routedTexts).toEqual(["/heartbeat resume"]);
    expect(lark.sent[0].text).toBe("✅ heartbeat resumed");
    expect(replier.consumed).toHaveLength(0);
  });

  it("runs backend for non-slash prompt in user group", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_001");
    const session = makeSession("sess_001", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "back_1" },
      { kind: "completed", finalMessage: "done" },
    ];
    const backend = makeFakeBackendRegistry(events);

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "hello world"));

    expect(replier.consumed).toHaveLength(1);
    expect(replier.consumed[0].sessionId).toBe(sessionId);

    // After completion, no running run should remain
    const runningRun = await store.findRunningMessageRunBySession(sessionId);
    expect(runningRun).toBeNull();
  });

  it("drains pending /next messages in FIFO order after each run finishes", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_fifo");
    const session = makeSession("sess_fifo", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "back_fifo" },
      { kind: "completed", finalMessage: "done" },
    ];
    const { registry, captured } = makeCapturingBackendRegistry(events);
    const pendingQueue = [
      { text: "queued one", groupId: USER_GROUP, userId: "user1" },
      { text: "queued two", groupId: USER_GROUP, userId: "user1" },
    ];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { replyText: "should not be called" };
        },
      },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      pendingNext: {
        has: () => pendingQueue.length > 0,
        shift: () => pendingQueue.shift(),
        restoreFront: (_sessionId, entry) => {
          pendingQueue.unshift(entry);
        },
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "initial prompt"));

    expect(captured.map((input) => input.prompt)).toEqual([
      "initial prompt",
      "queued one",
      "queued two",
    ]);
    expect(pendingQueue).toEqual([]);
  });

  it("serializes concurrent pending /next drains for the same session", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_fifo_concurrent");
    store.seedSession(makeSession("sess_fifo_concurrent", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    let activeRuns = 0;
    let maxActiveRuns = 0;
    let releaseFirst: (() => void) | undefined;
    const prompts: string[] = [];
    const backend: AgentBackend = {
      kind: "claude",
      run(input: RunInput): AsyncIterable<AgentEvent> {
        prompts.push(input.prompt);
        activeRuns += 1;
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
        return (async function* () {
          yield { kind: "started" as const, backendSessionId: "back_fifo_concurrent" };
          if (input.prompt === "queued one") {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          yield { kind: "completed" as const, finalMessage: `done: ${input.prompt}` };
          activeRuns -= 1;
        })();
      },
      async cancel(_sessionId) {},
    };
    const pendingQueue = [
      { text: "queued one", groupId: USER_GROUP, userId: "user1" },
      { text: "queued two", groupId: USER_GROUP, userId: "user1" },
    ];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { handled: true };
        },
      },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      pendingNext: {
        has: () => pendingQueue.length > 0,
        shift: () => pendingQueue.shift(),
        restoreFront: (_sessionId, entry) => {
          pendingQueue.unshift(entry);
        },
      },
    });

    const firstDrain = dispatcher.handleInbound(makeMsg(USER_GROUP, "/status", { messageId: "cmd1" }));
    const secondDrain = dispatcher.handleInbound(makeMsg(USER_GROUP, "/status", { messageId: "cmd2" }));

    for (let i = 0; i < 10 && !releaseFirst; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releaseFirst).toBeTypeOf("function");
    releaseFirst?.();
    await Promise.all([firstDrain, secondDrain]);

    expect(prompts).toEqual(["queued one", "queued two"]);
    expect(maxActiveRuns).toBe(1);
    expect(pendingQueue).toEqual([]);
  });

  it("passes previous Codex raw usage totals to the replier as the usage baseline", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();

    const sessionId = asSessionId("sess_codex");
    const session = {
      ...makeSession("sess_codex", "idle"),
      backend: "codex" as const,
      model: "gpt-5.5",
      backendSessionId: "bks-codex",
    };
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const baseline = {
      inputTokens: 24_255_780,
      outputTokens: 69_736,
      cacheReadTokens: 23_092_608,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    store.seedTokenUsageRawTotals(sessionId, baseline);

    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "bks-codex" },
      { kind: "completed", finalMessage: "done" },
    ];
    const backend = makeFakeBackendRegistry(events);
    let seenBaseline: unknown;
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        seenBaseline = input.usageBaseline;
        for await (const _ of input.stream) {
          // drain stream
        }
        return {
          finalMessage: "done",
          cardId: asCardId("card_1"),
          runStatus: "completed" as const,
          streamLog: [],
        };
      },
    };

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "hello codex"));

    expect(seenBaseline).toEqual(baseline);
  });

  it("clears a Codex resume id after Bad Request from the resumed thread", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();

    const sessionId = asSessionId("sess_codex_bad_resume");
    const session = {
      ...makeSession("sess_codex_bad_resume", "idle"),
      backend: "codex" as const,
      model: "gpt-5.5",
      backendSessionId: "bad-thread",
    };
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const backend = makeFakeBackendRegistry([
      { kind: "started", backendSessionId: "bad-thread" },
    ]);
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _ of input.stream) {
          // drain stream
        }
        return {
          finalMessage: '❌ {"detail":"Bad Request"}',
          cardId: asCardId("card_bad_resume"),
          error: '{"detail":"Bad Request"}',
          runStatus: "failed" as const,
          backendSessionId: "bad-thread",
          streamLog: [
            {
              ts: 1000,
              kind: "error" as const,
              text: "Reconnecting... 5/5 (stream disconnected before completion: websocket closed by server before response.completed)",
            },
            { ts: 1001, kind: "error" as const, text: '{"detail":"Bad Request"}' },
          ],
        };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { replyText: "should not be called" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "resume please"));

    const updated = await store.findSessionById(sessionId);
    expect(updated?.status).toBe("idle");
    expect(updated?.backendSessionId).toBeNull();
  });

  it("clears a Codex resume id after missing rollout on thread resume", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();

    const sessionId = asSessionId("sess_codex_missing_rollout");
    const session = {
      ...makeSession("sess_codex_missing_rollout", "idle"),
      backend: "codex" as const,
      model: "gpt-5.5",
      backendSessionId: "019e1a43-3ba5-7171-8671-1930a6c15bc9",
    };
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const backend = makeFakeBackendRegistry([]);
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _ of input.stream) {
          // drain stream
        }
        return {
          finalMessage: "❌ Error: thread/resume: thread/resume failed: no rollout found for thread id 019e1a43-3ba5-7171-8671-1930a6c15bc9",
          cardId: asCardId("card_missing_rollout"),
          error: "Error: thread/resume: thread/resume failed: no rollout found for thread id 019e1a43-3ba5-7171-8671-1930a6c15bc9",
          runStatus: "failed" as const,
          streamLog: [],
        };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { replyText: "should not be called" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "resume please"));

    const updated = await store.findSessionById(sessionId);
    expect(updated?.status).toBe("idle");
    expect(updated?.backendSessionId).toBeNull();
  });

  it("rejects when session is busy", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_busy");
    const session = makeSession("sess_busy", "busy");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "a normal message"));

    expect(lark.sent).toHaveLength(1);
    expect(lark.sent[0].text).toContain("正忙");
    expect(replier.consumed).toHaveLength(0);
  });

  it("silently ignores messages starting with ~", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "~ this is a note"));
    await dispatcher.handleInbound(makeMsg(USER_GROUP, "~memo"));

    expect(lark.sent).toHaveLength(0);
    expect(replier.consumed).toHaveLength(0);
  });

  it("silently ignores messages starting with full-width ～ (Chinese IME)", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "～ this is a note"));
    await dispatcher.handleInbound(makeMsg(USER_GROUP, "～memo"));

    expect(lark.sent).toHaveLength(0);
    expect(replier.consumed).toHaveLength(0);
  });

  it("routes full-width slash command via router (Chinese IME)", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: { scope: unknown; msg: InboundMessage }) {
        return { replyText: "✅ command handled" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "／help"));

    expect(lark.sent).toHaveLength(1);
    expect(lark.sent[0].text).toBe("✅ command handled");
    expect(replier.consumed).toHaveLength(0);
  });

  it("preserves original full-width text on prompt path (no NFKC for LLM input)", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_prompt");
    const session = makeSession("sess_prompt", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "back_1" },
      { kind: "completed", finalMessage: "done" },
    ];
    let receivedPrompt: string | undefined;
    const backend: BackendRegistry = {
      get: () => ({
        kind: "claude",
        run(input: RunInput): AsyncIterable<AgentEvent> {
          receivedPrompt = input.prompt;
          return (async function* () {
            for (const e of events) yield e;
          })();
        },
        async cancel() {},
      }),
      cancel: async () => {},
    };

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    // User intentionally writes Chinese full-width punctuation in prompt body
    const fullWidthBody = "请帮我写一段代码／配置";
    await dispatcher.handleInbound(makeMsg(USER_GROUP, fullWidthBody));

    expect(receivedPrompt).toBe(fullWidthBody);
  });

  it("rejects non-slash prompt in root group", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const router = {
      async route(_input: unknown) {
        return { replyText: "should not be called" };
      },
    };

    const dispatcher = createDispatcher({
      store,
      lark,
      router,
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "just a message"));

    expect(lark.sent).toHaveLength(0);
    expect(replier.consumed).toHaveLength(0);
  });

  it("dispatches card actions through the internal async child-session path", async () => {
    const store = createFakeBindingStore();
    store.seedSession({ ...makeSession("sess_target_card"), name: "target-session" });
    store.seedSession({ ...makeSession("sess_supermatrix_root"), name: "supermatrix-root" });
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const spawnInputs: SpawnChildInput[] = [];
    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { replyText: "should not route" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      childSession: {
        async spawnChild(input: SpawnChildInput) {
          spawnInputs.push(input);
          return {
            session: { ...makeSession("sess_child_card"), scope: "child", parentId: asSessionId("sess_target_card"), depth: 1 },
            finalMessage: "done",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_child_card"),
            spawnCommId: "comm_child_card",
          };
        },
      },
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "CARD_ACTION:" + JSON.stringify({
      target_session: "target-session",
      card_action_id: "card_action_1712345678",
      action: "approve",
    })));

    await vi.waitFor(() => expect(spawnInputs).toHaveLength(1));
    const input = spawnInputs[0]!;
    expect(input).toMatchObject({
      parentId: asSessionId("sess_target_card"),
      requestedBy: asSessionId("sess_supermatrix_root"),
      callerInvocation: "async_kickoff",
      triggerKind: "session",
      resultSinks: [{ kind: "pollable_endpoint" }],
      verificationPredicate: {
        predicate: {
          type: "inbox-message",
          session_name: "target-session",
          field: "prompt",
          expected_window_sec: 600,
        },
      },
    });
    expect(input.prompt).toContain("\"card_action_id\":\"card_action_1712345678\"");
    expect(input.prompt).toContain("\"spawn_predicate_anchor\":");
    expect(input.verificationPredicate?.predicate.type).toBe("inbox-message");
    const containsAll = input.verificationPredicate?.predicate.type === "inbox-message"
      ? input.verificationPredicate.predicate.contains_all
      : [];
    expect(containsAll).toEqual(
      expect.arrayContaining(["card_action_id", "card_action_1712345678"]),
    );
    const generatedAnchor = containsAll?.find((token) => token.startsWith("comm_card_action_spawn_"));
    expect(generatedAnchor).toBeTruthy();
    expect(input.prompt).toContain(generatedAnchor);
  });

  describe("外部 session trust boundary", () => {
    const OWNER_ID = "LARK_OWNER_OPEN_ID";
    const NON_OWNER_ID = "ou_outsider_001";

    function makeExternalSession(id: string): Session {
      return { ...makeSession(id, "idle"), category: "外部" as const };
    }

    it("silently ignores unmentioned prompt in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();
      const replier = createFakeReplier();

      const sessionId = asSessionId("sess_ext_unmentioned_prompt");
      store.seedSession(makeExternalSession("sess_ext_unmentioned_prompt"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      let routerCalled = false;
      let fetchCalled = false;
      const { registry, captured } = makeCapturingBackendRegistry([
        { kind: "started", backendSessionId: "back_unmentioned" },
        { kind: "completed", finalMessage: "answer" },
      ]);

      const dispatcher = createDispatcher({
        store,
        lark,
        router: {
          async route(_input: unknown) {
            routerCalled = true;
            return { replyText: "should not be called" };
          },
        },
        backend: registry,
        replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ext_unmentioned_prompt",
        userId: NON_OWNER_ID,
        text: "what is 2+2?",
        attachments: [{
          kind: "image",
          originalName: "photo.jpg",
          fetch: async () => {
            fetchCalled = true;
            return { localPath: asAbsolutePath("/tmp/photo.jpg") };
          },
        }],
        receivedAtMs: 1000,
      });

      expect(routerCalled).toBe(false);
      expect(fetchCalled).toBe(false);
      expect(captured).toHaveLength(0);
      expect(lark.sent).toHaveLength(0);
      expect(replier.consumed).toHaveLength(0);
    });

    it("silently ignores unmentioned slash command in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();
      const replier = createFakeReplier();
      const backend = makeFakeBackendRegistry();

      const sessionId = asSessionId("sess_ext_unmentioned_slash");
      store.seedSession(makeExternalSession("sess_ext_unmentioned_slash"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      let routerCalled = false;
      const dispatcher = createDispatcher({
        store, lark,
        router: {
          async route(_input: unknown) {
            routerCalled = true;
            return { replyText: "should not be called" };
          },
        },
        backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ext_unmentioned_slash",
        userId: OWNER_ID,
        text: "/status",
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(routerCalled).toBe(false);
      expect(lark.sent).toHaveLength(0);
      expect(replier.consumed).toHaveLength(0);
    });

    it("rejects slash command from non-owner in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();
      const replier = createFakeReplier();
      const backend = makeFakeBackendRegistry();

      const sessionId = asSessionId("sess_ext1");
      store.seedSession(makeExternalSession("sess_ext1"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      let routerCalled = false;
      const router = {
        async route(_input: unknown) {
          routerCalled = true;
          return { replyText: "should not be called" };
        },
      };

      const dispatcher = createDispatcher({
        store, lark, router, backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ext_slash",
        userId: NON_OWNER_ID,
        text: "/help",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(routerCalled).toBe(false);
      expect(lark.sent).toHaveLength(1);
      expect(lark.sent[0].text).toContain("owner");
      expect(replier.consumed).toHaveLength(0);
    });

    it("allows slash command from owner in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();
      const replier = createFakeReplier();
      const backend = makeFakeBackendRegistry();

      const sessionId = asSessionId("sess_ext2");
      store.seedSession(makeExternalSession("sess_ext2"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const router = {
        async route(_input: unknown) {
          return { replyText: "✅ owner command ok" };
        },
      };

      const dispatcher = createDispatcher({
        store, lark, router, backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_owner_slash",
        userId: OWNER_ID,
        text: "/status",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(lark.sent).toHaveLength(1);
      expect(lark.sent[0].text).toBe("✅ owner command ok");
      expect(replier.consumed).toHaveLength(0);
    });

    it("routes owner slash command after leading bot mention in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();
      const replier = createFakeReplier();
      const backend = makeFakeBackendRegistry();

      const sessionId = asSessionId("sess_ext_mentioned_slash");
      store.seedSession(makeExternalSession("sess_ext_mentioned_slash"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      let routedText = "";
      const router = {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedText = input.msg.text;
          return { replyText: "✅ mentioned command ok" };
        },
      };

      const dispatcher = createDispatcher({
        store, lark, router, backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_owner_mentioned_slash",
        userId: OWNER_ID,
        text: "@SuperMatrix /help",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(routedText).toBe("/help");
      expect(lark.sent).toHaveLength(1);
      expect(lark.sent[0].text).toBe("✅ mentioned command ok");
      expect(replier.consumed).toHaveLength(0);
    });

    it("invokes backend with answerOnly: true for non-owner prompt in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext_ao");
      store.seedSession(makeExternalSession("sess_ext_ao"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const events: AgentEvent[] = [
        { kind: "started", backendSessionId: "back_ao" },
        { kind: "completed", finalMessage: "answer" },
      ];
      const { registry, captured } = makeCapturingBackendRegistry(events);
      const replier = createFakeReplier();

      const dispatcher = createDispatcher({
        store, lark,
        router: { async route(_: unknown) { return { replyText: "" }; } },
        backend: registry, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ao_non_owner",
        userId: NON_OWNER_ID,
        text: "what is the weather?",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].answerOnly).toBe(true);
      expect(captured[0].prompt).toContain("Sender role: external_non_owner");
      expect(captured[0].prompt).toContain(`Incoming sender ou_id: ${NON_OWNER_ID}`);
      expect(captured[0].prompt).not.toContain(OWNER_ID);
      expect(captured[0].prompt).toContain("[User message]\nwhat is the weather?");
    });

    it("skips persisting backend session id for external non-owner answer-only runs", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext_ao_phantom");
      const seeded: Session = {
        ...makeExternalSession("sess_ext_ao_phantom"),
        backend: "codex" as const,
        backendSessionId: "prior-good-thread",
      };
      store.seedSession(seeded);
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const backend = makeFakeBackendRegistry([
        { kind: "started", backendSessionId: "phantom-ephemeral-thread" },
        { kind: "completed", finalMessage: "answer" },
      ]);
      const replier = {
        async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
          for await (const _ of input.stream) {
            // drain stream
          }
          return {
            finalMessage: "answer",
            cardId: asCardId("card_phantom"),
            runStatus: "completed" as const,
            backendSessionId: "phantom-ephemeral-thread",
            streamLog: [],
          };
        },
      };

      const dispatcher = createDispatcher({
        store, lark,
        router: { async route(_: unknown) { return { replyText: "" }; } },
        backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ao_phantom",
        userId: NON_OWNER_ID,
        text: "what is the weather?",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      const updated = await store.findSessionById(sessionId);
      expect(updated?.backendSessionId).toBe("prior-good-thread");
    });

    it("invokes backend without answerOnly for owner prompt in 外部 session", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext_owner");
      store.seedSession(makeExternalSession("sess_ext_owner"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const events: AgentEvent[] = [
        { kind: "started", backendSessionId: "back_owner" },
        { kind: "completed", finalMessage: "answer" },
      ];
      const { registry, captured } = makeCapturingBackendRegistry(events);
      const replier = createFakeReplier();

      const dispatcher = createDispatcher({
        store, lark,
        router: { async route(_: unknown) { return { replyText: "" }; } },
        backend: registry, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ao_owner",
        userId: OWNER_ID,
        text: "deploy the app",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].answerOnly).toBeFalsy();
      expect(captured[0].prompt).toContain("Sender role: owner");
      expect(captured[0].prompt).toContain(`Configured owner ou_id: ${OWNER_ID}`);
      expect(captured[0].prompt).toContain(`Incoming sender ou_id: ${OWNER_ID}`);
      expect(captured[0].prompt).toContain("[User message]\ndeploy the app");
    });

    it("passes non-slash prompt from non-owner to backend but skips attachment fetch", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext3");
      store.seedSession(makeExternalSession("sess_ext3"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      let fetchCalled = false;
      const fakeAttachment = {
        kind: "image" as const,
        originalName: "photo.jpg",
        fetch: async () => {
          fetchCalled = true;
          return { localPath: asAbsolutePath("/tmp/photo.jpg") };
        },
      };

      const events: AgentEvent[] = [
        { kind: "started", backendSessionId: "back_ext" },
        { kind: "completed", finalMessage: "answer" },
      ];
      const backend = makeFakeBackendRegistry(events);
      const replier = createFakeReplier();

      const router = {
        async route(_input: unknown) {
          return { replyText: "should not be called" };
        },
      };

      const dispatcher = createDispatcher({
        store, lark, router, backend, replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ext_prompt",
        userId: NON_OWNER_ID,
        text: "what is 2+2?",
        mentionedBot: true,
        attachments: [fakeAttachment],
        receivedAtMs: 1000,
      });

      expect(fetchCalled).toBe(false);
      expect(replier.consumed).toHaveLength(1);
      expect(replier.consumed[0].sessionId).toBe(sessionId);
    });
  });
});
