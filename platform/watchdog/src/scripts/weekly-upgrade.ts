// "Do" entry：升级 + writeLog + 派 root review (fire-and-forget) + 写 pending file
// + 简短 Console 卡片。完事即退出（≤2min）。Report 由独立 cron weekly-upgrade-report.ts
// 接管，互不阻塞。
//
// 拆分动机（2026-05-07）：单 cron 把"升级"和"等 root review"绑死时，
// review 卡 30min/2h 就让整个 task 占住 scheduler 槽位、easy 撞 evidence_missing。
// 现在 do 这边只管动作 + 派单 + 留 handoff 文件，report 那边轮询 + 交付。

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createNotifyClient } from "../notify/console.js";

const CHECKLIST_FILE = join(process.cwd(), "data", "upgrade-review-checklist.md");
import {
  LOG_FILE,
  PENDING_FILE,
  ROOT_SESSION,
  SPAWN_API,
  type UpgradeResult,
  buildRootReviewSpawnBody,
  formatSpawnAdmissionError,
  formatUpgradeLines,
  writePending,
  writeReceipt,
} from "./_weekly-upgrade-shared.js";

const CLAUDE_BIN = process.env.WATCHDOG_CLAUDE_BIN ?? "claude";
const CODEX_BIN = process.env.WATCHDOG_CODEX_BIN ?? "codex";
const LARK_BIN = process.env.WATCHDOG_LARK_CLI_PATH ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
const SUPERMATRIX_DIR = process.env.SM_REPO_ROOT ?? process.cwd();
const NPM_BIN = process.env.WATCHDOG_NPM_BIN ?? "npm";

function readVersion(bin: string, parser: (s: string) => string): string {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf-8", timeout: 10000 });
    return parser(out.trim());
  } catch {
    return "unknown";
  }
}

const claudeVersion = () => readVersion(CLAUDE_BIN, (s) => s.split(/\s+/)[0]);
const codexVersion = () => readVersion(CODEX_BIN, (s) => s.replace(/^codex-cli\s+/, ""));
const larkVersion = () => readVersion(LARK_BIN, (s) => s.replace(/^lark-cli version\s+/, ""));

// All three fds "ignore": stdin prevents confirmation hang (2026-05-07 root cause);
// stdout/stderr prevents orphan grandchildren from holding scheduler's stdio pipe open
// (trigger.ts SIGKILL orphan bug — close event would otherwise fire 100 min late).
// We never use the captured output anyway — errors surface via catch(err).
const UPGRADE_STDIO: ("ignore" | "pipe")[] = ["ignore", "ignore", "ignore"];

function upgradeClaude(): UpgradeResult {
  const before = claudeVersion();
  try {
    execFileSync(CLAUDE_BIN, ["update"], { encoding: "utf-8", timeout: 300000, stdio: UPGRADE_STDIO });
    const after = claudeVersion();
    return { cli: "claude-code", before, after, changed: before !== after };
  } catch (err) {
    return { cli: "claude-code", before, after: before, changed: false, error: (err as Error).message.slice(0, 200) };
  }
}

function upgradeCodex(): UpgradeResult {
  const before = codexVersion();
  try {
    execFileSync(NPM_BIN, ["install", "-g", "@openai/codex@latest"], { encoding: "utf-8", timeout: 300000, stdio: UPGRADE_STDIO });
    const after = codexVersion();
    return { cli: "codex", before, after, changed: before !== after };
  } catch (err) {
    return { cli: "codex", before, after: before, changed: false, error: (err as Error).message.slice(0, 200) };
  }
}

function upgradeLarkCli(): UpgradeResult {
  // @larksuite/cli 是 supermatrix 项目的 dep，升级走 npm install --save 改 package.json + lock
  const before = larkVersion();
  try {
    execFileSync(NPM_BIN, ["install", "@larksuite/cli@latest", "--save"], {
      cwd: SUPERMATRIX_DIR,
      encoding: "utf-8",
      timeout: 300000,
      stdio: UPGRADE_STDIO,
    });
    const after = larkVersion();
    return { cli: "lark-cli", before, after, changed: before !== after };
  } catch (err) {
    return { cli: "lark-cli", before, after: before, changed: false, error: (err as Error).message.slice(0, 200) };
  }
}

function writeLog(date: string, results: UpgradeResult[]): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify({ date, results }) + "\n");
}

