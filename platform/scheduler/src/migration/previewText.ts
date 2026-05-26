import type { TaskClass } from "../classes/types.js";

export function renderMigrationPreview(entries: { taskName: string; suggestedClass: TaskClass }[]): string {
  const lines = entries.map((e) => `  - ${e.taskName}  (建议 class: ${e.suggestedClass})`).join("\n");
  return [
    "【scheduler 预告 — 无需回复】",
    "",
    "近期 scheduler 会完成架构升级，引入任务分类（class）和完成凭证（receipt）机制。",
    "你 own 的这些 task 随后会收到结构化 migration proposal，请届时花 5 分钟确认/修改：",
    "",
    lines,
    "",
    "关键变化（与你相关的部分）:",
    "- 需要你声明每个 task 的 expectedDuration（正常跑多久），没有 class 默认值",
    "- scheduler 会主动发 migration proposal，你回 CONFIRM/MODIFY/LATER/DISABLE",
    "- 非幂等任务（发飞书报告等）失败不再自动补跑，会发 heal proposal 给你拍板",
  ].join("\n");
}
