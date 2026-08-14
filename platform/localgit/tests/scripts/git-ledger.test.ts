import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendGitLedgerEntry,
  buildCommitLedgerEntry,
  buildHoldLedgerEntry,
  buildSkipLedgerEntry,
  filterGitLedgerEntries,
  getLastLedgerHeadByRepo,
} from "../../src/scripts/git-ledger.js";

describe("git ledger", () => {
  it("records hold commits separately with original and hold branches", () => {
    const entry = buildHoldLedgerEntry({
      runId: "daily-2026-07-14T03:15:00+08:00",
      repo: "localgit",
      repoPath: "/repo/localgit",
      actor: "localgit",
      originalBranch: "main",
      originalHead: "aaa111",
      holdBranch: "localgit/hold/localgit/fp1234567890",
      holdCommit: "bbb222",
      message: "wip(hold): persist disputed working set for localgit",
      changedFiles: ["src/shared.ts"],
      dirtyFingerprint: "fp1234567890",
    });

    expect(entry.operation).toBe("hold_commit");
    expect(entry.branch).toBe("main");
    expect(entry.head_before).toBe("aaa111");
    expect(entry.head_after).toBe("aaa111");
    expect(entry.commit_sha).toBe("bbb222");
    expect(entry.original_branch).toBe("main");
    expect(entry.hold_branch).toBe("localgit/hold/localgit/fp1234567890");
    expect(entry.hold_commit_sha).toBe("bbb222");
  });

  it("builds auto-commit entries with traceable before and after heads", () => {
    const entry = buildCommitLedgerEntry({
      runId: "daily-2026-06-01T03:15:00.000Z",
      repo: "localgit",
      repoPath: "/repo/localgit",
      branch: "main",
      actor: "localgit",
      headBefore: "aaa111",
      headAfter: "bbb222",
      parents: ["aaa111"],
      message: "feat: move daily commit to localgit",
      filesChanged: 3,
      changedFiles: ["src/scripts/daily-commit.ts"],
    });

    expect(entry.operation).toBe("commit");
    expect(entry.repo).toBe("localgit");
    expect(entry.actor).toBe("localgit");
    expect(entry.head_before).toBe("aaa111");
    expect(entry.head_after).toBe("bbb222");
    expect(entry.commit_sha).toBe("bbb222");
    expect(entry.parents).toEqual(["aaa111"]);
    expect(entry.changed_files).toEqual(["src/scripts/daily-commit.ts"]);
  });

  it("marks commits with multiple parents as merge_detected", () => {
    const entry = buildCommitLedgerEntry({
      runId: "daily-2026-06-01T03:15:00.000Z",
      repo: "scheduler",
      repoPath: "/repo/scheduler",
      branch: "main",
      actor: "localgit",
      headBefore: "aaa111",
      headAfter: "merge333",
      parents: ["aaa111", "ccc222"],
      message: "merge branch feature",
      filesChanged: 0,
      changedFiles: [],
    });

    expect(entry.operation).toBe("merge_detected");
    expect(entry.parents).toHaveLength(2);
  });

  it("appends jsonl and finds the latest observed head per repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "localgit-ledger-test-"));
    const ledgerPath = join(dir, "ledger.jsonl");
    try {
      appendGitLedgerEntry(ledgerPath, buildSkipLedgerEntry({
        runId: "r1",
        repo: "after-sales",
        repoPath: "/repo/after-sales",
        branch: "main",
        actor: "localgit",
        head: "old",
        filesChanged: 2,
        changedFiles: ["data/a.json"],
        skippedReason: "owner-routed data export",
      }));
      appendGitLedgerEntry(ledgerPath, buildCommitLedgerEntry({
        runId: "r2",
        repo: "after-sales",
        repoPath: "/repo/after-sales",
        branch: "main",
        actor: "localgit",
        headBefore: "old",
        headAfter: "new",
        parents: ["old"],
        message: "chore: update generated report",
        filesChanged: 1,
        changedFiles: ["reports/a.md"],
      }));

      expect(readFileSync(ledgerPath, "utf-8").trim().split("\n")).toHaveLength(2);
      expect(getLastLedgerHeadByRepo(ledgerPath).get("after-sales")).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters entries for operator lookup", () => {
    const entries = [
      buildCommitLedgerEntry({
        runId: "r1",
        repo: "localgit",
        repoPath: "/repo/localgit",
        branch: "main",
        actor: "localgit",
        headBefore: "a",
        headAfter: "b",
        parents: ["a"],
        message: "feat: one",
        filesChanged: 1,
        changedFiles: ["a.ts"],
        recordedAt: "2026-06-01T01:00:00.000Z",
      }),
      buildSkipLedgerEntry({
        runId: "r2",
        repo: "scheduler",
        repoPath: "/repo/scheduler",
        branch: "main",
        actor: "localgit",
        head: "c",
        filesChanged: 2,
        changedFiles: ["data/x"],
        skippedReason: "owner-routed",
        recordedAt: "2026-06-01T02:00:00.000Z",
      }),
    ];

    expect(filterGitLedgerEntries(entries, { repo: "localgit" })).toHaveLength(1);
    expect(filterGitLedgerEntries(entries, { operation: "skip" })[0]?.repo).toBe("scheduler");
    expect(filterGitLedgerEntries(entries, { since: "2026-06-01T01:30:00.000Z" })[0]?.repo).toBe("scheduler");
    expect(filterGitLedgerEntries(entries, { limit: 1 })[0]?.run_id).toBe("r2");
  });

  it("filters by canonical repo path when multiple sessions share one workdir", () => {
    const entries = [
      buildSkipLedgerEntry({
        runId: "r1",
        repo: "codexroot",
        repoPath: "/Users/LOCAL_USER/SuperMatrix",
        branch: "main",
        actor: "localgit",
        head: "a",
        filesChanged: 1,
        changedFiles: ["src/a.ts"],
        skippedReason: "blocked: stale must-review dirty set queued for localgit review",
      }),
      buildSkipLedgerEntry({
        runId: "r2",
        repo: "localgit",
        repoPath: "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit",
        branch: "main",
        actor: "localgit",
        head: "b",
        filesChanged: 1,
        changedFiles: ["src/scripts/daily-commit.ts"],
        skippedReason: "blocked: must-review dirty set could not be reviewed by localgit",
      }),
    ];

    expect(filterGitLedgerEntries(entries, { repoPath: "/Users/LOCAL_USER/SuperMatrix" })).toHaveLength(1);
    expect(filterGitLedgerEntries(entries, { repoPath: "/Users/LOCAL_USER/SuperMatrix" })[0]?.repo).toBe("codexroot");
  });

  it("records dirty fingerprints on skip entries for audit", () => {
    const entry = buildSkipLedgerEntry({
      runId: "r1",
      repo: "amz-sql",
      repoPath: "/repo/amz-sql",
      branch: "main",
      actor: "localgit",
      head: "aaa111",
      filesChanged: 2,
      changedFiles: ["src/a.ts", "tests/a.test.ts"],
      skippedReason: "blocked: must-review dirty set could not be reviewed by localgit",
      dirtyFingerprint: "fp-1",
      recordedAt: "2026-06-01T20:00:00.000Z",
    });

    expect(entry.dirty_fingerprint).toBe("fp-1");
  });
});
