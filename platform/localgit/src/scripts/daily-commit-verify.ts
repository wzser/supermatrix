import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGitLedgerEntries, type GitLedgerEntry } from "./git-ledger.js";

export type DailyRunRepo = {
  name: string;
  path: string;
  dirtyBefore: string[];
  directPurgeCandidates?: string[];
};
export type DailyRunState = { runId: string; repos: DailyRunRepo[] };

export type DailyVerifierDeps = {
  statusFiles(path: string): string[];
  branch(path: string): string;
  head(path: string): string;
  branchHead(path: string, branch: string): string | undefined;
  commitFiles(path: string, commit: string): string[];
  // liveDeps always provides this; when a test omits it, the hold-restore check
  // falls back to the legacy strict head-equality semantics.
  isAncestor?(path: string, ancestor: string, descendant: string): boolean;
};

export type DailyVerifyResult = { ok: boolean; errors: string[]; verifiedRepos: number };

export function writeDailyRunState(path: string, state: DailyRunState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, path);
}

function isExplicitDirectPurgeDeferral(row: GitLedgerEntry, file: string): boolean {
  if (row.operation !== "skip" || row.purge_phase) return false;
  if (!/deferred: in-flight session activity|daily-commit time budget/i.test(row.skipped_reason ?? "")) return false;
  return row.per_file_dispositions?.some(
    (disposition) => disposition.file === file && disposition.class === "noise" && disposition.verdict === "KEEP_DIRTY",
  ) ?? false;
}

function hasDirectPurgeDisposition(
  row: GitLedgerEntry,
  file: string,
  verdict: "PURGE_PENDING" | "PURGED",
): boolean {
  return row.operation === "skip" && (row.per_file_dispositions?.some(
    (disposition) => disposition.file === file && disposition.class === "noise" && disposition.verdict === verdict,
  ) ?? false);
}

