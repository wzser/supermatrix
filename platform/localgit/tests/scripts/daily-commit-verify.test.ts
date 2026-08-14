import { describe, expect, it } from "vitest";
import { verifyDailyRun } from "../../src/scripts/daily-commit-verify.js";
import type { GitLedgerEntry } from "../../src/scripts/git-ledger.js";

const repo = { name: "scratch", path: "/repo/scratch", dirtyBefore: ["src/a.ts"] };

function entry(overrides: Partial<GitLedgerEntry> = {}): GitLedgerEntry {
  return {
    recorded_at: "2026-07-14T03:15:00.000Z",
    run_id: "run-1",
    repo: "scratch",
    repo_path: "/repo/scratch",
    branch: "main",
    actor: "localgit",
    operation: "commit",
    head_before: "a",
    head_after: "b",
    files_changed: 1,
    changed_files: ["src/a.ts"],
    ...overrides,
  };
}

describe("daily commit verifier", () => {
  it("fails when an eligible dirty repo has no run ledger row", () => {
    const result = verifyDailyRun({ runId: "run-1", repos: [repo], ledgerEntries: [] }, {
      statusFiles: () => ["src/a.ts"], branch: () => "main", head: () => "a",
      branchHead: () => undefined, commitFiles: () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("no ledger row");
  });

  it("fails when a committed SAFE path is still dirty", () => {
    const result = verifyDailyRun({ runId: "run-1", repos: [repo], ledgerEntries: [entry()] }, {
      statusFiles: () => ["src/a.ts"], branch: () => "main", head: () => "b",
      branchHead: () => undefined, commitFiles: () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("still dirty");
  });

  it("passes an explicit sensitive block", () => {
    const blocked = entry({
      operation: "skip",
      head_after: "a",
      skipped_reason: "blocked_sensitive: secret must be moved or ignored by owner",
      per_file_dispositions: [{ file: ".env", class: "deny_secret", verdict: "DENY", source: "l0" }],
      changed_files: [".env"],
    });
    const result = verifyDailyRun({ runId: "run-1", repos: [{ ...repo, dirtyBefore: [".env"] }], ledgerEntries: [blocked] }, {
      statusFiles: () => [".env"], branch: () => "main", head: () => "a",
      branchHead: () => undefined, commitFiles: () => [],
    });
    expect(result.ok).toBe(true);
  });

  it("verifies hold branch, commit files, and restored original state", () => {
    const hold = entry({
      operation: "hold_commit",
      head_after: "a",
      commit_sha: "h",
      original_branch: "main",
      hold_branch: "localgit/hold/scratch/fp",
      hold_commit_sha: "h",
    });
    const result = verifyDailyRun({ runId: "run-1", repos: [repo], ledgerEntries: [hold] }, {
      statusFiles: () => [], branch: () => "main", head: () => "a",
      branchHead: () => "h", commitFiles: () => ["src/a.ts"],
    });
    expect(result.ok).toBe(true);
  });
});
