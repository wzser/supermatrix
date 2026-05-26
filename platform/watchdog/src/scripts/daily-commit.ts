import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createNotifyClient } from "../notify/console.js";
import {
  DAILY_COMMIT_ACTIVITY_WINDOW_MS,
  decideDailyCommitActivityGate,
  filterActivityRelevantDirtyFiles,
  getLastActivityMessageRunAtFromRows,
  splitDailyCommitResults,
  type MessageRunActivityRow,
} from "./daily-commit-activity-gate.js";
import { DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH, DAILY_COMMIT_IGNORE_POLICY_PROMPT } from "./daily-commit-ignore-policy.js";
import { runCodexReviewer } from "./daily-commit-reviewer.js";
import { classifyDailyCommitSkipRouting } from "./daily-commit-skip-routing.js";
import { detectStubToFormalTransitionFromDiff, isNovelClaudeMdIdentityChange } from "./stub-transition.js";

const SM_DB_PATH = process.env.SM_DB_PATH ?? "";
const SM_REPO_ROOT = process.env.SM_REPO_ROOT ?? "";
const SAFE_RELOAD = process.env.WATCHDOG_SAFE_RELOAD_PATH ?? `${SM_REPO_ROOT}/scripts/safe-reload.sh`;
const LARK = process.env.WATCHDOG_LARK_CLI_PATH ?? process.env.SM_LARK_CLI_PATH ?? "lark-cli";
const BITABLE_BASE = process.env.WATCHDOG_DAILY_COMMIT_BASE_TOKEN ?? "";
const BITABLE_TABLE = process.env.WATCHDOG_DAILY_COMMIT_TABLE_ID ?? "";
const SESSION_TABLE_BASE = process.env.WATCHDOG_SESSION_BASE_TOKEN ?? "";
const SESSION_TABLE_ID = process.env.WATCHDOG_SESSION_TABLE_ID ?? "";
const DAILY_COMMIT_FIELD = "Daily Commit";
const LOG_FILE = join(process.cwd(), "data", "daily-commits.log");
const GIT_USER = "watchdog";
const GIT_EMAIL = "watchdog@supermatrix.local";
// Wall-clock budget for the per-repo loop. Scheduler hard-kills at 30 min;
// reserve 12 min of headroom for writeLog / bitable sync / notify / reload after the loop.
// 2026-04-26 incident: 23 dirty repos × 120s reviewer timeout could in theory pile up to >30 min,
// and that morning the run was hard-killed mid-loop with no log/notify emitted.
const LOOP_BUDGET_MS = 18 * 60 * 1000;

type RepoResult = {
  name: string;
  committed: boolean;
  message: string;
  filesChanged: number;
  skippedReason: string;
  autoFixed?: boolean;
  deferred?: boolean;
  watchdogOwned?: boolean;
};

function git(args: string[], cwd: string): string {
  // maxBuffer 50MB: a stray un-gitignored venv can produce 30k+ files / 3MB+ in `ls-files --others`,
  // which overflows Node's 1MB default and throws ENOBUFS, killing the whole daily run.
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).trim();
}

