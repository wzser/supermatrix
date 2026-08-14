export type DailyCommitSkipRouting = {
  routeToOwner: boolean;
  owner: "localgit" | "repo-owner";
};

const LOCALGIT_OWNED_SKIP_PATTERNS = [
  /processing error:/i,
  /daily-commit time budget/i,
  /daily-commit session selection failed/i,
  /codex reviewer likely stalled/i,
  /stale must-review dirty set/i,
  /\b(ETIMEDOUT|ENOBUFS|E2BIG|ENOENT)\b/i,
];

export function classifyDailyCommitSkipRouting(skippedReason: string): DailyCommitSkipRouting {
  const reason = skippedReason.trim();

  if (!reason || LOCALGIT_OWNED_SKIP_PATTERNS.some((pattern) => pattern.test(reason))) {
    return { routeToOwner: false, owner: "localgit" };
  }

  if (/^blocked:\s*must-review dirty set could not be reviewed by localgit/i.test(reason)) {
    return { routeToOwner: true, owner: "repo-owner" };
  }

  return { routeToOwner: true, owner: "repo-owner" };
}
