export type DailyCommitBitableResult = {
  name: string;
  committed: boolean;
  message: string;
  filesChanged: number;
  skippedReason: string;
  autoFixed?: boolean;
};

export function buildDailyCommitBitableRecord(date: string, result: DailyCommitBitableResult): Record<string, string> {
  return {
    date,
    repo_name: result.name,
    committed: result.committed ? "yes" : "no",
    commit_message: result.message,
    files_changed: String(result.filesChanged),
    skipped_reason: result.skippedReason,
  };
}
