import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createCodexRuntimeRecoveryRun,
  recoverCodexRuntimeStream,
  repairCodexRuntimeConfigForNextRun,
  type CodexRuntimeRecoveryDeps,
} from "../../src/app/codexRuntimeRecovery.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { EffortLevel, Session } from "../../src/domain/session.ts";
import type { RunInput } from "../../src/ports/AgentBackend.ts";
import type {
  SessionRuntimeConfigMutation,
  SessionRuntimeConfigSnapshot,
} from "../../src/ports/BindingStore.ts";
import type {
  CodexModelAvailability,
  ModelAvailabilityResult,
} from "../../src/ports/CodexModelAvailability.ts";
import {
  resetCodexModelCatalogForTests,
  SAFE_CODEX_MODEL_FALLBACKS,
} from "../../src/ports/CodexModelCatalog.ts";
import {
  resetConfiguredBackendRuntimeDefaultsForTests,
  setConfiguredBackendRuntimeDefaults,
} from "../../src/ports/BackendRuntimeDefaults.ts";
import { buildCodexArgs } from "../../src/adapters/backend-codex/commandBuilder.ts";
import {
  isCodexModelAtCapacity,
  isConfirmedCodexModelUnavailable,
} from "../../src/adapters/backend-codex/modelUnavailable.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";

const TEST_MESSAGE_RUN_ID = asMessageRunId("mr_test");

const ENTITLEMENT = (model: string) =>
  `The model \`${model}\` does not exist or you do not have access to it`;

const SESSION_ID = asSessionId("sess_codex_recovery");
const RUN_ID = asMessageRunId("mr_recovery_1");
const GROUP = asLarkGroupId("grp_recovery");

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    name: "codex-session",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: "gpt-5.5",
    effort: "xhigh",
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/codex"),
    backendSessionId: "thread-1",
    chatName: null,
    purpose: "test",
    status: "busy",
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
    createdAt: asTimestamp(1000),
    updatedAt: asTimestamp(1000),
    ...overrides,
  };
}

function tupleOf(session: Session): SessionRuntimeConfigSnapshot {
  return {
    backend: session.backend,
    model: session.model,
    effort: session.effort,
    backendSessionId: session.backendSessionId,
  };
}

/** A backend `run` fn that yields a fresh script per invocation and records inputs. */
function scriptedRun(...scripts: AgentEvent[][]) {
  const inputs: RunInput[] = [];
  let call = 0;
  const run = (input: RunInput): AsyncIterable<AgentEvent> => {
    const script = scripts[call] ?? [];
    call += 1;
    inputs.push(input);
    return (async function* () {
      for (const event of script) yield event;
    })();
  };
  return { run, inputs, get calls() { return call; } };
}

/** Every catalog model is unreachable behind the active sm-switch route. */
function routeManagedAvailability(): CodexModelAvailability {
  return {
    probe: vi.fn(async (model: string): Promise<ModelAvailabilityResult> => ({
      kind: "skipped",
      checkedAt: 1,
      reason: `codex route "deepseek" is active and serves deepseek-v4-flash; ${model} is not served on this route, so it was not probed`,
    })),
  };
}

function availabilityFrom(
  map: Record<string, ModelAvailabilityResult["kind"]>,
): CodexModelAvailability {
  return {
    probe: vi.fn(async (model: string): Promise<ModelAvailabilityResult> => {
      const kind = map[model] ?? "unavailable";
      if (kind === "available") return { kind, checkedAt: 1 };
      return { kind, checkedAt: 1, reason: `probe:${model}` };
    }),
  };
}

type Harness = {
  store: ReturnType<typeof createFakeBindingStore>;
  deps: CodexRuntimeRecoveryDeps;
  capturedMutations: SessionRuntimeConfigMutation[];
};

