import { describe, expect, test } from "vitest";
import { createChildSessionService } from "../../src/app/childSession.ts";
import { createDispatcher } from "../../src/app/dispatcher.ts";
import { runOnSession } from "../../src/app/runOnSession.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";
import type { AgentBackend, BackendRegistry, RunInput } from "../../src/ports/AgentBackend.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import { createFakeLarkGateway } from "../fakes/fakeLarkGateway.ts";
import { createFakeReplier } from "../fakes/fakeReplier.ts";

const ROOT_GROUP = asLarkGroupId("oc_root");
const USER_GROUP = asLarkGroupId("oc_user");

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: asSessionId("sess_claude"),
    name: "claude-session",
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
    effortLocked: false,
    workdir: asAbsolutePath("/tmp/claude-session"),
    backendSessionId: null,
    chatName: null,
    purpose: "test",
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
    createdAt: asTimestamp(1_700_000_000_000),
    updatedAt: asTimestamp(1_700_000_000_000),
    ...overrides,
  };
}

function recordingClaudeBackend(): {
  backend: AgentBackend;
  registry: BackendRegistry;
  calls: RunInput[];
  requestedBackends: string[];
} {
  const calls: RunInput[] = [];
  const requestedBackends: string[] = [];
  const backend: AgentBackend = {
    kind: "claude",
    async *run(input: RunInput): AsyncIterable<AgentEvent> {
      calls.push(input);
      yield { kind: "completed", finalMessage: "should not run while fenced" };
    },
    async cancel() {},
  };
  return {
    backend,
    registry: {
      get(kind) {
        requestedBackends.push(kind);
        return backend;
      },
      cancel: async () => {},
    },
    calls,
    requestedBackends,
  };
}

async function acquireClaudeFence(store: ReturnType<typeof createFakeBindingStore>): Promise<void> {
  await expect(store.acquireBackendMaintenanceLease({
    backend: "claude",
    owner: "sm-switch",
    tokenHash: "sha256:lease-token",
    requestId: "switch-fence-test",
    acquiredAt: asTimestamp(1_700_000_000_010),
  })).resolves.toMatchObject({ kind: "acquired", duplicate: false });
}

