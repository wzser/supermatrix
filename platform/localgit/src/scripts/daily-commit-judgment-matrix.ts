import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitLedgerEntry } from "./git-ledger.js";
import { LOCALGIT_ROOT, resolveSopById } from "./localgit-context.js";

// Rule flow SSoT: resolve by stable SOP id 1a186q.
// Catalog SSoT:   sop/references/daily-commit-ignore-policy.md (allowlist / artifact-first lists)
// Owner asks:     sop/references/owner-decision-rubric.md (§D template obligations)
export const JUDGMENT_MATRIX_SOP_PATH = resolveSopById(join(LOCALGIT_ROOT, "sop"), "1a186q");
export const OWNER_DECISION_RUBRIC_PATH = join(LOCALGIT_ROOT, "sop/references/owner-decision-rubric.md");
export const OWNER_DECISION_RUBRIC_VERSION = "v1";
export const L2_PROMPT_REFERENCE_PATH = join(LOCALGIT_ROOT, "sop/references/SOP-daily-commit-judgment-matrix-l2-review-prompt.md");
export const SECRET_PATTERNS_REFERENCE_PATH = join(LOCALGIT_ROOT, "sop/references/SOP-daily-commit-judgment-matrix-secret-patterns.md");
export const REPO_POLICIES_DIR = join(LOCALGIT_ROOT, "registry/repo-policies");

// SOP 参数表 — values must match the SOP table; tests assert the invariants that matter.
export const JUDGMENT_PARAMS = {
  loopBudgetMs: 18 * 60 * 1000,
  reviewerTimeoutMs: 120_000,
  untrackedHeadLines: 80,
  diffHeadBytes: 4096,
  bigFileBytes: 10 * 1024 * 1024,
  bigBinaryBytes: 2 * 1024 * 1024,
  inflightWindowMs: 2 * 60 * 60 * 1000,
  artifactDigestDays: 7,
  contentScanMaxFiles: 500,
  l2MaxFiles: 60,
} as const;

export type L0Class =
  | "deny_secret"
  | "deny_db"
  | "deny_big"
  | "deny_nested_git"
  | "conflict"
  | "noise"
  | "identity"
  | "artifact"
  | "source";

export type FileEvidence = {
  file: string;
  statusCode: string;
  bytes: number | null;
  isBinary: boolean;
  contentSample: string;
  sampled: boolean;
  isUntrackedDir?: boolean;
  hasNestedGit?: boolean;
  unreadable?: boolean;
  isSymlink?: boolean;
};

export type FileVerdict =
  | "SAFE"
  | "RISKY"
  | "OWNER"
  | "DENY"
  | "IGNORE"
  | "PENDING_OWNER"
  | "KEEP_DIRTY"
  | "UNREVIEWED";

export type DispositionSource = "l0" | "manifest" | "l2-fresh" | "cached";

export type FileDisposition = {
  file: string;
  class: L0Class;
  verdict: FileVerdict;
  reason?: string;
  source: DispositionSource;
};

// ---------------------------------------------------------------------------
// R1 DENY-SECRET — synced with references/SOP-daily-commit-judgment-matrix-secret-patterns.md.
// Tests parse the reference doc and assert both tables stay in lockstep.
// ---------------------------------------------------------------------------

export const SECRET_NAME_GLOBS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa*",
  "id_ed25519*",
  "*.ppk",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "*credential*",
  "*token*",
  "*secret*",
  "*cookie*",
  "*.kdbx",
  "service-account*.json",
] as const;

export const SECRET_NAME_EXCLUDES = [/tokenizer/i, /token_count/i];

export const SECRET_PATH_DIRS = [".aws", ".ssh"] as const;

export const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN( RSA| EC| OPENSSH| PGP)? PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9-]{20,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /authorization:\s*bearer\s+ey[A-Za-z0-9_-]{20,}/i,
  /(api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
  /password\s*[:=]\s*['"][^'"]{8,}['"]/i,
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i");
}

const SECRET_NAME_REGEXPS = SECRET_NAME_GLOBS.map((g) => ({ glob: g, re: globToRegExp(g) }));

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function basename(filePath: string): string {
  return normalizePath(filePath).split("/").pop() ?? "";
}

function extension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function matchesSecretName(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (normalized.split("/").some((seg) => SECRET_PATH_DIRS.includes(seg as (typeof SECRET_PATH_DIRS)[number]))) {
    return true;
  }
  const name = basename(normalized);
  const matched = SECRET_NAME_REGEXPS.filter(({ re }) => re.test(name));
  if (matched.length === 0) return false;
  // "*token*" excludes tokenizer / token_count artifacts; the exclusion only saves the
  // file when no other secret glob matched it.
  if (SECRET_NAME_EXCLUDES.some((re) => re.test(name)) && matched.every(({ glob }) => glob === "*token*")) {
    return false;
  }
  return true;
}

export function matchesSecretContent(sample: string): boolean {
  if (!sample) return false;
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(sample));
}

