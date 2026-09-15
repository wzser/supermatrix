#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_PORT = "3501";
const DEFAULT_IMPACT_REVIEW_MIN_AGE_DAYS = 6;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_WARN_FREE_BYTES = 20 * 1024 ** 3;
const DEFAULT_REBOOT_HINT_FREE_BYTES = 10 * 1024 ** 3;
const DEFAULT_NOTIFY_MIN_DELETED_BYTES = 512 * 1024 ** 2;
const CODEX_SESSION_TRANSCRIPTS_RULE_ID = "codex-session-transcripts-old-days";
const UV_CACHE_ROOT = "/Users/LOCAL_USER/.cache/uv";
const UV_NATIVE_DEFAULT_TIMEOUT_MS = 15_000;
const UV_NATIVE_DEFAULT_LOCK_TIMEOUT_SECONDS = 2;
const DIRECTORY_MANIFEST_VERSION = "weekly-cache-cleanup-dir-manifest/v1";
const DIGEST_CHUNK_BYTES = 1024 * 1024;
const RECOVERY_KINDS = ["regenerable_cache", "restorable_artifact"] as const;
const PLACEHOLDER_RECOVERY_VALUES = new Set(["", "-", "cache", "caches", "none", "n/a", "na", "null", "tbd", "todo", "unknown"]);
const OWNER_CONTRACT_SCHEMA = "storage-retention-contract/v1";
const SHA256_HEX = /^[0-9a-f]{64}$/u;
/** Legacy default: the ad-adjust archive contract packs its members under a fixed `decision/` root. */
const DEFAULT_ARCHIVE_MEMBER_PREFIX = "decision/";
/** Hard floor for the deleted-session state gate. A contract cannot configure its way below it. */
const DELETED_SESSION_MIN_RETENTION_DAYS = 30;
/** Bound on the in-candidate protection walk; exceeding it fail-closes instead of sweeping blind. */
const SUBTREE_PROTECTION_MAX_DEPTH = 64;

/**
 * Config-independent hard gate. No rule, gate or owner contract can delete a path that is equal to
 * or below one of these roots, and no config edit can switch it off. Every entry is an asset whose
 * loss is either unrecoverable or breaks a live process.
 */
const NEVER_SWEEP_ROOTS = [
  // Heartbeat: sole recovery index for the R26 production deletion, plus the canonical bodies its
  // pointers dereference. T004 declares these as permanent never-sweep.
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/data/history-manifests/production-20260820",
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/data/history-canonical",
  // Pointer-referenced Codex rollout transcripts. The transcript rule is permanently safety-blocked
  // after a directory-mtime selector deleted active threads; this makes that decision mechanical.
  "/Users/LOCAL_USER/.codex/sessions",
  // Active git worktrees (LGS + Mr Beast). Their contents exist nowhere else until they land.
  "/Users/LOCAL_USER/SuperMatrixRuntime/worktrees",
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/mr-beast/.worktrees",
  // Chrome on-device model weights: one copy per version, re-download is not guaranteed.
  "/Users/LOCAL_USER/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel",
  "/Users/LOCAL_USER/Library/Application Support/Google/Chrome/OptGuideOnDeviceClassifierModel",
  "/Users/LOCAL_USER/Library/Application Support/Google/Chrome/optimization_guide_model_store",
];

/**
 * Git stores are protected by proving the `.git` ancestor is a real repository on disk, not by
 * matching the name. Cache mirrors that replicate a source path (the Apple Python bytecode cache
 * mirrors absolute paths, `.git` segments included) therefore stay sweepable.
 */
function gitStorePathReason(gitPath: string): string | null {
  const st = safeLstat(gitPath);
  if (!st) return null;
  // A worktree/submodule uses a `.git` file pointing at the real store; both are protected.
  if (st.isFile() || safeLstat(join(gitPath, "objects")) !== null || safeLstat(join(gitPath, "HEAD")) !== null) {
    return `never-sweep-git-store:${gitPath}`;
  }
  return null;
}

function gitStoreReason(path: string): string | null {
  const parts = resolve(path).split("/");
  for (const [index, part] of parts.entries()) {
    if (part !== ".git") continue;
    const reason = gitStorePathReason(parts.slice(0, index + 1).join("/"));
    if (reason) return reason;
  }
  return null;
}

/** Live runtime databases. Deleting one of these or its sidecar corrupts a running process. */
const NEVER_SWEEP_LIVE_DATABASES = [
  "/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db",
  "/Users/LOCAL_USER/SuperMatrixRuntime/data/scheduler.db",
  "/Users/LOCAL_USER/SuperMatrixRuntime/data/scheduler-v2.db",
  "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/data/heartbeat.sqlite",
  "/Users/LOCAL_USER/.codex/state_5.sqlite",
  "/Users/LOCAL_USER/.codex/logs_2.sqlite",
  "/Users/LOCAL_USER/amzdata/amz_sql.db",
  "/Users/LOCAL_USER/CodexSkills/amz-sql/productdata-raw/dashenlin/dashenlin_raw.db",
];
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

type CleanupAction = "delete_children_older_than" | "delete_named_descendants_older_than" | "delete_matching_files_older_than" | "delete_owner_contract_candidates" | "uv_cache_prune";

export type NativeUvCleanup = {
  kind: "uv-cache-prune";
  executable: string;
  expectedVersion: string;
  timeoutMs?: number;
  lockTimeoutMs?: number;
};

/**
 * Points a rule at one owner-approved storage-retention-contract/v1 and pins its exact bytes.
 * The contract, not the filesystem, is the candidate list: nothing is scanned, walked or matched by
 * name, so the rule can never widen. Editing or regenerating the contract changes its digest and
 * fail-closes the whole rule.
 */
export type OwnerContractSelector = {
  path: string;
  sha256: string;
  owner: string;
  taskId: string;
  recoveryMode: "retained-hash-peer" | "verified-archive-manifest" | "skill-master-snapshot-generation" | "per-candidate-recovery-probe";
  cohortField?: string;
  cohortValue?: string;
  /**
   * Set when the owner receipt is a rich-info wrapper around a separately published candidate
   * manifest. The referenced manifest is digest-pinned too and every candidate fact
   * (path, bytes, sha256) must agree item by item, or the rule fail-closes.
   */
  crossCheck?: { path: string; sha256: string };
  /**
   * Required by recoveryMode verified-archive-manifest only. The in-archive directory the manifest
   * members are packed under, as a relative, in-tree, slash-terminated prefix. Absent means the
   * legacy ad-adjust default `decision/`, so already-pinned contracts keep working unchanged.
   * Absolute prefixes, `..`, `.` and empty segments are rejected at config load, and the engine
   * additionally refuses an archive that extracts anything outside the declared prefix.
   */
  archiveMemberPrefix?: string;
  /**
   * Optional runtime state gate for workspace candidates whose deletion is only safe once every
   * session bound to the same physical directory is gone. Evaluated against the runtime database on
   * every pass -- scan and both pre-delete revalidations -- and folded into the candidate evidence,
   * so any drift in the sessions rows fail-closes the delete.
   */
  deletedSessionGate?: DeletedSessionGate;
  snapshotVerification?: SnapshotVerification;
  /**
   * Required by recoveryMode per-candidate-recovery-probe: a read-only, owner-published verify
   * probe the engine re-runs per candidate at scan and in both pre-delete revalidation passes.
   * `{path}` and `{sha256}` substitute the candidate's declared absolute path and contract digest;
   * any non-passing probe fail-closes that candidate and keeps it.
   */
  recoveryProbe?: ControlledProbe;
};

export type DeletedSessionGate = {
  runtimeDbPath: string;
  /** Days the latest retention clock must clear. Config cannot go below the 30-day hard floor. */
  minRetentionDays: number;
};

export type ControlledProbe = {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  stdout?: "capture" | "discard";
  stdoutIncludes?: string[];
  stdoutJson?: {
    requiredKeys: string[];
    equals: Record<string, string | number | boolean | null>;
  };
};

export type SnapshotVerification = {
  requiredRootKeys: string[];
  tarProbe: ControlledProbe;
  restoreDryRunProbe: ControlledProbe;
  verifyCurrentProbe: ControlledProbe;
};

export type CleanupGate = {
  kind: "snapshot-manifest" | "sha256-authoritative";
  manifestName?: string;
  requiredReason?: string;
  snapshotIdMatchesBasename?: boolean;
  requiredRootKeys?: string[];
  requireArchiveResultExists?: boolean;
  tarProbe?: ControlledProbe;
  restoreDryRunProbe?: ControlledProbe;
  verifyCurrentProbe?: ControlledProbe;
  authoritativePaths?: string[];
};

export type RetentionPolicy = {
  retainNewest: number;
  groupBy: "parent";
  order: "mtime-desc-path-asc" | "manifest-created-at-desc-path-asc";
};

export type RecoveryContract = {
  kind: (typeof RECOVERY_KINDS)[number];
  producer: string;
  key: string;
  version: string;
  probe: string;
};

export type CleanupRule = {
  id: string;
  recovery?: RecoveryContract;
  owner: string;
  enabled: boolean;
  action: CleanupAction;
  paths: string[];
  retentionDays: number;
  safetyState?: "blocked";
  description?: string;
  includeBasenamePrefixes?: string[];
  names?: string[];
  maxDepth?: number;
  excludeBasenames?: string[];
  protectedBasenames?: string[];
  exactBasenames?: string[];
  matchBasenamePrefixes?: string[];
  suffixes?: string[];
  retention?: RetentionPolicy;
  gate?: CleanupGate;
  contract?: OwnerContractSelector;
  native?: NativeUvCleanup;
};

export type CleanupConfig = {
  version: number;
  safeRoots: string[];
  maxDeleteBytes?: number;
  codexStateDbPath?: string | null;
  rules: CleanupRule[];
};

export type NativeUvCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

export type NativeUvRootObservation = {
  exists: boolean;
  realpath: string | null;
  logicalBytes: number;
  entries: number;
  freeBytes: number | null;
};

export type NativeUvPruneReceipt = {
  ruleId: string;
  root: string;
  mode: "dry-run" | "apply";
  executable: string;
  executableRealpath: string | null;
  expectedVersion: string;
  actualVersion?: string;
  argv: string[];
  command: string;
  timeoutMs: number;
  lockTimeoutSeconds: number;
  lockStatus: "not-run" | "not-needed" | "acquired" | "blocked" | "failed";
  mutationAttempted: boolean;
  mutationOutcome: "not-started" | "verified" | "unverified";
  deletionVerified: boolean;
  nativePotentialDeletion: "unknown" | "not-run";
  nativePotentialDeletionIsNotLegacySelector: true;
  logicalBytesRemoved: number | null;
  removedEntries: number | null;
  physicalFreeBytesDelta: number | null;
  readbackStatus: "not-run" | "verified" | "ambiguous-concurrent-growth" | "failed";
  rootReadback: NativeUvRootObservation | null;
  before?: NativeUvRootObservation;
  after?: NativeUvRootObservation;
  exitCode: number | null;
  signal: string | null;
  stdoutPreview: string;
  stderrPreview: string;
  error?: string;
  failureReason?: string;
  auditSidecar?: string;
};

export type NativeUvCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => NativeUvCommandResult;

export type NativeUvRootObserver = (root: string) => NativeUvRootObservation;

export type CleanupCandidate = {
  ruleId: string;
  owner: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  retentionTimeMs: number;
  scanEvidence?: ScanEvidence;
};

type Fingerprint = {
  path: string;
  realpath: string;
  sha256: string;
};

type ProbeEvidence = {
  command: string;
  ok: boolean;
  fingerprint: string;
  detail?: string;
  stdoutJson?: Record<string, unknown>;
};

export type ScanEvidence = {
  scannedAtMs: number;
  selector: {
    basename: string;
    realpath: string;
    retentionEligible: boolean;
    retentionTimeMs: number;
  };
  candidate: Fingerprint;
  source?: Fingerprint;
  gate?: {
    kind: CleanupGate["kind"];
    fingerprint: string;
    manifest?: Fingerprint & { createdAtMs: number };
    archives?: Fingerprint[];
    probes?: ProbeEvidence[];
  };
  retention?: {
    rank: number;
    floorPaths: string[];
    retainedAnchors?: Array<{ candidate: Fingerprint; probes?: ProbeEvidence[] }>;
  };
  contract?: ContractCandidateEvidence;
};

/**
 * Everything the contract gate re-derived from disk for one candidate. It is embedded in
 * ScanEvidence, so the existing pre-delete comparison re-runs the whole gate and refuses the delete
 * if the contract, the candidate bytes or the recovery source moved between scan and rmSync.
 */
export type DeletedSessionEvidence = {
  runtimeDbPath: string;
  minRetentionDays: number;
  candidateRealpath: string;
  declaredSessionIds: string[];
  rows: Array<{ id: string; name: string; status: string; workdir: string; workdirRealpath: string; updatedAtMs: number }>;
  latestRetentionClockMs: number;
  retentionDaysElapsed: number;
};

export type ContractCandidateEvidence = {
  taskId: string;
  contract: Fingerprint;
  crossCheck?: Fingerprint;
  declaredBytes: number;
  declaredSha256: string;
  recoveryMode: OwnerContractSelector["recoveryMode"];
  recovery: Fingerprint;
  recoveryManifest?: Fingerprint;
  recoveryDetail: Record<string, unknown>;
  deletedSession?: DeletedSessionEvidence;
  fingerprint: string;
};

export type TargetDigest = {
  algorithm: "sha256";
  kind: "file" | "symlink" | "directory-manifest";
  value: string;
  entries: number;
  bytes: number;
  manifestVersion?: string;
};

export type DeletionAuditRecord = {
  ruleId: string;
  owner: string;
  path: string;
  preDelete: {
    capturedAtMs: number;
    bytes: number;
    digest: TargetDigest;
    realpath: string;
    scanEvidence: ScanEvidence;
    recovery: RecoveryContract;
    codexStateArchivedThreadIds?: string[];
  };
  deleteResult: { attempted: boolean; ok: boolean; error?: string };
  postDelete: { checkedAtMs: number; exists: boolean };
};

export type CleanupAuditSummary = {
  mode: "dry-run" | "apply";
  digestAlgorithm: "sha256";
  directoryManifestVersion: string;
  digestsCaptured: number;
  deletionsAttempted: number;
  deletionsSucceeded: number;
  postDeleteVerifiedAbsent: number;
  failures: number;
  recoveryGatedCandidates: number;
  note: string;
};

/**
 * Wall-clock cost of each phase of one run, in the same receipt that reports its results. The 04:10
 * apply lost its terminal receipt because the run outgrew the scheduler timeout mid-apply, and the
 * only surviving artefact was the audit sidecar; with these numbers the phase that grew is readable
 * straight off the receipt instead of being inferred from sidecar timestamps.
 */
export type CleanupStageTimings = {
  scanMs: number;
  recoveryGateMs: number;
  retentionFloorMs: number;
  retentionProbeMs: number;
  applyMs: number;
  totalMs: number;
  perRuleScanMs: Record<string, number>;
};

export type CleanupSummary = {
  mode: "dry-run" | "apply";
  configPath: string;
  stageTimingsMs: CleanupStageTimings;
  auditChainSidecar?: string;
  candidates: CleanupCandidate[];
  deleted: CleanupCandidate[];
  codexStateArchives?: Array<{ path: string; archivedThreadIds: string[] }>;
  skipped: Array<{ ruleId: string; path: string; reason: string; detail?: string }>;
  auditChain: DeletionAuditRecord[];
  deleteFailures: Array<{ ruleId: string; path: string; phase: "delete" | "post-delete-readback" | "audit-sidecar"; error: string }>;
  audit: CleanupAuditSummary;
  totalCandidateBytes: number;
  totalDeletedBytes: number;
  totalNativeDeletedBytes: number;
  nativeUvPrunes?: NativeUvPruneReceipt[];
  impactReview?: ImpactReviewSummary;
  completionNotify?: CompletionNotifyResult;
  probeResults?: Array<{
    ruleId: string;
    path: string;
    phase: "candidate" | "retention-anchor";
    probe: string;
    ok: boolean;
    detail?: string;
  }>;
};

export type CompletionNotifyResult = {
  attempted: boolean;
  reason?: string;
  level?: "info" | "warn";
  freeBytes?: number | null;
  ok?: boolean;
  status?: number;
  responsePreview?: string;
  rebootRecommended?: boolean;
};

export type ImpactReviewDispatch = {
  sourceReceipt: string;
  owner: string;
  clientRequestId: string;
  deletedCount: number;
  deletedBytes: number;
  ruleIds: string[];
  currentConfigPath: string;
  currentRuleStates: ImpactReviewRuleState[];
  samplePaths: string[];
  ok: boolean;
  status: number;
  responsePreview: string;
  markerPath?: string;
  notify?: {
    ok: boolean;
    status: number;
    responsePreview: string;
  };
};

export type ImpactReviewRuleState = {
  ruleId: string;
  status: "enabled" | "disabled" | "missing" | "unknown";
  safetyState?: "blocked";
};

export type ImpactReviewSummary = {
  consideredReceipts: number;
  requestedOwners: number;
  succeededOwners: number;
  failedOwners: number;
  skippedOwners: number;
  dispatches: ImpactReviewDispatch[];
};

type CliOptions = {
  apply: boolean;
  json: boolean;
  configPath: string;
  receiptDir: string;
  apiBase: string;
  impactReviewMinAgeDays: number;
  skipImpactReview: boolean;
  nowMs: number;
};

type PostJsonResult = {
  ok: boolean;
  status: number;
  text: string;
};

type PostJson = (url: string, body: unknown, timeoutMs: number) => Promise<PostJsonResult>;

function defaultConfigPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "weekly-cache-cleanup.config.json");
}

export function resolveApiBase(env: Record<string, string | undefined>): string {
  const explicit = env.SM_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/$/u, "");
  const port = env.SM_API_PORT?.trim() || DEFAULT_API_PORT;
  return `http://localhost:${port}`;
}

function parseArgs(argv: string[]): CliOptions {
  let apply = false;
  let json = false;
  let configPath = defaultConfigPath();
  let receiptDir = process.env.SM_WEEKLY_CACHE_CLEANUP_RECEIPT_DIR ?? "/Users/LOCAL_USER/SuperMatrixRuntime/data/weekly-cache-cleanup";
  let apiBase = resolveApiBase(process.env);
  let impactReviewMinAgeDays = Number(process.env.SM_WEEKLY_CACHE_CLEANUP_IMPACT_REVIEW_MIN_AGE_DAYS ?? DEFAULT_IMPACT_REVIEW_MIN_AGE_DAYS);
  let skipImpactReview = false;
  let nowMs = Date.now();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--config") {
      const next = argv[i + 1];
      if (!next) throw new Error("--config requires a path");
      configPath = resolve(next);
      i += 1;
    } else if (arg === "--receipt-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--receipt-dir requires a path");
      receiptDir = resolve(next);
      i += 1;
    } else if (arg === "--now-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error("--now-ms requires a timestamp");
      nowMs = Number(next);
      if (!Number.isFinite(nowMs)) throw new Error("--now-ms must be numeric");
      i += 1;
    } else if (arg === "--api-base") {
      const next = argv[i + 1];
      if (!next) throw new Error("--api-base requires a URL");
      apiBase = next.replace(/\/$/u, "");
      i += 1;
    } else if (arg === "--impact-review-min-age-days") {
      const next = argv[i + 1];
      if (!next) throw new Error("--impact-review-min-age-days requires a number");
      impactReviewMinAgeDays = Number(next);
      if (!Number.isFinite(impactReviewMinAgeDays) || impactReviewMinAgeDays < 0) {
        throw new Error("--impact-review-min-age-days must be a non-negative number");
      }
      i += 1;
    } else if (arg === "--skip-impact-review") {
      skipImpactReview = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(impactReviewMinAgeDays) || impactReviewMinAgeDays < 0) {
    throw new Error("SM_WEEKLY_CACHE_CLEANUP_IMPACT_REVIEW_MIN_AGE_DAYS must be a non-negative number");
  }

  return { apply, json, configPath, receiptDir, apiBase, impactReviewMinAgeDays, skipImpactReview, nowMs };
}

const CONTROLLED_PROBE_PLACEHOLDERS = new Set(["{path}", "{basename}", "{snapshotId}", "{archivePath}", "{sha256}"]);
const CONTROLLED_PROBE_KEYS = new Set(["executable", "args", "cwd", "timeoutMs", "stdout", "stdoutIncludes", "stdoutJson"]);
const CONFIG_KEYS = new Set(["version", "safeRoots", "maxDeleteBytes", "codexStateDbPath", "rules"]);
const RULE_KEYS = new Set([
  "id", "recovery", "owner", "enabled", "action", "paths", "retentionDays", "safetyState", "description",
  "includeBasenamePrefixes", "names", "maxDepth", "excludeBasenames", "protectedBasenames", "exactBasenames",
  "matchBasenamePrefixes", "suffixes", "retention", "gate", "contract", "native",
]);
const NATIVE_KEYS = new Set(["kind", "executable", "expectedVersion", "timeoutMs", "lockTimeoutMs"]);
const CONTRACT_KEYS = new Set(["path", "sha256", "owner", "taskId", "recoveryMode", "cohortField", "cohortValue", "crossCheck", "archiveMemberPrefix", "deletedSessionGate", "snapshotVerification", "recoveryProbe"]);
const CONTRACT_RECOVERY_MODES = new Set(["retained-hash-peer", "verified-archive-manifest", "skill-master-snapshot-generation", "per-candidate-recovery-probe"]);
const RECOVERY_KEYS = new Set(["kind", "producer", "key", "version", "probe"]);
const SNAPSHOT_GATE_KEYS = new Set([
  "kind", "manifestName", "requiredReason", "snapshotIdMatchesBasename", "requiredRootKeys",
  "requireArchiveResultExists", "tarProbe", "restoreDryRunProbe", "verifyCurrentProbe",
]);
const SHA_GATE_KEYS = new Set(["kind", "authoritativePaths"]);

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

