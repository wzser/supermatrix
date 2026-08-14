import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitToHoldBranch,
  isHoldEligible,
  maybeCommitResultToHold,
} from "../../src/scripts/daily-commit-hold.js";
import type { FileDisposition } from "../../src/scripts/daily-commit-judgment-matrix.js";

const scratchDirs: string[] = [];

function git(path: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf-8" });
}

function makeRepo(): { name: string; path: string } {
  const path = mkdtempSync(join(tmpdir(), "localgit-hold-"));
  scratchDirs.push(path);
  git(path, "init", "-q", "-b", "main");
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "src/shared.ts"), "export const value = 1;\n");
  git(path, "add", "--", "src/shared.ts");
  git(path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "init");
  return { name: "scratch", path };
}

function disposition(file: string, reason: string, verdict: "RISKY" | "OWNER" = "RISKY"): FileDisposition {
  return { file, class: "source", verdict, reason, source: "l2-fresh" };
}

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

describe("daily-commit hold transaction", () => {
  it("commits a homogeneous disputed set to hold and restores main clean", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "src/shared.ts"), "export const value = 2;\n");
    writeFileSync(join(repo.path, "src/contract.ts"), "export const contract = 1;\n");
    const originalHead = git(repo.path, "rev-parse", "HEAD").trim();

    const result = commitToHoldBranch(repo, {
      fingerprint: "abc123def4567890",
      files: ["src/shared.ts", "src/contract.ts"],
    });

    expect(result.ok).toBe(true);
    expect(result.originalBranch).toBe("main");
    expect(result.originalHead).toBe(originalHead);
    expect(result.holdBranch).toBe("localgit/hold/scratch/abc123def456");
    expect(git(repo.path, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo.path, "rev-parse", "HEAD").trim()).toBe(originalHead);
    expect(git(repo.path, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(
      git(repo.path, "show", "--format=", "--name-only", result.holdCommit!).split("\n").filter(Boolean).sort(),
    ).toEqual(["src/contract.ts", "src/shared.ts"]);
  });

  it("refuses a pre-staged worktree without moving branch or HEAD", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "src/shared.ts"), "export const value = 3;\n");
    git(repo.path, "add", "--", "src/shared.ts");
    const before = {
      branch: git(repo.path, "branch", "--show-current"),
      head: git(repo.path, "rev-parse", "HEAD"),
      status: git(repo.path, "status", "--porcelain", "--untracked-files=all"),
    };

    const result = commitToHoldBranch(repo, {
      fingerprint: "staged1234567890",
      files: ["src/shared.ts"],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("pre-existing staged");
    expect({
      branch: git(repo.path, "branch", "--show-current"),
      head: git(repo.path, "rev-parse", "HEAD"),
      status: git(repo.path, "status", "--porcelain", "--untracked-files=all"),
    }).toEqual(before);
  });

  it("restores the original branch and unstaged dirty set after post-switch failure", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "src/shared.ts"), "export const value = 5;  \n");
    const beforeHead = git(repo.path, "rev-parse", "HEAD").trim();

    const result = commitToHoldBranch(repo, {
      fingerprint: "whitespace123456",
      files: ["src/shared.ts"],
    });

    expect(result.ok).toBe(false);
    expect(git(repo.path, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo.path, "rev-parse", "HEAD").trim()).toBe(beforeHead);
    expect(git(repo.path, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(git(repo.path, "status", "--porcelain")).toContain(" M src/shared.ts");
  });

  it("accepts only a complete E3/E5 source set", () => {
    const eligible = isHoldEligible(
      [disposition("src/a.ts", "E3 shared contract lacks owner verification"), disposition("src/b.ts", "E5 owner semantics", "OWNER")],
      ["src/a.ts", "src/b.ts"],
    );
    expect(eligible).toEqual({ ok: true, files: ["src/a.ts", "src/b.ts"] });

    const mixed = isHoldEligible(
      [disposition("src/a.ts", "E3 shared contract"), { file: ".env", class: "deny_secret", verdict: "DENY", reason: "E1 secret", source: "l0" }],
      ["src/a.ts", ".env"],
    );
    expect(mixed.ok).toBe(false);
    expect(mixed.error).toContain("not hold-eligible");
  });

  it("turns a hold-only daily result into a persisted non-reload result", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "src/shared.ts"), "export const value = 4;\n");
    const result = maybeCommitResultToHold(repo, {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: 1,
      skippedReason: "no safe subset",
      dirtyFingerprint: "holdonly123456789",
      dispositions: [disposition("src/shared.ts", "E3 shared contract needs owner review")],
    }, true);

    expect(result.committed).toBe(true);
    expect(result.holdOnly).toBe(true);
    expect(result.holdCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(result.skippedReason).toBe("");
    expect(git(repo.path, "status", "--porcelain")).toBe("");
  });
});
