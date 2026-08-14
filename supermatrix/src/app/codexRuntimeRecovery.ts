import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../domain/events/agentEvent.ts";
import { asTimestamp, type MessageRunId, type SessionId, type Timestamp } from "../domain/ids.ts";
import type { EffortLevel } from "../domain/session.ts";
import type { RunInput } from "../ports/AgentBackend.ts";
import { resolveRunExecutionConfig, type RunExecutionConfig } from "../ports/RunExecutionConfig.ts";
import type {
  BindingStore,
  SessionRuntimeConfigMutation,
  SessionRuntimeConfigSnapshot,
} from "../ports/BindingStore.ts";
import { RuntimeConfigConflictError } from "../ports/BindingStore.ts";
import type { CodexModelAvailability } from "../ports/CodexModelAvailability.ts";
import {
  getCodexDefaultModel,
  getCodexModelCatalogFingerprint,
  getCodexModelCatalogSnapshot,
  getCodexModelCatalogSource,
  type CodexModelCatalogSnapshot,
} from "../ports/CodexModelCatalog.ts";
import type { Logger } from "../ports/Logger.ts";
import {
  resolveSessionRuntimeConfig,
  type RuntimeConfigTuple,
} from "./sessionRuntimeConfigPolicy.ts";
import type { CodexResumeRecoveryBackup } from "./codexResumeRecovery.ts";

// Runtime recovery for Codex admission failures. When a Codex run fails with a
// confirmed model-unavailable (account-entitlement) error BEFORE any work
// signal, replace the model with a verified fallback and replay the same
// logical run exactly once. Everything else — rate limits, timeouts, network
// faults, ordinary backend errors, and model/resume incompatibility — passes
// through untouched. See the runtime config state-machine plan, Task 7.

export type CodexRuntimeRecoveryDeps = {
  store: BindingStore;
  availability: CodexModelAvailability;
  /** Injected so the app layer never imports the adapter classifier directly. */
  isModelUnavailable: (error: unknown) => boolean;
  /**
   * Narrow, exact classifier for the transient provider "at capacity" error.
   * Injected like {@link isModelUnavailable} so the app layer never imports the
   * adapter classifier directly. When absent, capacity retry is disabled and
   * the error passes through unchanged.
   */
  isCapacityError?: (error: unknown) => boolean;
  /** Bounded pause before the single capacity replay; injected for tests. */
  delay?: (ms: number) => Promise<void>;
  now?: () => Timestamp;
  idFactory?: () => string;
  logger?: Logger;
  getCatalogSnapshot?: () => CodexModelCatalogSnapshot;
  getCatalogSource?: () => string;
  getCatalogFingerprint?: () => string;
  /** Creates a verified, recoverable runtime-DB snapshot before poison clear. */
  backupBeforeResumeClear?: CodexResumeRecoveryBackup;
};

// Bounded pause before the single capacity replay. Short enough to stay within
// a normal turn, long enough to let a transient capacity blip clear.
const CAPACITY_RETRY_DELAY_MS = 1_500;
const CAPACITY_RETRY_NOTICE =
  "⚠️ codex 模型当前繁忙（at capacity），正在自动重试一次…";

async function capacityRetryDelay(deps: CodexRuntimeRecoveryDeps): Promise<void> {
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  await delay(CAPACITY_RETRY_DELAY_MS);
}

export type CodexRuntimeRecoveryOutcome = {
  /** An in-run before-work fallback replay was performed (at most once). */
  retried: boolean;
  /**
   * A confirmed unavailable error surfaced AFTER work started, so no in-run
   * replay was possible. The outer lifecycle should attempt an idle-guarded
   * repair for the NEXT run once the session returns to a non-busy state.
   */
  postWorkUnavailable: boolean;
  /** The model that was actually attempted (for exclusion in the next repair). */
  failedModel: string | null;
};