function makeHarness(
  availability: CodexModelAvailability,
  session: Session,
): Harness {
  const store = createFakeBindingStore();
  store.seedSession(session);
  store.seedBinding({ groupId: GROUP, sessionId: session.id, createdAt: asTimestamp(1) });
  if (session.status === "busy") {
    // The active-run guard requires a running message_run for this session.
    void store.startMessageRun({
      id: RUN_ID,
      sessionId: session.id,
      groupId: GROUP,
      prompt: "hi",
      startedAt: asTimestamp(1000),
    });
  }
  const capturedMutations: SessionRuntimeConfigMutation[] = [];
  const realApply = store.applySessionRuntimeConfigMutations.bind(store);
  store.applySessionRuntimeConfigMutations = vi.fn(async (mutations) => {
    for (const m of mutations) capturedMutations.push(m);
    return realApply(mutations);
  });
  let n = 0;
  const deps: CodexRuntimeRecoveryDeps = {
    store,
    availability,
    isModelUnavailable: isConfirmedCodexModelUnavailable,
    now: () => asTimestamp(2000),
    idFactory: () => `aud_${++n}`,
  };
  return { store, deps, capturedMutations };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

beforeEach(() => {
  resetCodexModelCatalogForTests();
  resetConfiguredBackendRuntimeDefaultsForTests();
});

describe("recoverCodexRuntimeStream", () => {
  test("[unavailable error] -> repair -> notice -> second stream -> completed", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [
        { kind: "started", backendSessionId: "thread-1" },
        { kind: "assistant_message", text: "hello", final: true },
        { kind: "completed", finalMessage: "hello" },
      ],
    );
    const { deps, store, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const outcome = { retried: false, postWorkUnavailable: false, failedModel: null as string | null };

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
        outcome,
      }),
    );

    // Original unavailable error suppressed; notice + retry stream surfaced.
    expect(events.some((e) => e.kind === "error")).toBe(false);
    const notice = events.find((e) => e.kind === "assistant_message");
    expect(notice).toMatchObject({ kind: "assistant_message", final: false });
    expect((notice as { text: string }).text).toContain("gpt-5.5");
    expect((notice as { text: string }).text).toContain("gpt-5.6-sol");
    expect(events.at(-1)).toEqual({ kind: "completed", finalMessage: "hello" });

    // Exactly one retry.
    expect(scripted.calls).toBe(2);
    expect(outcome.retried).toBe(true);

    // Persisted the fallback tuple with the active-run guard.
    expect(capturedMutations).toHaveLength(1);
    expect(capturedMutations[0]!.guard).toEqual({ kind: "active-run", messageRunId: RUN_ID });
    expect(Object.keys(capturedMutations[0]!.audit).sort()).toEqual([
      "catalogFingerprint",
      "catalogSource",
      "createdAt",
      "decision",
      "id",
      "reason",
      "requested",
      "trigger",
    ]);
    expect(capturedMutations[0]!.audit.requested).toEqual({ model: "gpt-5.6-sol" });
    expect(JSON.stringify(capturedMutations[0]!.audit)).not.toContain("hi");
    expect(JSON.stringify(capturedMutations[0]!.audit)).not.toContain(ENTITLEMENT("gpt-5.5"));
    const updated = await store.findSessionById(session.id);
    expect(updated?.model).toBe("gpt-5.6-sol");
    expect(updated?.backendSessionId).toBe("thread-1");

    // Retry ran on the repaired session (re-read committed tuple), same resume id.
    expect(scripted.inputs[1]!.session.model).toBe("gpt-5.6-sol");
    expect(scripted.inputs[1]!.session.backendSessionId).toBe("thread-1");
  });

  test("retry rebuilds its frozen command config from the repaired tuple, not later defaults", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [{ kind: "completed", finalMessage: "hello" }],
    );
    const { deps } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const runInput: RunInput = {
      messageRunId: TEST_MESSAGE_RUN_ID,
      session,
      prompt: "hi",
      execution: { backend: "codex", model: "gpt-5.5", effort: "xhigh" },
    };
    // This simulates a mutable /model and /effort default changing while the
    // first attempt is in flight. The retry must use the committed repair.
    setConfiguredBackendRuntimeDefaults("codex", { model: "gpt-5.4", effort: "high" });

    await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput,
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    const retryArgs = buildCodexArgs(scripted.inputs[1]!);
    expect(retryArgs[retryArgs.indexOf("--model") + 1]).toBe("gpt-5.6-sol");
    expect(retryArgs).toContain("model_reasoning_effort=xhigh");
  });

  test("clamps effort downward when the fallback model supports less", async () => {
    const session = makeSession({ model: "gpt-5.6-sol", effort: "ultra" as EffortLevel });
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.6-sol"), recoverable: false }],
      [{ kind: "completed", finalMessage: "ok" }],
    );
    const { deps, store } = makeHarness(
      availabilityFrom({
        "gpt-5.6-terra": "unavailable",
        "gpt-5.6-luna": "unavailable",
        "gpt-5.5": "available",
      }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    const updated = await store.findSessionById(session.id);
    expect(updated?.model).toBe("gpt-5.5");
    expect(updated?.effort).toBe("xhigh"); // ultra clamped down for legacy model
    const notice = events.find((e) => e.kind === "assistant_message") as { text: string };
    expect(notice.text).toContain("ultra");
    expect(notice.text).toContain("xhigh");
  });

  test("[started, unavailable error] -> no retry (thread created blocks replay)", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const outcome = { retried: false, postWorkUnavailable: false, failedModel: null as string | null };

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
        outcome,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    // Flag it so the outer lifecycle can attempt an idle repair for the NEXT run.
    expect(outcome.postWorkUnavailable).toBe(true);
    expect(outcome.failedModel).toBe("gpt-5.5");
    expect(outcome.retried).toBe(false);
  });

  test("[assistant_message, unavailable error] -> no retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "assistant_message", text: "partial", final: false },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  test("[tool_call, unavailable error] -> no retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "tool_call", name: "bash", args: {} },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  test.each<[AgentEvent, string]>([
    [{ kind: "thinking", text: "reasoning" } satisfies AgentEvent, "thinking is emitted work"],
    [{
      kind: "usage",
      model: "gpt-5.5",
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      rawUsage: {},
    } satisfies AgentEvent, "usage is observable backend work/accounting"],
  ])("%s blocks replay because %s", async (workSignal, _reason) => {
    const session = makeSession();
    const scripted = scriptedRun([
      workSignal,
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(events).toEqual([
      workSignal,
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
  });

  test("[429 error] -> no mutation and no retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: "429 Too Many Requests: rate limited", recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events).toEqual([
      { kind: "error", message: "429 Too Many Requests: rate limited", recoverable: false },
    ]);
  });

  test.each([
    "400 Bad Request",
    "401 Unauthorized: login required",
    "authentication token expired",
  ])("non-entitlement error passes through unchanged: %s", async (message) => {
    const session = makeSession();
    const scripted = scriptedRun([{ kind: "error", message, recoverable: false }]);
    const availability = availabilityFrom({ "gpt-5.6-sol": "available" });
    const { deps, capturedMutations } = makeHarness(availability, session);

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "secret prompt" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(events).toEqual([{ kind: "error", message, recoverable: false }]);
    expect(scripted.calls).toBe(1);
    expect(availability.probe).not.toHaveBeenCalled();
    expect(capturedMutations).toHaveLength(0);
  });

  test("[timeout error] -> no mutation and no retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: "[TIMEOUT] codex inactivity after 900s", recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
  });

  test("[model/resume incompatible error] -> preserve resume, no mutation, no retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: '{"detail":"Bad Request"}', recoverable: false },
    ]);
    const { deps, store, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    const updated = await store.findSessionById(session.id);
    expect(updated?.backendSessionId).toBe("thread-1"); // resume preserved
    expect(updated?.model).toBe("gpt-5.5"); // config untouched
  });

  test("[unavailable error, fallback unavailable] -> no loop", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    // Every candidate probes unavailable -> no confirmed-available fallback.
    const availability = availabilityFrom({});
    const { deps, capturedMutations } = makeHarness(availability, session);

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
    // Bounded search: every fallback candidate in the reset catalog is probed
    // exactly once, minus the model that just failed. Derived from the
    // catalog constant so deprecating a fallback (2948b4c removed the 5.4
    // selectors) does not strand a stale hardcoded count here.
    expect(availability.probe).toHaveBeenCalledTimes(
      SAFE_CODEX_MODEL_FALLBACKS.filter((model) => model !== "gpt-5.5").length,
    );
    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
  });

  test("[unavailable error, completed] abort exposes only the error and terminates the attempt", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
      { kind: "completed", finalMessage: "must stay hidden" },
    ]);
    const { deps } = makeHarness(availabilityFrom({}), session);

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
  });

  test("effective catalog default is tried first, then deduplicated catalog order", async () => {
    const session = makeSession({ model: "failed" });
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("failed"), recoverable: false }],
      [{ kind: "completed", finalMessage: "ok" }],
    );
    const availability = availabilityFrom({ preferred: "unavailable", first: "available" });
    const { deps } = makeHarness(availability, session);
    deps.getCatalogSnapshot = () => ({
      defaultModel: "preferred",
      models: [
        { slug: "first", supportedEfforts: ["xhigh"] },
        { slug: "preferred", supportedEfforts: ["xhigh"] },
        { slug: "first", supportedEfforts: ["xhigh"] },
        { slug: "failed", supportedEfforts: ["xhigh"] },
      ],
    });

    await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(availability.probe).toHaveBeenCalledTimes(2);
    expect(availability.probe).toHaveBeenNthCalledWith(1, "preferred");
    expect(availability.probe).toHaveBeenNthCalledWith(2, "first");
  });

  test.each(["catalog", "probe", "policy", "mutation", "committed-read"] as const)(
    "%s infrastructure failure preserves the original unavailable error and never retries",
    async (stage) => {
      const session = makeSession();
      const scripted = scriptedRun(
        [
          { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
          { kind: "completed", finalMessage: "must stay hidden" },
        ],
        [{ kind: "completed", finalMessage: "must not retry" }],
      );
      const { deps } = makeHarness(
        availabilityFrom({ "gpt-5.6-sol": "available" }),
        session,
      );
      const warn = vi.fn();
      deps.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as never;
      if (stage === "catalog") deps.getCatalogSnapshot = () => { throw new Error("catalog secret"); };
      if (stage === "probe") deps.availability.probe = vi.fn(async () => { throw new Error("probe secret"); });
      if (stage === "policy") {
        const entry = {
          slug: "gpt-5.6-sol",
          get supportedEfforts(): string[] { throw new Error("policy secret"); },
        };
        deps.getCatalogSnapshot = () => ({
          defaultModel: "gpt-5.6-sol",
          models: [entry],
        });
      }
      if (stage === "mutation") {
        deps.store.applySessionRuntimeConfigMutations = vi.fn(async () => { throw new Error("mutation secret"); });
      }
      if (stage === "committed-read") {
        deps.store.findSessionById = vi.fn(async () => { throw new Error("read secret"); });
      }

      const events = await drain(recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "backend payload secret" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }));

      expect(events).toEqual([
        { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
      ]);
      expect(scripted.calls).toBe(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|entitlement|backend payload/i);
    },
  );

  test("retry that fails unavailable again passes the error through with no second retry", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [{ kind: "error", message: ENTITLEMENT("gpt-5.6-sol"), recoverable: false }],
    );
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const outcome = { retried: false, postWorkUnavailable: false, failedModel: null as string | null };

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
        outcome,
      }),
    );

    expect(scripted.calls).toBe(2); // exactly one retry
    expect(capturedMutations).toHaveLength(1); // exactly one config mutation
    // The second unavailable error passes through unsuppressed.
    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(outcome.retried).toBe(true);
    expect(outcome.postWorkUnavailable).toBe(false);
  });

  test("a transient fallback probe stops the bounded search", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const availability = availabilityFrom({
      "gpt-5.6-sol": "transient_failure",
      "gpt-5.6-terra": "available",
    });
    const { deps, capturedMutations } = makeHarness(availability, session);

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(availability.probe).toHaveBeenCalledTimes(1);
    expect(capturedMutations).toHaveLength(0);
    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
  });

  test("a route-managed (skipped) probe stops the search and surfaces the original error", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
    );
    // While an sm-switch route serves the runs, no catalog model is probeable,
    // so there is no measured candidate to swap onto.
    const availability = routeManagedAvailability();
    const { deps, capturedMutations } = makeHarness(availability, session);
    const warn = vi.fn();
    deps.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as never;

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(availability.probe).toHaveBeenCalledTimes(1);
    expect(capturedMutations).toHaveLength(0);
    expect(scripted.calls).toBe(1); // no replay
    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    // Not a silent give-up: the route reason is logged.
    expect(warn).toHaveBeenCalledWith(
      "codex runtime recovery skipped: model is route-managed",
      { reason: expect.stringContaining("deepseek") },
    );
  });

  test("model=null excludes the failed effective default from fallback selection", async () => {
    const session = makeSession({ model: null });
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.6-sol"), recoverable: false }],
      [{ kind: "completed", finalMessage: "ok" }],
    );
    const availability = availabilityFrom({ "gpt-5.6-terra": "available" });
    const { deps } = makeHarness(availability, session);

    await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(availability.probe).not.toHaveBeenCalledWith("gpt-5.6-sol");
    expect(availability.probe).toHaveBeenCalledWith("gpt-5.6-terra");
    expect(scripted.inputs[1]!.session.model).toBe("gpt-5.6-terra");
  });

  test("active-run mutation failure -> original error, no retry", async () => {
    // Seed the session as idle so the active-run guard rejects the mutation.
    const session = makeSession({ status: "idle" });
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [{ kind: "completed", finalMessage: "should not run" }],
    );
    const { deps } = makeHarness(availabilityFrom({ "gpt-5.6-sol": "available" }), session);

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1); // no retry
    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
  });

  test("missing committed session after mutation keeps the original error visible", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false }],
      [{ kind: "completed", finalMessage: "must not run" }],
    );
    const { deps } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    deps.store.findSessionById = vi.fn(async () => null);

    const events = await drain(recoverCodexRuntimeStream({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    }));

    expect(scripted.calls).toBe(1);
    expect(events).toEqual([
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
  });

  test("non-codex-unavailable ordinary events pass straight through", async () => {
    const session = makeSession();
    const script: AgentEvent[] = [
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "thinking", text: "reasoning" },
      { kind: "assistant_message", text: "done", final: true },
      { kind: "completed", finalMessage: "done" },
    ];
    const scripted = scriptedRun(script);
    const { deps, capturedMutations } = makeHarness(availabilityFrom({}), session);

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(events).toEqual(script);
    expect(scripted.calls).toBe(1);
    expect(capturedMutations).toHaveLength(0);
  });
});

