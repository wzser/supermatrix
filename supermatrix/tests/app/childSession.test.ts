import { describe, expect, test, vi } from "vitest";
import { createChildSessionService, type SpawnChildCompletedResult } from "../../src/app/childSession.ts";
import { asAbsolutePath, asSessionId, asTimestamp, type SessionId } from "../../src/domain/ids.ts";
import { UserError } from "../../src/domain/errors.ts";
import { createFakeBindingStore } from "../fakes/fakeBindingStore.ts";
import { createFakeEventBus } from "../fakes/fakeEventBus.ts";
import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import type { AgentBackend, BackendRegistry, RunInput } from "../../src/ports/AgentBackend.ts";
import type { Session } from "../../src/domain/session.ts";
import type { ResultSinkAttempt, ResultSinkAttemptInput } from "../../src/ports/BindingStore.ts";
import type { DeliverySummary } from "../../src/app/resultSinkEngine.ts";
import type { Logger } from "../../src/ports/Logger.ts";

function makeFakeBackend(script: AgentEvent[] = []): AgentBackend {
  return {
    kind: "claude",
    async *run(_input: RunInput): AsyncIterable<AgentEvent> {
      for (const e of script) yield e;
    },
    async cancel() {},
  };
}

function seedParent(store: ReturnType<typeof createFakeBindingStore>): Session {
  const session: Session = {
    id: asSessionId("sess_parent"),
    name: "parent",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/ws/parent"),
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
    createdAt: asTimestamp(1000),
    updatedAt: asTimestamp(1000),
  };
  store.seedSession(session);
  return session;
}

function makeFakeHangingBackend(): AgentBackend {
  return {
    kind: "claude",
    async *run(_input: RunInput): AsyncIterable<AgentEvent> {
      await new Promise(() => {}); // hang forever
    },
    async cancel() {},
  };
}

function makeFakeSlowBackend(delayMs: number, finalMessage: string): AgentBackend {
  return {
    kind: "claude",
    async *run(_input: RunInput): AsyncIterable<AgentEvent> {
      yield { kind: "started", backendSessionId: "bks-slow-1" };
      await new Promise((r) => setTimeout(r, delayMs));
      yield { kind: "assistant_message", text: finalMessage, final: true };
      yield { kind: "completed", finalMessage };
    },
    async cancel() {},
  };
}