// ---------------------------------------------------------------------------
// R6 NOISE / R8 ARTIFACT catalogs — mirror sop/references/daily-commit-ignore-policy.md.
// ---------------------------------------------------------------------------

const NOISE_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "tmp",
  "temp",
  "__MACOSX",
]);

// Lockfiles that are real source contracts and must never be treated as noise.
const MEANINGFUL_LOCK_BASENAMES = new Set([
  "yarn.lock",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "flake.lock",
  "bun.lock",
  "composer.lock",
]);

export const ARTIFACT_FIRST_DIRS = new Set([
  "data",
  "raw",
  "output",
  "outputs",
  "runs",
  "reports",
  "captures",
  "screenshots",
  "media",
  "artifacts",
  "archive",
  "diagnostics",
  "exports",
  "logs",
  "downloads",
  "payloads",
  "metrics",
  "snapshots",
  "backups",
  "lark-im-resources",
  "deepthink-runs",
]);

// Behavior fast path: first-segment dirs whose readable text changes are the exact
// durability target of daily-commit. A sampled, non-binary, secret-screened file here
// commits directly (verdict SAFE) with zero L2 reviewer spend; L2 is reserved for
// gray-zone residue outside both this list and ARTIFACT_FIRST_DIRS. Root-level files
// deliberately stay on the L2 path (identity docs, symlinks, ad-hoc drops).
export const BEHAVIOR_FAST_PATH_DIRS = new Set([
  "src",
  "server",
  "scripts",
  "tests",
  "test",
  "sop",
  "docs",
  "templates",
  "skills",
  "config",
  "migrations",
  "bin",
  "lib",
  "principles",
]);

export const FAST_PATH_REASON = "behavior-dir fast path: L0-screened text change";

export function isBehaviorFastPathEligible(evidence: FileEvidence): boolean {
  const first = normalizePath(evidence.file).split("/")[0] ?? "";
  if (!BEHAVIOR_FAST_PATH_DIRS.has(first)) return false;
  return (
    evidence.sampled &&
    !evidence.isBinary &&
    !evidence.unreadable &&
    !evidence.isSymlink &&
    !evidence.isUntrackedDir
  );
}

const DB_EXT_RE = /\.(db|sqlite3?|kdb)(-(wal|shm|journal))?$/i;
const DB_EXTS = new Set([".db", ".sqlite", ".sqlite3", ".db-wal", ".db-shm", ".db-journal"]);

export function noiseIgnoreEntryFor(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const name = basename(normalized);
  for (const seg of normalized.split("/")) {
    if (NOISE_DIR_SEGMENTS.has(seg)) return `${seg}/`;
  }
  if (name === ".DS_Store") return ".DS_Store";
  if (/^\._[^/]+$/.test(name)) return "._*";
  if (name.endsWith(".pyc")) return "*.pyc";
  if (name.endsWith(".log")) return "*.log";
  if (name.endsWith(".lock") && !MEANINGFUL_LOCK_BASENAMES.has(name.toLowerCase())) return "*.lock";
  return null;
}

export function isArtifactFirstPath(filePath: string): boolean {
  const first = normalizePath(filePath).split("/")[0] ?? "";
  return ARTIFACT_FIRST_DIRS.has(first);
}