const CAPACITY = "Selected model is at capacity. Please try a different model.";

describe("recoverCodexRuntimeStream capacity retry", () => {
  test("[before-work capacity error] -> notice -> retry SAME frozen RunInput once -> completed", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: CAPACITY, recoverable: false }],
      [
        { kind: "started", backendSessionId: "thread-1" },
        { kind: "assistant_message", text: "hello", final: true },
        { kind: "completed", finalMessage: "hello" },
      ],
    );
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const availabilityProbe = deps.availability.probe;
    deps.isCapacityError = isCodexModelAtCapacity;
    const delay = vi.fn(async (_ms: number) => {});
    deps.delay = delay;
    const runInput: RunInput = { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" };

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput,
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    // Exactly two attempts (before-work capacity call count = 2).
    expect(scripted.calls).toBe(2);
    // The retry replays the EXACT SAME frozen RunInput — same object identity,
    // no model/effort mutation.
    expect(scripted.inputs[0]).toBe(runInput);
    expect(scripted.inputs[1]).toBe(runInput);
    // Zero config mutation, zero availability probe, no fallback model.
    expect(capturedMutations).toHaveLength(0);
    expect(availabilityProbe).not.toHaveBeenCalled();
    // A short bounded delay ran before the retry.
    expect(delay).toHaveBeenCalledTimes(1);
    expect(delay.mock.calls[0]![0]).toBeGreaterThan(0);
    // First capacity error suppressed; a non-final retry notice surfaced.
    expect(events.some((e) => e.kind === "error")).toBe(false);
    const notice = events.find((e) => e.kind === "assistant_message");
    expect(notice).toMatchObject({ kind: "assistant_message", final: false });
    expect(events.at(-1)).toEqual({ kind: "completed", finalMessage: "hello" });
  });

  test("[work signal then capacity error] -> pass-through, no retry (after-work = 1)", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: CAPACITY, recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    deps.isCapacityError = isCodexModelAtCapacity;
    const delay = vi.fn(async () => {});
    deps.delay = delay;

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
    expect(capturedMutations).toHaveLength(0);
    expect(events).toEqual([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: CAPACITY, recoverable: false },
    ]);
  });

  test("[capacity, capacity] -> stops after 2 attempts and surfaces the capacity error (no loop)", async () => {
    const session = makeSession();
    const scripted = scriptedRun(
      [{ kind: "error", message: CAPACITY, recoverable: false }],
      [{ kind: "error", message: CAPACITY, recoverable: false }],
    );
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    deps.isCapacityError = isCodexModelAtCapacity;
    deps.delay = vi.fn(async () => {});

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    // Exactly two attempts, no third — the second attempt is pure pass-through.
    expect(scripted.calls).toBe(2);
    expect(capturedMutations).toHaveLength(0);
    // The capacity error from the second attempt is surfaced.
    expect(events.filter((e) => e.kind === "error")).toEqual([
      { kind: "error", message: CAPACITY, recoverable: false },
    ]);
  });

  test("[429 error] with capacity classifier wired -> no retry (429 remains 1)", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "error", message: "429 Too Many Requests: rate limited", recoverable: false },
    ]);
    const { deps, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    deps.isCapacityError = isCodexModelAtCapacity;
    const delay = vi.fn(async () => {});
    deps.delay = delay;

    const events = await drain(
      recoverCodexRuntimeStream({
        run: scripted.run,
        runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
        messageRunId: RUN_ID,
        sessionId: session.id,
        expected: tupleOf(session),
        deps,
      }),
    );

    expect(scripted.calls).toBe(1);
    expect(delay).not.toHaveBeenCalled();
    expect(capturedMutations).toHaveLength(0);
    expect(events).toEqual([
      { kind: "error", message: "429 Too Many Requests: rate limited", recoverable: false },
    ]);
  });
});

