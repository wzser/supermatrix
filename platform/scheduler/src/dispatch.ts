import type { Task, TriggerResult, ScriptConfig, SessionConfig } from "./types.js";
import type { TaskStore, MutationAuditContext } from "./db/taskStore.js";
import type { SchedulerSpawnContext } from "./spawn/sanitizeSpawnBody.js";

export type RunDeps = {
  store: TaskStore;
  trigger: {
    shell: (args: { config: ScriptConfig; schedulerContext?: SchedulerSpawnContext }) => Promise<TriggerResult>;
    http: (config: SessionConfig & { schedulerContext?: SchedulerSpawnContext }) => Promise<TriggerResult>;
  };
  sendAlert: (task: Task, consecutiveFailures: number) => void | Promise<void>;
  onOneshotDone: (taskId: string) => void;
  sleep: (ms: number) => Promise<void>;
};

const SCHEDULER_RUNTIME_MUTATION_CONTEXT: MutationAuditContext = {
  actorClass: "scheduler_runtime",
  actorSession: "scheduler",
  sourceCommId: null,
};

function shouldRetry(task: Task, result: TriggerResult): boolean {
  if (!task.retryEnabled || result.ok) return false;
  if (task.retryExitCodes === undefined) return true;
  return task.type === "script" &&
    result.exitCode !== undefined &&
    task.retryExitCodes.includes(result.exitCode);
}

export async function runTask(
  task: Task,
  deps: RunDeps,
  options: { scheduledAt?: number } = {},
): Promise<void> {
  const { store, trigger, sendAlert, onOneshotDone, sleep } = deps;
  const triggeredAt = Date.now();
  const runId = store.createRun(task.id, triggeredAt, options.scheduledAt ?? null);
  if (!runId) return;
  const ctx: SchedulerSpawnContext = { taskId: task.id, runId, triggeredAt, owner: task.owner };

  const dispatch = (): Promise<TriggerResult> =>
    task.type === "script"
      ? trigger.shell({ config: task.config as ScriptConfig, schedulerContext: ctx })
      : trigger.http({ ...(task.config as SessionConfig), schedulerContext: ctx });

  let attempts = 1;
  let result = await dispatch();
  // Omitted retryExitCodes preserves legacy retryEnabled behavior. An explicit
  // list only retries matching script exit codes.
  if (shouldRetry(task, result)) {
    while (shouldRetry(task, result) && attempts <= task.retryMax) {
      await sleep(task.retryDelayMs);
      attempts++;
      result = await dispatch();
    }
  }

  if (result.ok) {
    store.finalizeRun(runId, {
      outcome: "success",
      attempts,
      pid: result.pid,
      childSessionId: result.childSessionId,
    });
    if (task.oneshot) {
      store.updateTask(task.id, { enabled: false }, SCHEDULER_RUNTIME_MUTATION_CONTEXT);
      onOneshotDone(task.id);
    }
    return;
  }

  store.finalizeRun(runId, { outcome: "failed", attempts, error: result.error });
  const n = store.consecutiveFailures(task.id);
  if (task.alertThreshold > 0 && n === task.alertThreshold) {
    await sendAlert(task, n);
  }
}
