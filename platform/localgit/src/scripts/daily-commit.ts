import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createNotifyClient } from "../notify/console.js";
import { businessDate, loadDailyCommitGovernedRepos, SM_DB_PATH, SM_REPO_ROOT } from "./localgit-context.js";
import {
  getLastActivityMessageRunAtFromRows,
  shouldRequestLifecycleMaintenance,
  splitDailyCommitResults,
  type MessageRunActivityRow,
} from "./daily-commit-activity-gate.js";
import {
  buildLifecycleMaintenanceDelegation,
  spawnLifecycleMaintenance,
} from "./daily-commit-lifecycle-delegation.js";
import {
  DIRECT_PURGE_GIT_SCAN_TIMEOUT_MS,
  listDirectlyPurgeableCodingGarbageFromUntrackedStatus,
  listIgnoredDirectlyPurgeableCodingGarbage,
  purgeDirectlyPurgeableCodingGarbage,
  shouldPurgeDirectlyPurgeableCodingGarbage,
} from "./daily-commit-coding-garbage.js";
import { formatRunHealthLine, summarizeRunHealth } from "./daily-commit-run-health.js";
import {
  canStartCapacityRetry,
  canStartPrimaryLoopWork,
  isLocalgitReviewBlock,
  isTimeBudgetRetryCandidate,
} from "./daily-commit-capacity-retry.js";
import { runCodexReviewer } from "./daily-commit-reviewer.js";
import { classifyDailyCommitSkipRouting } from "./daily-commit-skip-routing.js";
import {
  CAPACITY_REPAIR_REQUIRED_DAYS,
  CAPACITY_WARN_DAYS,
  JUDGMENT_PARAMS,
  buildCapacityEscalationNotifyRequests,
  buildVerdictCache,
  decideInFlightGate,
  deriveConsecutiveCapacitySkipDays,
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
import { buildDailyCommitBitableRecord, parseBitableRecordListResponse, type BitableRecordReadback } from "./daily-commit-bitable.js";
import { maybeCommitResultToHold } from "./daily-commit-hold.js";
import { buildHoldReviewDispatch, spawnHoldReview } from "./daily-commit-hold-dispatch.js";
import {
  buildOwnerDecisionDelegation,
  spawnOwnerDecisionDelegation,
} from "./daily-commit-owner-delegation.js";
import { writeDailyRunState } from "./daily-commit-verify.js";
import {
  appendGitLedgerEntry,
  buildCommitLedgerEntry,
  buildHoldLedgerEntry,
  buildSkipLedgerEntry,
  iterateGitLedgerEntries,
  rotateGitLedgerIfNeeded,
} from "./git-ledger.js";
import { recordDailyCommitDecision } from "./daily-commit-record-decision.js";

const LARK = process.env.SM_LARK_CLI_PATH
  ?? process.env.LOCALGIT_LARK_CLI_PATH
  ?? join(SM_REPO_ROOT, "node_modules/.bin/lark-cli");
const LOG_FILE = join(process.cwd(), "data", "daily-commits.log");
const GIT_LEDGER_FILE = join(process.cwd(), "data", "git-ledger.jsonl");
const DISPATCH_LOG_FILE = join(process.cwd(), "data", "daily-commit-dispatches.jsonl");
const DECISION_LOG_FILE = join(process.cwd(), "data", "daily-commit-decisions.jsonl");
// Wall-clock budget for the per-repo loop (SOP param.loop_budget_min). The live
// scheduler task has a 27-min timeout; reserve 3 min for one retry tail and 9 min
// for writeLog / bitable sync / notify / maintenance routing.
const LOOP_BUDGET_MS = JUDGMENT_PARAMS.loopBudgetMs;
const LOOP_BUDGET_MINUTES = LOOP_BUDGET_MS / 60_000;
const CAPACITY_RETRY_BUDGET_MS = JUDGMENT_PARAMS.capacityRetryBudgetMs;
const CAPACITY_RETRY_REVIEWER_TIMEOUT_MS = JUDGMENT_PARAMS.capacityRetryReviewerTimeoutMs;
const CAPACITY_RETRY_START_RESERVE_MS = JUDGMENT_PARAMS.capacityRetryStartReserveMs;
const DIRECT_PURGE_DISCOVERY_BUDGET_MS = JUDGMENT_PARAMS.directPurgeDiscoveryBudgetMs;

type CapacityRetrySummary = {
  candidates: number;
  attempted: number;
  reviewed: number;
  exhausted: boolean;
  budgetMs: number;
  elapsedMs: number;
};

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

type DirectPurgeLedgerPhase = "intent" | "completed" | "failed";
type DirectPurgeCandidates = ReturnType<typeof listIgnoredDirectlyPurgeableCodingGarbage>;

function prepareDirectPurgeCandidates(
  repo: { name: string; path: string },
  entries: Array<{ code: string; file: string }>,
  ignoredCandidates: DirectPurgeCandidates | undefined,
): DirectPurgeCandidates {
  try {
    const byFile = new Map<string, DirectPurgeCandidates[number]>();
    for (const candidate of ignoredCandidates ?? []) byFile.set(candidate.file, candidate);
    for (const candidate of listDirectlyPurgeableCodingGarbageFromUntrackedStatus(repo.path, entries)) {
      byFile.set(candidate.file, candidate);
    }
    return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  } catch (err) {
    console.error(`Failed to prepare direct coding garbage for ${repo.name}:`, (err as Error).message);
    return [];
  }
}

function mergeDirtyFiles(visibleFiles: string[], directPurgeCandidates: DirectPurgeCandidates): string[] {
  return [...new Set([...visibleFiles, ...directPurgeCandidates.map((candidate) => candidate.file)])].sort();
}

function deferredDispositions(
  files: string[],
  directPurgeCandidates: DirectPurgeCandidates,
  reason: string,
): NonNullable<RepoResult["dispositions"]> {
  const directFiles = new Set(directPurgeCandidates.map((candidate) => candidate.file));
  return files.map((file) => ({
    file,
    class: directFiles.has(file) ? "noise" as const : "source" as const,
    verdict: "KEEP_DIRTY" as const,
    reason,
    source: "l0" as const,
  }));
}

function recordDirectPurgeLedger(
  runId: string,
  repo: { name: string; path: string },
  context: { branch: string; head: string },
  phase: DirectPurgeLedgerPhase,
  file: string,
  bytes: number,
  reason: string,
): void {
  const verdict = phase === "intent" ? "PURGE_PENDING" : phase === "completed" ? "PURGED" : "PURGE_FAILED";
  appendGitLedgerEntry(GIT_LEDGER_FILE, buildSkipLedgerEntry({
    runId,
    repo: repo.name,
    repoPath: repo.path,
    branch: context.branch,
    actor: GIT_USER,
    head: context.head,
    filesChanged: 1,
    changedFiles: [file],
    skippedReason: reason,
    perFileDispositions: [{
      file,
      class: "noise",
      verdict,
      reason,
      source: "l0",
    }],
    decisionSource: "l0",
    purgePhase: phase,
    reclaimedBytes: phase === "completed" ? bytes : 0,
  }), { durable: true });
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

function finalizeRepoResult(
  runId: string,
  date: string,
  repo: { name: string; path: string },
  result: RepoResult,
): RepoResult {
  if (!result.committed && !result.deferred && !result.localgitOwned) {
    const routing = classifyDailyCommitSkipRouting(result.skippedReason);
    if (routing.owner === "localgit") {
      result.localgitOwned = true;
    }
  }
  const beforeHold = result;
  const finalized = maybeCommitResultToHold(repo, result, process.env.LOCALGIT_HOLD_ENABLED === "1");
  if (beforeHold.committed) recordGitLedger(runId, repo, beforeHold);
  if (finalized.holdCommit) {
    recordHoldLedger(runId, repo, finalized);
    dispatchHoldReview(date, runId, repo, finalized);
  }
  if (!beforeHold.committed && !finalized.holdCommit) recordGitLedger(runId, repo, finalized);
  return finalized;
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

function appendDispatchLog(entry: {
  date: string;
  runId?: string;
  dispatchId?: string;
  kind: "owner_delegation" | "owner_hint" | "fp_escalation" | "hold_review" | "lifecycle_maintenance";
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
        kind: "owner_delegation",
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

    const repoPath = repoPaths.get(r.name);
    if (!repoPath) {
      appendDispatchLog({
        date,
        runId,
        dispatchId: notifyGate.dispatchId,
        kind: "owner_delegation",
        targetSession: r.name,
        repo: r.name,
        status: "failed",
        message: "",
        dirtyFingerprint: r.dirtyFingerprint,
        skippedReason: r.skippedReason,
        error: "repo path missing from daily-commit route map",
      });
      continue;
    }

    const delegation = buildOwnerDecisionDelegation({
      date,
      repo: r.name,
      repoPath,
      dispatchId: notifyGate.dispatchId,
      dirtyFingerprint: r.dirtyFingerprint,
      skippedReason: r.skippedReason,
      defaultSuggestion: defaultSuggestionFor(r),
    });
    try {
      // E5 and other repo-local ownership questions are owner-session work.
      // Spawn2.0 gives the owner a real, auditable task; a --as user message
      // would only impersonate the human operator and create a phantom run.
      const receipt = spawnOwnerDecisionDelegation(delegation);
      appendDispatchLog({
        date,
        runId,
        dispatchId: notifyGate.dispatchId,
        kind: "owner_delegation",
        targetSession: r.name,
        repo: r.name,
        status: "sent",
        message: delegation.payload.prompt,
        dirtyFingerprint: r.dirtyFingerprint,
        skippedReason: r.skippedReason,
        clientRequestId: delegation.clientRequestId,
        verificationToken: delegation.verificationToken,
        acceptedReceipt: receipt.receiptSummary,
        spawnResponse: JSON.stringify(receipt.body),
      });
      delegatedToOwner++;
    } catch (err) {
      appendDispatchLog({
        date,
        runId,
        dispatchId: notifyGate.dispatchId,
        kind: "owner_delegation",
        targetSession: r.name,
        repo: r.name,
        status: "failed",
        message: delegation.payload.prompt,
        dirtyFingerprint: r.dirtyFingerprint,
        skippedReason: r.skippedReason,
        clientRequestId: delegation.clientRequestId,
        verificationToken: delegation.verificationToken,
        error: (err as Error).message,
      });
      console.error(`Failed to delegate ${r.name} to its owner session:`, (err as Error).message);
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

function readBitableRecord(baseToken: string, tableId: string, date: string, repoName: string): BitableRecordReadback | undefined {
  const filterJson = JSON.stringify({
    logic: "and",
    conditions: [["date", "==", date], ["repo_name", "==", repoName]],
  });
  const raw = execFileSync(LARK, [
    "base", "+record-list", "--as", "user",
    "--base-token", baseToken, "--table-id", tableId,
    "--field-id", "date", "--field-id", "repo_name", "--field-id", "committed",
    "--field-id", "commit_message", "--field-id", "files_changed", "--field-id", "skipped_reason",
    "--filter-json", filterJson, "--limit", "10", "--format", "json",
  ], { encoding: "utf-8", timeout: 15000 });
  return parseBitableRecordListResponse(JSON.parse(raw), date, repoName);
}

function assertBitableRecordFields(actual: BitableRecordReadback, expected: Record<string, string>): void {
  for (const [field, value] of Object.entries(expected)) {
    if (actual.fields[field] !== value) {
      throw new Error(`native lark-cli exact-key readback mismatch for field ${field}`);
    }
  }
}

function syncToBitable(date: string, result: RepoResult): boolean {
  const baseToken = process.env.LOCALGIT_BITABLE_BASE_TOKEN?.trim();
  const tableId = process.env.LOCALGIT_BITABLE_TABLE_ID?.trim();
  if (!baseToken && !tableId) {
    console.error("Bitable mirror disabled: set LOCALGIT_BITABLE_BASE_TOKEN and LOCALGIT_BITABLE_TABLE_ID to enable the native lark-cli mirror.");
    return true;
  }
  if (!baseToken || !tableId) {
    console.error("Bitable mirror disabled: LOCALGIT_BITABLE_BASE_TOKEN and LOCALGIT_BITABLE_TABLE_ID must be set together.");
    return false;
  }
  try {
    const expected = buildDailyCommitBitableRecord(date, result);
    const record = JSON.stringify(expected);
    const existing = readBitableRecord(baseToken, tableId, date, result.name);
    const args = [
      "base", "+record-upsert",
      "--as", "user",
      "--base-token", baseToken,
      "--table-id", tableId,
      "--json", record,
    ];
    if (existing) args.splice(6, 0, "--record-id", existing.recordId);
    execFileSync(LARK, args, { timeout: 15000 });
    const readback = readBitableRecord(baseToken, tableId, date, result.name);
    if (!readback) {
      throw new Error("native lark-cli record-upsert was not confirmed by exact-key readback");
    }
    assertBitableRecordFields(readback, expected);
    return true;
  } catch (err) {
    console.error(`Failed to sync ${result.name} to bitable:`, (err as Error).message);
    return false;
  }
}

function isMustReviewBacklogResult(result: RepoResult): boolean {
  return Boolean(result.mustReviewBacklog || /stale must-review dirty set/i.test(result.skippedReason));
}

async function notifyConsole(
  date: string,
  results: RepoResult[],
  options: { maintenanceRequested?: boolean; capacityRetry?: CapacityRetrySummary } = {},
): Promise<void> {
  const { committed, skipped, deferred, localgitOwned } = splitDailyCommitResults(results);
  const mustReviewBacklog = localgitOwned.filter(isMustReviewBacklogResult);
  const maintenanceRequested = options.maintenanceRequested ?? false;

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
  if (options.capacityRetry && options.capacityRetry.candidates > 0) {
    const retryState = options.capacityRetry.exhausted ? "budget exhausted" : "queue drained";
    bodyLines.push(`- capacity retry：${options.capacityRetry.reviewed}/${options.capacityRetry.attempted} re-reviewed (${options.capacityRetry.candidates} candidates; ${retryState})`);
  }
  const health = summarizeRunHealth(results);
  bodyLines.push(formatRunHealthLine(health));
  if (bodyLines.length === 0) bodyLines.push("_无需提交的变更_");
  bodyLines.push("");
  bodyLines.push(`共 ${committed.length} 个 repo 提交，${skipped.length} 个内容跳过，${localgitOwned.length} 个 localgit 自处理，${deferred.length} 个延后。${maintenanceRequested ? "维护诉求将路由至 codexroot。" : "不产生 lifecycle 维护诉求。"}`);

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
        capacityRetryCandidates: options.capacityRetry?.candidates ?? 0,
        capacityRetryAttempted: options.capacityRetry?.attempted ?? 0,
        capacityRetryReviewed: options.capacityRetry?.reviewed ?? 0,
        capacityRetryExhausted: options.capacityRetry?.exhausted ? 1 : 0,
      },
    });
  } catch (err) {
    console.error("Failed to notify console:", (err as Error).message);
  }
}

function writeLog(date: string, results: RepoResult[], capacityRetry?: CapacityRetrySummary): void {
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
      ...(r.purgedFiles?.length ? { purged_files: r.purgedFiles, reclaimed_bytes: r.reclaimedBytes ?? 0 } : {}),
      ...(r.deferred ? { deferred: true } : {}),
      ...(r.localgitOwned ? { localgit_owned: true } : {}),
      ...(isMustReviewBacklogResult(r) ? { must_review_backlog: true } : {}),
      ...(r.retryAttempted ? { retry_attempted: true } : {}),
      ...(r.retryReviewed ? { retry_reviewed: true } : {}),
    })),
    total_committed: committed.length,
    total_skipped: skipped.length,
    total_deferred: deferred.length,
    total_localgit_owned: localgitOwned.length,
    total_must_review_backlog: mustReviewBacklog.length,
    ...(capacityRetry ? {
      capacity_retry: {
        candidates: capacityRetry.candidates,
        attempted: capacityRetry.attempted,
        reviewed: capacityRetry.reviewed,
        exhausted: capacityRetry.exhausted,
        budget_ms: capacityRetry.budgetMs,
        elapsed_ms: capacityRetry.elapsedMs,
      },
    } : {}),
  });
  appendFileSync(LOG_FILE, entry + "\n");
}