describe("Claude maintenance fence real admission paths", () => {
  test("dispatcher rejects a fenced Claude prompt before backend execution", async () => {
    const store = createFakeBindingStore();
    const target = session();
    store.seedSession(target);
    store.seedBinding({ groupId: USER_GROUP, sessionId: target.id, createdAt: asTimestamp(1) });
    await acquireClaudeFence(store);
    const lark = createFakeLarkGateway();
    const recorded = recordingClaudeBackend();
    const dispatcher = createDispatcher({
      store,
      lark,
      router: { async route() { return { replyText: "unused" }; } },
      backend: recorded.registry,
      replier: createFakeReplier(),
      rootGroupId: ROOT_GROUP,
      clock: { now: () => asTimestamp(1_700_000_000_011) },
      idFactory: () => "mr_dispatch_fenced",
    });

    await dispatcher.handleInbound({
      groupId: USER_GROUP,
      messageId: "msg-fenced",
      userId: "ou_test",
      text: "new Claude task",
      attachments: [],
      receivedAtMs: 1,
    });

    expect(recorded.calls).toEqual([]);
    expect(store._listMessageRuns()).toEqual([]);
    expect((await store.findSessionById(target.id))?.status).toBe("idle");
    expect(lark.sent.at(-1)?.text).toMatch(/Claude.*维护/u);
  });

  test("runOnSession refuses a fenced Claude API run without invoking the backend", async () => {
    const store = createFakeBindingStore();
    const target = session();
    store.seedSession(target);
    await acquireClaudeFence(store);
    const recorded = recordingClaudeBackend();

    const result = await runOnSession({
      store,
      backendRegistry: recorded.registry,
      clock: { now: () => asTimestamp(1_700_000_000_011) },
      idFactory: () => "mr_api_fenced",
    }, {
      session: target,
      prompt: "API prompt",
      groupId: USER_GROUP,
    });

    expect(result).toMatchObject({ kind: "maintenance", backend: "claude", leaseOwner: "sm-switch" });
    expect(recorded.calls).toEqual([]);
    expect(store._listMessageRuns()).toEqual([]);
  });

  test("runOnSession executes the backend tuple atomically admitted by the store, not a stale caller snapshot", async () => {
    const store = createFakeBindingStore();
    const persisted = session({ backend: "codex" });
    // Simulate a caller which read the old Claude tuple just before a valid
    // backend reconfiguration. Claude is fenced, but the durable admission
    // reads codex; running the stale tuple here would violate the fence.
    const staleCallerSnapshot = session({ backend: "claude" });
    store.seedSession(persisted);
    await acquireClaudeFence(store);
    const recorded = recordingClaudeBackend();

    const result = await runOnSession({
      store,
      backendRegistry: recorded.registry,
      clock: { now: () => asTimestamp(1_700_000_000_011) },
      idFactory: () => "mr_admitted_tuple",
    }, {
      session: staleCallerSnapshot,
      prompt: "must use the admitted backend",
      groupId: USER_GROUP,
    });

    expect(result).toMatchObject({ kind: "ok" });
    expect(recorded.requestedBackends).toEqual(["codex"]);
    expect(recorded.calls[0]?.session.backend).toBe("codex");
  });

  test("direct and queued child spawns both fail closed at their shared admission point", async () => {
    const store = createFakeBindingStore();
    const parent = session({ id: asSessionId("sess_parent"), name: "parent" });
    const requester = session({ id: asSessionId("sess_requester"), name: "requester" });
    store.seedSession(parent);
    store.seedSession(requester);
    await acquireClaudeFence(store);
    const recorded = recordingClaudeBackend();
    const service = createChildSessionService({
      store,
      backendRegistry: recorded.registry,
      clock: { now: () => asTimestamp(1_700_000_000_011) },
      eventBus: createFakeEventBus(),
      idFactory: (() => { let n = 0; return () => `sess_child_${++n}`; })(),
      availability: { probe: async () => ({ kind: "available", checkedAt: 1 }) },
    });
    const childInput = {
      parentId: parent.id,
      backend: "claude" as const,
      workdir: asAbsolutePath("/tmp/child"),
      prompt: "child task",
      requestedBy: requester.id,
      type: "one_shot_delegation" as const,
      resultSinks: [{ kind: "pollable_endpoint" as const }],
    };

    await expect(service.spawnChild(childInput)).rejects.toThrow(/claude.*maintenance/i);
    expect(recorded.calls).toEqual([]);

    await store.logCrossSessionComm({
      id: "comm_queued_fenced",
      fromSessionId: requester.id,
      toSessionId: parent.id,
      kind: "spawn",
      prompt: "queued child task",
      childModel: null,
      createdAt: asTimestamp(1_700_000_000_012),
    });
    await store.enqueueSpawnQueueItem({
      id: "spawnq_fenced",
      parentId: parent.id,
      spawnInputJson: JSON.stringify({ ...childInput, prompt: "queued child task", callerInvocation: "async_kickoff" }),
      callerSession: requester.id,
      commId: "comm_queued_fenced",
      createdAt: asTimestamp(1_700_000_000_012),
      ttlSec: 60,
    });

    await expect(service.drainSpawnQueues()).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded.calls).toEqual([]);
    expect(store._listSpawnQueueItems()[0]).toMatchObject({ status: "failed" });
    expect(store._listCrossSessionComms().find((comm) => comm.id === "comm_queued_fenced"))
      .toMatchObject({ status: "failed", errorMessage: expect.stringMatching(/claude.*maintenance/i) });
  });

  test("an admission-store exception propagates and never falls through to a backend call", async () => {
    const store = createFakeBindingStore();
    const target = session();
    store.seedSession(target);
    const recorded = recordingClaudeBackend();
    store.admitMessageRun = async () => {
      throw new Error("maintenance admission database unavailable");
    };

    await expect(runOnSession({
      store,
      backendRegistry: recorded.registry,
      clock: { now: () => asTimestamp(1_700_000_000_011) },
      idFactory: () => "mr_admission_error",
    }, {
      session: target,
      prompt: "must fail closed",
      groupId: USER_GROUP,
    })).rejects.toThrow("maintenance admission database unavailable");

    expect(recorded.calls).toEqual([]);
    expect(store._listMessageRuns()).toEqual([]);
  });
});
