import type { TaskClass } from "../db/taskStore.js";

export const DEFAULT_DURATION_MS: Record<TaskClass, number> = {
  sync_job: 1_800_000,
  publication: 3_600_000,
  monitoring: 300_000,
  delegation: 1_800_000,
  notification: 120_000,
};

export function inferSuggestedClass(task: {
  executor: "shell" | "http";
  config: Record<string, unknown>;
}): { suggestedClass: TaskClass; suggestedExpectedDurationMs: number } {
  const suggestedClass: TaskClass = task.executor === "shell" ? "sync_job" : "delegation";
  return { suggestedClass, suggestedExpectedDurationMs: DEFAULT_DURATION_MS[suggestedClass] };
}
