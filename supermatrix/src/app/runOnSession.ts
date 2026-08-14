import { isThinkingBlockResumeError } from "../domain/backendResumeErrors.ts";
import type { SessionEvent } from "../domain/events/sessionEvent.ts";
import {
  asMessageRunId,
  type LarkGroupId,
  type MessageRunId,
  type SessionId,
} from "../domain/ids.ts";
import type { Session } from "../domain/session.ts";
import { MAIN_BRANCH_NAME } from "../domain/sessionBranch.ts";
import type { BackendRegistry } from "../ports/AgentBackend.ts";
import type { BindingStore, RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Logger } from "../ports/Logger.ts";
import { errorMessage } from "./errorMessage.ts";
import { classifyRunStatus } from "./runStatus.ts";
import { collectStream } from "./streamCollector.ts";
import {
  createCodexRuntimeRecoveryRun,
  type CodexRuntimeRecoveryDeps,
  type CodexRuntimeRecoveryRun,
} from "./codexRuntimeRecovery.ts";
import { recoverRepeatedCodexResume } from "./codexResumeRecovery.ts";
import { recoverKimiResumeStream } from "./kimiResumeRecovery.ts";

// runOnSession: drive a prompt on an EXISTING user-scope session, resuming
// its main backend_session_id. Mirrors dispatcher.handleInbound's run loop
// but skips the chat-coupled bits (Lark card postCard/updateCard, slash
// command routing, attachment ingestion). Used by POST /api/run so a
// sibling session can ask, e.g., amzdata to follow up in its own context
// without polluting amzdata's chat with a synthetic --as-user message.
//
// Status semantics intentionally mirror an in-chat user prompt:
//   idle → busy → idle, message_runs row, cross_session_log if requested.
// Concurrent runs are rejected (kind="busy") rather than queued — API
// callers handle 409 retry; chat queueing via PendingNext stays a chat-only
// concern.

export type RunOnSessionDeps = {
  store: BindingStore;
  backendRegistry: BackendRegistry;
  clock: Clock;
  idFactory: () => string;
  eventBus?: EventBus;
  logger?: Logger;
  monotonic?: () => number;
  codexRuntimeRecovery?: Omit<CodexRuntimeRecoveryDeps, "store" | "logger">;
};

export type RunOnSessionInput = {
  session: Session;
  prompt: string;
  groupId: LarkGroupId;
  requesterSessionId?: SessionId;
};

export type RunOnSessionResult =
  | {
      kind: "ok";
      runId: MessageRunId;
      finalMessage: string;
      backendSessionId: string | null;
      runStatus: RunStatus;
    }
  | {
      kind: "error";
      runId: MessageRunId;
      finalMessage: string;
      error: string;
      runStatus: RunStatus;
    }
  | { kind: "maintenance"; backend: "claude" | "codex" | "kimi"; leaseOwner: string }
  | { kind: "busy"; currentRunId: MessageRunId | null };

