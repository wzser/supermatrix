import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCodexReviewer } from "./daily-commit-reviewer.js";
import { LOCALGIT_ROOT, resolveSopById } from "./localgit-context.js";
import {
  FAST_PATH_REASON,
  JUDGMENT_PARAMS,
  L2_PROMPT_REFERENCE_PATH,
  OWNER_DECISION_RUBRIC_VERSION,
  REPO_POLICIES_DIR,
  buildCommitMessage,
  buildCommitSet,
  buildL2Prompt,
  classifyFileL0,
  extractPromptTemplate,
  isBehaviorFastPathEligible,
  loadRepoPolicy,
  matchPolicyRule,
  noiseIgnoreEntryFor,
  parseL2Verdicts,
  prioritizeForContentScan,
  summarizeLeftovers,
  type FileDisposition,
  type FileEvidence,
} from "./daily-commit-judgment-matrix.js";
import { detectStubToFormalTransitionFromDiff, isNovelClaudeMdIdentityChange } from "./stub-transition.js";

// Per-repo judgment pipeline (SOP-daily-commit-judgment-matrix Steps 1-5), importable
// without side effects so integration tests can drive it against scratch repos with a
// stubbed reviewer. daily-commit.ts is the scheduling/routing orchestrator around it.

export const GIT_USER = "localgit";
export const GIT_EMAIL = "localgit@supermatrix.local";
export const BRANCH_PATROL_SOP = resolveSopById(
  join(LOCALGIT_ROOT, "sop"),
  "68dd04",
);

export type RepoRef = { name: string; path: string };

export type RepoResult = {
  name: string;
  committed: boolean;
  message: string;
  filesChanged: number;
  skippedReason: string;
  branch?: string;
  headBefore?: string;
  headAfter?: string;
  parents?: string[];
  changedFiles?: string[];
  autoFixed?: boolean;
  deferred?: boolean;
  localgitOwned?: boolean;
  mustReviewBacklog?: boolean;
  dirtyFingerprint?: string;
  dispositions?: FileDisposition[];
  decisionSource?: string;
  leftoverSummary?: string;
  reviewerFailure?: string;
  holdOnly?: boolean;
  holdBranch?: string;
  holdCommit?: string;
  holdOriginalBranch?: string;
  holdOriginalHead?: string;
  holdFiles?: string[];
};

export type PipelineDeps = {
  reviewer?: (prompt: string, cwd: string) => string;
  promptTemplate?: string | null;
  policiesDir?: string;
};

export function git(args: string[], cwd: string): string {
  // maxBuffer 50MB: a stray un-gitignored venv can produce 30k+ files / 3MB+ in `ls-files --others`,
  // which overflows Node's 1MB default and throws ENOBUFS, killing the whole daily run.
  return execFileSync("git", args, { cwd, encoding: "utf-8", timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).trim();
}

export function isDirty(repoPath: string): boolean {
  return git(["status", "--short"], repoPath).length > 0;
}

export type StatusEntry = { code: string; file: string };

export function collectStatusEntries(repoPath: string): StatusEntry[] {
  // --untracked-files=all expands untracked directories into individual files so the
  // matrix judges files, not opaque "src/" entries. Embedded git repos still show as
  // a single collapsed "dir/" entry, which is exactly what R4 needs.
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoPath,
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  }).toString("utf-8");

  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const entries: StatusEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const file = token.slice(3);
    entries.push({ code, file });
    // Rename/copy entries carry the source path as the next NUL token.
    if (code.startsWith("R") || code.startsWith("C")) i++;
  }
  return entries;
}

export function listChangedFiles(repoPath: string): string[] {
  return collectStatusEntries(repoPath).map((e) => e.file);
}