export type RecoverCodexRuntimeStreamInput = {
  /** Starts a backend run and returns its event stream (lazy). */
  run: (input: RunInput) => AsyncIterable<AgentEvent>;
  /** Run input for the first attempt; its session drives the replay. */
  runInput: RunInput;
  /** The already-created run id; the retry reuses it (no second message_run). */
  messageRunId: MessageRunId;
  sessionId: SessionId;
  /** Persisted `sessions` tuple used as the active-run mutation guard. */
  expected: SessionRuntimeConfigSnapshot;
  deps: CodexRuntimeRecoveryDeps;
  /** Populated in place so callers can drive the post-run idle repair. */
  outcome?: CodexRuntimeRecoveryOutcome;
  onExecutionConfigUpdated?: (execution: RunExecutionConfig) => void;
};

// A work signal proves the run produced a durable side effect or output, so a
// silent replay would be unsafe. `started` carries the backend thread id, i.e.
// backend session/thread creation.
const WORK_SIGNAL_KINDS = new Set<AgentEvent["kind"]>([
  "started",
  "thinking",
  "assistant_message",
  "tool_call",
  "tool_result",
  // Usage is observable backend accounting and may accompany generated
  // content even when no assistant_message was parsed. Replaying after it
  // would risk duplicate billed work.
  "usage",
]);

export type CodexRuntimeRecoveryRunOutcome =
  | { kind: "not_triggered" }
  | { kind: "retried"; failedModel: string | null }
  | { kind: "pending_next_run_repair"; failedModel: string }
  | { kind: "next_run_repaired"; failedModel: string }
  | { kind: "next_run_repair_conflict"; failedModel: string }
  | {
      kind: "next_run_repair_skipped";
      failedModel: string;
      status: Exclude<RepairNextRunResult["status"], "repaired" | "conflict">;
    };

export type CodexRuntimeRecoveryRun = {
  stream: AsyncIterable<AgentEvent>;
  repairAfterRun(): Promise<RepairNextRunResult | { status: "not_pending" }>;
  getOutcome(): CodexRuntimeRecoveryRunOutcome;
  getExecutionConfig(): RunExecutionConfig;
};

/**
 * Creates one lazy recovery controller. It starts no polling or background
 * work: the backend begins only when `stream` is consumed, and a post-work
 * mutation begins only when the outer lifecycle calls `repairAfterRun()`.
 */
export function createCodexRuntimeRecoveryRun(
  input: Omit<RecoverCodexRuntimeStreamInput, "outcome">,
): CodexRuntimeRecoveryRun {
  const streamOutcome: CodexRuntimeRecoveryOutcome = {
    retried: false,
    postWorkUnavailable: false,
    failedModel: null,
  };
  let currentExecutionConfig = input.runInput.execution ?? resolveRunExecutionConfig(input.runInput.session);
  let repairOutcome: CodexRuntimeRecoveryRunOutcome | null = null;
  let repairAttempted = false;

  return {
    stream: recoverCodexRuntimeStream({
      ...input,
      outcome: streamOutcome,
      onExecutionConfigUpdated: (execution) => {
        currentExecutionConfig = execution;
      },
    }),
    async repairAfterRun() {
      const failedModel = streamOutcome.failedModel;
      if (repairAttempted || !streamOutcome.postWorkUnavailable || !failedModel) {
        return { status: "not_pending" };
      }
      repairAttempted = true;
      const result = await repairCodexRuntimeConfigForNextRun({
        sessionId: input.sessionId,
        failedModel,
        expected: input.expected,
        deps: input.deps,
      });
      repairOutcome = result.status === "repaired"
        ? { kind: "next_run_repaired", failedModel }
        : result.status === "conflict"
          ? { kind: "next_run_repair_conflict", failedModel }
          : { kind: "next_run_repair_skipped", failedModel, status: result.status };
      return result;
    },
    getOutcome() {
      if (repairOutcome) return repairOutcome;
      if (streamOutcome.postWorkUnavailable && streamOutcome.failedModel) {
        return {
          kind: "pending_next_run_repair",
          failedModel: streamOutcome.failedModel,
        };
      }
      if (streamOutcome.retried) {
        return { kind: "retried", failedModel: streamOutcome.failedModel };
      }
      return { kind: "not_triggered" };
    },
    getExecutionConfig() {
      return currentExecutionConfig;
    },
  };
}

