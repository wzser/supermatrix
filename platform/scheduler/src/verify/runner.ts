import type { TaskStore, Task, TaskRun } from "../db/taskStore.js";
import type { DimensionValues, Idempotency, NotifyEvent, NotifyRule } from "../classes/types.js";
import { resolveOverrides } from "../classes/resolveOverrides.js";
import type { NotifyContext } from "../notify/v2/types.js";
import { evaluateProof } from "../receiptProofs/registry.js";
import type { VerifyStore } from "./store.js";
import { computeGraceAction } from "./grace.js";

export type HealArgs = {
  taskId: string;
  runId: string;
  taskName: string;
  ownerSession: string;
  idempotency: Idempotency;
  triggeredAt: number;
  evidence: Record<string, unknown>;
  verifyAttempts: number;
};

export type VerifyDeps = {
  taskStore: TaskStore;
  verifyStore: VerifyStore;
  lookupExitContext: (runId: string) => {
    exitCode?: number | null;
    httpStatus?: number;
    sessionReply?: unknown;
    childSessionId?: string | null;
    asyncRef?: string | null;
    smBaseUrl?: string;
    fetchImpl?: typeof fetch;
  };
  notify?: (rule: NotifyRule, ctx: NotifyContext) => Promise<void>;
  heal?: (args: HealArgs) => Promise<void>;
  syncTask?: (task: Task, latestRun?: TaskRun) => Promise<void>;
  unregisterCron?: (taskId: string) => void;
};

export async function runVerification(verificationId: string, deps: VerifyDeps): Promise<void> {
  const verification = deps.verifyStore.getVerification(verificationId);
  if (!verification || verification.status !== "pending") return;

  const run = deps.taskStore.getRun(verification.runId);
  if (!run) {
    deps.verifyStore.finalizeVerification(verificationId);
    return;
  }

  if (run.finalStatus !== "pending") {
    deps.verifyStore.finalizeVerification(verificationId);
    return;
  }

  const task = deps.taskStore.getTask(run.taskId);
  if (!task || task.class === null) {
    deps.verifyStore.finalizeVerification(verificationId);
    return;
  }

  const effective: DimensionValues = resolveOverrides(
    task.class,
    task.overrides as Partial<DimensionValues> | null
  );

  const exitCtx = deps.lookupExitContext(run.id);
  const proof = await evaluateProof(effective.receiptProof, {
    exitCode: exitCtx.exitCode,
    httpStatus: exitCtx.httpStatus,
    sessionReply: exitCtx.sessionReply,
    childSessionId: exitCtx.childSessionId,
    asyncRef: exitCtx.asyncRef,
    smBaseUrl: exitCtx.smBaseUrl,
    fetchImpl: exitCtx.fetchImpl,
    taskId: task.id,
    runId: run.id,
    triggeredAt: run.triggeredAt ?? 0,
  });

  const now = Date.now();
  const action = computeGraceAction(proof, verification.attempts, now);

  if (action.kind === "finalize_success") {
    deps.taskStore.updateRunVerify(run.id, {
      verifyStatus: "pass",
      receiptEvidence: proof.evidence,
    });
    deps.taskStore.updateRunFinal(run.id, "success", now);
    deps.verifyStore.finalizeVerification(verificationId);
    if (task.oneshot) {
      deps.taskStore.updateTask(task.id, { enabled: false });
      try {
        deps.unregisterCron?.(task.id);
      } catch (err) {
        console.error(`unregisterCron failed for oneshot task ${task.id}:`, err);
      }
    } else {
      deps.taskStore.refreshNextRun(task.id);
    }
    await fireNotify(deps, effective, "succeeded", task, run, "task completed successfully");
    if (deps.syncTask) {
      const reloaded = deps.taskStore.getTask(run.taskId);
      const reloadedRun = deps.taskStore.getRun(run.id);
      if (reloaded) {
        try {
          await deps.syncTask(reloaded, reloadedRun);
        } catch (err) {
          console.error(`syncTask error after finalize_success for task ${task.id}:`, err);
        }
      }
    }
  } else if (action.kind === "finalize_evidence_missing") {
    deps.taskStore.updateRunVerify(run.id, {
      verifyStatus: "fail",
      receiptEvidence: proof.evidence,
    });
    deps.taskStore.updateRunFinal(run.id, "evidence_missing", now);
    deps.verifyStore.finalizeVerification(verificationId);
    deps.taskStore.refreshNextRun(task.id);
    await fireNotify(
      deps,
      effective,
      "receipt_missing",
      task,
      run,
      `receipt proof failed; evidence: ${JSON.stringify(proof.evidence)}`
    );
    if (deps.heal) {
      try {
        await deps.heal({
          taskId: task.id,
          runId: run.id,
          taskName: task.name,
          ownerSession: task.ownerSession ?? "",
          idempotency: effective.idempotency,
          triggeredAt: run.triggeredAt ?? 0,
          evidence: proof.evidence,
          verifyAttempts: verification.attempts,
        });
      } catch (err) {
        console.error(`heal dispatch failed for run ${run.id}:`, err);
      }
    }
    if (deps.syncTask) {
      const reloaded = deps.taskStore.getTask(run.taskId);
      const reloadedRun = deps.taskStore.getRun(run.id);
      if (reloaded) {
        try {
          await deps.syncTask(reloaded, reloadedRun);
        } catch (err) {
          console.error(`syncTask error after finalize_evidence_missing for task ${task.id}:`, err);
        }
      }
    }
  } else {
    deps.verifyStore.rescheduleVerification(verificationId, action.dueAt);
  }
}

async function fireNotify(
  deps: VerifyDeps,
  effective: DimensionValues,
  event: NotifyEvent,
  task: { id: string; name: string; ownerSession: string | null },
  run: { id: string },
  message: string
): Promise<void> {
  if (!deps.notify) return;
  const rule = effective.notify[event];
  if (rule.channel === "none") return;
  try {
    await deps.notify(rule, {
      event,
      taskId: task.id,
      runId: run.id,
      taskName: task.name,
      ownerSession: task.ownerSession ?? "",
      message,
    });
  } catch (err) {
    console.error(`notify error for task ${task.id}:`, err);
  }
}