function getDailyCommitEnabledSessions(): Set<string> {
  const raw = execFileSync(
    LARK,
    [
      "base", "+record-list",
      "--base-token", SESSION_TABLE_BASE,
      "--table-id", SESSION_TABLE_ID,
      "--limit", "500",
      "--field-id", "Session",
      "--field-id", DAILY_COMMIT_FIELD,
      "--format", "json",
    ],
    { encoding: "utf-8", timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
  );

  const parsed = JSON.parse(raw) as {
    ok?: boolean;
    data?: {
      fields?: string[];
      data?: unknown[][];
    };
    error?: { message?: string };
  };
  if (parsed.ok === false) {
    throw new Error(parsed.error?.message ?? "lark-cli record-list returned ok=false");
  }

  const fields = parsed.data?.fields ?? [];
  const rows = parsed.data?.data ?? [];
  const sessionIndex = fields.indexOf("Session");
  const dailyCommitIndex = fields.indexOf(DAILY_COMMIT_FIELD);
  if (sessionIndex < 0 || dailyCommitIndex < 0) {
    throw new Error(`missing Session or ${DAILY_COMMIT_FIELD} field in session table`);
  }

  const enabled = new Set<string>();
  for (const row of rows) {
    const session = row[sessionIndex];
    const dailyCommit = row[dailyCommitIndex];
    if (typeof session === "string" && dailyCommit === true) {
      enabled.add(session);
    }
  }
  return enabled;
}

function getAllRepos(enabledSessions: Set<string>): Array<{ name: string; path: string }> {
  // Source of truth: sessions.workdir in the SuperMatrix SQLite DB.
  // scope='child' is filtered out — those are ephemeral spawns with throwaway workdirs.
  // Non-git workdirs (e.g. data-only sessions like amzdata) silently skipped.
  // Eligibility is Feishu-authoritative: session table checkbox "Daily Commit"
  // must be checked, matching the Heartbeat / FP管辖 control-field pattern.
  const out = execFileSync(
    "sqlite3",
    [
      "-readonly",
      SM_DB_PATH,
      "-separator",
      "\t",
      "SELECT name, workdir FROM sessions WHERE scope='user' AND workdir != '' ORDER BY name;",
    ],
    { encoding: "utf-8", timeout: 10000 },
  ).trim();

  const repos: Array<{ name: string; path: string }> = [];
  const seenWorkdirs = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const workdir = line.slice(tab + 1);
    if (!enabledSessions.has(name)) continue;
    if (seenWorkdirs.has(workdir)) continue;
    seenWorkdirs.add(workdir);
    if (!existsSync(join(workdir, ".git"))) continue;
    repos.push({ name, path: workdir });
  }
  return repos;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getLastActivityMessageRunAt(sessionName: string, now: number): number | null {
  const threshold = now - DAILY_COMMIT_ACTIVITY_WINDOW_MS;
  const out = execFileSync(
    "sqlite3",
    [
      "-readonly",
      "-json",
      SM_DB_PATH,
      `SELECT m.started_at, m.prompt FROM message_runs m JOIN sessions s ON m.session_id=s.id WHERE s.name=${sqlString(sessionName)} AND m.started_at >= ${threshold} ORDER BY m.started_at DESC;`,
    ],
    { encoding: "utf-8", timeout: 5000 },
  ).trim();

  if (!out) return null;
  const parsed = JSON.parse(out) as unknown[];
  const rows: MessageRunActivityRow[] = parsed
    .map((row) => row as Partial<MessageRunActivityRow>)
    .filter((row): row is MessageRunActivityRow => Number.isFinite(row.started_at) && typeof row.prompt === "string");
  return getLastActivityMessageRunAtFromRows(rows);
}

function isDirty(repoPath: string): boolean {
  const status = git(["status", "--short"], repoPath);
  return status.length > 0;
}

function getDiff(repoPath: string): string {
  const tracked = git(["diff", "--stat"], repoPath);
  const staged = git(["diff", "--cached", "--stat"], repoPath);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], repoPath);
  const parts: string[] = [];
  if (tracked) parts.push("Modified:\n" + tracked);
  if (staged) parts.push("Staged:\n" + staged);
  if (untracked) parts.push("Untracked:\n" + untracked);
  return parts.join("\n\n");
}

function getDetailedDiff(repoPath: string): string {
  try {
    const diff = git(["diff"], repoPath);
    return diff.slice(0, 3000);
  } catch {
    return "";
  }
}

function countChangedFiles(repoPath: string): number {
  const status = git(["status", "--short"], repoPath);
  return status.split("\n").filter((l) => l.trim()).length;
}