export function recoverCodexRuntimeStream(
  input: RecoverCodexRuntimeStreamInput,
): AsyncIterable<AgentEvent> {
  return { [Symbol.asyncIterator]: () => generate(input) };
}

async function* generate(
  input: RecoverCodexRuntimeStreamInput,
): AsyncGenerator<AgentEvent> {
  const { outcome } = input;
  let workStarted = false;
  let handledEligible = false;

  for await (const event of input.run(input.runInput)) {
    if (WORK_SIGNAL_KINDS.has(event.kind)) {
      workStarted = true;
      yield event;
      continue;
    }

    // Transient capacity error BEFORE any work: replay the EXACT same frozen
    // RunInput/model/effort once after a short bounded delay. No config
    // mutation, no availability probe, no fallback model, no loop. The second
    // attempt is a pure pass-through. Capacity after work started, or a second
    // capacity error, passes through untouched.
    const isCapacity =
      event.kind === "error" &&
      !handledEligible &&
      !workStarted &&
      (input.deps.isCapacityError?.(event.message) ?? false);
    if (isCapacity) {
      handledEligible = true;
      yield { kind: "assistant_message", text: CAPACITY_RETRY_NOTICE, final: false };
      await capacityRetryDelay(input.deps);
      for await (const retryEvent of input.run(input.runInput)) {
        yield retryEvent;
      }
      return;
    }

    const isUnavailable =
      event.kind === "error" &&
      !handledEligible &&
      input.deps.isModelUnavailable(event.message);

    if (isUnavailable && !workStarted) {
      handledEligible = true;
      let repair: RepairResult;
      try {
        if (outcome) {
          outcome.failedModel = executionModel(input.runInput.session.model, input.deps);
        }
        repair = await tryRepair(input);
      } catch {
        warnRecoveryInfrastructure(input.deps, "prepare");
        repair = { kind: "abort" };
      }
      if (repair.kind === "retry") {
        if (outcome) outcome.retried = true;
        if (repair.retryRunInput.execution) {
          input.onExecutionConfigUpdated?.(repair.retryRunInput.execution);
        }
        yield { kind: "assistant_message", text: repair.notice, final: false };
        // Second attempt is a pure pass-through: one replay only.
        for await (const retryEvent of input.run(repair.retryRunInput)) {
          yield retryEvent;
        }
        return;
      }
      // Repair impossible (no candidate / mutation rejected): surface the
      // original error and stop. No retry, no loop.
      yield event;
      return;
    }

    if (isUnavailable && workStarted) {
      // Work already happened — cannot replay. Flag for a post-run idle repair
      // of the NEXT run and let this run finish its error path.
      handledEligible = true;
      if (outcome) {
        outcome.postWorkUnavailable = true;
        outcome.failedModel = executionModel(input.runInput.session.model, input.deps);
      }
      yield event;
      continue;
    }

    yield event;
  }
}

type RepairResult =
  | { kind: "retry"; notice: string; retryRunInput: RunInput }
  | { kind: "abort" };

