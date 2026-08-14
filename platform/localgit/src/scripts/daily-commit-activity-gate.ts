// Message-run activity helpers + run-result partitioning for daily-commit.
// The 2026-07-03 judgment-matrix redesign removed the legacy activity gate
// (stale+inactive → backlog): gating now lives in decideInFlightGate in
// daily-commit-judgment-matrix.ts with inverted semantics (recent activity
// defers, staleness processes). See SOP-daily-commit-judgment-matrix Step 6.

export type DailyCommitResultLike = {
  committed: boolean;
  deferred?: boolean;
  localgitOwned?: boolean;
  holdOnly?: boolean;
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

export function splitDailyCommitResults<T extends DailyCommitResultLike>(results: T[]): {
  committed: T[];
  skipped: T[];
  deferred: T[];
  localgitOwned: T[];
} {
  const committed = results.filter((r) => r.committed);
  const deferred = results.filter((r) => !r.committed && r.deferred);
  const localgitOwned = results.filter((r) => !r.committed && r.localgitOwned);
  const skipped = results.filter((r) => !r.committed && !r.deferred && !r.localgitOwned);
  return { committed, skipped, deferred, localgitOwned };
}

export function shouldReloadAfterDailyCommit<T extends DailyCommitResultLike>(results: T[]): boolean {
  return results.some((result) => result.committed && !result.holdOnly);
}