// skip-handling SOP escalation: a repo starved by the time budget night after
// night must surface as a localgit-owned capacity incident (ad-adjust skipped 3
// consecutive nights silently). streak>=3 gets an idempotent decision record
// (stable id per repo per UTC day — same-day re-runs stay one row) so daily
// triage picks it up. Notifications are aggregated to <=2 per run and sent
// concurrently: a serial per-repo notify would burn one client timeout per repo
// during a notify outage and inflate the very budget this escalation is about.
async function escalateCapacitySkips(
  date: string,
  dayStamp: string,
  escalations: Array<{ repo: string; days: number }>,
): Promise<void> {
  const starved = escalations.filter((entry) => entry.days >= CAPACITY_WARN_DAYS);
  if (starved.length === 0) return;

  for (const { repo, days } of starved.filter((entry) => entry.days >= CAPACITY_REPAIR_REQUIRED_DAYS)) {
    try {
      recordDailyCommitDecision({
        repo,
        decision: "localgit_retry",
        actor: "localgit",
        scope: "repo_policy",
        reason: `capacity-repair-required: ${repo} 已连续 ${days} 天因时间预算未能审查（截至 ${date}）；修复 reviewer 容量或拆分审查范围`,
        decisionId: `dcd-${repo.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40)}-${dayStamp}-capacity-review`,
      });
    } catch (err) {
      console.error(`Failed to record capacity decision for ${repo}:`, (err as Error).message);
    }
  }

  const requests = buildCapacityEscalationNotifyRequests(date, starved);
  const client = createNotifyClient();
  const outcomes = await Promise.allSettled(requests.map((request) => client.notify(request)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      console.error(`Failed to send capacity alert (${requests[index]?.title}):`, outcome.reason);
    }
  });
}

