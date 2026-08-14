// "Report" entry：cron 每 5 分钟 tick 一次（周四 05:00–12:55）。读 pending file，
// 一次单 GET /api/sessions/:id/result：202 still running 就 no-op；200 done 就解析、
// 自动登记 Proposed issues、Console 完整报告卡片、清 pending file；404 给 root 看不到
// 的也清 pending file（不再徒劳重试）。
//
// 设计目标（与 weekly-upgrade.ts do entry 对偶）：
// - do 失败：pending file 不存在 → report 永远 no-op，不噪音
// - do 成功 + root 慢：report 多次 tick 直到 200，最长 8h 给 root review 时间
// - report 自身崩：下个 tick 接着干，状态文件是单一权威，无 race

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNotifyClient } from "../notify/console.js";
import {
  assessModelAuditResolution,
  formatModelAuditForReview,
  type WeeklyModelAudit,
} from "./_weekly-upgrade-model-audit.js";
import {
  PENDING_FILE,
  RECEIPT_FILE,
  assessChangelogCoverage,
  childSessionIdFromPending,
  classifyPolledSessionResult,
  clearPending,
  fileChecklistMetaAsIssues,
  fileProposedAsIssues,
  formatUpgradeLines,
  formatWeeklyRunDate,
  readPending,
  writeLastReviewedVersions,
  type PendingState,
  type WeeklyCatalogPublishOutcome,
} from "./_weekly-upgrade-shared.js";

const port = process.env.SM_API_PORT ?? "3501";
const AUDIT_FILE = join(process.cwd(), "data", "scheduler_receipts", "weekly-cli-upgrade.audit.jsonl");
const ORPHAN_ALERTED_FILE = join(process.cwd(), "data", "weekly-upgrade-orphan-alerted.json");
// do-entry 全链实测 ~10min；audit 最后一条事件超过这个安静期仍无终态 receipt
// 才判孤儿，避免对进行中的 run 误报。
const ORPHAN_QUIET_MS = 20 * 60 * 1000;

