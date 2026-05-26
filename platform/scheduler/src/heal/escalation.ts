import type Database from "better-sqlite3";
import type { TaskStore } from "../db/taskStore.js";
import type { HealStore } from "./store.js";

/**
 * Escalate only when a task is genuinely stuck — i.e. several runs in a row were
 * SKIP'd with no success in between. A flat 30-day SKIP count was frequency-blind:
 * an every-5-min task has ~8640 runs/month, so 6 scattered SKIPs is noise; a weekly
 * task has ~4, so 6 SKIPs is a total stall. A consecutive streak is cadence-independent.
 *
 * One DM per stuck task per cooldown window — the prior version re-fired on every
 * heal tick, which spammed the user for long-running stalls where the owner was
 * already actively repairing (e.g. spawn-closure-watcher, 2026-05-20).
 */
const ESCALATION_STREAK_THRESHOLD = 4;
const RE_ESCALATE_COOLDOWN_MS = 24 * 3600_000;

export type HealEscalationStore = {
  getLastEscalatedAt(taskId: string): number | null;
  upsertEscalated(taskId: string, at: number): void;
};

export function createHealEscalationStore(db: Database.Database): HealEscalationStore {
  const getStmt = db.prepare("SELECT last_escalated_at FROM heal_escalations WHERE task_id = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO heal_escalations (task_id, last_escalated_at) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET last_escalated_at = excluded.last_escalated_at",
  );
  return {
    getLastEscalatedAt(taskId) {
      const row = getStmt.get(taskId) as { last_escalated_at: number } | undefined;
      return row ? row.last_escalated_at : null;
    },
    upsertEscalated(taskId, at) {
      upsertStmt.run(taskId, at);
    },
  };
}

export async function maybeEscalateSkips(deps: {
  healStore: HealStore;
  taskStore: TaskStore;
  escalationStore: HealEscalationStore;
  taskId: string;
  sendUserDm: (text: string) => Promise<void>;
  clock?: () => number;
}): Promise<void> {
  const streak = deps.healStore.countConsecutiveSkippedRunsSinceSuccess(deps.taskId);
  if (streak < ESCALATION_STREAK_THRESHOLD) return;

  const now = (deps.clock ?? Date.now)();
  const last = deps.escalationStore.getLastEscalatedAt(deps.taskId);
  if (last !== null && now - last < RE_ESCALATE_COOLDOWN_MS) return;

  const task = deps.taskStore.getTask(deps.taskId);
  const taskName = task?.name ?? deps.taskId;
  const purpose = task?.description?.trim() || "(无描述)";
  const cron = task?.cron ?? "?";
  const owner = task?.ownerSession ?? "(none)";

  const text = [
    `【scheduler 告警】任务 "${taskName}" 长期没有成功`,
    "",
    `任务目的:${purpose}`,
    `执行频次:cron \`${cron}\`(owner=${owner})`,
    `当前状态:最近连续 ${streak} 次 run 都被记为 SKIP,没有一次成功`,
    `自愈尝试:scheduler 已对每次失败走 heal 协商;owner 持续回复 SKIP(可能正在自己排查或修脚本)`,
    "",
    `如果 owner 在管,等修复即可。如长期未解,可手工 PATCH http://localhost:3500/tasks/${deps.taskId}(改 expectedDuration / cron),或临时停用任务。`,
    "",
    `(同一任务 24 小时内不会重复发此告警。)`,
  ].join("\n");

  await deps.sendUserDm(text);
  deps.escalationStore.upsertEscalated(deps.taskId, now);
}