function retryTimeBudgetBlocks(
  runId: string,
  date: string,
  results: RepoResult[],
  reposByName: Map<string, { name: string; path: string }>,
  verdictCache: ReturnType<typeof buildVerdictCache>,
  loopStartedAt: number,
): CapacityRetrySummary {
  const retryStartedAt = Date.now();
  const candidates = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => isTimeBudgetRetryCandidate(result));
  let attempted = 0;
  let reviewed = 0;
  let exhausted = false;

  for (const { index } of candidates) {
    const now = Date.now();
    const retryFitsTail = canStartCapacityRetry({
      retryStartedAt,
      now,
      budgetMs: CAPACITY_RETRY_BUDGET_MS,
      reviewerTimeoutMs: CAPACITY_RETRY_REVIEWER_TIMEOUT_MS,
      reserveMs: CAPACITY_RETRY_START_RESERVE_MS,
    });
    const retryFitsRun = canStartCapacityRetry({
      retryStartedAt: loopStartedAt,
      now,
      budgetMs: LOOP_BUDGET_MS + CAPACITY_RETRY_BUDGET_MS,
      reviewerTimeoutMs: CAPACITY_RETRY_REVIEWER_TIMEOUT_MS,
      reserveMs: CAPACITY_RETRY_START_RESERVE_MS,
    });
    if (!retryFitsTail || !retryFitsRun) {
      exhausted = true;
      break;
    }

    const original = results[index];
    const repo = reposByName.get(original.name);
    if (!repo) continue;

    console.log(`Retrying time-budget block for ${repo.name}...`);
    let retryResult: RepoResult;
    try {
      const changedEntries = collectStatusEntries(repo.path);
      if (changedEntries.length === 0) continue;
      const changedFiles = changedEntries.map((entry) => entry.file);
      let fingerprint: string | undefined;
      try {
        fingerprint = getDirtyFingerprint(repo.path);
      } catch {
        fingerprint = undefined;
      }
      const cached = fingerprint ? verdictCache.get(repo.name) : undefined;
      retryResult = cached && cached.fingerprint === fingerprint
        ? applyDispositions(repo, changedFiles, cached.dispositions.map((disposition) => ({ ...disposition })), fingerprint, "cached")
        : judgeRepo(repo, changedEntries, fingerprint, {
          reviewer: (prompt, cwd) => runCodexReviewer(prompt, cwd, { timeoutMs: CAPACITY_RETRY_REVIEWER_TIMEOUT_MS }),
        });
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      retryResult = {
        name: repo.name,
        committed: false,
        message: "",
        filesChanged: original.filesChanged,
        skippedReason: buildMustReviewFailureReason(`processing error during capacity retry: ${message}`),
        changedFiles: original.changedFiles,
        dirtyFingerprint: original.dirtyFingerprint,
      };
    }

    attempted++;
    retryResult.retryAttempted = true;
    retryResult = finalizeRepoResult(runId, date, repo, retryResult);
    retryResult.retryReviewed = !retryResult.reviewerFailure && !isLocalgitReviewBlock(retryResult);
    results[index] = retryResult;
    if (retryResult.retryReviewed) reviewed++;
    console.log(`  → retry ${retryResult.committed ? "✅ committed" : "❌ skipped"}: ${retryResult.message || retryResult.skippedReason}\n`);
  }

  return {
    candidates: candidates.length,
    attempted,
    reviewed,
    exhausted,
    budgetMs: CAPACITY_RETRY_BUDGET_MS,
    elapsedMs: Date.now() - retryStartedAt,
  };
}

