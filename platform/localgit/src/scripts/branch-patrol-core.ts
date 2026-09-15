import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
  action: "report" | "deleted" | "fast_forwarded" | "fast_forwarded_and_deleted" | "auto_merged_docs" | "failed";
  shaBefore?: string;
  shaAfter?: string;
  mergeSha?: string;
  parents?: string[];
  // Set when the branch was kept because it is a worktree's checked-out HEAD.
  branchRetained?: boolean;
  // Free-form explanation, e.g. why execution was skipped for a policy repo.
  note?: string;
  error?: string;
};

export type PatrolHistoryRow = {
  repo?: string;
  currentBranch?: string;
  recorded_at?: string;
};

export type PatrolApplyOptions = {
  // C3 docs-only branches (ahead <= 5, every changed file on the docs allowlist)
  // are auto-merged; non-docs C3 stays report-only while auto_clean_merge=false.
  autoDocsMerge?: boolean;
  // Repo policy `branch_policy.trunk_advance=owner_only` (registry/repo-policies):
  // a repo-local hook (ad-adjust D-58) reserves trunk moves to the owner, so C2
  // and docs-C3 classify and report (+ owner hint routing) but never execute.
  // C1 deletion of already-merged branches is not a trunk move and still runs.
  trunkAdvanceOwnerOnly?: boolean;
};

const DOCS_MERGE_MAX_AHEAD = 5;

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

type WorktreeEntry = { path: string; head?: string; branch?: string };

function worktreeList(path: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const line of git(path, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length) };
      entries.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

// C5 常驻非 trunk: count consecutive patrol run-days (calendar dates of
// recorded_at) ending at runDate on which the repo's current branch was not
// trunk. Branch hopping between non-trunk branches does not reset the count;
// the caller includes a synthetic row for the current run so a first-ever
// off-trunk sighting counts as day 1.
export function consecutiveOffTrunkDays(
  rows: PatrolHistoryRow[],
  repo: string,
  trunk: string,
  runDate: string,
): number {
  const offTrunkDates = new Set<string>();
  for (const row of rows) {
    if (row.repo !== repo || typeof row.currentBranch !== "string" || typeof row.recorded_at !== "string") continue;
    if (row.currentBranch !== trunk) offTrunkDates.add(row.recorded_at.slice(0, 10));
  }
  let count = 0;
  let cursor = runDate;
  while (offTrunkDates.has(cursor)) {
    count += 1;
    cursor = previousDate(cursor);
  }
  return count;
}

// Remove a temporary worktree without leaking git worktree metadata. Every
// temp-dir deletion path goes through here, including ones where the worktree
// was never (fully) registered: remove --force fails harmlessly there, the
// unconditional prune clears any stale registration, the directory is deleted
// only if it still exists, and a final prune drops records left by rmSync.
// (Note: `worktree prune` skips LOCKED admin entries — git 2.39.5 verified —
// and we never lock our temp worktrees.)
export function removeTempWorktree(repoPath: string, worktree: string): void {
  try { git(repoPath, ["worktree", "remove", "--force", worktree]); } catch { /* not (or no longer) registered */ }
  try { git(repoPath, ["worktree", "prune"]); } catch { /* best effort */ }
  if (existsSync(worktree)) {
    rmSync(worktree, { recursive: true, force: true });
    try { git(repoPath, ["worktree", "prune"]); } catch { /* best effort */ }
  }
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
    }
    removeTempWorktree(path, worktree);
  }
}

export function inventoryRepo(repo: RepoRef, options: {
  trunkBranch?: string;
  parkedDays?: number;
  history?: PatrolHistoryRow[];
  runDate?: string;
} = {}): BranchInventory[] {
  const branches = localBranches(repo.path);
  const currentBranch = git(repo.path, ["branch", "--show-current"]);
  const trunk = options.trunkBranch
    ?? (branches.includes("main") ? "main" : branches.includes("master") ? "master" : undefined);
  const mountedElsewhere = otherWorktreeBranches(repo.path, currentBranch);
  const parkedDays = options.parkedDays ?? 7;
  const runDate = options.runDate ?? new Date().toISOString().slice(0, 10);

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
    if (branch === currentBranch && consecutiveOffTrunkDays(
      [...(options.history ?? []), { repo: repo.name, currentBranch, recorded_at: runDate }],
      repo.name, trunk, runDate,
    ) >= parkedDays) return { ...base, class: "C5" as const };
    if (succeeds(repo.path, ["merge-base", "--is-ancestor", trunk, branch])) return { ...base, class: "C2" as const };
    const conflictFiles = dryRunConflicts(repo.path, trunk, branch);
    return { ...base, class: conflictFiles.length > 0 ? "C4" as const : "C3" as const, conflictFiles };
  });
}

