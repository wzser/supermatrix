import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDispositions,
  collectStatusEntries,
  getDirtyFingerprint,
  judgeRepo,
  tryCommitFiles,
} from "../../src/scripts/daily-commit-pipeline.js";

const scratchDirs: string[] = [];

function makeRepo(): { name: string; path: string } {
  const path = mkdtempSync(join(tmpdir(), "localgit-pipeline-"));
  scratchDirs.push(path);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf-8" });
  g("init", "-q", "-b", "main");
  g("-c", "user.name=test", "-c", "user.email=test@test", "commit", "--allow-empty", "-q", "-m", "init");
  return { name: "scratch", path };
}

function gitLog1Files(path: string): string[] {
  return execFileSync("git", ["log", "-1", "--name-only", "--format="], { cwd: path, encoding: "utf-8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

function safeReviewerFor(files: string[]): (prompt: string, cwd: string) => string {
  return () => JSON.stringify(files.map((f) => ({ file: f, verdict: "SAFE", reason: "" })));
}

describe("daily-commit pipeline against real scratch repos", () => {
  it("splits a mixed dirty set: commits safe source + .gitignore, leaves deny/pending in worktree", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "src"), { recursive: true });
    mkdirSync(join(repo.path, "data"), { recursive: true });
    mkdirSync(join(repo.path, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(repo.path, "src/ok.ts"), "export const x = 1;\n");
    writeFileSync(join(repo.path, "data/report.csv"), "a,b\n1,2\n");
    writeFileSync(join(repo.path, "node_modules/pkg/index.js"), "module.exports = 1;\n");
    writeFileSync(join(repo.path, ".env"), "SECRET=super-secret-value\n");

    const entries = collectStatusEntries(repo.path);
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const result = judgeRepo(repo, entries, getDirtyFingerprint(repo.path), {
      reviewer: safeReviewerFor(["src/ok.ts"]),
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path).sort()).toEqual([".gitignore", "src/ok.ts"]);
    expect(result.leftoverSummary).toContain("deny:1");
    expect(result.leftoverSummary).toContain("pending_owner:1");
    expect(readFileSync(join(repo.path, ".gitignore"), "utf-8")).toContain("node_modules/");

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo.path, encoding: "utf-8" });
    expect(status).toContain(".env");
    expect(status).toContain("data/report.csv");
    expect(status).not.toContain("src/ok.ts");
  });

  it("honors manifest rules: commit for declared artifacts, ignore via .gitignore", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "data"), { recursive: true });
    writeFileSync(join(repo.path, "data/ledger.jsonl"), '{"ok":true}\n');
    writeFileSync(join(repo.path, "data/export.csv"), "x\n");

    const policiesDir = mkdtempSync(join(tmpdir(), "localgit-policies-"));
    scratchDirs.push(policiesDir);
    writeFileSync(
      join(policiesDir, "scratch.json"),
      JSON.stringify({
        repo: "scratch",
        rules: [
          { pattern: "data/ledger.jsonl", action: "commit", note: "append-only audit trail" },
          { pattern: "data/**", action: "ignore" },
        ],
      }),
    );

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("no L2 candidates expected");
      },
      policiesDir,
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path).sort()).toEqual([".gitignore", "data/ledger.jsonl"]);
    expect(readFileSync(join(repo.path, ".gitignore"), "utf-8")).toContain("data/**");
  });

  it("fast-paths behavior-dir text changes to commit with zero reviewer calls", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "sop"), { recursive: true });
    mkdirSync(join(repo.path, "scripts"), { recursive: true });
    writeFileSync(join(repo.path, "sop/new-doc.md"), "# doc\n");
    writeFileSync(join(repo.path, "scripts/run.sh"), "echo ok\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("reviewer must not be called for fast-path-only dirty sets");
      },
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path).sort()).toEqual(["scripts/run.sh", "sop/new-doc.md"]);
    expect(result.dispositions?.every((d) => d.verdict === "SAFE" && d.source === "l0")).toBe(true);
  });

  it("fast path never bypasses the R1 secret content screen inside behavior dirs", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "scripts"), { recursive: true });
    writeFileSync(join(repo.path, "scripts/deploy.sh"), "export AWS_KEY=AKIAIOSFODNN7EXAMPLE\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("no reviewer expected");
      },
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(false);
    expect(result.dispositions?.find((d) => d.file === "scripts/deploy.sh")?.verdict).toBe("DENY");
  });

  it("caps L2 candidates and marks the overflow PENDING_OWNER for the manifest flow", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "stuff"), { recursive: true });
    const cap = 60;
    const files = Array.from({ length: cap + 5 }, (_, i) => `stuff/f${String(i).padStart(3, "0")}.txt`);
    for (const f of files) writeFileSync(join(repo.path, f), "text\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      // git status sorts paths, so the reviewed set is deterministically the first `cap` files.
      reviewer: safeReviewerFor(files.slice(0, cap)),
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path).length).toBe(cap);
    const overflow = result.dispositions?.filter((d) => d.verdict === "PENDING_OWNER") ?? [];
    expect(overflow.length).toBe(5);
    expect(overflow[0]?.reason).toContain("L2 candidate cap");
  });

  it("commits tracked files whose parent dir was later .gitignored (huodaiduijie runtime/ case)", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "scripts"), { recursive: true });
    writeFileSync(join(repo.path, "scripts/run.sh"), "echo v1\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "--", "scripts/run.sh"], { cwd: repo.path });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "track script"], { cwd: repo.path });
    writeFileSync(join(repo.path, ".gitignore"), "scripts/\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "--", ".gitignore"], { cwd: repo.path });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ignore scripts dir"], { cwd: repo.path });
    writeFileSync(join(repo.path, "scripts/run.sh"), "echo v2\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("no reviewer expected");
      },
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path)).toEqual(["scripts/run.sh"]);
  });

  it("freezes the whole repo on merge-conflict markers and routes to branch patrol", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "app.ts"), "clean\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "--", "app.ts"], { cwd: repo.path });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "track app"], { cwd: repo.path });
    writeFileSync(join(repo.path, "app.ts"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n");
    writeFileSync(join(repo.path, "other.ts"), "export const y = 2;\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: safeReviewerFor(["other.ts"]),
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(false);
    expect(result.skippedReason).toContain("merge-conflict state");
    expect(result.skippedReason).toContain("branch-merge patrol");
    expect(result.dispositions?.find((d) => d.file === "other.ts")?.verdict).toBe("KEEP_DIRTY");
  });

  it("still commits the fast-path safe subset when the reviewer dies (skill-master 2026-08-05 case)", () => {
    const repo = makeRepo();
    mkdirSync(join(repo.path, "src"), { recursive: true });
    writeFileSync(join(repo.path, "src/behavior.ts"), "export const b = 1;\n");
    // Root-level file → gray zone → L2, whose reviewer is down.
    writeFileSync(join(repo.path, "ambiguous-note.md"), "notes\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("simulated codex ETIMEDOUT");
      },
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path)).toEqual(["src/behavior.ts"]);
    // The outage is still reported, and the gray-zone file stays for tomorrow.
    expect(result.reviewerFailure).toContain("codex reviewer likely stalled");
    expect(result.localgitOwned).toBe(true);
    expect(result.dispositions?.find((d) => d.file === "ambiguous-note.md")?.verdict).toBe("UNREVIEWED");
  });

  it("marks R9 files UNREVIEWED and stays localgit-owned when the reviewer fails twice", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "brand-new.ts"), "export const z = 3;\n");

    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer: () => {
        throw new Error("simulated codex outage");
      },
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(false);
    expect(result.skippedReason).toContain("codex reviewer likely stalled");
    expect(result.dispositions?.every((d) => d.verdict === "UNREVIEWED")).toBe(true);
  });

  it("treats an outside-pointing symlink as evidence for L2 (ad-adjust case shape)", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "notes.md"), "hello\n");
    symlinkSync("/somewhere/outside", join(repo.path, "full-docs"));

    const reviewer = (prompt: string) => {
      expect(prompt).toContain("symlink -> /somewhere/outside");
      return JSON.stringify([
        { file: "full-docs", verdict: "RISKY", reason: "E5 symlink points outside the repo" },
        { file: "notes.md", verdict: "SAFE", reason: "" },
      ]);
    };
    const result = judgeRepo(repo, collectStatusEntries(repo.path), getDirtyFingerprint(repo.path), {
      reviewer,
      policiesDir: join(repo.path, "no-policies"),
    });

    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path)).toEqual(["notes.md"]);
    expect(result.leftoverSummary).toContain("risky:1");
  });

  it("re-applies cached dispositions idempotently (retry after a commit failure)", () => {
    const repo = makeRepo();
    writeFileSync(join(repo.path, "keep.ts"), "export const k = 1;\n");
    const dispositions = [{ file: "keep.ts", class: "source" as const, verdict: "SAFE" as const, source: "cached" as const }];
    const result = applyDispositions(repo, ["keep.ts"], dispositions, "fp", "cached");
    expect(result.committed).toBe(true);
    expect(gitLog1Files(repo.path)).toEqual(["keep.ts"]);
  });

  it("tryCommitFiles reports failure without touching the worktree when files are missing", () => {
    const repo = makeRepo();
    const attempt = tryCommitFiles(repo, "chore: nothing", ["ghost.ts"]);
    expect(attempt.ok).toBe(false);
    expect(attempt.result.skippedReason).toContain("git commit failed");
  });
});