function assertAllowedKeys(value: object, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is unknown`);
  }
}

function assertStaticAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    throw new Error(`${label} must be an absolute static path`);
  }
}

function validateNativeUvCleanup(value: unknown, label: string): NativeUvCleanup {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, NATIVE_KEYS, label);
  const native = value as Partial<NativeUvCleanup>;
  if (native.kind !== "uv-cache-prune") throw new Error(`${label}.kind must be uv-cache-prune`);
  assertString(native.executable, `${label}.executable`);
  assertStaticAbsolutePath(native.executable, `${label}.executable`);
  if (!/^\d+\.\d+\.\d+$/u.test(native.expectedVersion ?? "")) throw new Error(`${label}.expectedVersion must be a semantic version`);
  if (native.timeoutMs !== undefined && (!Number.isInteger(native.timeoutMs) || native.timeoutMs < 1 || native.timeoutMs > 60_000)) {
    throw new Error(`${label}.timeoutMs must be an integer from 1 to 60000`);
  }
  if (native.lockTimeoutMs !== undefined && (!Number.isInteger(native.lockTimeoutMs) || native.lockTimeoutMs < 1 || native.lockTimeoutMs > 30_000)) {
    throw new Error(`${label}.lockTimeoutMs must be an integer from 1 to 30000`);
  }
  return native as NativeUvCleanup;
}

function assertProbePlaceholders(value: string, label: string): void {
  const tokens = value.match(/\{[A-Za-z][^{}]*\}|\{[A-Za-z][^{}]*$/gu) ?? [];
  for (const token of tokens) {
    if (!CONTROLLED_PROBE_PLACEHOLDERS.has(token)) throw new Error(`${label} contains an unsupported placeholder or unclosed placeholder: ${token}`);
  }
}

function validateControlledProbe(value: unknown, label: string): ControlledProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, CONTROLLED_PROBE_KEYS, label);
  const probe = value as Partial<ControlledProbe>;
  assertString(probe.executable, `${label}.executable`);
  assertStaticAbsolutePath(probe.executable, `${label}.executable`);
  assertProbePlaceholders(probe.executable, `${label}.executable`);
  if (!Array.isArray(probe.args) || probe.args.some((arg) => typeof arg !== "string")) throw new Error(`${label}.args must be string[]`);
  probe.args.forEach((arg, index) => assertProbePlaceholders(arg, `${label}.args[${index}]`));
  if (probe.cwd !== undefined) {
    assertString(probe.cwd, `${label}.cwd`);
    assertStaticAbsolutePath(probe.cwd, `${label}.cwd`);
    assertProbePlaceholders(probe.cwd, `${label}.cwd`);
  }
  if (probe.timeoutMs !== undefined && (!Number.isInteger(probe.timeoutMs) || probe.timeoutMs <= 0)) {
    throw new Error(`${label}.timeoutMs must be a positive integer`);
  }
  if (probe.stdout !== undefined && probe.stdout !== "capture" && probe.stdout !== "discard") {
    throw new Error(`${label}.stdout must be capture or discard`);
  }
  if (probe.stdoutIncludes !== undefined && (!Array.isArray(probe.stdoutIncludes) || probe.stdoutIncludes.length === 0 || probe.stdoutIncludes.some((item) => typeof item !== "string" || item === ""))) {
    throw new Error(`${label}.stdoutIncludes must be a non-empty string[]`);
  }
  if (probe.stdoutIncludes !== undefined && probe.stdout === "discard") throw new Error(`${label}.stdoutIncludes cannot use discarded stdout`);
  if (probe.stdoutJson !== undefined) {
    if (!probe.stdoutJson || typeof probe.stdoutJson !== "object" || Array.isArray(probe.stdoutJson)) throw new Error(`${label}.stdoutJson must be an object`);
    assertAllowedKeys(probe.stdoutJson, new Set(["requiredKeys", "equals"]), `${label}.stdoutJson`);
    if (!Array.isArray(probe.stdoutJson.requiredKeys) || probe.stdoutJson.requiredKeys.some((key) => typeof key !== "string" || key.trim() === "")) {
      throw new Error(`${label}.stdoutJson.requiredKeys must be string[]`);
    }
    if (!probe.stdoutJson.equals || typeof probe.stdoutJson.equals !== "object" || Array.isArray(probe.stdoutJson.equals)) throw new Error(`${label}.stdoutJson.equals must be an object`);
    for (const [key, expected] of Object.entries(probe.stdoutJson.equals)) {
      if (!probe.stdoutJson.requiredKeys.includes(key)) throw new Error(`${label}.stdoutJson.equals.${key} must be required`);
      if (!(["string", "number", "boolean"].includes(typeof expected) || expected === null)) throw new Error(`${label}.stdoutJson.equals.${key} has unsupported value`);
    }
    if (probe.stdout === "discard") throw new Error(`${label}.stdoutJson cannot use discarded stdout`);
  }
  return probe as ControlledProbe;
}

function validateSnapshotVerification(value: unknown, label: string): SnapshotVerification {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, new Set(["requiredRootKeys", "tarProbe", "restoreDryRunProbe", "verifyCurrentProbe"]), label);
  const verification = value as Partial<SnapshotVerification>;
  if (!Array.isArray(verification.requiredRootKeys) || verification.requiredRootKeys.length === 0 || verification.requiredRootKeys.some((key) => typeof key !== "string" || key === "") || new Set(verification.requiredRootKeys).size !== verification.requiredRootKeys.length) {
    throw new Error(`${label}.requiredRootKeys must be a non-empty unique string[]`);
  }
  validateControlledProbe(verification.tarProbe, `${label}.tarProbe`);
  validateControlledProbe(verification.restoreDryRunProbe, `${label}.restoreDryRunProbe`);
  validateControlledProbe(verification.verifyCurrentProbe, `${label}.verifyCurrentProbe`);
  if (!verification.verifyCurrentProbe?.stdoutJson || verification.verifyCurrentProbe.stdoutJson.equals.ok !== true || !verification.verifyCurrentProbe.stdoutJson.requiredKeys.includes("ok")) {
    throw new Error(`${label}.verifyCurrentProbe must assert JSON ok === true`);
  }
  return verification as SnapshotVerification;
}

function validateGate(value: unknown, label: string): CleanupGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const gate = value as CleanupGate;
  if (gate.kind !== "snapshot-manifest" && gate.kind !== "sha256-authoritative") throw new Error(`${label}.kind is unsupported`);
  if (gate.kind === "snapshot-manifest") {
    assertAllowedKeys(value, SNAPSHOT_GATE_KEYS, label);
    if (gate.manifestName !== "manifest.json") throw new Error(`${label}.manifestName must be manifest.json`);
    assertString(gate.requiredReason, `${label}.requiredReason`);
    if (gate.snapshotIdMatchesBasename !== true) throw new Error(`${label}.snapshotIdMatchesBasename must be true`);
    if (!Array.isArray(gate.requiredRootKeys) || gate.requiredRootKeys.length === 0 || gate.requiredRootKeys.some((key) => typeof key !== "string" || key.trim() === "")) {
      throw new Error(`${label}.requiredRootKeys must be a non-empty string[]`);
    }
    if (gate.requireArchiveResultExists !== true) throw new Error(`${label}.requireArchiveResultExists must be true`);
    validateControlledProbe(gate.tarProbe, `${label}.tarProbe`);
    validateControlledProbe(gate.restoreDryRunProbe, `${label}.restoreDryRunProbe`);
    validateControlledProbe(gate.verifyCurrentProbe, `${label}.verifyCurrentProbe`);
    if (!gate.verifyCurrentProbe?.stdoutJson || gate.verifyCurrentProbe.stdoutJson.equals.ok !== true || !gate.verifyCurrentProbe.stdoutJson.requiredKeys.includes("ok")) {
      throw new Error(`${label}.verifyCurrentProbe must assert JSON ok === true`);
    }
  } else {
    assertAllowedKeys(value, SHA_GATE_KEYS, label);
    if (!Array.isArray(gate.authoritativePaths) || gate.authoritativePaths.length === 0 || gate.authoritativePaths.some((path) => typeof path !== "string" || !isAbsolute(path))) {
      throw new Error(`${label}.authoritativePaths must be a non-empty absolute string[]`);
    }
    for (const [index, path] of gate.authoritativePaths.entries()) {
      if (path.includes("{") || path.includes("}")) {
        if (!path.includes("{basename}")) throw new Error(`${label}.authoritativePaths[${index}] only allows {basename}`);
        const remaining = path.replace("{basename}", "");
        if ((path.match(/\{basename\}/gu) ?? []).length !== 1 || remaining.includes("{") || remaining.includes("}")) {
          throw new Error(`${label}.authoritativePaths[${index}] has an invalid placeholder`);
        }
      }
      assertStaticAbsolutePath(path.replace("{basename}", "placeholder"), `${label}.authoritativePaths[${index}]`);
    }
  }
  return gate;
}

/**
 * An archive member prefix names a directory inside the tarball, nothing else. Anything that could
 * escape the extraction root -- an absolute path, `..`, `.`, an empty segment, a backslash, a
 * control character or a probe placeholder -- is rejected before the config is ever loaded.
 */
function assertArchiveMemberPrefix(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (isAbsolute(value) || value.startsWith("/")) throw new Error(`${label} must be a relative in-archive prefix`);
  if (!value.endsWith("/")) throw new Error(`${label} must end with /`);
  if (/[\u0000-\u001f\\{}]/u.test(value)) throw new Error(`${label} contains an unsupported character`);
  const segments = value.slice(0, -1).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a non-empty in-tree path without . or .. segments`);
  }
}

function validateDeletedSessionGate(value: unknown, label: string): DeletedSessionGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, new Set(["runtimeDbPath", "minRetentionDays"]), label);
  const gate = value as Partial<DeletedSessionGate>;
  assertString(gate.runtimeDbPath, `${label}.runtimeDbPath`);
  assertStaticAbsolutePath(gate.runtimeDbPath, `${label}.runtimeDbPath`);
  if (!Number.isInteger(gate.minRetentionDays) || (gate.minRetentionDays as number) < DELETED_SESSION_MIN_RETENTION_DAYS) {
    throw new Error(`${label}.minRetentionDays must be an integer of at least ${DELETED_SESSION_MIN_RETENTION_DAYS}`);
  }
  return gate as DeletedSessionGate;
}

function assertSha256Hex(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new Error(`${label} must be a lowercase 64-hex sha256`);
}

function validateOwnerContractSelector(value: unknown, label: string): OwnerContractSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  assertAllowedKeys(value, CONTRACT_KEYS, label);
  const selector = value as Partial<OwnerContractSelector>;
  for (const field of ["path", "owner", "taskId"] as const) assertString(selector[field], `${label}.${field}`);
  assertStaticAbsolutePath(selector.path!, `${label}.path`);
  assertSha256Hex(selector.sha256, `${label}.sha256`);
  if (!CONTRACT_RECOVERY_MODES.has(selector.recoveryMode as string)) {
    throw new Error(`${label}.recoveryMode must be one of ${[...CONTRACT_RECOVERY_MODES].join("|")}`);
  }
  if ((selector.cohortField === undefined) !== (selector.cohortValue === undefined)) {
    throw new Error(`${label}.cohortField and ${label}.cohortValue must be set together`);
  }
  if (selector.cohortField !== undefined) {
    assertString(selector.cohortField, `${label}.cohortField`);
    assertString(selector.cohortValue, `${label}.cohortValue`);
  }
  if (selector.crossCheck !== undefined) {
    if (!selector.crossCheck || typeof selector.crossCheck !== "object" || Array.isArray(selector.crossCheck)) throw new Error(`${label}.crossCheck must be an object`);
    assertAllowedKeys(selector.crossCheck, new Set(["path", "sha256"]), `${label}.crossCheck`);
    assertString(selector.crossCheck.path, `${label}.crossCheck.path`);
    assertStaticAbsolutePath(selector.crossCheck.path, `${label}.crossCheck.path`);
    assertSha256Hex(selector.crossCheck.sha256, `${label}.crossCheck.sha256`);
  }
  if (selector.archiveMemberPrefix !== undefined) {
    if (selector.recoveryMode !== "verified-archive-manifest") throw new Error(`${label}.archiveMemberPrefix only applies to verified-archive-manifest`);
    assertArchiveMemberPrefix(selector.archiveMemberPrefix, `${label}.archiveMemberPrefix`);
  }
  if (selector.deletedSessionGate !== undefined) {
    selector.deletedSessionGate = validateDeletedSessionGate(selector.deletedSessionGate, `${label}.deletedSessionGate`);
  }
  if (selector.recoveryMode === "skill-master-snapshot-generation") {
    if (!selector.crossCheck) throw new Error(`${label}.crossCheck is required by skill-master-snapshot-generation`);
    selector.snapshotVerification = validateSnapshotVerification(selector.snapshotVerification, `${label}.snapshotVerification`);
  } else if (selector.snapshotVerification !== undefined) {
    throw new Error(`${label}.snapshotVerification only applies to skill-master-snapshot-generation`);
  }
  if (selector.recoveryMode === "per-candidate-recovery-probe") {
    selector.recoveryProbe = validateControlledProbe(selector.recoveryProbe, `${label}.recoveryProbe`);
  } else if (selector.recoveryProbe !== undefined) {
    throw new Error(`${label}.recoveryProbe only applies to per-candidate-recovery-probe`);
  }
  return selector as OwnerContractSelector;
}

