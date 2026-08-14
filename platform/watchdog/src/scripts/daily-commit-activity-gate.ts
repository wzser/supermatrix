export const DAILY_COMMIT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

const OWNER_ROUTED_DIRS = new Set(["artifacts", "outputs", "data", "exports", "screenshots", "captures", "reports", "media"]);

export type ActivityGateInput = {
  now: number;
  lastMessageRunAt: number | null;
  latestDirtyMtime: number | null;
  repoName: string;
  windowMs?: number;
};

export type ActivityGateDecision =
  | { kind: "process" }
  | { kind: "defer"; reason: string };

export type DailyCommitResultLike = {
  committed: boolean;
  deferred?: boolean;
  watchdogOwned?: boolean;
};

export type MessageRunActivityRow = {
  started_at: number;
  prompt: string;
};

export function isDailyCommitOperationalPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes("daily-commit") || normalized.includes("daily commit");
}

export function getLastActivityMessageRunAtFromRows(rows: MessageRunActivityRow[]): number | null {
  for (const row of rows) {
    if (Number.isFinite(row.started_at) && !isDailyCommitOperationalPrompt(row.prompt)) {
      return row.started_at;
    }
  }
  return null;
}

export function isOwnerRoutedDailyCommitPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const firstSegment = normalized.split("/")[0];
  return OWNER_ROUTED_DIRS.has(firstSegment);
}

export function filterActivityRelevantDirtyFiles(filePaths: string[]): string[] {
  return filePaths.filter((filePath) => !isOwnerRoutedDailyCommitPath(filePath));
}

export function decideDailyCommitActivityGate(input: ActivityGateInput): ActivityGateDecision {
  const windowMs = input.windowMs ?? DAILY_COMMIT_ACTIVITY_WINDOW_MS;
  const hasRecentMessage = input.lastMessageRunAt !== null && input.now - input.lastMessageRunAt <= windowMs;
  const hasRecentDirtyFile = input.latestDirtyMtime !== null && input.now - input.latestDirtyMtime <= windowMs;

  if (hasRecentMessage || hasRecentDirtyFile) {
    return { kind: "process" };
  }

  const hours = Math.round(windowMs / (60 * 60 * 1000));
  return {
    kind: "defer",
    reason: `deferred: inactive session and stale dirty set (> ${hours}h without relevant message or source/config mtime change)`,
  };
}

export function splitDailyCommitResults<T extends DailyCommitResultLike>(results: T[]): {
  committed: T[];
  skipped: T[];
  deferred: T[];
  watchdogOwned: T[];
} {
  const committed = results.filter((r) => r.committed);
  const deferred = results.filter((r) => !r.committed && r.deferred);
  const watchdogOwned = results.filter((r) => !r.committed && r.watchdogOwned);
  const skipped = results.filter((r) => !r.committed && !r.deferred && !r.watchdogOwned);
  return { committed, skipped, deferred, watchdogOwned };
}
