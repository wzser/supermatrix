import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function normalizeAttempt(value) {
  const attempt = Number(value);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`Invalid attempt: ${value}`);
  }

  return attempt;
}

export function buildRepairBranchName({ packName, incidentId, attempt } = {}) {
  const normalizedPackName = requireNonEmptyString(packName, "packName");
  const normalizedIncidentId = requireNonEmptyString(incidentId, "incidentId");
  const normalizedAttempt = normalizeAttempt(attempt);
  return `repair/${normalizedPackName}/${normalizedIncidentId}/attempt-${normalizedAttempt}`;
}

export async function createRepairWorktree({
  repoRoot,
  packName,
  incidentId,
  attempt,
  repairsRoot = path.join(repoRoot ?? process.cwd(), ".worktrees", "repairs"),
  baseRef = "HEAD",
  execFileImpl = execFileAsync
} = {}) {
  const normalizedRepoRoot = requireNonEmptyString(repoRoot, "repoRoot");
  const normalizedAttempt = normalizeAttempt(attempt);
  const branchName = buildRepairBranchName({ packName, incidentId, attempt: normalizedAttempt });
  const worktreePath = path.join(repairsRoot, incidentId, `attempt-${normalizedAttempt}`);
  const { stdout: baseRevisionStdout = "" } = await execFileImpl("git", [
    "-C",
    normalizedRepoRoot,
    "rev-parse",
    "--verify",
    baseRef
  ]);
  const baseRevisionSha = requireNonEmptyString(baseRevisionStdout, "baseRevisionSha");

  await execFileImpl("git", [
    "-C",
    normalizedRepoRoot,
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    baseRef
  ]);

  return {
    attempt: normalizedAttempt,
    branchName,
    worktreePath,
    baseRef,
    baseRevisionSha
  };
}

export async function listRepairWorktreeChangedFiles({
  worktree,
  execFileImpl = execFileAsync
} = {}) {
  const worktreePath = requireNonEmptyString(worktree?.worktreePath, "worktree.worktreePath");
  const baseRevisionSha = requireNonEmptyString(worktree?.baseRevisionSha, "worktree.baseRevisionSha");
  const { stdout: committedDiffStdout = "" } = await execFileImpl("git", [
    "-C",
    worktreePath,
    "diff",
    "--name-only",
    "--relative",
    `${baseRevisionSha}..HEAD`
  ]);
  const { stdout: dirtyDiffStdout = "" } = await execFileImpl("git", [
    "-C",
    worktreePath,
    "diff",
    "--name-only",
    "--relative"
  ]);
  const { stdout: stagedDiffStdout = "" } = await execFileImpl("git", [
    "-C",
    worktreePath,
    "diff",
    "--cached",
    "--name-only",
    "--relative"
  ]);
  const { stdout: untrackedStdout = "" } = await execFileImpl("git", [
    "-C",
    worktreePath,
    "ls-files",
    "--others",
    "--exclude-standard"
  ]);

  return Array.from(
    new Set(
      [committedDiffStdout, dirtyDiffStdout, stagedDiffStdout, untrackedStdout]
        .flatMap((output) => String(output).split("\n"))
        .map((line) => line.trim())
        .filter(Boolean)
    )
  );
}
