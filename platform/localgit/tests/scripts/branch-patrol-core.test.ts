import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPatrolAction,
  inventoryRepo,
} from "../../src/scripts/branch-patrol-core.js";

const scratchDirs: string[] = [];

function git(path: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf-8" });
}

function makeRepo(): { name: string; path: string } {
  const path = mkdtempSync(join(tmpdir(), "localgit-patrol-"));
  scratchDirs.push(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "app.ts"), "base\n");
  git(path, "add", "--", "app.ts");
  git(path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", "base");
  return { name: "scratch", path };
}

function commit(path: string, message: string, content: string): void {
  writeFileSync(join(path, "app.ts"), content);
  git(path, "add", "--", "app.ts");
  git(path, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "-m", message);
}

afterEach(() => {
  while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

describe("branch patrol core", () => {
  it("fast-forwards a C2 branch and deletes it with -d", () => {
    const repo = makeRepo();
    git(repo.path, "switch", "-q", "-c", "feature/one");
    commit(repo.path, "feature", "feature\n");
    const featureHead = git(repo.path, "rev-parse", "HEAD").trim();
    git(repo.path, "switch", "-q", "main");

    const item = inventoryRepo(repo).find((row) => row.branch === "feature/one")!;
    expect(item.class).toBe("C2");
    const evidence = applyPatrolAction(item, "apply");
    expect(evidence.action).toBe("fast_forwarded_and_deleted");
    expect(git(repo.path, "rev-parse", "main").trim()).toBe(featureHead);
    expect(git(repo.path, "branch", "--list", "feature/one").trim()).toBe("");
  });

  it("refuses C2 before mutation when the branch advanced after inventory", () => {
    const repo = makeRepo();
    git(repo.path, "switch", "-q", "-c", "feature/race");
    commit(repo.path, "reviewed", "reviewed\n");
    git(repo.path, "switch", "-q", "main");
    const item = inventoryRepo(repo).find((row) => row.branch === "feature/race")!;
    git(repo.path, "switch", "-q", "feature/race");
    commit(repo.path, "unreviewed", "unreviewed\n");
    git(repo.path, "switch", "-q", "main");
    const mainBefore = git(repo.path, "rev-parse", "main").trim();

    const evidence = applyPatrolAction(item, "apply");

    expect(evidence.action).toBe("failed");
    expect(evidence.error).toContain("branch ref changed");
    expect(git(repo.path, "rev-parse", "main").trim()).toBe(mainBefore);
  });

  it("protects an undecided hold branch as H1", () => {
    const repo = makeRepo();
    git(repo.path, "switch", "-q", "-c", "localgit/hold/scratch/abc123def456");
    commit(repo.path, "hold", "hold\n");
    git(repo.path, "switch", "-q", "main");

    const item = inventoryRepo(repo).find((row) => row.branch.startsWith("localgit/hold/"))!;
    expect(item.class).toBe("H1");
    expect(applyPatrolAction(item, "apply").action).toBe("report");
    expect(git(repo.path, "branch", "--list", item.branch).trim()).not.toBe("");
  });

  it("deletes an already merged C1 branch with -d", () => {
    const repo = makeRepo();
    git(repo.path, "branch", "already-merged");
    const item = inventoryRepo(repo).find((row) => row.branch === "already-merged")!;
    expect(item.class).toBe("C1");
    expect(applyPatrolAction(item, "apply").action).toBe("deleted");
  });

  it("reports C4 conflict files without changing either branch", () => {
    const repo = makeRepo();
    git(repo.path, "switch", "-q", "-c", "feature/conflict");
    commit(repo.path, "feature", "feature\n");
    const featureHead = git(repo.path, "rev-parse", "HEAD").trim();
    git(repo.path, "switch", "-q", "main");
    commit(repo.path, "main", "main\n");
    const mainHead = git(repo.path, "rev-parse", "HEAD").trim();

    const item = inventoryRepo(repo).find((row) => row.branch === "feature/conflict")!;
    expect(item.class).toBe("C4");
    expect(item.conflictFiles).toEqual(["app.ts"]);
    expect(applyPatrolAction(item, "apply").action).toBe("report");
    expect(git(repo.path, "rev-parse", "main").trim()).toBe(mainHead);
    expect(git(repo.path, "rev-parse", "feature/conflict").trim()).toBe(featureHead);
  });
});
