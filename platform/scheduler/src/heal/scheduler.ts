import type { TaskStore } from "../db/taskStore.js";
import type { HealStore } from "./store.js";
import type { RateLimitStore } from "./rateLimitStore.js";
import type { HealAction, HealProposal } from "./types.js";
import type { NotifyParams } from "../notify/console.js";
import { parseHealReply } from "./replyParser.js";
import { parseHealPatch } from "./patchParser.js";
import { renderHealCard, isTaskRetired } from "./cardFormat.js";
import { inboxPredicate, DECISION_TOKENS } from "../spawn/predicate.js";
import {
  detectAnthropicRateLimit,
  extractRateLimitSnippet,
  RATE_LIMIT_QUIET_WINDOW_MS,
  RATE_LIMIT_SCOPE,
} from "./rateLimit.js";

const TWENTY_FOUR_HOURS = 24 * 3600_000;
const MAX_SPAWN_RETRIES = 3;

export type HealTickDeps = {
  healStore: HealStore;
  taskStore: TaskStore;
  smBaseUrl: string;
  fetchImpl?: typeof fetch;
  retryTaskFn: (taskId: string) => Promise<void>;
  notifyConsole: (params: NotifyParams) => Promise<void>;
  sendUserDm: (text: string) => Promise<void>;
  spawnFn: (params: {
    target: string;
    from: string;
    prompt: string;
    verification_predicate: Record<string, unknown>;
  }) => Promise<{ ok: true; childSessionId: string } | { ok: false; status?: number; error?: string }>;
  rateLimitStore?: RateLimitStore;
  clock?: () => number;
};

export async function runHealTick(deps: HealTickDeps): Promise<void> {
  const now = (deps.clock ?? Date.now)();
  await processPending(deps, now);
  await processPendingRetry(deps, now);
}

async function processPending(deps: HealTickDeps, now: number): Promise<void> {
  const fetchFn = deps.fetchImpl ?? fetch;
  for (const p of deps.healStore.listPending()) {
    if (!p.childSessionId) continue;

    const url = `${deps.smBaseUrl}/api/sessions/${p.childSessionId}/result`;
    let res: Response;
    try {
      res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
    } catch {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        await applyTimeout(deps, p, now);
      }
      continue;
    }

    if (res.status === 202) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        await applyTimeout(deps, p, now);
      }
      continue;
    }

    if (res.status >= 500) {
      await applyTimeout(deps, p, now);
      continue;
    }

    if (!res.ok) continue;

    let body: { status?: string; finalMessage?: string | null; errorMessage?: string | null };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      continue;
    }
    if (body.status === "running") {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        await applyTimeout(deps, p, now);
      }
      continue;
    }
    if (body.status === "failed" || body.status === "timeout") {
      // If the polled child died because Anthropic rate-limited it, do NOT
      // applyTimeout (which would burn the default action and spam a Console
      // card). Open the quiet window and leave the proposal pending — the
      // spawnedAt+24h ceiling in this branch still kicks in eventually if the
      // child genuinely never recovers, so we don't lose the safety net.
      if (deps.rateLimitStore && detectAnthropicRateLimit({ errorMessage: body.errorMessage, finalMessage: body.finalMessage })) {
        deps.rateLimitStore.recordHit({
          scope: RATE_LIMIT_SCOPE,
          detectedAt: now,
          quietUntil: now + RATE_LIMIT_QUIET_WINDOW_MS,
          sourceTaskId: p.taskId,
          sourceRunId: p.runId,
          sourceSnippet: extractRateLimitSnippet({ errorMessage: body.errorMessage, finalMessage: body.finalMessage }),
        });
        console.warn(
          `heal tick: child ${p.childSessionId} failed with Anthropic rate-limit; quiet window 60min, proposal ${p.id} stays pending`,
        );
        continue;
      }
      await applyTimeout(deps, p, now);
      continue;
    }
    const finalMessage = typeof body.finalMessage === "string" ? body.finalMessage : "";
    if (!finalMessage) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        await applyTimeout(deps, p, now);
      }
      continue;
    }
    const action = parseHealReply(finalMessage);
    if (!action) {
      if (now - p.spawnedAt > TWENTY_FOUR_HOURS) {
        await applyTimeout(deps, p, now);
      }
      continue;
    }

    deps.healStore.markReplied(p.id, action, finalMessage, now);
    await applyAction(deps, p, action, finalMessage);
  }
}