function dispatchLifecycleMaintenance(date: string, runId: string, results: RepoResult[]): void {
  const committed = splitDailyCommitResults(results).committed.filter((result) => !result.holdOnly).length;
  const delegation = buildLifecycleMaintenanceDelegation({ date, runId, committed });
  try {
    const receipt = spawnLifecycleMaintenance(delegation);
    appendDispatchLog({
      date,
      runId,
      kind: "lifecycle_maintenance",
      targetSession: "codexroot",
      status: "sent",
      message: delegation.payload.prompt,
      clientRequestId: delegation.clientRequestId,
      verificationToken: delegation.verificationToken,
      acceptedReceipt: receipt.receiptSummary,
      spawnResponse: JSON.stringify(receipt.body),
    });
    console.log("Lifecycle maintenance routed to codexroot:", receipt.receiptSummary);
  } catch (error) {
    appendDispatchLog({
      date,
      runId,
      kind: "lifecycle_maintenance",
      targetSession: "codexroot",
      status: "failed",
      message: delegation.payload.prompt,
      clientRequestId: delegation.clientRequestId,
      verificationToken: delegation.verificationToken,
      error: (error as Error).message,
    });
    console.error("Lifecycle maintenance routing failed:", (error as Error).message);
  }
}

// Main
const runStartedAt = new Date();
const date = businessDate(runStartedAt);
const runId = `daily-${runStartedAt.toISOString()}`;
console.log(`[Daily Commit] ${date}\n`);
mkdirSync(join(process.cwd(), "data"), { recursive: true });

