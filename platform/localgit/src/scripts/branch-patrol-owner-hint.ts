import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER_DECISION_RUBRIC_PATH,
  OWNER_DECISION_RUBRIC_VERSION,
} from "./daily-commit-judgment-matrix.js";
import {
  loadOwnerNotificationHistory,
  shouldNotifyOwner,
  type OwnerNotificationHistory,
} from "./daily-commit-owner-notify-gate.js";
import {
  spawnOwnerDecisionDelegation,
  type OwnerDecisionDelegation,
} from "./daily-commit-owner-delegation.js";
import { LOCALGIT_ROOT } from "./localgit-context.js";
import type { BranchInventory, PatrolEvidence } from "./branch-patrol-core.js";

const DISPATCH_LOG_FILE = join(process.cwd(), "data", "daily-commit-dispatches.jsonl");
const DECISION_LOG_FILE = join(process.cwd(), "data", "daily-commit-decisions.jsonl");
// The notify gate's git-ledger suppression leg can never match patrol
// fingerprints (they only ever appear in the dispatch/decision logs), so skip
// reading the oversized ledger entirely. The basename intentionally does not
// exist; missing paths read as empty history.
const UNUSED_LEDGER_FILE = join(process.cwd(), "data", "git-ledger.jsonl.patrol-unused");

export type PatrolOwnerHintCandidate = {
  kind: "C3" | "C4" | "C5";
  fingerprint: string;
  skippedReason: string;
  defaultSuggestion: string;
};

function patrolFingerprint(item: BranchInventory, kind: "C3" | "C4" | "C5"): string {
  return `patrol:${item.repo}:${item.branch}:${kind}`;
}

// Decide whether a patrol evidence row deserves an owner hint. C3 rows that
// were not auto-merged (non-docs, ahead > 5, or gate off) get a next-day hint
// once ageDays >= 2; C4 conflict rows and C5 rows get the SOP's one-time owner ask. All dedup
// through the same fingerprint gate as daily-commit owner delegations.
export function patrolOwnerHintCandidate(
  item: BranchInventory,
  evidence: PatrolEvidence,
): PatrolOwnerHintCandidate | undefined {
  if (item.class === "C3" && evidence.action === "report" && item.ageDays >= 2) {
    return {
      kind: "C3",
      fingerprint: patrolFingerprint(item, "C3"),
      skippedReason: "branch_patrol_c3",
      defaultSuggestion: "合回 —— 分支干净可合（临时 worktree 试合无冲突），滞留只会让已完成工作无限期搁浅（rubric §B-C3 默认）",
    };
  }
  if (item.class === "C4" && evidence.action === "report") {
    return {
      kind: "C4",
      fingerprint: patrolFingerprint(item, "C4"),
      skippedReason: "branch_patrol_c4",
      defaultSuggestion: "合回 —— 由 owner 按冲突文件逐块解决后合回；禁止 --ours/--theirs 机械覆盖，若分支已废弃则选择删除（rubric §B-C4 默认）",
    };
  }
  if (item.class === "C5") {
    return {
      kind: "C5",
      fingerprint: patrolFingerprint(item, "C5"),
      skippedReason: "branch_patrol_c5",
      defaultSuggestion: "合回 —— current 分支长期领先 trunk；仅当 trunk 已事实废弃、current 就是长期主线时才改选 登记 trunk（rubric §B-C5 默认）",
    };
  }
  return undefined;
}

export function loadPatrolOwnerNotificationHistory(): OwnerNotificationHistory {
  return loadOwnerNotificationHistory({
    dispatchLogFile: DISPATCH_LOG_FILE,
    decisionLogFile: DECISION_LOG_FILE,
    gitLedgerFile: UNUSED_LEDGER_FILE,
  });
}