async function processPendingRetry(deps: HealTickDeps, now: number): Promise<void> {
  // Don't burn pending_retry attempts while Anthropic is rate-limiting us —
  // each re-spawn that hits the limit just generates another failed comm.
  // Skip this tick entirely; the next tick after window-expiry will pick up.
  if (deps.rateLimitStore) {
    const quietUntil = deps.rateLimitStore.getQuietUntil(RATE_LIMIT_SCOPE);
    if (quietUntil !== null && now < quietUntil) {
      return;
    }
  }
  for (const p of deps.healStore.listPendingRetry()) {
    if (p.spawnRetryCount >= MAX_SPAWN_RETRIES) {
      await applyTimeout(deps, p, now);
      continue;
    }
    const task = deps.taskStore.getTask(p.taskId);
    if (!task || !task.ownerSession) continue;
    const prompt = `retry of heal proposal for task=${task.name} run=${p.runId} (retry#${p.spawnRetryCount + 1})`;

    let result;
    try {
      result = await deps.spawnFn({
        target: task.ownerSession,
        from: "scheduler",
        prompt,
        verification_predicate: inboxPredicate({
          sessionName: task.ownerSession,
          tokens: DECISION_TOKENS,
        }),
      });
    } catch {
      deps.healStore.markPendingRetry(p.id);
      continue;
    }

    if (result.ok) {
      deps.healStore.promoteToPending(p.id, result.childSessionId);
    } else {
      deps.healStore.markPendingRetry(p.id);
    }
  }
}

async function applyAction(deps: HealTickDeps, p: HealProposal, action: HealAction, replyText: string): Promise<void> {
  if (action === "RETRY") {
    try {
      await deps.retryTaskFn(p.taskId);
    } catch (err) {
      console.error(`heal apply RETRY failed for task ${p.taskId}:`, err);
    }
    return;
  }
  if (action === "DISABLE") {
    try {
      deps.taskStore.updateTask(p.taskId, { enabled: false });
    } catch (err) {
      console.error(`heal apply DISABLE failed for task ${p.taskId}:`, err);
    }
    return;
  }
  if (action === "SKIP" || action === "REJECT") {
    return;
  }
  if (action === "ADJUST") {
    const task = deps.taskStore.getTask(p.taskId);

    const patch = parseHealPatch(replyText);
    if (patch && task) {
      try {
        deps.taskStore.updateTask(p.taskId, patch);
        try {
          await deps.retryTaskFn(p.taskId);
        } catch (err) {
          console.error(`heal ADJUST retry-after-patch failed for task ${p.taskId}:`, err);
        }
        return;
      } catch (err) {
        console.error(`heal ADJUST patch apply failed for task ${p.taskId}:`, err);
      }
    }

    if (task && task.updatedAt > p.spawnedAt) {
      console.log(`heal ADJUST proposal ${p.id}: task ${task.name} updated_at=${task.updatedAt} > spawned_at=${p.spawnedAt}, owner self-modified — skipping userDM`);
      return;
    }

    const text = `owner replied ACTION: ADJUST on task ${task?.name ?? p.taskId}. Please coordinate the adjustment (expectedDuration / receiptProof / overrides).`;
    try {
      await deps.sendUserDm(text);
    } catch (err) {
      console.error(`heal apply ADJUST userDM failed for task ${p.taskId}:`, err);
    }
    return;
  }
}

async function applyTimeout(deps: HealTickDeps, p: HealProposal, now: number): Promise<void> {
  const task = deps.taskStore.getTask(p.taskId);
  if (!task) {
    deps.healStore.markDefaultApplied(p.id, "SKIP", now);
    return;
  }
  const defaultAction: HealAction = task.class === "sync_job" ? "RETRY" : "SKIP";
  deps.healStore.markDefaultApplied(p.id, defaultAction, now);
  if (defaultAction === "RETRY") {
    try {
      await deps.retryTaskFn(task.id);
    } catch (err) {
      console.error(`heal timeout RETRY failed for task ${task.id}:`, err);
    }
  } else {
    // Skip the card if the task is already retired (disabled or in a
    // retirement category) — same noise-suppression rule as Step 3 of runner.
    if (isTaskRetired(task)) {
      console.warn(
        `heal timeout skipping card for retired task ${task.id} (enabled=${task.enabled}, category=${task.category ?? "?"})`,
      );
      return;
    }
    const run = deps.taskStore.getRun(p.runId);
    const triggeredAt = run?.triggeredAt ?? p.spawnedAt;
    const evidence = (run?.receiptEvidence as Record<string, unknown> | null) ?? {};
    try {
      await deps.notifyConsole({
        title: `heal proposal timed out: ${task.name}`,
        body: renderHealCard({
          taskId: task.id,
          taskName: task.name,
          taskDescription: task.description ?? "",
          ownerSession: task.ownerSession ?? "(none)",
          triggeredAt,
          reason: p.reason,
          evidence,
          defaultAction,
          scenario: "timeout",
          spawnRetryCount: p.spawnRetryCount,
        }),
        level: "warn",
        metadata: {
          event: "heal_proposal_timeout",
          taskId: task.id,
          taskName: task.name,
          runId: p.runId,
          anomaly: p.reason,
          spawnedAt: new Date(p.spawnedAt).toISOString(),
          ownerSession: task.ownerSession ?? null,
          defaultApplied: defaultAction,
          spawnRetryCount: p.spawnRetryCount,
        },
      });
    } catch (cardErr) {
      console.error(`heal timeout console card failed for task ${task.id}:`, cardErr);
      try {
        await deps.sendUserDm(
          `[scheduler] heal proposal card-send failed; task=${task.name} run=${p.runId} heal-timeout default=${defaultAction}. See scheduler logs.`,
        );
      } catch (err) {
        console.error(`heal timeout diagnostic userDm also failed for task ${task.id}:`, err);
      }
    }
  }
}