function hasConflictStatus(statusCode: string): boolean {
  const xy = statusCode.padEnd(2).slice(0, 2);
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

function hasConflictMarkers(sample: string): boolean {
  // Tracked-file samples are diffs, so marker lines arrive prefixed with "+" or " ".
  return /^[+ ]?<{7}(\s|$)/m.test(sample);
}

export function classifyFileL0(
  evidence: FileEvidence,
  opts: { identityFiles?: Set<string>; params?: typeof JUDGMENT_PARAMS } = {},
): L0Class {
  const params = opts.params ?? JUDGMENT_PARAMS;
  const file = normalizePath(evidence.file);

  if (matchesSecretName(file)) return "deny_secret";
  if (evidence.sampled && matchesSecretContent(evidence.contentSample)) return "deny_secret";
  if (DB_EXTS.has(extension(file)) || DB_EXT_RE.test(basename(file))) return "deny_db";
  if (evidence.bytes !== null && (evidence.bytes > params.bigFileBytes || (evidence.isBinary && evidence.bytes > params.bigBinaryBytes))) {
    return "deny_big";
  }
  if (evidence.hasNestedGit) return "deny_nested_git";
  if (hasConflictStatus(evidence.statusCode) || (evidence.sampled && hasConflictMarkers(evidence.contentSample))) {
    return "conflict";
  }
  if (noiseIgnoreEntryFor(file) !== null) return "noise";
  if (opts.identityFiles?.has(file)) return "identity";
  if (isArtifactFirstPath(file)) return "artifact";
  return "source";
}

// Path-only pre-class used to prioritize which files get content sampling under
// param.content_scan_max_files: likely-source files first, artifact tails last.
export function prioritizeForContentScan(files: string[], maxFiles: number): { sample: Set<string>; truncated: number } {
  const scored = files.map((file) => ({ file, artifact: isArtifactFirstPath(file) || noiseIgnoreEntryFor(file) !== null }));
  scored.sort((a, b) => Number(a.artifact) - Number(b.artifact));
  const sample = new Set(scored.slice(0, maxFiles).map((s) => s.file));
  return { sample, truncated: Math.max(0, files.length - maxFiles) };
}

// ---------------------------------------------------------------------------
// L1 manifest — registry/repo-policies/<repo>.json
// ---------------------------------------------------------------------------

export type RepoPolicyRule = {
  pattern: string;
  action: "commit" | "ignore" | "keep_dirty";
  decided_by?: string;
  decided_at?: string;
  source?: string;
  rubric?: string;
  note?: string;
};

export type RepoPolicy = {
  repo: string;
  trunk_branch?: string;
  rules?: RepoPolicyRule[];
};

export function loadRepoPolicy(
  registryDir: string,
  repo: string,
  io: { exists?: (p: string) => boolean; read?: (p: string) => string } = {},
): { policy: RepoPolicy | null; error?: string } {
  const exists = io.exists ?? existsSync;
  const read = io.read ?? ((p: string) => readFileSync(p, "utf-8"));
  const path = join(registryDir, `${repo}.json`);
  if (!exists(path)) return { policy: null };
  try {
    const parsed = JSON.parse(read(path)) as RepoPolicy;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules ?? [])) {
      return { policy: null, error: "manifest schema invalid: rules must be an array" };
    }
    return { policy: parsed };
  } catch (err) {
    return { policy: null, error: `manifest parse failed: ${(err as Error).message}` };
  }
}