export function validateConfig(value: unknown): CleanupConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
  assertAllowedKeys(value, CONFIG_KEYS, "config");
  const config = value as Partial<CleanupConfig>;
  if (config.version !== 1) throw new Error(`unsupported config version: ${config.version}`);
  if (!Array.isArray(config.safeRoots) || config.safeRoots.length === 0 || config.safeRoots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    throw new Error("safeRoots must be a non-empty absolute string[]");
  }
  if (config.maxDeleteBytes !== undefined && (!Number.isFinite(config.maxDeleteBytes) || config.maxDeleteBytes < 0)) throw new Error("maxDeleteBytes must be non-negative");
  if (!Array.isArray(config.rules)) throw new Error("rules must be an array");
  const ids = new Set<string>();
  for (const [index, rawRule] of config.rules.entries()) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) throw new Error(`rules[${index}] must be an object`);
    assertAllowedKeys(rawRule, RULE_KEYS, `rules[${index}]`);
    const rule = rawRule as CleanupRule;
    for (const field of ["id", "owner"] as const) assertString(rule[field], `rules[${index}].${field}`);
    if (ids.has(rule.id)) throw new Error(`duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
    if (typeof rule.enabled !== "boolean") throw new Error(`rules[${index}].enabled must be boolean`);
    if (rule.action !== "delete_children_older_than" && rule.action !== "delete_named_descendants_older_than" && rule.action !== "delete_matching_files_older_than" && rule.action !== "delete_owner_contract_candidates" && rule.action !== "uv_cache_prune") throw new Error(`rules[${index}].action is unsupported`);
    if (!Array.isArray(rule.paths) || rule.paths.length === 0 || rule.paths.some((path) => typeof path !== "string" || !isAbsolute(path))) throw new Error(`rules[${index}].paths must be a non-empty absolute string[]`);
    if (!Number.isFinite(rule.retentionDays) || rule.retentionDays < 0) throw new Error(`rules[${index}].retentionDays must be non-negative`);
    if (rule.action === "uv_cache_prune") {
      if (config.maxDeleteBytes === undefined) throw new Error("config.maxDeleteBytes is required by uv_cache_prune");
      if (rule.paths.length !== 1 || resolve(rule.paths[0]!) !== UV_CACHE_ROOT) throw new Error(`rules[${index}].paths must contain the exact uv cache root`);
      validateNativeUvCleanup(rule.native, `rules[${index}].native`);
      for (const field of ["recovery", "retention", "gate", "contract", "includeBasenamePrefixes", "names", "maxDepth", "excludeBasenames", "protectedBasenames", "exactBasenames", "matchBasenamePrefixes", "suffixes"] as const) {
        if (rule[field] !== undefined) throw new Error(`rules[${index}].${field} does not apply to uv_cache_prune`);
      }
    } else if (rule.native !== undefined) {
      throw new Error(`rules[${index}].native only applies to uv_cache_prune`);
    }
    if (rule.retention !== undefined) {
      if (!rule.retention || typeof rule.retention !== "object" || Array.isArray(rule.retention) || Object.keys(rule.retention).some((key) => !["retainNewest", "groupBy", "order"].includes(key)) || rule.retention.groupBy !== "parent" || !["mtime-desc-path-asc", "manifest-created-at-desc-path-asc"].includes(rule.retention.order) || !Number.isInteger(rule.retention.retainNewest) || rule.retention.retainNewest < 1) {
        throw new Error(`rules[${index}].retention is invalid`);
      }
    }
    for (const field of ["excludeBasenames", "protectedBasenames", "exactBasenames", "matchBasenamePrefixes", "includeBasenamePrefixes", "names", "suffixes"] as const) {
      if (rule[field] !== undefined && (!Array.isArray(rule[field]) || rule[field]!.some((item) => typeof item !== "string" || item === ""))) throw new Error(`rules[${index}].${field} must be string[]`);
    }
    if (rule.recovery !== undefined) {
      if (!rule.recovery || typeof rule.recovery !== "object" || Array.isArray(rule.recovery)) throw new Error(`rules[${index}].recovery must be an object`);
      assertAllowedKeys(rule.recovery, RECOVERY_KEYS, `rules[${index}].recovery`);
    }
    if (rule.action === "delete_children_older_than" && (rule.names !== undefined || rule.matchBasenamePrefixes !== undefined || rule.suffixes !== undefined || rule.maxDepth !== undefined)) {
      throw new Error(`rules[${index}] named-descendant fields do not apply to delete_children_older_than`);
    }
    if (rule.action === "delete_named_descendants_older_than" && (rule.includeBasenamePrefixes !== undefined || rule.exactBasenames !== undefined || rule.suffixes !== undefined || rule.gate !== undefined)) {
      throw new Error(`rules[${index}] child-selector/gate fields do not apply to delete_named_descendants_older_than`);
    }
    if (rule.action === "delete_matching_files_older_than") {
      if (!rule.suffixes || rule.suffixes.length === 0 || rule.suffixes.some((suffix) => !suffix.startsWith(".") || suffix.includes("/"))) {
        throw new Error(`rules[${index}].suffixes must be a non-empty dotted suffix list`);
      }
      if (rule.names !== undefined || rule.matchBasenamePrefixes !== undefined || rule.includeBasenamePrefixes !== undefined || rule.exactBasenames !== undefined || rule.gate !== undefined) {
        throw new Error(`rules[${index}] only suffixes/maxDepth apply to delete_matching_files_older_than`);
      }
    }
    if (rule.maxDepth !== undefined && (!Number.isInteger(rule.maxDepth) || rule.maxDepth < 1 || rule.maxDepth > 64)) {
      throw new Error(`rules[${index}].maxDepth must be an integer from 1 to 64`);
    }
    if (rule.action === "delete_owner_contract_candidates") {
      if (rule.contract === undefined) throw new Error(`rules[${index}].contract is required by delete_owner_contract_candidates`);
      const contract = validateOwnerContractSelector(rule.contract, `rules[${index}].contract`);
      if (contract.owner !== rule.owner) throw new Error(`rules[${index}].contract.owner must equal the rule owner`);
      for (const field of ["gate", "retention", "names", "matchBasenamePrefixes", "includeBasenamePrefixes", "exactBasenames", "suffixes", "maxDepth"] as const) {
        if (rule[field] !== undefined) throw new Error(`rules[${index}].${field} does not apply to delete_owner_contract_candidates`);
      }
      // The contract supplies the candidate list; rule.paths only bounds it.
      for (const path of rule.paths) assertStaticAbsolutePath(path, `rules[${index}].paths`);
    } else if (rule.contract !== undefined) {
      throw new Error(`rules[${index}].contract only applies to delete_owner_contract_candidates`);
    }
    if (rule.gate !== undefined) {
      if (rule.action !== "delete_children_older_than") throw new Error(`rules[${index}].gate only applies to delete_children_older_than`);
      validateGate(rule.gate, `rules[${index}].gate`);
      if (rule.gate.kind === "snapshot-manifest" && (!rule.retention || rule.retention.order !== "manifest-created-at-desc-path-asc")) {
        throw new Error(`rules[${index}] snapshot-manifest retention must order by manifest created_at`);
      }
    }
    if (rule.retention?.order === "manifest-created-at-desc-path-asc" && rule.gate?.kind !== "snapshot-manifest") {
      throw new Error(`rules[${index}] manifest-created-at retention requires a snapshot-manifest gate`);
    }
  }
  return config as CleanupConfig;
}

function loadConfig(configPath: string): CleanupConfig {
  try {
    return validateConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (err) {
    throw new Error(`invalid cleanup config: ${errorMessage(err)}`);
  }
}

function normalizeSafeRoots(config: CleanupConfig): string[] {
  return config.safeRoots.map((root) => resolve(root));
}

function realPathInside(path: string, root: string): boolean {
  try {
    const resolvedPath = realpathSync(path);
    const resolvedRoot = realpathSync(root);
    const rel = relative(resolvedRoot, resolvedPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function isInsideSafeRoot(path: string, safeRoots: string[]): boolean {
  return safeRoots.some((root) => realPathInside(path, root));
}

function effectivePathForComparison(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return resolve(real, ...suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function isEqualOrBelow(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The one gate every deletion target must clear, regardless of rule, gate or owner contract.
 * Returns the reason a path is protected, or null when it is sweepable. It is deliberately
 * evaluated on both the literal path and its realpath so a symlinked parent cannot route around it.
 */
export function neverSweepReason(path: string): string | null {
  const candidates = [resolve(path)];
  try {
    const real = realpathSync(path);
    if (!candidates.includes(real)) candidates.push(real);
  } catch {
    // An unresolvable path is checked literally; the caller still lstats it separately.
  }
  for (const target of candidates) {
    for (const root of NEVER_SWEEP_ROOTS) {
      if (isEqualOrBelow(target, root)) return `never-sweep-root:${root}`;
    }
    const gitReason = gitStoreReason(target);
    if (gitReason) return gitReason;
    for (const db of NEVER_SWEEP_LIVE_DATABASES) {
      if (target === db) return `never-sweep-live-database:${db}`;
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        if (target === `${db}${suffix}`) return `never-sweep-live-database:${db}${suffix}`;
      }
    }
    // Generic live-SQLite detection: a database with an open WAL/SHM sidecar, or a sidecar whose
    // database still exists. A cold .bak copy has neither, so backup-pruning rules are unaffected.
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      if (target.endsWith(suffix) && safeLstat(target.slice(0, -suffix.length)) !== null) {
        return `never-sweep-live-database-sidecar:${target}`;
      }
    }
    for (const suffix of ["-wal", "-shm"]) {
      if (safeLstat(`${target}${suffix}`) !== null) return `never-sweep-live-database:${target}`;
    }
    const inside = subtreeProtectionReason(target);
    if (inside) return inside;
  }
  return null;
}

/**
 * Config-independent hard gate for what lives *inside* a deletion target. The ancestor-based
 * `gitStoreReason` and the live-database lists above only describe the target and its parents, so a
 * candidate that is itself a repository root, hides a nested repository or a registered worktree, or
 * holds a paired SQLite database would otherwise be swept whole. This walks the candidate subtree
 * with dirents only -- no content reads -- and fail-closes on the first protected entry. It is
 * reached from `neverSweepReason`, so scan, dry-run and both pre-delete revalidations run it
 * identically and no rule, gate or owner contract can switch it off.
 */
function subtreeProtectionReason(root: string, depth = 0): string | null {
  const st = safeLstat(root);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
  if (depth > SUBTREE_PROTECTION_MAX_DEPTH) return `never-sweep-subtree-too-deep:${root}`;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (isVanishedPathError(err)) return null;
    return `never-sweep-unreadable-subtree:${root}`;
  }
  const names = new Set(entries.map((entry) => entry.name));
  // A bare repository carries no `.git` segment anywhere: it *is* the object store.
  if (depth === 0 && names.has("HEAD") && names.has("objects")) return `never-sweep-git-store:${root}`;
  if (names.has(".git")) {
    const reason = gitStorePathReason(join(root, ".git"));
    if (reason) return reason;
  }
  // A database with a live WAL/SHM/journal sidecar next to it, detected from the directory listing
  // alone. A cold backup has no sidecar, so backup-pruning rules are unaffected.
  for (const name of names) {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      if (name.length > suffix.length && name.endsWith(suffix) && names.has(name.slice(0, -suffix.length))) {
        return `never-sweep-live-database-inside-candidate:${join(root, name.slice(0, -suffix.length))}`;
      }
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const reason = subtreeProtectionReason(join(root, entry.name), depth + 1);
    if (reason) return reason;
  }
  return null;
}

function isVanishedPathError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (isVanishedPathError(err)) return null;
    throw err;
  }
}

function safeReaddir(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch (err) {
    if (isVanishedPathError(err)) return null;
    throw err;
  }
}

function entrySize(path: string): number {
  const st = safeLstat(path);
  if (!st) return 0;
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;

  let total = st.size;
  const children = safeReaddir(path);
  if (!children) return 0;
  for (const child of children) {
    total += entrySize(join(path, child));
  }
  return total;
}

function observeNativeUvRoot(root: string): NativeUvRootObservation {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("uv cache root is not a real directory");
  const realpath = realpathSync(root);
  let entries = 1;
  const count = (current: string): number => {
    const st = lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) return st.size;
    let bytes = st.size;
    for (const child of readdirSync(current)) {
      entries += 1;
      bytes += count(join(current, child));
    }
    return bytes;
  };
  return {
    exists: true,
    realpath,
    logicalBytes: count(root),
    entries,
    freeBytes: diskFreeBytes(root),
  };
}

function sameNativeUvObservation(a: NativeUvRootObservation, b: NativeUvRootObservation): boolean {
  return a.exists === b.exists
    && a.realpath === b.realpath
    && a.logicalBytes === b.logicalBytes
    && a.entries === b.entries
    && a.freeBytes === b.freeBytes;
}

function basenameAllowed(name: string, rule: CleanupRule): boolean {
  if (rule.excludeBasenames?.includes(name)) return false;
  if (rule.exactBasenames && !rule.exactBasenames.includes(name)) return false;
  const prefixes = rule.includeBasenamePrefixes;
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

type SnapshotGateInfo = {
  archivePaths: string[];
  manifest: Fingerprint & { createdAtMs: number };
  archives: Fingerprint[];
};

type GateCheck = {
  ok: true;
  info?: SnapshotGateInfo;
  source?: Fingerprint;
  contract?: ContractCandidateEvidence;
  fingerprint: string;
} | {
  ok: false;
  reason: string;
  detail?: string;
};

function probeCommandLabel(probe: ControlledProbe): string {
  return [probe.executable, ...probe.args].join(" ");
}

function materializeProbe(probe: ControlledProbe, values: Record<string, string>): ControlledProbe {
  const substitute = (value: string): string => value.replace(/\{(?:path|basename|snapshotId|archivePath|sha256)\}/gu, (token) => values[token.slice(1, -1)] ?? token);
  return {
    executable: probe.executable,
    args: probe.args.map(substitute),
    ...(probe.cwd === undefined ? {} : { cwd: substitute(probe.cwd) }),
    ...(probe.timeoutMs === undefined ? {} : { timeoutMs: probe.timeoutMs }),
    ...(probe.stdout === undefined ? {} : { stdout: probe.stdout }),
    ...(probe.stdoutIncludes === undefined ? {} : { stdoutIncludes: probe.stdoutIncludes.map(substitute) }),
    ...(probe.stdoutJson === undefined ? {} : { stdoutJson: probe.stdoutJson }),
  };
}

function runControlledProbe(probe: ControlledProbe, values: Record<string, string>): ProbeEvidence {
  const materialized = materializeProbe(probe, values);
  const captureStdout = materialized.stdout !== "discard";
  const result = spawnSync(materialized.executable, materialized.args, {
    cwd: materialized.cwd,
    timeout: materialized.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const output = stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
  const command = probeCommandLabel(materialized);
  const base = `${command}\u0000${stdout}\u0000${stderr}\u0000${result.status ?? "null"}\u0000${result.signal ?? ""}`;
  const failureDetail = (prefix: string): string => `${prefix}${output ? `: ${output}` : ""}`;
  if (result.error) {
    const code = "code" in result.error && typeof result.error.code === "string" ? ` code=${result.error.code}` : "";
    return { ok: false, detail: failureDetail(`${result.error.message}${code}`), command, fingerprint: sha256(`failure\u0000${base}`) };
  }
  if (result.signal) return { ok: false, detail: failureDetail(`signal=${result.signal}`), command, fingerprint: sha256(`signal\u0000${base}`) };
  if (result.status !== 0) return { ok: false, detail: failureDetail(`exit=${result.status ?? "null"}`), command, fingerprint: sha256(`exit\u0000${base}`) };
  if (materialized.stdoutIncludes) {
    const missing = materialized.stdoutIncludes.find((item) => !stdout.includes(item));
    if (missing !== undefined) return { ok: false, detail: `stdout missing ${JSON.stringify(missing)}`, command, fingerprint: sha256(`stdout-includes\u0000${base}`) };
  }
  let stdoutJson: Record<string, unknown> | undefined;
  if (materialized.stdoutJson) {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("stdout JSON must be an object");
      stdoutJson = parsed as Record<string, unknown>;
      for (const key of materialized.stdoutJson.requiredKeys) {
        if (!(key in stdoutJson)) throw new Error(`stdout JSON missing required key ${key}`);
      }
      for (const [key, expected] of Object.entries(materialized.stdoutJson.equals)) {
        if (stdoutJson[key] !== expected) throw new Error(`stdout JSON ${key} !== ${JSON.stringify(expected)}`);
      }
    } catch (err) {
      return { ok: false, detail: `stdout-json: ${errorMessage(err)}`, command, fingerprint: sha256(`stdout-json\u0000${base}`) };
    }
  }
  const fingerprint = materialized.stdoutJson
    ? sha256(JSON.stringify({
      executable: materialized.executable,
      args: materialized.args,
      status: result.status ?? null,
      signal: result.signal ?? null,
      requiredValues: Object.fromEntries(
        [...new Set([...materialized.stdoutJson.requiredKeys, ...Object.keys(materialized.stdoutJson.equals)])]
          .sort()
          .map((key) => [key, stdoutJson?.[key]]),
      ),
    }))
    : materialized.stdoutIncludes
      ? sha256(JSON.stringify({ executable: materialized.executable, args: materialized.args, status: result.status ?? null, stdoutIncludes: materialized.stdoutIncludes }))
      : sha256(`ok\u0000${base}`);
  return {
    ok: true,
    ...(output ? { detail: output } : {}),
    ...(stdoutJson ? { stdoutJson } : {}),
    command,
    fingerprint,
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be a JSON object");
  return parsed as Record<string, unknown>;
}

function fingerprintFile(path: string): Fingerprint {
  return { path, realpath: realpathSync(path), sha256: hashFileContents(path) };
}

function parseCreatedAt(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = millisecondText === undefined ? 0 : Number(millisecondText);
  const parsedDate = new Date(0);
  parsedDate.setUTCFullYear(year, month - 1, day);
  parsedDate.setUTCHours(hour, minute, second, millisecond);
  return parsedDate.getUTCFullYear() === year
    && parsedDate.getUTCMonth() === month - 1
    && parsedDate.getUTCDate() === day
    && parsedDate.getUTCHours() === hour
    && parsedDate.getUTCMinutes() === minute
    && parsedDate.getUTCSeconds() === second
    && parsedDate.getUTCMilliseconds() === millisecond
    ? parsedDate.getTime()
    : null;
}

function inspectSnapshotGate(path: string, gate: CleanupGate): GateCheck {
  if (gate.kind !== "snapshot-manifest") return { ok: false, reason: "invalid-gate-kind" };
  const manifestPath = join(path, gate.manifestName!);
  if (!realPathInside(manifestPath, path)) return { ok: false, reason: "manifest-realpath-escape" };
  let manifest: Record<string, unknown>;
  try {
    manifest = readJsonObject(manifestPath);
  } catch (err) {
    return { ok: false, reason: "snapshot-manifest-invalid", detail: errorMessage(err) };
  }
  if (manifest.reason !== gate.requiredReason) return { ok: false, reason: "snapshot-manifest-invalid", detail: "reason mismatch" };
  if (gate.snapshotIdMatchesBasename && manifest.snapshot_id !== basename(path)) return { ok: false, reason: "snapshot-manifest-invalid", detail: "snapshot_id mismatch" };
  const createdAtMs = parseCreatedAt(manifest.created_at);
  if (createdAtMs === null) return { ok: false, reason: "snapshot-manifest-invalid", detail: "created_at must be a canonical UTC ISO timestamp" };
  if (!Array.isArray(manifest.roots)) return { ok: false, reason: "snapshot-manifest-invalid", detail: "roots must be an array" };
  const rootsByKey = new Map<string, Record<string, unknown>>();
  for (const rawRoot of manifest.roots) {
    if (!rawRoot || typeof rawRoot !== "object" || Array.isArray(rawRoot)) return { ok: false, reason: "snapshot-manifest-invalid", detail: "root must be an object" };
    const root = rawRoot as Record<string, unknown>;
    if (typeof root.key !== "string" || rootsByKey.has(root.key)) return { ok: false, reason: "snapshot-manifest-invalid", detail: "root key missing or duplicated" };
    rootsByKey.set(root.key, root);
  }
  const requiredKeys = gate.requiredRootKeys ?? [];
  if (rootsByKey.size !== requiredKeys.length || requiredKeys.some((key) => !rootsByKey.has(key))) return { ok: false, reason: "snapshot-manifest-invalid", detail: "required roots mismatch" };
  const archivePaths: string[] = [];
  const archives: Fingerprint[] = [];
  for (const key of requiredKeys) {
    const root = rootsByKey.get(key)!;
    const archive = root.archive;
    const archiveResult = root.archive_result;
    if (typeof archive !== "string" || !archive || !archiveResult || typeof archiveResult !== "object" || Array.isArray(archiveResult) || (gate.requireArchiveResultExists && (archiveResult as Record<string, unknown>).exists !== true)) {
      return { ok: false, reason: "snapshot-archive-invalid", detail: `${key} archive_result.exists is not true` };
    }
    const archivePath = resolve(path, archive);
    if (!realPathInside(archivePath, path) || basename(archivePath) !== archive || safeLstat(archivePath)?.isSymbolicLink()) return { ok: false, reason: "snapshot-archive-invalid", detail: `${key} archive escapes snapshot directory` };
    const tarResult = runControlledProbe(gate.tarProbe!, { path, basename: basename(path), snapshotId: basename(path), archivePath });
    if (!tarResult.ok) return { ok: false, reason: "snapshot-archive-unreadable", detail: `${key}: ${tarResult.detail ?? tarResult.command}` };
    archivePaths.push(archivePath);
    try {
      archives.push(fingerprintFile(archivePath));
    } catch (err) {
      return { ok: false, reason: "snapshot-archive-unreadable", detail: `${key}: ${errorMessage(err)}` };
    }
  }
  const manifestFingerprint = fingerprintFile(manifestPath);
  const info: SnapshotGateInfo = {
    archivePaths,
    manifest: { ...manifestFingerprint, createdAtMs },
    archives,
  };
  return { ok: true, info, fingerprint: sha256(JSON.stringify({ kind: gate.kind, manifest: info.manifest, archives: info.archives })) };
}

function checkSha256Gate(path: string, gate: CleanupGate, safeRoots: string[]): GateCheck {
  if (gate.kind !== "sha256-authoritative") return { ok: false, reason: "invalid-gate-kind" };
  let candidateHash: string;
  try {
    const candidate = lstatSync(path);
    if (!candidate.isFile()) return { ok: false, reason: "candidate-not-regular-file" };
    candidateHash = hashFileContents(path);
  } catch (err) {
    return { ok: false, reason: "candidate-hash-failed", detail: errorMessage(err) };
  }
  let authoritativeFound = false;
  for (const template of gate.authoritativePaths ?? []) {
    const authoritativePath = template.replaceAll("{basename}", basename(path));
    if (!isInsideSafeRoot(authoritativePath, safeRoots)) return { ok: false, reason: "authoritative-outside-safe-roots", detail: authoritativePath };
    const st = safeLstat(authoritativePath);
    if (!st || st.isSymbolicLink() || !st.isFile()) continue;
    authoritativeFound = true;
    if (hashFileContents(authoritativePath) === candidateHash) {
      const source = fingerprintFile(authoritativePath);
      return { ok: true, source, fingerprint: sha256(JSON.stringify({ kind: gate.kind, candidateHash, source })) };
    }
  }
  return authoritativeFound
    ? { ok: false, reason: "authoritative-sha-mismatch" }
    : { ok: false, reason: "authoritative-missing" };
}

type ContractCandidateRecord = {
  path: string;
  bytes: number;
  sha256: string;
  retainedPath?: string;
  retainedSha256?: string;
  archiveManifest?: string;
  businessKey?: string;
  archiveSha256?: string;
  sessionIds?: string[];
  snapshotEntry?: Record<string, unknown>;
};

type LoadedOwnerContract = {
  contract: Fingerprint;
  crossCheck?: Fingerprint;
  crossCheckValue?: Record<string, unknown>;
  candidates: Map<string, ContractCandidateRecord>;
  declaredBytes: number;
};

type ContractFailure = { ok: false; reason: string; detail: string };
type ContractLoad = { ok: true; loaded: LoadedOwnerContract } | ContractFailure;

type ContractCacheEntry = { key: string; load: ContractLoad };

/**
 * Owner contracts are read once per process and reused across the scan and both pre-delete
 * revalidations; a 28k-candidate manifest cannot be re-parsed per candidate. The cache key includes
 * the contract file identity and mtime, so a contract rewritten mid-run invalidates the entry and
 * is re-read and re-digested before the next candidate is cleared.
 */
const ownerContractCache = new Map<string, ContractCacheEntry>();

function contractCacheKey(path: string, crossCheckPath?: string): string {
  const stamp = (target: string): string => {
    const st = safeLstat(target);
    return st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}` : "missing";
  };
  return `${stamp(path)}|${crossCheckPath ? stamp(crossCheckPath) : "-"}`;
}

function contractFailure(reason: string, detail: string): ContractFailure {
  return { ok: false, reason, detail };
}

function readPinnedJson(path: string, expectedSha256: string, label: string): { ok: true; value: Record<string, unknown>; fingerprint: Fingerprint } | ContractFailure {
  const st = safeLstat(path);
  if (!st) return contractFailure("owner-contract-unreadable", `${label} is missing: ${path}`);
  if (st.isSymbolicLink() || !st.isFile()) return contractFailure("owner-contract-unreadable", `${label} is not a regular file: ${path}`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return contractFailure("owner-contract-unreadable", `${label}: ${errorMessage(err)}`);
  }
  const actual = sha256(raw);
  if (actual !== expectedSha256) {
    return contractFailure("owner-contract-digest-mismatch", `${label} sha256 ${actual} !== pinned ${expectedSha256}`);
  }
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be a JSON object");
    value = parsed as Record<string, unknown>;
  } catch (err) {
    return contractFailure("owner-contract-invalid", `${label}: ${errorMessage(err)}`);
  }
  return { ok: true, value, fingerprint: { path, realpath: realpathSync(path), sha256: actual } };
}

function candidateFacts(entry: Record<string, unknown>): { path: string; bytes: number; sha256: string } | null {
  const { path, bytes, sha256 } = entry;
  if (typeof path !== "string" || !isAbsolute(path) || path.split("/").includes("..")) return null;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0) return null;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) return null;
  return { path, bytes, sha256 };
}

function readContractCandidates(value: Record<string, unknown>, label: string): { ok: true; entries: Array<Record<string, unknown>> } | ContractLoad {
  const { candidates, candidate_count: count, candidate_bytes: bytes } = value;
  if (!Array.isArray(candidates) || candidates.length === 0) return contractFailure("owner-contract-invalid", `${label}.candidates must be a non-empty array`);
  const entries: Array<Record<string, unknown>> = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return contractFailure("owner-contract-invalid", `${label}.candidates entries must be objects`);
    entries.push(raw as Record<string, unknown>);
  }
  if (count !== entries.length) return contractFailure("owner-contract-invalid", `${label}.candidate_count ${String(count)} !== ${entries.length} entries`);
  let total = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const facts = candidateFacts(entry);
    if (!facts) return contractFailure("owner-contract-invalid", `${label} has a candidate without an absolute path, positive integer bytes and a lowercase sha256`);
    if (seen.has(facts.path)) return contractFailure("owner-contract-invalid", `${label} repeats candidate path ${facts.path}`);
    seen.add(facts.path);
    total += facts.bytes;
  }
  if (bytes !== total) return contractFailure("owner-contract-invalid", `${label}.candidate_bytes ${String(bytes)} !== summed ${total}`);
  return { ok: true, entries };
}

function loadOwnerContractUncached(rule: CleanupRule, safeRoots: string[]): ContractLoad {
  const selector = rule.contract!;
  const head = readPinnedJson(selector.path, selector.sha256, "owner contract");
  if (!("value" in head)) return head;
  const value = head.value;

  if (value.schema !== OWNER_CONTRACT_SCHEMA) return contractFailure("owner-contract-invalid", `schema ${JSON.stringify(value.schema)} !== ${OWNER_CONTRACT_SCHEMA}`);
  if (value.owner !== selector.owner || value.owner !== rule.owner) return contractFailure("owner-contract-invalid", `owner ${JSON.stringify(value.owner)} does not match rule owner ${rule.owner}`);
  if (value.approved_for_daily_cleanup !== true) return contractFailure("owner-contract-not-approved", "approved_for_daily_cleanup is not true");
  if (value.blocked_reason !== null && value.blocked_reason !== "") return contractFailure("owner-contract-not-approved", `blocked_reason is set: ${String(value.blocked_reason)}`);
  const probe = value.recovery_probe;
  if (!probe || typeof probe !== "object" || Array.isArray(probe) || (probe as Record<string, unknown>).status !== "passed") {
    return contractFailure("owner-contract-not-approved", "recovery_probe.status is not passed");
  }
  const roots = value.roots;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== "string" || !isAbsolute(root))) {
    return contractFailure("owner-contract-invalid", "roots must be a non-empty absolute string[]");
  }
  const contractRoots = roots as string[];

  const read = readContractCandidates(value, "owner contract");
  if (!("entries" in read)) return read;
  let entries = read.entries;

  if (selector.cohortField !== undefined) {
    const before = entries.length;
    entries = entries.filter((entry) => entry[selector.cohortField!] === selector.cohortValue);
    if (entries.length !== before) {
      return contractFailure("owner-contract-invalid", `contract mixes cohorts: ${before - entries.length} candidates are not ${selector.cohortField}=${String(selector.cohortValue)}`);
    }
  }
  if (entries.some((entry) => entry.approved_for_daily_cleanup === false)) {
    return contractFailure("owner-contract-invalid", "contract lists a candidate with approved_for_daily_cleanup=false");
  }

  let crossCheck: Fingerprint | undefined;
  let crossCheckValue: Record<string, unknown> | undefined;
  let crossCheckEntries: Map<string, Record<string, unknown>> | undefined;
  if (selector.crossCheck) {
    const referenced = readPinnedJson(selector.crossCheck.path, selector.crossCheck.sha256, "referenced candidate manifest");
    if (!("value" in referenced)) return referenced;
    if (referenced.value.owner !== rule.owner) return contractFailure("owner-contract-invalid", "referenced candidate manifest has a different owner");
    const referencedRead = readContractCandidates(referenced.value, "referenced candidate manifest");
    if (!("entries" in referencedRead)) return referencedRead;
    const normalize = (list: Array<Record<string, unknown>>): string => JSON.stringify(
      list.map((entry) => candidateFacts(entry)!).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    );
    if (normalize(entries) !== normalize(referencedRead.entries)) {
      return contractFailure("owner-contract-crosscheck-mismatch", "wrapper receipt and referenced candidate manifest disagree on candidate path/bytes/sha256");
    }
    if (referenced.value.candidate_count !== value.candidate_count || referenced.value.candidate_bytes !== value.candidate_bytes) {
      return contractFailure("owner-contract-crosscheck-mismatch", "wrapper receipt and referenced candidate manifest disagree on declared totals");
    }
    crossCheck = referenced.fingerprint;
    crossCheckValue = referenced.value;
    crossCheckEntries = new Map(referencedRead.entries.map((entry) => [candidateFacts(entry)!.path, entry]));
  }

  const candidates = new Map<string, ContractCandidateRecord>();
  let declaredBytes = 0;
  for (const entry of entries) {
    const facts = candidateFacts(entry)!;
    let sessionIds: string[] | undefined;
    if (selector.deletedSessionGate) {
      const declared = entry.session_ids;
      if (!Array.isArray(declared) || declared.length === 0
        || declared.some((id) => typeof id !== "string" || id.trim() === "")
        || new Set(declared as string[]).size !== declared.length) {
        return contractFailure("owner-contract-invalid", `candidate lacks a non-empty unique session_ids list required by deletedSessionGate: ${facts.path}`);
      }
      sessionIds = [...declared as string[]].sort();
    }
    const snapshotEntry = crossCheckEntries?.get(facts.path);
    if (!contractRoots.some((root) => isEqualOrBelow(facts.path, root))) {
      return contractFailure("owner-contract-invalid", `candidate escapes the declared roots: ${facts.path}`);
    }
    if (!rule.paths.some((root) => isEqualOrBelow(facts.path, root))) {
      return contractFailure("owner-contract-invalid", `candidate escapes the rule paths: ${facts.path}`);
    }
    const blocked = neverSweepReason(facts.path);
    if (blocked) return contractFailure("never-sweep-protected", `${facts.path}: ${blocked}`);
    if (!isInsideSafeRoot(dirname(facts.path), safeRoots)) {
      return contractFailure("owner-contract-invalid", `candidate parent is outside safeRoots: ${facts.path}`);
    }
    candidates.set(resolve(facts.path), {
      ...facts,
      ...(typeof entry.retained_path === "string" ? { retainedPath: entry.retained_path } : {}),
      ...(typeof entry.retained_sha256 === "string" ? { retainedSha256: entry.retained_sha256 } : {}),
      ...(typeof entry.archive_manifest === "string" ? { archiveManifest: entry.archive_manifest } : {}),
      ...(typeof entry.business_key === "string" ? { businessKey: entry.business_key } : {}),
      ...(typeof entry.archive_sha256 === "string" ? { archiveSha256: entry.archive_sha256 } : {}),
      ...(sessionIds ? { sessionIds } : {}),
      ...(snapshotEntry ? { snapshotEntry } : {}),
    });
    declaredBytes += facts.bytes;
  }

  // No candidate may double as another candidate's retained recovery peer.
  for (const record of candidates.values()) {
    if (record.retainedPath && candidates.has(resolve(record.retainedPath))) {
      return contractFailure("owner-contract-invalid", `retained peer is itself a candidate: ${record.retainedPath}`);
    }
  }

  return { ok: true, loaded: { contract: head.fingerprint, ...(crossCheck ? { crossCheck } : {}), ...(crossCheckValue ? { crossCheckValue } : {}), candidates, declaredBytes } };
}

