import type { Task, TaskStore } from "../db/taskStore.js";

export function shouldSkipForOverlap(store: TaskStore, task: Task): boolean {
  if (task.overlapPolicy !== "skip_if_running") return false;

  const recent = store.listRuns(task.id, 10);
  return recent.some((run) => run.triggerStatus === "ok" && run.finalStatus === "pending");
}