async function kickoffRootReview(changes: UpgradeResult[]): Promise<{ childSessionId?: string; error?: string }> {
  const list = changes.map((c) => `- ${c.cli}: ${c.before} → ${c.after}`).join("\n");
  const checklist = existsSync(CHECKLIST_FILE)
    ? readFileSync(CHECKLIST_FILE, "utf-8")
    : "(checklist 文件缺失，按既有 cluster 顺势检查 claude-code / codex / lark-cli 调用面)";

  const prompt = `本周 watchdog 自动升级了以下 CLI：

${list}

请按下面 **Checklist** 逐项核对 changelog，再给出处理决定。

==================================================================
【Checklist（每项必须显式标注，不要跳）】
状态用 [✓] / [⚠️ <一句原因>] / [N/A <原因>]
==================================================================

${checklist}

==================================================================
【Checklist 自身的演化（meta review）】
==================================================================
本次 review 你做完上面 17 项（或现 checklist 全部）核对后，反思一下：

- 这次 changelog 有没有暴露 checklist **没覆盖到**的 SuperMatrix 调用面/失败模式？（如有 → 提议增加）
- checklist 里有没有项已经**长期 N/A** 或**信息冗余**？（如有 → 提议删除/合并）
- 有没有项措辞**模糊到容易判错**？（如有 → 提议改写）

把建议放在 ## Checklist meta 段，每条独立一行，watchdog 收到后会 file 成 issue 由人审。
格式示例：
\`+ [claude-code] 检查 reasoning_text 字段防御性解析: 上轮 codex 那边踩过类似空 token 边界，claude 也该列入\`
\`- [lark-cli] event +subscribe --compact: 1.0.21 起官方推 event consume，老命令将进入维护期，本项可在 1.0.25 后删\`
\`~ [codex] 默认模型项: 措辞太宽，建议改为"检查 codex --version 输出与本仓 backend-codex/index.ts 默认模型常量是否一致"\`

如果本次没建议，写"无"即可。

==================================================================
【处理决定（在 checklist 与 meta 之后给出）】
==================================================================

档 1：自动修复（直接动手）
  适用：checklist 里任何 [⚠️] 项属于"低风险机械修复"（重命名 flag、替换函数名、补必传参数等改动小且语义不变）
  动作：直接改 SuperMatrix/src 文件 + git commit
  commit message 形如 "fix(deps): adapt to <cli>@<new-version> <change-desc>"

档 2：写方案推给人工（不要动手改）
  适用：
  - 风险高 / 影响多模块 / 需要权衡的兼容修复
  - 新功能可接入（写明 feature 名 / 启用后能做什么 / 实施代价初判）
  - 行为变更需要全局策略调整
  动作：写 title + ≤3 行方案，不 commit

==================================================================
【回执格式】严格按此格式输出，watchdog 会原样转发到 Console 群：
==================================================================

## Checklist
（按 checklist 文件给出的 cluster 与项目顺序逐条标，每行一项）

### claude-code
- [...] <项目>
...

### codex
- [...] <项目>
...

### lark-cli
- [...] <项目>
...

## Checklist meta
- + [cluster] <新增检查项>: <一句话说明 / 为什么要加>
- - [cluster] <既有项关键词>: <为什么要删>
- ~ [cluster] <既有项关键词>: <改写建议>
（或 "无"）

## Auto-fixed
- <description> (commit: <短 hash> in <repo>)
（或 "无"）

## Proposed for human
- **<title>**: <one-line summary>
  方案/原因: <2-3 lines>
（或 "无"）

==================================================================
【no-cascade 强约束】
==================================================================
- 不要 spawn 其它 session
- 不要触发 atp / scheduler / 任何 test run
- 档 1 自己动手，不要转包给别的 session
- 修复完只在 SuperMatrix repo commit + 在 reply 里列出，不要再发额外卡片
- 完工 spawn-back 给 watchdog 时不要用 --no-notify`;

  try {
    const res = await fetch(SPAWN_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildRootReviewSpawnBody(prompt)),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { error: formatSpawnAdmissionError(res.status, body) };
    }
    const data = (await res.json()) as { ok?: boolean; childSessionId?: string };
    if (!data.ok || !data.childSessionId) return { error: "spawn returned invalid response" };
    return { childSessionId: data.childSessionId };
  } catch (err) {
    return { error: (err as Error).message.slice(0, 200) };
  }
}

async function notifyInitial(
  date: string,
  results: UpgradeResult[],
  spawn: { childSessionId?: string; error?: string } | null,
): Promise<void> {
  const { lines, changed, failed } = formatUpgradeLines(results);
  const sections = [lines.join("\n")];
  if (spawn) {
    if (spawn.childSessionId) {
      sections.push(`---\nRoot review 已派出（childSessionId=${spawn.childSessionId}）。完整两档报告由 weekly-upgrade-report cron 完工时单独发出，最迟 8h 内（${date} 13:00 前）。`);
    } else {
      sections.push(`---\n⚠️ Root review 派单失败：${spawn.error}。本次 review 跳过，已是最新版本部分不影响。`);
    }
  }
  const body = sections.join("\n\n");
  console.log(`[Weekly CLI upgrade · do] ${date}\n${body}`);
  try {
    await createNotifyClient().notify({
      source: "watchdog",
      title: `每周 CLI 升级 · ${date}（升级阶段）`,
      body,
      level: failed > 0 ? "error" : "info",
      metadata: {
        date, changed, failed, total: results.length,
        spawned: spawn?.childSessionId ? "yes" : "no",
      },
    });
  } catch (err) {
    console.error("Notify failed:", (err as Error).message);
  }
}

const date = new Date().toISOString().slice(0, 10);
console.log(`[Weekly CLI upgrade · do] ${date}`);

const results: UpgradeResult[] = [upgradeClaude(), upgradeCodex(), upgradeLarkCli()];
writeLog(date, results);
writeReceipt({ date, results });

const changes = results.filter((r) => r.changed);
let spawn: { childSessionId?: string; error?: string } | null = null;
if (changes.length > 0) {
  spawn = await kickoffRootReview(changes);
  if (spawn.childSessionId) {
    writePending({
      runDate: date,
      spawnedAt: Date.now(),
      childSessionId: spawn.childSessionId,
      results,
    });
    console.log(`Pending review handoff written: ${PENDING_FILE}`);
  }
}

await notifyInitial(date, results, spawn);
