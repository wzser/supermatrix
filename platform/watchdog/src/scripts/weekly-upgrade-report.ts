// "Report" entry：cron 每 5 分钟 tick 一次（周四 05:00–12:55）。读 pending file，
// 一次单 GET /api/sessions/:id/result：202 still running 就 no-op；200 done 就解析、
// 自动登记 Proposed issues、Console 完整报告卡片、清 pending file；404 给 root 看不到
// 的也清 pending file（不再徒劳重试）。
//
// 设计目标（与 weekly-upgrade.ts do entry 对偶）：
// - do 失败：pending file 不存在 → report 永远 no-op，不噪音
// - do 成功 + root 慢：report 多次 tick 直到 200，最长 8h 给 root review 时间
// - report 自身崩：下个 tick 接着干，状态文件是单一权威，无 race

import { existsSync } from "node:fs";
import { createNotifyClient } from "../notify/console.js";
import {
  PENDING_FILE,
  clearPending,
  fileChecklistMetaAsIssues,
  fileProposedAsIssues,
  formatUpgradeLines,
  readPending,
} from "./_weekly-upgrade-shared.js";

const port = process.env.SM_API_PORT ?? "3501";

async function pollOnce(childSessionId: string): Promise<{ status: "running" | "done" | "missing"; finalMessage?: string }> {
  const url = `http://localhost:${port}/api/sessions/${encodeURIComponent(childSessionId)}/result`;
  try {
    const res = await fetch(url);
    if (res.status === 202) return { status: "running" };
    if (res.status === 200) {
      const data = (await res.json()) as { finalMessage?: string };
      return { status: "done", finalMessage: data.finalMessage ?? "(no finalMessage)" };
    }
    if (res.status === 404) return { status: "missing" };
    return { status: "missing" };
  } catch {
    // 网络抖动当 still running 处理，下个 tick 重试
    return { status: "running" };
  }
}

function auditChecklist(rootReview: string): { warned: number; passed: number; na: number } {
  // 解析 root 输出的 ## Checklist 段，统计 [⚠️] / [✓] / [N/A] 数量。
  // 每行格式约定：'- [✓] xxx' 或 '- [⚠️ <reason>] xxx' 或 '- [N/A <reason>] xxx'
  const idx = rootReview.search(/^##\s*Checklist\b/im);
  if (idx < 0) return { warned: 0, passed: 0, na: 0 };
  const after = rootReview.slice(idx).replace(/^##\s*Checklist[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = sectionEnd >= 0 ? after.slice(0, sectionEnd) : after;
  let warned = 0;
  let passed = 0;
  let na = 0;
  for (const line of section.split("\n")) {
    if (/\[⚠️/.test(line) || /\[WARN/i.test(line)) warned++;
    else if (/\[✓/.test(line) || /\[OK\b/i.test(line)) passed++;
    else if (/\[N\/A/i.test(line)) na++;
  }
  return { warned, passed, na };
}

async function deliverFinalReport(
  date: string,
  results: import("./_weekly-upgrade-shared.js").UpgradeResult[],
  rootReview: string,
  proposedFiled: { count: number; ids: string[]; failed: number },
  metaFiled: { count: number; ids: string[]; failed: number },
): Promise<void> {
  const { lines, changed, failed } = formatUpgradeLines(results);
  const audit = auditChecklist(rootReview);
  const sections = [lines.join("\n")];
  if (audit.passed + audit.warned + audit.na > 0) {
    const summary = `**Checklist**：${audit.passed} ✓ / ${audit.warned} ⚠️ / ${audit.na} N/A`;
    sections.push(`---\n${summary}${audit.warned > 0 ? "（**有警告项需关注**，详见下方 review 全文 ⚠️ 行）" : ""}`);
  }
  sections.push(`---\n**Root review (supermatrix-root)**:\n${rootReview}`);
  if (proposedFiled.count > 0 || proposedFiled.failed > 0) {
    sections.push(`---\n**已自动登记 ${proposedFiled.count} 条 Proposed issue 进 watchdog 队列**${proposedFiled.failed > 0 ? `（${proposedFiled.failed} 条 add 失败）` : ""}：${proposedFiled.ids.map((i) => i.slice(0, 8)).join(", ")}`);
  }
  if (metaFiled.count > 0 || metaFiled.failed > 0) {
    sections.push(`**已自动登记 ${metaFiled.count} 条 checklist 演化建议 issue**${metaFiled.failed > 0 ? `（${metaFiled.failed} 条 add 失败）` : ""}：${metaFiled.ids.map((i) => i.slice(0, 8)).join(", ")}（人审后手工编辑 data/upgrade-review-checklist.md）`);
  }
  const body = sections.join("\n\n");
  console.log(`[Weekly CLI upgrade · report] ${date}\n${body}`);
  // level：upgrade 本身失败 → error；checklist 有 warn → warn；否则 info
  const level = failed > 0 ? "error" : audit.warned > 0 ? "warn" : "info";
  try {
    await createNotifyClient().notify({
      source: "watchdog",
      title: `每周 CLI 升级 · ${date}（review 完成${audit.warned > 0 ? `，${audit.warned} 项警告` : ""}）`,
      body,
      level,
      metadata: {
        date, changed, failed, total: results.length,
        rootReviewed: "yes",
        proposedFiled: proposedFiled.count,
        metaFiled: metaFiled.count,
        checklistPassed: audit.passed,
        checklistWarned: audit.warned,
        checklistNA: audit.na,
      },
    });
  } catch (err) {
    console.error("Notify failed:", (err as Error).message);
  }
}

if (!existsSync(PENDING_FILE)) {
  console.log("[Weekly CLI upgrade · report] no pending review, no-op");
  process.exit(0);
}

const pending = readPending();
if (!pending) {
  console.log("[Weekly CLI upgrade · report] pending file unparseable, clearing");
  clearPending();
  process.exit(0);
}

const ageMs = Date.now() - pending.spawnedAt;
const ageHours = (ageMs / 3600_000).toFixed(1);
console.log(`[Weekly CLI upgrade · report] ${pending.runDate} polling ${pending.childSessionId} (age ${ageHours}h)`);

const result = await pollOnce(pending.childSessionId);
if (result.status === "running") {
  console.log("  → still running, will retry next tick");
  process.exit(0);
}
if (result.status === "missing") {
  console.error(`  → session missing/404, abandoning pending review`);
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${pending.runDate}（review 中止）`,
    body: `Root review session ${pending.childSessionId} 在 SuperMatrix 中查不到了（404 / lookup miss）。当周 review 放弃。已是最新部分不受影响。`,
    level: "warn",
    metadata: { date: pending.runDate, abandoned: "yes" },
  }).catch(() => {});
  clearPending();
  process.exit(0);
}

// status === "done"
const rootReview = result.finalMessage ?? "(no finalMessage)";
const proposedFiled = fileProposedAsIssues(rootReview);
const metaFiled = fileChecklistMetaAsIssues(rootReview);
await deliverFinalReport(pending.runDate, pending.results, rootReview, proposedFiled, metaFiled);
clearPending();
console.log("  → final report delivered, pending file cleared");
