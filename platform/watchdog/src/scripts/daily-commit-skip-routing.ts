export type DailyCommitSkipRouting = {
  routeToOwner: boolean;
  owner: "watchdog" | "repo-owner";
};

const WATCHDOG_OWNED_SKIP_PATTERNS = [
  /^processing error:/i,
  /daily-commit time budget/i,
  /daily-commit control fetch failed/i,
  /codex reviewer likely stalled/i,
  /\b(ETIMEDOUT|ENOBUFS|E2BIG)\b/i,
];

export function classifyDailyCommitSkipRouting(skippedReason: string): DailyCommitSkipRouting {
  const reason = skippedReason.trim();

  if (!reason || WATCHDOG_OWNED_SKIP_PATTERNS.some((pattern) => pattern.test(reason))) {
    return { routeToOwner: false, owner: "watchdog" };
  }

  return { routeToOwner: true, owner: "repo-owner" };
}
