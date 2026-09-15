import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type {
  AgentBackend,
  BackendRegistry,
  RunInput,
} from "../../src/ports/AgentBackend.ts";
import { runOnSession } from "../../src/app/runOnSession.ts";
import { createSetModelHandler } from "../../src/app/commands/setModel.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { isConfirmedCodexModelUnavailable } from "../../src/adapters/backend-codex/modelUnavailable.ts";
import { resetCodexModelCatalogForTests } from "../../src/ports/CodexModelCatalog.ts";
import type { CodexModelAvailability, ModelAvailabilityResult } from "../../src/ports/CodexModelAvailability.ts";
import type { Logger } from "../../src/ports/Logger.ts";

function makeScriptedCodexRegistry(
  ...scripts: AgentEvent[][]
): { backendRegistry: BackendRegistry; captured: RunInput[] } {
  const captured: RunInput[] = [];
  let call = 0;
  const backend: AgentBackend = {
    kind: "codex",
    run(input: RunInput): AsyncIterable<AgentEvent> {
      const script = scripts[call] ?? [];
      call += 1;
      captured.push(input);
      return (async function* () {
        for (const e of script) yield e;
      })();
    },
    async cancel(_sessionId) {},
  };
  return { backendRegistry: { get: () => backend, cancel: async () => {} }, captured };
}

function availabilityFrom(
  map: Record<string, ModelAvailabilityResult["kind"]>,
): CodexModelAvailability {
  return {
    async probe(model: string): Promise<ModelAvailabilityResult> {
      const kind = map[model] ?? "unavailable";
      if (kind === "available") return { kind, checkedAt: 1 };
      return { kind, checkedAt: 1, reason: `probe:${model}` };
    },
  };
}

const ENTITLEMENT = (model: string) =>
  `The model \`${model}\` does not exist or you do not have access to it`;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_run"),
    name: "run-session",
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
    workdir: asAbsolutePath("/tmp/work"),
    backendSessionId: null,
    chatName: null,
    purpose: "testing",
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
    ...overrides,
  };
}