export async function runOnSession(
  deps: RunOnSessionDeps,
  input: RunOnSessionInput,
): Promise<RunOnSessionResult> {
  const { store, backendRegistry, clock, idFactory } = deps;
  let session = input.session;
  const log = deps.logger?.child({ mod: "runOnSession" });
  const monotonic = deps.monotonic ?? (() => Date.now());

  // Busy gate — refuse rather than queue. PendingNext is chat-only, where
  // overwriting a stale queued entry is fine; API callers want explicit
  // 409 so they can decide whether to retry.
  if (session.status === "busy") {
    const running = await store.findRunningMessageRunBySession(session.id);
    return { kind: "busy", currentRunId: running?.id ?? null };
  }
  const lingering = await store.findRunningMessageRunBySession(session.id);
  if (lingering) {
    return { kind: "busy", currentRunId: lingering.id };
  }

  const emit = (event: SessionEvent) =>
    deps.eventBus ? deps.eventBus.publish(event) : Promise.resolve();

  // Open cross-session log if a requester was supplied.
  const commId = input.requesterSessionId
    ? `comm_run_${session.id.slice(-8)}_${Date.now()}`
    : null;
  if (commId && input.requesterSessionId) {
    await store.logCrossSessionComm({
      id: commId,
      fromSessionId: input.requesterSessionId,
      toSessionId: session.id,
      kind: "resume_main",
      prompt: input.prompt,
      childModel: session.model,
      createdAt: clock.now(),
    });
  }

  const runId = asMessageRunId(idFactory());
  const admission = await store.admitMessageRun({
    id: runId,
    sessionId: session.id,
    groupId: input.groupId,
    prompt: input.prompt,
    startedAt: clock.now(),
  });
  if (admission.kind === "maintenance") {
    if (commId) {
      await store.finishCrossSessionComm(
        commId,
        "failed",
        undefined,
        undefined,
        `${admission.backend} backend maintenance lease active`,
      );
    }
    return { kind: "maintenance", backend: admission.backend, leaseOwner: admission.lease.owner };
  }
  if (admission.kind === "busy") {
    if (commId) {
      await store.finishCrossSessionComm(
        commId,
        "failed",
        undefined,
        undefined,
        "target busy during atomic run admission",
      );
    }
    return { kind: "busy", currentRunId: admission.currentRunId };
  }
  if (admission.kind === "not_admittable") {
    if (commId) {
      await store.finishCrossSessionComm(
        commId,
        "failed",
        undefined,
        undefined,
        `target not admittable during atomic run admission: ${admission.status ?? "missing"}`,
      );
    }
    return { kind: "busy", currentRunId: null };
  }
  // The lease check and this snapshot came from one SQLite transaction. Do
  // not launch using the caller's pre-admission session tuple: a concurrent
  // backend change must not turn a permitted non-Claude admission into a
  // fenced Claude process (or vice versa).
  session = { ...session, ...admission.runtimeConfig, status: "busy" };
  await emit({
    kind: "session_status_changed",
    sessionId: session.id,
    from: admission.previousStatus,
    to: "busy",
  });
  log?.info("run started", {
    runId,
    sessionId: session.id,
    sessionName: session.name,
    backend: session.backend,
    resume: session.backendSessionId ?? null,
    requestedBy: input.requesterSessionId ?? null,
  });
  const runStartedAtMs = monotonic();
  let recovery: CodexRuntimeRecoveryRun | null = null;
  let recoveryFinalized = false;
  const finalizeRecovery = async () => {
    if (!recovery || recoveryFinalized) return;
    recoveryFinalized = true;
    try {
      await recovery.repairAfterRun();
      log?.info("codex runtime recovery outcome", { outcome: recovery.getOutcome().kind });
    } catch {
      log?.warn("codex runtime recovery finalization failed", { outcome: recovery.getOutcome().kind });
    }
  };

  const concludeIdle = async (wasCleared: boolean) => {
    if (wasCleared) return;
    await store.updateSessionStatus(session.id, "idle", clock.now());
    await emit({
      kind: "session_status_changed",
      sessionId: session.id,
      from: "busy",
      to: "idle",
    });
  };
  const drainPendingRuntimeConfig = async () => {
    const result = await store.drainPendingSessionRuntimeConfig(session.id);
    if (result.kind === "rejected") {
      log?.warn("pending runtime config rejected", { sessionId: session.id, reason: result.reason });
    }
  };

  try {
    const usageBaseline =
      session.backend === "codex"
        ? await store.getLatestTokenUsageRawTotals(session.id)
        : null;
    const runInput = {
      messageRunId: runId,
      session,
      prompt: input.prompt,
      attachments: [],
    };
    const backend = backendRegistry.get(session.backend);
    const stream = session.backend === "codex" && deps.codexRuntimeRecovery
      ? (recovery = createCodexRuntimeRecoveryRun({
          run: (retryInput) => backend.run(retryInput),
          runInput,
          messageRunId: runId,
          sessionId: session.id,
          expected: {
            backend: session.backend,
            model: session.model,
            effort: session.effort,
            backendSessionId: session.backendSessionId,
          },
          deps: {
            store,
            ...deps.codexRuntimeRecovery,
            ...(log ? { logger: log } : {}),
          },
        })).stream
      : session.backend === "kimi" && session.backendSessionId
        ? recoverKimiResumeStream({
            run: (retryInput) => backend.run(retryInput),
            runInput,
            persistedBackendSessionId: session.backendSessionId,
            clearPersisted: () => store.updateSessionBackendSessionId(session.id, null),
            ...(log ? { logger: log } : {}),
          })
        : backend.run(runInput);
    const collected = await collectStream(stream, {
      ...(usageBaseline
        ? { usageBaseline, normalizeCumulativeUsage: true }
        : {}),
    });

    // Re-read so a /restart or /reset that landed mid-run isn't clobbered
    // (mirrors dispatcher.handleInbound's wasCleared check).
    const afterRun = await store.findSessionById(session.id);
    const wasCleared =
      afterRun?.backendSessionId === null && afterRun?.status === "idle";

    // A resumed Claude session that dies on a thinking-block 400 leaves its
    // persisted backendSessionId pointing at a poisoned transcript. Re-persisting
    // it re-poisons the next resume; null it so the next run starts fresh.
    const clearPoisonedClaudeResume =
      session.backend === "claude" &&
      Boolean(session.backendSessionId) &&
      isThinkingBlockResumeError(collected.error);
    if (clearPoisonedClaudeResume && !wasCleared) {
      await store.updateSessionBackendSessionId(session.id, null);
    } else if (collected.backendSessionId && !wasCleared) {
      await store.updateSessionBackendSessionId(
        session.id,
        collected.backendSessionId,
      );
    }
    if (collected.usage && !wasCleared) {
      await store.recordTokenUsage({
        sessionId: session.id,
        messageRunId: runId,
        backend: session.backend,
        model: collected.usage.model ?? session.model ?? null,
        inputTokens: collected.usage.inputTokens,
        outputTokens: collected.usage.outputTokens,
        cacheReadTokens: collected.usage.cacheReadTokens,
        cacheWriteTokens: collected.usage.cacheWriteTokens,
        reasoningTokens: collected.usage.reasoningTokens,
        rawUsageJson: collected.usage.rawUsageJson,
        createdAt: clock.now(),
      });
    }

    const streamLogJson =
      collected.streamLog && collected.streamLog.length > 0
        ? JSON.stringify(collected.streamLog)
        : undefined;
    const runStatus = classifyRunStatus(collected.error);

    if (collected.error) {
      await store.finishMessageRun(
        runId,
        runStatus,
        collected.finalMessage,
        collected.error,
        streamLogJson,
      );
      const codexResumeRecovery = await recoverRepeatedCodexResume({
        store,
        sessionId: session.id,
        branchName: MAIN_BRANCH_NAME,
        backend: session.backend,
        persistedBackendSessionId: session.backendSessionId,
        failedRunId: runId,
        error: collected.error,
        now: clock.now(),
        ...(deps.codexRuntimeRecovery?.backupBeforeResumeClear
          ? { backup: deps.codexRuntimeRecovery.backupBeforeResumeClear }
          : {}),
      });
      if (codexResumeRecovery.status === "cleared") {
        log?.warn("cleared repeated poisoned Codex resume after verified DB backup", {
          runId,
          sessionId: session.id,
          snapshotPath: codexResumeRecovery.snapshotPath,
          receiptPath: codexResumeRecovery.receiptPath,
          readBackBackendSessionId: null,
        });
      } else if (codexResumeRecovery.status === "backup_failed" || codexResumeRecovery.status === "clear_failed") {
        log?.error("Codex poisoned-resume recovery did not clear the pointer", {
          runId,
          sessionId: session.id,
          status: codexResumeRecovery.status,
          error: codexResumeRecovery.error instanceof Error
            ? codexResumeRecovery.error.message
            : String(codexResumeRecovery.error),
          ...(codexResumeRecovery.status === "clear_failed"
            ? {
                snapshotPath: codexResumeRecovery.snapshotPath,
                receiptPath: codexResumeRecovery.receiptPath,
              }
            : {}),
        });
      }
      if (commId) {
        await store.finishCrossSessionComm(
          commId,
          "failed",
          undefined,
          collected.finalMessage
            ? collected.finalMessage.slice(0, 500)
            : undefined,
          collected.error,
          collected.finalMessage || undefined,
          runId,
        );
      }
      await concludeIdle(wasCleared);
      await drainPendingRuntimeConfig();
      await finalizeRecovery();
      log?.warn("run finished with error", {
        runId,
        sessionId: session.id,
        durationMs: monotonic() - runStartedAtMs,
        error: collected.error,
        cleared: wasCleared,
      });
      return {
        kind: "error",
        runId,
        finalMessage: collected.finalMessage,
        error: collected.error,
        runStatus,
      };
    }

    await store.finishMessageRun(
      runId,
      "completed",
      collected.finalMessage,
      undefined,
      streamLogJson,
    );
    if (commId) {
      const preview =
        collected.finalMessage.length > 500
          ? collected.finalMessage.slice(0, 500) + "..."
          : collected.finalMessage;
      await store.finishCrossSessionComm(
        commId,
        "completed",
        undefined,
        preview,
        undefined,
        collected.finalMessage,
        runId,
      );
    }
    await concludeIdle(wasCleared);
    await drainPendingRuntimeConfig();
    await finalizeRecovery();
    log?.info("run completed", {
      runId,
      sessionId: session.id,
      durationMs: monotonic() - runStartedAtMs,
      backendSessionId: collected.backendSessionId ?? null,
      finalLength: collected.finalMessage.length,
      cleared: wasCleared,
    });
    return {
      kind: "ok",
      runId,
      finalMessage: collected.finalMessage,
      backendSessionId: collected.backendSessionId,
      runStatus: "completed",
    };
  } catch (err) {
    const errMsg = errorMessage(err);
    const runStatus = classifyRunStatus(errMsg);
    try {
      await store.finishMessageRun(runId, runStatus, undefined, errMsg);
    } catch {
      // best-effort — store may be closing during shutdown
    }
    if (commId) {
      try {
        await store.finishCrossSessionComm(
          commId,
          "failed",
          undefined,
          undefined,
          errMsg,
          undefined,
          runId,
        );
      } catch {
        // best-effort
      }
    }
    try {
      await store.updateSessionStatus(session.id, "idle", clock.now());
      await emit({
        kind: "session_status_changed",
        sessionId: session.id,
        from: "busy",
        to: "idle",
      });
    } catch {
      // best-effort
    }
    try {
      await drainPendingRuntimeConfig();
    } catch {
      // best-effort — the pending row remains durable for boot recovery
    }
    await finalizeRecovery();
    log?.error("run threw", {
      runId,
      sessionId: session.id,
      durationMs: monotonic() - runStartedAtMs,
      error: errMsg,
    });
    return { kind: "error", runId, finalMessage: "", error: errMsg, runStatus };
  }
}