function dirtyFiles(path: string): string[] {
  const out = git(path, ["status", "--porcelain", "--untracked-files=all"]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const file = line.slice(3);
    const arrow = file.lastIndexOf(" -> ");
    return arrow >= 0 ? file.slice(arrow + 4) : file;
  });
}

function assertTrunkWorktreeMergeable(item: BranchInventory, worktreePath: string, shaBefore: string, targetSha: string): void {
  if (samePath(worktreePath, item.repoPath)) {
    // Governed worktree itself is on trunk: keep the existing full-clean check.
    if (git(worktreePath, ["status", "--porcelain", "--untracked-files=all"])) {
      throw new Error(`${item.class} requires a clean trunk worktree`);
    }
    return;
  }
  // Trunk checked out in a linked worktree: SOP precondition is that its dirty
  // files do not intersect the files the trunk move would touch.
  const touched = new Set(
    git(item.repoPath, ["diff", "--name-only", `${shaBefore}..${targetSha}`]).split("\n").filter(Boolean),
  );
  const overlap = dirtyFiles(worktreePath).filter((file) => touched.has(file));
  if (overlap.length > 0) {
    throw new Error(`trunk worktree dirty files overlap the merge: ${overlap.join(", ")}`);
  }
}

function branchIsCheckedOut(item: BranchInventory): boolean {
  return worktreeList(item.repoPath).some((entry) => entry.branch === item.branch);
}

function withCheckedOutBranch<T>(repoPath: string, branch: string, fn: (worktreePath: string) => T): T {
  const existing = worktreeList(repoPath).find((entry) => entry.branch === branch);
  if (existing) return fn(existing.path);

  const worktree = mkdtempSync(join(tmpdir(), "localgit-branch-boundary-"));
  rmSync(worktree, { recursive: true, force: true });
  try {
    // Holding the branch checked out in this temporary worktree lets Git's own
    // worktree guard serialize checkout/ref mutations around this branch.
    git(repoPath, ["worktree", "add", "-q", worktree, branch]);
    return fn(worktree);
  } finally {
    removeTempWorktree(repoPath, worktree);
  }
}

// Move trunk to targetSha (branch head for C2, fresh merge commit for docs C3).
// All inventory drift checks re-run here, immediately before the mutation.
// The move itself is `git fetch . <sha>:<ref>`: git natively rejects non-ff
// updates and refuses to move a branch checked out in ANY worktree — both
// verified on git 2.39.5 ("refusing to fetch into branch ... checked out at
// ..." for the main worktree and for linked worktrees). `git update-ref
// <ref> <new> <old>` has no checkout guard: a concurrent checkout between the
// worktreeList check and the update would still be moved, leaving HEAD,
// worktree and ref inconsistent (review TOCTOU).
function moveTrunkTo(item: BranchInventory, targetSha: string): { shaBefore: string; shaAfter: string } {
  const trunk = item.trunk!;
  const liveBranchHead = git(item.repoPath, ["rev-parse", `refs/heads/${item.branch}`]);
  if (liveBranchHead !== item.branchHead) {
    throw new Error(`branch ref changed after inventory: expected ${item.branchHead}, found ${liveBranchHead}`);
  }
  const shaBefore = git(item.repoPath, ["rev-parse", `refs/heads/${trunk}`]);
  if (item.trunkHead && shaBefore !== item.trunkHead) {
    throw new Error(`trunk ref changed after inventory: expected ${item.trunkHead}, found ${shaBefore}`);
  }
  if (!succeeds(item.repoPath, ["merge-base", "--is-ancestor", shaBefore, targetSha])) {
    throw new Error(`target ${targetSha} does not contain ${trunk}@${shaBefore}; refusing to move trunk`);
  }
  try {
    git(item.repoPath, ["fetch", ".", `${targetSha}:refs/heads/${trunk}`]);
  } catch (fetchRefused) {
    // Refusal = trunk was checked out between inventory and now (or a non-ff
    // race). Re-read the worktree list once: if trunk really is checked out
    // now, converge through that worktree's own ff-only merge (its HEAD,
    // worktree and ref stay consistent); otherwise fail closed.
    const trunkEntry = worktreeList(item.repoPath).find((entry) => entry.branch === trunk);
    if (!trunkEntry) {
      throw new Error(`trunk move refused while ${trunk} is not checked out anywhere: ${(fetchRefused as Error).message}`);
    }
    if (git(trunkEntry.path, ["branch", "--show-current"]) !== trunk) {
      throw new Error(`trunk worktree ${trunkEntry.path} is no longer on ${trunk}; refusing to merge`);
    }
    assertTrunkWorktreeMergeable(item, trunkEntry.path, shaBefore, targetSha);
    git(trunkEntry.path, ["merge", "--ff-only", targetSha]);
  }
  const shaAfter = git(item.repoPath, ["rev-parse", `refs/heads/${trunk}`]);
  if (shaAfter !== targetSha) throw new Error("trunk move result does not match target sha");
  return { shaBefore, shaAfter };
}