async function tryRepair(input: RecoverCodexRuntimeStreamInput): Promise<RepairResult> {
  const { deps } = input;
  let stage = "catalog";
  try {
    const catalog = (deps.getCatalogSnapshot ?? getCodexModelCatalogSnapshot)();
    const failedModel = executionModel(input.runInput.session.model, deps);

    stage = "probe";
    const selection = await selectFallbackModel(catalog, failedModel, deps.availability);
    if (selection.kind === "route_managed") {
      warnRouteManagedFallback(deps, selection.reason);
      return { kind: "abort" };
    }
    if (selection.kind !== "model") return { kind: "abort" };
    const fallbackModel = selection.model;

    stage = "policy";
    const current: RuntimeConfigTuple = { ...input.expected };
    const decision = resolveSessionRuntimeConfig({
      current,
      intent: { kind: "runtime-model-unavailable", fallbackModel },
      catalog,
    });
    if (decision.action === "reject") return { kind: "abort" };

    const mutation = buildMutation(input.sessionId, current, decision.after, {
      guard: { kind: "active-run", messageRunId: input.messageRunId },
      trigger: "runtime-unavailable",
      requestedModel: fallbackModel,
      decision: decision.action,
      reason: decision.reason,
      deps,
    });

    stage = "mutation";
    await deps.store.applySessionRuntimeConfigMutations([mutation]);

    // Re-read the committed tuple so the replay uses persisted state, not the
    // in-memory decision. A failed read aborts replay; the committed mutation
    // remains authoritative and no rollback is inferred.
    stage = "committed-read";
    const committed = await deps.store.findSessionById(input.sessionId);
    if (!committed || committed.backend !== "codex") return { kind: "abort" };
    const newModel = committed.model;
    const newEffort = committed.effort;
    const retryRunInput: RunInput = {
      ...input.runInput,
      session: { ...input.runInput.session, model: newModel, effort: newEffort },
      execution: resolveRunExecutionConfig({
        ...input.runInput.session,
        model: newModel,
        effort: newEffort,
      }),
    };
    const notice = formatNotice(
      failedModel,
      input.runInput.session.effort,
      executionModel(newModel, deps),
      newEffort,
    );
    return { kind: "retry", notice, retryRunInput };
  } catch {
    warnRecoveryInfrastructure(deps, stage);
    return { kind: "abort" };
  }
}

export type RepairNextRunResult = {
  status: "repaired" | "conflict" | "no_candidate" | "not_eligible" | "route_managed";
};

export type RepairCodexRuntimeConfigForNextRunInput = {
  sessionId: SessionId;
  failedModel?: string | null;
  /** Optional expected tuple; defaults to the freshly re-read session tuple. */
  expected?: SessionRuntimeConfigSnapshot;
  deps: CodexRuntimeRecoveryDeps;
};

// Post-run repair: after a run finished with a confirmed unavailable error that
// surfaced AFTER work started, mutate the config for the NEXT run using an idle
// guard. A conflicting newer tuple is left untouched (log + preserve).
export async function repairCodexRuntimeConfigForNextRun(
  input: RepairCodexRuntimeConfigForNextRunInput,
): Promise<RepairNextRunResult> {
  const { deps } = input;
  const session = await deps.store.findSessionById(input.sessionId);
  if (input.expected && session && !sameTuple(input.expected, session)) {
    deps.logger?.warn("codex runtime next-run repair conflict; preserving newer tuple", {
      stage: "expected-tuple",
    });
    return { status: "conflict" };
  }
  if (
    !session ||
    session.backend !== "codex" ||
    session.status === "busy" ||
    session.status === "deleted"
  ) {
    return { status: "not_eligible" };
  }

  const catalog = (deps.getCatalogSnapshot ?? getCodexModelCatalogSnapshot)();
  const current: RuntimeConfigTuple = {
    backend: session.backend,
    model: session.model,
    effort: session.effort,
    backendSessionId: session.backendSessionId,
  };
  const failedModel = input.failedModel?.trim() || executionModel(session.model, deps);
  const selection = await selectFallbackModel(catalog, failedModel, deps.availability);
  if (selection.kind === "route_managed") {
    warnRouteManagedFallback(deps, selection.reason);
    return { status: "route_managed" };
  }
  if (selection.kind !== "model") return { status: "no_candidate" };
  const fallbackModel = selection.model;

  const decision = resolveSessionRuntimeConfig({
    current,
    intent: { kind: "runtime-model-unavailable", fallbackModel },
    catalog,
  });
  if (decision.action === "reject") return { status: "no_candidate" };

  const mutation = buildMutation(input.sessionId, input.expected ?? current, decision.after, {
    guard: { kind: "idle" },
    trigger: "runtime-unavailable-next",
    requestedModel: fallbackModel,
    decision: decision.action,
    reason: decision.reason,
    deps,
  });

  try {
    await deps.store.applySessionRuntimeConfigMutations([mutation]);
    return { status: "repaired" };
  } catch (error) {
    if (error instanceof RuntimeConfigConflictError) {
      deps.logger?.warn("codex runtime next-run repair conflict; preserving newer tuple", {
        sessionId: input.sessionId,
      });
      return { status: "conflict" };
    }
    throw error;
  }
}

