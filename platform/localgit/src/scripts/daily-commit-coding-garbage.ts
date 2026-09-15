import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync, unlinkSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import {
  JUDGMENT_PARAMS,
  isArtifactFirstPath,
  isDatabasePath,
  matchesSecretContent,
  matchesSecretName,
} from "./daily-commit-judgment-matrix.js";

export type DirectPurgeCandidate = { file: string };
export type DirectPurgeResult = {
  purged: Array<DirectPurgeCandidate & { bytes: number }>;
  skipped: DirectPurgeCandidate[];
  reclaimedBytes: number;
};
export type DirectPurgeHooks = {
  beforeDelete?: (candidate: DirectPurgeCandidate & { bytes: number }) => void;
  afterDelete?: (candidate: DirectPurgeCandidate & { bytes: number }) => void;
};
export type DirectPurgeDiscoveryOptions = {
  timeoutMs?: number;
  deadlineAt?: number;
};

type StatusLike = { code: string; file: string };

// These names are standardized tool/OS caches, not repo-specific artifact folders.
// Deliberately excluded: node_modules, dist, build, coverage, .next, .cache, tmp,
// temp, logs, and all owner-routed artifact roots. Those can be valuable deliverables
// or active runtime state even when they are reproducible.
const DIRECT_PURGE_MAX_BYTES = JUDGMENT_PARAMS.bigFileBytes;
const DIRECT_PURGE_SAMPLE_BYTES = 16 * 1024;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
export const DIRECT_PURGE_GIT_SCAN_TIMEOUT_MS = 30_000;

const DIRECT_PURGE_PATHSPECS = [
  ":(glob)**/.DS_Store",
  ":(glob)**/._*",
  ":(glob)**/__pycache__/*.pyc",
];