function loadOwnerContract(rule: CleanupRule, safeRoots: string[]): ContractLoad {
  const selector = rule.contract!;
  const key = contractCacheKey(selector.path, selector.crossCheck?.path);
  const cached = ownerContractCache.get(rule.id);
  if (cached && cached.key === key) return cached.load;
  const load = loadOwnerContractUncached(rule, safeRoots);
  ownerContractCache.set(rule.id, { key, load });
  return load;
}

function verifyRetainedHashPeer(record: ContractCandidateRecord, safeRoots: string[]): { ok: true; recovery: Fingerprint; detail: Record<string, unknown> } | { ok: false; reason: string; detail: string } {
  const { retainedPath, retainedSha256 } = record;
  if (!retainedPath || !isAbsolute(retainedPath) || retainedSha256 === undefined) {
    return { ok: false, reason: "contract-recovery-missing", detail: "retained_path/retained_sha256 are required by recoveryMode retained-hash-peer" };
  }
  if (retainedSha256 !== record.sha256) return { ok: false, reason: "contract-recovery-failed", detail: "retained_sha256 !== candidate sha256" };
  if (resolve(retainedPath) === resolve(record.path)) return { ok: false, reason: "contract-recovery-failed", detail: "retained peer is the candidate itself" };
  const blocked = neverSweepReason(retainedPath);
  if (blocked) return { ok: false, reason: "contract-recovery-failed", detail: `retained peer is protected: ${blocked}` };
  if (!isInsideSafeRoot(retainedPath, safeRoots)) return { ok: false, reason: "contract-recovery-failed", detail: "retained peer is outside safeRoots" };
  const st = safeLstat(retainedPath);
  if (!st || st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "contract-recovery-failed", detail: "retained peer is missing or not a regular file" };
  let actual: string;
  try {
    actual = hashFileContents(retainedPath);
  } catch (err) {
    return { ok: false, reason: "contract-recovery-failed", detail: `retained peer unreadable: ${errorMessage(err)}` };
  }
  if (actual !== retainedSha256) return { ok: false, reason: "contract-recovery-failed", detail: "retained peer sha256 changed" };
  return {
    ok: true,
    recovery: { path: retainedPath, realpath: realpathSync(retainedPath), sha256: actual },
    detail: { mode: "retained-hash-peer", retainedBytes: st.size },
  };
}

function listRegularFiles(root: string, current: string, out: Map<string, { bytes: number; sha256: string }>): string | null {
  const children = safeReaddir(current);
  if (!children) return `directory vanished: ${current}`;
  for (const child of children.sort()) {
    const childPath = join(current, child);
    const st = safeLstat(childPath);
    if (!st) return `entry vanished: ${childPath}`;
    if (st.isSymbolicLink()) return `symlink inside candidate: ${childPath}`;
    if (st.isDirectory()) {
      const err = listRegularFiles(root, childPath, out);
      if (err) return err;
      continue;
    }
    if (!st.isFile()) return `non-regular file inside candidate: ${childPath}`;
    try {
      out.set(relative(root, childPath), { bytes: st.size, sha256: hashFileContents(childPath) });
    } catch (err) {
      return `unreadable file inside candidate: ${childPath}: ${errorMessage(err)}`;
    }
  }
  return null;
}

function verifyArchivedMemberFiles(archivePath: string, expected: Map<string, { bytes: number; sha256: string }>, memberPrefix: string): string | null {
  const expectedArchivePaths = [...expected.keys()].map((path) => `${memberPrefix}${path}`).sort();
  const prefixSegments = memberPrefix.slice(0, -1).split("/");
  const extractionRoot = mkdtempSync(join(tmpdir(), "weekly-cache-cleanup-archive-"));
  try {
    const extracted = runControlledProbe({
      executable: "/usr/bin/tar",
      args: ["-xzf", "{archivePath}", "-C", "{path}", "--", ...expectedArchivePaths],
      timeoutMs: 120_000,
      stdout: "discard",
    }, { archivePath, path: extractionRoot });
    if (!extracted.ok) return `archive member extraction failed: ${extracted.detail ?? extracted.command}`;

    // Prefix drift guard: the extraction must have produced exactly the declared prefix chain and
    // nothing beside it, so an archive that packs members under a different root -- or escapes the
    // prefix entirely -- is refused instead of silently comparing an empty member set.
    let expectedRoot = extractionRoot;
    for (const segment of prefixSegments) {
      const listed = safeReaddir(expectedRoot);
      if (!listed) return `archive did not extract the declared member prefix ${memberPrefix}`;
      if (listed.length !== 1 || listed[0] !== segment) {
        return `archive extracted ${JSON.stringify(listed)} where member prefix ${memberPrefix} requires ${JSON.stringify([segment])}`;
      }
      expectedRoot = join(expectedRoot, segment);
    }

    const actual = new Map<string, { bytes: number; sha256: string }>();
    const decisionRoot = expectedRoot;
    const walkError = listRegularFiles(decisionRoot, decisionRoot, actual);
    if (walkError) return walkError;
    if (actual.size !== expected.size) return `extracted archive has ${actual.size} members, manifest declares ${expected.size}`;
    for (const [path, expectedEntry] of expected) {
      const actualEntry = actual.get(path);
      if (!actualEntry) return `manifest member is missing from archive: ${path}`;
      if (actualEntry.bytes !== expectedEntry.bytes || actualEntry.sha256 !== expectedEntry.sha256) {
        return `archive member differs from manifest: ${path}`;
      }
    }
    return null;
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function verifyArchivedRunManifest(record: ContractCandidateRecord, safeRoots: string[], memberPrefix: string): { ok: true; recovery: Fingerprint; recoveryManifest: Fingerprint; detail: Record<string, unknown> } | { ok: false; reason: string; detail: string } {
  const { archiveManifest, archiveSha256, businessKey } = record;
  if (!archiveManifest || !isAbsolute(archiveManifest) || !archiveSha256 || !businessKey) {
    return { ok: false, reason: "contract-recovery-missing", detail: "archive_manifest/archive_sha256/business_key are required by recoveryMode verified-archive-manifest" };
  }
  let manifestSha256: string;
  try {
    manifestSha256 = hashFileContents(archiveManifest);
  } catch (err) {
    return { ok: false, reason: "contract-recovery-failed", detail: `archive manifest unreadable: ${errorMessage(err)}` };
  }
  const pinnedManifest = readPinnedJson(archiveManifest, manifestSha256, "archive manifest");
  if (!pinnedManifest.ok) return { ok: false, reason: "contract-recovery-failed", detail: pinnedManifest.detail };
  const manifest = pinnedManifest.value;
  if (manifest.source_path !== record.path) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest source_path !== candidate path" };
  if (manifest.business_key !== businessKey) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest business_key !== contract business_key" };
  if (manifest.archive_sha256 !== archiveSha256) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest archive_sha256 !== contract archive_sha256" };
  const archivePath = manifest.archive_path;
  if (typeof archivePath !== "string" || !isAbsolute(archivePath)) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest archive_path is not absolute" };
  if (isEqualOrBelow(archivePath, record.path)) return { ok: false, reason: "contract-recovery-failed", detail: "archive lives inside the candidate it recovers" };
  if (!isInsideSafeRoot(archivePath, safeRoots)) return { ok: false, reason: "contract-recovery-failed", detail: "archive is outside safeRoots" };
  const archiveStat = safeLstat(archivePath);
  if (!archiveStat || archiveStat.isSymbolicLink() || !archiveStat.isFile()) return { ok: false, reason: "contract-recovery-failed", detail: "archive is missing or not a regular file" };
  let archiveHash: string;
  try {
    archiveHash = hashFileContents(archivePath);
  } catch (err) {
    return { ok: false, reason: "contract-recovery-failed", detail: `archive unreadable: ${errorMessage(err)}` };
  }
  if (archiveHash !== archiveSha256) return { ok: false, reason: "contract-recovery-failed", detail: "archive sha256 changed" };

  if (!Array.isArray(manifest.members)) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest members must be an array" };
  const expected = new Map<string, { bytes: number; sha256: string }>();
  let expectedBytes = 0;
  for (const raw of manifest.members) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest member is not an object" };
    const member = raw as Record<string, unknown>;
    const { path: memberPath, bytes, sha256 } = member;
    if (typeof memberPath !== "string" || memberPath === "" || isAbsolute(memberPath) || /[\u0000\r\n]/u.test(memberPath) || memberPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      return { ok: false, reason: "contract-recovery-failed", detail: "archive manifest member path must be a relative in-tree path" };
    }
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0 || typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      return { ok: false, reason: "contract-recovery-failed", detail: `archive manifest member ${memberPath} lacks integer bytes and a sha256` };
    }
    if (expected.has(memberPath)) return { ok: false, reason: "contract-recovery-failed", detail: `archive manifest repeats member ${memberPath}` };
    expected.set(memberPath, { bytes, sha256 });
    expectedBytes += bytes;
  }

  // The live tree, digest-pinned manifest and tar-probed archive members must agree file for file
  // and hash for hash. Archive extraction runs only after the cheaper live-tree gate succeeds.
  const live = new Map<string, { bytes: number; sha256: string }>();
  const walkError = listRegularFiles(record.path, record.path, live);
  if (walkError) return { ok: false, reason: "contract-recovery-failed", detail: walkError };
  if (live.size !== expected.size) return { ok: false, reason: "contract-recovery-failed", detail: `live tree has ${live.size} files, archive covers ${expected.size}` };
  for (const [relPath, liveEntry] of live) {
    const archived = expected.get(relPath);
    if (!archived) return { ok: false, reason: "contract-recovery-failed", detail: `live file is not in the archive: ${relPath}` };
    if (archived.bytes !== liveEntry.bytes || archived.sha256 !== liveEntry.sha256) {
      return { ok: false, reason: "contract-recovery-failed", detail: `live file differs from the archived copy: ${relPath}` };
    }
  }
  if (expectedBytes !== record.bytes) return { ok: false, reason: "contract-recovery-failed", detail: `archived member bytes ${expectedBytes} !== contract bytes ${record.bytes}` };
  const archiveMemberError = verifyArchivedMemberFiles(archivePath, expected, memberPrefix);
  if (archiveMemberError) return { ok: false, reason: "contract-recovery-failed", detail: archiveMemberError };

  return {
    ok: true,
    recovery: { path: archivePath, realpath: realpathSync(archivePath), sha256: archiveHash },
    recoveryManifest: pinnedManifest.fingerprint,
    detail: { mode: "verified-archive-manifest", businessKey, members: expected.size, memberBytes: expectedBytes, archiveMembersVerified: expected.size, archiveManifest, memberPrefix },
  };
}

function snapshotGenerationFacts(path: string): { ok: true; bytes: number; sha256: string; files: Fingerprint[] } | { ok: false; detail: string } {
  const names = safeReaddir(path);
  if (!names) return { ok: false, detail: `snapshot directory is unreadable: ${path}` };
  let bytes = 0;
  const lines: string[] = [];
  const files: Fingerprint[] = [];
  for (const name of names.sort()) {
    const filePath = join(path, name);
    const st = safeLstat(filePath);
    if (!st || st.isSymbolicLink() || !st.isFile()) return { ok: false, detail: `snapshot contains a non-regular entry: ${filePath}` };
    let realpath: string;
    let fileSha256: string;
    try {
      realpath = realpathSync(filePath);
      if (!realPathInside(realpath, path)) return { ok: false, detail: `snapshot file realpath escapes generation: ${filePath}` };
      fileSha256 = hashFileContents(filePath);
    } catch (err) {
      return { ok: false, detail: `snapshot file is unreadable: ${filePath}: ${errorMessage(err)}` };
    }
    bytes += st.size;
    lines.push(`${fileSha256}  ${name}\n`);
    files.push({ path: filePath, realpath, sha256: fileSha256 });
  }
  return { ok: true, bytes, sha256: sha256(lines.sort().join("")), files };
}

function snapshotObject(value: unknown, label: string): Record<string, unknown> | { error: string } {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { error: `${label} must be an object` };
}

function verifySkillMasterSnapshotGeneration(
  record: ContractCandidateRecord,
  selector: OwnerContractSelector,
  loaded: LoadedOwnerContract,
  safeRoots: string[],
): { ok: true; recovery: Fingerprint; detail: Record<string, unknown> } | { ok: false; reason: string; detail: string } {
  const verification = selector.snapshotVerification!;
  const entry = record.snapshotEntry;
  if (!entry || !loaded.crossCheck || !loaded.crossCheckValue) {
    return { ok: false, reason: "contract-recovery-missing", detail: "the digest-pinned candidate manifest and rich candidate entry are required" };
  }
  if (!Array.isArray(entry.archives) || entry.archives.length !== verification.requiredRootKeys.length) {
    return { ok: false, reason: "contract-recovery-failed", detail: "candidate archive declarations mismatch" };
  }
  const declaredArchiveNames = entry.archives.map((raw) => raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).name : null);
  if (declaredArchiveNames.some((name) => typeof name !== "string") || new Set(declaredArchiveNames).size !== verification.requiredRootKeys.length) {
    return { ok: false, reason: "contract-recovery-failed", detail: "candidate archive names are invalid or duplicated" };
  }
  const expectedNames = ["manifest.json", ...declaredArchiveNames as string[]].sort();
  const facts = snapshotGenerationFacts(record.path);
  if (!facts.ok) return { ok: false, reason: "contract-recovery-failed", detail: facts.detail };
  const actualNames = facts.files.map((file) => basename(file.path)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    return { ok: false, reason: "contract-recovery-failed", detail: `snapshot files ${JSON.stringify(actualNames)} !== required ${JSON.stringify(expectedNames)}` };
  }
  if (facts.sha256 !== record.sha256) return { ok: false, reason: "contract-candidate-sha-changed", detail: record.path };
  if (facts.bytes !== record.bytes) return { ok: false, reason: "contract-candidate-bytes-changed", detail: `${facts.bytes} !== ${record.bytes}` };

  const declaredManifest = snapshotObject(entry.manifest, "candidate manifest");
  if ("error" in declaredManifest) return { ok: false, reason: "contract-recovery-failed", detail: declaredManifest.error as string };
  const manifestPath = join(record.path, "manifest.json");
  const manifestFingerprint = facts.files.find((file) => file.path === manifestPath)!;
  if (declaredManifest.path !== manifestPath || declaredManifest.sha256 !== manifestFingerprint.sha256) {
    return { ok: false, reason: "contract-recovery-failed", detail: "candidate manifest path or sha256 changed" };
  }
  const declaredRootKeys = declaredManifest.root_keys;
  if (!Array.isArray(declaredRootKeys) || JSON.stringify([...declaredRootKeys].sort()) !== JSON.stringify([...verification.requiredRootKeys].sort())) {
    return { ok: false, reason: "contract-recovery-failed", detail: "candidate manifest root_keys mismatch" };
  }
  if (declaredManifest.root_count !== verification.requiredRootKeys.length) {
    return { ok: false, reason: "contract-recovery-failed", detail: "candidate manifest root_count mismatch" };
  }

  let liveManifest: Record<string, unknown>;
  try {
    liveManifest = readJsonObject(manifestPath);
  } catch (err) {
    return { ok: false, reason: "contract-recovery-failed", detail: `manifest.json is invalid: ${errorMessage(err)}` };
  }
  if (liveManifest.snapshot_id !== basename(record.path) || !Array.isArray(liveManifest.roots)) {
    return { ok: false, reason: "contract-recovery-failed", detail: "manifest snapshot_id or roots are invalid" };
  }
  const liveRoots = new Map<string, Record<string, unknown>>();
  for (const rawRoot of liveManifest.roots) {
    const root = snapshotObject(rawRoot, "snapshot root");
    if ("error" in root || typeof root.key !== "string" || liveRoots.has(root.key)) {
      return { ok: false, reason: "contract-recovery-failed", detail: "manifest has an invalid or duplicate root" };
    }
    liveRoots.set(root.key, root);
  }
  if (liveRoots.size !== verification.requiredRootKeys.length || verification.requiredRootKeys.some((key) => !liveRoots.has(key))) {
    return { ok: false, reason: "contract-recovery-failed", detail: "manifest required roots mismatch" };
  }

  const archiveEvidence: Fingerprint[] = [];
  const probeEvidence: ProbeEvidence[] = [];
  const values = { path: record.path, basename: basename(record.path), snapshotId: basename(record.path) };
  for (const key of verification.requiredRootKeys) {
    const root = liveRoots.get(key)!;
    if (typeof root.archive !== "string" || basename(root.archive) !== root.archive) {
      return { ok: false, reason: "contract-recovery-failed", detail: `manifest archive name is invalid for root ${key}` };
    }
    const archiveName = root.archive;
    const archivePath = join(record.path, archiveName);
    const archive = entry.archives.find((raw) => raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>).name === archiveName) as Record<string, unknown> | undefined;
    const fingerprint = facts.files.find((file) => file.path === archivePath);
    const archiveResult = snapshotObject(root.archive_result, "archive_result");
    if (!archive || !fingerprint || archive.bytes !== statSync(archivePath).size || archive.sha256 !== fingerprint.sha256 || root.archive !== archiveName || "error" in archiveResult || archiveResult.exists !== true) {
      return { ok: false, reason: "contract-recovery-failed", detail: `archive declaration changed: ${archivePath}` };
    }
    archiveEvidence.push(fingerprint);
    probeEvidence.push(runControlledProbe(verification.tarProbe, { ...values, archivePath }));
  }
  probeEvidence.push(runControlledProbe(verification.restoreDryRunProbe, values));
  probeEvidence.push(runControlledProbe(verification.verifyCurrentProbe, values));
  const failedProbe = probeEvidence.find((probe) => !probe.ok);
  if (failedProbe) return { ok: false, reason: "contract-recovery-failed", detail: failedProbe.detail ?? failedProbe.command };

  const retainedFloor = loaded.crossCheckValue.retained_floor;
  if (!Array.isArray(retainedFloor) || retainedFloor.length === 0) {
    return { ok: false, reason: "contract-recovery-missing", detail: "candidate manifest retained_floor is missing" };
  }
  const retainedEvidence: Array<{ path: string; realpath: string; bytes: number; sha256: string }> = [];
  for (const rawRetained of retainedFloor) {
    const retained = snapshotObject(rawRetained, "retained floor entry");
    if ("error" in retained || typeof retained.path !== "string" || !isAbsolute(retained.path) || !isInsideSafeRoot(retained.path, safeRoots)) {
      return { ok: false, reason: "contract-recovery-failed", detail: "retained floor path is invalid" };
    }
    const retainedFacts = snapshotGenerationFacts(retained.path);
    if (!retainedFacts.ok || retainedFacts.bytes !== retained.bytes || retainedFacts.sha256 !== retained.sha256 || retained.root_count !== verification.requiredRootKeys.length) {
      return { ok: false, reason: "contract-recovery-failed", detail: `retained floor changed: ${retained.path}` };
    }
    const retainedManifest = retainedFacts.files.find((file) => basename(file.path) === "manifest.json");
    if (!retainedManifest || retained.manifest_sha256 !== retainedManifest.sha256) {
      return { ok: false, reason: "contract-recovery-failed", detail: `retained floor manifest changed: ${retained.path}` };
    }
    retainedEvidence.push({ path: retained.path, realpath: realpathSync(retained.path), bytes: retainedFacts.bytes, sha256: retainedFacts.sha256 });
  }

  return {
    ok: true,
    recovery: loaded.crossCheck,
    detail: {
      mode: "skill-master-snapshot-generation",
      candidateRealpath: realpathSync(record.path),
      manifest: manifestFingerprint,
      archives: archiveEvidence,
      retainedFloor: retainedEvidence,
      probes: probeEvidence.map(deterministicProbeEvidence),
    },
  };
}

/**
 * recoveryMode per-candidate-recovery-probe: the owner publishes a read-only verify probe (for
 * heartbeat T017, a per-candidate restore dry-run against a sealed recovery archive). The engine
 * re-runs it per candidate with the declared path and digest; a non-zero exit, timeout, signal or
 * stdout that violates the configured assertions fail-closes that candidate and keeps it.
 */
function verifyPerCandidateRecoveryProbe(
  record: ContractCandidateRecord,
  selector: OwnerContractSelector,
): { ok: true; recovery: Fingerprint; detail: Record<string, unknown> } | { ok: false; reason: string; detail: string } {
  const probe = selector.recoveryProbe!;
  const probeStat = safeLstat(probe.executable);
  if (!probeStat || probeStat.isSymbolicLink() || !probeStat.isFile()) {
    return { ok: false, reason: "contract-recovery-missing", detail: `recovery probe is missing or not a regular file: ${probe.executable}` };
  }
  let probeFingerprint: Fingerprint;
  try {
    probeFingerprint = fingerprintFile(probe.executable);
  } catch (err) {
    return { ok: false, reason: "contract-recovery-failed", detail: `recovery probe unreadable: ${errorMessage(err)}` };
  }
  const evidence = runControlledProbe(probe, {
    path: record.path,
    basename: basename(record.path),
    snapshotId: basename(record.path),
    sha256: record.sha256,
  });
  if (!evidence.ok) return { ok: false, reason: "contract-recovery-failed", detail: evidence.detail ?? evidence.command };
  return {
    ok: true,
    recovery: probeFingerprint,
    detail: { mode: "per-candidate-recovery-probe", probe: evidence },
  };
}