describe("createCodexRuntimeRecoveryRun", () => {
  test("post-work repair mutates only after explicit repairAfterRun and exposes outcomes", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, store, capturedMutations } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const recovery = createCodexRuntimeRecoveryRun({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    });

    await drain(recovery.stream);
    expect(capturedMutations).toHaveLength(0);
    expect(recovery.getOutcome()).toMatchObject({
      kind: "pending_next_run_repair",
      failedModel: "gpt-5.5",
    });

    store.seedSession({ ...session, status: "idle" });
    const result = await recovery.repairAfterRun();

    expect(result).toEqual({ status: "repaired" });
    expect(capturedMutations).toHaveLength(1);
    expect(capturedMutations[0]!.guard).toEqual({ kind: "idle" });
    expect(recovery.getOutcome()).toMatchObject({ kind: "next_run_repaired" });
    expect(await recovery.repairAfterRun()).toEqual({ status: "not_pending" });
    expect(capturedMutations).toHaveLength(1);
  });

  test("post-work repair conflict preserves newer state and returns a structured outcome", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "assistant_message", text: "partial", final: false },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, store } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const realApply = deps.store.applySessionRuntimeConfigMutations.bind(deps.store);
    deps.store.applySessionRuntimeConfigMutations = vi.fn(async (mutations) => {
      store.seedSession({ ...session, status: "idle", model: "gpt-5.4" });
      return realApply(mutations);
    });
    const recovery = createCodexRuntimeRecoveryRun({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    });

    await drain(recovery.stream);
    store.seedSession({ ...session, status: "idle" });
    const result = await recovery.repairAfterRun();

    expect(result).toEqual({ status: "conflict" });
    expect((await store.findSessionById(session.id))?.model).toBe("gpt-5.4");
    expect(recovery.getOutcome()).toMatchObject({ kind: "next_run_repair_conflict" });
  });

  test.each([
    ["backend", { backend: "claude" as const }],
    ["model", { model: "gpt-5.4" }],
    ["effort", { effort: "high" as const }],
    ["resume", { backendSessionId: "thread-new" }],
  ])("post-work repair preserves a newer %s before repairAfterRun starts", async (_field, changed) => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, store } = makeHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    const recovery = createCodexRuntimeRecoveryRun({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    });

    await drain(recovery.stream);
    store.seedSession({ ...session, status: "idle", ...changed });

    expect(await recovery.repairAfterRun()).toEqual({ status: "conflict" });
    expect(await store.findSessionById(session.id)).toMatchObject(changed);
  });

  test("post-work infrastructure rejection does not claim repaired", async () => {
    const session = makeSession();
    const scripted = scriptedRun([
      { kind: "started", backendSessionId: "thread-1" },
      { kind: "error", message: ENTITLEMENT("gpt-5.5"), recoverable: false },
    ]);
    const { deps, store } = makeHarness(availabilityFrom({ "gpt-5.6-sol": "available" }), session);
    const recovery = createCodexRuntimeRecoveryRun({
      run: scripted.run,
      runInput: { messageRunId: TEST_MESSAGE_RUN_ID, session, prompt: "hi" },
      messageRunId: RUN_ID,
      sessionId: session.id,
      expected: tupleOf(session),
      deps,
    });

    await drain(recovery.stream);
    store.seedSession({ ...session, status: "idle" });
    deps.store.applySessionRuntimeConfigMutations = vi.fn(async () => { throw new Error("db down"); });

    await expect(recovery.repairAfterRun()).rejects.toThrow("db down");
    expect(recovery.getOutcome()).not.toMatchObject({ kind: "next_run_repaired" });
  });
});

