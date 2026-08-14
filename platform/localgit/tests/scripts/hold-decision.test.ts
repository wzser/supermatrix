import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyHoldDecision } from "../../src/scripts/hold-decision.js";

const scratchDirs: string[] = [];

function git(path: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf-8" });
}

function makeHoldRepo(): { path: string; holdBranch: string; fingerprint: string; decisions: string } {
  const path = mkdtempSync(join(tmpdir(), "localgit-hold-decision-"));
  scratchDirs.push(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "a.ts"), "one\n");
  git(path, "add", "--", "a.ts");
  git(path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "init");
  const holdBranch = "localgit/hold/scratch/abc123def456";
  git(path, "switch", "-q", "-c", holdBranch);
  writeFileSync(join(path, "a.ts"), "two\n");
  git(path, "add", "--", "a.ts");
  git(path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "hold");
  git(path, "switch", "-q", "main");
  return { path, holdBranch, fingerprint: "abc123def4567890", decisions: join(path, "decisions.jsonl") };
}

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

describe("hold decisions", () => {
  it("merges only by fast-forward and records intent plus resolution", () => {
    const repo = makeHoldRepo();
    const holdHead = git(repo.path, "rev-parse", repo.holdBranch).trim();

    const result = applyHoldDecision({
      repo: "scratch",
      repoPath: repo.path,
      originalBranch: "main",
      holdBranch: repo.holdBranch,
      holdCommit: holdHead,
      dirtyFingerprint: repo.fingerprint,
      decision: "merge",
      actor: "scratch",
      decisionLogFile: repo.decisions,
    });

    expect(result.status).toBe("merged");
    expect(git(repo.path, "rev-parse", "HEAD").trim()).toBe(holdHead);
    const rows = readFileSync(repo.decisions, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.decision)).toEqual(["hold_merge", "hold_merged"]);
  });

  it("refuses merge when the original branch is dirty", () => {
    const repo = makeHoldRepo();
    const holdHead = git(repo.path, "rev-parse", repo.holdBranch).trim();
    writeFileSync(join(repo.path, "dirty.ts"), "dirty\n");

    expect(() => applyHoldDecision({
      repo: "scratch",
      repoPath: repo.path,
      originalBranch: "main",
      holdBranch: repo.holdBranch,
      holdCommit: holdHead,
      dirtyFingerprint: repo.fingerprint,
      decision: "merge",
      actor: "scratch",
      decisionLogFile: repo.decisions,
    })).toThrow("original branch is dirty");
    expect(git(repo.path, "branch", "--show-current").trim()).toBe("main");
  });

  it("archives without mutating git state", () => {
    const repo = makeHoldRepo();
    const holdHead = git(repo.path, "rev-parse", repo.holdBranch).trim();
    const before = git(repo.path, "rev-parse", "HEAD").trim();
    const result = applyHoldDecision({
      repo: "scratch",
      repoPath: repo.path,
      originalBranch: "main",
      holdBranch: repo.holdBranch,
      holdCommit: holdHead,
      dirtyFingerprint: repo.fingerprint,
      decision: "archive",
      actor: "scratch",
      decisionLogFile: repo.decisions,
    });
    expect(result.status).toBe("archived");
    expect(git(repo.path, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("refuses every decision when the hold branch advanced after review", () => {
    const repo = makeHoldRepo();
    const reviewedHead = git(repo.path, "rev-parse", repo.holdBranch).trim();
    git(repo.path, "switch", "-q", repo.holdBranch);
    writeFileSync(join(repo.path, "a.ts"), "unreviewed\n");
    git(repo.path, "add", "--", "a.ts");
    git(repo.path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "advance");
    git(repo.path, "switch", "-q", "main");
    const mainBefore = git(repo.path, "rev-parse", "main").trim();

    for (const decision of ["merge", "archive", "keep_until"] as const) {
      expect(() => applyHoldDecision({
        repo: "scratch", repoPath: repo.path, originalBranch: "main", holdBranch: repo.holdBranch,
        holdCommit: reviewedHead, dirtyFingerprint: repo.fingerprint, decision, actor: "scratch",
        decisionLogFile: repo.decisions, expiresAt: "2099-01-01T00:00:00.000Z",
      })).toThrow("hold branch ref changed");
    }
    expect(git(repo.path, "rev-parse", "main").trim()).toBe(mainBefore);
  });
});
