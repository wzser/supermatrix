import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readGitLedgerEntries, type GitLedgerEntry } from "./git-ledger.js";

export type DailyRunRepo = { name: string; path: string; dirtyBefore: string[] };
export type DailyRunState = { runId: string; repos: DailyRunRepo[] };

export type DailyVerifierDeps = {
  statusFiles(path: string): string[];
  branch(path: string): string;
  head(path: string): string;
  branchHead(path: string, branch: string): string | undefined;
  commitFiles(path: string, commit: string): string[];
};

export type DailyVerifyResult = { ok: boolean; errors: string[]; verifiedRepos: number };

export function writeDailyRunState(path: string, state: DailyRunState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + "\n");
  renameSync(temp, path);
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
    for (const row of rows) {
      if (row.operation === "commit") {
        const remaining = row.changed_files.filter((file) => dirty.has(file));
        if (remaining.length > 0) errors.push(`${repo.name}: committed files still dirty: ${remaining.join(", ")}`);
      } else if (row.operation === "hold_commit") {
        if (!row.original_branch || !row.hold_branch || !row.hold_commit_sha) {
          errors.push(`${repo.name}: hold ledger metadata incomplete`);
          continue;
        }
        if (deps.branch(repo.path) !== row.original_branch || deps.head(repo.path) !== row.head_after) {
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