function normalizeRepoRelative(file: string): string | null {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function isInsideRepo(repoPath: string, absolutePath: string): boolean {
  const rel = relative(repoPath, absolutePath);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../") && !rel.startsWith("..\\");
}

function listGitOtherFiles(repoPath: string, ignored: boolean, timeoutMs = DIRECT_PURGE_GIT_SCAN_TIMEOUT_MS): string[] {
  const args = ["ls-files", "--others", "--exclude-standard", "-z"];
  if (ignored) args.push("--ignored");
  args.push("--", ...DIRECT_PURGE_PATHSPECS);
  const raw = execFileSync("git", args, {
    cwd: repoPath,
    timeout: Math.max(1, Math.floor(timeoutMs)),
    maxBuffer: 20 * 1024 * 1024,
  }).toString("utf-8");
  return raw.split("\0").filter(Boolean);
}

export function isDirectlyPurgeableCodingGarbage(file: string): boolean {
  const normalized = normalizeRepoRelative(file);
  if (!normalized) return false;
  const name = basename(normalized);
  const segments = normalized.split("/");
  return name === ".DS_Store" ||
    /^\._[^/]+$/.test(name) ||
    (name.endsWith(".pyc") && segments.at(-2) === "__pycache__");
}

function readHead(absolutePath: string): Buffer | null {
  try {
    const fd = openSync(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(DIRECT_PURGE_SAMPLE_BYTES);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isDeniedForDirectPurge(file: string, absolutePath: string, bytes: number): boolean {
  if (
    bytes > DIRECT_PURGE_MAX_BYTES ||
    matchesSecretName(file) ||
    isDatabasePath(file) ||
    isArtifactFirstPath(file)
  ) {
    return true;
  }
  const sample = readHead(absolutePath);
  if (sample === null) return true;
  if (sample.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) return true;
  return matchesSecretContent(sample.toString("utf-8"));
}

type ResolvedPurgeFile = { realPath: string; bytes: number };

function resolveSafeRegularFile(repoRoot: string, file: string): ResolvedPurgeFile | null {
  const lexicalPath = resolve(repoRoot, file);
  if (!isInsideRepo(repoRoot, lexicalPath)) return null;
  try {
    const stat = lstatSync(lexicalPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realRepoRoot = realpathSync.native(repoRoot);
    const realPath = realpathSync.native(lexicalPath);
    if (!isInsideRepo(realRepoRoot, realPath)) return null;
    if (isDeniedForDirectPurge(file, realPath, stat.size)) return null;
    return { realPath, bytes: stat.size };
  } catch {
    return null;
  }
}

function candidatesFromPaths(repoPath: string, rawPaths: string[], deadlineAt?: number): DirectPurgeCandidate[] {
  const repoRoot = resolve(repoPath);
  const candidates = new Set<string>();
  for (const rawPath of rawPaths) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) break;
    const file = normalizeRepoRelative(rawPath);
    if (!file || !isDirectlyPurgeableCodingGarbage(file)) continue;
    if (resolveSafeRegularFile(repoRoot, file)) candidates.add(file);
  }
  return [...candidates].sort().map((file) => ({ file }));
}

// Production discovery scans only ignored candidates once per repository. Visible
// candidates come from the normal `git status` already required by daily-commit.
export function listIgnoredDirectlyPurgeableCodingGarbage(
  repoPath: string,
  options: DirectPurgeDiscoveryOptions = {},
): DirectPurgeCandidate[] {
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return [];
  return candidatesFromPaths(
    repoPath,
    listGitOtherFiles(repoPath, true, options.timeoutMs),
    options.deadlineAt,
  );
}

export function listDirectlyPurgeableCodingGarbageFromUntrackedStatus(
  repoPath: string,
  entries: StatusLike[],
): DirectPurgeCandidate[] {
  return candidatesFromPaths(repoPath, entries.filter((entry) => entry.code === "??").map((entry) => entry.file));
}

// Test/diagnostic convenience only. The scheduled path deliberately uses the
// split helpers above so it does not repeat Git scans for every repository.
export function listDirectlyPurgeableCodingGarbage(repoPath: string): DirectPurgeCandidate[] {
  return candidatesFromPaths(repoPath, [
    ...listGitOtherFiles(repoPath, false),
    ...listGitOtherFiles(repoPath, true),
  ]);
}

export function shouldPurgeDirectlyPurgeableCodingGarbage(
  changedEntries: StatusLike[],
  candidates: DirectPurgeCandidate[],
): boolean {
  if (candidates.length === 0) return false;
  const candidateFiles = new Set(candidates.map((candidate) => candidate.file));
  return changedEntries.every((entry) => entry.code === "??" && candidateFiles.has(normalizeRepoRelative(entry.file) ?? entry.file));
}

export function purgeDirectlyPurgeableCodingGarbage(
  repoPath: string,
  candidates: DirectPurgeCandidate[],
  hooks: DirectPurgeHooks = {},
): DirectPurgeResult {
  const repoRoot = resolve(repoPath);
  const purged: DirectPurgeResult["purged"] = [];
  const skipped: DirectPurgeCandidate[] = [];
  let reclaimedBytes = 0;

  for (const candidate of candidates) {
    const file = normalizeRepoRelative(candidate.file);
    if (!file || !isDirectlyPurgeableCodingGarbage(file)) {
      skipped.push(candidate);
      continue;
    }
    const resolved = resolveSafeRegularFile(repoRoot, file);
    if (!resolved) {
      skipped.push({ file });
      continue;
    }
    const sizedCandidate = { file, bytes: resolved.bytes };
    // Intent and completion hooks are deliberately outside the deletion catch:
    // if durable auditing fails, stop rather than reporting a successful purge.
    hooks.beforeDelete?.(sizedCandidate);
    try {
      // Unlink the resolved in-repo target, never the original lexical path;
      // this prevents a symlinked parent directory from redirecting deletion.
      unlinkSync(resolved.realPath);
    } catch {
      skipped.push({ file });
      continue;
    }
    hooks.afterDelete?.(sizedCandidate);
    purged.push(sizedCandidate);
    reclaimedBytes += resolved.bytes;
  }

  return { purged, skipped, reclaimedBytes };
}
