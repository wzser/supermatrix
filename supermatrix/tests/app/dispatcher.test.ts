import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CARD_ASK_SYSTEM_HINT } from "../../src/app/cardAskGate.ts";
import type { SpawnChildInput } from "../../src/app/childSession.ts";
import { createDispatcher, type DispatcherDeps } from "../../src/app/dispatcher.ts";
import { createSetModelHandler } from "../../src/app/commands/setModel.ts";
import { createReplier } from "../../src/app/replier.ts";
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
import { isConfirmedCodexModelUnavailable } from "../../src/adapters/backend-codex/modelUnavailable.ts";
import {
  isCodexRouteOverrideActive,
  ROUTE_STATE_CONTRACT_VERSION,
} from "../../src/adapters/backend-codex/routeState.ts";
import type { Logger } from "../../src/ports/Logger.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../src/ports/BackendRuntimeDefaults.ts";

const ROOT_GROUP = asLarkGroupId("root_group");
const USER_GROUP = asLarkGroupId("user_group");

afterEach(() => {
  vi.unstubAllGlobals();
  resetConfiguredBackendRuntimeDefaultsForTests();
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

function makePostJson(lines: string[][]): string {
  return JSON.stringify({
    title: "",
    content: lines.map((line) => line.map((text) => ({ tag: "text", text }))),
  });
}

function makeSession(
  id: string,
  status: Session["status"] = "idle",
  overrides: Partial<Session> = {},
): Session {
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
    ...overrides,
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
  kind: Session["backend"] = "claude",
): { registry: BackendRegistry; captured: RunInput[] } {
  const captured: RunInput[] = [];
  const backend: AgentBackend = {
    kind,
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

function makeScriptedRegistry(...scripts: AgentEvent[][]): { registry: BackendRegistry; captured: RunInput[] } {
  const captured: RunInput[] = [];
  let call = 0;
  const backend: AgentBackend = {
    kind: "codex",
    run(input) {
      captured.push(input);
      const script = scripts[call++] ?? [];
      return (async function* () { for (const event of script) yield event; })();
    },
    async cancel() {},
  };
  return { registry: { get: () => backend, cancel: async () => {} }, captured };
}

describe("dispatcher", () => {
  it("does not leak the in-flight counter when a run fails to start (updateSessionStatus throws)", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_leak");
    store.seedSession(makeSession("sess_leak", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    // Simulate a transient DB error while marking the session busy — the exact
    // window (between runStarted and the run's try/finally) where inFlight leaked.
    const realUpdate = store.updateSessionStatus.bind(store);
    store.updateSessionStatus = async (id, status, now) => {
      if (status === "busy") throw new Error("db locked mid-start");
      return realUpdate(id, status, now);
    };
    let started = 0;
    let finished = 0;
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: makeFakeBackendRegistry([{ kind: "completed", finalMessage: "ok" }]),
      replier: createFakeReplier(),
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      lifecycle: { runStarted: () => { started++; }, runFinished: () => { finished++; } },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "a prompt")).catch(() => {});

    // Balanced: either the run never counted, or it was counted and released.
    // The bug left started=1, finished=0 (inFlight permanently pinned at 1).
    expect(started).toBe(finished);
  });

  it("retries a before-work Codex unavailable error through the existing replier and run", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_dispatch_recovery");
    store.seedSession(makeSession("sess_dispatch_recovery", "idle", {
      backend: "codex", model: "gpt-5.5", effort: "xhigh", backendSessionId: "row-resume",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.createSessionBranch({
      sessionId,
      name: "plan-a",
      sourceBranchName: "main",
      sourceBackendSessionId: "row-resume",
      forkPending: false,
      createdAt: asTimestamp(101),
    });
    await store.updateSessionBranchBackendSessionId(sessionId, "plan-a", "branch-resume", asTimestamp(102));
    await store.setActiveBranch(sessionId, "plan-a", asTimestamp(103));
    const { registry, captured } = makeScriptedRegistry(
      [{ kind: "error", message: "The model `gpt-5.5` does not exist or you do not have access to it", recoverable: false }],
      [{ kind: "started", backendSessionId: "fresh" }, { kind: "completed", finalMessage: "ok" }],
    );
    const replier = createFakeReplier();
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_dispatch_recovery",
      codexRuntimeRecovery: {
        availability: { probe: async (model) => model === "gpt-5.6-sol"
          ? { kind: "available", checkedAt: 1 }
          : { kind: "unavailable", checkedAt: 1, reason: "no" } },
        isModelUnavailable: isConfirmedCodexModelUnavailable,
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "same prompt"));

    expect(captured).toHaveLength(2);
    expect(captured.map((input) => input.prompt)).toEqual(["same prompt", "same prompt"]);
    expect(captured[0].session.backendSessionId).toBe("branch-resume");
    expect(captured[1].session.backendSessionId).toBe("branch-resume");
    expect((await store.findSessionById(sessionId))?.model).toBe("gpt-5.6-sol");
    expect(replier.consumed).toHaveLength(1);
    expect(store._listMessageRuns()).toHaveLength(1);
  });

  it("updates Codex recovery retry card titles from the authoritative retry execution config", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const sessionId = asSessionId("sess_dispatch_recovery_title");
    store.seedSession(makeSession("sess_dispatch_recovery_title", "idle", {
      name: "codexroot",
      backend: "codex",
      model: "gpt-5.5",
      effort: "ultra",
      backendSessionId: "thread-title",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const { registry, captured } = makeScriptedRegistry(
      [{ kind: "error", message: "The model `gpt-5.5` does not exist or you do not have access to it", recoverable: false }],
      [
        { kind: "started", backendSessionId: "thread-title" },
        {
          kind: "usage",
          model: "gpt-5.6-sol",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          rawUsage: null,
        },
        { kind: "assistant_message", text: "ok", final: true },
        { kind: "completed", finalMessage: "ok" },
      ],
    );
    const replier = createReplier({
      lark,
      clock: makeClock(),
      monotonic: () => 1000,
    });
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "unused" }; } },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_card_effort_retry",
      codexRuntimeRecovery: {
        availability: { probe: async (model) => model === "gpt-5.6-sol"
          ? { kind: "available", checkedAt: 1 }
          : { kind: "unavailable", checkedAt: 1, reason: "no" } },
        isModelUnavailable: isConfirmedCodexModelUnavailable,
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "same prompt"));

    expect(captured).toHaveLength(2);
    expect(captured[0]?.execution).toEqual({ backend: "codex", model: "gpt-5.5", effort: "xhigh" });
    expect(captured[1]?.execution).toEqual({ backend: "codex", model: "gpt-5.6-sol", effort: "ultra" });
    expect(lark.finalized[0]?.title).toBe(
      "codexroot@main | GPT-5.6 Sol · done | ULTRA | mr_card_effort_retry",
    );
  });

  it("repairs a post-work Codex failure only after dispatcher finalizes the original error", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_dispatch_post_work");
    store.seedSession(makeSession("sess_dispatch_post_work", "idle", {
      backend: "codex", model: "gpt-5.5", effort: "xhigh", backendSessionId: "same-thread",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const { registry } = makeScriptedRegistry([
      { kind: "started", backendSessionId: "same-thread" },
      { kind: "error", message: "The model `gpt-5.5` does not exist or you do not have access to it", recoverable: false },
    ]);
    const statusesAtMutation: string[] = [];
    const apply = store.applySessionRuntimeConfigMutations.bind(store);
    store.applySessionRuntimeConfigMutations = async (mutations) => {
      statusesAtMutation.push((await store.findSessionById(sessionId))?.status ?? "missing");
      return await apply(mutations);
    };
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _event of input.stream) { /* consume existing stream */ }
        return {
          finalMessage: "partial",
          cardId: asCardId("post_work"),
          error: "The model `gpt-5.5` does not exist or you do not have access to it",
          runStatus: "failed" as const,
          backendSessionId: "same-thread",
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_dispatch_post",
      codexRuntimeRecovery: {
        availability: { probe: async () => ({ kind: "available", checkedAt: 1 }) },
        isModelUnavailable: isConfirmedCodexModelUnavailable,
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "post work"));

    expect(statusesAtMutation).toEqual(["idle"]);
    expect(store._getMessageRun(asMessageRunId("mr_dispatch_post"))?.status).toBe("failed");
  });

  it("preserves a newer tuple on post-work conflict before draining queued next", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_dispatch_post_conflict");
    store.seedSession(makeSession("sess_dispatch_post_conflict", "idle", {
      backend: "codex", model: "gpt-5.5", effort: "xhigh",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const prompts: string[] = [];
    let calls = 0;
    const backend: AgentBackend = {
      kind: "codex",
      run(input) {
        calls += 1;
        prompts.push(input.prompt);
        if (input.prompt === "queued after conflict") {
          return (async function* () { yield { kind: "completed", finalMessage: "queued ok" } as AgentEvent; })();
        }
        return (async function* () {
          yield { kind: "started", backendSessionId: "same-thread" } as AgentEvent;
          yield { kind: "error", message: "The model `gpt-5.5` does not exist or you do not have access to it", recoverable: false } as AgentEvent;
          await store.updateSessionModel(sessionId, "gpt-5.6-terra");
          await store.updateSessionEffort(sessionId, "max");
        })();
      },
      async cancel() {},
    };
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug() {}, info() {}, error() {},
      warn(message, fields) { warnings.push({ message, ...(fields ? { fields } : {}) }); },
      child() { return logger; },
    };
    const pendingQueue = [{ text: "queued after conflict", groupId: USER_GROUP, userId: "user1" }];
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        let error: string | undefined;
        let finalMessage = "";
        for await (const event of input.stream) {
          if (event.kind === "error") error = event.message;
          if (event.kind === "completed") finalMessage = event.finalMessage;
        }
        return {
          finalMessage,
          cardId: asCardId("post_conflict"),
          ...(error ? { error, runStatus: "failed" as const } : { runStatus: "completed" as const }),
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      logger,
      pendingNext: {
        has: () => pendingQueue.length > 0,
        shift: () => pendingQueue.shift(),
        restoreFront: (_id, entry) => pendingQueue.unshift(entry),
      },
      codexRuntimeRecovery: {
        availability: { probe: async () => ({ kind: "available", checkedAt: 1 }) },
        isModelUnavailable: isConfirmedCodexModelUnavailable,
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "post work conflict"));

    expect(calls).toBe(2);
    expect(prompts).toEqual(["post work conflict", "queued after conflict"]);
    expect(store._listMessageRuns().find((run) => run.prompt === "post work conflict")?.status).toBe("failed");
    expect(await store.findSessionById(sessionId)).toMatchObject({ model: "gpt-5.6-terra", effort: "max" });
    expect(warnings).toContainEqual(expect.objectContaining({
      message: "codex runtime next-run repair conflict; preserving newer tuple",
    }));
  });

  it("clears a stale Kimi backend session id after Unknown sessionId", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_kimi_unknown_session");
    store.seedSession(makeSession("sess_kimi_unknown_session", "idle", {
      backend: "kimi",
      backendSessionId: "e55e28d9-d58d-4940-8e9b-78e0d1b7f33c",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _event of input.stream) { /* consume existing stream */ }
        return {
          finalMessage: "",
          cardId: asCardId("kimi_unknown_session"),
          error: "Invalid params: Unknown sessionId: e55e28d9-d58d-4940-8e9b-78e0d1b7f33c",
          runStatus: "failed" as const,
          streamLog: [],
        };
      },
    };
    const backend: AgentBackend = {
      kind: "kimi",
      run() {
        return (async function* () {
          yield { kind: "error", message: "Invalid params: Unknown sessionId: e55e28d9-d58d-4940-8e9b-78e0d1b7f33c", recoverable: false } as AgentEvent;
        })();
      },
      async cancel() {},
    };
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_kimi_unknown_session",
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "resume kimi"));

    expect((await store.findSessionById(sessionId))?.backendSessionId).toBeNull();
    expect(store._getMessageRun(asMessageRunId("mr_kimi_unknown_session"))?.status).toBe("failed");
  });

  it("transparently retries a stale Kimi resume in-run and persists the fresh session id", async () => {
    const store = createFakeBindingStore();
    const staleId = "e55e28d9-d58d-4940-8e9b-78e0d1b7f33c";
    const sessionId = asSessionId("sess_kimi_resume_retry");
    store.seedSession(makeSession("sess_kimi_resume_retry", "idle", {
      backend: "kimi",
      backendSessionId: staleId,
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const clearSpy = vi.spyOn(store, "clearSessionBranchBackendSessionId");
    const runInputs: RunInput[] = [];
    const backend: AgentBackend = {
      kind: "kimi",
      run(input) {
        runInputs.push(input);
        if (input.session.backendSessionId === staleId) {
          return (async function* () {
            yield { kind: "error", message: `Invalid params: Unknown sessionId: ${staleId}`, recoverable: false } as AgentEvent;
          })();
        }
        return (async function* () {
          yield { kind: "started", backendSessionId: "fresh-kimi-session" } as AgentEvent;
          yield { kind: "assistant_message", text: "recovered", final: false } as AgentEvent;
          yield { kind: "completed", finalMessage: "recovered" } as AgentEvent;
        })();
      },
      async cancel() {},
    };
    const seenTexts: string[] = [];
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        let backendSessionId: string | undefined;
        for await (const event of input.stream) {
          if (event.kind === "started") backendSessionId = event.backendSessionId;
          if (event.kind === "assistant_message") seenTexts.push(event.text);
        }
        return {
          finalMessage: "recovered",
          cardId: asCardId("kimi_resume_retry"),
          runStatus: "completed" as const,
          ...(backendSessionId ? { backendSessionId } : {}),
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_kimi_resume_retry",
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "resume kimi"));

    expect(runInputs).toHaveLength(2);
    expect(runInputs.map((input) => input.messageRunId)).toEqual([
      "mr_kimi_resume_retry",
      "mr_kimi_resume_retry",
    ]);
    expect(runInputs[0]!.session.backendSessionId).toBe(staleId);
    expect(runInputs[1]!.session.backendSessionId).toBeNull();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // The user sees the recovery notice, and the fresh session id is persisted.
    expect(seenTexts).toContain("⚠️ kimi 会话已失效（可能因账号切换），正在自动开启新会话重试…");
    expect((await store.findSessionById(sessionId))?.backendSessionId).toBe("fresh-kimi-session");
    expect(store._getMessageRun(asMessageRunId("mr_kimi_resume_retry"))?.status).toBe("completed");
  });

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

  it("rejects blocked slash commands in employee user groups", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const sessionId = asSessionId("sess_employee");
    store.seedSession(makeSession("sess_employee", "idle", { category: "员工" as never }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const route = vi.fn(async (_input: { scope: unknown; msg: InboundMessage }) => ({
      replyText: "should not route",
    }));

    const dispatcher = createDispatcher({
      store,
      lark,
      router: { route },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "/backend codex"));
    await dispatcher.handleInbound(makeMsg(USER_GROUP, "/clone kimi employee-copy"));

    expect(route).not.toHaveBeenCalled();
    expect(lark.sent).toHaveLength(2);
    expect(lark.sent[0].text).toContain("员工群不支持 /backend");
    expect(lark.sent[1].text).toContain("员工群不支持 /clone");
    expect(replier.consumed).toHaveLength(0);
  });

  it("allows ordinary prompts in employee user groups", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const sessionId = asSessionId("sess_employee_prompt");
    store.seedSession(makeSession("sess_employee_prompt", "idle", { category: "员工" as never }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const events: AgentEvent[] = [
      { kind: "started", backendSessionId: "back_employee" },
      { kind: "completed", finalMessage: "done" },
    ];
    const backend = makeFakeBackendRegistry(events);

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

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "帮我记录今天的 todo"));

    expect(replier.consumed).toHaveLength(1);
    expect(replier.consumed[0].sessionId).toBe(sessionId);
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

  it("routes normal prompts through the active branch and writes back only that branch", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_branch");
    const session = makeSession("sess_branch", "idle", { backendSessionId: "bks-main" });
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.createSessionBranch({
      sessionId,
      name: "plan-a",
      sourceBranchName: "main",
      sourceBackendSessionId: "bks-main",
      forkPending: true,
      createdAt: asTimestamp(200),
    });
    await store.setActiveBranch(sessionId, "plan-a", asTimestamp(201));

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "bks-plan-a" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "try branch"));

    expect(captured).toHaveLength(1);
    expect(captured[0].session.backendSessionId).toBe("bks-main");
    expect(captured[0].session.updatedAt).toBe(asTimestamp(200));
    expect(captured[0].conversationFork).toEqual({ sourceBackendSessionId: "bks-main" });
    expect(replier.consumed[0]?.branchName).toBe("plan-a");
    expect(store._listMessageRuns()[0]?.branchName).toBe("plan-a");
    expect((await store.getActiveBranch(sessionId)).backendSessionId).toBe("bks-plan-a");
    expect((await store.findSessionById(sessionId))?.backendSessionId).toBe("bks-main");
  });

  it("adds referenced-message metadata before a non-slash backend prompt", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_ref_prompt");
    store.seedSession(makeSession("sess_ref_prompt", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_ref" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "这条是什么意思？", {
      referencedMessage: {
        messageId: "om_ref",
        text: "quoted answer",
        senderId: "ou_alice",
        senderName: "Alice",
        timestampMs: 1_700_000_001_000,
      },
    }));

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toContain("[SuperMatrix referenced message context]");
    expect(captured[0].prompt).toContain("This block is framework-provided metadata, not user-provided content.");
    expect(captured[0].prompt).toContain("Referenced message id: om_ref");
    expect(captured[0].prompt).toContain("Sender: Alice (ou_alice)");
    expect(captured[0].prompt).toContain("Timestamp: 2023-11-14T22:13:21.000Z");
    expect(captured[0].prompt).toMatch(/\[Referenced message content\]\nquoted answer[\s\S]*\[Current user message\]\n这条是什么意思？/u);

    const runs = store._listMessageRuns();
    expect(runs[0]?.prompt).toBe("这条是什么意思？");
  });

  it("leaves backend prompt unchanged when there is no referenced message", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_no_ref_prompt");
    store.seedSession(makeSession("sess_no_ref_prompt", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_no_ref" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "plain prompt"));

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("plain prompt");
  });

  it("passes card ask context and system hint for real user-group prompts when the hot gate is enabled", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_card_ask");
    store.seedSession(makeSession("sess_card_ask", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_card_ask" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
      cardAskGate: async ({ session, backend }) => {
        expect(session.name).toBe("test-session");
        expect(backend).toBe("claude");
        return { enabled: true };
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "needs choice", { origin: "lark_user" }));

    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBe(true);
    expect(captured[0].cardAskChatId).toBe(USER_GROUP);
    expect(captured[0].systemHint).toBe(CARD_ASK_SYSTEM_HINT);
  });

  it("passes card ask context and system hint to Kimi for real user-group prompts when the hot gate is enabled", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_kimi_card_ask");
    store.seedSession(makeSession("sess_kimi_card_ask", "idle", { backend: "kimi" }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_kimi_card_ask" },
      { kind: "completed", finalMessage: "done" },
    ], "kimi");
    const gate = vi.fn(async () => ({ enabled: true }));

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
      cardAskGate: gate,
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "needs Kimi choice", { origin: "lark_user" }));

    expect(gate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ backend: "kimi" }),
      backend: "kimi",
    }));
    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBe(true);
    expect(captured[0].cardAskChatId).toBe(USER_GROUP);
    expect(captured[0].systemHint).toBe(CARD_ASK_SYSTEM_HINT);
  });

  it("marks the run card-routed for the replier when kimi card-ask survives the broker health filter", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_kimi_card_routed");
    store.seedSession(makeSession("sess_kimi_card_routed", "idle", { backend: "kimi" }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_kimi_card_routed" },
      { kind: "completed", finalMessage: "done" },
    ], "kimi");

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
      cardAskGate: async () => ({ enabled: true }),
      cardAskHealthFilter: async (input) => input, // broker healthy
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "needs Kimi choice", { origin: "lark_user" }));

    expect(replier.consumed).toHaveLength(1);
    expect(replier.consumed[0].askUserQuestionCardRouted).toBe(true);
  });

  it("drops card-ask and keeps the text fallback when the broker health filter strips it", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_kimi_broker_down");
    store.seedSession(makeSession("sess_kimi_broker_down", "idle", { backend: "kimi" }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_kimi_broker_down" },
      { kind: "completed", finalMessage: "done" },
    ], "kimi");

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
      cardAskGate: async () => ({ enabled: true }),
      // Broker unhealthy: mirror disableCardAskWhenBrokerUnhealthy's strip.
      cardAskHealthFilter: async (input) => ({
        ...input,
        cardAskEnabled: undefined,
        cardAskChatId: undefined,
      }),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "needs Kimi choice", { origin: "lark_user" }));

    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(replier.consumed).toHaveLength(1);
    expect(replier.consumed[0].askUserQuestionCardRouted).toBeUndefined();
  });

  it("does not mark claude runs card-routed even with gate on and healthy broker", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_claude_card_ask");
    store.seedSession(makeSession("sess_claude_card_ask", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_claude_card_ask" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
      cardAskGate: async () => ({ enabled: true }),
      cardAskHealthFilter: async (input) => input,
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "needs choice", { origin: "lark_user" }));

    // claude/codex built-ins have no card route — the legacy text mirror is
    // their only user-facing channel and must stay on.
    expect(replier.consumed).toHaveLength(1);
    expect(replier.consumed[0].askUserQuestionCardRouted).toBeUndefined();
  });

  it("does not pass card ask context when the hot gate is disabled", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_no_card_ask");
    store.seedSession(makeSession("sess_no_card_ask", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_no_card_ask" },
      { kind: "completed", finalMessage: "done" },
    ]);

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
      cardAskGate: async () => ({ enabled: false }),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "plain prompt", { origin: "lark_user" }));

    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].cardAskChatId).toBeUndefined();
    expect(captured[0].systemHint).toBeUndefined();
  });

  it("keeps external non-owner runs out of the card ask gate", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_external");
    store.seedSession(makeSession("sess_external", "idle", { category: "外部" }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_external" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const gate = vi.fn(async () => ({ enabled: true }));

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
      ownerUserId: "owner_user",
      clock: makeClock(),
      idFactory: makeIdFactory(),
      cardAskGate: gate,
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "external prompt", {
      origin: "lark_user",
      userId: "not_owner",
      mentionedBot: true,
    }));

    expect(gate).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].answerOnly).toBe(true);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].systemHint).toBeUndefined();
  });

  it("keeps framework synthetic runs out of the card ask gate", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_synthetic");
    store.seedSession(makeSession("sess_synthetic", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_synthetic" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const gate = vi.fn(async () => ({ enabled: true }));

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
      cardAskGate: gate,
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "synthetic prompt", {
      origin: "framework_synthetic",
    }));

    expect(gate).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].systemHint).toBeUndefined();
  });

  it("does not prepend referenced-message metadata to slash command handlers", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "command ok" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(ROOT_GROUP, "/help", {
      referencedMessage: {
        messageId: "om_ref",
        text: "quoted",
      },
    }));

    expect(routedTexts).toEqual(["/help"]);
    expect(replier.consumed).toHaveLength(0);
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

  it("applies a queued runtime config before draining /next into the next run", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const sessionId = asSessionId("sess_pending_before_next");
    store.seedSession(makeSession("sess_pending_before_next", "idle", {
      backend: "codex",
      model: "gpt-5.5",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const captured: RunInput[] = [];
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const backend: AgentBackend = {
      kind: "codex",
      run(input) {
        captured.push(input);
        return (async function* () {
          yield { kind: "started" as const, backendSessionId: "back_pending" };
          if (input.prompt === "initial prompt") {
            started();
            await releasePromise;
          }
          yield { kind: "completed" as const, finalMessage: input.prompt };
        })();
      },
      async cancel() {},
    };
    const pendingQueue = [{ text: "next prompt", groupId: USER_GROUP, userId: "user1" }];
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "unused" }; } },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      pendingNext: {
        has: () => pendingQueue.length > 0,
        shift: () => pendingQueue.shift(),
        restoreFront: (_sessionId, entry) => pendingQueue.unshift(entry),
      },
    });

    const running = dispatcher.handleInbound(makeMsg(USER_GROUP, "initial prompt"));
    await startedPromise;
    const queueModel = createSetModelHandler({ store });
    await queueModel({
      scope: "root",
      args: { name: "test-session", model: "gpt-5.6-sol" },
      msg: makeMsg(ROOT_GROUP, "/model test-session gpt-5.6-sol"),
    });
    release();
    await running;

    expect(captured.map((input) => ({ prompt: input.prompt, model: input.session.model }))).toEqual([
      { prompt: "initial prompt", model: "gpt-5.5" },
      { prompt: "next prompt", model: "gpt-5.6-sol" },
    ]);
    expect(store._getPendingSessionRuntimeConfig(sessionId)).toBeNull();
  });

  it.each(["failed", "throws"] as const)("applies queued config after dispatcher %s cleanup", async (outcome) => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const sessionId = asSessionId(`sess_pending_${outcome}`);
    store.seedSession(makeSession(`sess_pending_${outcome}`, "idle", {
      backend: "codex",
      model: "gpt-5.5",
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const backend: AgentBackend = {
      kind: "codex",
      run() {
        return (async function* () {
          yield { kind: "started" as const, backendSessionId: "back_pending_terminal" };
          started();
          await releasePromise;
          if (outcome === "throws") throw new Error("replier stream threw");
          yield { kind: "completed" as const, finalMessage: "failed result" };
        })();
      },
      async cancel() {},
    };
    const replier: DispatcherDeps["replier"] = {
      async consume(input) {
        for await (const _event of input.stream) {
          // Drain the backend stream; the terminal outcome below is deliberate.
        }
        return {
          finalMessage: "failed result",
          cardId: asCardId("pending-terminal-card"),
          error: "terminal response failure",
          runStatus: "failed",
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "unused" }; } },
      backend: { get: () => backend, cancel: async () => {} },
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const running = dispatcher.handleInbound(makeMsg(USER_GROUP, "initial prompt"));
    await startedPromise;
    await createSetModelHandler({ store })({
      scope: "root",
      args: { name: "test-session", model: "gpt-5.6-sol" },
      msg: makeMsg(ROOT_GROUP, "/model test-session gpt-5.6-sol"),
    });
    release();
    await running;

    expect(await store.findSessionById(sessionId)).toMatchObject({
      status: "idle",
      model: "gpt-5.6-sol",
    });
    expect(store._getPendingSessionRuntimeConfig(sessionId)).toBeNull();
  });

  it("treats drained pending text that starts with /next as a backend prompt", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_next_literal");
    store.seedSession(makeSession("sess_next_literal", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_next_literal" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const pendingQueue = [
      { text: "/next literal prompt", groupId: USER_GROUP, userId: "user1" },
    ];
    const routedTexts: string[] = [];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
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
      "/next literal prompt",
    ]);
    expect(routedTexts).toEqual([]);
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

  it("freezes and propagates one Codex execution config to the backend and replier", async () => {
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.6-sol", effort: "ultra" });
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const sessionId = asSessionId("sess_execution_config");
    store.seedSession({ ...makeSession("sess_execution_config", "idle"), backend: "codex" });
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "completed", finalMessage: "done" },
    ]);
    let replierExecution: unknown;
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        replierExecution = (input as typeof input & { execution?: unknown }).execution;
        for await (const _ of input.stream) {
          // drain stream
        }
        return {
          finalMessage: "done",
          cardId: asCardId("card_execution_config"),
          runStatus: "completed" as const,
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "should not be called" }; } },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "run"));

    expect(captured[0]?.execution).toEqual({
      backend: "codex",
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(replierExecution).toEqual(captured[0]?.execution);
  });

  it("preserves a Codex resume id after generic Bad Request from the resumed thread", async () => {
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
    expect(updated?.backendSessionId).toBe("bad-thread");
    expect(lark.sent.some((message) => message.text.includes("/reset"))).toBe(true);
  });

  it("backs up before clearing both main Codex resume pointers after repeated ArrayParam failures", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const sessionId = asSessionId("sess_codex_array_poison");
    const poisonedId = "019fefd1-c28c-78b2-b88d-37603b50f40c";
    const error = "400 [ArrayParam] [input[115].content] [array_above_max_length]";
    const session = {
      ...makeSession("sess_codex_array_poison", "idle"),
      backend: "codex" as const,
      model: "gpt-5.5",
      backendSessionId: poisonedId,
    };
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.startMessageRun({
      id: asMessageRunId("mr_ff3bbdc8"),
      sessionId,
      groupId: USER_GROUP,
      prompt: "first short prompt",
      startedAt: asTimestamp(900),
      branchName: "main",
    });
    await store.finishMessageRun(asMessageRunId("mr_ff3bbdc8"), "failed", undefined, error);

    const backup = vi.fn(async () => ({
      snapshotPath: "/tmp/codex-resume-recovery/snapshot.sqlite",
      receiptPath: "/tmp/codex-resume-recovery/receipt.json",
    }));
    const clear = vi.spyOn(store, "clearSessionBranchBackendSessionId");
    const backend = makeFakeBackendRegistry([]);
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _ of input.stream) { /* drain */ }
        return {
          finalMessage: `❌ ${error}`,
          cardId: asCardId("card_codex_array_poison"),
          error,
          runStatus: "failed" as const,
          backendSessionId: poisonedId,
          streamLog: [],
        };
      },
    };
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "unused" }; } },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: () => "mr_c9403f76",
      codexRuntimeRecovery: {
        availability: { async probe() { return { kind: "unavailable", checkedAt: 1000, reason: "test" }; } },
        isModelUnavailable: () => false,
        backupBeforeResumeClear: backup,
      },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "short prompt"));

    expect(backup).toHaveBeenCalledTimes(1);
    expect(backup.mock.invocationCallOrder[0]).toBeLessThan(clear.mock.invocationCallOrder[0]!);
    expect(backup).toHaveBeenCalledWith({
      sessionId,
      branchName: "main",
      failedRunId: "mr_c9403f76",
      errorClass: "array_above_max_length",
    });
    expect((await store.findSessionById(sessionId))?.backendSessionId).toBeNull();
    expect((await store.findSessionBranch(sessionId, "main"))?.backendSessionId).toBeNull();
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

  it("clears a Claude resume id after a thinking-block 400 from the resumed session", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();

    const sessionId = asSessionId("sess_claude_thinking_poison");
    const session = {
      ...makeSession("sess_claude_thinking_poison", "idle"),
      backend: "claude" as const,
      backendSessionId: "bks-poisoned",
    };
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const backend = makeFakeBackendRegistry([
      { kind: "started", backendSessionId: "bks-poisoned" },
    ]);
    const error =
      "API Error: 400 messages.35.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";
    const replier = {
      async consume(input: Parameters<DispatcherDeps["replier"]["consume"]>[0]) {
        for await (const _ of input.stream) {
          // drain stream
        }
        return {
          finalMessage: `❌ ${error}`,
          cardId: asCardId("card_thinking_poison"),
          error,
          runStatus: "failed" as const,
          backendSessionId: "bks-poisoned",
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

  it("silently ignores Feishu rich post message when first text block starts with ~", async () => {
    // Reproduces the exact message from issue f305324c: post JSON with a
    // leading "~" text block followed by an image attachment.
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const sessionId = asSessionId("sess_rich_post_mute");
    const session = makeSession("sess_rich_post_mute", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route(_input: unknown) { return { replyText: "should not be called" }; } },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    // Exact Feishu post JSON from the incident report (om_REDACTEDMESSAGEID)
    const postJson = JSON.stringify({
      title: "",
      content: [
        [{ tag: "text", text: "~   ", style: [] }],
        [{ tag: "img", image_key: "img_v3_0212f_b6ed1bb8-0455-47bd-a43a-bb467d71050g" }],
      ],
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, postJson, { attachments: [] }));

    expect(lark.sent).toHaveLength(0);
    expect(replier.consumed).toHaveLength(0);
    const runs = store._listMessageRuns();
    expect(runs).toHaveLength(0);
  });

  it("silently ignores Feishu rich post when first text block starts with full-width ～", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();

    const sessionId = asSessionId("sess_rich_post_fullwidth");
    const session = makeSession("sess_rich_post_fullwidth", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route(_input: unknown) { return { replyText: "should not be called" }; } },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const postJson = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "～ 全角波浪线备注" }]],
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, postJson));

    expect(lark.sent).toHaveLength(0);
    expect(replier.consumed).toHaveLength(0);
    const runs = store._listMessageRuns();
    expect(runs).toHaveLength(0);
  });

  it("does NOT mute Feishu rich post when first text block does not start with ~", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_rich_post_normal");
    const session = makeSession("sess_rich_post_normal", "idle");
    store.seedSession(session);
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_rich_post" },
      { kind: "completed", finalMessage: "done" },
    ]);

    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route(_input: unknown) { return { replyText: "should not be called" }; } },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const postJson = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "请帮我分析一下" }]],
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, postJson));

    expect(captured).toHaveLength(1);
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

  it("ignores stale AskUserQuestion choice CARD_ACTION payloads", async () => {
    const store = createFakeBindingStore();
    const targetSessionId = asSessionId("sess_ask_user_target");
    store.seedSession({ ...makeSession("sess_ask_user_target"), id: targetSessionId, name: "amzdata" });
    store.seedBinding({ groupId: USER_GROUP, sessionId: targetSessionId, createdAt: asTimestamp(100) });
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "completed", finalMessage: "choice handled" },
    ]);
    const spawnChild = vi.fn(async (_input: SpawnChildInput) => ({
      session: { ...makeSession("sess_should_not_spawn"), scope: "child" as const },
      finalMessage: "should not spawn",
      backendSessionId: null,
      messageRunId: asMessageRunId("mr_should_not_spawn"),
      spawnCommId: "comm_should_not_spawn",
    }));
    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(_input: unknown) {
          return { replyText: "should not route" };
        },
      },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      childSession: { spawnChild },
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "CARD_ACTION:" + JSON.stringify({
      action: "ask_user_answer",
      target_session: "amzdata",
      origin_run_id: "mr_6fef35af",
      question_id: "plan_choice",
      header: "选择方案",
      question: "这次 mr_6fef35af 要按哪个方案继续？",
      selected_label: "方案 B",
      selected_value: "方案 B",
    }), {
      messageId: "card_action_msg_1",
      userId: "ou_picker",
    }));

    expect(spawnChild).not.toHaveBeenCalled();
    expect(captured).toHaveLength(0);
    const runs = store._listMessageRuns();
    expect(runs).toHaveLength(0);
  });

  describe("外部 session trust boundary", () => {
    const OWNER_ID = "ou_REDACTEDOPENID";
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

    it("routes unmentioned slash command from owner in 外部 session", async () => {
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
          async route(input: { scope: unknown; msg: InboundMessage }) {
            routerCalled = true;
            expect(input.msg.text).toBe("/status");
            return { replyText: "✅ owner command ok" };
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

      expect(routerCalled).toBe(true);
      expect(lark.sent).toHaveLength(1);
      expect(lark.sent[0].text).toBe("✅ owner command ok");
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

    it("rejects non-owner prompt when 外部 session drifted onto kimi backend", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext_kimi");
      store.seedSession({ ...makeExternalSession("sess_ext_kimi"), backend: "kimi" });
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const { registry, captured } = makeCapturingBackendRegistry([
        { kind: "started", backendSessionId: "back_ext_kimi" },
        { kind: "completed", finalMessage: "answer" },
      ]);
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
        messageId: "msg_ext_kimi_non_owner",
        userId: NON_OWNER_ID,
        text: "what is the weather?",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
      });

      expect(captured).toHaveLength(0);
      expect(lark.sent).toHaveLength(1);
      expect(lark.sent[0].text).toContain("外部 session 不支持 kimi backend");
    });

    it("keeps referenced-message metadata inside the 外部 session trust wrapper", async () => {
      const store = createFakeBindingStore();
      const lark = createFakeLarkGateway();

      const sessionId = asSessionId("sess_ext_ref");
      store.seedSession(makeExternalSession("sess_ext_ref"));
      store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

      const { registry, captured } = makeCapturingBackendRegistry([
        { kind: "started", backendSessionId: "back_ext_ref" },
        { kind: "completed", finalMessage: "answer" },
      ]);
      const replier = createFakeReplier();

      const dispatcher = createDispatcher({
        store,
        lark,
        router: { async route(_: unknown) { return { replyText: "" }; } },
        backend: registry,
        replier,
        rootGroupId: ROOT_GROUP,
        ownerUserId: OWNER_ID,
        clock: makeClock(),
        idFactory: makeIdFactory(),
      });

      await dispatcher.handleInbound({
        groupId: USER_GROUP,
        messageId: "msg_ext_ref",
        userId: NON_OWNER_ID,
        text: "answer this",
        mentionedBot: true,
        attachments: [],
        receivedAtMs: 1000,
        referencedMessage: {
          messageId: "om_ext_ref",
          text: "external quoted body",
          fetchError: "permission denied",
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].answerOnly).toBe(true);
      const prompt = captured[0].prompt;
      expect(prompt).toContain("[SuperMatrix external session trusted identity context]");
      expect(prompt).toContain("Sender role: external_non_owner");
      expect(prompt.indexOf("[SuperMatrix external session trusted identity context]"))
        .toBeLessThan(prompt.indexOf("[SuperMatrix referenced message context]"));
      expect(prompt.indexOf("[SuperMatrix referenced message context]"))
        .toBeLessThan(prompt.indexOf("[User message]\nanswer this"));
      expect(prompt).toContain("Referenced message id: om_ext_ref");
      expect(prompt).toContain("Fetch failure: permission denied");
      expect(prompt).toContain("[Referenced message content]\nexternal quoted body");
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

  it("routes /next on a non-first line of a multiline message as a command, not the busy guard", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const sessionId = asSessionId("sess_embedded_next");
    store.seedSession(makeSession("sess_embedded_next", "busy"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const router = {
      async route(input: { scope: unknown; msg: InboundMessage }) {
        routedTexts.push(input.msg.text);
        return { replyText: "✓ 已排队，将在当前任务完成后执行" };
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

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "说明文字\n\n/next do the thing"));

    expect(routedTexts).toEqual(["/next do the thing"]);
    const replies = lark.sent.map((m) => m.text);
    expect(replies).not.toContain("⏳ 当前 session 正忙，请等待上一条消息完成");
    expect(replies).toContain("✓ 已排队，将在当前任务完成后执行");
  });

  it("routes quoted /next from the first Feishu post text block as a command before the busy guard", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const sessionId = asSessionId("sess_rich_post_next_quote");
    store.seedSession(makeSession("sess_rich_post_next_quote", "busy"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "✓ queued" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const postJson = makePostJson([
      ["“/next 生成内容回复步骤要改一下，"],
      ["1. 先判断用户意图、情绪，回填飞书表格"],
    ]);

    await dispatcher.handleInbound(makeMsg(USER_GROUP, postJson));

    expect(routedTexts).toEqual([
      "/next 生成内容回复步骤要改一下，\n1. 先判断用户意图、情绪，回填飞书表格",
    ]);
    expect(lark.sent.map((m) => m.text)).not.toContain("⏳ 当前 session 正忙，请等待上一条消息完成");
  });

  it("routes /next from a later Feishu post paragraph and preserves following visible paragraphs", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const sessionId = asSessionId("sess_rich_post_embedded_next");
    store.seedSession(makeSession("sess_rich_post_embedded_next", "busy"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "✓ queued" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const postJson = makePostJson([
      ["背景说明"],
      ["/next task line one"],
      ["task line two"],
    ]);

    await dispatcher.handleInbound(makeMsg(USER_GROUP, postJson));

    expect(routedTexts).toEqual(["/next task line one\ntask line two"]);
  });

  it("does not route ordinary Feishu post prose that merely contains /next", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const sessionId = asSessionId("sess_rich_post_prose_next");
    store.seedSession(makeSession("sess_rich_post_prose_next", "busy"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "should not route" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(
      makeMsg(USER_GROUP, makePostJson([["这只是普通说明，里面提到 /next 但不是命令起点"]])),
    );

    expect(routedTexts).toEqual([]);
    expect(lark.sent.map((m) => m.text)).toContain("⏳ 当前 session 正忙，请等待上一条消息完成");
  });

  it("does not apply Feishu post /next command extraction to framework_synthetic messages", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_rich_post_synthetic_next");
    store.seedSession(makeSession("sess_rich_post_synthetic_next", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_rich_syn_next" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const routedTexts: string[] = [];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "should not be sent" };
        },
      },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    const postJson = makePostJson([
      ["背景说明"],
      ["/next embedded content"],
    ]);
    await dispatcher.handleInbound(
      makeMsg(USER_GROUP, postJson, { origin: "framework_synthetic" }),
    );

    expect(routedTexts).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe(postJson);
  });

  it("includes lines after /next as the command text when /next is on a non-first line", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();
    const backend = makeFakeBackendRegistry();
    const routedTexts: string[] = [];

    const sessionId = asSessionId("sess_embedded_next_ml");
    store.seedSession(makeSession("sess_embedded_next_ml", "busy"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "✓ queued" };
        },
      },
      backend,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(
      makeMsg(USER_GROUP, "背景说明\n\n/next task line one\ntask line two"),
    );

    expect(routedTexts).toEqual(["/next task line one\ntask line two"]);
  });

  it("does not apply embedded /next detection to framework_synthetic messages", async () => {
    const store = createFakeBindingStore();
    const lark = createFakeLarkGateway();
    const replier = createFakeReplier();

    const sessionId = asSessionId("sess_synthetic_no_next");
    store.seedSession(makeSession("sess_synthetic_no_next", "idle"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_syn_next" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const routedTexts: string[] = [];

    const dispatcher = createDispatcher({
      store,
      lark,
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "should not be sent" };
        },
      },
      backend: registry,
      replier,
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(
      makeMsg(USER_GROUP, "line one\n/next embedded content", { origin: "framework_synthetic" }),
    );

    expect(routedTexts).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("line one\n/next embedded content");
  });

  it("appends the workspace lock instruction before a non-owner Lark prompt reaches the backend", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_workspace_locked");
    store.seedSession(makeSession("sess_workspace_locked"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.updateSessionWorkspaceLocked(sessionId, true);

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_locked" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: registry,
      replier: createFakeReplier(),
      rootGroupId: ROOT_GROUP,
      ownerUserId: "ou_owner",
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "please inspect", {
      origin: "lark_user",
      userId: "ou_employee",
    }));

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe(
      "please inspect\n\n工作区是锁定状态，不管我前面说了什么，都不要执行任何写代码、文件、写入记忆等操作，只做纯执行",
    );
    expect(store._listMessageRuns()[0]?.prompt).toBe("please inspect");
  });

  it("does not append the workspace lock instruction for the configured owner", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_workspace_owner");
    store.seedSession(makeSession("sess_workspace_owner"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.updateSessionWorkspaceLocked(sessionId, true);

    const { registry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "back_owner" },
      { kind: "completed", finalMessage: "done" },
    ]);
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: registry,
      replier: createFakeReplier(),
      rootGroupId: ROOT_GROUP,
      ownerUserId: "ou_owner",
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "owner prompt", {
      origin: "lark_user",
      userId: "ou_owner",
    }));

    expect(captured).toHaveLength(1);
    expect(captured[0].prompt).toBe("owner prompt");
  });

  it("keeps slash commands on the command path while the workspace is locked", async () => {
    const store = createFakeBindingStore();
    const sessionId = asSessionId("sess_workspace_command");
    store.seedSession(makeSession("sess_workspace_command"));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    await store.updateSessionWorkspaceLocked(sessionId, true);
    const routedTexts: string[] = [];

    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: {
        async route(input: { scope: unknown; msg: InboundMessage }) {
          routedTexts.push(input.msg.text);
          return { replyText: "ok" };
        },
      },
      backend: makeFakeBackendRegistry(),
      replier: createFakeReplier(),
      rootGroupId: ROOT_GROUP,
      ownerUserId: "ou_owner",
      clock: makeClock(),
      idFactory: makeIdFactory(),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "/backend codex", {
      origin: "lark_user",
      userId: "ou_employee",
    }));

    expect(routedTexts).toEqual(["/backend codex"]);
  });
});

