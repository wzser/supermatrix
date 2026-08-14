import { Cron } from "croner";
import type { Task } from "./types.js";

const MAX_BOOT_CATCH_UP_DELAY_MS = 24 * 60 * 60 * 1000;
// v2 cron is minute-granularity, so this bounds boot-time availability work to
// the two days immediately before the catch-up cutoff.
const MAX_BOOT_AVAILABILITY_SCAN_SLOTS = 2 * 24 * 60;

export type BootRecoveryCandidate = {
  task: Task;
  scheduledAt: number;
};

export type BootExpiredCandidate = BootRecoveryCandidate;

export function findBootRecoveryCandidates(
  tasks: readonly Task[],
  now: number,
  hasDeliveryForScheduledAt: (taskId: string, scheduledAt: number) => boolean,
): BootRecoveryCandidate[] {
  return tasks.flatMap((task) => {
    if (!task.enabled || task.oneshot || task.config.catchUpOnBoot !== true) return [];

    const cron = new Cron(task.cron, { paused: true });
    const scheduledAt = cron.previousRuns(1, new Date(now))[0]?.getTime();
    cron.stop();

    if (scheduledAt === undefined || now - scheduledAt > MAX_BOOT_CATCH_UP_DELAY_MS) return [];
    if (hasDeliveryForScheduledAt(task.id, scheduledAt)) return [];
    return [{ task, scheduledAt }];
  });
}

/**
 * Finds the newest expired slot with no delivery record. These are evidence
 * candidates only: callers must record them without dispatching the task.
 */
export function findBootExpiredCandidates(
  tasks: readonly Task[],
  now: number,
  hasDeliveryForScheduledAt: (taskId: string, scheduledAt: number) => boolean,
): BootExpiredCandidate[] {
  const cutoff = now - MAX_BOOT_CATCH_UP_DELAY_MS;

  return tasks.flatMap((task) => {
    if (!task.enabled || task.oneshot || task.config.catchUpOnBoot !== true) return [];

    const cron = new Cron(task.cron, { paused: true });
    const scheduledAt = cron.previousRuns(MAX_BOOT_AVAILABILITY_SCAN_SLOTS, new Date(cutoff))
      .map((run) => run.getTime())
      .find((at) =>
        now - at > MAX_BOOT_CATCH_UP_DELAY_MS
        && at >= task.createdAt
        && !hasDeliveryForScheduledAt(task.id, at));
    cron.stop();

    return scheduledAt === undefined ? [] : [{ task, scheduledAt }];
  });
}

export async function recoverMissedTasks(
  tasks: readonly Task[],
  now: number,
  hasDeliveryForScheduledAt: (taskId: string, scheduledAt: number) => boolean,
  deliver: (candidate: BootRecoveryCandidate) => Promise<void>,
): Promise<BootRecoveryCandidate[]> {
  const candidates = findBootRecoveryCandidates(tasks, now, hasDeliveryForScheduledAt);
  for (const candidate of candidates) await deliver(candidate);
  return candidates;
}
