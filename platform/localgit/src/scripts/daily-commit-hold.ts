import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { RepoRef } from "./localgit-context.js";
import type { FileDisposition } from "./daily-commit-judgment-matrix.js";

export type HoldEligibility =
  | { ok: true; files: string[] }
  | { ok: false; error: string };

export type HoldInput = {
  fingerprint: string;
  files: string[];
};

export type HoldResult = {
  ok: boolean;
  originalBranch?: string;
  originalHead?: string;
  holdBranch?: string;
  holdCommit?: string;
  files: string[];
  error?: string;
};

export type HoldableRepoResult = {
  name: string;
  committed: boolean;
  message: string;
  filesChanged: number;
  skippedReason: string;
  dirtyFingerprint?: string;
  dispositions?: FileDisposition[];
  deferred?: boolean;
  localgitOwned?: boolean;
  leftoverSummary?: string;
  holdOnly?: boolean;
  holdBranch?: string;
  holdCommit?: string;
  holdOriginalBranch?: string;
  holdOriginalHead?: string;
  holdFiles?: string[];
};

function git(path: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: path,
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function sanitizeBranchPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function statusFiles(path: string): string[] {
  return git(path, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((file) => file.includes(" -> ") ? file.slice(file.indexOf(" -> ") + 4) : file)
    .sort();
}

function gitOperationInProgress(path: string): boolean {
  const gitPath = (name: string) => git(path, ["rev-parse", "--git-path", name]).trim();
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]
    .some((name) => existsSync(gitPath(name)));
}

export function isHoldEligible(
  dispositions: FileDisposition[],
  dirtyFiles: string[],
): HoldEligibility {
  const byFile = new Map(dispositions.map((item) => [item.file, item]));
  const rejected = dirtyFiles.filter((file) => {
    const item = byFile.get(file);
    return !item ||
      item.class !== "source" ||
      !["RISKY", "OWNER"].includes(item.verdict) ||
      !/^(E3|E5)\b/.test(item.reason ?? "");
  });
  if (rejected.length > 0) {
    return { ok: false, error: `not hold-eligible: ${rejected.join(", ")}` };
  }
  return { ok: true, files: [...dirtyFiles].sort() };
}

export function commitToHoldBranch(repo: RepoRef, input: HoldInput): HoldResult {
  const files = [...input.files].sort();
  const originalBranch = git(repo.path, ["branch", "--show-current"]).trim();
  const originalHead = git(repo.path, ["rev-parse", "HEAD"]).trim();
  const holdBranch = `localgit/hold/${sanitizeBranchPart(repo.name)}/${sanitizeBranchPart(input.fingerprint.slice(0, 12))}`;
  const base: HoldResult = { ok: false, originalBranch, originalHead, holdBranch, files };

  if (!originalBranch) return { ...base, error: "detached HEAD is not hold-eligible" };
  if (gitOperationInProgress(repo.path)) return { ...base, error: "git operation in progress" };
  if (git(repo.path, ["diff", "--name-only", "--diff-filter=U"]).trim()) {
    return { ...base, error: "unmerged paths are not hold-eligible" };
  }
  if (git(repo.path, ["diff", "--cached", "--name-only"]).trim()) {
    return { ...base, error: "pre-existing staged changes are not hold-eligible" };
  }
  const liveFiles = statusFiles(repo.path);
  if (JSON.stringify(liveFiles) !== JSON.stringify(files)) {
    return { ...base, error: `dirty file set changed: expected ${files.join(", ")}; found ${liveFiles.join(", ")}` };
  }
  try {
    git(repo.path, ["show-ref", "--verify", "--quiet", `refs/heads/${holdBranch}`]);
    return { ...base, error: `hold branch already exists: ${holdBranch}` };
  } catch {
    // Expected when the deterministic hold branch does not exist yet.
  }

  let holdCommit: string | undefined;
  try {
    git(repo.path, ["switch", "-c", holdBranch]);
    git(repo.path, ["add", "--", ...files]);
    git(repo.path, ["diff", "--cached", "--check"]);
    git(repo.path, [
      "-c", "user.name=localgit",
      "-c", "user.email=localgit@local",
      "commit", "-m", `wip(hold): persist disputed working set for ${repo.name}`,
    ]);
    holdCommit = git(repo.path, ["rev-parse", "HEAD"]).trim();
    git(repo.path, ["switch", originalBranch]);

    const restoredBranch = git(repo.path, ["branch", "--show-current"]).trim();
    const restoredHead = git(repo.path, ["rev-parse", "HEAD"]).trim();
    const remaining = statusFiles(repo.path);
    const committedFiles = git(repo.path, ["show", "--format=", "--name-only", holdCommit])
      .split("\n").filter(Boolean).sort();
    if (restoredBranch !== originalBranch || restoredHead !== originalHead) {
      throw new Error("original branch or HEAD was not restored");
    }
    if (remaining.some((file) => files.includes(file))) {
      throw new Error(`hold files remain dirty: ${remaining.join(", ")}`);
    }
    if (JSON.stringify(committedFiles) !== JSON.stringify(files)) {
      throw new Error(`hold commit file mismatch: ${committedFiles.join(", ")}`);
    }
    return { ...base, ok: true, holdCommit };
  } catch (error) {
    const failure = (error as Error).message;
    try {
      const currentBranch = git(repo.path, ["branch", "--show-current"]).trim();
      if (currentBranch === holdBranch) {
        const staged = git(repo.path, ["diff", "--cached", "--name-only"]).trim();
        if (staged) git(repo.path, ["restore", "--staged", "--", ...files]);
        git(repo.path, ["switch", originalBranch]);
      }
      const restoredBranch = git(repo.path, ["branch", "--show-current"]).trim();
      const restoredHead = git(repo.path, ["rev-parse", "HEAD"]).trim();
      if (restoredBranch !== originalBranch || restoredHead !== originalHead) {
        throw new Error(`restored ${restoredBranch}@${restoredHead}, expected ${originalBranch}@${originalHead}`);
      }
      if (!holdCommit) {
        try { git(repo.path, ["branch", "-d", holdBranch]); } catch { /* safe to leave an unmerged recovery ref */ }
      }
    } catch (restoreError) {
      throw new Error(`hold transaction failed and original worktree was not restored: ${failure}; restore: ${(restoreError as Error).message}`);
    }
    return { ...base, holdCommit, error: failure };
  }
}

export function maybeCommitResultToHold<T extends HoldableRepoResult>(
  repo: RepoRef,
  result: T,
  enabled: boolean,
): T {
  if (!enabled || !result.dirtyFingerprint || !result.dispositions?.length) return result;
  const dirtyFiles = statusFiles(repo.path);
  if (dirtyFiles.length === 0) return result;
  const eligibility = isHoldEligible(result.dispositions, dirtyFiles);
  if (!eligibility.ok) return result;
  const hold = commitToHoldBranch(repo, {
    fingerprint: result.dirtyFingerprint,
    files: eligibility.files,
  });
  if (!hold.ok || !hold.holdBranch || !hold.holdCommit || !hold.originalBranch || !hold.originalHead) {
    return result;
  }
  const holdMessage = `wip(hold): persist disputed working set for ${repo.name}`;
  return {
    ...result,
    committed: true,
    holdOnly: !result.committed,
    message: result.committed ? `${result.message}; ${holdMessage}` : holdMessage,
    skippedReason: "",
    deferred: false,
    localgitOwned: false,
    leftoverSummary: undefined,
    holdBranch: hold.holdBranch,
    holdCommit: hold.holdCommit,
    holdOriginalBranch: hold.originalBranch,
    holdOriginalHead: hold.originalHead,
    holdFiles: hold.files,
  };
}
