import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type GitLedgerOperation = "commit" | "hold_commit" | "merge_detected" | "skip";

// Structurally compatible with FileDisposition in daily-commit-judgment-matrix.ts;
// kept local so the ledger module stays dependency-free of the matrix module.
export type LedgerFileDisposition = {
  file: string;
  class: string;
  verdict: string;
  reason?: string;
  source: string;
};

export type GitLedgerEntry = {
  recorded_at: string;
  run_id: string;
  repo: string;
  repo_path: string;
  branch: string;
  actor: string;
  operation: GitLedgerOperation;
  head_before: string;
  head_after: string;
  commit_sha?: string;
  parents?: string[];
  message?: string;
  files_changed: number;
  changed_files: string[];
  skipped_reason?: string;
  dirty_fingerprint?: string;
  per_file_dispositions?: LedgerFileDisposition[];
  decision_source?: string;
  original_branch?: string;
  hold_branch?: string;
  hold_commit_sha?: string;
};

type CommitLedgerInput = {
  runId: string;
  repo: string;
  repoPath: string;
  branch: string;
  actor: string;
  headBefore: string;
  headAfter: string;
  parents: string[];
  message: string;
  filesChanged: number;
  changedFiles: string[];
  recordedAt?: string;
  perFileDispositions?: LedgerFileDisposition[];
  decisionSource?: string;
};

type SkipLedgerInput = {
  runId: string;
  repo: string;
  repoPath: string;
  branch: string;
  actor: string;
  head: string;
  filesChanged: number;
  changedFiles: string[];
  skippedReason: string;
  dirtyFingerprint?: string;
  recordedAt?: string;
  perFileDispositions?: LedgerFileDisposition[];
  decisionSource?: string;
};

type HoldLedgerInput = {
  runId: string;
  repo: string;
  repoPath: string;
  actor: string;
  originalBranch: string;
  originalHead: string;
  holdBranch: string;
  holdCommit: string;
  message: string;
  changedFiles: string[];
  dirtyFingerprint: string;
  recordedAt?: string;
  perFileDispositions?: LedgerFileDisposition[];
  decisionSource?: string;
};

export function buildCommitLedgerEntry(input: CommitLedgerInput): GitLedgerEntry {
  const entry: GitLedgerEntry = {
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    run_id: input.runId,
    repo: input.repo,
    repo_path: input.repoPath,
    branch: input.branch,
    actor: input.actor,
    operation: input.parents.length > 1 ? "merge_detected" : "commit",
    head_before: input.headBefore,
    head_after: input.headAfter,
    commit_sha: input.headAfter,
    parents: input.parents,
    message: input.message,
    files_changed: input.filesChanged,
    changed_files: input.changedFiles,
  };
  if (input.perFileDispositions?.length) entry.per_file_dispositions = input.perFileDispositions;
  if (input.decisionSource) entry.decision_source = input.decisionSource;
  return entry;
}

export function buildSkipLedgerEntry(input: SkipLedgerInput): GitLedgerEntry {
  const entry: GitLedgerEntry = {
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    run_id: input.runId,
    repo: input.repo,
    repo_path: input.repoPath,
    branch: input.branch,
    actor: input.actor,
    operation: "skip",
    head_before: input.head,
    head_after: input.head,
    files_changed: input.filesChanged,
    changed_files: input.changedFiles,
    skipped_reason: input.skippedReason,
  };
  if (input.dirtyFingerprint) {
    entry.dirty_fingerprint = input.dirtyFingerprint;
  }
  if (input.perFileDispositions?.length) entry.per_file_dispositions = input.perFileDispositions;
  if (input.decisionSource) entry.decision_source = input.decisionSource;
  return entry;
}

export function buildHoldLedgerEntry(input: HoldLedgerInput): GitLedgerEntry {
  const entry: GitLedgerEntry = {
    recorded_at: input.recordedAt ?? new Date().toISOString(),
    run_id: input.runId,
    repo: input.repo,
    repo_path: input.repoPath,
    branch: input.originalBranch,
    actor: input.actor,
    operation: "hold_commit",
    head_before: input.originalHead,
    head_after: input.originalHead,
    commit_sha: input.holdCommit,
    parents: [input.originalHead],
    message: input.message,
    files_changed: input.changedFiles.length,
    changed_files: input.changedFiles,
    dirty_fingerprint: input.dirtyFingerprint,
    original_branch: input.originalBranch,
    hold_branch: input.holdBranch,
    hold_commit_sha: input.holdCommit,
  };
  if (input.perFileDispositions?.length) entry.per_file_dispositions = input.perFileDispositions;
  if (input.decisionSource) entry.decision_source = input.decisionSource;
  return entry;
}

export function appendGitLedgerEntry(ledgerPath: string, entry: GitLedgerEntry): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify(entry) + "\n");
}

export function getLastLedgerHeadByRepo(ledgerPath: string): Map<string, string> {
  const heads = new Map<string, string>();
  if (!existsSync(ledgerPath)) return heads;

  for (const line of readFileSync(ledgerPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<GitLedgerEntry>;
      if (typeof entry.repo === "string" && typeof entry.head_after === "string") {
        heads.set(entry.repo, entry.head_after);
      }
    } catch {
      // Keep the ledger append-only and tolerate one malformed historical row.
    }
  }
  return heads;
}

export function readGitLedgerEntries(ledgerPath: string): GitLedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];

  const entries: GitLedgerEntry[] = [];
  for (const line of readFileSync(ledgerPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as GitLedgerEntry);
    } catch {
      // Querying should keep working even if a historical row was truncated.
    }
  }
  return entries;
}

export function filterGitLedgerEntries(
  entries: GitLedgerEntry[],
  filters: {
    repo?: string;
    repoPath?: string;
    operation?: GitLedgerOperation;
    since?: string;
    limit?: number;
  },
): GitLedgerEntry[] {
  const filtered = entries.filter((entry) => {
    if (filters.repo && entry.repo !== filters.repo) return false;
    if (filters.repoPath && entry.repo_path !== filters.repoPath) return false;
    if (filters.operation && entry.operation !== filters.operation) return false;
    if (filters.since && entry.recorded_at < filters.since) return false;
    return true;
  });

  const newestFirst = [...filtered].reverse();
  return typeof filters.limit === "number" ? newestFirst.slice(0, filters.limit) : newestFirst;
}
