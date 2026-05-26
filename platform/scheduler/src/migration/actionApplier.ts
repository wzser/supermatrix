import type { TaskStore } from "../db/taskStore.js";
import type { TaskClass } from "../classes/types.js";
import type { MigrationAction } from "./types.js";

const VALID_CLASSES: TaskClass[] = ["sync_job", "publication", "monitoring", "delegation", "notification"];

type Params = {
  taskStore: TaskStore;
  taskId: string;
  action: MigrationAction;
  kv: Record<string, string>;
  suggestedClass: TaskClass;
  suggestedExpectedDurationMs: number;
  ownerSession: string;
};

export type ApplyResult = { applied: boolean; error?: string };

export function applyMigrationAction(p: Params): ApplyResult {
  if (p.action === "LATER" || p.action === "REJECT") {
    return { applied: false };
  }
  if (p.action === "DISABLE") {
    p.taskStore.updateTask(p.taskId, { enabled: false });
    return { applied: true };
  }

  const targetClass: TaskClass = p.action === "MODIFY" && p.kv.class
    ? (p.kv.class as TaskClass)
    : p.suggestedClass;
  if (!(VALID_CLASSES as string[]).includes(targetClass)) {
    return { applied: false, error: `invalid class: ${p.kv.class}` };
  }
  const durRaw = p.kv.expectedDuration;
  const targetDuration = durRaw ? Number(durRaw) : p.suggestedExpectedDurationMs;
  if (!Number.isFinite(targetDuration) || targetDuration <= 0 || targetDuration > 86_400_000) {
    return { applied: false, error: `invalid expectedDuration: ${durRaw}` };
  }

  p.taskStore.updateTask(p.taskId, {
    class: targetClass,
    expectedDurationMs: targetDuration,
    ownerSession: p.ownerSession,
  });
  return { applied: true };
}