/**
 * Deleted-session state gate. A workspace directory is only releasable when the runtime itself says
 * so: every sessions row bound to the candidate's *physical* realpath must be `deleted`, the row set
 * must be exactly the session_ids the owner contract declared, and the latest of those retention
 * clocks must have cleared the 30-day floor. The runtime database is re-read on every pass -- scan
 * and both pre-delete revalidations -- and the rows land in the candidate evidence, so a row that is
 * revived, re-bound, re-touched or removed between passes fail-closes the delete.
 */
function checkDeletedSessionGate(
  record: ContractCandidateRecord,
  gate: DeletedSessionGate,
  path: string,
  nowMs: number,
): { ok: true; evidence: DeletedSessionEvidence } | { ok: false; reason: string; detail: string } {
  const declaredSessionIds = record.sessionIds;
  if (!declaredSessionIds || declaredSessionIds.length === 0) {
    return { ok: false, reason: "deleted-session-contract-incomplete", detail: `session_ids are required by deletedSessionGate: ${path}` };
  }
  let candidateRealpath: string;
  try {
    candidateRealpath = realpathSync(path);
  } catch (err) {
    return { ok: false, reason: "deleted-session-candidate-unresolvable", detail: errorMessage(err) };
  }

  let rows: Array<{ id: unknown; name: unknown; status: unknown; workdir: unknown; updated_at: unknown }>;
  let db: InstanceType<typeof Database> | undefined;
  try {
    db = new Database(gate.runtimeDbPath, { readonly: true, fileMustExist: true });
    rows = db.prepare("SELECT id, name, status, workdir, updated_at FROM sessions").all() as typeof rows;
  } catch (err) {
    return { ok: false, reason: "deleted-session-runtime-db-unreadable", detail: `${gate.runtimeDbPath}: ${errorMessage(err)}` };
  } finally {
    db?.close();
  }

  const matched: DeletedSessionEvidence["rows"] = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || typeof row.workdir !== "string" || typeof row.status !== "string") {
      return { ok: false, reason: "deleted-session-runtime-row-invalid", detail: "sessions row lacks a string id, status or workdir" };
    }
    let workdirRealpath: string;
    try {
      workdirRealpath = realpathSync(row.workdir);
    } catch {
      // An unresolvable workdir cannot be the candidate's physical directory, which still exists.
      workdirRealpath = resolve(row.workdir);
    }
    if (workdirRealpath !== candidateRealpath && resolve(row.workdir) !== resolve(path) && resolve(row.workdir) !== candidateRealpath) continue;
    matched.push({
      id: row.id,
      name: typeof row.name === "string" ? row.name : "",
      status: row.status,
      workdir: row.workdir,
      workdirRealpath,
      updatedAtMs: typeof row.updated_at === "number" ? row.updated_at : Number.NaN,
    });
  }
  matched.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (matched.length === 0) {
    return { ok: false, reason: "deleted-session-no-runtime-rows", detail: `no sessions row is bound to ${candidateRealpath}` };
  }
  const blockers = matched.filter((row) => row.status !== "deleted");
  if (blockers.length > 0) {
    return { ok: false, reason: "deleted-session-shared-blocker", detail: `${blockers.map((row) => `${row.id}=${row.status}`).join(",")} still bound to ${candidateRealpath}` };
  }
  const actualIds = matched.map((row) => row.id);
  if (JSON.stringify(actualIds) !== JSON.stringify([...declaredSessionIds].sort())) {
    return { ok: false, reason: "deleted-session-id-set-mismatch", detail: `runtime ${JSON.stringify(actualIds)} !== contract ${JSON.stringify([...declaredSessionIds].sort())}` };
  }
  if (matched.some((row) => !Number.isFinite(row.updatedAtMs))) {
    return { ok: false, reason: "deleted-session-runtime-row-invalid", detail: "sessions row lacks an integer updated_at" };
  }
  const latestRetentionClockMs = Math.max(...matched.map((row) => row.updatedAtMs));
  const requiredDays = Math.max(gate.minRetentionDays, DELETED_SESSION_MIN_RETENTION_DAYS);
  const elapsedMs = nowMs - latestRetentionClockMs;
  if (elapsedMs < requiredDays * DAY_MS) {
    return { ok: false, reason: "deleted-session-retention-floor", detail: `latest retention clock is ${Math.floor(elapsedMs / DAY_MS)} days old, floor is ${requiredDays}` };
  }
  return {
    ok: true,
    evidence: {
      runtimeDbPath: gate.runtimeDbPath,
      minRetentionDays: requiredDays,
      candidateRealpath,
      declaredSessionIds: [...declaredSessionIds].sort(),
      rows: matched,
      latestRetentionClockMs,
      retentionDaysElapsed: Math.floor(elapsedMs / DAY_MS),
    },
  };
}

/**
 * Re-derives, from disk, that this exact path is an owner-approved candidate whose bytes are
 * unchanged and whose recovery source is present and verified. Runs at scan and again in both
 * pre-delete revalidation passes.
 */
