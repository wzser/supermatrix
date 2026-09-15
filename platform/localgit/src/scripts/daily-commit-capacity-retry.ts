import { classifyDailyCommitSkipRouting } from "./daily-commit-skip-routing.js";

type RetryCandidateLike = {
  committed: boolean;
  deferred?: boolean;
  skippedReason: string;
};

const TIME_BUDGET_RE = /daily-commit time budget \(\d+min\) (?:exceeded|reached retry-tail reserve boundary)/i;
const MUST_REVIEW_BLOCK_RE = /^blocked:\s*must-review dirty set could not be reviewed by localgit/i;

export function canStartPrimaryLoopWork(input: {
  loopStartedAt: number;
  now: number;
  loopBudgetMs: number;
  primaryReviewerTimeoutMs: number;
  retryReviewerTimeoutMs: number;
  retryReserveMs: number;
}): boolean {
  const elapsedMs = input.now - input.loopStartedAt;
  const primaryReviewReserveMs = input.primaryReviewerTimeoutMs * 2;
  const retryAttemptReserveMs = input.retryReviewerTimeoutMs * 2 + input.retryReserveMs;
  return elapsedMs >= 0 && elapsedMs + primaryReviewReserveMs + retryAttemptReserveMs <= input.loopBudgetMs;
}

// A reviewer invocation can make two short attempts. Only start it when both
// attempts plus Git/result-recording reserve fit inside the retry tail budget.
export function canStartCapacityRetry(input: {
  retryStartedAt: number;
  now: number;
  budgetMs: number;
  reviewerTimeoutMs: number;
  reserveMs: number;
}): boolean {
  const elapsedMs = input.now - input.retryStartedAt;
  const maxPerRepoMs = input.reviewerTimeoutMs * 2 + input.reserveMs;
  return elapsedMs >= 0 && elapsedMs + maxPerRepoMs <= input.budgetMs;
}

export function isTimeBudgetRetryCandidate(result: RetryCandidateLike): boolean {
  return isLocalgitReviewBlock(result) && TIME_BUDGET_RE.test(result.skippedReason);
}

export function isLocalgitReviewBlock(result: RetryCandidateLike): boolean {
  if (result.committed || result.deferred) return false;
  if (!MUST_REVIEW_BLOCK_RE.test(result.skippedReason)) return false;
  return classifyDailyCommitSkipRouting(result.skippedReason).owner === "localgit";
}