function buildPatrolOwnerHintDelegation(input: {
  date: string;
  item: BranchInventory;
  candidate: PatrolOwnerHintCandidate;
  dispatchId: string;
}): OwnerDecisionDelegation {
  const { item, candidate } = input;
  const key = item.repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const fpHash = createHash("sha256").update(candidate.fingerprint).digest("hex").slice(0, 12);
  const clientRequestId = `${input.date}:localgit:${key}:branch-patrol-${candidate.kind.toLowerCase()}-${fpHash}`;
  const verificationToken = `comm_branch_patrol_owner_${key}_${fpHash}`.replace(/[^A-Za-z0-9_]/g, "_");
  const decisionCommand = [
    `cd ${LOCALGIT_ROOT}`,
    "&& npm run daily-commit-decision --",
    `--repo ${item.repo}`,
    `--dirty-fingerprint ${candidate.fingerprint}`,
    "--decision <resolved|quiet_until_changed>",
    `--actor ${item.repo}`,
    `--dispatch-id ${input.dispatchId}`,
    "--scope fingerprint",
    '--reason "<one-sentence reason>"',
  ].join(" ");
  let question: string;
  let actions: string[];
  if (candidate.kind === "C3") {
    question = `分支 ${item.branch} 已 ${item.ageDays} 天停在 C3（干净可合：双向各有独有 commit、临时 worktree 试合无冲突，ahead ${item.ahead} / behind ${item.behind}）；第一阶段 localgit 只自动合 docs-only 分支，这条需要 owner 裁决。`;
    actions = [
      "枚举动作（rubric §B，只能三选一）：",
      "- 合回：你在仓内把分支 git merge --no-ff 合回 trunk；localgit 下轮巡检按 C1 用 -d 安全清理分支。",
      "- 删除：分支已废弃；回复后由 localgit 用 -d 安全删（删不掉会转回路由）。",
      "- 挂起+期限：分支是未完成实验；必须附预计完成日期。",
    ];
  } else if (candidate.kind === "C4") {
    question = `分支 ${item.branch} 停在 C4（真冲突：ahead ${item.ahead} / behind ${item.behind}；冲突文件：${item.conflictFiles.join(", ") || "unknown"}）；localgit 只路由，绝不自动解冲突。`;
    actions = [
      "枚举动作（rubric §B，只能三选一）：",
      "- 合回：你在仓内逐文件解决冲突后 git merge --no-ff 合回 trunk；禁止 --ours/--theirs 机械覆盖。",
      "- 删除：分支已废弃；回复后由 localgit 用 -d 安全删（删不掉会转回路由）。",
      "- 挂起+期限：分支是未完成实验；必须附预计完成日期。",
    ];
  } else {
    question = `仓库 current 分支 ${item.branch} 连续 ≥ parked_days 天不是 trunk（${item.trunk ?? "unknown"}），trunk 长期落后 current（C5 常驻非 trunk）。`;
    actions = [
      "枚举动作（rubric §B，只能三选一）：",
      "- 合回：把 current 分支合回 trunk，此后在 trunk 上工作。",
      "- 登记 trunk：仅当 trunk 已事实废弃、current 就是长期主线；localgit 回写 manifest trunk_branch，此后按新 trunk 巡检。",
      "- 挂起+期限：必须附预计完成日期。",
    ];
  }
  const prompt = [
    `[verification: ${verificationToken}] You are the owner session for repository ${item.repo}.`,
    `关联ID：${input.dispatchId}`,
    `Dirty-Fingerprint：${candidate.fingerprint}`,
    `Workspace：${item.repoPath}`,
    `Skipped reason：${candidate.skippedReason}`,
    question,
    ...actions,
    `裁决准则摘要（rubric ${OWNER_DECISION_RUBRIC_VERSION} §B）：分支处置答案只能是 合回 / 删除 / 挂起(附期限) / 登记 trunk；不接受「以后再说」；不回复两轮周 digest 后升级用户代裁。完整准则：${OWNER_DECISION_RUBRIC_PATH}`,
    `localgit 预判默认项：${candidate.defaultSuggestion}。`,
    "Handle this repo-local branch decision yourself; do not ask the human operator to choose unless an actual business decision remains.",
    `After the repo-local action, append the matching audit decision with: ${decisionCommand}`,
    "Return the exact action taken, the resulting branch/trunk state, and any blocker.",
  ].join("\n");

  return {
    clientRequestId,
    verificationToken,
    payload: {
      target: item.repo,
      from: "localgit",
      prompt,
      client_request_id: clientRequestId,
      closure: { kind: "message", target: { type: "todo_pool" } },
      verification_predicate: {
        type: "inbox-message",
        session_name: item.repo,
        field: "prompt",
        contains_all: [verificationToken],
        expected_window_sec: 600,
      },
    },
  };
}

