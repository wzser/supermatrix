import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoRef } from "./localgit-context.js";

export type PatrolClass = "C0" | "C1" | "C2" | "H1" | "C3" | "C4" | "C5" | "C6";

export type BranchInventory = {
  repo: string;
  repoPath: string;
  branch: string;
  trunk?: string;
  currentBranch: string;
  class: PatrolClass;
  branchHead: string;
  trunkHead?: string;
  ahead: number;
  behind: number;
  ageDays: number;
  conflictFiles: string[];
};

export type PatrolEvidence = BranchInventory & {
  action: "report" | "deleted" | "fast_forwarded_and_deleted" | "failed";
  shaBefore?: string;
  shaAfter?: string;
  error?: string;
};

function git(path: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: path,
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

function succeeds(path: string, args: string[]): boolean {
  try {
    git(path, args);
    return true;
  } catch {
    return false;
  }
}

function localBranches(path: string): string[] {
  const out = git(path, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out ? out.split("\n").filter(Boolean).sort() : [];
}

function otherWorktreeBranches(path: string, currentBranch: string): Set<string> {
  const mounted = new Set<string>();
  const out = git(path, ["worktree", "list", "--porcelain"]);
  for (const line of out.split("\n")) {
    if (!line.startsWith("branch refs/heads/")) continue;
    const branch = line.slice("branch refs/heads/".length);
    if (branch !== currentBranch) mounted.add(branch);
  }
  return mounted;
}

function dryRunConflicts(path: string, trunk: string, branch: string): string[] {
  const worktree = mkdtempSync(join(tmpdir(), "localgit-merge-dryrun-"));
  rmSync(worktree, { recursive: true, force: true });
  let added = false;
  try {
    git(path, ["worktree", "add", "--detach", worktree, trunk]);
    added = true;
    try {
      git(worktree, ["-c", "user.name=localgit", "-c", "user.email=localgit@local", "merge", "--no-commit", "--no-ff", branch]);
      return [];
    } catch {
      const conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"]);
      return conflicts ? conflicts.split("\n").filter(Boolean).sort() : [];
    }
  } finally {
    if (added) {
      try { git(worktree, ["merge", "--abort"]); } catch { /* no merge to abort */ }
      try { git(path, ["worktree", "remove", "--force", worktree]); } catch { /* verifier reports leftovers */ }
    }
    rmSync(worktree, { recursive: true, force: true });
  }
}

export function inventoryRepo(repo: RepoRef, options: { trunkBranch?: string; parkedDays?: number } = {}): BranchInventory[] {
  const branches = localBranches(repo.path);
  const currentBranch = git(repo.path, ["branch", "--show-current"]);
  const trunk = options.trunkBranch
    ?? (branches.includes("main") ? "main" : branches.includes("master") ? "master" : undefined);
  const mountedElsewhere = otherWorktreeBranches(repo.path, currentBranch);
  const parkedDays = options.parkedDays ?? 7;

  return branches.filter((branch) => branch !== trunk).map((branch) => {
    const branchHead = git(repo.path, ["rev-parse", branch]);
    const ageSeconds = Number(git(repo.path, ["show", "-s", "--format=%ct", branch]));
    const ageDays = Math.max(0, Math.floor((Date.now() / 1000 - ageSeconds) / 86400));
    if (!trunk) {
      return { repo: repo.name, repoPath: repo.path, branch, currentBranch, class: "C6", branchHead, ahead: 0, behind: 0, ageDays, conflictFiles: [] };
    }
    const trunkHead = git(repo.path, ["rev-parse", trunk]);
    const counts = git(repo.path, ["rev-list", "--left-right", "--count", `${trunk}...${branch}`]).split(/\s+/).map(Number);
    const base = {
      repo: repo.name, repoPath: repo.path, branch, trunk, currentBranch, branchHead, trunkHead,
      behind: counts[0] ?? 0, ahead: counts[1] ?? 0, ageDays, conflictFiles: [] as string[],
    };
    if (mountedElsewhere.has(branch)) return { ...base, class: "C0" as const };
    if (succeeds(repo.path, ["merge-base", "--is-ancestor", branch, trunk])) return { ...base, class: "C1" as const };
    if (branch.startsWith("localgit/hold/")) return { ...base, class: "H1" as const };
    if (branch === currentBranch && ageDays >= parkedDays) return { ...base, class: "C5" as const };
    if (succeeds(repo.path, ["merge-base", "--is-ancestor", trunk, branch])) return { ...base, class: "C2" as const };
    const conflictFiles = dryRunConflicts(repo.path, trunk, branch);
    return { ...base, class: conflictFiles.length > 0 ? "C4" as const : "C3" as const, conflictFiles };
  });
}

export function applyPatrolAction(item: BranchInventory, mode: "report" | "apply"): PatrolEvidence {
  const evidence: PatrolEvidence = { ...item, action: "report" };
  if (mode === "report" || !["C1", "C2"].includes(item.class)) return evidence;
  try {
    if (item.class === "C1") {
      git(item.repoPath, ["branch", "-d", item.branch]);
      return { ...evidence, action: "deleted", shaBefore: item.trunkHead, shaAfter: item.trunkHead };
    }
    if (!item.trunk || item.currentBranch !== item.trunk) {
      throw new Error("C2 requires the current worktree on trunk");
    }
    if (git(item.repoPath, ["status", "--porcelain", "--untracked-files=all"])) {
      throw new Error("C2 requires a clean trunk worktree");
    }
    const liveBranchHead = git(item.repoPath, ["rev-parse", `refs/heads/${item.branch}`]);
    if (liveBranchHead !== item.branchHead) {
      throw new Error(`branch ref changed after inventory: expected ${item.branchHead}, found ${liveBranchHead}`);
    }
    const shaBefore = git(item.repoPath, ["rev-parse", item.trunk]);
    if (item.trunkHead && shaBefore !== item.trunkHead) {
      throw new Error(`trunk ref changed after inventory: expected ${item.trunkHead}, found ${shaBefore}`);
    }
    git(item.repoPath, ["merge", "--ff-only", item.branchHead]);
    const shaAfter = git(item.repoPath, ["rev-parse", item.trunk]);
    if (shaAfter !== item.branchHead) throw new Error("fast-forward result does not match branch head");
    const branchBeforeDelete = git(item.repoPath, ["rev-parse", `refs/heads/${item.branch}`]);
    if (branchBeforeDelete !== item.branchHead) {
      throw new Error(`branch ref changed before delete: expected ${item.branchHead}, found ${branchBeforeDelete}`);
    }
    git(item.repoPath, ["branch", "-d", item.branch]);
    return { ...evidence, action: "fast_forwarded_and_deleted", shaBefore, shaAfter };
  } catch (error) {
    return { ...evidence, action: "failed", error: (error as Error).message };
  }
}
