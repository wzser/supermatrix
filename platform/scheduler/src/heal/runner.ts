import type { TaskStore } from "../db/taskStore.js";
import type { Idempotency } from "../classes/types.js";
import type { HealStore } from "./store.js";
import type { RateLimitStore } from "./rateLimitStore.js";
import type { NotifyParams } from "../notify/console.js";
import type { InboxPredicate } from "../spawn/predicate.js";
import { inboxPredicate, DECISION_TOKENS } from "../spawn/predicate.js";
import { renderProposalText } from "./proposalText.js";
import { renderHealCard, isTaskRetired } from "./cardFormat.js";
import {
  detectAnthropicRateLimit,
  extractRateLimitSnippet,
  RATE_LIMIT_QUIET_WINDOW_MS,
  RATE_LIMIT_SCOPE,
} from "./rateLimit.js";

export type SpawnParams = {
  target: string;
  from: string;
  prompt: string;
  verification_predicate: InboxPredicate;
};

export type SpawnResult =
  | { ok: true; childSessionId: string }
  | { ok: false; status?: number; error?: string };

/**
 * Map a raw /api/spawn HTTP response to a SpawnResult. The 2026-05-18 redesign
 * added a third possibility: `HTTP 200 + {ok:false, status:"switched_async"}`
 * means the framework took the spawn and handed it to the watcher — that is a
 * success, not a failure, and the response's `ref` becomes the correlation id.
 */
export function parseSpawnResponse(httpStatus: number, body: unknown): SpawnResult {
  if (httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, status: httpStatus };
  }
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (obj.ok === false && obj.status === "switched_async" && typeof obj.ref === "string") {
      return { ok: true, childSessionId: obj.ref };
    }
    if (typeof obj.childSessionId === "string" && obj.childSessionId.length > 0) {
      return { ok: true, childSessionId: obj.childSessionId };
    }
  }
  return { ok: false, error: "no childSessionId" };
}

export type HealRunnerDeps = {
  taskStore: TaskStore;
  healStore: HealStore;
  spawnFn: (params: SpawnParams) => Promise<SpawnResult>;
  notifyConsole: (params: NotifyParams) => Promise<void>;
  sendUserDm: (text: string) => Promise<void>;
  retryTaskFn: (taskId: string) => Promise<void>;
  rateLimitStore?: RateLimitStore;
  clock?: () => number;
};

export type HealParams = {
  taskId: string;
  runId: string;
  taskName: string;
  ownerSession: string;
  idempotency: Idempotency;
  triggeredAt: number;
  evidence: Record<string, unknown>;
  verifyAttempts: number;
};

