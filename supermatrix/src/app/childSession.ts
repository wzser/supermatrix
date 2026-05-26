import type {
  CallerInvocation,
  ChildSessionType,
  ContinuationHook,
  EventBusContract,
  PostIdentity,
  ResultSink,
  TriggerKind,
} from "../domain/childCapabilities.ts";
import {
  isChildSessionType,
} from "../domain/childCapabilities.ts";
import type { SessionEvent } from "../domain/events/sessionEvent.ts";
import { UserError } from "../domain/errors.ts";
import {
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  type AbsolutePath,
  type MessageRunId,
  type SessionId,
  type Timestamp,
} from "../domain/ids.ts";
import type { BackendKind, Session, SessionStatus } from "../domain/session.ts";
import type { BackendRegistry } from "../ports/AgentBackend.ts";
import type {
  BindingStore,
  NormalizedSpawnPredicate,
  ResultSinkAttemptStatus,
  SpawnQueueItem,
} from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import type { TopicBus } from "../ports/TopicBus.ts";
import { policyForType, policyForTypeOrDefault } from "./childSessionPolicy.ts";
import type { DeliverySummary } from "./resultSinkEngine.ts";
import { classifyRunStatus } from "./runStatus.ts";
import { collectStream, type StreamResult } from "./streamCollector.ts";

class RunFailure extends Error {
  constructor(message: string, readonly messageRunId: MessageRunId) {
    super(message);
    this.name = "RunFailure";
  }
}

const DEFAULT_SPAWN_QUEUE_MAX_PER_PARENT = 100;
const DEFAULT_SPAWN_QUEUE_TTL_SEC = 24 * 60 * 60;

export type ChildSessionDeps = {
  store: BindingStore;
  backendRegistry: BackendRegistry;
  clock: Clock;
  eventBus?: EventBus;
  /**
   * Required for `event_awaited_worker` to actually wait — after its first
   * run finishes, the session subscribes to the topic declared in
   * `eventBusContract.subscribe` and blocks until the topic fires or
   * maxRuntime elapses.
   */
  topicBus?: TopicBus;
  idFactory?: () => string;
  /**
   * Test overrides. Production code should let policy defaults drive these
   * values via `policyForType()` — the overrides exist so unit tests can
   * assert depth/concurrency guardrails without constructing full policies.
   */
  maxDepth?: number;
  maxConcurrent?: number;
  runTimeoutMs?: number;
  queueMaxPerParent?: number;
  queueTtlSec?: number;
  logger?: Logger;
  /**
   * Sink delivery hook. Invoked after a successful run with the child's
   * final message; production wiring passes in `deliverResultSinks` bound
   * to real postToChat / injectContinuation implementations. Omitting this
   * is safe — the child just finishes without external delivery (useful for
   * tests that don't exercise sinks).
   */
  deliverSinks?: (session: Session, finalMessage: string) => Promise<DeliverySummary>;
};

export type SpawnChildInput = {
  parentId: SessionId;
  backend: BackendKind;
  model?: string | null;
  workdir: AbsolutePath;
  prompt: string;
  type: ChildSessionType;
  resultSinks: ResultSink[];
  requestedBy?: SessionId;
  triggerKind?: TriggerKind;
  postIdentity?: PostIdentity;
  callerInvocation?: CallerInvocation;
  continuationHook?: ContinuationHook;
  eventBusContract?: EventBusContract;
  /**
   * Fires once the child session row + first message_run row are persisted,
   * before the backend stream has finished. Async callers (HTTP /api/spawn
   * with callerInvocation=async_kickoff|fire_and_forget) use this to return
   * a 202 response with {childSessionId, messageRunId} without blocking on
   * the full run. Errors thrown from this hook are swallowed — the spawn
   * itself continues.
   */
  onSessionReady?: (info: {
    session: Session;
    messageRunId: MessageRunId;
    spawnCommId?: string;
  }) => void | Promise<void>;
  verificationPredicate?: NormalizedSpawnPredicate;
  clientRequestId?: string;
  /** Feishu open_id of the human who triggered this spawn (ou_ prefix). */
  senderId?: string;
};

// After a child session's run ends, its session row transitions to this status.
// ephemeral_conversation alone keeps the row alive (idle) for follow-up runs.
// event_awaited_worker technically enters a `waiting` state (step 9) — until then,
// it is treated like one_shot.
export function terminalStatusForChildType(type: ChildSessionType | null): SessionStatus {
  return type === "ephemeral_conversation" ? "idle" : "deleted";
}

export type SpawnChildCompletedResult = {
  session: Session;
  finalMessage: string;
  backendSessionId: string | null;
  messageRunId: MessageRunId;
  spawnCommId?: string;
};

export type SpawnChildQueuedResult = {
  status: "queued";
  ref: string;
  commId: string;
  spawnCommId: string;
  parentId: SessionId;
  queuedAt: Timestamp;
  ttlSec: number;
};

