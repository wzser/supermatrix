#!/usr/bin/env tsx
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pruneManagedSqliteSnapshots } from "./managed-sqlite-snapshot.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_API_PORT = "3501";
const DEFAULT_IMPACT_REVIEW_MIN_AGE_DAYS = 6;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_WARN_FREE_BYTES = 20 * 1024 ** 3;
const DEFAULT_REBOOT_HINT_FREE_BYTES = 10 * 1024 ** 3;
const DEFAULT_NOTIFY_MIN_DELETED_BYTES = 512 * 1024 ** 2;
const CODEX_SESSION_TRANSCRIPTS_RULE_ID = "codex-session-transcripts-old-days";

type CleanupAction = "delete_children_older_than" | "delete_named_descendants_older_than";

export type CleanupRule = {
  id: string;
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
};

export type CleanupConfig = {
  version: number;
  safeRoots: string[];
  maxDeleteBytes?: number;
  codexStateDbPath?: string | null;
  rules: CleanupRule[];
};

export type CleanupCandidate = {
  ruleId: string;
  owner: string;
  path: string;
  bytes: number;
  mtimeMs: number;
};

export type CleanupSummary = {
  mode: "dry-run" | "apply";
  configPath: string;
  candidates: CleanupCandidate[];
  deleted: CleanupCandidate[];
  codexStateArchives?: Array<{ path: string; archivedThreadIds: string[] }>;
  skipped: Array<{ ruleId: string; path: string; reason: string }>;
  totalCandidateBytes: number;
  totalDeletedBytes: number;
  impactReview?: ImpactReviewSummary;
  completionNotify?: CompletionNotifyResult;
  managedSqliteSnapshotPrunes?: Array<{
    managedRoot: string;
    released: Array<{ snapshotId: string; reason: string }>;
    orphanedReleased: Array<{ snapshotId: string; reason: "orphan-hard-expiry" }>;
    skipped: string[];
  }>;
};

export async function pruneManagedSqliteSnapshotRoots(input: {
  auditDbPath: string;
  runtimeRoot: string;
  nowMs?: number;
}): Promise<NonNullable<CleanupSummary["managedSqliteSnapshotPrunes"]>> {
  const results: NonNullable<CleanupSummary["managedSqliteSnapshotPrunes"]> = [];
  for (const managedRoot of [
    join(input.runtimeRoot, "data", "codex-state-snapshots"),
    join(input.runtimeRoot, "data", "managed-sqlite-snapshots"),
  ]) {
    results.push({
      managedRoot,
      ...await pruneManagedSqliteSnapshots({
        auditDbPath: input.auditDbPath,
        managedRoot,
        ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
      }),
    });
  }
  return results;
}

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

function loadConfig(configPath: string): CleanupConfig {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as CleanupConfig;
  if (parsed.version !== 1) throw new Error(`unsupported config version: ${parsed.version}`);
  return parsed;
}

function normalizeSafeRoots(config: CleanupConfig): string[] {
  return config.safeRoots.map((root) => resolve(root));
}

function isInsideSafeRoot(path: string, safeRoots: string[]): boolean {
  const resolved = resolve(path);
  return safeRoots.some((root) => {
    const rel = relative(root, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
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

function basenameAllowed(name: string, rule: CleanupRule): boolean {
  const prefixes = rule.includeBasenamePrefixes;
  if (!prefixes || prefixes.length === 0) return true;
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function addCandidateIfOld(
  candidates: CleanupCandidate[],
  skipped: CleanupSummary["skipped"],
  rule: CleanupRule,
  path: string,
  cutoffMs: number,
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
  if (st.mtimeMs > cutoffMs) return;

  candidates.push({
    ruleId: rule.id,
    owner: rule.owner,
    path,
    bytes: entrySize(path),
    mtimeMs: st.mtimeMs,
  });
}

function collectChildren(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
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
      addCandidateIfOld(summary.candidates, summary.skipped, rule, join(resolvedParent, child), cutoffMs);
    }
  }
}

function walkNamedDescendants(
  root: string,
  rule: CleanupRule,
  safeRoots: string[],
  cutoffMs: number,
  summary: CleanupSummary,
  depth: number,
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
    if (childStat.isSymbolicLink() || !childStat.isDirectory()) continue;
    if (rule.names?.includes(child)) {
      addCandidateIfOld(summary.candidates, summary.skipped, rule, childPath, cutoffMs);
      continue;
    }
    walkNamedDescendants(childPath, rule, safeRoots, cutoffMs, summary, depth + 1);
  }
}

function collectNamedDescendants(
  rule: CleanupRule,
  safeRoots: string[],
  nowMs: number,
  summary: CleanupSummary,
): void {
  const cutoffMs = nowMs - rule.retentionDays * DAY_MS;
  for (const root of rule.paths) {
    walkNamedDescendants(resolve(root), rule, safeRoots, cutoffMs, summary, 0);
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

function applyDeletes(summary: CleanupSummary, config: CleanupConfig, nowMs: number): void {
  const maxDeleteBytes = config.maxDeleteBytes ?? Number.MAX_SAFE_INTEGER;
  let deletedBytes = 0;
  for (const candidate of summary.candidates) {
    if (deletedBytes + candidate.bytes > maxDeleteBytes) {
      summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "max-delete-bytes" });
      continue;
    }
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
        }
      } catch {
        summary.skipped.push({ ruleId: candidate.ruleId, path: candidate.path, reason: "codex-state-archive-failed" });
        continue;
      }
    }
    rmSync(candidate.path, { recursive: true, force: true });
    summary.deleted.push(candidate);
    deletedBytes += candidate.bytes;
  }
}

