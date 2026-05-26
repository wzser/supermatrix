import type { TaskClass } from "../classes/types.js";

type Params = {
  taskName: string;
  taskCron: string;
  suggestedClass: TaskClass;
  suggestedExpectedDurationMs: number;
  executorSummary: string;
  laterCount: number;
};

export function renderMigrationProposalText(p: Params): string {
  const resendNote = p.laterCount > 0
    ? `\n(这是第 ${p.laterCount + 1} 次 migration proposal — 之前 ${p.laterCount} 次 LATER 或未回复)\n`
    : "";
  return [
    "【scheduler migration proposal】",
    resendNote,
    `task: ${p.taskName}`,
    `cron: ${p.taskCron}`,
    `当前执行方式: ${p.executorSummary}`,
    "",
    "scheduler 的建议:",
    `  class: ${p.suggestedClass}`,
    `  expectedDuration: ${p.suggestedExpectedDurationMs} ms`,
    "",
    "动作（回复格式：ACTION: <name> [key=value ...]）:",
    "  CONFIRM   采纳建议（可带 expectedDuration 覆盖），例: ACTION: CONFIRM expectedDuration=1800000",
    "  MODIFY    改 class / expectedDuration，例: ACTION: MODIFY class=publication expectedDuration=7200000",
    "  LATER     暂不迁移，过 7 天再问",
    "  DISABLE   这个 task 已过期，请直接停用",
    "",
    "默认 24h 无回复 → LATER",
  ].join("\n");
}