// Delete a provably merged branch with `git branch -d` run from a worktree
// whose HEAD is trunk (a temporary one when trunk is not checked out): there
// the -d merged-check passes, and -d natively refuses to delete a branch
// checked out in any worktree. `git update-ref -d` is deliberately NOT used:
// verified on git 2.39.5 that it deletes branches checked out in the main
// worktree AND in linked worktrees without any refusal, leaving that
// worktree's HEAD dangling at an unborn ref.
function deleteMergedBranch(item: BranchInventory): void {
  const beforeDelete = git(item.repoPath, ["rev-parse", `refs/heads/${item.branch}`]);
  if (beforeDelete !== item.branchHead) {
    throw new Error(`branch ref changed before delete: expected ${item.branchHead}, found ${beforeDelete}`);
  }
  if (!item.trunk || !succeeds(item.repoPath, ["merge-base", "--is-ancestor", item.branchHead, item.trunk])) {
    throw new Error(`${item.branch} is not provably merged into ${item.trunk ?? "trunk"}`);
  }
  withCheckedOutBranch(item.repoPath, item.trunk, (trunkPath) => {
    git(trunkPath, ["branch", "-d", item.branch]);
  });
  if (succeeds(item.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${item.branch}`])) {
    throw new Error(`branch ${item.branch} still exists after delete`);
  }
}

// Docs-only auto-merge allowlist: every changed file must live under docs/ or
// architecture/ (the incident class: livemap 账 in architecture/map.json), or
// have a .md basename — and must not hit the identity/governance denylist, so
// AGENTS.md / CLAUDE.md / SOPs / principles / repo policies never bypass the
// first-principle / owner gates through this lane.
const DOCS_MERGE_ALLOW_PREFIXES = ["docs/", "architecture/"];
const DOCS_MERGE_DENY_PREFIXES = ["sop/", "principles/", "registry/", ".github/"];
const DOCS_MERGE_DENY_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "LOCALGIT-GOVERNANCE.md"]);

function isDocsMergeableFile(file: string): boolean {
  const basename = file.split("/").pop() ?? file;
  if (DOCS_MERGE_DENY_BASENAMES.has(basename)) return false;
  if (DOCS_MERGE_DENY_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  return DOCS_MERGE_ALLOW_PREFIXES.some((prefix) => file.startsWith(prefix)) || basename.endsWith(".md");
}

function isDocsOnlyMerge(item: BranchInventory): boolean {
  if (!item.trunk || item.ahead < 1 || item.ahead > DOCS_MERGE_MAX_AHEAD) return false;
  const mergeBase = git(item.repoPath, ["merge-base", item.trunk, item.branchHead]);
  const files = git(item.repoPath, ["diff", "--name-only", `${mergeBase}..${item.branchHead}`]);
  const list = files ? files.split("\n").filter(Boolean) : [];
  return list.length > 0 && list.every(isDocsMergeableFile);
}

// C3 docs-only lane: build the merge commit in a temp detached worktree (no
// real worktree is touched by the merge itself), then move trunk to it.
function applyDocsMerge(item: BranchInventory, evidence: PatrolEvidence): PatrolEvidence {
  const trunk = item.trunk!;
  const liveBranchHead = git(item.repoPath, ["rev-parse", `refs/heads/${item.branch}`]);
  if (liveBranchHead !== item.branchHead) {
    throw new Error(`branch ref changed after inventory: expected ${item.branchHead}, found ${liveBranchHead}`);
  }
  const trunkBefore = git(item.repoPath, ["rev-parse", `refs/heads/${trunk}`]);
  if (item.trunkHead && trunkBefore !== item.trunkHead) {
    throw new Error(`trunk ref changed after inventory: expected ${item.trunkHead}, found ${trunkBefore}`);
  }
  const worktree = mkdtempSync(join(tmpdir(), "branch-patrol-docs-merge-"));
  rmSync(worktree, { recursive: true, force: true });
  let added = false;
  let mergeSha: string;
  let parents: string[];
  try {
    git(item.repoPath, ["worktree", "add", "--detach", worktree, trunkBefore]);
    added = true;
    git(worktree, [
      "-c", "user.name=localgit", "-c", "user.email=localgit@local",
      "merge", "--no-ff", "-m", `Merge branch '${item.branch}' (branch-patrol auto docs-only)`, item.branchHead,
    ]);
    mergeSha = git(worktree, ["rev-parse", "HEAD"]);
    parents = git(worktree, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).slice(1);
    if (parents.length !== 2 || parents[0] !== trunkBefore || parents[1] !== item.branchHead) {
      throw new Error(`unexpected merge parents: ${parents.join(" ")}`);
    }
  } finally {
    if (added) {
      try { git(worktree, ["merge", "--abort"]); } catch { /* no merge to abort */ }
    }
    removeTempWorktree(item.repoPath, worktree);
  }
  const { shaBefore, shaAfter } = moveTrunkTo(item, mergeSha);
  if (branchIsCheckedOut(item)) {
    // Trunk converged; the branch stays as that worktree's checked-out home.
    return { ...evidence, action: "auto_merged_docs", shaBefore, shaAfter, mergeSha, parents, branchRetained: true };
  }
  deleteMergedBranch(item);
  return { ...evidence, action: "auto_merged_docs", shaBefore, shaAfter, mergeSha, parents };
}

export function applyPatrolAction(item: BranchInventory, mode: "report" | "apply", options: PatrolApplyOptions = {}): PatrolEvidence {
  const evidence: PatrolEvidence = { ...item, action: "report" };
  if (mode === "report") return evidence;
  try {
    if (item.class === "C1") {
      deleteMergedBranch(item);
      return { ...evidence, action: "deleted", shaBefore: item.trunkHead, shaAfter: item.trunkHead };
    }
    if ((item.class === "C2" || item.class === "C3") && options.trunkAdvanceOwnerOnly) {
      return { ...evidence, note: "trunk_advance=owner_only: repo hook reserves trunk moves to the owner; classify+report only" };
    }
    if (item.class === "C2") {
      if (!item.trunk) throw new Error("C2 requires a resolved trunk");
      const { shaBefore, shaAfter } = moveTrunkTo(item, item.branchHead);
      if (branchIsCheckedOut(item)) {
        // Trunk converged; the branch stays as that worktree's checked-out home
        // (a worktree's current branch can never be deleted).
        return { ...evidence, action: "fast_forwarded", shaBefore, shaAfter, branchRetained: true };
      }
      deleteMergedBranch(item);
      return { ...evidence, action: "fast_forwarded_and_deleted", shaBefore, shaAfter };
    }
    if (item.class === "C3" && (options.autoDocsMerge ?? true) && isDocsOnlyMerge(item)) {
      return applyDocsMerge(item, evidence);
    }
    return evidence;
  } catch (error) {
    return { ...evidence, action: "failed", error: (error as Error).message };
  }
}