function makeBackendRegistry(events: AgentEvent[]): BackendRegistry {
  const backend: AgentBackend = {
    kind: "claude",
    run(_input: RunInput): AsyncIterable<AgentEvent> {
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    async cancel(_sessionId) {},
  };
  return { get: () => backend, cancel: async () => {} };
}

function makeCapturingBackendRegistry(
  events: AgentEvent[],
): { backendRegistry: BackendRegistry; captured: RunInput[] } {
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
  return { backendRegistry: { get: () => backend, cancel: async () => {} }, captured };
}

function makeThrowingBackendRegistry(error: unknown): BackendRegistry {
  const backend: AgentBackend = {
    kind: "kimi",
    run(_input: RunInput): AsyncIterable<AgentEvent> {
      return (async function* () {
        throw error;
      })();
    },
    async cancel(_sessionId) {},
  };
  return { get: () => backend, cancel: async () => {} };
}

const THINKING_BLOCK_ERROR =
  "API Error: 400 messages.35.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

describe("runOnSession resume poison clearing", () => {
  it("keeps the active run on its starting tuple then applies queued config on success", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backend: "codex", model: "gpt-5.5", effort: "high" });
    store.seedSession(session);
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
          yield { kind: "started" as const, backendSessionId: "run-old-tuple" };
          started();
          await releasePromise;
          yield { kind: "completed" as const, finalMessage: "done" };
        })();
      },
      async cancel() {},
    };

    const running = runOnSession({
      store,
      backendRegistry: { get: () => backend, cancel: async () => {} },
      clock: { now: () => asTimestamp(1000) },
      idFactory: () => "mr_pending_success",
    }, { session, prompt: "keep old tuple", groupId: asLarkGroupId("g1") });
    await startedPromise;
    await createSetModelHandler({ store })({
      scope: "root",
      args: { name: session.name, model: "gpt-5.6-sol" },
      msg: { groupId: asLarkGroupId("root"), messageId: "m", userId: "u", text: "/model", attachments: [], receivedAtMs: 0 },
    });
    release();
    await expect(running).resolves.toMatchObject({ kind: "ok" });

    expect(captured[0]?.session).toMatchObject({ model: "gpt-5.5", effort: "high" });
    expect(await store.findSessionById(session.id)).toMatchObject({
      status: "idle",
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(store._listSessionRuntimeConfigAudit().map((audit) => audit.decision)).toContain("apply");
  });

  it("applies queued config after a terminal failed stream", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backend: "codex", model: "gpt-5.5" });
    store.seedSession(session);
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const backend: AgentBackend = {
      kind: "codex",
      run() {
        return (async function* () {
          yield { kind: "started" as const, backendSessionId: "run-failed" };
          started();
          await releasePromise;
          yield { kind: "error" as const, message: "terminal failure", recoverable: false };
        })();
      },
      async cancel() {},
    };
    const running = runOnSession({
      store,
      backendRegistry: { get: () => backend, cancel: async () => {} },
      clock: { now: () => asTimestamp(1000) },
      idFactory: () => "mr_pending_failed",
    }, { session, prompt: "fail", groupId: asLarkGroupId("g1") });
    await startedPromise;
    await createSetModelHandler({ store })({
      scope: "root", args: { name: session.name, model: "gpt-5.6-sol" },
      msg: { groupId: asLarkGroupId("root"), messageId: "m", userId: "u", text: "/model", attachments: [], receivedAtMs: 0 },
    });
    release();

    await expect(running).resolves.toMatchObject({ kind: "error" });
    expect(await store.findSessionById(session.id)).toMatchObject({ status: "idle", model: "gpt-5.6-sol" });
  });

  it("applies queued config when runOnSession throws", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backend: "codex", model: "gpt-5.5" });
    store.seedSession(session);
    let started!: () => void;
    let release!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const backend: AgentBackend = {
      kind: "codex",
      run() {
        return (async function* () {
          yield { kind: "started" as const, backendSessionId: "run-throws" };
          started();
          await releasePromise;
          throw new Error("backend threw");
        })();
      },
      async cancel() {},
    };
    const running = runOnSession({
      store,
      backendRegistry: { get: () => backend, cancel: async () => {} },
      clock: { now: () => asTimestamp(1000) },
      idFactory: () => "mr_pending_throw",
    }, { session, prompt: "throw", groupId: asLarkGroupId("g1") });
    await startedPromise;
    await createSetModelHandler({ store })({
      scope: "root", args: { name: session.name, model: "gpt-5.6-sol" },
      msg: { groupId: asLarkGroupId("root"), messageId: "m", userId: "u", text: "/model", attachments: [], receivedAtMs: 0 },
    });
    release();

    await expect(running).resolves.toMatchObject({ kind: "error", error: "backend threw" });
    expect(await store.findSessionById(session.id)).toMatchObject({ status: "idle", model: "gpt-5.6-sol" });
  });
  it("retries a before-work Codex unavailable error in the same logical run", async () => {
    resetCodexModelCatalogForTests();
    const store = createFakeBindingStore();
    const session = makeSession({
      backend: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      backendSessionId: "branch-resume",
    });
    store.seedSession(session);
    const { backendRegistry, captured } = makeScriptedCodexRegistry(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [
        { kind: "started", backendSessionId: "new-thread" },
        { kind: "completed", finalMessage: "recovered" },
      ],
    );

    const result = await runOnSession(
      {
        store,
        backendRegistry,
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => "mr_same",
        codexRuntimeRecovery: {
          availability: availabilityFrom({ "gpt-5.6-sol": "available" }),
          isModelUnavailable: isConfirmedCodexModelUnavailable,
        },
      },
      { session, prompt: "same prompt", groupId: asLarkGroupId("g1") },
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected recovered run");
    expect(captured).toHaveLength(2);
    expect(captured.map((run) => run.prompt)).toEqual(["same prompt", "same prompt"]);
    expect(captured.map((run) => run.messageRunId)).toEqual(["mr_same", "mr_same"]);
    expect(captured[1].session.backendSessionId).toBe("branch-resume");
    expect(store._getMessageRun(result.runId)?.id).toBe("mr_same");
  });

  it("repairs only after a post-work Codex failure returns the session to idle", async () => {
    resetCodexModelCatalogForTests();
    const store = createFakeBindingStore();
    const session = makeSession({
      backend: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      backendSessionId: "started-thread",
    });
    store.seedSession(session);
    const statusesAtMutation: string[] = [];
    const apply = store.applySessionRuntimeConfigMutations.bind(store);
    store.applySessionRuntimeConfigMutations = async (mutations) => {
      statusesAtMutation.push((await store.findSessionById(session.id))?.status ?? "missing");
      return await apply(mutations);
    };
    const { backendRegistry, captured } = makeScriptedCodexRegistry([
      { kind: "started", backendSessionId: "started-thread" },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);

    const result = await runOnSession(
      {
        store,
        backendRegistry,
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => "mr_post_work",
        codexRuntimeRecovery: {
          availability: availabilityFrom({ "gpt-5.6-sol": "available" }),
          isModelUnavailable: isConfirmedCodexModelUnavailable,
        },
      },
      { session, prompt: "do work", groupId: asLarkGroupId("g1") },
    );

    expect(result.kind).toBe("error");
    expect(captured).toHaveLength(1);
    expect(statusesAtMutation).toEqual(["idle"]);
    expect((await store.findSessionById(session.id))?.model).toBe("gpt-5.6-sol");
  });

  it("preserves a newer tuple when post-work repair conflicts", async () => {
    resetCodexModelCatalogForTests();
    const store = createFakeBindingStore();
    const session = makeSession({ backend: "codex", model: "gpt-5.5", effort: "xhigh" });
    store.seedSession(session);
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      debug() {}, info() {}, error() {},
      warn(message, fields) { warnings.push({ message, ...(fields ? { fields } : {}) }); },
      child() { return logger; },
    };
    let calls = 0;
    const backend: AgentBackend = {
      kind: "codex",
      run() {
        calls += 1;
        return (async function* () {
          yield { kind: "started", backendSessionId: "started-thread" } as AgentEvent;
          yield { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false } as AgentEvent;
          await store.updateSessionModel(session.id, "gpt-5.6-terra");
          await store.updateSessionEffort(session.id, "max");
        })();
      },
      async cancel() {},
    };

    const result = await runOnSession({
      store,
      backendRegistry: { get: () => backend, cancel: async () => {} },
      clock: { now: () => asTimestamp(1000) },
      idFactory: () => "mr_post_conflict",
      logger,
      codexRuntimeRecovery: {
        availability: availabilityFrom({ "gpt-5.6-sol": "available" }),
        isModelUnavailable: isConfirmedCodexModelUnavailable,
      },
    }, { session, prompt: "do work", groupId: asLarkGroupId("g1") });

    expect(result.kind).toBe("error");
    expect(calls).toBe(1);
    expect(await store.findSessionById(session.id)).toMatchObject({ model: "gpt-5.6-terra", effort: "max" });
    expect(warnings).toContainEqual(expect.objectContaining({
      message: "codex runtime next-run repair conflict; preserving newer tuple",
    }));
  });

  it("clears a poisoned Claude resume id after a thinking-block 400", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-poisoned" });
    store.seedSession(session);

    const backendRegistry = makeBackendRegistry([
      { kind: "started", backendSessionId: "bks-poisoned" },
      { kind: "error", message: THINKING_BLOCK_ERROR, recoverable: false },
    ]);

    let n = 0;
    const result = await runOnSession(
      {
        store,
        backendRegistry,
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => `id_${++n}`,
      },
      {
        session,
        prompt: "resume please",
        groupId: asLarkGroupId("g1"),
      },
    );

    expect(result.kind).toBe("error");
    const updated = await store.findSessionById(session.id);
    expect(updated?.backendSessionId).toBeNull();
  });

  it("persists a fresh backendSessionId on a successful run", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backendSessionId: "bks-old" });
    store.seedSession(session);

    const backendRegistry = makeBackendRegistry([
      { kind: "started", backendSessionId: "bks-new" },
      { kind: "assistant_message", text: "done", final: true },
      { kind: "completed", finalMessage: "done" },
    ]);

    let n = 0;
    const result = await runOnSession(
      {
        store,
        backendRegistry,
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => `id_${++n}`,
      },
      {
        session,
        prompt: "hi",
        groupId: asLarkGroupId("g1"),
      },
    );

    expect(result.kind).toBe("ok");
    const updated = await store.findSessionById(session.id);
    expect(updated?.backendSessionId).toBe("bks-new");
  });

  it("does not enable card ask for api-style runs even when a binding group id is present", async () => {
    const store = createFakeBindingStore();
    const session = makeSession();
    store.seedSession(session);
    const { backendRegistry, captured } = makeCapturingBackendRegistry([
      { kind: "started", backendSessionId: "bks-new" },
      { kind: "completed", finalMessage: "done" },
    ]);

    let n = 0;
    const result = await runOnSession(
      {
        store,
        backendRegistry,
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => `id_${++n}`,
      },
      {
        session,
        prompt: "api run",
        groupId: asLarkGroupId("g1"),
      },
    );

    expect(result.kind).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(captured[0].cardAskEnabled).toBeUndefined();
    expect(captured[0].cardAskChatId).toBeUndefined();
  });

  it("formats structured backend throws instead of storing [object Object]", async () => {
    const store = createFakeBindingStore();
    const session = makeSession({ backend: "kimi" });
    store.seedSession(session);

    const result = await runOnSession(
      {
        store,
        backendRegistry: makeThrowingBackendRegistry({
          error: "ACP prompt failed",
          code: "kimi_acp_error",
        }),
        clock: { now: () => asTimestamp(1000) },
        idFactory: () => "id_structured_error",
      },
      {
        session,
        prompt: "hi",
        groupId: asLarkGroupId("g1"),
      },
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    expect(result.error).toBe("ACP prompt failed");
    expect(store._getMessageRun(result.runId)?.errorMessage).toBe("ACP prompt failed");
  });
});