function checkOwnerContractGate(rule: CleanupRule, path: string, safeRoots: string[], nowMs: number): GateCheck {
  const selector = rule.contract!;
  const load = loadOwnerContract(rule, safeRoots);
  if (!load.ok) return { ok: false, reason: load.reason, detail: load.detail };
  const record = load.loaded.candidates.get(resolve(path));
  if (!record) return { ok: false, reason: "not-an-approved-contract-candidate", detail: path };

  const blocked = neverSweepReason(path);
  if (blocked) return { ok: false, reason: "never-sweep-protected", detail: blocked };

  const st = safeLstat(path);
  if (!st) return { ok: false, reason: "missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };

  let deletedSession: DeletedSessionEvidence | undefined;
  if (selector.deletedSessionGate) {
    const state = checkDeletedSessionGate(record, selector.deletedSessionGate, path, nowMs);
    if (!state.ok) return { ok: false, reason: state.reason, detail: state.detail };
    deletedSession = state.evidence;
  }

  let recovery: { ok: true; recovery: Fingerprint; recoveryManifest?: Fingerprint; detail: Record<string, unknown> } | { ok: false; reason: string; detail: string };
  if (selector.recoveryMode === "retained-hash-peer") {
    if (!st.isFile()) return { ok: false, reason: "contract-candidate-not-regular-file", detail: path };
    if (st.size !== record.bytes) return { ok: false, reason: "contract-candidate-bytes-changed", detail: `${st.size} !== ${record.bytes}` };
    let actual: string;
    try {
      actual = hashFileContents(path);
    } catch (err) {
      return { ok: false, reason: "contract-candidate-unreadable", detail: errorMessage(err) };
    }
    if (actual !== record.sha256) return { ok: false, reason: "contract-candidate-sha-changed", detail: path };
    recovery = verifyRetainedHashPeer(record, safeRoots);
  } else if (selector.recoveryMode === "verified-archive-manifest") {
    if (!st.isDirectory()) return { ok: false, reason: "contract-candidate-not-directory", detail: path };
    recovery = verifyArchivedRunManifest(record, safeRoots, selector.archiveMemberPrefix ?? DEFAULT_ARCHIVE_MEMBER_PREFIX);
  } else if (selector.recoveryMode === "per-candidate-recovery-probe") {
    if (!st.isFile()) return { ok: false, reason: "contract-candidate-not-regular-file", detail: path };
    if (st.size !== record.bytes) return { ok: false, reason: "contract-candidate-bytes-changed", detail: `${st.size} !== ${record.bytes}` };
    let actual: string;
    try {
      actual = hashFileContents(path);
    } catch (err) {
      return { ok: false, reason: "contract-candidate-unreadable", detail: errorMessage(err) };
    }
    if (actual !== record.sha256) return { ok: false, reason: "contract-candidate-sha-changed", detail: path };
    recovery = verifyPerCandidateRecoveryProbe(record, selector);
  } else {
    if (!st.isDirectory()) return { ok: false, reason: "contract-candidate-not-directory", detail: path };
    recovery = verifySkillMasterSnapshotGeneration(record, selector, load.loaded, safeRoots);
  }
  if (!recovery.ok) return { ok: false, reason: recovery.reason, detail: recovery.detail };

  const evidence: Omit<ContractCandidateEvidence, "fingerprint"> = {
    taskId: selector.taskId,
    contract: load.loaded.contract,
    ...(load.loaded.crossCheck ? { crossCheck: load.loaded.crossCheck } : {}),
    declaredBytes: record.bytes,
    declaredSha256: record.sha256,
    recoveryMode: selector.recoveryMode,
    recovery: recovery.recovery,
    ...(recovery.recoveryManifest ? { recoveryManifest: recovery.recoveryManifest } : {}),
    recoveryDetail: recovery.detail,
    ...(deletedSession ? { deletedSession } : {}),
  };
  const fingerprint = sha256(JSON.stringify({ path: resolve(path), ...evidence }));
  return { ok: true, contract: { ...evidence, fingerprint }, fingerprint };
}

function checkStructuralGate(rule: CleanupRule, path: string, safeRoots: string[], nowMs: number): GateCheck {
  if (rule.contract) return checkOwnerContractGate(rule, path, safeRoots, nowMs);
  if (!rule.gate) return { ok: true, fingerprint: "none" };
  if (rule.gate.kind === "snapshot-manifest") return inspectSnapshotGate(path, rule.gate);
  return checkSha256Gate(path, rule.gate, safeRoots);
}

function addCandidateIfOld(
  candidates: CleanupCandidate[],
  skipped: CleanupSummary["skipped"],
  rule: CleanupRule,
  path: string,
  cutoffMs: number,
  nowMs: number,
  safeRoots: string[],
  captureEvidence: boolean,
  scannedAtMs: number,
): void {
  const st = safeLstat(path);
  if (!st) {
    skipped.push({ ruleId: rule.id, path, reason: "missing" });
    return;
  }

  if (st.isSymbolicLink()) {
    skipped.push({ ruleId: rule.id, path, reason: "symlink" });
    return;
  }
  if (!isInsideSafeRoot(path, safeRoots)) {
    skipped.push({ ruleId: rule.id, path, reason: "realpath-outside-safe-roots" });
    return;
  }
  if (rule.protectedBasenames?.includes(basename(path))) {
    skipped.push({ ruleId: rule.id, path, reason: "protected-basename" });
    return;
  }
  if (rule.excludeBasenames?.includes(basename(path))) {
    skipped.push({ ruleId: rule.id, path, reason: "excluded-basename" });
    return;
  }
  const protectedReason = neverSweepReason(path);
  if (protectedReason) {
    skipped.push({ ruleId: rule.id, path, reason: "never-sweep-protected", detail: protectedReason });
    return;
  }
  const gate = checkStructuralGate(rule, path, safeRoots, nowMs);
  if (!gate.ok) {
    skipped.push({ ruleId: rule.id, path, reason: gate.reason, ...(gate.detail ? { detail: gate.detail } : {}) });
    return;
  }

  const retentionTimeMs = gate.info?.manifest.createdAtMs ?? st.mtimeMs;
  if (!rule.retention && retentionTimeMs > cutoffMs) {
    // Contract rules report the age floor explicitly: an owner-approved candidate that the
    // independent mtime floor still holds back must be visible in the receipt, not silently absent.
    if (rule.contract) skipped.push({ ruleId: rule.id, path, reason: "contract-candidate-age-floor", detail: `mtime ${new Date(retentionTimeMs).toISOString()} is newer than the ${rule.retentionDays}-day floor` });
    return;
  }

  const scanEvidence: ScanEvidence | undefined = captureEvidence ? {
    scannedAtMs,
    selector: {
      basename: basename(path),
      realpath: realpathSync(path),
      retentionEligible: retentionTimeMs <= cutoffMs,
      retentionTimeMs,
    },
    candidate: { path, realpath: realpathSync(path), sha256: digestTarget(path).value },
    ...(gate.source ? { source: gate.source } : {}),
    ...(gate.contract ? { contract: gate.contract } : {}),
    ...(rule.gate ? {
      gate: {
        kind: rule.gate.kind,
        fingerprint: gate.fingerprint,
        ...(gate.info ? { manifest: gate.info.manifest, archives: gate.info.archives } : {}),
      },
    } : {}),
  } : undefined;

  candidates.push({
    ruleId: rule.id,
    owner: rule.owner,
    path,
    bytes: entrySize(path),
    mtimeMs: st.mtimeMs,
    retentionTimeMs,
    ...(scanEvidence ? { scanEvidence } : {}),
  });
}

function collectChildren(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
  captureEvidence: boolean,
): void {
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  for (const parent of rule.paths) {
    const resolvedParent = resolve(parent);
    if (!isInsideSafeRoot(resolvedParent, safeRoots)) {
      summary.skipped.push({ ruleId: rule.id, path: parent, reason: "outside-safe-roots" });
      continue;
    }
    if (!existsSync(resolvedParent)) {
      summary.skipped.push({ ruleId: rule.id, path: parent, reason: "missing" });
      continue;
    }
    const st = safeLstat(resolvedParent);
    if (!st) {
      summary.skipped.push({ ruleId: rule.id, path: parent, reason: "missing" });
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      summary.skipped.push({ ruleId: rule.id, path: parent, reason: st.isSymbolicLink() ? "symlink" : "not-directory" });
      continue;
    }

    const children = safeReaddir(resolvedParent);
    if (!children) {
      summary.skipped.push({ ruleId: rule.id, path: parent, reason: "missing" });
      continue;
    }
    for (const child of children) {
      if (!basenameAllowed(child, rule)) continue;
      addCandidateIfOld(summary.candidates, summary.skipped, rule, join(resolvedParent, child), cutoffMs, nowMs, safeRoots, captureEvidence, nowMs);
    }
  }
}

function walkNamedDescendants(
  root: string,
  rule: CleanupRule,
  safeRoots: string[],
  cutoffMs: number,
  nowMs: number,
  summary: CleanupSummary,
  depth: number,
  captureEvidence: boolean,
): void {
  const maxDepth = rule.maxDepth ?? 6;
  if (depth > maxDepth) return;
  if (!isInsideSafeRoot(root, safeRoots)) {
    summary.skipped.push({ ruleId: rule.id, path: root, reason: "outside-safe-roots" });
    return;
  }
  if (!existsSync(root)) {
    summary.skipped.push({ ruleId: rule.id, path: root, reason: "missing" });
    return;
  }

  const st = safeLstat(root);
  if (!st) {
    summary.skipped.push({ ruleId: rule.id, path: root, reason: "missing" });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return;

  const children = safeReaddir(root);
  if (!children) return;
  for (const child of children) {
    const childPath = join(root, child);
    const childStat = safeLstat(childPath);
    if (!childStat) continue;
    if (childStat.isSymbolicLink()) continue;
    const namedMatch = rule.names?.includes(child)
      || rule.matchBasenamePrefixes?.some((prefix) => child.startsWith(prefix));
    if (namedMatch) {
      addCandidateIfOld(summary.candidates, summary.skipped, rule, childPath, cutoffMs, nowMs, safeRoots, captureEvidence, Date.now());
      continue;
    }
    if (childStat.isDirectory()) walkNamedDescendants(childPath, rule, safeRoots, cutoffMs, nowMs, summary, depth + 1, captureEvidence);
  }
}

function collectNamedDescendants(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
  captureEvidence: boolean,
): void {
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  for (const root of rule.paths) {
    walkNamedDescendants(resolve(root), rule, safeRoots, cutoffMs, nowMs, summary, 0, captureEvidence);
  }
}

/**
 * The owner-contract collector never reads a directory to decide what to delete. It takes the
 * digest-pinned, owner-approved candidate list and re-verifies each entry against disk, so the
 * worst case is deleting strictly fewer paths than the owner approved -- never more.
 */
function collectContractCandidates(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
  captureEvidence: boolean,
): void {
  const load = loadOwnerContract(rule, safeRoots);
  if (!load.ok) {
    for (const path of rule.paths) summary.skipped.push({ ruleId: rule.id, path, reason: load.reason, detail: load.detail });
    return;
  }
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  const before = summary.candidates.length;
  for (const path of [...load.loaded.candidates.keys()].sort()) {
    addCandidateIfOld(summary.candidates, summary.skipped, rule, path, cutoffMs, nowMs, safeRoots, captureEvidence, nowMs);
  }
  const admitted = summary.candidates.slice(before);
  // Compare against the bytes the owner declared, not the bytes measured on disk: a directory
  // candidate's measured size also counts directory inodes, which the contract never accounts for.
  const admittedBytes = admitted.reduce((sum, candidate) => sum + (load.loaded.candidates.get(resolve(candidate.path))?.bytes ?? Number.MAX_SAFE_INTEGER), 0);
  if (admitted.length > load.loaded.candidates.size || admittedBytes > load.loaded.declaredBytes) {
    // Cannot happen while the collector iterates the contract map, so treat it as tampering and
    // drop the whole rule rather than delete an unbounded amount.
    summary.candidates.length = before;
    for (const candidate of admitted) {
      summary.skipped.push({ ruleId: rule.id, path: candidate.path, reason: "contract-budget-exceeded", detail: `${admitted.length} candidates / ${admittedBytes} bytes exceed the approved ${load.loaded.candidates.size} / ${load.loaded.declaredBytes}` });
    }
  }
}

function walkMatchingFiles(
  root: string,
  rule: CleanupRule,
  safeRoots: string[],
  cutoffMs: number,
  nowMs: number,
  summary: CleanupSummary,
  depth: number,
  captureEvidence: boolean,
  scannedAtMs: number,
): void {
  if (depth > (rule.maxDepth ?? 12) || !isInsideSafeRoot(root, safeRoots)) return;
  const st = safeLstat(root);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  const children = safeReaddir(root);
  if (!children) return;
  for (const child of children) {
    const childPath = join(root, child);
    const childStat = safeLstat(childPath);
    if (!childStat || childStat.isSymbolicLink()) continue;
    if (childStat.isDirectory()) {
      walkMatchingFiles(childPath, rule, safeRoots, cutoffMs, nowMs, summary, depth + 1, captureEvidence, scannedAtMs);
      continue;
    }
    if (!childStat.isFile() || !rule.suffixes?.some((suffix) => child.endsWith(suffix))) continue;
    addCandidateIfOld(summary.candidates, summary.skipped, rule, childPath, cutoffMs, nowMs, safeRoots, captureEvidence, scannedAtMs);
  }
}

function collectMatchingFiles(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
  captureEvidence: boolean,
): void {
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  for (const root of rule.paths) {
    const resolvedRoot = resolve(root);
    if (!isInsideSafeRoot(resolvedRoot, safeRoots)) {
      summary.skipped.push({ ruleId: rule.id, path: root, reason: "outside-safe-roots" });
      continue;
    }
    if (!existsSync(resolvedRoot)) {
      summary.skipped.push({ ruleId: rule.id, path: root, reason: "missing" });
      continue;
    }
    walkMatchingFiles(resolvedRoot, rule, safeRoots, cutoffMs, nowMs, summary, 0, captureEvidence, nowMs);
  }
}

function defaultCodexStateDbPath(): string {
  return join(homedir(), ".codex", "state_5.sqlite");
}

function escapeSqlLike(input: string): string {
  return input.replace(/[\\%_]/gu, (char) => `\\${char}`);
}

function archiveCodexStateThreadsForPath(
  candidatePath: string,
  config: CleanupConfig,
  archivedAtSeconds: number,
): string[] {
  const dbPath = config.codexStateDbPath === undefined
    ? defaultCodexStateDbPath()
    : config.codexStateDbPath;
  if (!dbPath || !existsSync(dbPath)) return [];

  const db = new Database(dbPath, { timeout: 1000 });
  try {
    const prefixLike = `${escapeSqlLike(`${candidatePath}/`)}%`;
    const rows = db.prepare(`
      SELECT id
      FROM threads
      WHERE archived = 0
        AND (
          rollout_path = @candidatePath
          OR rollout_path LIKE @prefixLike ESCAPE '\\'
        )
      ORDER BY id
    `).all({ candidatePath, prefixLike }) as Array<{ id: string }>;
    const threadIds = rows.map((row) => row.id);
    if (threadIds.length === 0) return [];

    const update = db.prepare(`
      UPDATE threads
      SET archived = 1, archived_at = @archivedAtSeconds
      WHERE id = @id AND archived = 0
    `);
    const archive = db.transaction((ids: string[]) => {
      for (const id of ids) update.run({ id, archivedAtSeconds });
    });
    archive(threadIds);
    return threadIds;
  } finally {
    db.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nativePreview(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, 500);
}

function defaultNativeUvCommandRunner(
  executable: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): NativeUvCommandResult {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error ?? null,
  };
}

function verifyNativeUvRoot(root: string, safeRoots: string[]): string {
  if (resolve(root) !== UV_CACHE_ROOT) throw new Error("uv cache root must be the exact uv cache root");
  const st = lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("uv cache root must be a real directory");
  const realpath = realpathSync(root);
  if (realpath !== UV_CACHE_ROOT) throw new Error(`uv cache root realpath mismatch: ${realpath}`);
  if (!isInsideSafeRoot(root, safeRoots)) throw new Error("uv cache root is outside safeRoots");
  return realpath;
}

function verifyNativeUvExecutable(executable: string): string {
  const realpath = realpathSync(executable);
  const st = lstatSync(realpath);
  if (!st.isFile()) throw new Error("uv executable is not a regular file");
  accessSync(realpath, fsConstants.X_OK);
  return realpath;
}

type NativeUvAuditEvent = {
  schema: "weekly-cache-cleanup-uv-native-audit/v1";
  event: "pre-prune" | "prune-result";
  ruleId: string;
  root: string;
  argv: string[];
  capturedAtMs: number;
  before?: NativeUvRootObservation;
  commandResult?: { status: number | null; signal: string | null; stdoutPreview: string; stderrPreview: string; error?: string };
  after?: NativeUvRootObservation;
  lockStatus?: NativeUvPruneReceipt["lockStatus"];
  deletionVerified?: boolean;
  logicalBytesRemoved?: number | null;
  physicalFreeBytesDelta?: number | null;
};

function appendNativeUvAuditEvent(fd: number, event: NativeUvAuditEvent): void {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  let offset = 0;
  while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
  fsyncSync(fd);
}

function nativeUvAuditPath(receiptDir: string, nowMs: number, ruleId: string): string {
  return join(receiptDir, `${receiptStamp(nowMs)}-${safeOwnerSlug(ruleId)}-uv-native.audit.jsonl`);
}

function runNativeUvCachePrune(input: {
  rule: CleanupRule;
  safeRoots: string[];
  apply: boolean;
  maxDeleteBytes: number;
  receiptDir?: string;
  nowMs: number;
  commandRunner: NativeUvCommandRunner;
  rootObserver: NativeUvRootObserver;
}): NativeUvPruneReceipt {
  const native = input.rule.native!;
  const root = input.rule.paths[0]!;
  const timeoutMs = native.timeoutMs ?? UV_NATIVE_DEFAULT_TIMEOUT_MS;
  const lockTimeoutSeconds = Math.max(1, Math.ceil((native.lockTimeoutMs ?? UV_NATIVE_DEFAULT_LOCK_TIMEOUT_SECONDS * 1000) / 1000));
  const argv = ["cache", "prune", "--cache-dir", root, "--no-config"];
  const receipt: NativeUvPruneReceipt = {
    ruleId: input.rule.id,
    root,
    mode: input.apply ? "apply" : "dry-run",
    executable: native.executable,
    executableRealpath: null,
    expectedVersion: native.expectedVersion,
    argv,
    command: [native.executable, ...argv].join(" "),
    timeoutMs,
    lockTimeoutSeconds,
    lockStatus: input.apply ? "failed" : "not-run",
    mutationAttempted: false,
    mutationOutcome: "not-started",
    deletionVerified: false,
    nativePotentialDeletion: input.apply ? "not-run" : "unknown",
    nativePotentialDeletionIsNotLegacySelector: true,
    logicalBytesRemoved: null,
    removedEntries: null,
    physicalFreeBytesDelta: null,
    readbackStatus: "not-run",
    rootReadback: null,
    exitCode: null,
    signal: null,
    stdoutPreview: "",
    stderrPreview: "",
  };

  try {
    verifyNativeUvRoot(root, input.safeRoots);
    receipt.executableRealpath = verifyNativeUvExecutable(native.executable);
  } catch (err) {
    receipt.failureReason = `preflight: ${errorMessage(err)}`;
    return receipt;
  }

  let versionResult: NativeUvCommandResult;
  try {
    versionResult = input.commandRunner(native.executable, ["--version"], {
      cwd: root,
      timeoutMs: Math.min(timeoutMs, 5_000),
      env: { ...process.env },
    });
  } catch (err) {
    versionResult = { status: null, signal: null, stdout: "", stderr: "", error: err instanceof Error ? err : new Error(String(err)) };
  }
  receipt.exitCode = versionResult.status;
  receipt.signal = versionResult.signal;
  receipt.stdoutPreview = nativePreview(versionResult.stdout);
  receipt.stderrPreview = nativePreview(versionResult.stderr);
  if (versionResult.error) receipt.error = errorMessage(versionResult.error);
  const actualVersion = /^uv\s+(\S+)/u.exec(versionResult.stdout.trim())?.[1];
  if (versionResult.status !== 0 || versionResult.signal || actualVersion !== native.expectedVersion) {
    receipt.failureReason = `version verification failed: expected uv ${native.expectedVersion}, got ${actualVersion ?? "unknown"}`;
    return receipt;
  }
  receipt.actualVersion = actualVersion;

  if (!input.apply) {
    receipt.lockStatus = "not-needed";
    return receipt;
  }
  if (!input.receiptDir) {
    receipt.failureReason = "receiptDir is required for native apply";
    return receipt;
  }

  let before: NativeUvRootObservation;
  try {
    before = input.rootObserver(root);
    receipt.before = before;
    if (!before.exists || before.realpath !== UV_CACHE_ROOT) throw new Error("uv cache root preflight readback failed");
    if (before.logicalBytes > input.maxDeleteBytes) {
      receipt.failureReason = `root logical bytes ${before.logicalBytes} exceed maxDeleteBytes ${input.maxDeleteBytes}`;
      receipt.readbackStatus = "failed";
      return receipt;
    }
  } catch (err) {
    receipt.failureReason = `pre-prune observation failed: ${errorMessage(err)}`;
    return receipt;
  }

  const auditPath = nativeUvAuditPath(input.receiptDir, input.nowMs, input.rule.id);
  receipt.auditSidecar = auditPath;
  mkdirSync(input.receiptDir, { recursive: true });
  let auditFd: number | undefined;
  try {
    auditFd = openSync(auditPath, "a", 0o600);
    appendNativeUvAuditEvent(auditFd, {
      schema: "weekly-cache-cleanup-uv-native-audit/v1",
      event: "pre-prune",
      ruleId: input.rule.id,
      root,
      argv,
      capturedAtMs: Date.now(),
      before,
    });
  } catch (err) {
    if (auditFd !== undefined) closeSync(auditFd);
    receipt.failureReason = `fsync pre-prune audit failed: ${errorMessage(err)}`;
    return receipt;
  }

  // Re-read both security-critical identities immediately before invoking uv. The earlier
  // preflight and tree observation can be slow enough for either path to be replaced meanwhile.
  try {
    verifyNativeUvRoot(root, input.safeRoots);
    receipt.executableRealpath = verifyNativeUvExecutable(native.executable);
  } catch (err) {
    receipt.failureReason = `pre-command safety gate failed: ${errorMessage(err)}`;
    try {
      appendNativeUvAuditEvent(auditFd, {
        schema: "weekly-cache-cleanup-uv-native-audit/v1",
        event: "prune-result",
        ruleId: input.rule.id,
        root,
        argv,
        capturedAtMs: Date.now(),
        commandResult: { status: null, signal: null, stdoutPreview: "", stderrPreview: "", error: receipt.failureReason },
        lockStatus: receipt.lockStatus,
        deletionVerified: false,
        logicalBytesRemoved: null,
        physicalFreeBytesDelta: null,
      });
    } catch (auditErr) {
      receipt.failureReason = `${receipt.failureReason}; fsync result audit failed: ${errorMessage(auditErr)}`;
    } finally {
      closeSync(auditFd);
    }
    return receipt;
  }

  receipt.mutationAttempted = true;
  receipt.mutationOutcome = "unverified";
  let commandResult: NativeUvCommandResult;
  try {
    commandResult = input.commandRunner(native.executable, argv, {
      cwd: root,
      timeoutMs,
      env: { ...process.env, UV_LOCK_TIMEOUT: String(lockTimeoutSeconds) },
    });
  } catch (err) {
    commandResult = { status: null, signal: null, stdout: "", stderr: "", error: err instanceof Error ? err : new Error(String(err)) };
  }
  receipt.exitCode = commandResult.status;
  receipt.signal = commandResult.signal;
  receipt.stdoutPreview = nativePreview(commandResult.stdout);
  receipt.stderrPreview = nativePreview(commandResult.stderr);
  if (commandResult.error) receipt.error = errorMessage(commandResult.error);
  const combinedOutput = `${commandResult.stdout}\n${commandResult.stderr}`.toLowerCase();
  const lockBlocked = commandResult.status !== 0 && combinedOutput.includes("lock") && (combinedOutput.includes("timeout") || combinedOutput.includes("timed out") || combinedOutput.includes("wait"));
  receipt.lockStatus = commandResult.status === 0 && !commandResult.signal ? "acquired" : lockBlocked ? "blocked" : "failed";

  let after: NativeUvRootObservation | undefined;
  try {
    after = input.rootObserver(root);
    receipt.after = after;
    receipt.rootReadback = after;
    if (!after.exists || after.realpath !== UV_CACHE_ROOT) {
      receipt.readbackStatus = "failed";
    } else if (after.logicalBytes > before.logicalBytes || after.entries > before.entries) {
      receipt.readbackStatus = "ambiguous-concurrent-growth";
    } else {
      receipt.readbackStatus = "verified";
      if (commandResult.status === 0 && !commandResult.signal) {
        receipt.logicalBytesRemoved = before.logicalBytes - after.logicalBytes;
        receipt.removedEntries = before.entries - after.entries;
        receipt.physicalFreeBytesDelta = before.freeBytes !== null && after.freeBytes !== null
          ? after.freeBytes - before.freeBytes
          : null;
        receipt.mutationOutcome = "verified";
      } else if (lockBlocked && sameNativeUvObservation(before, after)) {
        // uv reports a lock timeout before it starts pruning. This is the only failed native
        // branch that is safe to let the existing generic rules consume the full budget.
        receipt.mutationOutcome = "not-started";
      }
    }
  } catch (err) {
    receipt.readbackStatus = "failed";
    receipt.failureReason = `post-prune observation failed: ${errorMessage(err)}`;
  }
  receipt.deletionVerified = commandResult.status === 0 && !commandResult.signal && receipt.readbackStatus === "verified";
  if (!receipt.deletionVerified && !receipt.failureReason) receipt.failureReason = lockBlocked ? "uv lock blocked native prune" : "uv native prune did not pass command/readback verification";
  try {
    appendNativeUvAuditEvent(auditFd, {
      schema: "weekly-cache-cleanup-uv-native-audit/v1",
      event: "prune-result",
      ruleId: input.rule.id,
      root,
      argv,
      capturedAtMs: Date.now(),
      commandResult: {
        status: commandResult.status,
        signal: commandResult.signal,
        stdoutPreview: receipt.stdoutPreview,
        stderrPreview: receipt.stderrPreview,
        ...(receipt.error ? { error: receipt.error } : {}),
      },
      ...(after ? { after } : {}),
      lockStatus: receipt.lockStatus,
      deletionVerified: receipt.deletionVerified,
      logicalBytesRemoved: receipt.logicalBytesRemoved,
      physicalFreeBytesDelta: receipt.physicalFreeBytesDelta,
    });
  } catch (err) {
    receipt.deletionVerified = false;
    receipt.mutationOutcome = "unverified";
    receipt.failureReason = `fsync result audit failed: ${errorMessage(err)}`;
  } finally {
    closeSync(auditFd);
  }
  return receipt;
}

function isPlaceholderRecoveryValue(value: unknown): boolean {
  return typeof value !== "string" || PLACEHOLDER_RECOVERY_VALUES.has(value.trim().toLowerCase());
}

export function checkRecoveryContract(
  rule: CleanupRule | undefined,
): { ok: true; contract: RecoveryContract } | { ok: false; reason: string } {
  if (!rule) return { ok: false, reason: "rule-not-in-config" };
  const recovery = rule.recovery;
  if (!recovery || typeof recovery !== "object") return { ok: false, reason: "rule-has-no-recovery-contract" };
  if (!RECOVERY_KINDS.includes(recovery.kind)) return { ok: false, reason: `recovery.kind must be one of ${RECOVERY_KINDS.join("|")}` };
  for (const field of ["producer", "key", "version", "probe"] as const) {
    if (isPlaceholderRecoveryValue(recovery[field])) {
      return { ok: false, reason: `recovery.${field} is empty or a placeholder` };
    }
  }
  return { ok: true, contract: recovery };
}

function materializeRecovery(contract: RecoveryContract, path: string): RecoveryContract {
  const substitute = (value: string): string => value
    .replaceAll("{basename}", basename(path))
    .replaceAll("{path}", path);
  return {
    kind: contract.kind,
    producer: contract.producer,
    key: substitute(contract.key),
    version: contract.version,
    probe: substitute(contract.probe),
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashFileContents(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, DIGEST_CHUNK_BYTES, null);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function manifestLine(relPath: string, kind: string, size: number, contentHash: string): string {
  return `${relPath}\u0000${kind}\u0000${size}\u0000${contentHash}\n`;
}

function collectManifestEntries(
  root: string,
  current: string,
  entries: Array<{ relPath: string; line: string; bytes: number }>,
): void {
  const st = lstatSync(current);
  const relPath = relative(root, current) || ".";
  if (st.isSymbolicLink()) {
    const target = readlinkSync(current);
    entries.push({ relPath, line: manifestLine(relPath, "l", target.length, sha256(target)), bytes: st.size });
    return;
  }
  if (st.isDirectory()) {
    entries.push({ relPath, line: manifestLine(relPath, "d", 0, "-"), bytes: st.size });
    for (const child of readdirSync(current)) {
      collectManifestEntries(root, join(current, child), entries);
    }
    return;
  }
  if (st.isFile()) {
    entries.push({ relPath, line: manifestLine(relPath, "f", st.size, hashFileContents(current)), bytes: st.size });
    return;
  }
  entries.push({ relPath, line: manifestLine(relPath, "o", st.size, "-"), bytes: st.size });
}

/**
 * Content evidence for one deletion target. Regular files hash their bytes; a directory hashes a
 * stable recursive manifest (version line + one path-sorted line per descendant), so the same tree
 * always yields the same digest and any missing or changed descendant changes it.
 */
export function digestTarget(path: string): TargetDigest {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    return { algorithm: "sha256", kind: "symlink", value: sha256(readlinkSync(path)), entries: 1, bytes: st.size };
  }
  if (!st.isDirectory()) {
    return { algorithm: "sha256", kind: "file", value: hashFileContents(path), entries: 1, bytes: st.size };
  }
  const entries: Array<{ relPath: string; line: string; bytes: number }> = [];
  collectManifestEntries(path, path, entries);
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const manifest = `${DIRECTORY_MANIFEST_VERSION}\n${entries.map((entry) => entry.line).join("")}`;
  return {
    algorithm: "sha256",
    kind: "directory-manifest",
    value: sha256(manifest),
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    manifestVersion: DIRECTORY_MANIFEST_VERSION,
  };
}

function gateCandidatesWithoutRecoveryProbe(summary: CleanupSummary, config: CleanupConfig): void {
  const rulesById = new Map(config.rules.map((rule) => [rule.id, rule]));
  const admitted: CleanupCandidate[] = [];
  for (const candidate of summary.candidates) {
    const gate = checkRecoveryContract(rulesById.get(candidate.ruleId));
    if (gate.ok) {
      admitted.push(candidate);
      continue;
    }
    summary.audit.recoveryGatedCandidates += 1;
    summary.skipped.push({
      ruleId: candidate.ruleId,
      path: candidate.path,
      reason: "missing-recovery-probe",
      detail: gate.reason,
    });
  }
  summary.candidates = admitted;
}

type ApplyAuditSidecarEvent = {
  schema: "weekly-cache-cleanup-apply-audit/v1";
  event: "pre-delete";
  ruleId: string;
  owner: string;
  path: string;
  bytes: number;
  digest: TargetDigest;
  realpath: string;
  scanEvidence: ScanEvidence;
  recovery: RecoveryContract;
  capturedAtMs: number;
  codexStateArchivedThreadIds?: string[];
} | {
  schema: "weekly-cache-cleanup-apply-audit/v1";
  event: "delete-result";
  ruleId: string;
  owner: string;
  path: string;
  deleteResult: DeletionAuditRecord["deleteResult"];
  postDelete: DeletionAuditRecord["postDelete"];
};

function receiptStamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
}

function auditChainSidecarPath(receiptDir: string, nowMs: number): string {
  return join(receiptDir, `${receiptStamp(nowMs)}-apply.audit.jsonl`);
}

function appendAuditSidecarEvent(fd: number, event: ApplyAuditSidecarEvent): void {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  let offset = 0;
  while (offset < line.length) {
    offset += writeSync(fd, line, offset, line.length - offset);
  }
  fsyncSync(fd);
}

/**
 * Both selector matchers answer one question: would the collector's walk have reached exactly this
 * target? Re-running that walk as a depth-first search costs O(tree) per candidate, and the
 * revalidation path runs it twice per delete; on the 55k-entry Apple Python bytecode mirror that is
 * what pushed the 04:10 apply past its scheduler timeout before it could write a terminal receipt.
 * Descending the ancestor chain from root to target evaluates the identical predicate in O(depth):
 * the same safe-root, readability, symlink, directory and depth conditions the DFS applied to every
 * directory it entered. Returns the path segments from root to target, or null when the walk could
 * not have reached it.
 */
function descendantChain(root: string, target: string, maxDepth: number, safeRoots: string[]): string[] | null {
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split("/");
  if (segments.length - 1 > maxDepth) return null;
  let current = root;
  for (const segment of segments) {
    if (!isInsideSafeRoot(current, safeRoots)) return null;
    const st = safeLstat(current);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return null;
    try {
      // Parity with the DFS: a directory it could not list was a directory it could not match through.
      accessSync(current, fsConstants.R_OK | fsConstants.X_OK);
    } catch {
      return null;
    }
    current = join(current, segment);
  }
  return segments;
}

function namedDescendantContains(root: string, target: string, rule: CleanupRule, safeRoots: string[]): boolean {
  const segments = descendantChain(root, target, rule.maxDepth ?? 6, safeRoots);
  if (!segments) return false;
  const st = safeLstat(target);
  if (!st || st.isSymbolicLink()) return false;
  const name = segments[segments.length - 1]!;
  return rule.names?.includes(name) === true || rule.matchBasenamePrefixes?.some((prefix) => name.startsWith(prefix)) === true;
}

function matchingFileContains(root: string, target: string, rule: CleanupRule, safeRoots: string[]): boolean {
  const segments = descendantChain(root, target, rule.maxDepth ?? 12, safeRoots);
  if (!segments) return false;
  const st = safeLstat(target);
  if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  const name = segments[segments.length - 1]!;
  return rule.suffixes?.some((suffix) => name.endsWith(suffix)) === true;
}

function selectorMatchesPath(rule: CleanupRule, path: string, safeRoots: string[]): boolean {
  const resolvedPath = resolve(path);
  if (rule.action === "delete_owner_contract_candidates") {
    const load = loadOwnerContract(rule, safeRoots);
    return load.ok && load.loaded.candidates.has(resolvedPath);
  }
  if (rule.action === "delete_children_older_than") {
    return rule.paths.some((parent) => resolve(join(parent, basename(path))) === resolvedPath && resolve(parent) === dirname(resolvedPath) && basenameAllowed(basename(path), rule));
  }
  if (rule.action === "delete_matching_files_older_than") {
    return rule.paths.some((root) => matchingFileContains(resolve(root), resolvedPath, rule, safeRoots));
  }
  return rule.paths.some((root) => namedDescendantContains(resolve(root), resolvedPath, rule, safeRoots));
}

type CurrentCandidateScan = {
  ok: true;
  candidate: Fingerprint;
  gate: GateCheck;
  retentionTimeMs: number;
  retentionEligible: boolean;
  selectorRealpath: string;
};

function scanCurrentCandidate(rule: CleanupRule, path: string, nowMs: number, safeRoots: string[]): CurrentCandidateScan | { ok: false; reason: string; detail?: string } {
  const st = safeLstat(path);
  if (!st) return { ok: false, reason: "missing" };
  if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!selectorMatchesPath(rule, path, safeRoots)) return { ok: false, reason: "selector-changed" };
  if (!isInsideSafeRoot(path, safeRoots)) return { ok: false, reason: "realpath-outside-safe-roots" };
  if (rule.protectedBasenames?.includes(basename(path))) return { ok: false, reason: "protected-basename" };
  if (rule.excludeBasenames?.includes(basename(path))) return { ok: false, reason: "excluded-basename" };
  const protectedReason = neverSweepReason(path);
  if (protectedReason) return { ok: false, reason: "never-sweep-protected", detail: protectedReason };
  const gate = checkStructuralGate(rule, path, safeRoots, nowMs);
  if (!gate.ok) return gate;
  const retentionTimeMs = gate.info?.manifest.createdAtMs ?? st.mtimeMs;
  return {
    ok: true,
    candidate: { path, realpath: realpathSync(path), sha256: digestTarget(path).value },
    gate,
    retentionTimeMs,
    retentionEligible: retentionTimeMs <= nowMs - rule.retentionDays * DAY_MS,
    selectorRealpath: realpathSync(path),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProbeEvidence(left: ProbeEvidence, right: ProbeEvidence): boolean {
  return left.command === right.command
    && left.ok === right.ok
    && left.fingerprint === right.fingerprint;
}

function sameProbeEvidenceList(left: ProbeEvidence[], right: ProbeEvidence[]): boolean {
  return left.length === right.length && left.every((probe, index) => sameProbeEvidence(probe, right[index]!));
}

function deterministicProbeEvidence(probe: ProbeEvidence): ProbeEvidence {
  // stdoutJson and detail can contain observation-time data. The probe fingerprint already
  // commits to the configured assertions and their required values, which is the stable contract
  // that scan and pre-delete revalidation must compare.
  return { command: probe.command, ok: probe.ok, fingerprint: probe.fingerprint };
}

function preDeleteEvidenceMatches(expected: Fingerprint, digest: TargetDigest, realpath: string): boolean {
  return expected.realpath === realpath && expected.sha256 === digest.value;
}

function candidateProbeEvidence(rule: CleanupRule, path: string, gate: GateCheck): ProbeEvidence[] | { ok: false; detail: string } {
  if (rule.gate?.kind !== "snapshot-manifest" || !gate.ok || !gate.info) return [];
  const values = { path, basename: basename(path), snapshotId: basename(path) };
  const probes = [runControlledProbe(rule.gate.restoreDryRunProbe!, values)];
  for (const archivePath of gate.info.archivePaths) probes.push(runControlledProbe(rule.gate.tarProbe!, { ...values, archivePath }));
  const failed = probes.find((probe) => !probe.ok);
  return failed ? { ok: false, detail: failed.detail ?? failed.command } : probes;
}

function anchorProbeEvidence(rule: CleanupRule, anchorPath: string): ProbeEvidence[] | { ok: false; detail: string } {
  if (rule.gate?.kind !== "snapshot-manifest") return [];
  const inspected = inspectSnapshotGate(anchorPath, rule.gate);
  if (!inspected.ok) return { ok: false, detail: inspected.detail ?? inspected.reason };
  const values = { path: anchorPath, basename: basename(anchorPath), snapshotId: basename(anchorPath) };
  const probes = [
    runControlledProbe(rule.gate.restoreDryRunProbe!, values),
    runControlledProbe(rule.gate.verifyCurrentProbe!, values),
  ];
  for (const archivePath of inspected.info!.archivePaths) {
    probes.push(runControlledProbe(rule.gate.tarProbe!, { ...values, archivePath }));
  }
  const failed = probes.find((probe) => !probe.ok);
  return failed ? { ok: false, detail: failed.detail ?? failed.command } : probes;
}

function revalidateCandidateBeforeDelete(
  candidate: CleanupCandidate,
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  anchors: Map<string, string[]>,
): { ok: true; evidence: ScanEvidence } | { ok: false; reason: string; detail: string; retentionGroupFailure?: boolean } {
  const scan = scanCurrentCandidate(rule, candidate.path, nowMs, safeRoots);
  if (!scan.ok) return { ok: false, reason: "pre-delete-evidence-failed", detail: scan.detail ?? scan.reason };
  const gate = scan.gate;
  if (!gate.ok) return { ok: false, reason: "pre-delete-evidence-failed", detail: gate.detail ?? gate.reason };
  if (!scan.retentionEligible && !rule.retention) return { ok: false, reason: "pre-delete-evidence-failed", detail: "retention eligibility changed" };
  const currentEvidence: ScanEvidence = {
    scannedAtMs: Date.now(),
    selector: {
      basename: basename(candidate.path),
      realpath: scan.selectorRealpath,
      retentionEligible: scan.retentionEligible,
      retentionTimeMs: scan.retentionTimeMs,
    },
    candidate: scan.candidate,
    ...(gate.source ? { source: gate.source } : {}),
    ...(gate.contract ? { contract: gate.contract } : {}),
    ...(rule.gate ? {
      gate: {
        kind: rule.gate.kind,
        fingerprint: gate.fingerprint,
        ...(gate.info ? { manifest: gate.info.manifest, archives: gate.info.archives } : {}),
      },
    } : {}),
  };
  if (rule.gate?.kind === "snapshot-manifest") {
    const probes = candidateProbeEvidence(rule, candidate.path, gate);
    if (!Array.isArray(probes)) return { ok: false, reason: "pre-delete-evidence-failed", detail: probes.detail };
    currentEvidence.gate!.probes = probes;
  }
  const storedRetention = candidate.scanEvidence?.retention;
  const { retention: _currentRetention, ...currentWithoutRetention } = currentEvidence;
  const { retention: _storedRetention, ...storedWithoutRetention } = candidate.scanEvidence ?? {};
  if (!candidate.scanEvidence || !sameJson({ ...storedWithoutRetention, scannedAtMs: 0 }, { ...currentWithoutRetention, scannedAtMs: 0 })) {
    return { ok: false, reason: "pre-delete-evidence-failed", detail: "candidate/source/gate fingerprint changed after scan" };
  }

  if (rule.retention) {
    const parent = dirname(candidate.path);
    const currentGroup: CurrentCandidateScan[] = [];
    for (const child of safeReaddir(parent) ?? []) {
      const childPath = join(parent, child);
      const item = scanCurrentCandidate(rule, childPath, nowMs, safeRoots);
      if (item.ok) currentGroup.push(item);
    }
    currentGroup.sort((a, b) => b.retentionTimeMs - a.retentionTimeMs || (a.candidate.path < b.candidate.path ? -1 : a.candidate.path > b.candidate.path ? 1 : 0));
    const rank = currentGroup.findIndex((item) => item.candidate.path === candidate.path);
    const floorPaths = currentGroup.slice(0, rule.retention.retainNewest).map((item) => item.candidate.path);
    if (rank < rule.retention.retainNewest || currentEvidence.selector.retentionTimeMs > nowMs - rule.retentionDays * DAY_MS) {
      return { ok: false, reason: "pre-delete-evidence-failed", detail: "retention floor or age eligibility changed" };
    }
    if (!storedRetention || storedRetention.rank !== rank || !sameJson(storedRetention.floorPaths, floorPaths)) {
      return { ok: false, reason: "pre-delete-evidence-failed", detail: "retention floor/rank changed after scan" };
    }
    const declaredAnchorPaths = (anchors.get(rule.id) ?? []).filter((path) => dirname(path) === parent);
    if (!sameJson(declaredAnchorPaths, floorPaths)) {
      return { ok: false, reason: "pre-delete-evidence-failed", detail: "retained anchor set changed after scan", retentionGroupFailure: true };
    }
    if (!storedRetention.retainedAnchors || !sameJson(storedRetention.retainedAnchors.map((anchor) => anchor.candidate.path), declaredAnchorPaths)) {
      return { ok: false, reason: "pre-delete-evidence-failed", detail: "retained anchor evidence is incomplete", retentionGroupFailure: true };
    }
    const retainedAnchors: Array<{ candidate: Fingerprint; probes?: ProbeEvidence[] }> = [];
    for (const anchorPath of declaredAnchorPaths) {
      const currentAnchor = currentGroup.find((item) => item.candidate.path === anchorPath);
      const storedAnchor = storedRetention.retainedAnchors.find((anchor) => anchor.candidate.path === anchorPath);
      if (!currentAnchor || !storedAnchor || !sameJson(currentAnchor.candidate, storedAnchor.candidate)) {
        return { ok: false, reason: "pre-delete-evidence-failed", detail: `retained anchor fingerprint changed: ${anchorPath}`, retentionGroupFailure: true };
      }
      const anchorProbes = anchorProbeEvidence(rule, anchorPath);
      if (!Array.isArray(anchorProbes)) return { ok: false, reason: "pre-delete-evidence-failed", detail: `retained anchor probe failed: ${anchorProbes.detail}`, retentionGroupFailure: true };
      if (rule.gate?.kind === "snapshot-manifest" && (!storedAnchor.probes || !sameProbeEvidenceList(storedAnchor.probes, anchorProbes))) {
        return { ok: false, reason: "pre-delete-evidence-failed", detail: `retained anchor restore/current/tar evidence changed: ${anchorPath}`, retentionGroupFailure: true };
      }
      retainedAnchors.push({ candidate: currentAnchor.candidate, ...(rule.gate?.kind === "snapshot-manifest" ? { probes: anchorProbes.map(deterministicProbeEvidence) } : {}) });
    }
    currentEvidence.retention = {
      rank,
      floorPaths,
      retainedAnchors,
    };
  }
  return { ok: true, evidence: currentEvidence };
}

function applyDeletes(summary: CleanupSummary, config: CleanupConfig, nowMs: number, sidecarPath: string, safeRoots: string[], retentionAnchors: Map<string, string[]>, beforeDelete?: (candidate: CleanupCandidate) => void, beforePreDeleteCapture?: (candidate: CleanupCandidate) => void): void {
  const maxDeleteBytes = config.maxDeleteBytes ?? Number.MAX_SAFE_INTEGER;
  const rulesById = new Map(config.rules.map((rule) => [rule.id, rule]));
  const heldRetentionGroups = new Map<string, string>();
  const retentionGroupKey = (candidate: CleanupCandidate): string => `${candidate.ruleId}\u0000${dirname(candidate.path)}`;
  let deletedBytes = 0;
  const sidecarFd = openSync(sidecarPath, "a", 0o600);
  try {
    for (const candidate of summary.candidates) {
      const groupKey = retentionGroupKey(candidate);
      const heldReason = heldRetentionGroups.get(groupKey);
      if (heldReason) {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "retention-group-held", detail: heldReason });
        continue;
      }
      if (deletedBytes + candidate.bytes > maxDeleteBytes) {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "max-delete-bytes" });
        continue;
      }

      const gate = checkRecoveryContract(rulesById.get(candidate.ruleId));
      if (!gate.ok) {
        summary.audit.recoveryGatedCandidates += 1;
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "missing-recovery-probe", detail: gate.reason });
        continue;
      }

      beforeDelete?.(candidate);
      const rule = rulesById.get(candidate.ruleId);
      if (!rule) {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "pre-delete-evidence-failed", detail: "rule disappeared after scan" });
        continue;
      }
      const revalidated = revalidateCandidateBeforeDelete(candidate, rule, safeRoots, nowMs, retentionAnchors);
      if (!revalidated.ok) {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: revalidated.reason, detail: revalidated.detail });
        if (revalidated.retentionGroupFailure) heldRetentionGroups.set(groupKey, `retained anchor pre-delete evidence failed; remaining candidates held: ${revalidated.detail}`);
        continue;
      }

      let preDelete: DeletionAuditRecord["preDelete"];
      try {
        beforePreDeleteCapture?.(candidate);
        const finalRevalidated = revalidateCandidateBeforeDelete(candidate, rule, safeRoots, nowMs, retentionAnchors);
        if (!finalRevalidated.ok) {
          summary.skipped.push({
            ruleId: candidate.ruleId,
            path: candidate.path,
            reason: finalRevalidated.reason,
            detail: `final pre-delete full evidence changed after revalidation: ${finalRevalidated.detail}`,
          });
          if (finalRevalidated.retentionGroupFailure) heldRetentionGroups.set(groupKey, `retained anchor pre-delete evidence failed; remaining candidates held: ${finalRevalidated.detail}`);
          continue;
        }
        // The final evidence pass is deliberately ordered before the digest/realpath check and rmSync.
        // A filesystem change can still occur between the last check and rmSync; this is not atomic.
        const digest = digestTarget(candidate.path);
        const candidateRealpath = realpathSync(candidate.path);
        if (!preDeleteEvidenceMatches(finalRevalidated.evidence.candidate, digest, candidateRealpath)) {
          summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "pre-delete-evidence-failed", detail: "final pre-delete digest/realpath changed after revalidation" });
          continue;
        }
        preDelete = {
          capturedAtMs: Date.now(),
          bytes: digest.bytes,
          digest,
          recovery: materializeRecovery(gate.contract, candidate.path),
          realpath: candidateRealpath,
          scanEvidence: finalRevalidated.evidence,
        };
      } catch (err) {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "pre-delete-evidence-failed", detail: errorMessage(err) });
        continue;
      }
      summary.audit.digestsCaptured += 1;

      if (candidate.ruleId === CODEX_SESSION_TRANSCRIPTS_RULE_ID) {
        try {
          const archivedThreadIds = archiveCodexStateThreadsForPath(
            candidate.path,
            config,
            Math.floor(nowMs / 1000),
          );
          if (archivedThreadIds.length > 0) {
            summary.codexStateArchives ??= [];
            summary.codexStateArchives.push({ path: candidate.path, archivedThreadIds });
            preDelete.codexStateArchivedThreadIds = archivedThreadIds;
          }
        } catch {
          summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "codex-state-archive-failed" });
          continue;
        }
      }

      try {
        appendAuditSidecarEvent(sidecarFd, {
          schema: "weekly-cache-cleanup-apply-audit/v1",
          event: "pre-delete",
          ruleId: candidate.ruleId,
          owner: candidate.owner,
          path: candidate.path,
          bytes: preDelete.bytes,
          digest: preDelete.digest,
          recovery: preDelete.recovery,
          capturedAtMs: preDelete.capturedAtMs,
          realpath: preDelete.realpath,
          scanEvidence: preDelete.scanEvidence,
          ...(preDelete.codexStateArchivedThreadIds === undefined
            ? {}
            : { codexStateArchivedThreadIds: preDelete.codexStateArchivedThreadIds }),
        });
      } catch (err) {
        summary.audit.failures += 1;
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "pre-delete-evidence-failed", detail: `audit sidecar: ${errorMessage(err)}` });
        continue;
      }

      const record: DeletionAuditRecord = {
        ruleId: candidate.ruleId,
        owner: candidate.owner,
        path: candidate.path,
        preDelete,
        deleteResult: { attempted: true, ok: false },
        postDelete: { checkedAtMs: 0, exists: true },
      };
      summary.audit.deletionsAttempted += 1;
      try {
        rmSync(candidate.path, { recursive: true, force: true });
        record.deleteResult = { attempted: true, ok: true };
      } catch (err) {
        record.deleteResult = { attempted: true, ok: false, error: errorMessage(err) };
      }
      record.postDelete = { checkedAtMs: Date.now(), exists: safeLstat(candidate.path) !== null };
      summary.auditChain.push(record);

      let sidecarError: string | undefined;
      try {
        appendAuditSidecarEvent(sidecarFd, {
          schema: "weekly-cache-cleanup-apply-audit/v1",
          event: "delete-result",
          ruleId: candidate.ruleId,
          owner: candidate.owner,
          path: candidate.path,
          deleteResult: record.deleteResult,
          postDelete: record.postDelete,
        });
      } catch (err) {
        sidecarError = errorMessage(err);
      }

      if (record.deleteResult.ok && !record.postDelete.exists) {
        summary.audit.deletionsSucceeded += 1;
        summary.audit.postDeleteVerifiedAbsent += 1;
        summary.deleted.push(candidate);
        deletedBytes += candidate.bytes;
      } else {
        summary.audit.failures += 1;
        summary.deleteFailures.push({
          ruleId: candidate.ruleId,
          path: candidate.path,
          phase: record.deleteResult.ok ? "post-delete-readback" : "delete",
          error: record.deleteResult.error ?? "target still exists after delete",
        });
      }

      if (sidecarError) {
        summary.audit.failures += 1;
        summary.deleteFailures.push({
          ruleId: candidate.ruleId,
          path: candidate.path,
          phase: "audit-sidecar",
          error: sidecarError,
        });
      }
    }
  } finally {
    closeSync(sidecarFd);
  }
}