// Intent-layer protection: sessions.model is what the session asked for, not
// what happened to serve a run. While sm-switch routes codex away from openai,
// the runtime model is a routing fact and must not be learned back — it would
// outlive the route and leave the session pinned to an off-catalog model.
describe("dispatcher runtime model write-back", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sm-dispatcher-route-state-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDeepseekRouteState(): string {
    const path = join(dir, "route-state.json");
    writeFileSync(path, JSON.stringify({
      contractVersion: ROUTE_STATE_CONTRACT_VERSION,
      backend: "codex",
      route: "deepseek",
      defaultModel: "deepseek-v4-flash",
      servedModels: ["deepseek-v4-flash", "deepseek-v4"],
      activatedAt: "2026-08-07T12:00:00+08:00",
      proxy: { host: "127.0.0.1", port: 15722, healthUrl: "http://127.0.0.1:15722/health" },
    }));
    return path;
  }

  function makeRuntimeModelReplier(runtimeModel: string) {
    const fake = createFakeReplier();
    return {
      consumed: fake.consumed,
      async consume(input: Parameters<typeof fake.consume>[0]) {
        return { ...(await fake.consume(input)), runtimeModel };
      },
    };
  }

  async function runOnce(input: {
    sessionId: string;
    backend: Session["backend"];
    runtimeModel: string;
    routeStatePath: string;
  }) {
    const store = createFakeBindingStore();
    const sessionId = asSessionId(input.sessionId);
    store.seedSession(makeSession(input.sessionId, "idle", {
      backend: input.backend,
      model: null,
    }));
    store.seedBinding({ groupId: USER_GROUP, sessionId, createdAt: asTimestamp(100) });
    const dispatcher = createDispatcher({
      store,
      lark: createFakeLarkGateway(),
      router: { async route() { return { replyText: "unused" }; } },
      backend: makeFakeBackendRegistry([
        { kind: "started", backendSessionId: "thread-1" },
        { kind: "completed", finalMessage: "ok" },
      ]),
      replier: makeRuntimeModelReplier(input.runtimeModel),
      rootGroupId: ROOT_GROUP,
      clock: makeClock(),
      idFactory: makeIdFactory(),
      // Wired exactly as bootstrap does — the real contract reader, not a stub,
      // so the test exercises the route-state parsing the runtime uses.
      isCodexRouteOverrideActive: () => isCodexRouteOverrideActive(input.routeStatePath),
    });

    await dispatcher.handleInbound(makeMsg(USER_GROUP, "a prompt"));
    return (await store.findSessionById(sessionId))?.model ?? null;
  }

  it("does not learn the route-served model into a codex session with no model intent", async () => {
    const model = await runOnce({
      sessionId: "sess_route_active",
      backend: "codex",
      runtimeModel: "deepseek-v4-flash",
      routeStatePath: writeDeepseekRouteState(),
    });

    // Intent stays null: every later run re-resolves through the route, and
    // switching back to openai leaves nothing behind.
    expect(model).toBeNull();
  });

  it("learns the runtime model for codex when no route state exists (fail open)", async () => {
    const model = await runOnce({
      sessionId: "sess_route_absent",
      backend: "codex",
      runtimeModel: "gpt-5.6-terra",
      routeStatePath: join(dir, "does-not-exist.json"),
    });

    expect(model).toBe("gpt-5.6-terra");
  });

  it("still learns the runtime model for claude while a codex route is active", async () => {
    const model = await runOnce({
      sessionId: "sess_route_claude",
      backend: "claude",
      runtimeModel: "claude-opus-5",
      routeStatePath: writeDeepseekRouteState(),
    });

    expect(model).toBe("claude-opus-5");
  });
});