// 孤儿检测：do-entry 被 kill（如 2026-08-06 scheduler 120s 超时 SIGTERM）后
// 没有 pending file，report 原本会静默 no-op。现在没有 pending 时先核对
// 「今天 audit 里有 run start、但 receipt 缺失/日期不对/aborted」→ Console 告警一次。
async function detectOrphanRun(): Promise<void> {
  const today = formatWeeklyRunDate();
  let events: { date?: string; phase?: string; writtenAt?: number }[] = [];
  try {
    events = readFileSync(AUDIT_FILE, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as { date?: string; phase?: string; writtenAt?: number }; } catch { return {}; }
      });
  } catch {
    return;
  }
  const todayEvents = events.filter((event) => event.date === today);
  const lastStartAt = Math.max(0, ...todayEvents.filter((event) => event.phase === "start").map((event) => event.writtenAt ?? 0));
  if (lastStartAt === 0) return;
  const lastWrittenAt = Math.max(...todayEvents.map((event) => event.writtenAt ?? 0));
  if (Date.now() - lastWrittenAt < ORPHAN_QUIET_MS) return; // 可能仍在跑
  let receipt: { date?: string; aborted?: boolean; writtenAt?: number } | null = null;
  try {
    receipt = JSON.parse(readFileSync(RECEIPT_FILE, "utf-8"));
  } catch {
    receipt = null;
  }
  // receipt 必须晚于**最后一次** start：同日早间成功 receipt 不能掩蔽
  // 之后被 SIGKILL 的 run（2026-08-06 补跑即这么消失的）。
  const healthy = receipt !== null && receipt.date === today && receipt.aborted !== true
    && (receipt.writtenAt ?? 0) >= lastStartAt;
  if (healthy) return;
  try {
    const alerted = JSON.parse(readFileSync(ORPHAN_ALERTED_FILE, "utf-8")) as { date?: string };
    if (alerted.date === today) return;
  } catch {
    // 未告警过
  }
  const reason = receipt === null
    ? "receipt 不可读"
    : receipt.date !== today
    ? `receipt 仍是 ${receipt.date} 的（本周 run 未写终态）`
    : "receipt 标记 aborted（run 被信号中断）";
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${today}（run 中断，未完成）`,
    body: `do-entry 今天有 run start 审计但没有本周的正常终态 receipt（${reason}）。升级链可能被超时/信号截断，本周 CLI 变更未经 root review。\n\n补跑入口（幂等）：cd /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/watchdog && npx tsx src/scripts/weekly-upgrade.ts`,
    level: "error",
    metadata: { date: today, orphanRun: "yes" },
  }).catch(() => {});
  mkdirSync(dirname(ORPHAN_ALERTED_FILE), { recursive: true });
  writeFileSync(ORPHAN_ALERTED_FILE, JSON.stringify({ date: today, alertedAt: Date.now() }));
}

// review 完成后把本次各 CLI 版本写成下周 review gate 的基线。
function updateReviewedBaseline(pending: PendingState): void {
  const versions: Record<string, string> = {};
  for (const result of pending.results) {
    if (result.after !== "unknown") versions[result.cli] = result.after;
  }
  writeLastReviewedVersions({ runDate: pending.runDate, reviewedAt: Date.now(), versions });
}

async function pollOnce(childSessionId: string): Promise<{ status: "running" | "done" | "missing" | "failed"; finalMessage?: string; reason?: string }> {
  const url = `http://localhost:${port}/api/sessions/${encodeURIComponent(childSessionId)}/result`;
  try {
    const res = await fetch(url);
    if (res.status === 202) return { status: "running" };
    if (res.status === 200) {
      const classified = classifyPolledSessionResult(await res.json());
      if (classified.status === "running") return { status: "running" };
      if (classified.status === "done") {
        return { status: "done", finalMessage: classified.finalMessage };
      }
      return { status: "failed", reason: classified.reason };
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

function localizeRootReviewForConsole(rootReview: string): string {
  return rootReview
    .replace(/^All\s+(\d+)\s+items verified[\s\S]*?\n\n---\n\n/im, "## Review 摘要\nRoot review 已完成全部 $1 项 CLI 兼容性检查。\n\n---\n\n")
    .replace(/^##\s*Checklist meta\b/gim, "## 检查清单演化建议")
    .replace(/^##\s*Checklist\b/gim, "## 检查清单")
    .replace(/^##\s*Auto-fixed\b/gim, "## 自动修复")
    .replace(/^##\s*Proposed for human\b/gim, "## 待人工评估")
    .replace(/^SM_CLOSURE_ACTION:.*$/gim, "")
    .trim();
}

async function deliverFinalReport(
  date: string,
  results: import("./_weekly-upgrade-shared.js").UpgradeResult[],
  rootReview: string,
  proposedFiled: { count: number; ids: string[]; failed: number },
  metaFiled: { count: number; ids: string[]; failed: number },
  modelAudit?: WeeklyModelAudit,
  catalogPublish?: WeeklyCatalogPublishOutcome,
): Promise<void> {
  const { lines, changed, failed } = formatUpgradeLines(results);
  const audit = auditChecklist(rootReview);
  const sections = [lines.join("\n")];
  const modelAuditResolution = modelAudit
    ? assessModelAuditResolution(modelAudit, rootReview)
    : null;
  if (modelAudit) {
    sections.push(`---\n**模型审计**\n${formatModelAuditForReview(modelAudit)}\n- root resolution: ${modelAuditResolution?.resolution ?? "missing"}`);
  }
  if (catalogPublish) {
    const receiptLine = catalogPublish.status === "failed"
      ? `- reason: ${catalogPublish.reason}`
      : `- receipt: ${catalogPublish.receiptId ?? "unchanged-no-new-receipt"}`;
    sections.push(`---\n**backend model/effort catalog 发布**\n- status: ${catalogPublish.status}\n- catalog revision: ${catalogPublish.catalogRevision ?? "unknown"}\n- snapshot: ${catalogPublish.snapshotPath}\n${receiptLine}`);
  }
  if (audit.passed + audit.warned + audit.na > 0) {
    const summary = `**Checklist**：${audit.passed} ✓ / ${audit.warned} ⚠️ / ${audit.na} N/A`;
    sections.push(`---\n${summary}${audit.warned > 0 ? "（**有警告项需关注**，详见下方 review 全文 ⚠️ 行）" : ""}`);
  }
  sections.push(`---\n**Root review（supermatrix-root）中文报告**：\n${localizeRootReviewForConsole(rootReview)}`);
  if (proposedFiled.count > 0 || proposedFiled.failed > 0) {
    sections.push(`---\n**已自动登记 ${proposedFiled.count} 条 Proposed issue 进 watchdog 队列**${proposedFiled.failed > 0 ? `（${proposedFiled.failed} 条 add 失败）` : ""}：${proposedFiled.ids.map((i) => i.slice(0, 8)).join(", ")}`);
  }
  if (metaFiled.count > 0 || metaFiled.failed > 0) {
    sections.push(`**已自动登记 ${metaFiled.count} 条 checklist 演化建议 issue**${metaFiled.failed > 0 ? `（${metaFiled.failed} 条 add 失败）` : ""}：${metaFiled.ids.map((i) => i.slice(0, 8)).join(", ")}（人审后手工编辑 docs/weekly-cli-upgrade-checklist.md）`);
  }
  const body = sections.join("\n\n");
  console.log(`[Weekly CLI upgrade · report] ${date}\n${body}`);
  // level：upgrade 本身失败 → error；checklist 有 warn → warn；否则 info
  const modelResolutionFailed = modelAuditResolution !== null && modelAuditResolution.status !== "accepted";
  const catalogPublishFailed = catalogPublish?.status === "failed";
  const level = failed > 0 || modelResolutionFailed || catalogPublishFailed ? "error" : audit.warned > 0 ? "warn" : "info";
  const titleStatus = catalogPublishFailed
    ? "model/effort catalog 发布未闭环"
    : modelResolutionFailed
    ? "模型审计未闭环"
    : `review 完成${audit.warned > 0 ? `，${audit.warned} 项警告` : ""}`;
  try {
    await createNotifyClient().notify({
      source: "watchdog",
      title: `每周 CLI 升级 · ${date}（${titleStatus}）`,
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
        modelAuditResolution: modelAuditResolution?.resolution ?? "legacy-no-audit",
        catalogPublish: catalogPublish?.status ?? "legacy-no-catalog-publish",
        catalogRevision: catalogPublish?.catalogRevision ?? "unknown",
      },
    });
  } catch (err) {
    console.error("Notify failed:", (err as Error).message);
  }
}

if (!existsSync(PENDING_FILE)) {
  await detectOrphanRun();
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
const childSessionId = childSessionIdFromPending(pending);
if (!childSessionId) {
  console.error("  → pending file has no pollable childSessionId, clearing");
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${pending.runDate}（review 中止）`,
    body: "pending-upgrade-review.json 缺少可轮询的 childSessionId；无法跟踪 root review，已清理 pending 文件。",
    level: "warn",
    metadata: { date: pending.runDate, abandoned: "yes" },
  }).catch(() => {});
  clearPending();
  process.exit(0);
}

const delegation = pending.delegation;
console.log(`[Weekly CLI upgrade · report] ${pending.runDate} polling ${childSessionId}${delegation?.spawnCommId ? ` (spawnCommId ${delegation.spawnCommId})` : ""} (age ${ageHours}h)`);

const result = await pollOnce(childSessionId);
if (result.status === "running") {
  console.log("  → still running, will retry next tick");
  process.exit(0);
}
if (result.status === "missing") {
  console.error(`  → session missing/404, abandoning pending review`);
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${pending.runDate}（review 中止）`,
    body: `Root review session ${childSessionId} 在 SuperMatrix 中查不到了（404 / lookup miss）。当周 review 放弃。已是最新部分不受影响。`,
    level: "warn",
    metadata: {
      date: pending.runDate,
      abandoned: "yes",
      ...(delegation?.spawnCommId ? { spawnCommId: delegation.spawnCommId } : {}),
    },
  }).catch(() => {});
  clearPending();
  process.exit(0);
}
if (result.status === "failed") {
  const reason = result.reason ?? "unknown terminal failure";
  console.error(`  → root review failed: ${reason}`);
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${pending.runDate}（review 失败）`,
    body: `Root review session ${childSessionId} 没有产出可交付 review：${reason}。升级阶段已完成，但本周 CLI 变更仍需重新 review。已清理 pending 文件，避免重复发送空报告。`,
    level: "warn",
    metadata: {
      date: pending.runDate,
      rootReviewFailed: "yes",
      ...(delegation?.spawnCommId ? { spawnCommId: delegation.spawnCommId } : {}),
    },
  }).catch(() => {});
  clearPending();
  process.exit(0);
}

// status === "done"
const rootReview = result.finalMessage ?? "(no finalMessage)";
// Changelog coverage 机器校验（fail-closed）：root 没按协议逐版本覆盖时不发
// 最终报告、不更新 reviewed 基线（下周 do-entry 会重新检测 drift 再审）。
const coverage = assessChangelogCoverage(rootReview, pending.changelogCoverage);
if (coverage.status === "missing-section" || coverage.status === "incomplete") {
  const detail = coverage.status === "missing-section"
    ? "缺少 ## Changelog coverage 段"
    : `缺少版本：${coverage.missing.map((m) => `${m.cli}@${m.version}`).join(", ")}`;
  console.error(`  → root review changelog coverage failed: ${detail}`);
  await createNotifyClient().notify({
    source: "watchdog",
    title: `每周 CLI 升级 · ${pending.runDate}（review 不完整：changelog 未逐版本覆盖）`,
    body: `Root review 已返回，但 Changelog coverage 校验未通过：${detail}。\n本次不发最终报告、不更新 reviewed 版本基线；本周变更下次 do-entry 仍会被判定待审。review 全文已留在 session ${childSessionId}，可人工核对。`,
    level: "error",
    metadata: { date: pending.runDate, changelogCoverage: coverage.status },
  }).catch(() => {});
  clearPending();
  process.exit(0);
}
const proposedFiled = fileProposedAsIssues(rootReview);
const metaFiled = fileChecklistMetaAsIssues(rootReview);
await deliverFinalReport(
  pending.runDate,
  pending.results,
  rootReview,
  proposedFiled,
  metaFiled,
  pending.modelAudit,
  pending.catalogPublish,
);
updateReviewedBaseline(pending);
clearPending();
console.log("  → final report delivered, pending file cleared");