export type SpawnChildResult = SpawnChildCompletedResult | SpawnChildQueuedResult;

export function isSpawnChildQueuedResult(result: SpawnChildResult): result is SpawnChildQueuedResult {
  return "status" in result && result.status === "queued";
}

export type ResumeChildInput = {
  sessionId: SessionId;
  prompt: string;
};

type RunPromptHooks = {
  onLateSuccess?: (result: SpawnChildCompletedResult) => Promise<void>;
  /** Fires after startMessageRun, before awaiting the backend stream. */
  onRunStarted?: (info: { session: Session; messageRunId: MessageRunId }) => void | Promise<void>;
  spawnCommId?: string;
  senderId?: string;
};

export function createChildSessionService(deps: ChildSessionDeps) {
  const genId = deps.idFactory ?? (() => "sess_child_" + Math.random().toString(36).slice(2, 10));

  const emit = (event: SessionEvent) =>
    deps.eventBus ? deps.eventBus.publish(event) : Promise.resolve();

  // Busy → error fallback when a runPrompt setup step (e.g. startMessageRun)
  // throws *before* the streamOutcome handler can persist a terminal status.
  // Without this, the session row stays "busy" forever — `resumeChild`/
  // `spawnChild` themselves had no try/catch around the busy update, so any
  // exception from the DB layer leaked out and left the row stranded.
  const revertBusyOnSetupFailure = async (sessionId: SessionId) => {
    try {
      const current = await deps.store.findSessionById(sessionId);
      if (current?.status !== "busy") return;
      const now = deps.clock.now();
      await deps.store.updateSessionStatus(sessionId, "error", now);
      await emit({
        kind: "session_status_changed",
        sessionId,
        from: "busy",
        to: "error",
      });
    } catch {
      // Best-effort cleanup; if the store is genuinely unavailable here
      // there is nothing more we can do, and we must not mask the original
      // error the caller is about to receive.
    }
  };

  async function spawnChild(input: SpawnChildInput): Promise<SpawnChildResult> {
    const admission = await prepareSpawn(input);
    await expireDueQueueItems(input.parentId, deps.clock.now());

    const activeChildren = await deps.store.countActiveChildrenByParent(input.parentId);
    const pendingQueuedSpawns = await deps.store.countPendingSpawnQueueItemsByParent(input.parentId);
    if (activeChildren >= admission.effectiveMaxBusy || pendingQueuedSpawns > 0) {
      const queued = await enqueueSpawnChild(input, admission, pendingQueuedSpawns);
      if (activeChildren < admission.effectiveMaxBusy) {
        scheduleDrainSpawnQueue(input.parentId, admission.effectiveMaxBusy);
      }
      return queued;
    }

    return await startChildRun(input, admission);
  }

  type SpawnAdmission = {
    parent: Session;
    childModel: string | null;
    childDepth: number;
    effectiveMaxBusy: number;
  };

  async function prepareSpawn(input: SpawnChildInput): Promise<SpawnAdmission> {
    // Guardrails established in the scenario-driven redesign:
    //   every child declares its type + at least one result sink, spawn-time.
    //   See plan §2 Root gap identification.
    if (!isChildSessionType(input.type)) {
      throw new UserError(`invalid child type: ${String(input.type)}`);
    }
    if (!Array.isArray(input.resultSinks) || input.resultSinks.length === 0) {
      throw new UserError(
        `child type ${input.type} requires at least one resultSink (where should the result go?)`
      );
    }

    // event_awaited_worker's whole purpose is to wait on an external event —
    // it must declare WHICH topic, and cannot run as sync_inline (the caller's
    // HTTP / command handler can't hold a connection open for up to an hour).
    if (input.type === "event_awaited_worker") {
      const topic = input.eventBusContract?.subscribe;
      if (!topic) {
        throw new UserError(
          "event_awaited_worker requires eventBusContract.subscribe (topic name)",
        );
      }
      if (input.callerInvocation === "sync_inline") {
        throw new UserError(
          "event_awaited_worker cannot use callerInvocation=sync_inline; use async_kickoff or fire_and_forget",
        );
      }
    }

    const parent = await deps.store.findSessionById(input.parentId);
    if (!parent) throw new UserError(`parent session not found: ${input.parentId}`);
    const childModel =
      input.model !== undefined
        ? input.model
        : input.backend === parent.backend
          ? parent.model
          : null;

    // Per-type policy drives depth + concurrency caps. Test overrides
    // (deps.maxDepth / deps.maxConcurrent) still win when present so the
    // existing guardrail tests work unchanged.
    const policy = policyForType(input.type);
    const effectiveMaxDepth = deps.maxDepth ?? policy.maxDepth;
    const effectiveMaxBusy = deps.maxConcurrent ?? policy.maxBusyChildrenPerParent;

    const childDepth = parent.depth + 1;
    if (childDepth > effectiveMaxDepth) {
      throw new UserError(`child depth ${childDepth} exceeds max ${effectiveMaxDepth}`);
    }

    return { parent, childModel, childDepth, effectiveMaxBusy };
  }

  async function enqueueSpawnChild(
    input: SpawnChildInput,
    admission: SpawnAdmission,
    pendingCount: number,
  ): Promise<SpawnChildQueuedResult> {
    const queueMax = configuredPositiveInt(
      deps.queueMaxPerParent,
      process.env.SM_SPAWN_QUEUE_MAX_PER_PARENT,
      DEFAULT_SPAWN_QUEUE_MAX_PER_PARENT,
    );
    if (pendingCount >= queueMax) {
      throw new UserError(
        `parent ${admission.parent.name} spawn queue full (${pendingCount}/${queueMax})`,
      );
    }

    const rawId = genId();
    const ref = `spawnq_${safeIdPart(rawId)}`;
    const now = deps.clock.now();
    const ttlSec = configuredPositiveInt(
      deps.queueTtlSec,
      process.env.SM_SPAWN_QUEUE_TTL_SEC,
      DEFAULT_SPAWN_QUEUE_TTL_SEC,
    );
    const callerSession = input.requestedBy ?? input.parentId;
    const commId = `comm_${safeIdPart(rawId).slice(-12)}_${Date.now()}`;
    const queuedInput = queuedSpawnInput(input, callerSession);

    await deps.store.logCrossSessionComm({
      id: commId,
      fromSessionId: callerSession,
      toSessionId: input.parentId,
      kind: "spawn",
      prompt: input.prompt,
      childModel: admission.childModel,
      clientRequestId: input.clientRequestId ?? null,
      createdAt: now,
    }, input.verificationPredicate
      ? {
          spawnCommId: commId,
          ownerSessionId: callerSession,
          createdBySessionId: callerSession,
          normalizedPredicate: input.verificationPredicate,
          createdAt: now,
        }
      : undefined);

    await deps.store.enqueueSpawnQueueItem({
      id: ref,
      parentId: input.parentId,
      spawnInputJson: JSON.stringify(queuedInput),
      callerSession,
      commId,
      createdAt: now,
      ttlSec,
    });

    logQueueEvent("spawn_queued", {
      ref,
      comm_id: commId,
      parent_id: input.parentId,
      caller_session: callerSession,
      ttl_sec: ttlSec,
      pending_count: pendingCount + 1,
    });

    return {
      status: "queued",
      ref,
      commId,
      spawnCommId: commId,
      parentId: input.parentId,
      queuedAt: now,
      ttlSec,
    };
  }

  async function startChildRun(
    input: SpawnChildInput,
    admission: SpawnAdmission,
    options: { commId?: string; commAlreadyLogged?: boolean } = {},
  ): Promise<SpawnChildCompletedResult> {
    const { parent, childModel, childDepth } = admission;
    const childId = asSessionId(genId());
    const childName = `child_${parent.name}_${childId.slice(-6)}`;
    const now = deps.clock.now();

    let requesterName: string | undefined;
    if (input.requestedBy) {
      const requester = await deps.store.findSessionById(input.requestedBy);
      requesterName = requester?.name;
    }
    const purpose = requesterName ? `requested by ${requesterName}` : "";

    const triggerKind: TriggerKind =
      input.triggerKind ?? (input.requestedBy ? "session" : "human");

    const session = await deps.store.createSession({
      id: childId,
      name: childName,
      scope: "child",
      backend: input.backend,
      model: childModel,
      workdir: input.workdir,
      purpose,
      createdAt: now,
      parentId: input.parentId,
      depth: childDepth,
      childType: input.type,
      triggerKind,
      postIdentity: input.postIdentity ?? null,
      callerInvocation: input.callerInvocation ?? null,
      continuationHook: input.continuationHook ?? "none",
      capabilityPayload: {
        resultSinks: input.resultSinks,
        ...(input.eventBusContract ? { eventBusContract: input.eventBusContract } : {}),
      },
    });
    await deps.store.updateSessionStatus(session.id, "busy", now);
    await emit({ kind: "session_created", session });

    const commId = options.commId ?? (input.requestedBy ? `comm_${childId.slice(-8)}_${Date.now()}` : null);
    if (commId && input.requestedBy && !options.commAlreadyLogged) {
      await deps.store.logCrossSessionComm({
        id: commId,
        fromSessionId: input.requestedBy,
        toSessionId: input.parentId,
        kind: "spawn",
        prompt: input.prompt,
        childModel: session.model ?? null,   // child model resolved at session creation
        clientRequestId: input.clientRequestId ?? null,
        createdAt: now,
      }, input.verificationPredicate
        ? {
            spawnCommId: commId,
            ownerSessionId: input.requestedBy,
            createdBySessionId: input.requestedBy,
            normalizedPredicate: input.verificationPredicate,
            createdAt: now,
          }
        : undefined);
    }

    const finishCommCompleted = async (result: SpawnChildCompletedResult) => {
      if (!commId) return;
      const preview = result.finalMessage.length > 500
        ? result.finalMessage.slice(0, 500) + "..."
        : result.finalMessage;
      await deps.store.finishCrossSessionComm(
        commId,
        "completed",
        childId,
        preview,
        undefined,
        result.finalMessage,
        result.messageRunId ?? undefined,
      );
    };

    try {
      const result = await runPrompt(session, input.prompt, {
        onLateSuccess: finishCommCompleted,
        ...(commId ? { spawnCommId: commId } : {}),
        ...(input.senderId ? { senderId: input.senderId } : {}),
        ...(input.onSessionReady
          ? {
              onRunStarted: async (info) => {
                try {
                  await input.onSessionReady!({
                    ...info,
                    ...(commId ? { spawnCommId: commId } : {}),
                  });
                } catch (hookErr) {
                  // Hook errors must not abort the spawn.
                  // eslint-disable-next-line no-console
                  console.warn("onSessionReady hook threw:", hookErr);
                }
              },
            }
          : {}),
      });
      const resultWithCommId = commId ? { ...result, spawnCommId: commId } : result;
      await finishCommCompleted(resultWithCommId);
      return resultWithCommId;
    } catch (err) {
      await revertBusyOnSetupFailure(session.id);
      if (commId) {
        const message = err instanceof Error ? err.message : "unknown error";
        await deps.store.finishCrossSessionComm(
          commId,
          "failed",
          childId,
          undefined,
          message,
          undefined,
          err instanceof RunFailure ? err.messageRunId : undefined,
        );
      }
      throw err;
    } finally {
      scheduleDrainSpawnQueue(input.parentId, admission.effectiveMaxBusy);
    }
  }

  function scheduleDrainSpawnQueue(parentId: SessionId, effectiveMaxBusy?: number): void {
    void drainSpawnQueue(parentId, effectiveMaxBusy).catch((err) => {
      deps.logger?.warn("spawn queue drain failed", {
        parent_id: parentId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async function drainSpawnQueues(): Promise<number> {
    const parents = (await deps.store.listActiveSessions())
      .filter((session) => session.scope !== "child");
    let parentsWithPendingQueue = 0;
    for (const parent of parents) {
      const pending = await deps.store.countPendingSpawnQueueItemsByParent(parent.id);
      if (pending === 0) continue;
      parentsWithPendingQueue += 1;
      await drainSpawnQueue(parent.id);
    }
    return parentsWithPendingQueue;
  }

  async function drainSpawnQueue(parentId: SessionId, effectiveMaxBusyHint?: number): Promise<void> {
    const now = deps.clock.now();
    await expireDueQueueItems(parentId, now);

    const activeChildren = await deps.store.countActiveChildrenByParent(parentId);
    const maxBusy =
      effectiveMaxBusyHint ??
      deps.maxConcurrent ??
      policyForType("one_shot_delegation").maxBusyChildrenPerParent;
    if (activeChildren >= maxBusy) return;

    const item = await deps.store.claimNextSpawnQueueItem(parentId, now);
    if (!item) return;

    logQueueEvent("spawn_dequeued", {
      ref: item.id,
      comm_id: item.commId,
      parent_id: item.parentId,
    });

    void dispatchQueuedSpawn(item).catch(async (err) => {
      const failedAt = deps.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      await deps.store.markSpawnQueueItemFailed(item.id, failedAt);
      await deps.store.finishCrossSessionComm(
        item.commId,
        "failed",
        undefined,
        undefined,
        message,
        undefined,
        undefined,
      );
      deps.logger?.warn("spawn queue dispatch failed", {
        event: "spawn_queue_dispatch_failed",
        ref: item.id,
        comm_id: item.commId,
        parent_id: item.parentId,
        err: message,
      });
      scheduleDrainSpawnQueue(item.parentId, effectiveMaxBusyHint);
    });
  }

  async function dispatchQueuedSpawn(item: SpawnQueueItem): Promise<void> {
    const input = parseQueuedSpawnInput(item);
    const admission = await prepareSpawn(input);
    await startChildRun(input, admission, {
      commId: item.commId,
      commAlreadyLogged: true,
    });
  }

  async function expireDueQueueItems(parentId: SessionId, now: Timestamp): Promise<void> {
    const expired = await deps.store.expireSpawnQueueItemsByParent(parentId, now);
    for (const item of expired) {
      await finishExpiredQueueItem(item);
    }
  }

  async function finishExpiredQueueItem(item: SpawnQueueItem): Promise<void> {
    const message = `spawn queue item ${item.id} expired after ${item.ttlSec}s before dispatch`;
    await deps.store.finishCrossSessionComm(
      item.commId,
      "failed",
      undefined,
      undefined,
      message,
      message,
      undefined,
    );
    logQueueEvent("spawn_queue_expired", {
      ref: item.id,
      comm_id: item.commId,
      parent_id: item.parentId,
      ttl_sec: item.ttlSec,
    });
  }

  function logQueueEvent(event: "spawn_queued" | "spawn_dequeued" | "spawn_queue_expired", fields: Record<string, unknown>): void {
    deps.logger?.info("spawn queue", {
      event,
      ...fields,
    });
  }

  function queuedSpawnInput(input: SpawnChildInput, callerSession: SessionId): Omit<SpawnChildInput, "onSessionReady"> {
    const resultSinks: ResultSink[] =
      input.resultSinks.map((sink) =>
        sink.kind === "http_response"
          ? { kind: "pollable_endpoint" }
          : sink
      );
    const queued: Omit<SpawnChildInput, "onSessionReady"> = {
      parentId: input.parentId,
      backend: input.backend,
      ...(input.model !== undefined ? { model: input.model } : {}),
      workdir: input.workdir,
      prompt: input.prompt,
      type: input.type,
      resultSinks,
      requestedBy: callerSession,
      triggerKind: input.triggerKind ?? "session",
      ...(input.postIdentity ? { postIdentity: input.postIdentity } : {}),
      ...(input.continuationHook ? { continuationHook: input.continuationHook } : {}),
      ...(input.eventBusContract ? { eventBusContract: input.eventBusContract } : {}),
      ...(input.verificationPredicate ? { verificationPredicate: input.verificationPredicate } : {}),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.senderId ? { senderId: input.senderId } : {}),
    };
    const callerInvocation = input.callerInvocation === "sync_inline"
      ? "async_kickoff"
      : input.callerInvocation;
    return callerInvocation ? { ...queued, callerInvocation } : queued;
  }

  function parseQueuedSpawnInput(item: SpawnQueueItem): SpawnChildInput {
    const parsed = JSON.parse(item.spawnInputJson) as SpawnChildInput;
    return parsed;
  }

  async function resumeChild(input: ResumeChildInput): Promise<SpawnChildCompletedResult> {
    const session = await deps.store.findSessionById(input.sessionId);
    if (!session) throw new UserError(`child session not found: ${input.sessionId}`);
    if (session.scope !== "child") throw new UserError(`session ${session.name} is not a child`);
    if (session.status === "deleted") throw new UserError(`child session ${session.name} is deleted`);
    if (session.status === "busy") throw new UserError(`child session ${session.name} is busy`);

    const now = deps.clock.now();
    await deps.store.updateSessionStatus(session.id, "busy", now);
    await emit({
      kind: "session_status_changed",
      sessionId: session.id,
      from: session.status,
      to: "busy",
    });

    try {
      return await runPrompt(session, input.prompt);
    } catch (err) {
      await revertBusyOnSetupFailure(session.id);
      throw err;
    } finally {
      if (session.parentId) {
        scheduleDrainSpawnQueue(
          session.parentId,
          deps.maxConcurrent ?? policyForTypeOrDefault(session.childType).maxBusyChildrenPerParent,
        );
      }
    }
  }

  async function runPrompt(
    session: Session,
    prompt: string,
    hooks: RunPromptHooks = {},
  ): Promise<SpawnChildCompletedResult> {
    // D8: per-run timeout comes from the policy table (env-tunable for
    // DEFAULT_POLICY via SM_CHILD_MAX_RUNTIME_SEC). `deps.runTimeoutMs`
    // stays as a test override.
    const runTimeoutMs =
      deps.runTimeoutMs ?? policyForTypeOrDefault(session.childType).maxRuntimeSec * 1000;
    const spawnCommId = hooks.spawnCommId ?? null;

    const usageBaseline =
      session.backend === "codex"
        ? await deps.store.getLatestTokenUsageRawTotals(session.id)
        : null;
    const stream = deps.backendRegistry.get(session.backend).run({ session, prompt });

    // Child sessions don't necessarily have a lark binding; use the parent's
    // group if available, else a synthetic marker so the NOT NULL column has a value.
    const parentBinding = session.parentId
      ? await deps.store.findBySession(session.parentId)
      : null;
    const groupId = parentBinding?.groupId
      ?? asLarkGroupId(`spawn:${session.parentId ?? session.id}`);

    const runId = asMessageRunId(genId());
    await deps.store.startMessageRun({
      id: runId,
      sessionId: session.id,
      groupId,
      prompt,
      startedAt: deps.clock.now(),
      ...(hooks.senderId ? { senderId: hooks.senderId } : {}),
    });

    // Hook point for async spawn kickoff: at this moment, the session row +
    // message_run row are both persisted; HTTP async callers can now return
    // 202 with {childSessionId, messageRunId} and the rest of this function
    // finishes in the background.
    await hooks.onRunStarted?.({ session, messageRunId: runId });

    let timedOut = false;
    let completedSuccessfully = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    // Terminal status is derived from the child type, not an ad-hoc flag.
    // Only ephemeral_conversation keeps its row alive (idle) for follow-up runs.
    const nextStatus = terminalStatusForChildType(session.childType);

    const persistBackendSessionId = async (backendSessionId: string | null) => {
      if (!backendSessionId) return;
      await deps.store.updateSessionBackendSessionId(session.id, backendSessionId);
    };

    const restoreSuccessfulTerminalState = async (collected: StreamResult) => {
      await persistBackendSessionId(collected.backendSessionId);
      const current = await deps.store.findSessionById(session.id);
      if (current && (current.status === "busy" || current.status === "error")) {
        const now = deps.clock.now();
        await deps.store.updateSessionStatus(session.id, nextStatus, now);
        await emit({
          kind: "session_status_changed",
          sessionId: session.id,
          from: current.status,
          to: nextStatus,
        });
      }
    };

    // Guard against parent cascade deletion racing run completion. If the
    // parent was deleted mid-run, `deleteSessionAndBinding` already flipped
    // this child row to "deleted"; the terminal status write below must not
    // resurrect it, and sink delivery must not fire (the parent chat / caller
    // is gone). Returns true if the caller should short-circuit the rest of
    // the terminal path.
    const isDeletedNow = async (): Promise<boolean> => {
      const current = await deps.store.findSessionById(session.id);
      return current?.status === "deleted";
    };

    // Track the stream's ACTUAL completion independent of the race below.
    // If the race timeout wins, the caller gets an error but this promise
    // still runs to completion and persists the final message to message_runs.
    const streamOutcome = collectStream(stream, {
      onStarted: async (event) => {
        await persistBackendSessionId(event.backendSessionId);
      },
      normalizeCumulativeUsage: session.backend === "codex",
      usageBaseline,
    }).then(
      (res) => ({ ok: true as const, res }),
      (err) => ({
        ok: false as const,
        err: err instanceof Error ? err : new Error(String(err)),
      }),
    );
    streamOutcome.then(async (outcome) => {
      try {
        if (outcome.ok) {
          if (outcome.res.usage) {
            await deps.store.recordTokenUsage({
              sessionId: session.id,
              messageRunId: runId,
              backend: session.backend,
              model: outcome.res.usage.model ?? session.model ?? null,
              inputTokens: outcome.res.usage.inputTokens,
              outputTokens: outcome.res.usage.outputTokens,
              cacheReadTokens: outcome.res.usage.cacheReadTokens,
              cacheWriteTokens: outcome.res.usage.cacheWriteTokens,
              reasoningTokens: outcome.res.usage.reasoningTokens,
              rawUsageJson: outcome.res.usage.rawUsageJson,
              createdAt: deps.clock.now(),
            });
          }
          if (outcome.res.error) {
            // Backend stream emitted a stable error event (e.g. codex empty
            // completion). Record as failed so downstream (sinks, callers,
            // watchdog) treat it as a real failure, not a silent zero-byte
            // success. Usage is still recorded above when present.
            await deps.store.finishMessageRun(
              runId,
              classifyRunStatus(outcome.res.error),
              undefined,
              outcome.res.error,
              outcome.res.streamLog && outcome.res.streamLog.length > 0
                ? JSON.stringify(outcome.res.streamLog)
                : undefined,
            );
          } else {
            completedSuccessfully = true;
            await deps.store.finishMessageRun(
              runId,
              "completed",
              outcome.res.finalMessage,
              undefined,
              outcome.res.streamLog && outcome.res.streamLog.length > 0
                ? JSON.stringify(outcome.res.streamLog)
                : undefined,
            );
            if (timedOut) {
              await restoreSuccessfulTerminalState(outcome.res);
              await hooks.onLateSuccess?.({
                session: (await deps.store.findSessionById(session.id)) ?? { ...session, status: nextStatus },
                finalMessage: outcome.res.finalMessage,
                backendSessionId: outcome.res.backendSessionId,
                messageRunId: runId,
                ...(spawnCommId ? { spawnCommId } : {}),
              });
            }
          }
        } else {
          await deps.store.finishMessageRun(
            runId,
            timedOut ? "timeout" : "failed",
            undefined,
            timedOut ? `[timeout] ${outcome.err.message}` : outcome.err.message,
            undefined,
          );
        }
      } catch {
        // Swallow: store may be closed during shutdown; don't crash the event loop.
      }
    });

    try {
      const collected: StreamResult = await Promise.race([
        streamOutcome.then((o) => {
          if (!o.ok) throw o.err;
          return o.res;
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            reject(new Error(`child session ${session.name} timed out after ${runTimeoutMs / 1000}s`));
          }, runTimeoutMs);
          if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) timeoutHandle.unref();
        }),
      ]);

      if (timeoutHandle) clearTimeout(timeoutHandle);
      await persistBackendSessionId(collected.backendSessionId);

      // Stream emitted an error event (e.g. codex empty completion). Skip
      // sink delivery, status updates, and onLateSuccess; let the catch at
      // line 642 mark the session as error and surface it as RunFailure.
      // The streamOutcome.then handler above has already written the run
      // row with status=failed and the same error message.
      if (collected.error) {
        throw new RunFailure(collected.error, runId);
      }

      const now = deps.clock.now();

      // event_awaited_worker: insert a gating "waiting" phase between run
      // completion and terminal transition / sink delivery. The child's
      // first-run output is preserved as the deliverable; the gating event
      // is purely a TIMING signal. If a caller needs the publisher's payload
      // as the content, they should subscribe to that topic inside the
      // child's first run and store the result in their own finalMessage.
      const gating =
        session.childType === "event_awaited_worker"
          ? session.capabilityPayload?.eventBusContract
          : undefined;

      if (gating?.subscribeGatesCompletion && gating.subscribe) {
        if (!deps.topicBus) {
          // Fail loud — we validated this at spawn but topicBus wasn't
          // wired at service construction. Treat as an infrastructure
          // bug, not a run-time error per child.
          throw new Error(
            "event_awaited_worker was spawned but deps.topicBus is not wired",
          );
        }

        // Parent gone → don't enter the waiting phase (would hold a topicBus
        // subscription up to maxRuntime for a deleted session), don't deliver
        // sinks. Preserve "deleted" as the observable terminal state.
        if (await isDeletedNow()) {
          return {
            session: { ...session, status: "deleted" },
            finalMessage: collected.finalMessage,
            backendSessionId: collected.backendSessionId,
            messageRunId: runId,
          };
        }

        await deps.store.updateSessionStatus(session.id, "waiting", now);
        await emit({
          kind: "session_status_changed",
          sessionId: session.id,
          from: "busy",
          to: "waiting",
        });

        const waitTopic: string = gating.subscribe;
        const waitMaxMs = policyForType(session.childType!).maxRuntimeSec * 1000;

        // Race the topic arrival against maxRuntime.
        const gateOutcome = await waitForGate(waitTopic, waitMaxMs, deps.topicBus);

        if (gateOutcome.ok) {
          if (await isDeletedNow()) {
            return {
              session: { ...session, status: "deleted" },
              finalMessage: collected.finalMessage,
              backendSessionId: collected.backendSessionId,
              messageRunId: runId,
            };
          }
          const terminalNow = deps.clock.now();
          await deps.store.updateSessionStatus(session.id, nextStatus, terminalNow);
          await emit({
            kind: "session_status_changed",
            sessionId: session.id,
            from: "waiting",
            to: nextStatus,
          });
          const updated = await deps.store.findSessionById(session.id);
          const sessionForSinks = updated ?? { ...session, status: nextStatus };
          await deliverAndRecordSinks(sessionForSinks, collected.finalMessage, runId, spawnCommId);
          return {
            session: sessionForSinks,
            finalMessage: collected.finalMessage,
            backendSessionId: collected.backendSessionId,
            messageRunId: runId,
            ...(spawnCommId ? { spawnCommId } : {}),
          };
        }

        // Timeout — transition to error and surface a RunFailure. Sink
        // delivery is intentionally skipped; a failed waiter doesn't trigger
        // parent continuation.
        if (!(await isDeletedNow())) {
          const errNow = deps.clock.now();
          await deps.store.updateSessionStatus(session.id, "error", errNow);
          await emit({
            kind: "session_status_changed",
            sessionId: session.id,
            from: "waiting",
            to: "error",
          });
        }
        throw new RunFailure(
          `event_awaited_worker timed out after ${waitMaxMs / 1000}s on topic "${waitTopic}"`,
          runId,
        );
      }

      if (await isDeletedNow()) {
        return {
          session: { ...session, status: "deleted" },
          finalMessage: collected.finalMessage,
          backendSessionId: collected.backendSessionId,
          messageRunId: runId,
        };
      }

      await deps.store.updateSessionStatus(session.id, nextStatus, now);
      await emit({
        kind: "session_status_changed",
        sessionId: session.id,
        from: "busy",
        to: nextStatus,
      });

      const updated = await deps.store.findSessionById(session.id);
      const sessionForSinks = updated ?? { ...session, status: nextStatus };

      // Fire result sink delivery. Non-fatal if it throws — the primary
      // spawn result is already recorded in DB. Sink engine short-circuits
      // for sync_inline callers so /spawn / /btw / sync /api/spawn are
      // unaffected.
      await deliverAndRecordSinks(sessionForSinks, collected.finalMessage, runId, spawnCommId);

      return {
        session: sessionForSinks,
        finalMessage: collected.finalMessage,
        backendSessionId: collected.backendSessionId,
        messageRunId: runId,
        ...(spawnCommId ? { spawnCommId } : {}),
      };
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (timedOut) {
        try {
          await deps.backendRegistry.cancel(session.id);
        } catch {
          // Best-effort cancellation only.
        }
      }
      if (!completedSuccessfully && !(await isDeletedNow())) {
        const now = deps.clock.now();
        await deps.store.updateSessionStatus(session.id, "error", now);
        await emit({
          kind: "session_status_changed",
          sessionId: session.id,
          from: "busy",
          to: "error",
        });
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new RunFailure(reason, runId);
    }
  }

  async function deliverAndRecordSinks(
    sessionForSinks: Session,
    finalMessage: string,
    messageRunId: MessageRunId,
    spawnCommId: string | null,
  ): Promise<void> {
    if (!deps.deliverSinks) return;
    try {
      const summary = await deps.deliverSinks(sessionForSinks, finalMessage);
      await recordDeliverySummary(sessionForSinks, messageRunId, spawnCommId, summary);
    } catch (sinkErr) {
      const errorMessage = sinkErr instanceof Error ? sinkErr.message : String(sinkErr);
      await recordResultSinkAttemptSafe({
        id: sinkAttemptId(messageRunId, "throw"),
        spawnCommId,
        childSessionId: sessionForSinks.id,
        messageRunId,
        sinkIndex: 0,
        sinkKind: "unknown",
        status: "failed",
        errorMessage,
        createdAt: deps.clock.now(),
      });
      // eslint-disable-next-line no-console
      console.warn("deliverSinks threw (non-fatal):", sinkErr);
    }
  }

  async function recordDeliverySummary(
    sessionForSinks: Session,
    messageRunId: MessageRunId,
    spawnCommId: string | null,
    summary: DeliverySummary,
  ): Promise<void> {
    for (const [sinkIndex, outcome] of summary.delivered.entries()) {
      await recordResultSinkAttemptSafe({
        id: sinkAttemptId(messageRunId, sinkIndex),
        spawnCommId,
        childSessionId: sessionForSinks.id,
        messageRunId,
        sinkIndex,
        sinkKind: outcome.sinkKind,
        status: statusForOutcome(outcome),
        ...(outcome.note ? { note: outcome.note } : {}),
        ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        createdAt: deps.clock.now(),
      });
    }
  }

  async function recordResultSinkAttemptSafe(
    input: Parameters<BindingStore["recordResultSinkAttempt"]>[0],
  ): Promise<void> {
    try {
      await deps.store.recordResultSinkAttempt(input);
    } catch (err) {
      // Sink observability is best-effort and must not turn a completed child
      // run into a failure path.
      // eslint-disable-next-line no-console
      console.warn("recordResultSinkAttempt threw (non-fatal):", err);
    }
  }

  return { spawnChild, resumeChild, drainSpawnQueues };
}

function sinkAttemptId(messageRunId: MessageRunId, suffix: number | string): string {
  const safeRunId = messageRunId.replace(/[^A-Za-z0-9_-]/gu, "_");
  return `sink_${safeRunId}_${suffix}`;
}

function statusForOutcome(
  outcome: DeliverySummary["delivered"][number],
): ResultSinkAttemptStatus {
  if (!outcome.ok) return "failed";
  if (outcome.note?.startsWith("skipped:")) return "skipped";
  return "delivered";
}

function configuredPositiveInt(
  depValue: number | undefined,
  envValue: string | undefined,
  fallback: number,
): number {
  const candidate = depValue ?? (envValue === undefined ? undefined : Number.parseInt(envValue, 10));
  if (candidate === undefined || !Number.isFinite(candidate) || candidate <= 0) return fallback;
  return Math.trunc(candidate);
}

function safeIdPart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return safe.length > 0 ? safe : "queued";
}

/**
 * Block until the named topic fires OR `maxMs` elapses.
 *
 * Subscribes with replay=true so an event published between first-run
 * completion and this subscribe call is still caught (see TopicBus ring
 * buffer). The first message observed on the topic opens the gate; the
 * subscription is torn down in both success and timeout paths.
 */
async function waitForGate(
  topic: string,
  maxMs: number,
  topicBus: TopicBus,
): Promise<{ ok: true } | { ok: false; reason: "timeout" }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve({ ok: false, reason: "timeout" });
    }, maxMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();

    const unsubscribe = topicBus.subscribe(
      topic,
      async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve({ ok: true });
      },
      { replay: true },
    );
  });
}