export function verifyDailyRun(
  input: DailyRunState & { ledgerEntries: GitLedgerEntry[] },
  deps: DailyVerifierDeps,
): DailyVerifyResult {
  const errors: string[] = [];
  for (const repo of input.repos) {
    const rows = input.ledgerEntries.filter((entry) => entry.run_id === input.runId && entry.repo === repo.name);
    if (rows.length === 0) {
      errors.push(`${repo.name}: no ledger row for run ${input.runId}`);
      continue;
    }
    const dirty = new Set(deps.statusFiles(repo.path));
    for (const file of repo.directPurgeCandidates ?? []) {
      const candidateRows = rows.filter((row) => row.changed_files.includes(file));
      if (candidateRows.length === 0) {
        errors.push(`${repo.name}: direct purge candidate lacks ledger accounting: ${file}`);
        continue;
      }
      const hasIntent = rows.some((row) => row.purge_phase === "intent" && row.changed_files.includes(file) && hasDirectPurgeDisposition(row, file, "PURGE_PENDING"));
      const hasCompletion = rows.some((row) => row.purge_phase === "completed" && row.changed_files.includes(file) && hasDirectPurgeDisposition(row, file, "PURGED") && typeof row.reclaimed_bytes === "number");
      const hasPair = hasIntent && hasCompletion;
      const deferred = candidateRows.some((row) => isExplicitDirectPurgeDeferral(row, file));
      if (!hasPair && !deferred) {
        errors.push(`${repo.name}: direct purge candidate lacks paired intent/completion or explicit deferral: ${file}`);
      }
    }
    for (const row of rows.filter((row) => row.purge_phase === "intent")) {
      for (const file of row.changed_files) {
        if (!hasDirectPurgeDisposition(row, file, "PURGE_PENDING")) {
          errors.push(`${repo.name}: direct purge intent lacks PURGE_PENDING disposition for ${file}`);
        }
        const hasCompletion = rows.some((candidate) => candidate.purge_phase === "completed" && candidate.changed_files.includes(file) && hasDirectPurgeDisposition(candidate, file, "PURGED") && typeof candidate.reclaimed_bytes === "number");
        if (!hasCompletion) {
          errors.push(`${repo.name}: direct purge intent lacks completion for ${file}`);
        }
      }
    }
    for (const row of rows.filter((row) => row.purge_phase === "completed")) {
      if (typeof row.reclaimed_bytes !== "number") {
        errors.push(`${repo.name}: completed direct purge lacks reclaimed byte count`);
      }
      for (const file of row.changed_files) {
        if (!hasDirectPurgeDisposition(row, file, "PURGED")) {
          errors.push(`${repo.name}: completed direct purge lacks PURGED disposition for ${file}`);
        }
        const hasIntent = rows.some((candidate) => candidate.purge_phase === "intent" && candidate.changed_files.includes(file) && hasDirectPurgeDisposition(candidate, file, "PURGE_PENDING"));
        if (!hasIntent) {
          errors.push(`${repo.name}: completed direct purge lacks intent for ${file}`);
        }
      }
      const remaining = row.changed_files.filter((file) => dirty.has(file));
      if (remaining.length > 0) {
        errors.push(`${repo.name}: completed direct purge files still dirty: ${remaining.join(", ")}`);
      }
    }
    for (const row of rows.filter((row) => row.purge_phase === "failed")) {
      errors.push(`${repo.name}: direct purge failed: ${row.changed_files.join(", ")}`);
    }
    for (const row of rows) {
      if (row.operation === "commit") {
        // Check against the commit's real file list (git show), not the ledger's
        // changed_files — historical rows recorded the whole dirty set there.
        let committedFiles: string[];
        try { committedFiles = deps.commitFiles(repo.path, row.head_after); } catch { committedFiles = row.changed_files; }
        const remaining = committedFiles.filter((file) => dirty.has(file));
        if (remaining.length > 0) errors.push(`${repo.name}: committed files still dirty: ${remaining.join(", ")}`);
      } else if (row.operation === "hold_commit") {
        if (!row.original_branch || !row.hold_branch || !row.hold_commit_sha) {
          errors.push(`${repo.name}: hold ledger metadata incomplete`);
          continue;
        }
        // Restored means: back on the original branch with HEAD at or *descended
        // from* head_after — the owner may legitimately merge the hold back or
        // commit on top the same night (adjiagou 2026-09-02 hold_merged case).
        const liveHead = deps.head(repo.path);
        if (deps.branch(repo.path) !== row.original_branch
          || (liveHead !== row.head_after && !(deps.isAncestor?.(repo.path, row.head_after, liveHead) ?? false))) {
          errors.push(`${repo.name}: original branch or HEAD was not restored`);
        }
        if (deps.branchHead(repo.path, row.hold_branch) !== row.hold_commit_sha) {
          errors.push(`${repo.name}: hold branch does not resolve to recorded commit`);
        }
        const committedFiles = deps.commitFiles(repo.path, row.hold_commit_sha).sort();
        if (JSON.stringify(committedFiles) !== JSON.stringify([...row.changed_files].sort())) {
          errors.push(`${repo.name}: hold commit file set disagrees with ledger`);
        }
        const remaining = row.changed_files.filter((file) => dirty.has(file));
        if (remaining.length > 0) errors.push(`${repo.name}: hold files still dirty: ${remaining.join(", ")}`);
      } else if (row.operation === "skip") {
        if (!row.skipped_reason || !row.per_file_dispositions?.length) {
          errors.push(`${repo.name}: blocked repository lacks explicit reason and dispositions`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, verifiedRepos: input.repos.length };
}

function git(path: string, args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf-8", timeout: 30000, maxBuffer: 20 * 1024 * 1024 }).trim();
}

function liveDeps(): DailyVerifierDeps {
  return {
    statusFiles: (path) => git(path, ["status", "--porcelain", "--untracked-files=all"])
      .split("\n").filter(Boolean).map((line) => line.slice(3)).sort(),
    branch: (path) => git(path, ["branch", "--show-current"]),
    head: (path) => git(path, ["rev-parse", "HEAD"]),
    branchHead: (path, branch) => {
      try { return git(path, ["rev-parse", `refs/heads/${branch}`]); } catch { return undefined; }
    },
    commitFiles: (path, commit) => git(path, ["show", "--format=", "--name-only", commit]).split("\n").filter(Boolean),
    isAncestor: (path, ancestor, descendant) => {
      try { git(path, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
    },
  };
}

function runCli(): void {
  const statePath = join(process.cwd(), "data", "run-state", "latest-daily-run.json");
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as DailyRunState;
  const ledgerEntries = readGitLedgerEntries(join(process.cwd(), "data", "git-ledger.jsonl"));
  const result = verifyDailyRun({ ...state, ledgerEntries }, liveDeps());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