function readHeadBytes(absPath: string, maxBytes: number): Buffer | null {
  try {
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function collectFileEvidence(repoPath: string, entry: StatusEntry, sampled: boolean): FileEvidence {
  const file = entry.file.replace(/\/+$/, "");
  const abs = join(repoPath, file);
  const evidence: FileEvidence = {
    file,
    statusCode: entry.code,
    bytes: null,
    isBinary: false,
    contentSample: "",
    sampled,
  };

  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(abs);
  } catch {
    // Deleted tracked files have no on-disk stat; diff sampling below still works.
  }

  if (stat?.isSymbolicLink()) {
    evidence.isSymlink = true;
    try {
      evidence.contentSample = `symlink -> ${readlinkSync(abs)}`;
      evidence.sampled = true;
    } catch {
      evidence.unreadable = true;
    }
    evidence.bytes = stat.size;
    return evidence;
  }

  if (stat?.isDirectory() || entry.file.endsWith("/")) {
    evidence.isUntrackedDir = true;
    evidence.hasNestedGit = existsSync(join(abs, ".git"));
    return evidence;
  }

  evidence.bytes = stat?.size ?? null;
  if (!sampled) return evidence;

  const isUntracked = entry.code === "??";
  if (isUntracked) {
    const head = readHeadBytes(abs, 16 * 1024);
    if (head === null) {
      evidence.unreadable = true;
      return evidence;
    }
    evidence.isBinary = head.includes(0);
    if (!evidence.isBinary) {
      evidence.contentSample = head
        .toString("utf-8")
        .split("\n")
        .slice(0, JUDGMENT_PARAMS.untrackedHeadLines)
        .join("\n");
    }
    return evidence;
  }

  try {
    const diff = git(["diff", "--", file], repoPath);
    const cached = git(["diff", "--cached", "--", file], repoPath);
    evidence.contentSample = `${diff}\n${cached}`.trim().slice(0, JUDGMENT_PARAMS.diffHeadBytes);
  } catch {
    evidence.unreadable = true;
  }
  const head = readHeadBytes(abs, 8192);
  if (head) evidence.isBinary = head.includes(0);
  return evidence;
}

export function getDirtyFingerprint(repoPath: string): string {
  const hash = createHash("sha256");
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    cwd: repoPath,
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  });
  hash.update(status);
  hash.update("\0tracked\0");
  hash.update(git(["diff", "--binary"], repoPath));
  hash.update("\0staged\0");
  hash.update(git(["diff", "--cached", "--binary"], repoPath));

  const untracked = git(["ls-files", "--others", "--exclude-standard"], repoPath)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  for (const file of untracked) {
    hash.update("\0untracked\0");
    hash.update(file);
    try {
      hash.update(readFileSync(join(repoPath, file)));
    } catch {
      hash.update("<unreadable>");
    }
  }

  return hash.digest("hex");
}

export function getHead(repoPath: string): string {
  try {
    return git(["rev-parse", "HEAD"], repoPath);
  } catch {
    return "";
  }
}

export function getBranch(repoPath: string): string {
  try {
    return git(["branch", "--show-current"], repoPath) || "HEAD";
  } catch {
    return "unknown";
  }
}

export function getCommitParents(repoPath: string, commitSha: string): string[] {
  if (!commitSha) return [];
  try {
    const line = git(["rev-list", "--parents", "-n", "1", commitSha], repoPath);
    return line.split(/\s+/).slice(1).filter(Boolean);
  } catch {
    return [];
  }
}

export function getLatestDirtyMtime(repoPath: string): number | null {
  let latest: number | null = null;
  for (const file of listChangedFiles(repoPath)) {
    try {
      const mtime = statSync(join(repoPath, file)).mtimeMs;
      if (latest === null || mtime > latest) latest = mtime;
    } catch {
      // Deleted or path-quoted files have no readable mtime; skip them for ordering.
    }
  }
  return latest;
}

export function detectStubToFormalTransition(repoPath: string) {
  try {
    const changed = listChangedFiles(repoPath);
    // `git diff HEAD` covers both staged and unstaged tracked changes; untracked
    // CLAUDE.md/AGENTS.md (no prior stub) won't show here, which is correct — that
    // case isn't a stub→formal transition.
    const diff = git(["diff", "HEAD", "--", "CLAUDE.md", "AGENTS.md"], repoPath);
    return detectStubToFormalTransitionFromDiff(diff, changed);
  } catch {
    return { match: false as const, reason: "git diff failed" };
  }
}

export function detectNovelIdentityChange(repoPath: string): boolean {
  // Inspect the actual diff (not reviewer prose) to decide whether the .md change
  // needs FP governance; see isNovelClaudeMdIdentityChange for the criterion.
  try {
    const changed = listChangedFiles(repoPath);
    const untracked = git(["ls-files", "--others", "--exclude-standard"], repoPath)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const diff = git(["diff", "HEAD", "--", "CLAUDE.md", "AGENTS.md"], repoPath);
    return isNovelClaudeMdIdentityChange(diff, changed, untracked);
  } catch {
    return false;
  }
}