export function createHealRunner(deps: HealRunnerDeps) {
  const now = () => (deps.clock ?? Date.now)();

  return {
    async runHeal(p: HealParams): Promise<void> {
      // Anthropic rate-limit short-circuit. The framework's spawn-closure
      // watcher treats every failed comm as an attempt; if heal blindly
      // retries / spawns proposals while Claude Opus is rate-limiting our
      // children, each cycle generates fresh failed comms and SK gets
      // false-alarm escalations. So: detect the signature in evidence and
      // open a 60-min quiet window; suppress all heal action inside the
      // window. The next cron tick after the window will produce the retry
      // naturally.
      if (deps.rateLimitStore) {
        if (detectAnthropicRateLimit(p.evidence)) {
          const t = now();
          deps.rateLimitStore.recordHit({
            scope: RATE_LIMIT_SCOPE,
            detectedAt: t,
            quietUntil: t + RATE_LIMIT_QUIET_WINDOW_MS,
            sourceTaskId: p.taskId,
            sourceRunId: p.runId,
            sourceSnippet: extractRateLimitSnippet(p.evidence),
          });
          console.warn(
            `heal suppressed: Anthropic rate-limit detected on task ${p.taskName} (run=${p.runId}); quiet window 60min`,
          );
          return;
        }
        const quietUntil = deps.rateLimitStore.getQuietUntil(RATE_LIMIT_SCOPE);
        if (quietUntil !== null && now() < quietUntil) {
          console.warn(
            `heal suppressed: Anthropic rate-limit quiet window active until ${new Date(quietUntil).toISOString()} (task=${p.taskName} run=${p.runId})`,
          );
          return;
        }
      }

      // Step 1: pure idempotency → one auto-retry.
      if (p.idempotency === "pure") {
        try {
          await deps.retryTaskFn(p.taskId);
        } catch (err) {
          console.error(`heal Step 1 retry failed for task ${p.taskId}:`, err);
        }
        return;
      }

      // Step 2 / 3: spawn proposal to owner, fall back to userDM on failure.
      const prompt = renderProposalText({
        taskName: p.taskName,
        runId: p.runId,
        reason: "evidence_missing",
        triggeredAt: p.triggeredAt,
        evidence: p.evidence,
        idempotency: p.idempotency,
      });

      let result: SpawnResult;
      try {
        result = await deps.spawnFn({
          target: p.ownerSession,
          from: "scheduler",
          prompt,
          verification_predicate: inboxPredicate({
            sessionName: p.ownerSession,
            tokens: DECISION_TOKENS,
          }),
        });
      } catch (err) {
        // Transient: record pending_retry, do not userDM yet.
        const proposal = deps.healStore.scheduleProposal({
          taskId: p.taskId,
          runId: p.runId,
          reason: "evidence_missing",
          spawnedAt: now(),
          childSessionId: null,
        });
        deps.healStore.markPendingRetry(proposal.id);
        console.error(`heal Step 2 spawn transient error for task ${p.taskId}:`, err);
        return;
      }

      if (result.ok) {
        deps.healStore.scheduleProposal({
          taskId: p.taskId,
          runId: p.runId,
          reason: "evidence_missing",
          spawnedAt: now(),
          childSessionId: result.childSessionId,
        });
        return;
      }

      const ownerStatus = result.status ?? "err";

      // Under the 2026-05-19 strict spawn contract the platform 400s on a much
      // wider surface (missing `from`, residual `mode`, malformed delivery_checks,
      // short transient hiccups). Only a hard 404 means "owner session does not
      // exist" — that one stays terminal. Everything else routes to pending_retry
      // so the heal tick can redrive (capped by MAX_SPAWN_RETRIES) before any
      // notification fires.
      if (ownerStatus !== 404) {
        const retryProposal = deps.healStore.scheduleProposal({
          taskId: p.taskId,
          runId: p.runId,
          reason: "evidence_missing",
          spawnedAt: now(),
          childSessionId: null,
        });
        deps.healStore.markPendingRetry(retryProposal.id);
        console.warn(
          `heal Step 2 spawn non-2xx for task ${p.taskId} (status=${ownerStatus}); pending_retry`,
        );
        return;
      }

      // Step 3: owner truly unreachable (404). Record audit + Console card.
      const proposal = deps.healStore.scheduleProposal({
        taskId: p.taskId,
        runId: p.runId,
        reason: "evidence_missing",
        spawnedAt: now(),
        childSessionId: null,
      });
      deps.healStore.markDefaultApplied(proposal.id, "SKIP", now());

      // Skip the card entirely if the task is already retired — disabled by the
      // owner or in a retirement category. Same noise-suppression rule the
      // disabledWarning nag uses.
      const task = deps.taskStore.getTask(p.taskId);
      if (!task || isTaskRetired(task)) {
        console.warn(
          `heal Step 3 skipping card for retired task ${p.taskId} (enabled=${task?.enabled ?? "?"}, category=${task?.category ?? "?"})`,
        );
        return;
      }

      const cardBody = renderHealCard({
        taskId: p.taskId,
        taskName: p.taskName,
        taskDescription: task.description ?? "",
        ownerSession: p.ownerSession,
        triggeredAt: p.triggeredAt,
        reason: "evidence_missing",
        evidence: p.evidence,
        // Step 1 already returned for pure idempotency, so the only paths
        // reaching Step 3 are non/conditional — default is SKIP.
        defaultAction: "SKIP",
        scenario: "owner_unreachable",
        ownerStatus,
      });
      try {
        await deps.notifyConsole({
          title: `heal proposal needs attention: ${p.taskName}`,
          body: cardBody,
          level: "warn",
          metadata: {
            event: "heal_owner_unreachable",
            taskId: p.taskId,
            taskName: p.taskName,
            runId: p.runId,
            anomaly: "evidence_missing",
            triggeredAt: new Date(p.triggeredAt).toISOString(),
            evidence: p.evidence,
            ownerSession: p.ownerSession,
            ownerStatus,
            idempotency: p.idempotency,
            actions: ["RETRY", "SKIP", "DISABLE", "ADJUST"],
            defaultAction: "SKIP",
            patchHint:
              'reply with `ACTION: ADJUST` + `PATCH: { "expectedDurationMs": ..., "overrides": {...}, "cron": "..." }`',
          },
        });
      } catch (cardErr) {
        console.error(`heal Step 3 console card failed for task ${p.taskId}:`, cardErr);
        // Last-resort short diagnostic — do NOT re-send the full proposal body as text.
        try {
          await deps.sendUserDm(
            `[scheduler] heal proposal card-send failed; task=${p.taskName} run=${p.runId} owner=${p.ownerSession} unreachable(status=${ownerStatus}). See scheduler logs.`,
          );
        } catch (err) {
          console.error(`heal Step 3 diagnostic userDm also failed for task ${p.taskId}:`, err);
        }
      }
    },
  };
}
