import type Database from "better-sqlite3";
import type { TaskStore } from "../db/taskStore.js";
import { Cron } from "croner";

const MIN_THRESHOLD_MS = 48 * 3600_000;
const MAX_THRESHOLD_MS = 30 * 24 * 3600_000;
const RE_WARN_INTERVAL_MS = 7 * 24 * 3600_000;

export type DisabledWarningStore = {
  getLastWarnedAt(taskId: string): number | null;
  upsertWarned(taskId: string, at: number): void;
  clearWarned(taskId: string): void;
};

export function createDisabledWarningStore(db: Database.Database): DisabledWarningStore {
  const getStmt = db.prepare("SELECT last_warned_at FROM disabled_warnings WHERE task_id = ?");
  const upsertStmt = db.prepare(
    "INSERT INTO disabled_warnings (task_id, last_warned_at) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET last_warned_at = excluded.last_warned_at"
  );
  const deleteStmt = db.prepare("DELETE FROM disabled_warnings WHERE task_id = ?");
  return {
    getLastWarnedAt(taskId) {
      const row = getStmt.get(taskId) as { last_warned_at: number } | undefined;
      return row ? row.last_warned_at : null;
    },
    upsertWarned(taskId, at) {
      upsertStmt.run(taskId, at);
    },
    clearWarned(taskId) {
      deleteStmt.run(taskId);
    },
  };
}

export function computeCronPeriodMs(cron: string, fromMs: number): number | null {
  try {
    const c = new Cron(cron);
    const a = c.nextRun(new Date(fromMs));
    if (!a) return null;
    const b = c.nextRun(new Date(a.getTime() + 1));
    if (!b) return null;
    return b.getTime() - a.getTime();
  } catch {
    return null;
  }
}

export function computeThreshold(cron: string, fromMs: number): number {
  const period = computeCronPeriodMs(cron, fromMs);
  if (period == null) return MIN_THRESHOLD_MS;
  return Math.min(MAX_THRESHOLD_MS, Math.max(MIN_THRESHOLD_MS, period * 3));
}

export type DisabledWarningTickDeps = {
  taskStore: TaskStore;
  warningStore: DisabledWarningStore;
  sendUserDm: (text: string) => Promise<void>;
  clock?: () => number;
};

export async function runDisabledWarningTick(
  deps: DisabledWarningTickDeps,
): Promise<{ warned: number; skipped: number }> {
  const now = (deps.clock ?? Date.now)();
  const tasks = deps.taskStore.listTasks().filter((t) => !t.enabled);
  let warned = 0;
  let skipped = 0;
  for (const t of tasks) {
    // Ephemeral lifecycle categories don't expect to be re-enabled — once done,
    // they're done. Either owner DELETEs them or they linger as historical
    // records; either way nagging the user about re-enabling them is just noise.
    // 已完成 = healthy retirement; 已废弃 = deliberately retired; 一次性补跑 = oneshot done.
    if (t.category === "已完成" || t.category === "已废弃" || t.category === "一次性补跑") {
      skipped++;
      continue;
    }
    const disabledFor = now - t.updatedAt;
    const threshold = computeThreshold(t.cron, now);
    if (disabledFor < threshold) {
      skipped++;
      continue;
    }
    const lastAt = deps.warningStore.getLastWarnedAt(t.id);
    if (lastAt != null && now - lastAt < RE_WARN_INTERVAL_MS) {
      skipped++;
      continue;
    }
    const days = Math.floor(disabledFor / 86400_000);
    const owner = t.ownerSession ?? t.createdBy ?? "unknown";
    const description = t.description?.trim() || "(无描述 — 建议补一下 description 字段，便于后续决策)";
    const text = [
      `[scheduler] 任务 "${t.name}" 已停用 ${days} 天`,
      "",
      `作用：${description}`,
      "",
      `cron: ${t.cron}  |  owner: ${owner}`,
      `id: ${t.id}`,
      "",
      "超过 3× cron 周期未启用，请决定：",
      `  - 重新启用：curl -X PATCH http://localhost:3500/tasks/${t.id} -H 'Content-Type: application/json' -d '{"enabled": true}'`,
      `  - 转交 owner：curl -X PATCH http://localhost:3500/tasks/${t.id} -H 'Content-Type: application/json' -d '{"ownerSession": "<other>"}'`,
      `  - 永久删除：curl -X DELETE http://localhost:3500/tasks/${t.id}`,
      "",
      "7 天后再次提醒（如仍未处理）。",
    ].join("\n");
    try {
      await deps.sendUserDm(text);
      deps.warningStore.upsertWarned(t.id, now);
      warned++;
    } catch (err) {
      console.error(`disabled-warning userDM failed for task ${t.id}:`, err);
    }
  }
  return { warned, skipped };
}
