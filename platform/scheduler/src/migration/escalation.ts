import type { TaskStore } from "../db/taskStore.js";
import type { MigrationStore } from "./store.js";

const DAY = 24 * 3600_000;

export async function maybeEscalateMigration(deps: {
  taskStore: TaskStore;
  migrationStore: MigrationStore;
  taskId: string;
  nowMs: number;
  sendUserDm: (text: string) => Promise<void>;
}): Promise<void> {
  const task = deps.taskStore.getTask(deps.taskId);
  if (!task) return;
  if (task.class !== null) return;

  const laterCount = deps.migrationStore.countLaterForTask(deps.taskId);
  if (laterCount < 2) return;

  const first = deps.migrationStore.firstSpawnedAtForTask(deps.taskId);
  if (first === null) return;
  const daysSinceFirst = (deps.nowMs - first) / DAY;

  const stage = task.migrationEscalationStage ?? 0;

  if (laterCount >= 3 && daysSinceFirst >= 30 && stage === 1) {
    await deps.sendUserDm(
      `[scheduler migration] task "${task.name}" has been deferred ${laterCount} times over ${Math.floor(daysSinceFirst)} days (since first proposal). Final nudge: please MODIFY / DISABLE, or the task will keep running on the legacy path indefinitely. Reference: 30 days.`
    );
    deps.taskStore.updateTask(deps.taskId, { migrationEscalationStage: 2 });
    return;
  }
  if (laterCount >= 2 && daysSinceFirst >= 14 && stage === 0) {
    await deps.sendUserDm(
      `[scheduler migration] task "${task.name}" has been deferred ${laterCount} times in the last ${Math.floor(daysSinceFirst)} days. Please review whether the task still needs to run; a 30-day final reminder will follow if it is not migrated or disabled.`
    );
    deps.taskStore.updateTask(deps.taskId, { migrationEscalationStage: 1 });
    return;
  }
}
