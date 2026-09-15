import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type HoldDecision = "merge" | "archive" | "keep_until";

export type HoldDecisionInput = {
  repo: string;
  repoPath: string;
  originalBranch: string;
  holdBranch: string;
  holdCommit: string;
  dirtyFingerprint: string;
  decision: HoldDecision;
  actor: string;
  decisionLogFile: string;
  expiresAt?: string;
};

export type HoldDecisionResult = {
  status: "merged" | "archived" | "kept_until";
  head?: string;
  expiresAt?: string;
};

function git(path: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: path,
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function appendDecision(input: HoldDecisionInput, decision: string, reason: string, expiresAt?: string): void {
  const recordedAt = new Date().toISOString();
  const decisionId = `dcd-${createHash("sha256")
    .update(`${input.repo}\0${input.dirtyFingerprint}\0${decision}\0${recordedAt}`)
    .digest("hex").slice(0, 12)}`;
  mkdirSync(dirname(input.decisionLogFile), { recursive: true });
  appendFileSync(input.decisionLogFile, JSON.stringify({
    recorded_at: recordedAt,
    decision_id: decisionId,
    repo: input.repo,
    dirty_fingerprint: input.dirtyFingerprint,
    decision,
    actor: input.actor,
    scope: "hold_branch",
    reason,
    expires_at: expiresAt,
    original_branch: input.originalBranch,
    hold_branch: input.holdBranch,
    hold_commit: input.holdCommit,
  }) + "\n");
}

export function applyHoldDecision(input: HoldDecisionInput): HoldDecisionResult {
  git(input.repoPath, ["show-ref", "--verify", `refs/heads/${input.holdBranch}`]);
  const liveHoldHead = git(input.repoPath, ["rev-parse", `refs/heads/${input.holdBranch}`]);
  if (liveHoldHead !== input.holdCommit) {
    throw new Error(`hold branch ref changed after review: expected ${input.holdCommit}, found ${liveHoldHead}`);
  }
  if (input.decision === "archive") {
    appendDecision(input, "hold_archive", "owner archived hold branch until fingerprint changes");
    return { status: "archived" };
  }
  if (input.decision === "keep_until") {
    const expires = Date.parse(input.expiresAt ?? "");
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      throw new Error("keep_until requires a future ISO --expires-at");
    }
    appendDecision(input, "hold_keep_until", "owner deferred hold merge", input.expiresAt);
    return { status: "kept_until", expiresAt: input.expiresAt };
  }

  const currentBranch = git(input.repoPath, ["branch", "--show-current"]);
  if (currentBranch !== input.originalBranch) {
    throw new Error(`expected original branch ${input.originalBranch}, found ${currentBranch || "detached"}`);
  }
  if (git(input.repoPath, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("original branch is dirty");
  }
  git(input.repoPath, ["merge-base", "--is-ancestor", input.originalBranch, input.holdCommit]);
  appendDecision(input, "hold_merge", "owner approved guarded fast-forward merge");
  try {
    git(input.repoPath, ["merge", "--ff-only", input.holdCommit]);
    const head = git(input.repoPath, ["rev-parse", "HEAD"]);
    if (head !== input.holdCommit) throw new Error("merged HEAD does not match reviewed hold commit");
    appendDecision(input, "hold_merged", `verified merged head ${head}`);
    return { status: "merged", head };
  } catch (error) {
    appendDecision(input, "hold_merge_failed", (error as Error).message);
    throw error;
  }
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function requireArg(name: string): string {
  const value = getArg(name);
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function runCli(): void {
  const repoPath = requireArg("--repo-path");
  const result = applyHoldDecision({
    repo: requireArg("--repo"),
    repoPath,
    originalBranch: requireArg("--original-branch"),
    holdBranch: requireArg("--hold-branch"),
    holdCommit: requireArg("--hold-commit"),
    dirtyFingerprint: requireArg("--dirty-fingerprint"),
    decision: requireArg("--decision") as HoldDecision,
    actor: getArg("--actor") ?? process.env.SM_SESSION_NAME ?? "localgit",
    decisionLogFile: getArg("--decision-log") ?? join(process.cwd(), "data", "daily-commit-decisions.jsonl"),
    expiresAt: getArg("--expires-at"),
  });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