describe("repairCodexRuntimeConfigForNextRun", () => {
  function makeIdleHarness(availability: CodexModelAvailability, session: Session) {
    const store = createFakeBindingStore();
    store.seedSession(session);
    const capturedMutations: SessionRuntimeConfigMutation[] = [];
    const realApply = store.applySessionRuntimeConfigMutations.bind(store);
    store.applySessionRuntimeConfigMutations = vi.fn(async (mutations) => {
      for (const m of mutations) capturedMutations.push(m);
      return realApply(mutations);
    });
    let n = 0;
    const deps: CodexRuntimeRecoveryDeps = {
      store,
      availability,
      isModelUnavailable: isConfirmedCodexModelUnavailable,
      now: () => asTimestamp(3000),
      idFactory: () => `aud_next_${++n}`,
    };
    return { store, deps, capturedMutations };
  }

  test("repairs config for the next run with an idle guard", async () => {
    const session = makeSession({ status: "idle" });
    const { store, deps, capturedMutations } = makeIdleHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const result = await repairCodexRuntimeConfigForNextRun({
      sessionId: session.id,
      failedModel: "gpt-5.5",
      deps,
    });

    expect(result.status).toBe("repaired");
    expect(capturedMutations).toHaveLength(1);
    expect(capturedMutations[0]!.guard).toEqual({ kind: "idle" });
    const updated = await store.findSessionById(session.id);
    expect(updated?.model).toBe("gpt-5.6-sol");
    expect(updated?.backendSessionId).toBe("thread-1"); // resume preserved
  });

  test("conflict preserves the newer tuple", async () => {
    const session = makeSession({ status: "idle" });
    const { store, deps } = makeIdleHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );
    // A newer tuple lands between the caller reading state and the repair.
    // The expected-tuple guard must reject and preserve the newer value.
    const stale: SessionRuntimeConfigSnapshot = {
      backend: "codex",
      model: "gpt-5.4", // no longer matches what the store holds
      effort: "xhigh",
      backendSessionId: "thread-1",
    };

    const result = await repairCodexRuntimeConfigForNextRun({
      sessionId: session.id,
      failedModel: "gpt-5.5",
      expected: stale,
      deps,
    });

    expect(result.status).toBe("conflict");
    const updated = await store.findSessionById(session.id);
    expect(updated?.model).toBe("gpt-5.5"); // untouched newer tuple
  });

  test("skips a deleted session", async () => {
    const session = makeSession({ status: "deleted" });
    const { deps, capturedMutations } = makeIdleHarness(
      availabilityFrom({ "gpt-5.6-sol": "available" }),
      session,
    );

    const result = await repairCodexRuntimeConfigForNextRun({
      sessionId: session.id,
      failedModel: "gpt-5.5",
      deps,
    });

    expect(result.status).toBe("not_eligible");
    expect(capturedMutations).toHaveLength(0);
  });

  test("no confirmed-available candidate -> unchanged", async () => {
    const session = makeSession({ status: "idle" });
    const { deps, capturedMutations } = makeIdleHarness(availabilityFrom({}), session);

    const result = await repairCodexRuntimeConfigForNextRun({
      sessionId: session.id,
      failedModel: "gpt-5.5",
      deps,
    });

    expect(result.status).toBe("no_candidate");
    expect(capturedMutations).toHaveLength(0);
  });

  test("route-managed probes report route_managed, not a missing candidate", async () => {
    const session = makeSession({ status: "idle" });
    const availability = routeManagedAvailability();
    const { deps, capturedMutations } = makeIdleHarness(availability, session);
    const warn = vi.fn();
    deps.logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: vi.fn() } as never;

    const result = await repairCodexRuntimeConfigForNextRun({
      sessionId: session.id,
      failedModel: "gpt-5.5",
      deps,
    });

    expect(result.status).toBe("route_managed");
    expect(availability.probe).toHaveBeenCalledTimes(1);
    expect(capturedMutations).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      "codex runtime recovery skipped: model is route-managed",
      { reason: expect.stringContaining("deepseek") },
    );
  });
});
