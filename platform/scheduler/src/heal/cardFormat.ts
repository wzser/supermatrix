const RETIREMENT_CATEGORIES = new Set(["已完成", "已废弃", "一次性补跑"]);

/**
 * A task is "retired" when there is no point nagging anyone about it: either
 * the owner has already disabled it, or its category marks it as deliberately
 * finished. Heal cards for retired tasks are pure noise — same rule the
 * disabledWarning stale-task nag uses.
 */
export function isTaskRetired(task: { enabled: boolean; category: string | null }): boolean {
  if (!task.enabled) return true;
  if (task.category && RETIREMENT_CATEGORIES.has(task.category)) return true;
  return false;
}

export type HealCardScenario = "owner_unreachable" | "timeout";

export type HealCardParams = {
  taskId: string;
  taskName: string;
  taskDescription: string;
  ownerSession: string;
  triggeredAt: number;
  reason: string;
  evidence: Record<string, unknown>;
  defaultAction: string;
  scenario: HealCardScenario;
  /** for owner_unreachable */
  ownerStatus?: number | string;
  /** for timeout */
  spawnRetryCount?: number;
};

/**
 * Console-bound heal card body. Read-only: the Console can't reply, so the
 * card states the situation and points to the API for manual intervention,
 * rather than listing reply tokens (RETRY/SKIP/DISABLE/ADJUST). The four
 * required sections — task purpose, originally scheduled time, current
 * status, and heal-attempt history — make the card stand on its own.
 */
export function renderHealCard(p: HealCardParams): string {
  const purpose = p.taskDescription.trim() || "(无描述)";
  const scheduled = new Date(p.triggeredAt).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(" ", "T");
  const evidenceLine = formatEvidence(p.evidence);
  const healLine =
    p.scenario === "owner_unreachable"
      ? `已尝试派活给 owner "${p.ownerSession}",平台返回 HTTP ${p.ownerStatus}(owner session 不存在或终态不可达,无法走自愈协商)。`
      : `已派活给 owner "${p.ownerSession}",24 小时无回复(spawn_retry_count=${p.spawnRetryCount ?? 0})。`;

  return [
    `【scheduler heal】任务 "${p.taskName}" 需要关注`,
    "",
    `任务目的:${purpose}`,
    `原计划执行时间:${scheduled}`,
    `当前状态:${p.reason} — ${evidenceLine}`,
    `自愈尝试:${healLine}`,
    `默认处理:本提案按 ${p.defaultAction} 归档,任务下次按 cron 正常触发。`,
    "",
    `如需手工干预(改 expectedDuration / 停用 / 重跑等),请 PATCH http://localhost:3500/tasks/${p.taskId}。`,
  ].join("\n");
}

function formatEvidence(e: Record<string, unknown>): string {
  if (!e || Object.keys(e).length === 0) return "(无证据)";
  const note = typeof e.note === "string" ? e.note : null;
  const exitCode = "exitCode" in e ? e.exitCode : undefined;
  if (note && exitCode !== undefined) return `${note} (exitCode=${exitCode === null ? "null" : String(exitCode)})`;
  if (note) return note;
  try {
    return JSON.stringify(e);
  } catch {
    return "(证据无法序列化)";
  }
}
