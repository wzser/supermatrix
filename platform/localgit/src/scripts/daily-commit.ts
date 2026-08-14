import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createNotifyClient } from "../notify/console.js";
import { businessDate, loadDailyCommitGovernedRepos, SM_DB_PATH, SM_REPO_ROOT } from "./localgit-context.js";
import {
  getLastActivityMessageRunAtFromRows,
  shouldReloadAfterDailyCommit,
  splitDailyCommitResults,
  type MessageRunActivityRow,
} from "./daily-commit-activity-gate.js";
import { DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH } from "./daily-commit-ignore-policy.js";
import { formatRunHealthLine, summarizeRunHealth } from "./daily-commit-run-health.js";
import { classifyDailyCommitSkipRouting } from "./daily-commit-skip-routing.js";
import {
  JUDGMENT_PARAMS,
  OWNER_DECISION_RUBRIC_PATH,
  OWNER_DECISION_RUBRIC_VERSION,
  buildVerdictCache,
  decideInFlightGate,
  deriveLastReviewedAt,
  orderReposForProcessing,
} from "./daily-commit-judgment-matrix.js";
import {
  GIT_USER,
  applyDispositions,
  buildMustReviewFailureReason,
  collectStatusEntries,
  defaultSuggestionFor,
  detectNovelIdentityChange,
  detectStubToFormalTransition,
  getBranch,
  getCommitParents,
  getDirtyFingerprint,
  getHead,
  getLatestDirtyMtime,
  isDirty,
  judgeRepo,
  listChangedFiles,
  tryCommitFiles,
  type RepoResult,
} from "./daily-commit-pipeline.js";
import {
  buildDailyCommitDispatchId,
  loadOwnerNotificationHistory,
  shouldNotifyOwner,
} from "./daily-commit-owner-notify-gate.js";
import {
  buildFpIdentityDocEscalation,
  spawnFpIdentityDocEscalation,
} from "./daily-commit-fp-escalation.js";
import { buildDailyCommitBitableRecord } from "./daily-commit-bitable.js";
import { maybeCommitResultToHold } from "./daily-commit-hold.js";
import { buildHoldReviewDispatch, spawnHoldReview } from "./daily-commit-hold-dispatch.js";
import { writeDailyRunState } from "./daily-commit-verify.js";
import {
  appendGitLedgerEntry,
  buildCommitLedgerEntry,
  buildHoldLedgerEntry,
  buildSkipLedgerEntry,
  readGitLedgerEntries,
} from "./git-ledger.js";

const SAFE_RELOAD = process.env.LOCALGIT_SAFE_RELOAD ?? join(SM_REPO_ROOT, "scripts/safe-reload.sh");
const LARK = process.env.SM_LARK_CLI_PATH
  ?? process.env.LOCALGIT_LARK_CLI_PATH
  ?? join(SM_REPO_ROOT, "node_modules/.bin/lark-cli");