type FallbackSelection =
  | { kind: "model"; model: string }
  | { kind: "none" }
  | { kind: "route_managed"; reason: string };

async function selectFallbackModel(
  catalog: CodexModelCatalogSnapshot,
  failedModel: string,
  availability: CodexModelAvailability,
): Promise<FallbackSelection> {
  // Bounded catalog preference order, excluding the failed model. Confirmed
  // unavailable advances; transient evidence stops the repair because later
  // candidates cannot turn an uncertain probe path into a safe mutation.
  //
  // `skipped` means an sm-switch route serves the runs and does not serve that
  // candidate, so it could not be probed. Swapping a session onto a model whose
  // availability nobody measured would be a blind mutation, and the model that
  // actually serves the run is the route's anyway — so stop and report the
  // route reason instead of walking the rest of the (equally unservable)
  // catalog. Served candidates are still probed normally.
  const candidates = [catalog.defaultModel, ...catalog.models.map((entry) => entry.slug)];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate === failedModel || seen.has(candidate)) continue;
    seen.add(candidate);
    const result = await availability.probe(candidate);
    if (result.kind === "available") return { kind: "model", model: candidate };
    if (result.kind === "skipped") return { kind: "route_managed", reason: result.reason };
    if (result.kind === "transient_failure") return { kind: "none" };
  }
  return { kind: "none" };
}

function sameTuple(expected: SessionRuntimeConfigSnapshot, session: RuntimeConfigTuple): boolean {
  return expected.backend === session.backend &&
    expected.model === session.model &&
    expected.effort === session.effort &&
    expected.backendSessionId === session.backendSessionId;
}

// A model swap is impossible while a route decides the served model, and the
// caller keeps the original backend error. Say so explicitly: an unexplained
// "no fallback" is exactly the silent give-up this path had before.
function warnRouteManagedFallback(deps: CodexRuntimeRecoveryDeps, reason: string): void {
  deps.logger?.warn("codex runtime recovery skipped: model is route-managed", { reason });
}

function warnRecoveryInfrastructure(deps: CodexRuntimeRecoveryDeps, stage: string): void {
  deps.logger?.warn("codex runtime recovery infrastructure failure", {
    stage,
    error: "recovery infrastructure failure",
  });
}

type MutationSpec = {
  guard: SessionRuntimeConfigMutation["guard"];
  trigger: string;
  requestedModel: string;
  decision: string;
  reason: string;
  deps: CodexRuntimeRecoveryDeps;
};

function buildMutation(
  sessionId: SessionId,
  expected: SessionRuntimeConfigSnapshot,
  after: SessionRuntimeConfigSnapshot,
  spec: MutationSpec,
): SessionRuntimeConfigMutation {
  const { deps } = spec;
  return {
    sessionId,
    expected: { ...expected },
    after: { ...after },
    guard: spec.guard,
    audit: {
      id: deps.idFactory?.() ?? `cfg_${randomUUID()}`,
      trigger: spec.trigger,
      requested: { model: spec.requestedModel },
      decision: spec.decision,
      reason: spec.reason,
      catalogSource: (deps.getCatalogSource ?? getCodexModelCatalogSource)(),
      catalogFingerprint: (deps.getCatalogFingerprint ?? getCodexModelCatalogFingerprint)(),
      createdAt: deps.now?.() ?? asTimestamp(Date.now()),
    },
  };
}

function executionModel(model: string | null | undefined, deps: CodexRuntimeRecoveryDeps): string {
  const trimmed = model?.trim();
  if (trimmed) return trimmed;
  return deps.getCatalogSnapshot
    ? deps.getCatalogSnapshot().defaultModel
    : getCodexDefaultModel();
}

function formatNotice(
  oldModel: string,
  oldEffort: EffortLevel | null,
  newModel: string,
  newEffort: EffortLevel | null,
): string {
  const from = `${oldModel} (${oldEffort ?? "default"})`;
  const to = `${newModel} (${newEffort ?? "default"})`;
  return `⚠️ codex 模型 ${oldModel} 当前不可用，已自动切换：${from} → ${to}`;
}