function listChangedFiles(repoPath: string): string[] {
  // Parses `git status --porcelain` lines: "XY name" (tracked) or "?? name" (untracked).
  // Both forms have the path starting at column 3.
  const status = git(["status", "--porcelain"], repoPath);
  return status
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

function getLatestDirtyMtime(repoPath: string): number | null {
  const changedFiles = filterActivityRelevantDirtyFiles(listChangedFiles(repoPath));
  let latest: number | null = null;

  for (const file of changedFiles) {
    try {
      const mtime = statSync(join(repoPath, file)).mtimeMs;
      if (latest === null || mtime > latest) latest = mtime;
    } catch {
      // Deleted or path-quoted files have no readable mtime. If every changed
      // path is unreadable, the activity gate treats the dirty set as stale.
    }
  }

  return latest;
}

function detectStubToFormalTransition(repoPath: string) {
  try {
    const changed = listChangedFiles(repoPath);
    // `git diff HEAD` covers both staged and unstaged tracked changes; untracked
    // CLAUDE.md/AGENTS.md (no prior stub) won't show here, which is correct — that
    // case isn't a stub→formal transition.
    const diff = git(["diff", "HEAD", "--", "CLAUDE.md", "AGENTS.md"], repoPath);
    return detectStubToFormalTransitionFromDiff(diff, changed);
  } catch {
    return { match: false as const, reason: "git diff failed" };
  }
}

function tryAutoRemediate(repo: { name: string; path: string }, reviewReason: string): RepoResult | null {
  // Ask Codex whether the rejection is fixable by adding entries to .gitignore.
  // Cheap path: only attempts gitignore-based remediation, no other auto-edits.
  const prompt = `repo "${repo.name}" 的本次 daily-commit 被 reviewer 拒绝。拒绝原因：

${reviewReason}

${DAILY_COMMIT_IGNORE_POLICY_PROMPT}

请只判断一件事：能否通过给 .gitignore 追加几条 entries 来解决？
只有当文件完全落在 allowlist / auto-remediate 范围内、且不触碰 denylist / never auto-ignore / owner-routed 类别时，才回答 FIXABLE: YES。
如果需要 repo owner 判断，回答 FIXABLE: NO。

格式：
FIXABLE: YES|NO
ENTRIES:
<one path per line, empty if NO>`;

  let advice: string;
  try {
    advice = runCodexReviewer(prompt, repo.path);
  } catch {
    return null;
  }

  const fixableMatch = advice.match(/FIXABLE:\s*(YES|NO)/i);
  if (!fixableMatch || fixableMatch[1].toUpperCase() !== "YES") return null;

  const entriesBlock = advice.split(/ENTRIES:\s*/i)[1] ?? "";
  const entries = entriesBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("<"));
  if (entries.length === 0) return null;

  const gitignorePath = join(repo.path, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const existingSet = new Set(existing.split("\n").map((l) => l.trim()).filter(Boolean));
  const toAppend = entries.filter((e) => !existingSet.has(e));
  if (toAppend.length === 0) return null;

  const banner = "\n# auto-added by watchdog daily-commit\n";
  appendFileSync(gitignorePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + banner + toAppend.join("\n") + "\n");

  // Re-screen with Codex after .gitignore change. If Codex still thinks it is
  // UNSURE/CONFLICT, abandon the auto-fix and fall back to the original skip.
  const filesChanged = countChangedFiles(repo.path);
  const diff = getDiff(repo.path);
  const screen = `repo "${repo.name}" 的变更摘要（已追加 .gitignore 排除产物）：

${diff}

${DAILY_COMMIT_IGNORE_POLICY_PROMPT}

请判断是否可直接提交。回答 YES / UNSURE / CONFLICT，并生成 commit message（一行，英文，conventional commits）。
格式：
SAFETY: YES|UNSURE|CONFLICT
MESSAGE: <commit message>`;

  let result: string;
  try {
    result = runCodexReviewer(screen, repo.path);
  } catch {
    return null;
  }
  const safety = result.match(/SAFETY:\s*(YES|UNSURE|CONFLICT)/i)?.[1]?.toUpperCase();
  const msg = result.match(/MESSAGE:\s*(.+)/i)?.[1]?.trim();
  if (safety !== "YES" || !msg) return null;

  const committed = tryCommit(repo, msg, filesChanged);
  if (!committed.committed) return null;
  return { ...committed, autoFixed: true };
}

function processRepo(repo: { name: string; path: string }): RepoResult {
  const transition = detectStubToFormalTransition(repo.path);
  if (transition.match) {
    const filesChanged = countChangedFiles(repo.path);
    const target = transition.backend ?? "CLAUDE.md/AGENTS.md";
    const msg = `chore: replace init stub with ${transition.category}-category ${target} (fp-generate-init)`;
    return tryCommit(repo, msg, filesChanged);
  }

  const diff = getDiff(repo.path);
  const filesChanged = countChangedFiles(repo.path);

  const reviewPrompt = `你是一个代码审查助手。以下是 git repo "${repo.name}" 的未提交变更摘要：

${diff}

${DAILY_COMMIT_IGNORE_POLICY_PROMPT}

请判断：
1. 这些变更是否安全可以直接提交？回答 YES / UNSURE / CONFLICT
   - YES：clean 改动，可直接提交
   - UNSURE：看起来像运行产物 / 缓存 / 临时文件 / 未跟踪目录可能需要 .gitignore 之类的情况——进入第二轮深审
   - CONFLICT：仅限真正的 git merge 冲突（diff 里有 <<<<<<< / ======= / >>>>>>> 标记）或历史明显分叉。"我有点疑虑"不是 CONFLICT，那是 UNSURE。
2. 如果 YES，生成一个简洁的 commit message（一行，英文，conventional commits 格式）

格式：
SAFETY: YES|UNSURE|CONFLICT
MESSAGE: <commit message>`;

  const reviewResult = runCodexReviewer(reviewPrompt, repo.path);
  const safetyMatch = reviewResult.match(/SAFETY:\s*(YES|UNSURE|CONFLICT)/i);
  const messageMatch = reviewResult.match(/MESSAGE:\s*(.+)/i);
  const safety = safetyMatch ? safetyMatch[1].toUpperCase() : "UNSURE";
  const commitMsg = messageMatch ? messageMatch[1].trim() : `chore: daily commit for ${repo.name}`;

  if (safety === "YES") {
    return tryCommit(repo, commitMsg, filesChanged);
  }

  if (safety === "UNSURE") {
    const detailedDiff = getDetailedDiff(repo.path);
    const deepReviewPrompt = `你是一个高级代码审查员。repo "${repo.name}" 有未提交变更，第一轮 reviewer 判断为 UNSURE。

变更摘要：
${diff}

详细 diff（截取前 3000 字符）：
${detailedDiff}

${DAILY_COMMIT_IGNORE_POLICY_PROMPT}

请判断：
1. 这些变更是否安全可以提交？回答 YES 或 NO
2. 如果 YES，生成 commit message（一行，英文，conventional commits 格式）
3. 如果 NO，说明原因

格式：
DECISION: YES|NO
MESSAGE: <commit message or reason>`;

    const deepReviewResult = runCodexReviewer(deepReviewPrompt, repo.path);
    const decisionMatch = deepReviewResult.match(/DECISION:\s*(YES|NO)/i);
    const deepMsgMatch = deepReviewResult.match(/MESSAGE:\s*(.+)/i);
    const decision = decisionMatch ? decisionMatch[1].toUpperCase() : "NO";
    const deepMsg = deepMsgMatch ? deepMsgMatch[1].trim() : "";

    if (decision === "YES" && deepMsg) {
      return tryCommit(repo, deepMsg, filesChanged);
    }

    const skipReason = deepMsg || "codex reviewer judged unsafe";
    const remediated = tryAutoRemediate(repo, skipReason);
    if (remediated) return remediated;
    return { name: repo.name, committed: false, message: "", filesChanged, skippedReason: skipReason };
  }

  const conflictReason = "conflict detected by codex reviewer";
  // Reviewer can still misclassify "artifact-like" changes as CONFLICT.
  // Give auto-remediate a diff summary so it can judge whether .gitignore fixes apply.
  const remediated = tryAutoRemediate(repo, `${conflictReason}\n\n变更摘要供参考：\n${diff}`);
  if (remediated) return remediated;
  return { name: repo.name, committed: false, message: "", filesChanged, skippedReason: conflictReason };
}

function getSessionGroupId(name: string): string | null {
  try {
    const out = execFileSync(
      "sqlite3",
      ["-readonly", SM_DB_PATH, `SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id WHERE s.name='${name}' LIMIT 1`],
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function sendLarkMessage(groupId: string, text: string, as: "bot" | "user" = "bot"): void {
  execFileSync(LARK, ["im", "+messages-send", "--as", as, "--chat-id", groupId, "--text", text], { encoding: "utf-8", timeout: 10000 });
}

function detectNovelIdentityChange(repoPath: string): boolean {
  // Inspect the actual diff (not the reviewer's prose) to decide whether the .md
  // change in this repo is something FP needs to govern. Pre-2026-05-07 behavior
  // escalated on any reviewer-text mention of CLAUDE.md/AGENTS.md, which fired
  // on parenthetical "the .md change is fine, the issue is elsewhere" notes
  // (e.g. ainotes 2026-05-06 — flagged for data/ai-notes/ pipeline products,
  // not for the .md change). The new gate uses the diff itself; see
  // isNovelClaudeMdIdentityChange for the precise criterion.
  try {
    const changed = listChangedFiles(repoPath);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], repoPath)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const diff = git(["diff", "HEAD", "--", "CLAUDE.md", "AGENTS.md"], repoPath);
    return isNovelClaudeMdIdentityChange(diff, changed, untracked);
  } catch {
    return false;
  }
}

function routeSkippedToOwners(
  date: string,
  skipped: RepoResult[],
  repoPaths: Map<string, string>,
): { delegatedToOwner: number; escalatedToFp: number } {
  const fpEscalations: RepoResult[] = [];
  let delegatedToOwner = 0;

  for (const r of skipped) {
    const path = repoPaths.get(r.name);
    if (path && detectNovelIdentityChange(path)) {
      fpEscalations.push(r);
    }

    const routing = classifyDailyCommitSkipRouting(r.skippedReason);
    if (!routing.routeToOwner) {
      continue;
    }

    const groupId = getSessionGroupId(r.name);
    if (groupId) {
      try {
        const msg = `[daily-commit hint · ${date}]\n你的 repo "${r.name}" 今早自动提交被跳过。原因：\n${r.skippedReason}\n\n请按 ${DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH} 判断：如果是 repo-local 产物噪音，由 repo owner 维护 .gitignore；如果是源码/配置/数据/凭证/共享平台行为，请拆分、验证或保留未提交，不要用 ignore 掩盖。`;
        // --as user: per console-principles 行 132，"Triggering session processing → user identity"。
        // 这条 hint 是要触发对方 session 自己处理，不是被动通知，必须 --as user 才能进 dispatcher routing。
        sendLarkMessage(groupId, msg, "user");
        delegatedToOwner++;
      } catch (err) {
        console.error(`Failed to notify ${r.name}:`, (err as Error).message);
      }
    }
  }

  if (fpEscalations.length > 0) {
    const fpGroup = getSessionGroupId("first-principle");
    if (fpGroup) {
      try {
        const list = fpEscalations.map((r) => `- **${r.name}**: ${r.skippedReason.slice(0, 200)}`).join("\n");
        const msg = `[daily-commit · ${date}] 以下 session 出现非 stub→formal 的大幅 CLAUDE.md/AGENTS.md 修改（>=30 行 +/- 或新建身份文件），daily-commit reviewer 已跳过本次自动提交：\n\n${list}\n\n请 review session 身份级文档的演进规范：这类大段重写或体外新建是否应走 first-principle 模板更新流程？watchdog 自动放行的边界在哪里？必要时产出契约文档或更新 CLAUDE.md/AGENTS.md 模板。`;
        // 同上 — FP 需要被触发去 review 初始化机制，不是被动通知，--as user
        sendLarkMessage(fpGroup, msg, "user");
        return { delegatedToOwner, escalatedToFp: fpEscalations.length };
      } catch (err) {
        console.error("Failed to escalate to FP:", (err as Error).message);
      }
    }
  }
  return { delegatedToOwner, escalatedToFp: 0 };
}

function tryCommit(repo: { name: string; path: string }, msg: string, filesChanged: number): RepoResult {
  try {
    git(["-c", `user.name=${GIT_USER}`, "-c", `user.email=${GIT_EMAIL}`, "add", "-A"], repo.path);
    git(["-c", `user.name=${GIT_USER}`, "-c", `user.email=${GIT_EMAIL}`, "commit", "-m", msg], repo.path);
    return { name: repo.name, committed: true, message: msg, filesChanged, skippedReason: "" };
  } catch (err) {
    return { name: repo.name, committed: false, message: "", filesChanged, skippedReason: `git commit failed: ${(err as Error).message.slice(0, 100)}` };
  }
}

function syncToBitable(date: string, result: RepoResult): void {
  try {
    const record = JSON.stringify({
      date,
      repo_name: result.name,
      committed: result.committed ? "yes" : "no",
      commit_message: result.message,
      files_changed: String(result.filesChanged),
      skipped_reason: result.skippedReason,
      auto_fixed: result.autoFixed ? "yes" : "no",
    });
    execFileSync(LARK, [
      "base", "+record-upsert",
      "--base-token", BITABLE_BASE,
      "--table-id", BITABLE_TABLE,
      "--json", record,
    ], { timeout: 15000 });
  } catch (err) {
    console.error(`Failed to sync ${result.name} to bitable:`, (err as Error).message);
  }
}

async function notifyConsole(date: string, results: RepoResult[], options: { willReload?: boolean } = {}): Promise<void> {
  const { committed, skipped, deferred, watchdogOwned } = splitDailyCommitResults(results);
  const willReload = options.willReload ?? true;

  const bodyLines: string[] = [];
  for (const r of committed) {
    const tag = r.autoFixed ? "✅ [auto-fix]" : "✅";
    bodyLines.push(`- ${tag} **${r.name}**：${r.message} (${r.filesChanged} files)`);
  }
  for (const r of skipped) {
    bodyLines.push(`- ❌ **${r.name}**：${r.skippedReason} (${r.filesChanged} files)`);
  }
  if (watchdogOwned.length > 0) {
    for (const r of watchdogOwned.slice(0, 12)) {
      bodyLines.push(`- 🛠 **watchdog follow-up** **${r.name}**：${r.skippedReason} (${r.filesChanged} files)`);
    }
    if (watchdogOwned.length > 12) {
      bodyLines.push(`- 🛠 **watchdog follow-up**：+${watchdogOwned.length - 12} more`);
    }
  }
  if (deferred.length > 0) {
    const shown = deferred.slice(0, 12).map((r) => r.name).join(", ");
    const suffix = deferred.length > 12 ? `, +${deferred.length - 12} more` : "";
    bodyLines.push(`- ⏸ **deferred inactive/stale**：${deferred.length} repos (${shown}${suffix})`);
  }
  if (bodyLines.length === 0) bodyLines.push("_无需提交的变更_");
  bodyLines.push("");
  bodyLines.push(`共 ${committed.length} 个 repo 提交，${skipped.length} 个内容跳过，${watchdogOwned.length} 个 watchdog 自处理，${deferred.length} 个延后。${willReload ? "即将 reload。" : "不会 reload。"}`);

  const body = bodyLines.join("\n");
  console.log(`[Watchdog 每日提交] ${date}\n${body}`);

  const client = createNotifyClient();
  try {
    await client.notify({
      source: "watchdog",
      title: `每日提交 · ${date}`,
      body,
      level: skipped.length > 0 || watchdogOwned.length > 0 ? "warn" : "info",
      metadata: {
        date,
        committed: committed.length,
        skipped: skipped.length,
        watchdogOwned: watchdogOwned.length,
        deferred: deferred.length,
      },
    });
  } catch (err) {
    console.error("Failed to notify console:", (err as Error).message);
  }
}

function writeLog(date: string, results: RepoResult[]): void {
  const { committed, skipped, deferred, watchdogOwned } = splitDailyCommitResults(results);
  const entry = JSON.stringify({
    date,
    repos: results.map((r) => ({
      name: r.name,
      committed: r.committed,
      message: r.message,
      files_changed: r.filesChanged,
      ...(r.skippedReason ? { skipped_reason: r.skippedReason } : {}),
      ...(r.autoFixed ? { auto_fixed: true } : {}),
      ...(r.deferred ? { deferred: true } : {}),
      ...(r.watchdogOwned ? { watchdog_owned: true } : {}),
    })),
    total_committed: committed.length,
    total_skipped: skipped.length,
    total_deferred: deferred.length,
    total_watchdog_owned: watchdogOwned.length,
  });
  appendFileSync(LOG_FILE, entry + "\n");
}

function reload(results: RepoResult[]): void {
  console.log("Triggering reload...");
  const { committed, skipped, watchdogOwned } = splitDailyCommitResults(results);
  // dispatcher.parseCommand splits /reload --source <value> on whitespace and
  // doesn't support quoted strings, so any space / Chinese punct in the source
  // string would silently break the daily reload (issue 5e42333c). Keep this
  // ASCII single-token; structured details belong in daily-commits.log anyway.
  const source = `watchdog-daily-commit-${committed.length}c-${skipped.length}s-${watchdogOwned.length}w`;
  try {
    const out = execFileSync("/bin/zsh", [SAFE_RELOAD], {
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, SM_RELOAD_SOURCE: source },
    });
    console.log("Reload:", out.trim());
  } catch (err) {
    console.error("Reload failed:", (err as Error).message);
  }
}

// Main
const date = new Date().toISOString().slice(0, 10);
console.log(`[Daily Commit] ${date}\n`);

let repos: Array<{ name: string; path: string }>;
try {
  const enabledSessions = getDailyCommitEnabledSessions();
  repos = getAllRepos(enabledSessions);
  console.log(`Bitable Daily Commit enabled sessions: ${enabledSessions.size}; git repos eligible: ${repos.length}`);
} catch (err) {
  const result: RepoResult = {
    name: "daily-commit-control",
    committed: false,
    message: "",
    filesChanged: 0,
    skippedReason: `daily-commit control fetch failed: ${(err as Error).message.slice(0, 200)}`,
    watchdogOwned: true,
  };
  writeLog(date, [result]);
  await notifyConsole(date, [result], { willReload: false });
  process.exit(1);
}

const dirtyRepos = repos.filter((r) => isDirty(r.path));

if (dirtyRepos.length === 0) {
  console.log("All repos clean. Nothing to commit.");
  reload([]);
  process.exit(0);
}

console.log(`Found ${dirtyRepos.length} dirty repos:\n`);
const loopStart = Date.now();
const results: RepoResult[] = [];
for (const repo of dirtyRepos) {
  console.log(`Processing ${repo.name}...`);
  let result: RepoResult;
  const now = Date.now();
  const activityDecision = decideDailyCommitActivityGate({
    now,
    lastMessageRunAt: getLastActivityMessageRunAt(repo.name, now),
    latestDirtyMtime: getLatestDirtyMtime(repo.path),
    repoName: repo.name,
  });

  if (activityDecision.kind === "defer") {
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: countChangedFiles(repo.path),
      skippedReason: activityDecision.reason,
      deferred: true,
    };
  } else if (Date.now() - loopStart > LOOP_BUDGET_MS) {
    // Wall-clock budget exceeded — skip remaining repos so writeLog / notifyConsole / reload
    // still run before the scheduler's 30-min hard-kill. Without this, prior incidents
    // produced output:null / no log entry because the script never reached its tail.
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: countChangedFiles(repo.path),
      skippedReason: "skipped: daily-commit time budget (18min) exceeded — codex reviewer likely stalled",
      watchdogOwned: true,
    };
  } else {
    try {
      result = processRepo(repo);
    } catch (err) {
      // Per-repo isolation: a single repo's failure (e.g. Codex CLI error, git error,
      // huge diff overflowing a child's buffer) must not abort the whole daily run.
      const msg = (err as Error).message.slice(0, 200);
      result = {
        name: repo.name,
        committed: false,
        message: "",
        filesChanged: countChangedFiles(repo.path),
        skippedReason: `processing error: ${msg}`,
        watchdogOwned: true,
      };
    }
  }
  results.push(result);
  console.log(`  → ${result.committed ? "✅ committed" : "❌ skipped"}: ${result.message || result.skippedReason}\n`);
}

writeLog(date, results);
const skippedRepos = splitDailyCommitResults(results).skipped;
if (skippedRepos.length > 0) {
  try {
    const repoPaths = new Map(dirtyRepos.map((r) => [r.name, r.path]));
    routeSkippedToOwners(date, skippedRepos, repoPaths);
  } catch (err) {
    console.error("Routing failed (non-fatal):", (err as Error).message);
  }
}
for (const r of results) {
  syncToBitable(date, r);
}
await notifyConsole(date, results);
reload(results);