export function runCleanup(config: CleanupConfig, options: { apply: boolean; configPath: string; nowMs?: number }): CleanupSummary {
  const nowMs = options.nowMs ?? Date.now();
  const safeRoots = normalizeSafeRoots(config);
  const summary: CleanupSummary = {
    mode: options.apply ? "apply" : "dry-run",
    configPath: options.configPath,
    candidates: [],
    deleted: [],
    skipped: [],
    totalCandidateBytes: 0,
    totalDeletedBytes: 0,
  };

  for (const rule of config.rules) {
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
    if (rule.action === "delete_children_older_than") {
      collectChildren(rule, safeRoots, nowMs, summary);
    } else {
      collectNamedDescendants(rule, safeRoots, nowMs, summary);
    }
  }

  summary.totalCandidateBytes = summary.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (options.apply) applyDeletes(summary, config, nowMs);
  summary.totalDeletedBytes = summary.deleted.reduce((sum, candidate) => sum + candidate.bytes, 0);
  return summary;
}

export function writeReceipt(summary: CleanupSummary, receiptDir: string, nowMs: number): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
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
  const bigDelete = input.summary.totalDeletedBytes >= notifyMinDeletedBytes;
  if (!lowDisk && !bigDelete && !rebootRecommended) {
    return { attempted: false, reason: "below-notify-thresholds", freeBytes: input.freeBytes };
  }

  const level: "info" | "warn" = lowDisk ? "warn" : "info";
  const bodyLines = [
    `deleted: ${input.summary.deleted.length} 项, ${formatBytes(input.summary.totalDeletedBytes)}`,
    `disk free: ${input.freeBytes === null ? "unknown" : formatBytes(input.freeBytes)}`,
    `receipt: ${input.receiptPath}`,
  ];
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
      deletedBytes: input.summary.totalDeletedBytes,
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

function printHuman(summary: CleanupSummary): void {
  console.log(`[weekly-cache-cleanup] mode=${summary.mode}`);
  console.log(`[weekly-cache-cleanup] candidates=${summary.candidates.length} bytes=${formatBytes(summary.totalCandidateBytes)}`);
  console.log(`[weekly-cache-cleanup] deleted=${summary.deleted.length} bytes=${formatBytes(summary.totalDeletedBytes)}`);
  for (const candidate of summary.candidates.slice(0, 50)) {
    console.log(`[candidate] ${formatBytes(candidate.bytes)} ${candidate.ruleId} ${candidate.path}`);
  }
  const remaining = summary.candidates.length - 50;
  if (remaining > 0) console.log(`[weekly-cache-cleanup] ... ${remaining} more candidates omitted`);
  const disabled = summary.skipped.filter((entry) => entry.reason === "rule-disabled").length;
  if (disabled > 0) console.log(`[weekly-cache-cleanup] disabled-rule-paths=${disabled}`);
  const safetyBlocked = summary.skipped.filter((entry) => entry.reason === "rule-safety-blocked").length;
  if (safetyBlocked > 0) console.log(`[weekly-cache-cleanup] safety-blocked-rule-paths=${safetyBlocked}`);
  if (summary.impactReview) {
    console.log(`[weekly-cache-cleanup] impact-review requested=${summary.impactReview.requestedOwners} succeeded=${summary.impactReview.succeededOwners} failed=${summary.impactReview.failedOwners}`);
  }
  for (const prune of summary.managedSqliteSnapshotPrunes ?? []) {
    console.log(`[weekly-cache-cleanup] managed-sqlite-snapshot root=${prune.managedRoot} released=${prune.released.length} orphaned=${prune.orphanedReleased.length} skipped=${prune.skipped.length}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.configPath);
  const summary = runCleanup(config, { apply: options.apply, configPath: options.configPath, nowMs: options.nowMs });
  if (options.apply) {
    const runtimeRoot = process.env.SM_RUNTIME_ROOT?.trim() || "/Users/LOCAL_USER/SuperMatrixRuntime";
    const auditDbPath = process.env.SM_DB_PATH?.trim() || join(runtimeRoot, "data", "supermatrix.db");
    summary.managedSqliteSnapshotPrunes = await pruneManagedSqliteSnapshotRoots({
      auditDbPath,
      runtimeRoot,
      nowMs: options.nowMs,
    });
  }
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