function applyRetentionFloors(summary: CleanupSummary, config: CleanupConfig, nowMs: number): Map<string, string[]> {
  const anchors = new Map<string, string[]>();
  for (const rule of config.rules) {
    if (!rule.retention) continue;
    const entries = summary.candidates.filter((candidate) => candidate.ruleId === rule.id);
    const byParent = new Map<string, CleanupCandidate[]>();
    for (const entry of entries) {
      const parent = dirname(entry.path);
      const group = byParent.get(parent) ?? [];
      group.push(entry);
      byParent.set(parent, group);
    }
    const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
    const retainedPaths: string[] = [];
    const admitted: CleanupCandidate[] = [];
    for (const group of byParent.values()) {
      group.sort((a, b) => b.retentionTimeMs - a.retentionTimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const floor = group.slice(0, rule.retention.retainNewest);
      retainedPaths.push(...floor.map((entry) => entry.path));
      const floorPaths = floor.map((entry) => entry.path);
      for (const [rank, entry] of group.entries()) {
        if (entry.scanEvidence) {
          entry.scanEvidence.retention = {
            rank,
            floorPaths,
            retainedAnchors: floor.flatMap((anchor) => anchor.scanEvidence ? [{ candidate: anchor.scanEvidence.candidate }] : []),
          };
        }
      }
      admitted.push(...group.slice(rule.retention.retainNewest).filter((entry) => entry.retentionTimeMs <= cutoffMs));
    }
    anchors.set(rule.id, retainedPaths);
    summary.candidates = summary.candidates.filter((candidate) => candidate.ruleId !== rule.id);
    summary.candidates.push(...admitted.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return anchors;
}

function recordProbe(summary: CleanupSummary, input: {
  ruleId: string;
  path: string;
  phase: "candidate" | "retention-anchor";
  probe: string;
  ok: boolean;
  detail?: string;
}): void {
  summary.probeResults ??= [];
  summary.probeResults.push(input);
}

function runRetentionProbes(summary: CleanupSummary, config: CleanupConfig, anchors: Map<string, string[]>): void {
  const rulesById = new Map(config.rules.map((rule) => [rule.id, rule]));
  for (const candidate of summary.candidates) {
    const rule = rulesById.get(candidate.ruleId);
    if (rule?.gate?.kind !== "snapshot-manifest") continue;
    const inspected = inspectSnapshotGate(candidate.path, rule.gate);
    if (!inspected.ok || !inspected.info) {
      summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: inspected.ok ? "snapshot-manifest-invalid" : inspected.reason, ...(inspected.ok ? {} : inspected.detail ? { detail: inspected.detail } : {}) });
      summary.candidates = summary.candidates.filter((entry) => entry !== candidate);
      continue;
    }
    const values = { path: candidate.path, basename: basename(candidate.path), snapshotId: basename(candidate.path) };
    const restoreProbe = runControlledProbe(rule.gate.restoreDryRunProbe!, values);
    const candidateEvidence = candidate.scanEvidence?.gate;
    if (candidateEvidence) candidateEvidence.probes = [restoreProbe];
    recordProbe(summary, { ruleId: rule.id, path: candidate.path, phase: "candidate", probe: restoreProbe.command, ok: restoreProbe.ok, ...(restoreProbe.detail ? { detail: restoreProbe.detail } : {}) });
    for (const archivePath of inspected.info.archivePaths) {
      const tarProbe = runControlledProbe(rule.gate.tarProbe!, { ...values, archivePath });
      if (candidateEvidence) {
        candidateEvidence.probes ??= [];
        candidateEvidence.probes.push(tarProbe);
      }
      recordProbe(summary, { ruleId: rule.id, path: candidate.path, phase: "candidate", probe: tarProbe.command, ok: tarProbe.ok, ...(tarProbe.detail ? { detail: tarProbe.detail } : {}) });
      if (!tarProbe.ok) {
        summary.skipped.push({ ruleId: rule.id, path: candidate.path, reason: "probe-failed", detail: tarProbe.detail ?? tarProbe.command });
        summary.candidates = summary.candidates.filter((entry) => entry !== candidate);
        break;
      }
    }
    if (!restoreProbe.ok && summary.candidates.includes(candidate)) {
      summary.skipped.push({ ruleId: rule.id, path: candidate.path, reason: "probe-failed", detail: restoreProbe.detail ?? restoreProbe.command });
      summary.candidates = summary.candidates.filter((entry) => entry !== candidate);
    }
  }

  for (const [ruleId, paths] of anchors) {
    const rule = rulesById.get(ruleId);
    if (rule?.gate?.kind !== "snapshot-manifest" || paths.length === 0) continue;
    for (const anchorPath of paths) {
      const anchorProbes = anchorProbeEvidence(rule, anchorPath);
      if (!Array.isArray(anchorProbes)) {
        for (const candidate of summary.candidates.filter((entry) => entry.ruleId === ruleId)) {
          summary.skipped.push({ ruleId, path: candidate.path, reason: "retention-anchor-probe-failed", detail: anchorProbes.detail });
        }
        summary.candidates = summary.candidates.filter((entry) => entry.ruleId !== ruleId);
        continue;
      }
      for (const candidate of summary.candidates.filter((entry) => entry.ruleId === ruleId)) {
        const anchor = candidate.scanEvidence?.retention?.retainedAnchors?.find((entry) => entry.candidate.path === anchorPath);
        if (anchor) anchor.probes = anchorProbes.map(deterministicProbeEvidence);
      }
      for (const result of anchorProbes) {
        recordProbe(summary, { ruleId, path: anchorPath, phase: "retention-anchor", probe: result.command, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) });
      }
      const failedProbe = anchorProbes.find((probe) => !probe.ok);
      if (failedProbe) {
        const detail = failedProbe.detail ?? failedProbe.command;
        for (const candidate of summary.candidates.filter((entry) => entry.ruleId === ruleId)) {
          summary.skipped.push({ ruleId, path: candidate.path, reason: "retention-anchor-probe-failed", detail });
        }
        summary.candidates = summary.candidates.filter((entry) => entry.ruleId !== ruleId);
      }
    }
  }
}

function ruleTouchesUvCache(rule: CleanupRule): boolean {
  return rule.paths.some((path) => {
    const lexicalPath = resolve(path);
    const effectivePath = effectivePathForComparison(path);
    return isEqualOrBelow(lexicalPath, UV_CACHE_ROOT)
      || isEqualOrBelow(UV_CACHE_ROOT, lexicalPath)
      || isEqualOrBelow(effectivePath, UV_CACHE_ROOT)
      || isEqualOrBelow(UV_CACHE_ROOT, effectivePath);
  });
}

export function runCleanup(config: CleanupConfig, options: {
  apply: boolean;
  configPath: string;
  nowMs?: number;
  receiptDir?: string;
  beforeDelete?: (candidate: CleanupCandidate) => void;
  beforePreDeleteCapture?: (candidate: CleanupCandidate) => void;
  nativeUvCommandRunner?: NativeUvCommandRunner;
  nativeUvRootObserver?: NativeUvRootObserver;
}): CleanupSummary {
  config = validateConfig(config);
  const nowMs = options.nowMs ?? Date.now();
  const safeRoots = normalizeSafeRoots(config);
  const mode: CleanupSummary["mode"] = options.apply ? "apply" : "dry-run";
  const summary: CleanupSummary = {
    mode,
    configPath: options.configPath,
    candidates: [],
    deleted: [],
    skipped: [],
    auditChain: [],
    deleteFailures: [],
    audit: {
      mode,
      digestAlgorithm: "sha256",
      directoryManifestVersion: DIRECTORY_MANIFEST_VERSION,
      digestsCaptured: 0,
      deletionsAttempted: 0,
      deletionsSucceeded: 0,
      postDeleteVerifiedAbsent: 0,
      failures: 0,
      recoveryGatedCandidates: 0,
      note: options.apply
        ? "apply: the fsynced auditChainSidecar is authoritative pre-delete evidence; auditChain is the end-of-run summary"
        : "dry-run: no digest was computed, nothing was deleted, and auditChain is intentionally empty",
    },
    totalCandidateBytes: 0,
    totalDeletedBytes: 0,
    totalNativeDeletedBytes: 0,
    stageTimingsMs: { scanMs: 0, recoveryGateMs: 0, retentionFloorMs: 0, retentionProbeMs: 0, applyMs: 0, totalMs: 0, perRuleScanMs: {} },
  };

  const startedAtMs = Date.now();
  const timings = summary.stageTimingsMs;
  const nativeRules: CleanupRule[] = [];
  for (const rule of config.rules) {
    const ruleStartedAtMs = Date.now();
    if (rule.safetyState === "blocked") {
      for (const path of rule.paths) {
        summary.skipped.push({
          ruleId: rule.id,
          path,
          reason: rule.enabled ? "rule-safety-blocked" : "rule-disabled",
        });
      }
      continue;
    }
    if (!rule.enabled) {
      for (const path of rule.paths) {
        summary.skipped.push({ ruleId: rule.id, path, reason: "rule-disabled" });
      }
      continue;
    }
    if (ruleTouchesUvCache(rule) && rule.action !== "uv_cache_prune") {
      for (const path of rule.paths) {
        summary.skipped.push({ ruleId: rule.id, path, reason: "uv-native-required", detail: "generic rmSync is forbidden for the uv cache" });
      }
      continue;
    }
    if (rule.action === "uv_cache_prune") {
      nativeRules.push(rule);
      continue;
    }
    if (rule.action === "delete_owner_contract_candidates") {
      collectContractCandidates(rule, safeRoots, nowMs, summary, options.apply);
    } else if (rule.action === "delete_children_older_than") {
      collectChildren(rule, safeRoots, nowMs, summary, options.apply);
    } else if (rule.action === "delete_named_descendants_older_than") {
      collectNamedDescendants(rule, safeRoots, nowMs, summary, options.apply);
    } else {
      collectMatchingFiles(rule, safeRoots, nowMs, summary, options.apply);
    }
    timings.perRuleScanMs[rule.id] = (timings.perRuleScanMs[rule.id] ?? 0) + (Date.now() - ruleStartedAtMs);
  }
  timings.scanMs = Date.now() - startedAtMs;

  const gateStartedAtMs = Date.now();
  gateCandidatesWithoutRecoveryProbe(summary, config);
  timings.recoveryGateMs = Date.now() - gateStartedAtMs;
  const floorStartedAtMs = Date.now();
  const retentionAnchors = applyRetentionFloors(summary, config, nowMs);
  timings.retentionFloorMs = Date.now() - floorStartedAtMs;
  const probeStartedAtMs = Date.now();
  runRetentionProbes(summary, config, retentionAnchors);
  timings.retentionProbeMs = Date.now() - probeStartedAtMs;
  summary.totalCandidateBytes = summary.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (options.apply) {
    if (!options.receiptDir) throw new Error("receiptDir is required in apply mode");
    mkdirSync(options.receiptDir, { recursive: true });
    summary.auditChainSidecar = auditChainSidecarPath(options.receiptDir, nowMs);
    const applyStartedAtMs = Date.now();
    applyDeletes(summary, config, nowMs, summary.auditChainSidecar, safeRoots, retentionAnchors, options.beforeDelete, options.beforePreDeleteCapture);
    timings.applyMs = Date.now() - applyStartedAtMs;
  }
  summary.totalDeletedBytes = summary.deleted.reduce((sum, candidate) => sum + candidate.bytes, 0);

  // Generic deletion is deliberately complete before native uv pruning. The native command gets
  // only the remaining global byte budget, and an uncertain native result cannot erase or relabel
  // the already verified generic deletion receipt; there is no later mutation in this run.
  for (const rule of nativeRules) {
    const ruleStartedAtMs = Date.now();
    const remainingNativeBudget = Math.max(
      0,
      (config.maxDeleteBytes ?? Number.MAX_SAFE_INTEGER) - summary.totalDeletedBytes - summary.totalNativeDeletedBytes,
    );
    const nativeReceipt = runNativeUvCachePrune({
      rule,
      safeRoots,
      apply: options.apply,
      maxDeleteBytes: remainingNativeBudget,
      ...(options.receiptDir === undefined ? {} : { receiptDir: options.receiptDir }),
      nowMs,
      commandRunner: options.nativeUvCommandRunner ?? defaultNativeUvCommandRunner,
      rootObserver: options.nativeUvRootObserver ?? observeNativeUvRoot,
    });
    summary.nativeUvPrunes ??= [];
    summary.nativeUvPrunes.push(nativeReceipt);
    if (nativeReceipt.deletionVerified && nativeReceipt.logicalBytesRemoved !== null) {
      summary.totalNativeDeletedBytes += nativeReceipt.logicalBytesRemoved;
    }
    if (options.apply && nativeReceipt.mutationOutcome !== "verified") {
      summary.skipped.push({
        ruleId: nativeReceipt.ruleId,
        path: nativeReceipt.root,
        reason: "native-uv-uncertain-result",
        detail: nativeReceipt.failureReason ?? "uv native result was not verified; no later native mutation was attempted",
      });
      break;
    }
    timings.perRuleScanMs[rule.id] = (timings.perRuleScanMs[rule.id] ?? 0) + (Date.now() - ruleStartedAtMs);
  }
  timings.totalMs = Date.now() - startedAtMs;
  return summary;
}

