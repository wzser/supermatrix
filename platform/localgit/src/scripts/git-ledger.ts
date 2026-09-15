import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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
  purge_phase?: "intent" | "completed" | "failed";
  reclaimed_bytes?: number;
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
  purgePhase?: "intent" | "completed" | "failed";
  reclaimedBytes?: number;
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
  if (input.purgePhase) entry.purge_phase = input.purgePhase;
  if (typeof input.reclaimedBytes === "number") entry.reclaimed_bytes = input.reclaimedBytes;
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

export function appendGitLedgerEntry(
  ledgerPath: string,
  entry: GitLedgerEntry,
  options: { durable?: boolean } = {},
): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const fd = openSync(ledgerPath, "a");
  try {
    const data = Buffer.from(JSON.stringify(entry) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error("short git-ledger write");
      offset += written;
    }
    if (options.durable) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function getLastLedgerHeadByRepo(ledgerPath: string): Map<string, string> {
  const heads = new Map<string, string>();
  if (!existsSync(ledgerPath)) return heads;

  for (const line of iterateGitLedgerLines(ledgerPath)) {
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

// Bounded-chunk line reader: peak transient memory stays O(chunk + longest line)
// instead of O(file size) — readFileSync on a >512MB ledger crashes Node with
// ERR_STRING_TOO_LONG (2026-08-27 nightly startup-crash incident).
const LEDGER_READ_CHUNK_BYTES = 8 * 1024 * 1024;
// Hard per-line cap: a pathological row (e.g. an un-grouped mega disposition
// list) is dropped via the malformed-row tolerance instead of growing `carry`
// without bound. Skips are counted and summarized on stderr per file.
export const LEDGER_LINE_MAX_BYTES = 32 * 1024 * 1024;

function* iterateGitLedgerLines(ledgerPath: string): Generator<string> {
  const fd = openSync(ledgerPath, "r");
  let skippedOversized = 0;
  try {
    const decoder = new StringDecoder("utf-8");
    const buffer = Buffer.allocUnsafe(LEDGER_READ_CHUNK_BYTES);
    let carry = "";
    let pendingBytes = 0;
    let overflowing = false;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      // StringDecoder holds a multi-byte character split across the chunk
      // boundary until its remaining bytes arrive — no U+FFFD corruption.
      let text = decoder.write(buffer.subarray(0, bytesRead));
      if (overflowing) {
        // Discarding an oversized line: drop everything up to its newline.
        const end = text.indexOf("\n");
        if (end < 0) continue;
        text = text.slice(end + 1);
        overflowing = false;
      }
      carry += text;
      let newline = carry.indexOf("\n");
      while (newline >= 0) {
        yield carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        newline = carry.indexOf("\n");
      }
      // Whatever remains in carry is one partial line; if it alone exceeds the
      // hard cap, drop it and keep dropping until its newline shows up.
      pendingBytes = Buffer.byteLength(carry);
      if (pendingBytes > LEDGER_LINE_MAX_BYTES) {
        skippedOversized++;
        overflowing = true;
        carry = "";
        pendingBytes = 0;
      }
    }
    carry += decoder.end();
    if (!overflowing && carry.length > 0) yield carry;
  } finally {
    closeSync(fd);
    if (skippedOversized > 0) {
      console.error(`git-ledger: skipped ${skippedOversized} oversized line(s) (> ${LEDGER_LINE_MAX_BYTES} bytes) in ${ledgerPath}`);
    }
  }
}

// Per-file entry stream: parse each line as it is read and hand it off
// immediately — no array is materialized anywhere on this path.
function* iterateGitLedgerFileEntries(ledgerPath: string): Generator<GitLedgerEntry> {
  if (!existsSync(ledgerPath)) return;
  for (const line of iterateGitLedgerLines(ledgerPath)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as GitLedgerEntry;
    } catch {
      // Querying should keep working even if a historical row was truncated.
    }
  }
}

// Shard-aware entry stream: archive shards in chronological order, then the
// active file. This is the memory-safe way to scan full history.
export function* iterateGitLedgerEntries(activePath: string): Generator<GitLedgerEntry> {
  for (const shard of listGitLedgerShards(activePath)) {
    yield* iterateGitLedgerFileEntries(shard);
  }
  yield* iterateGitLedgerFileEntries(activePath);
}

export function forEachGitLedgerEntry(activePath: string, onEntry: (entry: GitLedgerEntry) => void): void {
  for (const entry of iterateGitLedgerEntries(activePath)) {
    onEntry(entry);
  }
}

export function readGitLedgerEntries(ledgerPath: string): GitLedgerEntry[] {
  const entries: GitLedgerEntry[] = [];
  for (const entry of iterateGitLedgerFileEntries(ledgerPath)) {
    entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Ledger rotation: the active file is append-only and unbounded, so an
// oversized file is renamed aside as a timestamped shard (pure rename, no
// content read) and full-history readers merge shards + active in order.
// ---------------------------------------------------------------------------

export const GIT_LEDGER_DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

function ledgerShardRegExp(activePath: string): RegExp {
  const stem = basename(activePath).replace(/\.jsonl$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${stem}\\.\\d{8}-\\d{6}\\.jsonl$`);
}

export function listGitLedgerShards(activePath: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dirname(activePath));
  } catch {
    return [];
  }
  const shardRe = ledgerShardRegExp(activePath);
  // yyyyMMdd-HHmmss sorts chronologically as a plain string.
  return names.filter((name) => shardRe.test(name)).sort().map((name) => join(dirname(activePath), name));
}

export function rotateGitLedgerIfNeeded(
  activePath: string,
  maxBytes: number = GIT_LEDGER_DEFAULT_MAX_BYTES,
): string | null {
  let size: number;
  try {
    size = statSync(activePath).size;
  } catch {
    return null;
  }
  if (size <= maxBytes) return null;

  const now = new Date().toISOString();
  const stamp = `${now.slice(0, 10).replace(/-/g, "")}-${now.slice(11, 19).replace(/:/g, "")}`;
  const shardPath = join(dirname(activePath), `${basename(activePath).replace(/\.jsonl$/, "")}.${stamp}.jsonl`);
  // A same-second second rotation would overwrite the previous shard; skip and
  // let the next run rotate instead — the ledger must never lose history.
  if (existsSync(shardPath)) return null;
  renameSync(activePath, shardPath);
  // appendGitLedgerEntry opens with flag "a", which recreates the active file on
  // the next append — no touch needed here.
  return shardPath;
}

export function readAllGitLedgerEntries(activePath: string): GitLedgerEntry[] {
  const entries: GitLedgerEntry[] = [];
  forEachGitLedgerEntry(activePath, (entry) => {
    entries.push(entry);
  });
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