// Self-heal an oversized append-only ledger before any full-history read: the
// 540MB active file crashed every nightly startup with ERR_STRING_TOO_LONG
// (2026-08-27 incident). Pure rename; history stays visible via shard-aware reads.
try {
  const rotatedTo = rotateGitLedgerIfNeeded(GIT_LEDGER_FILE);
  if (rotatedTo) console.log(`git-ledger rotated: ${rotatedTo}`);
} catch (err) {
  console.error("git-ledger rotation failed (non-fatal):", (err as Error).message);
}

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
  await notifyConsole(date, [result], { maintenanceRequested: false });
  process.exit(1);
}

// Supervised canary knob: LOCALGIT_DAILY_COMMIT_ONLY=repo1,repo2 limits a manual run
// to named repos (small blast radius while observing a behavior change live).
const onlyRepos = (process.env.LOCALGIT_DAILY_COMMIT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (onlyRepos.length > 0) {
  repos = repos.filter((r) => onlyRepos.includes(r.name));
  console.log(`Canary filter active: ${repos.map((r) => r.name).join(", ") || "(no match)"}`);
}

if (repos.length === 0) {
  const result: RepoResult = {
    name: "daily-commit-eligibility",
    committed: false,
    message: "",
    filesChanged: 0,
    skippedReason: "blocked: no eligible repositories; verify managed role affiliation and Git workdir configuration",
    localgitOwned: true,
  };
  writeLog(date, [result]);
  await notifyConsole(date, [result], { maintenanceRequested: false });
  process.exit(2);
}

// Discovery is part of the same wall-clock budget as processing. Scan ignored
// candidates once here; visible candidates reuse each repo's normal status read.
const loopStart = Date.now();
const directPurgeDiscoveryDeadline = loopStart + DIRECT_PURGE_DISCOVERY_BUDGET_MS;
const directPurgeCandidatesByRepo = new Map<string, DirectPurgeCandidates>();
for (const repo of repos) {
  const remainingDiscoveryMs = directPurgeDiscoveryDeadline - Date.now();
  if (remainingDiscoveryMs <= 0) {
    console.error(`Direct coding-garbage discovery budget (${DIRECT_PURGE_DISCOVERY_BUDGET_MS}ms) exhausted; remaining ignored-only caches wait for the next run.`);
    break;
  }
  try {
    const candidates = listIgnoredDirectlyPurgeableCodingGarbage(repo.path, {
      timeoutMs: Math.min(DIRECT_PURGE_GIT_SCAN_TIMEOUT_MS, remainingDiscoveryMs),
      deadlineAt: directPurgeDiscoveryDeadline,
    });
    if (candidates.length > 0) directPurgeCandidatesByRepo.set(repo.name, candidates);
  } catch (err) {
    console.error(`Failed to inspect direct coding garbage for ${repo.name}:`, (err as Error).message);
  }
}
const dirtyRepos = repos.filter((r) => isDirty(r.path) || (directPurgeCandidatesByRepo.get(r.name)?.length ?? 0) > 0);
writeDailyRunState(join(process.cwd(), "data", "run-state", "latest-daily-run.json"), {
  runId,
  repos: dirtyRepos.map((repo) => {
    const entries = collectStatusEntries(repo.path);
    const candidates = prepareDirectPurgeCandidates(repo, entries, directPurgeCandidatesByRepo.get(repo.name));
    const eligibleCandidates = shouldPurgeDirectlyPurgeableCodingGarbage(entries, candidates) ? candidates : [];
    const dirtyBefore = new Set(entries.map((entry) => entry.file));
    for (const candidate of eligibleCandidates) dirtyBefore.add(candidate.file);
    return {
      name: repo.name,
      path: repo.path,
      dirtyBefore: [...dirtyBefore].sort(),
      ...(eligibleCandidates.length > 0 ? { directPurgeCandidates: eligibleCandidates.map((candidate) => candidate.file) } : {}),
    };
  }),
});

if (dirtyRepos.length === 0) {
  console.log("All repos clean. Nothing to commit.");
  process.exit(0);
}

// SOP Step 6 ①: capacity-starved repos first (consecutive time-budget skip days
// desc, so streak>=3 repos are guaranteed the front of the queue), then
// least-recently-reviewed (never-reviewed first, oldest dirt first inside that
// group) — replaces alphabetical order which starved the tail.
// Full history is scanned once per compact index via the streaming visitor, so
// the run never materializes the whole ledger (the 1.3GB retained-array
// regression); each pass peaks at O(chunk + compact index).
const verdictCache = buildVerdictCache(iterateGitLedgerEntries(GIT_LEDGER_FILE));
const lastReviewedAt = deriveLastReviewedAt(iterateGitLedgerEntries(GIT_LEDGER_FILE));
const capacitySkipDays = deriveConsecutiveCapacitySkipDays(iterateGitLedgerEntries(GIT_LEDGER_FILE));
const dirtyMtimeByRepo = new Map<string, number>();
for (const repo of dirtyRepos) {
  if (!lastReviewedAt.has(repo.name)) {
    const mtime = getLatestDirtyMtime(repo.path);
    if (mtime !== null) dirtyMtimeByRepo.set(repo.name, mtime);
  }
}
const orderedRepos = orderReposForProcessing(dirtyRepos, lastReviewedAt, dirtyMtimeByRepo, capacitySkipDays);

console.log(`Found ${orderedRepos.length} dirty repos (capacity-starved first, then least-recently-reviewed):\n`);
await escalateCapacitySkips(
  date,
  runStartedAt.toISOString().slice(0, 10).replace(/-/g, ""),
  orderedRepos.map((repo) => ({ repo: repo.name, days: capacitySkipDays.get(repo.name) ?? 0 })),
);
const results: RepoResult[] = [];
for (const repo of orderedRepos) {
  console.log(`Processing ${repo.name}...`);
  let result: RepoResult;
  const changedEntries = collectStatusEntries(repo.path);
  const changedFiles = changedEntries.map((e) => e.file);
  const directPurgeCandidates = prepareDirectPurgeCandidates(repo, changedEntries, directPurgeCandidatesByRepo.get(repo.name));
  const directPurgeEligible = shouldPurgeDirectlyPurgeableCodingGarbage(changedEntries, directPurgeCandidates);
  const gatedDirectPurgeCandidates = directPurgeEligible ? directPurgeCandidates : [];
  const accountedDirtyFiles = mergeDirtyFiles(changedFiles, gatedDirectPurgeCandidates);
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
      filesChanged: accountedDirtyFiles.length,
      skippedReason: inflight.reason,
      deferred: true,
      changedFiles: accountedDirtyFiles,
      dispositions: deferredDispositions(accountedDirtyFiles, gatedDirectPurgeCandidates, inflight.reason),
      dirtyFingerprint: getCurrentDirtyFingerprint(),
    };
    recordGitLedger(runId, repo, result);
    results.push(result);
    console.log(`  → deferred: ${result.skippedReason}\n`);
    continue;
  }

  if (!canStartPrimaryLoopWork({
    loopStartedAt: loopStart,
    now: Date.now(),
    loopBudgetMs: LOOP_BUDGET_MS,
    primaryReviewerTimeoutMs: JUDGMENT_PARAMS.reviewerTimeoutMs,
    retryReviewerTimeoutMs: CAPACITY_RETRY_REVIEWER_TIMEOUT_MS,
    retryReserveMs: CAPACITY_RETRY_START_RESERVE_MS,
  })) {
    // Stop before starting work that could consume the retry-tail reserve. Ordering
    // guarantees these repos go to the front of tomorrow's queue while the same
    // process still has room for one complete bounded retry.
    const timeBudgetReason = buildMustReviewFailureReason(
      `daily-commit time budget (${LOOP_BUDGET_MINUTES}min) reached retry-tail reserve boundary`,
    );
    result = {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: accountedDirtyFiles.length,
      skippedReason: timeBudgetReason,
      changedFiles: accountedDirtyFiles,
      dispositions: deferredDispositions(accountedDirtyFiles, gatedDirectPurgeCandidates, timeBudgetReason),
      dirtyFingerprint: getCurrentDirtyFingerprint(),
      localgitOwned: true,
    };
    recordGitLedger(runId, repo, result);
    results.push(result);
    console.log(`  → ❌ skipped: ${result.skippedReason}\n`);
    continue;
  }

  // Direct cleanup is intentionally much narrower than .gitignore remediation:
  // run only when every visible entry is untracked Tier-0; matching ignored
  // candidates can join, but no other ignored path is touched.
  // never alongside source, artifacts, credentials, DBs, symlinks, or conflicts.
  if (directPurgeEligible) {
    try {
      const purgeLedgerContext = { branch: getBranch(repo.path), head: getHead(repo.path) };
      const purge = purgeDirectlyPurgeableCodingGarbage(repo.path, directPurgeCandidates, {
        // Intent is fsync'd to the existing append-only ledger before each unlink.
        // Completion is appended only after unlink succeeds; an audit failure throws
        // and leaves an unmatched intent that the independent verifier rejects.
        beforeDelete: (candidate) => recordDirectPurgeLedger(
          runId,
          repo,
          purgeLedgerContext,
          "intent",
          candidate.file,
          candidate.bytes,
          "direct coding-garbage purge intent",
        ),
        afterDelete: (candidate) => recordDirectPurgeLedger(
          runId,
          repo,
          purgeLedgerContext,
          "completed",
          candidate.file,
          candidate.bytes,
          `purged directly-purgeable coding garbage; reclaimed ${candidate.bytes} bytes`,
        ),
      });
      for (const skipped of purge.skipped) {
        recordDirectPurgeLedger(
          runId,
          repo,
          purgeLedgerContext,
          "failed",
          skipped.file,
          0,
          "direct coding-garbage purge skipped because the target changed, disappeared, or could not be deleted",
        );
      }
      const purgedFiles = purge.purged.map((candidate) => candidate.file);
      if (purge.skipped.length > 0) {
        process.exitCode = 1;
        result = {
          name: repo.name,
          committed: false,
          message: "",
          filesChanged: purgedFiles.length + purge.skipped.length,
          skippedReason: `direct coding-garbage cleanup incomplete: ${purgedFiles.length} deleted, ${purge.skipped.length} skipped; inspect purge ledger`,
          localgitOwned: true,
          changedFiles: [...purgedFiles, ...purge.skipped.map((candidate) => candidate.file)],
          purgedFiles,
          reclaimedBytes: purge.reclaimedBytes,
          decisionSource: "l0",
        };
        results.push(result);
        console.log(`  → ❌ skipped: ${result.skippedReason}\n`);
        continue;
      }
      if (purgedFiles.length > 0) {
        result = {
          name: repo.name,
          committed: false,
          message: "",
          filesChanged: purgedFiles.length,
          skippedReason: `purged ${purgedFiles.length} directly-purgeable coding-garbage file(s), reclaimed ${purge.reclaimedBytes} bytes`,
          deferred: true,
          autoFixed: true,
          changedFiles: purgedFiles,
          purgedFiles,
          reclaimedBytes: purge.reclaimedBytes,
          dirtyFingerprint: changedEntries.length > 0 ? getCurrentDirtyFingerprint() : undefined,
          decisionSource: "l0",
          dispositions: purge.purged.map((candidate) => ({
            file: candidate.file,
            class: "noise" as const,
            verdict: "PURGED" as const,
            reason: `direct coding-garbage cleanup; reclaimed ${candidate.bytes} bytes`,
            source: "l0" as const,
          })),
        };
        results.push(result);
        console.log(`  → cleaned: ${result.skippedReason}\n`);
        continue;
      }
    } catch (err) {
      process.exitCode = 1;
      result = {
        name: repo.name,
        committed: false,
        message: "",
        filesChanged: directPurgeCandidates.length,
        skippedReason: `direct coding-garbage cleanup audit failure: ${(err as Error).message.slice(0, 200)}`,
        localgitOwned: true,
        changedFiles: directPurgeCandidates.map((candidate) => candidate.file),
        decisionSource: "l0",
      };
      results.push(result);
      console.log(`  → ❌ skipped: ${result.skippedReason}\n`);
      continue;
    }
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

  result = finalizeRepoResult(runId, date, repo, result);
  results.push(result);
  console.log(`  → ${result.committed ? "✅ committed" : "❌ skipped"}: ${result.message || result.skippedReason}\n`);
}

const capacityRetry = retryTimeBudgetBlocks(
  runId,
  date,
  results,
  new Map(dirtyRepos.map((repo) => [repo.name, repo])),
  verdictCache,
  loopStart,
);
writeLog(date, results, capacityRetry);
const skippedRepos = splitDailyCommitResults(results).skipped;
if (skippedRepos.length > 0) {
  try {
    const repoPaths = new Map(dirtyRepos.map((r) => [r.name, r.path]));
    routeSkippedToOwners(date, runId, skippedRepos, repoPaths);
  } catch (err) {
    console.error("Routing failed (non-fatal):", (err as Error).message);
  }
}
const bitableMirrorFailed = results.some((r) => !syncToBitable(date, r));
if (bitableMirrorFailed) process.exitCode = 2;
const maintenanceRequested = shouldRequestLifecycleMaintenance(results);
await notifyConsole(date, results, { capacityRetry, maintenanceRequested });
if (maintenanceRequested) {
  dispatchLifecycleMaintenance(date, runId, results);
} else {
  console.log("No non-hold commits landed; no lifecycle maintenance requested.");
}