function makeControlledBackend(): AgentBackend & {
  prompts: string[];
  releaseNext(finalMessage?: string): void;
  waitForRunCount(count: number): Promise<void>;
} {
  const prompts: string[] = [];
  const releases: Array<(finalMessage: string) => void> = [];
  const waiters: Array<() => void> = [];

  const notify = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };

  return {
    kind: "claude",
    prompts,
    releaseNext(finalMessage = "controlled done") {
      const release = releases.shift();
      if (!release) throw new Error("no controlled backend run waiting");
      release(finalMessage);
    },
    async waitForRunCount(count: number) {
      while (prompts.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async *run(input: RunInput): AsyncIterable<AgentEvent> {
      const finalMessagePromise = new Promise<string>((resolve) => releases.push(resolve));
      prompts.push(input.prompt);
      notify();
      yield { kind: "started", backendSessionId: `bks-controlled-${prompts.length}` };
      const finalMessage = await finalMessagePromise;
      yield { kind: "assistant_message", text: finalMessage, final: true };
      yield { kind: "completed", finalMessage };
    },
    async cancel() {},
  };
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
  if (lastError) throw lastError;
}

function mkService(opts: {
  script?: AgentEvent[];
  backend?: AgentBackend;
  maxDepth?: number;
  maxConcurrent?: number;
  runTimeoutMs?: number;
  queueMaxPerParent?: number;
  queueTtlSec?: number;
  clockNow?: () => ReturnType<typeof asTimestamp>;
  logger?: Logger;
  hanging?: boolean;
  slow?: { delayMs: number; finalMessage: string };
  topicBus?: import("../../src/ports/TopicBus.ts").TopicBus;
  deliverSinks?: (session: Session, finalMessage: string) => Promise<DeliverySummary>;
} = {}) {
  const store = createFakeBindingStore();
  const sinkAttempts: ResultSinkAttemptInput[] = [];
  store.recordResultSinkAttempt = async (input) => {
    sinkAttempts.push({ ...input });
  };
  store.listResultSinkAttemptsBySpawn = async (spawnCommId) =>
    sinkAttempts
      .filter((input) => input.spawnCommId === spawnCommId)
      .map((input): ResultSinkAttempt => ({
        ...input,
        spawnCommId: input.spawnCommId ?? null,
        messageRunId: input.messageRunId ?? null,
        note: input.note ?? null,
        errorMessage: input.errorMessage ?? null,
      }));
  const eventBus = createFakeEventBus();
  const cancelCalls: string[] = [];
  const backend = opts.backend
    ? opts.backend
    : opts.hanging
    ? makeFakeHangingBackend()
    : opts.slow
    ? makeFakeSlowBackend(opts.slow.delayMs, opts.slow.finalMessage)
    : makeFakeBackend(opts.script ?? [
        { kind: "started", backendSessionId: "bks-child-1" },
        { kind: "assistant_message", text: "result from child", final: true },
        { kind: "completed", finalMessage: "result from child" },
      ]);
  const backendRegistry: BackendRegistry = {
    get: () => backend,
    cancel: async (sessionId) => {
      cancelCalls.push(sessionId);
    },
  };
  const clock = { now: () => asTimestamp(5000) };
  const service = createChildSessionService({
    store,
    backendRegistry,
    clock: opts.clockNow ? { now: opts.clockNow } : clock,
    eventBus,
    idFactory: (() => { let i = 0; return () => `sess_child_${++i}`; })(),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    ...(opts.maxConcurrent !== undefined ? { maxConcurrent: opts.maxConcurrent } : {}),
    ...(opts.runTimeoutMs !== undefined ? { runTimeoutMs: opts.runTimeoutMs } : {}),
    ...(opts.queueMaxPerParent !== undefined ? { queueMaxPerParent: opts.queueMaxPerParent } : {}),
    ...(opts.queueTtlSec !== undefined ? { queueTtlSec: opts.queueTtlSec } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    ...(opts.topicBus ? { topicBus: opts.topicBus } : {}),
    ...(opts.deliverSinks ? { deliverSinks: opts.deliverSinks } : {}),
  });
  return { store, eventBus, service: service as any, cancelCalls, sinkAttempts };
}

function seedRequester(store: ReturnType<typeof createFakeBindingStore>, id = "sess_requester"): Session {
  const requester: Session = {
    id: asSessionId(id),
    name: id.replace(/^sess_/u, ""),
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/ws/${id}`),
    backendSessionId: null,
    chatName: null,
    purpose: "",
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
    createdAt: asTimestamp(1000),
    updatedAt: asTimestamp(1000),
  };
  store.seedSession(requester);
  return requester;
}

describe("childSession", () => {
  describe("spawnChild", () => {
    test("creates child session, runs backend, returns result", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "do something",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.finalMessage).toBe("result from child");
      expect(result.backendSessionId).toBe("bks-child-1");
      expect(result.session.scope).toBe("child");
      expect(result.session.parentId).toBe(parent.id);
      expect(result.session.depth).toBe(1);
      expect(result.session.status).toBe("deleted");
    });

    test("inherits parent model when no child model is supplied and backend matches", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      await store.updateSessionModel(parent.id, "claude-opus-4-7");

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "do something",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.session.model).toBe("claude-opus-4-7");
      const stored = await store.findSessionById(result.session.id);
      expect(stored?.model).toBe("claude-opus-4-7");
    });

    test("uses explicit child model instead of parent model", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      await store.updateSessionModel(parent.id, "claude-opus-4-7");

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        model: "claude-sonnet-4-6",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "do something",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.session.model).toBe("claude-sonnet-4-6");
    });

    test("does not inherit parent model across backend override when model is omitted", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      await store.updateSessionModel(parent.id, "claude-opus-4-7");

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "codex",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "do something",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.session.model).toBeNull();
    });

    test("rejects when depth exceeds max", async () => {
      const { store, service } = mkService({ maxDepth: 2 });
      const parent = seedParent(store);

      // Create a depth-2 child manually
      const deep: Session = {
        id: asSessionId("sess_deep"),
        name: "deep",
        alias: "",
        avatar: "", category: "", fpManaged: null,
        scope: "child",
        backend: "claude",
        model: null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: asAbsolutePath("/ws/parent"),
        backendSessionId: null,
        chatName: null,
        purpose: "",
        status: "idle",
        parentId: parent.id,
        depth: 2,
        inactivityTimeoutS: null,
        maxRuntimeS: null,
        childType: null,
        triggerKind: null,
        postIdentity: null,
        callerInvocation: null,
        continuationHook: null,
        capabilityPayload: null,
        createdAt: asTimestamp(2000),
        updatedAt: asTimestamp(2000),
      };
      store.seedSession(deep);

      await expect(
        service.spawnChild({
          parentId: deep.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "go deeper",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        })
      ).rejects.toThrow(UserError);
    });

    test("queues when concurrent children exceed max", async () => {
      const { store, service } = mkService({ maxConcurrent: 1 });
      const parent = seedParent(store);
      const requester = seedRequester(store);

      // Seed an existing busy child
      const busy: Session = {
        id: asSessionId("sess_busy_child"),
        name: "child_parent_1",
        alias: "",
        avatar: "", category: "", fpManaged: null,
        scope: "child",
        backend: "claude",
        model: null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: asAbsolutePath("/ws/parent"),
        backendSessionId: null,
        chatName: null,
        purpose: "",
        status: "busy",
        parentId: parent.id,
        depth: 1,
        inactivityTimeoutS: null,
        maxRuntimeS: null,
        childType: null,
        triggerKind: null,
        postIdentity: null,
        callerInvocation: null,
        continuationHook: null,
        capabilityPayload: null,
        createdAt: asTimestamp(2000),
        updatedAt: asTimestamp(2000),
      };
      store.seedSession(busy);

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "another one",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        callerInvocation: "sync_inline",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result).toMatchObject({
        status: "queued",
        ref: expect.stringMatching(/^spawnq_/),
        commId: expect.stringMatching(/^comm_/),
        spawnCommId: expect.stringMatching(/^comm_/),
      });
      expect(store._listSpawnQueueItems()).toHaveLength(1);
      expect(store._listCrossSessionComms()[0]).toMatchObject({
        id: result.spawnCommId,
        status: "pending",
        fromSessionId: requester.id,
        toSessionId: parent.id,
      });
    });

    test("throws when the per-parent spawn queue is full", async () => {
      const { store, service } = mkService({ maxConcurrent: 1, queueMaxPerParent: 1 });
      const parent = seedParent(store);
      const requester = seedRequester(store);
      store.seedSession({
        ...parent,
        id: asSessionId("sess_busy_child"),
        name: "busy_child",
        scope: "child",
        status: "busy",
        parentId: parent.id,
        depth: 1,
      });

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "queued one",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "queued two",
          requestedBy: requester.id,
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        }),
      ).rejects.toThrow(/spawn queue full/i);
    });

    test("keeps FIFO when a pending queue already exists and a slot is open", async () => {
      const backend = makeControlledBackend();
      const { store, service } = mkService({ backend, maxConcurrent: 1 });
      const parent = seedParent(store);
      const requester = seedRequester(store);

      await store.logCrossSessionComm({
        id: "comm_existing_queue",
        fromSessionId: requester.id,
        toSessionId: parent.id,
        kind: "spawn",
        prompt: "old queued",
        childModel: null,
        createdAt: asTimestamp(4000),
      });
      await store.enqueueSpawnQueueItem({
        id: "spawnq_existing",
        parentId: parent.id,
        spawnInputJson: JSON.stringify({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "old queued",
          requestedBy: requester.id,
          type: "one_shot_delegation",
          callerInvocation: "async_kickoff",
          resultSinks: [{ kind: "parent_continuation_inject", parentSessionId: requester.id }],
        }),
        callerSession: requester.id,
        commId: "comm_existing_queue",
        createdAt: asTimestamp(4000),
        ttlSec: 86_400,
      });

      const queued = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "new request",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        callerInvocation: "sync_inline",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(queued).toMatchObject({ status: "queued" });
      await backend.waitForRunCount(1);
      expect(backend.prompts).toEqual(["old queued"]);

      backend.releaseNext("old done");
      await backend.waitForRunCount(2);
      expect(backend.prompts).toEqual(["old queued", "new request"]);

      backend.releaseNext("new done");
      await eventually(() => {
        expect(store._listCrossSessionComms().find((c) => c.id === queued.spawnCommId)).toMatchObject({
          status: "completed",
          finalMessage: "new done",
        });
      });
    });

    test("dequeues the next pending spawn when a child reaches terminal state", async () => {
      const backend = makeControlledBackend();
      const delivered: Array<{ finalMessage: string; sinkKinds: string[] }> = [];
      const logRows: Array<{ message: string; fields?: Record<string, unknown> }> = [];
      const logger: Logger = {
        debug() {},
        info(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        warn(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        error(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        child() { return logger; },
      };
      const { store, service } = mkService({
        backend,
        maxConcurrent: 1,
        logger,
        deliverSinks: async (session, finalMessage) => {
          delivered.push({
            finalMessage,
            sinkKinds: (session.capabilityPayload?.resultSinks ?? []).map((sink) => sink.kind),
          });
          return { delivered: [] };
        },
      });
      const parent = seedParent(store);
      const requester = seedRequester(store);

      const first = service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });
      await backend.waitForRunCount(1);

      const queued = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "second",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        callerInvocation: "sync_inline",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(queued).toMatchObject({ status: "queued" });
      backend.releaseNext("first done");
      await first;

      await backend.waitForRunCount(2);
      expect(backend.prompts).toEqual(["first", "second"]);
      backend.releaseNext("second done");

      await eventually(() => {
        const queueRows = store._listSpawnQueueItems();
        expect(queueRows[0]).toMatchObject({ status: "dispatched" });
        const comms = store._listCrossSessionComms();
        expect(comms.find((c) => c.id === queued.spawnCommId)).toMatchObject({
          status: "completed",
          finalMessage: "second done",
        });
      });
      expect(logRows.map((row) => row.fields?.event)).toEqual(
        expect.arrayContaining(["spawn_queued", "spawn_dequeued"]),
      );
      expect(delivered).toEqual([
        { finalMessage: "first done", sinkKinds: ["http_response"] },
        { finalMessage: "second done", sinkKinds: ["pollable_endpoint"] },
      ]);
    });

    test("drains pending queue rows after restart when no child completion will trigger drain", async () => {
      const backend = makeControlledBackend();
      const { store, service } = mkService({ backend, maxConcurrent: 1 });
      const parent = seedParent(store);
      const requester = seedRequester(store);

      await store.logCrossSessionComm({
        id: "comm_boot_queue",
        fromSessionId: requester.id,
        toSessionId: parent.id,
        kind: "spawn",
        prompt: "boot queued",
        childModel: null,
        createdAt: asTimestamp(4000),
      });
      await store.enqueueSpawnQueueItem({
        id: "spawnq_boot_queue",
        parentId: parent.id,
        spawnInputJson: JSON.stringify({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "boot queued",
          requestedBy: requester.id,
          type: "one_shot_delegation",
          callerInvocation: "async_kickoff",
          resultSinks: [{ kind: "parent_continuation_inject", parentSessionId: requester.id }],
        }),
        callerSession: requester.id,
        commId: "comm_boot_queue",
        createdAt: asTimestamp(4000),
        ttlSec: 86_400,
      });

      await expect(service.drainSpawnQueues()).resolves.toBe(1);
      await backend.waitForRunCount(1);
      expect(backend.prompts).toEqual(["boot queued"]);

      backend.releaseNext("boot done");
      await eventually(() => {
        expect(store._listSpawnQueueItems()[0]).toMatchObject({ status: "dispatched" });
        expect(store._listCrossSessionComms().find((c) => c.id === "comm_boot_queue")).toMatchObject({
          status: "completed",
          finalMessage: "boot done",
        });
      });
    });

    test("expires queued spawns by TTL and marks their comm failed", async () => {
      let now = asTimestamp(5000);
      const backend = makeControlledBackend();
      const logRows: Array<{ message: string; fields?: Record<string, unknown> }> = [];
      const logger: Logger = {
        debug() {},
        info(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        warn(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        error(message, fields) { logRows.push(fields === undefined ? { message } : { message, fields }); },
        child() { return logger; },
      };
      const { store, service } = mkService({
        backend,
        maxConcurrent: 1,
        queueTtlSec: 1,
        clockNow: () => now,
        logger,
      });
      const parent = seedParent(store);
      const requester = seedRequester(store);

      const first = service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });
      await backend.waitForRunCount(1);

      const queued = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "expires",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        callerInvocation: "sync_inline",
        resultSinks: [{ kind: "http_response" }],
      });

      now = asTimestamp(7001);
      backend.releaseNext("first done");
      await first;

      await eventually(() => {
        expect(store._listSpawnQueueItems()[0]).toMatchObject({ status: "expired" });
        expect(store._listCrossSessionComms().find((c) => c.id === queued.spawnCommId)).toMatchObject({
          status: "failed",
          errorMessage: expect.stringContaining("expired"),
        });
      });
      expect(backend.prompts).toEqual(["first"]);
      expect(logRows.map((row) => row.fields?.event)).toContain("spawn_queue_expired");
    });

    test("publishes session_created and session_status_changed events", async () => {
      const { store, eventBus, service } = mkService();
      const parent = seedParent(store);

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "x",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      const kinds = eventBus.published.map((e) => e.kind);
      expect(kinds).toContain("session_created");
      expect(kinds).toContain("session_status_changed");
    });

    test("times out, cancels backend, and marks session as error when backend hangs", async () => {
      const { store, service, cancelCalls } = mkService({ hanging: true, runTimeoutMs: 100 });
      const parent = seedParent(store);

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "hang forever",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        })
      ).rejects.toThrow(/timed out/);

      const child = await store.findSessionById(asSessionId("sess_child_1"));
      expect(child?.status).toBe("error");
      expect(cancelCalls).toEqual([asSessionId("sess_child_1")]);
    });

    test("persists backendSessionId even when the child times out after start", async () => {
      const { store, service } = mkService({
        runTimeoutMs: 50,
        slow: { delayMs: 150, finalMessage: "delayed result" },
      });
      const parent = seedParent(store);

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "slow prompt",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        })
      ).rejects.toThrow(/timed out/);

      const child = await store.findSessionById(asSessionId("sess_child_1"));
      expect(child?.backendSessionId).toBe("bks-slow-1");
    });

    test("backend error event lands run as failed, skips sink delivery, throws RunFailure", async () => {
      // Repro of codex empty-completion (5/7 16:39): streamParser now emits
      // a stable `error` event for `task_complete last_agent_message=null`.
      // The child runner must record the run as failed (not completed),
      // skip sink delivery, and surface the error to the caller.
      const deliverSinks = vi.fn(async () => ({ delivered: [] }));
      const { store, service } = mkService({
        script: [
          { kind: "started", backendSessionId: "bks-empty" },
          {
            kind: "error",
            message: "codex returned empty completion (last_agent_message=null)",
            recoverable: false,
          },
        ],
        deliverSinks,
      });
      const parent = seedParent(store);

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "你的工作范围",
          type: "ephemeral_conversation",
          callerInvocation: "sync_inline",
          resultSinks: [{ kind: "http_response" }],
        }),
      ).rejects.toThrow(/empty completion/);

      const runs = store._listMessageRuns();
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("failed");
      expect(runs[0]?.errorMessage).toBe(
        "codex returned empty completion (last_agent_message=null)",
      );
      expect(runs[0]?.finalMessage).toBeNull();
      expect(deliverSinks).not.toHaveBeenCalled();

      const session = await store.findSessionById(asSessionId("sess_child_1"));
      expect(session?.status).toBe("error");
    });

    test("persists message_run with status=completed and finalMessage on happy path", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "do something",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      const runs = store._listMessageRuns();
      expect(runs.length).toBe(1);
      expect(runs[0]?.sessionId).toBe(asSessionId("sess_child_1"));
      expect(runs[0]?.prompt).toBe("do something");
      expect(runs[0]?.status).toBe("completed");
      expect(runs[0]?.finalMessage).toBe("result from child");
      expect(runs[0]?.errorMessage).toBeNull();
      expect(runs[0]?.finishedAt).not.toBeNull();
    });

    test("cross_session_log persists full final_message + message_run_id when requestedBy is set", async () => {
      const longMessage = "x".repeat(2000);
      const { store, service } = mkService({
        script: [
          { kind: "started", backendSessionId: "bks-long" },
          { kind: "assistant_message", text: longMessage, final: true },
          { kind: "completed", finalMessage: longMessage },
        ],
      });
      const parent = seedParent(store);
      const requester: Session = {
        id: asSessionId("sess_requester"),
        name: "requester",
        alias: "",
        avatar: "", category: "", fpManaged: null,
        scope: "user",
        backend: "claude",
        model: null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: asAbsolutePath("/ws/requester"),
        backendSessionId: null,
        chatName: null,
        purpose: "",
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
        createdAt: asTimestamp(1000),
        updatedAt: asTimestamp(1000),
      };
      store.seedSession(requester);

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "long task",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      const comms = store._listCrossSessionComms();
      expect(comms).toHaveLength(1);
      expect(comms[0]?.status).toBe("completed");
      expect(comms[0]?.resultPreview?.length).toBeLessThanOrEqual(503);
      expect(comms[0]?.finalMessage).toBe(longMessage);
      // idFactory yields sess_child_1 (childId) then sess_child_2 (runId).
      expect(comms[0]?.messageRunId).toBe("sess_child_2");
      // child inherits parent model when no explicit override
      expect(comms[0]?.childModel).toBeNull();   // parent.model is null in seedParent
    });

    test("late successful completion repairs run, child session, and cross-session comm after timeout", async () => {
      const { store, service } = mkService({
        runTimeoutMs: 50,
        slow: { delayMs: 150, finalMessage: "delayed result" },
      });
      const parent = seedParent(store);
      const requester: Session = {
        id: asSessionId("sess_requester"),
        name: "requester",
        alias: "",
        avatar: "", category: "", fpManaged: null,
        scope: "user",
        backend: "claude",
        model: null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: asAbsolutePath("/ws/requester"),
        backendSessionId: null,
        chatName: null,
        purpose: "",
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
        createdAt: asTimestamp(1000),
        updatedAt: asTimestamp(1000),
      };
      store.seedSession(requester);

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "slow prompt",
          requestedBy: requester.id,
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        })
      ).rejects.toThrow(/timed out/);

      await new Promise((r) => setTimeout(r, 300));

      const runs = store._listMessageRuns();
      expect(runs.length).toBe(1);
      expect(runs[0]?.status).toBe("completed");
      expect(runs[0]?.finalMessage).toBe("delayed result");
      expect(runs[0]?.finishedAt).not.toBeNull();

      const child = await store.findSessionById(asSessionId("sess_child_1"));
      expect(child?.status).toBe("deleted");
      expect(child?.backendSessionId).toBe("bks-slow-1");

      const comms = store._listCrossSessionComms();
      expect(comms).toHaveLength(1);
      expect(comms[0]?.status).toBe("completed");
      expect(comms[0]?.finalMessage).toBe("delayed result");
      expect(comms[0]?.messageRunId).toBe("sess_child_2");
      expect(comms[0]?.childModel).toBeNull();
    });

    test("cross_session_log records child_model when explicitly set", async () => {
      const { store, service } = mkService({
        script: [
          { kind: "started", backendSessionId: "bks-1" },
          { kind: "assistant_message", text: "done", final: true },
          { kind: "completed", finalMessage: "done" },
        ],
      });
      const parent = seedParent(store);
      const requester: Session = {
        id: asSessionId("sess_req2"),
        name: "requester2",
        alias: "",
        avatar: "", category: "", fpManaged: null,
        scope: "user",
        backend: "claude",
        model: null,
        effort: null,
        thinking: false,
        modelLocked: false,
        workdir: asAbsolutePath("/ws/requester2"),
        backendSessionId: null,
        chatName: null,
        purpose: "",
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
        createdAt: asTimestamp(1000),
        updatedAt: asTimestamp(1000),
      };
      store.seedSession(requester);

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        model: "claude-opus-4-7",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "task",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      const comms = store._listCrossSessionComms();
      expect(comms).toHaveLength(1);
      expect(comms[0]?.childModel).toBe("claude-opus-4-7");
    });

    test("cross_session_log records client_request_id when provided", async () => {
      const { store, service } = mkService({
        script: [
          { kind: "started", backendSessionId: "bks-client-request" },
          { kind: "assistant_message", text: "done", final: true },
          { kind: "completed", finalMessage: "done" },
        ],
      });
      const parent = seedParent(store);
      const requester: Session = {
        ...parent,
        id: asSessionId("sess_req_client_request"),
        name: "requester_client_request",
      };
      store.seedSession(requester);

      await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "task",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
        clientRequestId: "biz-request-child-session-123",
      });

      const comms = store._listCrossSessionComms();
      expect(comms).toHaveLength(1);
      expect((comms[0] as { clientRequestId?: string | null } | undefined)?.clientRequestId)
        .toBe("biz-request-child-session-123");
    });

    test("returns spawnCommId when spawn is requested by another session", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      const requester: Session = {
        ...parent,
        id: asSessionId("sess_requester_spawn_comm"),
        name: "requester_spawn_comm",
      };
      store.seedSession(requester);

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "task with comm id",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.spawnCommId).toMatch(/^comm_/);
      const comms = store._listCrossSessionComms();
      expect(result.spawnCommId).toBe(comms[0]?.id);
    });

    test("records failed unknown sink attempt when deliverSinks throws", async () => {
      const { store, service, sinkAttempts } = mkService({
        deliverSinks: async () => {
          throw new Error("sink transport down");
        },
      });
      const parent = seedParent(store);
      const requester: Session = {
        ...parent,
        id: asSessionId("sess_requester_sink_fail"),
        name: "requester_sink_fail",
      };
      store.seedSession(requester);

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "task with failing sink",
        requestedBy: requester.id,
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      expect(result.finalMessage).toBe("result from child");
      expect(sinkAttempts).toHaveLength(1);
      expect(sinkAttempts[0]).toMatchObject({
        spawnCommId: result.spawnCommId,
        childSessionId: result.session.id,
        messageRunId: result.messageRunId,
        sinkIndex: 0,
        sinkKind: "unknown",
        status: "failed",
        errorMessage: "sink transport down",
      });
    });

    test("does not resurrect a cascade-deleted child when the run completes afterwards", async () => {
      const sinkCalls: Array<{ sessionId: SessionId; status: string }> = [];
      const { store, service } = mkService({
        slow: { delayMs: 80, finalMessage: "late result" },
        deliverSinks: async (session) => {
          sinkCalls.push({ sessionId: session.id, status: session.status });
          return { delivered: [] };
        },
      });
      const parent = seedParent(store);

      const spawnPromise = service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "slow prompt",
        type: "ephemeral_conversation",
        resultSinks: [{ kind: "http_response" }],
      });

      // Let the child row get created + marked busy before we simulate the
      // parent cascade. The slow backend still owes 80ms of work.
      await new Promise((r) => setTimeout(r, 20));
      await store.deleteSessionAndBinding(parent.id);

      await spawnPromise;

      const child = await store.findSessionById(asSessionId("sess_child_1"));
      expect(child?.status).toBe("deleted");
      expect(sinkCalls).toEqual([]);
    });
  });

  describe("keepAlive", () => {
    test("spawnChild with keepAlive=true leaves child idle (not deleted)", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const first = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first",
        type: "ephemeral_conversation",
        resultSinks: [{ kind: "chat_post", chatRef: { kind: "parent" }, identity: "bot" }],
      });
      expect(first.session.status).toBe("idle");
    });

    test("resumeChild with keepAlive=true keeps child idle across turns", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const first = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first",
        type: "ephemeral_conversation",
        resultSinks: [{ kind: "chat_post", chatRef: { kind: "parent" }, identity: "bot" }],
      });
      expect(first.session.status).toBe("idle");

      const second = await service.resumeChild({
        sessionId: first.session.id,
        prompt: "follow up",
      });
      expect(second.session.id).toBe(first.session.id);
      expect(second.session.status).toBe("idle");
    });
  });

  describe("event_awaited_worker (step 9 waiting state)", () => {
    test("rejects spawn without eventBusContract.subscribe", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/x"),
          prompt: "wait",
          type: "event_awaited_worker",
          callerInvocation: "async_kickoff",
          resultSinks: [{ kind: "pollable_endpoint" }],
          // no eventBusContract.subscribe
        }),
      ).rejects.toThrow(/requires eventBusContract\.subscribe/);
    });

    test("rejects spawn with sync_inline callerInvocation", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);
      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/x"),
          prompt: "wait",
          type: "event_awaited_worker",
          callerInvocation: "sync_inline",
          eventBusContract: { subscribe: "done", subscribeGatesCompletion: true },
          resultSinks: [{ kind: "pollable_endpoint" }],
        }),
      ).rejects.toThrow(/sync_inline/);
    });

    test("happy path: waits, event fires, transitions to terminal + delivers sinks", async () => {
      const { InMemoryTopicBus } = await import("../../src/adapters/topic-bus-memory/index.ts");
      const topicBus = new InMemoryTopicBus();
      const sinkCalls: Array<{ sessionId: string; finalMessage: string; status: string }> = [];
      const { store, service } = mkService({
        topicBus,
        deliverSinks: async (session, finalMessage) => {
          sinkCalls.push({
            sessionId: session.id,
            finalMessage,
            status: session.status,
          });
          return { delivered: [] };
        },
      });
      const parent = seedParent(store);

      const spawnP = service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/x"),
        prompt: "go wait",
        type: "event_awaited_worker",
        callerInvocation: "async_kickoff",
        eventBusContract: { subscribe: "gate.open", subscribeGatesCompletion: true },
        resultSinks: [{ kind: "pollable_endpoint" }],
      });

      // Wait for the child to enter waiting state.
      await new Promise((r) => setTimeout(r, 10));
      const midway = await store.findSessionById(asSessionId("sess_child_1"));
      expect(midway?.status).toBe("waiting");
      expect(sinkCalls).toHaveLength(0);

      // Fire the gate event.
      await topicBus.publish("gate.open", { any: "payload" });

      const result = await spawnP;
      expect(result.finalMessage).toBe("result from child");
      expect(result.session.status).toBe("deleted");

      // Sink delivery fired with the child's own first-run finalMessage.
      expect(sinkCalls).toHaveLength(1);
      expect(sinkCalls[0]?.finalMessage).toBe("result from child");
      expect(sinkCalls[0]?.status).toBe("deleted");
    });

    test("times out when gate event never fires", async () => {
      const { InMemoryTopicBus } = await import("../../src/adapters/topic-bus-memory/index.ts");
      const topicBus = new InMemoryTopicBus();
      const sinkCalls: unknown[] = [];
      const { store, service } = mkService({
        topicBus,
        deliverSinks: async () => {
          sinkCalls.push(1);
          return { delivered: [] };
        },
      });
      const parent = seedParent(store);

      // Use 10ms maxRuntime via a lookalike policy override: call with a
      // small timeout by cranking down the type's maxRuntime. Since the
      // policy table is a const, we can't swap easily in-test — but the
      // behavior we care about (timeout path transitions to error, no sink
      // delivery) is exercised via a short wait tick if we monkey-patch.
      //
      // Instead of policy override, we spawn with a tiny fake topicBus that
      // never fires and mock deps.clock / setTimeout with fake timers.
      const { vi: viLocal } = await import("vitest");
      viLocal.useFakeTimers();
      try {
        const spawnP = service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/x"),
          prompt: "wait forever",
          type: "event_awaited_worker",
          callerInvocation: "async_kickoff",
          eventBusContract: { subscribe: "never.fires", subscribeGatesCompletion: true },
          resultSinks: [{ kind: "pollable_endpoint" }],
        });
        // Attach the rejection-asserting handler *before* advancing timers so
        // node doesn't emit an unhandledrejection between the rejection and
        // the test's observation (well-known fake-timers gotcha).
        const rejectionObserved = expect(spawnP).rejects.toThrow(/timed out/i);

        // Let microtasks run: first-run completes, session enters waiting.
        await viLocal.advanceTimersByTimeAsync(0);
        // Advance past the default event_awaited_worker maxRuntime (60min).
        await viLocal.advanceTimersByTimeAsync(60 * 60 * 1000 + 100);

        await rejectionObserved;
        const after = await store.findSessionById(asSessionId("sess_child_1"));
        expect(after?.status).toBe("error");
        expect(sinkCalls).toHaveLength(0);
      } finally {
        viLocal.useRealTimers();
      }
    });
  });

  describe("onSessionReady hook (step 3 async kickoff)", () => {
    test("fires before spawnChild resolves, with session + messageRunId", async () => {
      const { store, service } = mkService({
        slow: { delayMs: 40, finalMessage: "eventual" },
      });
      const parent = seedParent(store);

      let readyCalledAt: number | null = null;
      let finalResolvedAt: number | null = null;
      let capturedRunId: string | null = null;

      const finalPromise = service
        .spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "async task",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "pollable_endpoint" }],
          onSessionReady: ({ messageRunId }: { messageRunId: SpawnChildCompletedResult["messageRunId"] }) => {
            readyCalledAt = Date.now();
            capturedRunId = messageRunId;
          },
        })
        .then((r: SpawnChildCompletedResult) => {
          finalResolvedAt = Date.now();
          return r;
        });

      // Give the microtask queue a chance for onSessionReady to fire.
      await new Promise((r) => setTimeout(r, 5));
      expect(readyCalledAt).not.toBeNull();
      expect(capturedRunId).not.toBeNull();
      expect(finalResolvedAt).toBeNull(); // still in-flight

      const result = await finalPromise;
      expect(finalResolvedAt).not.toBeNull();
      expect(readyCalledAt!).toBeLessThanOrEqual(finalResolvedAt!);
      expect(result.messageRunId).toBe(capturedRunId);
      expect(result.finalMessage).toBe("eventual");
    });

    test("hook errors are swallowed — spawn completes normally", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const result = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "task",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
        onSessionReady: () => {
          throw new Error("hook sabotage");
        },
      });

      expect(result.finalMessage).toBe("result from child");
    });
  });

  describe("run timeout from policy table (D8)", () => {
    test("uses policyForType(childType).maxRuntimeSec when deps.runTimeoutMs is absent", async () => {
      const { store, service, cancelCalls } = mkService({ hanging: true });
      const parent = seedParent(store);

      vi.useFakeTimers();
      try {
        const spawnP = service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "hang forever",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        });
        // Attach the rejection-asserting handler before advancing timers to
        // avoid unhandledrejection noise with fake timers.
        const rejected = expect(spawnP).rejects.toThrow(/timed out after 1800s/);

        // Just shy of 30 min: still pending.
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 500);
        // Cross the 30-minute mark → policy timeout fires.
        await vi.advanceTimersByTimeAsync(1000);
        await rejected;

        expect(cancelCalls).toEqual([asSessionId("sess_child_1")]);
        const child = await store.findSessionById(asSessionId("sess_child_1"));
        expect(child?.status).toBe("error");
      } finally {
        vi.useRealTimers();
      }
    });

    test("SM_CHILD_MAX_RUNTIME_SEC env override flows through to runPrompt", async () => {
      const prev = process.env.SM_CHILD_MAX_RUNTIME_SEC;
      process.env.SM_CHILD_MAX_RUNTIME_SEC = "1";
      try {
        const { store, service } = mkService({ hanging: true });
        const parent = seedParent(store);

        await expect(
          service.spawnChild({
            parentId: parent.id,
            backend: "claude",
            workdir: asAbsolutePath("/ws/target"),
            prompt: "hang",
            type: "one_shot_delegation",
            resultSinks: [{ kind: "http_response" }],
          }),
        ).rejects.toThrow(/timed out after 1s/);
      } finally {
        if (prev === undefined) delete process.env.SM_CHILD_MAX_RUNTIME_SEC;
        else process.env.SM_CHILD_MAX_RUNTIME_SEC = prev;
      }
    });

    test("deps.runTimeoutMs still wins over policy / env values", async () => {
      const prev = process.env.SM_CHILD_MAX_RUNTIME_SEC;
      process.env.SM_CHILD_MAX_RUNTIME_SEC = String(60 * 60); // 1 hour env
      try {
        const { store, service } = mkService({ hanging: true, runTimeoutMs: 80 });
        const parent = seedParent(store);

        const start = Date.now();
        await expect(
          service.spawnChild({
            parentId: parent.id,
            backend: "claude",
            workdir: asAbsolutePath("/ws/target"),
            prompt: "hang",
            type: "one_shot_delegation",
            resultSinks: [{ kind: "http_response" }],
          }),
        ).rejects.toThrow(/timed out/);
        // Must have taken ~80ms, not 1 hour → deps.runTimeoutMs won.
        expect(Date.now() - start).toBeLessThan(5000);
      } finally {
        if (prev === undefined) delete process.env.SM_CHILD_MAX_RUNTIME_SEC;
        else process.env.SM_CHILD_MAX_RUNTIME_SEC = prev;
      }
    });
  });

  describe("resumeChild", () => {
    test("rejects resume on completed (deleted) child", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const first = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first task",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      // spawnChild marks completed child as deleted
      expect(first.session.status).toBe("deleted");

      await expect(
        service.resumeChild({ sessionId: first.session.id, prompt: "follow up" })
      ).rejects.toThrow(UserError);
    });

    test("resumes idle child session (manually kept alive)", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const first = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first task",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });

      // Simulate manually reverting to idle (e.g. for long-lived child sessions)
      await store.updateSessionStatus(first.session.id, "idle", asTimestamp(6000));

      const second = await service.resumeChild({
        sessionId: first.session.id,
        prompt: "follow up",
      });

      expect(second.session.id).toBe(first.session.id);
      expect(second.finalMessage).toBe("result from child");
    });

    test("reverts session out of busy when startMessageRun throws", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      const first = await service.spawnChild({
        parentId: parent.id,
        backend: "claude",
        workdir: asAbsolutePath("/ws/target"),
        prompt: "first task",
        type: "one_shot_delegation",
        resultSinks: [{ kind: "http_response" }],
      });
      await store.updateSessionStatus(first.session.id, "idle", asTimestamp(6000));

      const realStart = store.startMessageRun.bind(store);
      let calls = 0;
      store.startMessageRun = async () => {
        calls++;
        throw new Error("simulated db failure");
      };

      await expect(
        service.resumeChild({ sessionId: first.session.id, prompt: "follow up" })
      ).rejects.toThrow("simulated db failure");
      expect(calls).toBe(1);

      const after = await store.findSessionById(first.session.id);
      expect(after?.status).not.toBe("busy");

      // Restore so subsequent assertions/teardown don't trip.
      store.startMessageRun = realStart;
    });
  });

  describe("spawnChild error revert", () => {
    test("reverts new child out of busy when startMessageRun throws", async () => {
      const { store, service } = mkService();
      const parent = seedParent(store);

      store.startMessageRun = async () => {
        throw new Error("simulated db failure on spawn");
      };

      await expect(
        service.spawnChild({
          parentId: parent.id,
          backend: "claude",
          workdir: asAbsolutePath("/ws/target"),
          prompt: "task",
          type: "one_shot_delegation",
          resultSinks: [{ kind: "http_response" }],
        })
      ).rejects.toThrow("simulated db failure on spawn");

      const all = await store.listActiveSessions();
      const stuck = all.find((s) => s.status === "busy");
      expect(stuck).toBeUndefined();
    });
  });
});