const BITABLE_BASE = "P4HZbIvtaaRDGmsbillcUoHhnXs";
const BITABLE_TABLE = "tblREDACTEDTABLEID";
const LOG_FILE = join(process.cwd(), "data", "daily-commits.log");
const GIT_LEDGER_FILE = join(process.cwd(), "data", "git-ledger.jsonl");
const DISPATCH_LOG_FILE = join(process.cwd(), "data", "daily-commit-dispatches.jsonl");
const DECISION_LOG_FILE = join(process.cwd(), "data", "daily-commit-decisions.jsonl");
// Wall-clock budget for the per-repo loop (SOP param.loop_budget_min). Scheduler
// hard-kills at 30 min; reserve headroom for writeLog / bitable sync / notify / reload.
const LOOP_BUDGET_MS = JUDGMENT_PARAMS.loopBudgetMs;

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getLastActivityMessageRunAt(sessionName: string, now: number): number | null {
  const threshold = now - JUDGMENT_PARAMS.inflightWindowMs;
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

function recordGitLedger(runId: string, repo: { name: string; path: string }, result: RepoResult): void {
  try {
    const branch = result.branch ?? getBranch(repo.path);
    const headBefore = result.headBefore ?? getHead(repo.path);
    const headAfter = result.headAfter ?? headBefore;
    const changedFiles = result.changedFiles ?? listChangedFiles(repo.path);

    if (result.committed) {
      appendGitLedgerEntry(GIT_LEDGER_FILE, buildCommitLedgerEntry({
        runId,
        repo: repo.name,
        repoPath: repo.path,
        branch,
        actor: GIT_USER,
        headBefore,
        headAfter,
        parents: result.parents ?? getCommitParents(repo.path, headAfter),
        message: result.message,
        filesChanged: result.filesChanged,
        changedFiles,
        perFileDispositions: result.dispositions,
        decisionSource: result.decisionSource,
      }));
      return;
    }

    appendGitLedgerEntry(GIT_LEDGER_FILE, buildSkipLedgerEntry({
      runId,
      repo: repo.name,
      repoPath: repo.path,
      branch,
      actor: GIT_USER,
      head: headAfter,
      filesChanged: result.filesChanged,
      changedFiles,
      skippedReason: result.skippedReason || "not committed",
      dirtyFingerprint: result.dirtyFingerprint,
      perFileDispositions: result.dispositions,
      decisionSource: result.decisionSource,
    }));
  } catch (err) {
    console.error(`Failed to write git ledger for ${repo.name}:`, (err as Error).message);
  }
}

function recordHoldLedger(runId: string, repo: { name: string; path: string }, result: RepoResult): void {
  if (!result.holdBranch || !result.holdCommit || !result.holdOriginalBranch || !result.holdOriginalHead || !result.holdFiles) return;
  appendGitLedgerEntry(GIT_LEDGER_FILE, buildHoldLedgerEntry({
    runId,
    repo: repo.name,
    repoPath: repo.path,
    actor: GIT_USER,
    originalBranch: result.holdOriginalBranch,
    originalHead: result.holdOriginalHead,
    holdBranch: result.holdBranch,
    holdCommit: result.holdCommit,
    message: `wip(hold): persist disputed working set for ${repo.name}`,
    changedFiles: result.holdFiles,
    dirtyFingerprint: result.dirtyFingerprint ?? "unknown",
    perFileDispositions: result.dispositions,
    decisionSource: result.decisionSource,
  }));
}

function dispatchHoldReview(date: string, runId: string, repo: { name: string; path: string }, result: RepoResult): void {
  if (!result.holdBranch || !result.holdCommit || !result.holdOriginalBranch || !result.holdFiles || !result.dirtyFingerprint) return;
  const dispatch = buildHoldReviewDispatch({
    date,
    repo: repo.name,
    repoPath: repo.path,
    originalBranch: result.holdOriginalBranch,
    holdBranch: result.holdBranch,
    holdCommit: result.holdCommit,
    dirtyFingerprint: result.dirtyFingerprint,
    files: result.holdFiles,
  });
  try {
    const receipt = spawnHoldReview(dispatch);
    appendDispatchLog({
      date, runId, kind: "hold_review", targetSession: repo.name, repo: repo.name,
      status: "sent", message: dispatch.payload.prompt, dirtyFingerprint: result.dirtyFingerprint,
      clientRequestId: dispatch.clientRequestId, verificationToken: dispatch.verificationToken,
      acceptedReceipt: receipt.receiptSummary, spawnResponse: JSON.stringify(receipt.body),
    });
  } catch (error) {
    appendDispatchLog({
      date, runId, kind: "hold_review", targetSession: repo.name, repo: repo.name,
      status: "failed", message: dispatch.payload.prompt, dirtyFingerprint: result.dirtyFingerprint,
      clientRequestId: dispatch.clientRequestId, verificationToken: dispatch.verificationToken,
      error: (error as Error).message,
    });
  }
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

function sendLarkMessage(groupId: string, text: string, as: "bot" | "user" = "bot"): string {
  return execFileSync(LARK, ["im", "+messages-send", "--as", as, "--chat-id", groupId, "--text", text], { encoding: "utf-8", timeout: 10000 }).trim();
}

function appendDispatchLog(entry: {
  date: string;
  runId?: string;
  dispatchId?: string;
  kind: "owner_hint" | "fp_escalation" | "hold_review";
  targetSession: string;
  groupId?: string;
  status: "sent" | "failed" | "suppressed";
  message: string;
  repo?: string;
  dirtyFingerprint?: string;
  skippedReason?: string;
  suppressionReason?: string;
  clientRequestId?: string;
  verificationToken?: string;
  acceptedReceipt?: string;
  spawnResponse?: string;
  larkResponse?: string;
  error?: string;
}): void {
  try {
    const { larkResponse, spawnResponse, error, ...rest } = entry;
    appendFileSync(
      DISPATCH_LOG_FILE,
      JSON.stringify({
        recorded_at: new Date().toISOString(),
        ...rest,
        message_hash: createHash("sha256").update(rest.message).digest("hex"),
        lark_response: larkResponse?.slice(0, 2000),
        spawn_response: spawnResponse?.slice(0, 2000),
        error: error?.slice(0, 500),
      }) + "\n",
    );
  } catch (err) {
    console.error("Failed to write daily-commit dispatch log:", (err as Error).message);
  }
}

function routeSkippedToOwners(
  date: string,
  runId: string,
  skipped: RepoResult[],
  repoPaths: Map<string, string>,
): { delegatedToOwner: number; escalatedToFp: number } {
  const fpEscalations: RepoResult[] = [];
  let delegatedToOwner = 0;
  const ownerNotificationHistory = loadOwnerNotificationHistory({
    dispatchLogFile: DISPATCH_LOG_FILE,
    decisionLogFile: DECISION_LOG_FILE,
    gitLedgerFile: GIT_LEDGER_FILE,
  });

  for (const r of skipped) {
    const routing = classifyDailyCommitSkipRouting(r.skippedReason);
    if (!routing.routeToOwner) {
      continue;
    }

    const notifyGate = shouldNotifyOwner({
      date,
      repo: r.name,
      dirtyFingerprint: r.dirtyFingerprint,
      skippedReason: r.skippedReason,
      currentRunId: runId,
      history: ownerNotificationHistory,
    });
    if (notifyGate.kind === "suppress") {
      appendDispatchLog({
        date,
        runId,
        kind: "owner_hint",
        targetSession: r.name,
        repo: r.name,
        status: "suppressed",
        message: "",
        dirtyFingerprint: r.dirtyFingerprint,
        skippedReason: r.skippedReason,
        suppressionReason: notifyGate.reason,
      });
      continue;
    }

    const path = repoPaths.get(r.name);
    if (path && detectNovelIdentityChange(path)) {
      fpEscalations.push(r);
    }

    const groupId = getSessionGroupId(r.name);
    if (groupId) {
      // Owner asks must carry the rubric + a pre-judged default (rubric §D); a bare
      // question invites freestyle, repo-by-repo inconsistent decisions.
      const msg = `[daily-commit hint · ${date}]\n关联ID：${notifyGate.dispatchId}\nDirty-Fingerprint：${r.dirtyFingerprint ?? "unknown"}\n\n你的 repo "${r.name}" 今早自动提交被跳过。原因：\n${r.skippedReason}\n\n裁决准则：${OWNER_DECISION_RUBRIC_PATH}（${OWNER_DECISION_RUBRIC_VERSION}）。文件类答案只能是 commit / ignore / keep_dirty（§A 四问）；分支/冲突类按 §B。\nlocalgit 预判默认项：${defaultSuggestionFor(r)}。\n请回「默认」或「选 X + 一句理由」；ignore 类目细则见 ${DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH}。`;
      try {
        // Owner hints are human decision notices. Machine-to-session delegation
        // must use spawn2.0/API instead of impersonating user input.
        const larkResponse = sendLarkMessage(groupId, msg);
        appendDispatchLog({
          date,
          runId,
          dispatchId: notifyGate.dispatchId,
          kind: "owner_hint",
          targetSession: r.name,
          repo: r.name,
          groupId,
          status: "sent",
          message: msg,
          dirtyFingerprint: r.dirtyFingerprint,
          skippedReason: r.skippedReason,
          larkResponse,
        });
        delegatedToOwner++;
      } catch (err) {
        appendDispatchLog({
          date,
          runId,
          dispatchId: notifyGate.dispatchId,
          kind: "owner_hint",
          targetSession: r.name,
          repo: r.name,
          groupId,
          status: "failed",
          message: msg,
          dirtyFingerprint: r.dirtyFingerprint,
          skippedReason: r.skippedReason,
          error: (err as Error).message,
        });
        console.error(`Failed to notify ${r.name}:`, (err as Error).message);
      }
    }
  }

  if (fpEscalations.length > 0) {
    let escalatedToFp = 0;
    for (const r of fpEscalations) {
      const fpDispatchId = buildDailyCommitDispatchId({
        date,
        repo: r.name,
        dirtyFingerprint: r.dirtyFingerprint,
        skippedReason: r.skippedReason,
      });
      const escalation = buildFpIdentityDocEscalation({
        date,
        repo: r.name,
        skippedReason: r.skippedReason,
        dirtyFingerprint: r.dirtyFingerprint,
        dispatchId: fpDispatchId,
      });
      try {
        const receipt = spawnFpIdentityDocEscalation(escalation);
        appendDispatchLog({
          date,
          runId,
          dispatchId: fpDispatchId,
          kind: "fp_escalation",
          targetSession: "first-principle",
          repo: r.name,
          status: "sent",
          message: escalation.payload.prompt,
          dirtyFingerprint: r.dirtyFingerprint,
          skippedReason: r.skippedReason,
          clientRequestId: escalation.clientRequestId,
          verificationToken: escalation.verificationToken,
          acceptedReceipt: receipt.receiptSummary,
          spawnResponse: JSON.stringify(receipt.body),
        });
        escalatedToFp++;
      } catch (err) {
        appendDispatchLog({
          date,
          runId,
          dispatchId: fpDispatchId,
          kind: "fp_escalation",
          targetSession: "first-principle",
          status: "failed",
          repo: r.name,
          message: escalation.payload.prompt,
          dirtyFingerprint: r.dirtyFingerprint,
          skippedReason: r.skippedReason,
          clientRequestId: escalation.clientRequestId,
          verificationToken: escalation.verificationToken,
          error: (err as Error).message,
        });
        console.error(`Failed to escalate ${r.name} to FP:`, (err as Error).message);
      }
    }
    return { delegatedToOwner, escalatedToFp };
  }
  return { delegatedToOwner, escalatedToFp: 0 };
}

function syncToBitable(date: string, result: RepoResult): void {
  try {
    const record = JSON.stringify(buildDailyCommitBitableRecord(date, result));
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

function isMustReviewBacklogResult(result: RepoResult): boolean {
  return Boolean(result.mustReviewBacklog || /stale must-review dirty set/i.test(result.skippedReason));
}

async function notifyConsole(date: string, results: RepoResult[], options: { willReload?: boolean } = {}): Promise<void> {
  const { committed, skipped, deferred, localgitOwned } = splitDailyCommitResults(results);
  const mustReviewBacklog = localgitOwned.filter(isMustReviewBacklogResult);
  const willReload = options.willReload ?? true;

  if (committed.length === 0 && skipped.length === 0 && localgitOwned.length === 0) {
    console.log(`[Localgit 每日提交] ${date}\nNo actionable git changes; ${deferred.length} quiet-deferred repos recorded in ${LOG_FILE}.`);
    return;
  }

  const bodyLines: string[] = [];
  for (const r of committed) {
    const tag = r.autoFixed ? "✅ [auto-fix]" : "✅";
    const partial = r.leftoverSummary ? `（partial，遗留 ${r.leftoverSummary}）` : "";
    // A repo that committed its L0/manifest-safe subset while the reviewer was down
    // must not read as a fully judged run — the gray zone is still unjudged.
    const degraded = r.reviewerFailure ? "（reviewer 故障，仅落库安全子集）" : "";
    bodyLines.push(`- ${tag} **${r.name}**：${r.message} (${r.filesChanged} files)${partial}${degraded}`);
  }
  for (const r of skipped) {
    bodyLines.push(`- ❌ **${r.name}**：${r.skippedReason} (${r.filesChanged} files)`);
  }
  if (localgitOwned.length > 0) {
    for (const r of localgitOwned.slice(0, 12)) {
      bodyLines.push(`- 🛠 **localgit follow-up** **${r.name}**：${r.skippedReason} (${r.filesChanged} files)`);
    }
    if (localgitOwned.length > 12) {
      bodyLines.push(`- 🛠 **localgit follow-up**：+${localgitOwned.length - 12} more`);
    }
  }
  if (mustReviewBacklog.length > 0) {
    bodyLines.push(`- must-review backlog：${mustReviewBacklog.length} repos queued for localgit review, not quiet-deferred`);
  }
  if (deferred.length > 0) {
    bodyLines.push(`- deferred quietly：${deferred.length} repos recorded in local log`);
  }
  const health = summarizeRunHealth(results);
  bodyLines.push(formatRunHealthLine(health));
  if (bodyLines.length === 0) bodyLines.push("_无需提交的变更_");
  bodyLines.push("");
  bodyLines.push(`共 ${committed.length} 个 repo 提交，${skipped.length} 个内容跳过，${localgitOwned.length} 个 localgit 自处理，${deferred.length} 个延后。${willReload ? "即将 reload。" : "不会 reload。"}`);

  const body = bodyLines.join("\n");
  console.log(`[Localgit 每日提交] ${date}\n${body}`);

  const client = createNotifyClient();
  try {
    await client.notify({
      source: "localgit",
      title: `每日提交 · ${date}`,
      body,
      level: skipped.length > 0 || localgitOwned.length > 0 ? "warn" : "info",
      metadata: {
        date,
        committed: committed.length,
        skipped: skipped.length,
        localgitOwned: localgitOwned.length,
        mustReviewBacklog: mustReviewBacklog.length,
        deferred: deferred.length,
        fastPathCommitted: health.fastPathCommitted,
        reviewerFailures: health.reviewerFailures,
        pendingOwner: health.pendingOwner,
      },
    });
  } catch (err) {
    console.error("Failed to notify console:", (err as Error).message);
  }
}

function writeLog(date: string, results: RepoResult[]): void {
  const { committed, skipped, deferred, localgitOwned } = splitDailyCommitResults(results);
  const mustReviewBacklog = localgitOwned.filter(isMustReviewBacklogResult);
  const entry = JSON.stringify({
    date,
    repos: results.map((r) => ({
      name: r.name,
      committed: r.committed,
      message: r.message,
      files_changed: r.filesChanged,
      ...(r.skippedReason ? { skipped_reason: r.skippedReason } : {}),
      ...(r.reviewerFailure ? { reviewer_failure: r.reviewerFailure } : {}),
      ...(r.leftoverSummary ? { left_in_worktree: r.leftoverSummary } : {}),
      ...(r.decisionSource ? { decision_source: r.decisionSource } : {}),
      ...(r.autoFixed ? { auto_fixed: true } : {}),
      ...(r.deferred ? { deferred: true } : {}),
      ...(r.localgitOwned ? { localgit_owned: true } : {}),
      ...(isMustReviewBacklogResult(r) ? { must_review_backlog: true } : {}),
    })),
    total_committed: committed.length,
    total_skipped: skipped.length,
    total_deferred: deferred.length,
    total_localgit_owned: localgitOwned.length,
    total_must_review_backlog: mustReviewBacklog.length,
  });
  appendFileSync(LOG_FILE, entry + "\n");
}

function reload(results: RepoResult[]): void {
  console.log("Triggering reload...");
  const { committed, skipped, localgitOwned } = splitDailyCommitResults(results);
  // dispatcher.parseCommand splits /reload --source <value> on whitespace and
  // doesn't support quoted strings, so any space / Chinese punct in the source
  // string would silently break the daily reload (issue 5e42333c). Keep this
  // ASCII single-token; structured details belong in daily-commits.log anyway.
  const source = `localgit-daily-commit-${committed.length}c-${skipped.length}s-${localgitOwned.length}w`;
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
const runStartedAt = new Date();
const date = businessDate(runStartedAt);
const runId = `daily-${runStartedAt.toISOString()}`;
console.log(`[Daily Commit] ${date}\n`);

let repos: Array<{ name: string; path: string }> = [];
try {
  const selected = loadDailyCommitGovernedRepos();
  repos = selected.repos;
  console.log(`Daily-commit governed sessions: ${selected.governedSessionCount}; git repos eligible: ${repos.length}`);
} catch (err) {
  const result: RepoResult = {
    name: "daily-commit-session-selection",
    committed: false,
    message: "",
    filesChanged: 0,
    skippedReason: `daily-commit session selection failed: ${(err as Error).message.slice(0, 200)}`,
    localgitOwned: true,
  };
  writeLog(date, [result]);
  await notifyConsole(date, [result], { willReload: false });
  process.exit(1);
}

// Supervised canary knob: LOCALGIT_DAILY_COMMIT_ONLY=repo1,repo2 limits a manual run
// to named repos (small blast radius while observing a behavior change live).
const onlyRepos = (process.env.LOCALGIT_DAILY_COMMIT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (onlyRepos.length > 0) {
  repos = repos.filter((r) => onlyRepos.includes(r.name));
  console.log(`Canary filter active: ${repos.map((r) => r.name).join(", ") || "(no match)"}`);
}

const dirtyRepos = repos.filter((r) => isDirty(r.path));
writeDailyRunState(join(process.cwd(), "data", "run-state", "latest-daily-run.json"), {
  runId,
  repos: dirtyRepos.map((repo) => ({
    name: repo.name,
    path: repo.path,
    dirtyBefore: collectStatusEntries(repo.path).map((entry) => entry.file),
  })),
});

if (dirtyRepos.length === 0) {
  console.log("All repos clean. Nothing to commit.");
  process.exit(0);
}

// SOP Step 6 ①: least-recently-reviewed first (never-reviewed first, oldest dirt
// first inside that group) — replaces alphabetical order which starved the tail.
const ledgerEntries = readGitLedgerEntries(GIT_LEDGER_FILE);
const verdictCache = buildVerdictCache(ledgerEntries);
const lastReviewedAt = deriveLastReviewedAt(ledgerEntries);
const dirtyMtimeByRepo = new Map<string, number>();
for (const repo of dirtyRepos) {
  if (!lastReviewedAt.has(repo.name)) {
    const mtime = getLatestDirtyMtime(repo.path);
    if (mtime !== null) dirtyMtimeByRepo.set(repo.name, mtime);
  }
}
const orderedRepos = orderReposForProcessing(dirtyRepos, lastReviewedAt, dirtyMtimeByRepo);

console.log(`Found ${orderedRepos.length} dirty repos (least-recently-reviewed first):\n`);
const loopStart = Date.now();
const results: RepoResult[] = [];
for (const repo of orderedRepos) {
  console.log(`Processing ${repo.name}...`);
  let result: RepoResult;
  const changedEntries = collectStatusEntries(repo.path);
  const changedFiles = changedEntries.map((e) => e.file);
  let dirtyFingerprint: string | undefined;
  const getCurrentDirtyFingerprint = (): string | undefined => {
    if (dirtyFingerprint) return dirtyFingerprint;
    try {
      dirtyFingerprint = getDirtyFingerprint(repo.path);
      return dirtyFingerprint;
    } catch {
      return undefined;
    }
  };

  const transition = detectStubToFormalTransition(repo.path);
  if (transition.match) {
    const target = transition.backend ?? "CLAUDE.md/AGENTS.md";
    const msg = `chore: replace init stub with ${transition.category}-category ${target} (fp-generate-init)`;
    const stubFiles = changedFiles.filter((f) => f === "CLAUDE.md" || f === "AGENTS.md");
    result = tryCommitFiles(repo, msg, stubFiles.length > 0 ? stubFiles : changedFiles).result;
    recordGitLedger(runId, repo, result);
    results.push(result);
    console.log(`  → ${result.committed ? "✅ committed" : "❌ skipped"}: ${result.message || result.skippedReason}\n`);
    continue;
  }

  // SOP Step 6 ②: in-flight gate (inverted vs legacy activity gate) — recently
  // active sessions get room; stale+inactive repos are processed, not backlogged.
  const now = Date.now();
  let inflight: ReturnType<typeof decideInFlightGate>;
  try {
    inflight = decideInFlightGate({ now, lastMessageRunAt: getLastActivityMessageRunAt(repo.name, now) });
  } catch {
    inflight = { kind: "process" };
  }
  if (inflight.kind === "defer") {
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: changedFiles.length,
      skippedReason: inflight.reason,
      deferred: true,
      changedFiles,
      dirtyFingerprint: getCurrentDirtyFingerprint(),
    };
    recordGitLedger(runId, repo, result);
    results.push(result);
    console.log(`  → deferred: ${result.skippedReason}\n`);
    continue;
  }

  if (Date.now() - loopStart > LOOP_BUDGET_MS) {
    // Wall-clock budget exceeded — skip remaining repos so writeLog / notifyConsole / reload
    // still run before the scheduler's 30-min hard-kill. Ordering guarantees these
    // repos go to the front of tomorrow's queue.
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: changedFiles.length,
      skippedReason: buildMustReviewFailureReason("daily-commit time budget (18min) exceeded"),
      changedFiles,
      dirtyFingerprint: getCurrentDirtyFingerprint(),
    };
    recordGitLedger(runId, repo, result);
    results.push(result);
    console.log(`  → ❌ skipped: ${result.skippedReason}\n`);
    continue;
  }

  const fingerprint = getCurrentDirtyFingerprint();
  try {
    // SOP Step 4 cache: unchanged fingerprint reuses the full disposition set —
    // no reviewer spend on a dirty set we already judged.
    const cached = fingerprint ? verdictCache.get(repo.name) : undefined;
    if (cached && cached.fingerprint === fingerprint) {
      result = applyDispositions(repo, changedFiles, cached.dispositions.map((d) => ({ ...d })), fingerprint, "cached");
    } else {
      result = judgeRepo(repo, changedEntries, fingerprint);
    }
  } catch (err) {
    // Per-repo isolation: a single repo's failure (Codex CLI error, git error, huge
    // diff overflowing a child's buffer) must not abort the whole daily run.
    const msg = (err as Error).message.slice(0, 200);
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: changedFiles.length,
      skippedReason: buildMustReviewFailureReason(`processing error: ${msg}`),
      changedFiles,
      dirtyFingerprint: fingerprint,
    };
  }

  if (!result.committed && !result.deferred && !result.localgitOwned) {
    const routing = classifyDailyCommitSkipRouting(result.skippedReason);
    if (routing.owner === "localgit") {
      result.localgitOwned = true;
    }
  }
  const beforeHold = result;
  result = maybeCommitResultToHold(repo, result, process.env.LOCALGIT_HOLD_ENABLED === "1");
  if (beforeHold.committed) recordGitLedger(runId, repo, beforeHold);
  if (result.holdCommit) {
    recordHoldLedger(runId, repo, result);
    dispatchHoldReview(date, runId, repo, result);
  }
  if (!beforeHold.committed && !result.holdCommit) recordGitLedger(runId, repo, result);
  results.push(result);
  console.log(`  → ${result.committed ? "✅ committed" : "❌ skipped"}: ${result.message || result.skippedReason}\n`);
}

writeLog(date, results);
const skippedRepos = splitDailyCommitResults(results).skipped;
if (skippedRepos.length > 0) {
  try {
    const repoPaths = new Map(dirtyRepos.map((r) => [r.name, r.path]));
    routeSkippedToOwners(date, runId, skippedRepos, repoPaths);
  } catch (err) {
    console.error("Routing failed (non-fatal):", (err as Error).message);
  }
}
for (const r of results) {
  syncToBitable(date, r);
}
await notifyConsole(date, results);
if (process.env.LOCALGIT_DAILY_COMMIT_NO_RELOAD === "1") {
  console.log("Reload suppressed by LOCALGIT_DAILY_COMMIT_NO_RELOAD=1 (canary run).");
} else if (shouldReloadAfterDailyCommit(results)) {
  reload(results);
} else {
  console.log("No commits landed; skipping reload.");
}