export function appendGitignoreEntries(repoPath: string, entries: string[]): string[] {
  const gitignorePath = join(repoPath, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const existingSet = new Set(existing.split("\n").map((line) => line.trim()).filter(Boolean));
  const toAppend = [...new Set(entries)].filter((e) => e && !existingSet.has(e));
  if (toAppend.length === 0) return [];
  const banner = "\n# auto-added by localgit daily-commit\n";
  appendFileSync(gitignorePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + banner + toAppend.join("\n") + "\n");
  return toAppend;
}

export function tryCommitFiles(
  repo: RepoRef,
  msg: string,
  files: string[],
  forceFiles: Set<string> = new Set(),
): { ok: boolean; result: RepoResult } {
  const branch = getBranch(repo.path);
  const headBefore = getHead(repo.path);
  const changedFiles = listChangedFiles(repo.path);
  try {
    // Selective staging only — `git add -A` is a red line (Repo Management Principle §5.2);
    // chunk to keep argv well under ARG_MAX for large safe sets. Files the owner
    // explicitly declared `commit` in the manifest may sit under an ignore pattern
    // appended for their siblings — that explicit declaration is the one sanctioned
    // use of `add -f`, scoped to exactly those paths.
    // Tracked files always stage with -f: a tracked path whose parent dir was later
    // .gitignored (huodaiduijie runtime/ case) makes plain `git add` refuse the whole
    // chunk. -f on an explicitly listed tracked file is a no-op vs ignore semantics —
    // the file is already in history; owner ignore rules only govern new files.
    const tracked = new Set<string>();
    for (let i = 0; i < files.length; i += 200) {
      const out = git(["ls-files", "--", ...files.slice(i, i + 200)], repo.path);
      for (const f of out.split("\n").map((l) => l.trim()).filter(Boolean)) tracked.add(f);
    }
    const regular = files.filter((f) => !forceFiles.has(f) && !tracked.has(f));
    const forced = files.filter((f) => forceFiles.has(f) || tracked.has(f));
    for (let i = 0; i < regular.length; i += 200) {
      git(["-c", `user.name=${GIT_USER}`, "-c", `user.email=${GIT_EMAIL}`, "add", "--", ...regular.slice(i, i + 200)], repo.path);
    }
    for (let i = 0; i < forced.length; i += 200) {
      git(["-c", `user.name=${GIT_USER}`, "-c", `user.email=${GIT_EMAIL}`, "add", "-f", "--", ...forced.slice(i, i + 200)], repo.path);
    }
    git(["-c", `user.name=${GIT_USER}`, "-c", `user.email=${GIT_EMAIL}`, "commit", "-m", msg], repo.path);
    const headAfter = getHead(repo.path);
    return {
      ok: true,
      result: {
        name: repo.name,
        committed: true,
        message: msg.split("\n")[0],
        filesChanged: files.length,
        skippedReason: "",
        branch,
        headBefore,
        headAfter,
        parents: getCommitParents(repo.path, headAfter),
        changedFiles,
      },
    };
  } catch (err) {
    return {
      ok: false,
      result: {
        name: repo.name,
        committed: false,
        message: "",
        filesChanged: files.length,
        skippedReason: `git commit failed: ${(err as Error).message.slice(0, 100)}`,
        branch,
        headBefore,
        headAfter: getHead(repo.path),
        changedFiles,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// L2 review invocation with strict parsing + one retry (SOP Step 4).
// ---------------------------------------------------------------------------

let l2PromptTemplateCache: string | null | undefined;

function getL2PromptTemplate(deps: PipelineDeps): string | null {
  if (deps.promptTemplate !== undefined) return deps.promptTemplate;
  if (l2PromptTemplateCache !== undefined) return l2PromptTemplateCache;
  try {
    l2PromptTemplateCache = extractPromptTemplate(readFileSync(L2_PROMPT_REFERENCE_PATH, "utf-8"));
  } catch {
    l2PromptTemplateCache = null;
  }
  return l2PromptTemplateCache;
}

function defaultReviewer(prompt: string, cwd: string): string {
  return runCodexReviewer(prompt, cwd, { timeoutMs: JUDGMENT_PARAMS.reviewerTimeoutMs });
}

function runL2Review(
  repo: RepoRef,
  evidences: FileEvidence[],
  deps: PipelineDeps,
): { ok: true; verdicts: Map<string, { verdict: "SAFE" | "RISKY" | "OWNER"; reason: string }> } | { ok: false; error: string } {
  const template = getL2PromptTemplate(deps);
  if (!template) return { ok: false, error: `L2 prompt template unreadable at ${L2_PROMPT_REFERENCE_PATH}` };

  const reviewer = deps.reviewer ?? defaultReviewer;
  const prompt = buildL2Prompt(template, repo.name, evidences);
  const expected = evidences.map((e) => e.file);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      raw = reviewer(prompt, repo.path);
    } catch (err) {
      lastError = (err as Error).message.slice(0, 150);
      continue;
    }
    const parsed = parseL2Verdicts(raw, expected);
    if (parsed.ok) {
      return { ok: true, verdicts: new Map(parsed.verdicts.map((v) => [v.file, { verdict: v.verdict, reason: v.reason }])) };
    }
    lastError = parsed.error;
  }
  return { ok: false, error: lastError || "reviewer produced no parseable output" };
}

export function buildMustReviewFailureReason(cause: string): string {
  return `blocked: must-review dirty set could not be reviewed by localgit (${cause}); localgit must retry or improve reviewer capacity before owner routing`;
}

// ---------------------------------------------------------------------------
// Judgment pipeline (Steps 1-5) — one repo in, one RepoResult out.
// ---------------------------------------------------------------------------

export function judgeRepo(
  repo: RepoRef,
  changedEntries: StatusEntry[],
  fingerprint: string | undefined,
  deps: PipelineDeps = {},
): RepoResult {
  const changedFiles = changedEntries.map((e) => e.file);
  const { sample, truncated } = prioritizeForContentScan(changedFiles, JUDGMENT_PARAMS.contentScanMaxFiles);
  if (truncated > 0) {
    console.log(`  content_scan_truncated: ${truncated} files classified by path only (cap ${JUDGMENT_PARAMS.contentScanMaxFiles})`);
  }

  const identityFiles = new Set<string>();
  if (detectNovelIdentityChange(repo.path)) {
    for (const f of changedFiles) {
      if (f === "CLAUDE.md" || f === "AGENTS.md") identityFiles.add(f);
    }
  }

  const evidences = changedEntries.map((entry) => collectFileEvidence(repo.path, entry, sample.has(entry.file)));
  const dispositions: FileDisposition[] = [];
  const l2Candidates: FileEvidence[] = [];
  const noiseEntries: string[] = [];
  const manifestIgnorePatterns: string[] = [];

  const { policy, error: manifestError } = loadRepoPolicy(deps.policiesDir ?? REPO_POLICIES_DIR, repo.name);
  if (manifestError) {
    // Case-2: broken manifest degrades to no-manifest; the run must not stall on it.
    console.error(`  manifest error for ${repo.name}: ${manifestError}`);
  }
  const rules = policy?.rules ?? [];

  for (const evidence of evidences) {
    const file = evidence.file;
    const l0 = classifyFileL0(evidence, { identityFiles });

    if (l0 === "deny_secret") {
      // Exact-path fixture exemption per secret-patterns reference §3 (no globs).
      const exemption = matchPolicyRule(rules, file);
      if (exemption && exemption.action === "commit" && !exemption.pattern.includes("*") && !exemption.pattern.includes("?")) {
        dispositions.push({ file, class: l0, verdict: "SAFE", reason: `manifest fixture exemption: ${exemption.note ?? ""}`.trim(), source: "manifest" });
      } else {
        dispositions.push({ file, class: l0, verdict: "DENY", reason: "secrets pattern hit; never auto-commit/auto-ignore (rubric §A-1)", source: "l0" });
      }
      continue;
    }
    if (l0 === "deny_nested_git") {
      dispositions.push({ file, class: l0, verdict: "DENY", reason: "embedded git repository; never auto-commit (aftersale-web incident class)", source: "l0" });
      continue;
    }
    if (l0 === "conflict") {
      dispositions.push({ file, class: l0, verdict: "DENY", reason: "merge-conflict state", source: "l0" });
      continue;
    }
    if (l0 === "noise") {
      const entry = noiseIgnoreEntryFor(file);
      if (entry) noiseEntries.push(entry);
      dispositions.push({ file, class: l0, verdict: "IGNORE", reason: `allowlisted machine noise → .gitignore ${entry}`, source: "l0" });
      continue;
    }
    if (l0 === "identity") {
      dispositions.push({ file, class: l0, verdict: "OWNER", reason: "identity-doc major change; first-principle governance route", source: "l0" });
      continue;
    }
    if (l0 === "deny_db" || l0 === "deny_big" || l0 === "artifact") {
      const rule = matchPolicyRule(rules, file);
      if (rule?.action === "commit") {
        dispositions.push({ file, class: l0, verdict: "SAFE", reason: `manifest: ${rule.note ?? rule.pattern}`, source: "manifest" });
      } else if (rule?.action === "ignore") {
        manifestIgnorePatterns.push(rule.pattern);
        dispositions.push({ file, class: l0, verdict: "IGNORE", reason: `manifest: .gitignore ${rule.pattern}`, source: "manifest" });
      } else if (rule?.action === "keep_dirty") {
        dispositions.push({ file, class: l0, verdict: "KEEP_DIRTY", reason: `manifest: ${rule.note ?? "owner chose keep_dirty"}`, source: "manifest" });
      } else {
        dispositions.push({ file, class: l0, verdict: "PENDING_OWNER", reason: "no manifest rule; awaiting owner decision per rubric §A", source: "manifest" });
      }
      continue;
    }
    // l0 === "source": manifest may still pre-decide it (owner precision rules win),
    // otherwise it is an L2 gray-zone candidate.
    const rule = matchPolicyRule(rules, file);
    if (rule?.action === "commit") {
      dispositions.push({ file, class: l0, verdict: "SAFE", reason: `manifest: ${rule.note ?? rule.pattern}`, source: "manifest" });
    } else if (rule?.action === "ignore") {
      manifestIgnorePatterns.push(rule.pattern);
      dispositions.push({ file, class: l0, verdict: "IGNORE", reason: `manifest: .gitignore ${rule.pattern}`, source: "manifest" });
    } else if (rule?.action === "keep_dirty") {
      dispositions.push({ file, class: l0, verdict: "KEEP_DIRTY", reason: "manifest: owner chose keep_dirty", source: "manifest" });
    } else if (isBehaviorFastPathEligible(evidence)) {
      // Behavior fast path: sampled, secret-screened text under a must-commit dir is
      // the durability target itself — commit without reviewer spend (SOP Step 2 R9).
      dispositions.push({ file, class: l0, verdict: "SAFE", reason: FAST_PATH_REASON, source: "l0" });
    } else {
      l2Candidates.push(evidence);
    }
  }

  // R5: any conflict-state file freezes the whole repo for the day (SOP Step 2).
  if (dispositions.some((d) => d.class === "conflict")) {
    const conflictFiles = dispositions.filter((d) => d.class === "conflict").map((d) => d.file).slice(0, 10);
    for (const c of l2Candidates) {
      dispositions.push({ file: c.file, class: "source", verdict: "KEEP_DIRTY", reason: "repo frozen by merge-conflict state", source: "l0" });
    }
    return {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: changedFiles.length,
      skippedReason: `blocked: merge-conflict state detected (${conflictFiles.join(", ")}); routed to branch-merge patrol per ${BRANCH_PATROL_SOP} — owner merges per rubric §B, localgit never auto-resolves`,
      changedFiles,
      dirtyFingerprint: fingerprint,
      dispositions,
      decisionSource: "l0",
    };
  }

  let decisionSource = "l0";
  if (l2Candidates.length > 0) {
    // L2 candidate cap: a giant gray-zone heap must not produce an ETIMEDOUT-scale
    // prompt or eat the loop budget. Overflow goes PENDING_OWNER so a stagnant heap
    // reaches the weekly digest / manifest flow instead of silently re-queuing forever.
    const overflow = l2Candidates.splice(JUDGMENT_PARAMS.l2MaxFiles);
    for (const c of overflow) {
      dispositions.push({
        file: c.file,
        class: "source",
        verdict: "PENDING_OWNER",
        reason: `L2 candidate cap (${JUDGMENT_PARAMS.l2MaxFiles}) exceeded; bulk gray-zone heap awaits manifest rule per rubric §A`,
        source: "l0",
      });
    }
    if (overflow.length > 0) {
      console.log(`  l2_candidate_cap: reviewing ${l2Candidates.length}/${l2Candidates.length + overflow.length}`);
    }
    const review = runL2Review(repo, l2Candidates, deps);
    if (!review.ok) {
      for (const c of l2Candidates) {
        dispositions.push({ file: c.file, class: "source", verdict: "UNREVIEWED", reason: `reviewer_unavailable: ${review.error.slice(0, 100)}`, source: "l2-fresh" });
      }
      const reviewerFailure = buildMustReviewFailureReason(
        `codex reviewer likely stalled or returned invalid schema: ${review.error.slice(0, 120)}`,
      );
      // A reviewer outage must not discard verdicts already decided without it.
      // L0/manifest SAFE files (behavior fast path included) are judged independently
      // of L2, so they still commit; only the gray zone stays UNREVIEWED for retry.
      if (buildCommitSet(dispositions).length > 0) {
        const partial = applyDispositions(repo, changedFiles, dispositions, fingerprint, "l2-fresh", {
          noiseEntries,
          manifestIgnorePatterns,
        });
        partial.reviewerFailure = reviewerFailure;
        partial.localgitOwned = true;
        return partial;
      }
      return {
        name: repo.name,
        committed: false,
        message: "",
        filesChanged: changedFiles.length,
        skippedReason: reviewerFailure,
        reviewerFailure,
        changedFiles,
        dirtyFingerprint: fingerprint,
        dispositions,
        decisionSource: "l2-fresh",
      };
    }
    for (const c of l2Candidates) {
      const v = review.verdicts.get(c.file);
      if (!v) continue;
      dispositions.push({
        file: c.file,
        class: "source",
        verdict: v.verdict,
        reason: v.reason,
        source: "l2-fresh",
      });
    }
    decisionSource = "l2-fresh";
  }

  return applyDispositions(repo, changedFiles, dispositions, fingerprint, decisionSource, { noiseEntries, manifestIgnorePatterns });
}

export function applyDispositions(
  repo: RepoRef,
  changedFiles: string[],
  dispositions: FileDisposition[],
  fingerprint: string | undefined,
  decisionSource: string,
  ignoreWork: { noiseEntries: string[]; manifestIgnorePatterns: string[] } = { noiseEntries: [], manifestIgnorePatterns: [] },
): RepoResult {
  // Deterministic .gitignore remediation for allowlisted noise + manifest-ignore rules.
  const appended = appendGitignoreEntries(repo.path, [...ignoreWork.noiseEntries, ...ignoreWork.manifestIgnorePatterns]);
  const commitSet = buildCommitSet(dispositions);
  if (appended.length > 0 && !commitSet.includes(".gitignore")) {
    dispositions.push({ file: ".gitignore", class: "source", verdict: "SAFE", reason: `auto-remediate appended: ${appended.join(", ")}`, source: "l0" });
    commitSet.push(".gitignore");
  }

  const leftoverSummary = summarizeLeftovers(dispositions);

  if (commitSet.length === 0) {
    const pendingOnly = dispositions.every((d) => ["PENDING_OWNER", "KEEP_DIRTY", "IGNORE"].includes(d.verdict));
    const reasons = dispositions
      .filter((d) => ["DENY", "RISKY", "OWNER"].includes(d.verdict))
      .slice(0, 6)
      .map((d) => `${d.file}: ${d.reason ?? d.verdict}`);
    return {
      name: repo.name,
      committed: false,
      message: "",
      filesChanged: changedFiles.length,
      skippedReason: pendingOnly
        ? `deferred: awaiting owner decision via manifest/digest (${leftoverSummary || "no actionable files"}) — rubric ${OWNER_DECISION_RUBRIC_VERSION} §A`
        : `no safe subset to commit (${leftoverSummary}). ${reasons.join("; ")}`.slice(0, 900),
      deferred: pendingOnly,
      changedFiles,
      dirtyFingerprint: fingerprint,
      dispositions,
      decisionSource,
      leftoverSummary,
    };
  }

  const msg = buildCommitMessage(repo.name, dispositions, commitSet);
  const forceFiles = new Set(
    dispositions.filter((d) => d.verdict === "SAFE" && d.source === "manifest").map((d) => d.file),
  );
  const attempt = tryCommitFiles(repo, msg, commitSet, forceFiles);
  const result = attempt.result;
  result.dispositions = dispositions;
  result.decisionSource = decisionSource;
  result.dirtyFingerprint = fingerprint;
  if (attempt.ok && leftoverSummary) {
    result.leftoverSummary = leftoverSummary;
    result.skippedReason = "";
  }
  return result;
}

export function defaultSuggestionFor(result: RepoResult): string {
  const d = result.dispositions ?? [];
  if (d.some((x) => x.class === "deny_secret" && x.verdict === "DENY")) {
    return "keep_dirty 并把敏感文件移出仓或脱敏（rubric §A-1）";
  }
  if (d.some((x) => x.class === "conflict")) {
    return "由你按 rubric §B-C4 逐块合并，禁 --ours/--theirs";
  }
  if (d.some((x) => x.verdict === "RISKY" || x.verdict === "OWNER")) {
    return "按各文件 reason 中的 E 码对应 rubric 段处置；无 E 码文件已由 localgit 提交";
  }
  return "按 rubric §A 四问自查后回复枚举动作";
}