export function writeReceipt(summary: CleanupSummary, receiptDir: string, nowMs: number): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = receiptStamp(nowMs);
  const receiptPath = join(receiptDir, `${stamp}-${summary.mode}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return receiptPath;
}

function shanghaiDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(ms));
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function safeOwnerSlug(owner: string): string {
  return owner.replace(/[^a-zA-Z0-9_.-]/gu, "_");
}

function markerPathFor(receiptPath: string, owner: string): string {
  return `${receiptPath}.impact-review.${safeOwnerSlug(owner)}.json`;
}

function readCleanupReceipt(path: string): CleanupSummary | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CleanupSummary;
  } catch {
    return null;
  }
}

function ownerGroups(summary: CleanupSummary): Array<{
  owner: string;
  deleted: CleanupCandidate[];
  deletedBytes: number;
  ruleIds: string[];
  samplePaths: string[];
}> {
  const groups = new Map<string, CleanupCandidate[]>();
  for (const item of summary.deleted ?? []) {
    const items = groups.get(item.owner) ?? [];
    items.push(item);
    groups.set(item.owner, items);
  }
  return Array.from(groups.entries()).map(([owner, deleted]) => ({
    owner,
    deleted,
    deletedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
    ruleIds: Array.from(new Set(deleted.map((item) => item.ruleId))).sort(),
    samplePaths: deleted.slice(0, 25).map((item) => item.path),
  }));
}

function buildImpactReviewPrompt(input: {
  owner: string;
  receiptPath: string;
  clientRequestId: string;
  notifyEndpoint: string;
  reviewedAt: string;
  deletedCount: number;
  deletedBytes: number;
  ruleIds: string[];
  currentConfigPath: string;
  currentRuleStates: ImpactReviewRuleState[];
  samplePaths: string[];
}): string {
  return [
    "weekly-cache-cleanup 影响回访：请检查上一轮自动清理是否对你负责的工作区造成不良影响。",
    "",
    "review_kind: delayed_historical_receipt",
    `reviewed_at: ${input.reviewedAt}`,
    `receipt: ${input.receiptPath}`,
    `owner: ${input.owner}`,
    `deleted_count: ${input.deletedCount}`,
    `deleted_bytes: ${input.deletedBytes}`,
    `rules: ${input.ruleIds.join(", ") || "(none)"}`,
    `current_config_path: ${input.currentConfigPath}`,
    "current_rule_states:",
    ...input.currentRuleStates.map((state) => (
      `- ${state.ruleId}: ${state.status}${state.safetyState ? ` (safetyState=${state.safetyState})` : ""}`
    )),
    "",
    "sample_paths:",
    ...input.samplePaths.map((path) => `- ${path}`),
    "",
    "请按以下顺序处置：",
    "1. 先按删除当时生效的 selector、retention / expiresAt、safe root 和托管 receipt 判断是否违反策略；符合 retention / expiresAt 的到期删除属于预期行为，不能仅因原文件现在不可读就判为事故。",
    "2. 只有提前删除、越过 selector / safe root、删除活库或删除仍 active 的托管快照才算不良影响；另需检查删除是否直接导致任务失败或在承诺保留期内丢失业务证据。",
    "3. 如果属于预期到期且没有影响，在最终回复里写 `cleanup impact: none`，并列出你检查过的策略与运行证据。",
    "4. 如果确认有不良影响，先识别直接致因的 cleanup rule。若致因 rule 当前仍为 enabled，必须先执行 fail-safe：在现有配置中只把该 rule 改为 enabled=false；当前 session 无权修改时，通过 /api/spawn2.0 交给 cachem 并等待配置回读与 rule-disabled 证据。事故处置阶段不要直接上线未经评审的新 selector。",
    `5. 完成上述熔断尝试后，必须 POST \`${input.notifyEndpoint}\` 发 \`level=error\` 通知卡片；source 用你的 owner 名，title 包含 \`weekly-cache-cleanup 清理影响\`。本次是历史回执延迟审计，不能表述成今天再次删除。`,
    "6. 卡片 body 除 receipt、受影响路径、症状、恢复动作外，必须逐项写明：",
    "   - 回访性质：历史回执延迟审计 / 新增事故",
    "   - 规则当前状态：每个致因 rule 的 enabled / disabled / missing",
    "   - 规则调整状态：adjusted_now / already_disabled / adjustment_failed",
    "   - 调整证据：commit、config 路径及最新 receipt/dry-run 的 rule-disabled 读回",
    "   - 调整后是否仍有新增删除：yes / no / unknown",
    "   如果熔断失败也必须发卡，并明确 blocker，不能省略“规则调整状态”。",
    "7. 最终回复写 `cleanup impact: adverse`，并复述规则调整状态（adjusted_now / already_disabled / adjustment_failed）。",
    "",
    `[weekly_cache_cleanup_impact_review_anchor] ${input.clientRequestId}`,
  ].join("\n");
}

function impactReviewRuleStates(ruleIds: string[], config?: CleanupConfig): ImpactReviewRuleState[] {
  const rulesById = new Map((config?.rules ?? []).map((rule) => [rule.id, rule]));
  return ruleIds.map((ruleId) => {
    const rule = rulesById.get(ruleId);
    if (!config) return { ruleId, status: "unknown" };
    if (!rule) return { ruleId, status: "missing" };
    return {
      ruleId,
      status: rule.enabled ? "enabled" : "disabled",
      ...(rule.safetyState ? { safetyState: rule.safetyState } : {}),
    };
  });
}

async function defaultPostJson(url: string, body: unknown, timeoutMs: number): Promise<PostJsonResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (err) {
    return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function postSucceeded(result: PostJsonResult): boolean {
  if (!result.ok) return false;
  try {
    const parsed: unknown = JSON.parse(result.text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && (parsed as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function preview(text: string): string {
  return text.slice(0, 500);
}

async function sendDispatchFailureNotify(input: {
  apiBase: string;
  owner: string;
  receiptPath: string;
  clientRequestId: string;
  postResult: PostJsonResult;
  postJson: PostJson;
}): Promise<{ ok: boolean; status: number; responsePreview: string }> {
  const result = await input.postJson(`${input.apiBase}/api/notify`, {
    source: "cachem",
    title: "weekly-cache-cleanup 影响回访派发失败",
    body: [
      `owner: ${input.owner}`,
      `receipt: ${input.receiptPath}`,
      `client_request_id: ${input.clientRequestId}`,
      `spawn_status: ${input.postResult.status}`,
      `spawn_response: ${preview(input.postResult.text)}`,
      "",
      "需要人工确认该 owner 是否收到了上一轮清理影响回访；若未收到，请手动补发。",
    ].join("\n"),
    level: "error",
    metadata: {
      owner: input.owner,
      receiptPath: input.receiptPath,
      clientRequestId: input.clientRequestId,
      spawnStatus: input.postResult.status,
    },
  }, DEFAULT_HTTP_TIMEOUT_MS);
  return { ok: postSucceeded(result), status: result.status, responsePreview: preview(result.text) };
}

export async function dispatchPendingImpactReviews(input: {
  receiptDir: string;
  apiBase?: string;
  nowMs: number;
  minAgeDays?: number;
  currentConfig?: CleanupConfig;
  currentConfigPath?: string;
  postJson?: PostJson;
}): Promise<ImpactReviewSummary> {
  const apiBase = (input.apiBase ?? resolveApiBase(process.env)).replace(/\/$/u, "");
  const minAgeDays = input.minAgeDays ?? DEFAULT_IMPACT_REVIEW_MIN_AGE_DAYS;
  const postJson = input.postJson ?? defaultPostJson;
  const cutoffMs = input.nowMs - minAgeDays * DAY_MS;
  const summary: ImpactReviewSummary = {
    consideredReceipts: 0,
    requestedOwners: 0,
    succeededOwners: 0,
    failedOwners: 0,
    skippedOwners: 0,
    dispatches: [],
  };

  if (!existsSync(input.receiptDir)) return summary;

  for (const file of readdirSync(input.receiptDir).sort()) {
    if (!file.endsWith("-apply.json")) continue;
    const receiptPath = join(input.receiptDir, file);
    const st = statSync(receiptPath);
    if (st.mtimeMs > cutoffMs) continue;
    summary.consideredReceipts += 1;
    const receipt = readCleanupReceipt(receiptPath);
    if (!receipt || (receipt.deleted ?? []).length === 0) continue;

    for (const group of ownerGroups(receipt)) {
      const markerPath = markerPathFor(receiptPath, group.owner);
      if (existsSync(markerPath)) {
        summary.skippedOwners += 1;
        continue;
      }

      const clientRequestId = `${shanghaiDate(input.nowMs)}:weekly-cache-cleanup-impact:${group.owner}:${shortHash(`${receiptPath}:${group.owner}`)}`;
      const currentConfigPath = input.currentConfigPath ?? "(not supplied)";
      const currentRuleStates = impactReviewRuleStates(group.ruleIds, input.currentConfig);
      const prompt = buildImpactReviewPrompt({
        owner: group.owner,
        receiptPath,
        clientRequestId,
        notifyEndpoint: `${apiBase}/api/notify`,
        reviewedAt: new Date(input.nowMs).toISOString(),
        deletedCount: group.deleted.length,
        deletedBytes: group.deletedBytes,
        ruleIds: group.ruleIds,
        currentConfigPath,
        currentRuleStates,
        samplePaths: group.samplePaths,
      });
      const spawnBody = {
        target: group.owner,
        from: "cachem",
        prompt,
        client_request_id: clientRequestId,
        closure: { kind: "message", target: { type: "todo_pool" } },
      };

      summary.requestedOwners += 1;
      const result = await postJson(`${apiBase}/api/spawn2.0`, spawnBody, DEFAULT_HTTP_TIMEOUT_MS);
      const ok = postSucceeded(result);
      const dispatch: ImpactReviewDispatch = {
        sourceReceipt: receiptPath,
        owner: group.owner,
        clientRequestId,
        deletedCount: group.deleted.length,
        deletedBytes: group.deletedBytes,
        ruleIds: group.ruleIds,
        currentConfigPath,
        currentRuleStates,
        samplePaths: group.samplePaths,
        ok,
        status: result.status,
        responsePreview: preview(result.text),
      };

      if (ok) {
        dispatch.markerPath = markerPath;
        writeFileSync(markerPath, `${JSON.stringify({
          sourceReceipt: receiptPath,
          owner: group.owner,
          requestedAt: new Date(input.nowMs).toISOString(),
          clientRequestId,
          deletedCount: group.deleted.length,
          deletedBytes: group.deletedBytes,
          ruleIds: group.ruleIds,
          currentConfigPath,
          currentRuleStates,
          samplePaths: group.samplePaths,
          spawnStatus: result.status,
          spawnResponsePreview: preview(result.text),
        }, null, 2)}\n`, "utf8");
        summary.succeededOwners += 1;
      } else {
        dispatch.notify = await sendDispatchFailureNotify({
          apiBase,
          owner: group.owner,
          receiptPath,
          clientRequestId,
          postResult: result,
          postJson,
        });
        summary.failedOwners += 1;
      }

      summary.dispatches.push(dispatch);
    }
  }

  return summary;
}

export function diskFreeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

export async function sendCompletionNotify(input: {
  apiBase: string;
  summary: CleanupSummary;
  receiptPath: string;
  freeBytes: number | null;
  warnFreeBytes?: number;
  rebootHintFreeBytes?: number;
  notifyMinDeletedBytes?: number;
  postJson?: PostJson;
}): Promise<CompletionNotifyResult> {
  const warnFreeBytes = input.warnFreeBytes ?? DEFAULT_WARN_FREE_BYTES;
  const rebootHintFreeBytes = input.rebootHintFreeBytes ?? DEFAULT_REBOOT_HINT_FREE_BYTES;
  const notifyMinDeletedBytes = input.notifyMinDeletedBytes ?? DEFAULT_NOTIFY_MIN_DELETED_BYTES;
  const postJson = input.postJson ?? defaultPostJson;
  const lowDisk = input.freeBytes !== null && input.freeBytes < warnFreeBytes;
  const rebootRecommended = input.freeBytes !== null && input.freeBytes < rebootHintFreeBytes;
  const genericDeletedBytes = input.summary.totalDeletedBytes ?? 0;
  const nativeObservedCacheNetBytes = input.summary.totalNativeDeletedBytes ?? 0;
  const logicalDeletedBytes = genericDeletedBytes + nativeObservedCacheNetBytes;
  const nativeObservedFreeBytesDelta = nativeFreeBytesDelta(input.summary);
  const bigDelete = logicalDeletedBytes >= notifyMinDeletedBytes;
  if (!lowDisk && !bigDelete && !rebootRecommended) {
    return { attempted: false, reason: "below-notify-thresholds", freeBytes: input.freeBytes };
  }

  const level: "info" | "warn" = lowDisk ? "warn" : "info";
  const bodyLines = [
    `verified generic deleted: ${input.summary.deleted.length} 项, ${formatBytes(genericDeletedBytes)}`,
    `native uv observed cache net: ${formatBytes(nativeObservedCacheNetBytes)}`,
    `native uv observed df/free-space delta: ${nativeObservedFreeBytesDelta === null ? "unknown" : formatSignedBytes(nativeObservedFreeBytesDelta)}`,
    `logical deleted total (generic + native observed net): ${formatBytes(logicalDeletedBytes)}`,
    `disk free: ${input.freeBytes === null ? "unknown" : formatBytes(input.freeBytes)}`,
    `receipt: ${input.receiptPath}`,
  ];
  for (const prune of input.summary.nativeUvPrunes ?? []) {
    bodyLines.push(`native uv command ${prune.ruleId}: lock=${prune.lockStatus}, mutation=${prune.mutationOutcome}, verified=${prune.deletionVerified}`);
  }
  if (rebootRecommended) {
    bodyLines.push("restart hint: 剩余空间低于 10 GiB；macOS 可能仍持有 System Data/APFS 延迟回收空间，建议重启机器后复查磁盘空间。");
  }
  const result = await postJson(`${input.apiBase}/api/notify`, {
    source: "cachem",
    title: rebootRecommended ? "cache-cleanup 完成，建议重启释放系统空间" : lowDisk ? "cache-cleanup 完成，磁盘空间仍紧张" : "cache-cleanup 完成",
    body: bodyLines.join("\n"),
    level,
    metadata: {
      receiptPath: input.receiptPath,
      deletedBytes: logicalDeletedBytes,
      genericDeletedBytes,
      nativeObservedCacheNetBytes,
      nativeObservedFreeBytesDelta,
      logicalDeletedBytes,
      freeBytes: input.freeBytes,
      rebootRecommended,
      rebootHintFreeBytes,
    },
  }, DEFAULT_HTTP_TIMEOUT_MS);
  return {
    attempted: true,
    level,
    freeBytes: input.freeBytes,
    ok: postSucceeded(result),
    status: result.status,
    responsePreview: preview(result.text),
    rebootRecommended,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatSignedBytes(bytes: number): string {
  return `${bytes >= 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function nativeFreeBytesDelta(summary: CleanupSummary): number | null {
  const deltas = (summary.nativeUvPrunes ?? [])
    .filter((prune) => prune.deletionVerified && prune.physicalFreeBytesDelta !== null)
    .map((prune) => prune.physicalFreeBytesDelta!);
  return deltas.length === 0 ? null : deltas.reduce((sum, delta) => sum + delta, 0);
}

function printHuman(summary: CleanupSummary): void {
  console.log(`[weekly-cache-cleanup] mode=${summary.mode}`);
  console.log(`[weekly-cache-cleanup] candidates=${summary.candidates.length} bytes=${formatBytes(summary.totalCandidateBytes)}`);
  console.log(`[weekly-cache-cleanup] verified-generic-deleted=${summary.deleted.length} bytes=${formatBytes(summary.totalDeletedBytes)}`);
  console.log(`[weekly-cache-cleanup] native-uv-observed-cache-net=${formatBytes(summary.totalNativeDeletedBytes)}`);
  const nativeFreeDelta = nativeFreeBytesDelta(summary);
  console.log(`[weekly-cache-cleanup] native-uv-observed-df-free-space-delta=${nativeFreeDelta === null ? "unknown" : formatSignedBytes(nativeFreeDelta)}`);
  console.log(`[weekly-cache-cleanup] logical-deleted-total=${formatBytes(summary.totalDeletedBytes + summary.totalNativeDeletedBytes)} (generic + native observed net)`);
  for (const prune of summary.nativeUvPrunes ?? []) {
    console.log(`[weekly-cache-cleanup] native-uv-command rule=${prune.ruleId} lock=${prune.lockStatus} mutation=${prune.mutationOutcome} verified=${prune.deletionVerified} cache-net=${prune.logicalBytesRemoved === null ? "unknown" : formatBytes(prune.logicalBytesRemoved)} df-free-space-delta=${prune.physicalFreeBytesDelta === null ? "unknown" : formatSignedBytes(prune.physicalFreeBytesDelta)}`);
  }
  for (const candidate of summary.candidates.slice(0, 50)) {
    console.log(`[candidate] ${formatBytes(candidate.bytes)} ${candidate.ruleId} ${candidate.path}`);
  }
  const remaining = summary.candidates.length - 50;
  if (remaining > 0) console.log(`[weekly-cache-cleanup] ... ${remaining} more candidates omitted`);
  console.log(`[weekly-cache-cleanup] audit digests=${summary.audit.digestsCaptured} verified-absent=${summary.audit.postDeleteVerifiedAbsent} recovery-gated=${summary.audit.recoveryGatedCandidates} failures=${summary.audit.failures}`);
  for (const failure of summary.deleteFailures) {
    console.log(`[delete-failure] ${failure.phase} ${failure.ruleId} ${failure.path}: ${failure.error}`);
  }
  const disabled = summary.skipped.filter((entry) => entry.reason === "rule-disabled").length;
  if (disabled > 0) console.log(`[weekly-cache-cleanup] disabled-rule-paths=${disabled}`);
  const safetyBlocked = summary.skipped.filter((entry) => entry.reason === "rule-safety-blocked").length;
  if (safetyBlocked > 0) console.log(`[weekly-cache-cleanup] safety-blocked-rule-paths=${safetyBlocked}`);
  if (summary.impactReview) {
    console.log(`[weekly-cache-cleanup] impact-review requested=${summary.impactReview.requestedOwners} succeeded=${summary.impactReview.succeededOwners} failed=${summary.impactReview.failedOwners}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configPath);
  const summary = runCleanup(config, {
    apply: options.apply,
    configPath: options.configPath,
    nowMs: options.nowMs,
    receiptDir: options.receiptDir,
  });
  // Persist the deletion evidence chain before any post-delete side effect can throw; the later
  // writeReceipt call reuses the same nowMs-derived path and enriches it with those results.
  if (options.apply) writeReceipt(summary, options.receiptDir, options.nowMs);
  if (options.apply && !options.skipImpactReview) {
    summary.impactReview = await dispatchPendingImpactReviews({
      receiptDir: options.receiptDir,
      apiBase: options.apiBase,
      nowMs: options.nowMs,
      minAgeDays: options.impactReviewMinAgeDays,
      currentConfig: config,
      currentConfigPath: options.configPath,
    });
  }
  const receiptPath = writeReceipt(summary, options.receiptDir, options.nowMs);
  if (options.apply) {
    summary.completionNotify = await sendCompletionNotify({
      apiBase: options.apiBase,
      summary,
      receiptPath,
      freeBytes: diskFreeBytes(options.receiptDir),
    });
    if (summary.completionNotify.attempted && !summary.completionNotify.ok) {
      console.error(`[weekly-cache-cleanup] completion notify failed status=${summary.completionNotify.status}`);
    }
  }
  if (options.json) {
    console.log(JSON.stringify({ ...summary, receiptPath }, null, 2));
  } else {
    printHuman(summary);
    if (summary.completionNotify) {
      console.log(`[weekly-cache-cleanup] completion-notify attempted=${summary.completionNotify.attempted} level=${summary.completionNotify.level ?? "-"} ok=${summary.completionNotify.ok ?? "-"}`);
    }
    console.log(`[weekly-cache-cleanup] receipt=${receiptPath}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