function policyGlobToRegExp(pattern: string): RegExp {
  // Tokenize wildcards before expansion so a produced ".*" is never re-rewritten
  // by the single-star pass (data/** must match data/raw/x.json).
  const escaped = normalizePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "\u0003")
    .replace(/\?/g, "\u0004")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0002/g, ".*")
    .replace(/\u0003/g, "[^/]*")
    .replace(/\u0004/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

export function matchPolicyRule(rules: RepoPolicyRule[], filePath: string): RepoPolicyRule | null {
  const normalized = normalizePath(filePath);
  for (const rule of rules) {
    if (!rule?.pattern || !rule.action) continue;
    const pattern = rule.pattern;
    if (pattern.endsWith("/")) {
      if (normalized.startsWith(normalizePath(pattern) + "/")) return rule;
      continue;
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      if (policyGlobToRegExp(pattern).test(normalized)) return rule;
      continue;
    }
    if (normalized === normalizePath(pattern)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// L2 — prompt template from the reference doc; strict per-file verdict parsing.
// ---------------------------------------------------------------------------

export function extractPromptTemplate(markdown: string): string | null {
  const match = markdown.match(/```text\n([\s\S]*?)\n```/);
  return match ? match[1] : null;
}

export function buildL2Prompt(template: string, repoName: string, evidences: FileEvidence[]): string {
  const payload = evidences.map((e) => ({
    file: e.file,
    status: e.statusCode.trim(),
    bytes: e.bytes,
    is_binary: e.isBinary,
    content_sample: e.unreadable ? "<unreadable>" : e.contentSample,
  }));
  return template
    .replace(/\{\{repo_name\}\}/g, repoName)
    .replace(/\{\{files_evidence_json\}\}/g, JSON.stringify(payload, null, 1));
}

export type L2Verdict = { file: string; verdict: "SAFE" | "RISKY" | "OWNER"; reason: string };

// This repository's Git history is local and controlled. Privacy alone is not
// a persistence risk: local personal/business data and Feishu group metadata
// are commit-eligible. E1 remains a distinct access-credential risk.
const BLOCKING_L2_REASON_RE = /^(?:E1|E3|E4|E5)\b/;

function downgradedNonBlockingReason(reason: string): string {
  return `wip: downgraded(non-blocking): ${reason.slice(0, 120)}`;
}

export function parseL2Verdicts(
  raw: string,
  expectedFiles: string[],
): { ok: true; verdicts: L2Verdict[] } | { ok: false; error: string } {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return { ok: false, error: "no JSON array in reviewer output" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `reviewer output is not valid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "reviewer output is not an array" };

  const byFile = new Map<string, L2Verdict>();
  for (const item of parsed) {
    const row = item as Partial<L2Verdict>;
    if (typeof row?.file !== "string" || typeof row?.verdict !== "string") {
      return { ok: false, error: "verdict row missing file/verdict" };
    }
    const verdict = row.verdict.toUpperCase();
    if (!["SAFE", "RISKY", "OWNER"].includes(verdict)) {
      return { ok: false, error: `illegal verdict "${row.verdict}" for ${row.file}` };
    }
    if (byFile.has(row.file)) return { ok: false, error: `duplicate verdict for ${row.file}` };
    byFile.set(row.file, { file: row.file, verdict: verdict as L2Verdict["verdict"], reason: String(row.reason ?? "") });
  }

  const verdicts: L2Verdict[] = [];
  for (const file of expectedFiles) {
    const v = byFile.get(file);
    if (!v) return { ok: false, error: `missing verdict for ${file}` };
    // E2 (private local/customer/business data) is non-blocking in this
    // local-only repository. Other non-enumerated reasons are also illegal;
    // neither may prevent durable local history.
    if (v.verdict !== "SAFE" && !BLOCKING_L2_REASON_RE.test(v.reason.trim())) {
      verdicts.push({ file, verdict: "SAFE", reason: downgradedNonBlockingReason(v.reason) });
    } else {
      verdicts.push(v);
    }
  }
  if (byFile.size !== expectedFiles.length) {
    return { ok: false, error: "reviewer returned verdicts for unexpected files" };
  }
  return { ok: true, verdicts };
}

// ---------------------------------------------------------------------------
// Verdict cache + review ordering (Step 6) + in-flight gate.
// ---------------------------------------------------------------------------

export type CachedVerdict = { fingerprint: string; dispositions: FileDisposition[]; recordedAt: string };

function normalizeCachedDispositionForLocalPrivacyPolicy(disposition: FileDisposition): FileDisposition {
  if (
    (disposition.verdict === "RISKY" || disposition.verdict === "OWNER") &&
    !BLOCKING_L2_REASON_RE.test((disposition.reason ?? "").trim())
  ) {
    return {
      ...disposition,
      verdict: "SAFE",
      reason: downgradedNonBlockingReason(disposition.reason ?? ""),
    };
  }
  return disposition;
}

export function buildVerdictCache(entries: GitLedgerEntry[]): Map<string, CachedVerdict> {
  const cache = new Map<string, CachedVerdict>();
  for (const entry of entries) {
    const dispositions = (entry as GitLedgerEntry & { per_file_dispositions?: FileDisposition[] }).per_file_dispositions;
    // UNREVIEWED is the absence of a judgment (reviewer outage), not a verdict —
    // reusing it via the fingerprint cache would freeze a repo on a stale outage.
    if (Array.isArray(dispositions) && dispositions.some((d) => d.verdict === "UNREVIEWED")) {
      if (entry.repo) cache.delete(entry.repo);
      continue;
    }
    if (entry.repo && entry.dirty_fingerprint && Array.isArray(dispositions) && dispositions.length > 0) {
      cache.set(entry.repo, {
        fingerprint: entry.dirty_fingerprint,
        dispositions: dispositions.map(normalizeCachedDispositionForLocalPrivacyPolicy),
        recordedAt: entry.recorded_at,
      });
    } else if (entry.repo && cache.has(entry.repo) && entry.operation !== "skip") {
      // A later commit invalidates the cached skip verdict for that repo.
      cache.delete(entry.repo);
    }
  }
  return cache;
}

const NEVER_REVIEWED_REASON_RE =
  /time budget|stale must-review|deferred: inactive session|deferred: in-flight|processing error|reviewer_unavailable|codex reviewer likely stalled|control fetch failed/i;

export function deriveLastReviewedAt(entries: GitLedgerEntry[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.repo || !entry.recorded_at) continue;
    const ts = Date.parse(entry.recorded_at);
    if (!Number.isFinite(ts)) continue;
    const dispositions = (entry as GitLedgerEntry & { per_file_dispositions?: FileDisposition[] }).per_file_dispositions;
    const reviewed =
      entry.operation !== "skip" ||
      (Array.isArray(dispositions) && dispositions.length > 0) ||
      (typeof entry.skipped_reason === "string" && !NEVER_REVIEWED_REASON_RE.test(entry.skipped_reason));
    if (reviewed) {
      last.set(entry.repo, Math.max(last.get(entry.repo) ?? 0, ts));
    }
  }
  return last;
}

export function orderReposForProcessing<T extends { name: string }>(
  repos: T[],
  lastReviewedAt: Map<string, number>,
  dirtyMtime: Map<string, number> = new Map(),
): T[] {
  return [...repos].sort((a, b) => {
    const ra = lastReviewedAt.get(a.name) ?? 0;
    const rb = lastReviewedAt.get(b.name) ?? 0;
    if (ra !== rb) return ra - rb;
    const ma = dirtyMtime.get(a.name) ?? Number.POSITIVE_INFINITY;
    const mb = dirtyMtime.get(b.name) ?? Number.POSITIVE_INFINITY;
    if (ma !== mb) return ma - mb;
    return a.name.localeCompare(b.name);
  });
}

export type InFlightDecision = { kind: "process" } | { kind: "defer"; reason: string };

// Semantic inversion vs the pre-2026-07 activity gate: a *recently active* session is
// the risky window (racing in-flight work); a stale+inactive repo is the safest time
// to persist. See SOP Step 6 ②.
export function decideInFlightGate(input: { now: number; lastMessageRunAt: number | null; windowMs?: number }): InFlightDecision {
  const windowMs = input.windowMs ?? JUDGMENT_PARAMS.inflightWindowMs;
  if (input.lastMessageRunAt !== null && input.now - input.lastMessageRunAt <= windowMs) {
    const hours = Math.round((windowMs / (60 * 60 * 1000)) * 10) / 10;
    return { kind: "defer", reason: `deferred: in-flight session activity within ${hours}h; avoiding race with active work` };
  }
  return { kind: "process" };
}

// ---------------------------------------------------------------------------
// Commit assembly helpers (Step 5).
// ---------------------------------------------------------------------------

export function buildCommitSet(dispositions: FileDisposition[]): string[] {
  return dispositions.filter((d) => d.verdict === "SAFE").map((d) => d.file);
}

export function summarizeLeftovers(dispositions: FileDisposition[]): string {
  const counts = new Map<string, number>();
  for (const d of dispositions) {
    if (d.verdict === "SAFE") continue;
    counts.set(d.verdict, (counts.get(d.verdict) ?? 0) + 1);
  }
  return [...counts.entries()].map(([verdict, n]) => `${verdict.toLowerCase()}:${n}`).join(" ");
}

export function buildCommitMessage(repoName: string, dispositions: FileDisposition[], commitFiles: string[]): string {
  const wip = dispositions.some((d) => d.verdict === "SAFE" && d.reason?.startsWith("wip:"));
  const dirs = new Map<string, number>();
  for (const file of commitFiles) {
    const first = normalizePath(file).split("/")[0] ?? file;
    dirs.set(first, (dirs.get(first) ?? 0) + 1);
  }
  const topDirs = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d).join(", ");
  const subject = `${wip ? "wip: " : ""}chore(daily): persist reviewed working set (${commitFiles.length} files: ${topDirs})`;
  const leftovers = summarizeLeftovers(dispositions);
  const body = [
    "Why: daily-commit judgment matrix persistence checkpoint — commit is durability, not release.",
    leftovers ? `Left in worktree: ${leftovers}.` : "",
    `Rubric: ${OWNER_DECISION_RUBRIC_VERSION}; matrix: ${JUDGMENT_MATRIX_SOP_PATH}`,
  ]
    .filter(Boolean)
    .join("\n");
  return `${subject}\n\n${body}`;
}