function appendDispatchLog(entry: {
  date: string;
  runId?: string;
  dispatchId?: string;
  kind: "owner_delegation";
  targetSession: string;
  repo: string;
  status: "sent" | "failed" | "suppressed";
  message: string;
  dirtyFingerprint?: string;
  skippedReason?: string;
  suppressionReason?: string;
  clientRequestId?: string;
  verificationToken?: string;
  acceptedReceipt?: string;
  spawnResponse?: string;
  error?: string;
}): void {
  try {
    const { spawnResponse, error, ...rest } = entry;
    appendFileSync(
      DISPATCH_LOG_FILE,
      JSON.stringify({
        recorded_at: new Date().toISOString(),
        ...rest,
        message_hash: createHash("sha256").update(rest.message).digest("hex"),
        spawn_response: spawnResponse?.slice(0, 2000),
        error: error?.slice(0, 500),
      }) + "\n",
    );
  } catch (err) {
    console.error("Failed to write branch-patrol dispatch log:", (err as Error).message);
  }
}

// Send (or fingerprint-suppress) one patrol owner hint through the same
// notify-gate + spawn2.0 delegation machinery daily-commit uses for owner
// delegations. Returns the dispatch outcome for the caller's log line.
export function dispatchPatrolOwnerHint(input: {
  date: string;
  runId: string;
  item: BranchInventory;
  candidate: PatrolOwnerHintCandidate;
  history: OwnerNotificationHistory;
}): "sent" | "suppressed" | "failed" {
  const { item, candidate } = input;
  const gate = shouldNotifyOwner({
    date: input.date,
    repo: item.repo,
    dirtyFingerprint: candidate.fingerprint,
    skippedReason: candidate.skippedReason,
    currentRunId: input.runId,
    history: input.history,
  });
  if (gate.kind === "suppress") {
    appendDispatchLog({
      date: input.date,
      runId: input.runId,
      kind: "owner_delegation",
      targetSession: item.repo,
      repo: item.repo,
      status: "suppressed",
      message: "",
      dirtyFingerprint: candidate.fingerprint,
      skippedReason: candidate.skippedReason,
      suppressionReason: gate.reason,
    });
    return "suppressed";
  }

  const delegation = buildPatrolOwnerHintDelegation({
    date: input.date,
    item,
    candidate,
    dispatchId: gate.dispatchId,
  });
  try {
    const receipt = spawnOwnerDecisionDelegation(delegation);
    appendDispatchLog({
      date: input.date,
      runId: input.runId,
      dispatchId: gate.dispatchId,
      kind: "owner_delegation",
      targetSession: item.repo,
      repo: item.repo,
      status: "sent",
      message: delegation.payload.prompt,
      dirtyFingerprint: candidate.fingerprint,
      skippedReason: candidate.skippedReason,
      clientRequestId: delegation.clientRequestId,
      verificationToken: delegation.verificationToken,
      acceptedReceipt: receipt.receiptSummary,
      spawnResponse: JSON.stringify(receipt.body),
    });
    return "sent";
  } catch (error) {
    appendDispatchLog({
      date: input.date,
      runId: input.runId,
      dispatchId: gate.dispatchId,
      kind: "owner_delegation",
      targetSession: item.repo,
      repo: item.repo,
      status: "failed",
      message: delegation.payload.prompt,
      dirtyFingerprint: candidate.fingerprint,
      skippedReason: candidate.skippedReason,
      clientRequestId: delegation.clientRequestId,
      verificationToken: delegation.verificationToken,
      error: (error as Error).message,
    });
    return "failed";
  }
}
