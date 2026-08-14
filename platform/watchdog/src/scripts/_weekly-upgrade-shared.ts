// 共享给 weekly-upgrade.ts (do entry) 与 weekly-upgrade-report.ts (report entry)。
// 两 entry 通过 PENDING_FILE 做 handoff：do 写入 → report 读、轮询、清。

import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogPublishOutcome } from "./_weekly-upgrade-catalog-publisher.js";
import type { WeeklyModelAudit } from "./_weekly-upgrade-model-audit.js";

export type UpgradeResult = {
  cli: string;
  before: string;
  after: string;
  changed: boolean;
  error?: string;
  // 失败但事务已回滚且恢复验证通过（版本恢复 + 各 CLI 自己的 recovery 判据，
  // 如 Kimi 的 SM-PATCH marker>=1）。recovered 的失败不再阻断全局 root review
  //（2026-08-06 用户批准的 invariant 修改）；未恢复的失败维持 fail-closed。
  recovered?: boolean;
  // hold 文件存在时本 CLI 被跳过升级（如 Kimi SM-PATCH 上游修复期间）。
  held?: boolean;
  holdReason?: string;
};

export type ChangelogCoverageExpectation = {
  cli: string;
  versions: string[];
};

export type PendingState = {
  runDate: string;        // "YYYY-MM-DD"
  spawnedAt: number;      // ms epoch
  delegation?: Spawn2DelegationRecord;
  // Legacy pending files from the /api/spawn path only stored childSessionId.
  childSessionId?: string;
  results: UpgradeResult[];
  modelAudit?: WeeklyModelAudit;
  catalogPublish?: WeeklyCatalogPublishOutcome;
  // report entry 用来校验 root finalMessage 的 ## Changelog coverage 段是否
  // 覆盖了区间内全部版本号；缺失视为 review 不完整（fail-closed）。
  changelogCoverage?: ChangelogCoverageExpectation[];
};

export type WeeklyCatalogPublishOutcome = CatalogPublishOutcome | {
  status: "failed";
  snapshotPath: string;
  catalogRevision: null;
  reason: string;
};

export type PolledSessionResult =
  | { status: "running" }
  | { status: "done"; finalMessage: string }
  | { status: "failed"; reason: string };

export const LOG_FILE = join(process.cwd(), "data", "cli-upgrade.log");
export const PENDING_FILE = join(process.cwd(), "data", "pending-upgrade-review.json");
// root review 的版本基线：上次 root review 完成时各 CLI 的版本。
// review gate 用「当前版本 vs 该基线」判定 drift，而不是本进程内 changed 标志——
// 后者在中断后补跑时恒为 false，会静默漏审（2026-08-06 事故）。
export const LAST_REVIEWED_FILE = join(process.cwd(), "data", "last-reviewed-versions.json");
// Stable path scheduler watches via receiptProof external_evidence file engine.
// Script touches it once writeLog succeeds — so even if notify/spawn hangs later
// in the run, scheduler still finds "upgrade phase completed" evidence.
export const RECEIPT_FILE = join(process.cwd(), "data", "scheduler_receipts", "weekly-cli-upgrade.receipt");
export const SPAWN_API = "http://localhost:3501/api/spawn2.0";
export const ROOT_SESSION = "supermatrix-root";
export const SOURCE_SESSION = "watchdog";
export const SUPERMATRIX_REPO = "/Users/LOCAL_USER/SuperMatrix";
export const UPGRADE_COMMIT_MESSAGE_REGEX =
  "(?:update lark cli dependency|adapt to (?:claude-code|codex|lark-cli|kimi-code)@|weekly CLI upgrade)";

// Claude Code stores one OAuth credential JSON document under this macOS
// Keychain service. The scheduled verifier only persists the booleans below;
// it never writes the credential payload, access token, or refresh token.
export const CLAUDE_AUTH_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CLAUDE_AUTH_REQUIRED_SCOPES = ["user:inference", "user:profile"] as const;
export const CLAUDE_AUTH_STATUS_ATTEMPTS = 3;
export const CLAUDE_AUTH_LOGIN_COMMAND = "claude auth login --claudeai";

export type ClaudeAuthRequiredScope = typeof CLAUDE_AUTH_REQUIRED_SCOPES[number];
export type ClaudeAuthStatus = "authenticated" | "quota" | "unauthenticated" | "unknown";
export type ClaudeAuthProbeContext = "interactive-terminal" | "launchctl-asuser";
export type ClaudeAuthStatusProbe = {
  context: ClaudeAuthProbeContext;
  status: ClaudeAuthStatus;
  exitCode: number;
  // Safe diagnostic only. Raw stdout/stderr is never persisted outside the
  // short-lived command capture below.
  terminalIoctlFailure?: boolean;
};
export type ClaudeAuthSnapshotSummary = {
  version: string;
  status: "pass" | "fail";
  authStatus: ClaudeAuthStatus;
  keychainScopes: Record<ClaudeAuthRequiredScope, boolean>;
  probeCounts: Record<ClaudeAuthProbeContext, number>;
  quotaObserved: boolean;
  remediation?: typeof CLAUDE_AUTH_LOGIN_COMMAND;
};
export type ClaudeAuthCheck = {
  status: "pass" | "fail";
  before: ClaudeAuthSnapshotSummary;
  after: ClaudeAuthSnapshotSummary;
  remediation?: typeof CLAUDE_AUTH_LOGIN_COMMAND;
  rebootWakeFollowUp: "next-scheduled-run-only";
  activeReboot: "prohibited";
};

export function classifyClaudeAuthStatus(input: { exitCode: number; output: string }): ClaudeAuthStatus {
  try {
    const parsed: unknown = JSON.parse(input.output);
    if (parsed !== null && typeof parsed === "object") {
      const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
      if (typeof loggedIn === "boolean") return loggedIn ? "authenticated" : "unauthenticated";
    }
  } catch {
    // A malformed or incomplete status response must not authenticate by exit code.
  }
  const output = input.output.toLowerCase();
  if (/\b429\b|quota|rate[- ]limit|weekly limit/.test(output)) return "quota";
  if (/not logged in|unauthenticated|login required|authentication required|no credentials|invalid token|expired token/.test(output)) {
    return "unauthenticated";
  }
  return "unknown";
}

export type QuietCommandResult = { exitCode: number; output: string };
export type QuietCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<QuietCommandResult>;

// Auth status responses can contain sensitive account information. Keep the
// captured pipes in memory only long enough to classify the response; callers
// must persist summaries rather than this raw output.
export function runQuietCommand(command: string, args: string[], timeoutMs = 15000): Promise<QuietCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode, output });
    };
    const append = (chunk: Buffer | string) => {
      // 64 KiB is sufficient for a Claude auth status/credential JSON parse and
      // caps the amount of sensitive data retained transiently in memory.
      if (output.length >= 65536) return;
      output += String(chunk).slice(0, 65536 - output.length);
    };

    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(-1);
      return;
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => finish(-1));
    child.once("close", (code) => finish(code ?? -1));
    timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  });
}

async function runClaudeAuthStatusProbe(
  context: ClaudeAuthProbeContext,
  command: string,
  args: string[],
  timeoutMs: number | undefined,
  runCommand: QuietCommandRunner,
): Promise<ClaudeAuthStatusProbe> {
  const result = await runCommand(command, args, timeoutMs);
  return {
    context,
    exitCode: result.exitCode,
    status: classifyClaudeAuthStatus(result),
    terminalIoctlFailure: /tcgetattr|ioctl/i.test(result.output),
  };
}

// This is the exact non-interactive spawn shape used by the scheduled do
// entry. Do not wrap the interactive path in `/usr/bin/script`: with these
// piped fds it has no usable terminal and can fail at tcgetattr/ioctl.
export async function captureClaudeAuthStatusProbes(input: {
  claudeBin: string;
  uid: number;
  timeoutMs?: number;
  runCommand?: QuietCommandRunner;
}): Promise<ClaudeAuthStatusProbe[]> {
  const authStatusArgs = ["auth", "status"];
  const runCommand = input.runCommand ?? runQuietCommand;
  const probes: Promise<ClaudeAuthStatusProbe>[] = [];
  for (let attempt = 0; attempt < CLAUDE_AUTH_STATUS_ATTEMPTS; attempt += 1) {
    probes.push(runClaudeAuthStatusProbe(
      "interactive-terminal",
      input.claudeBin,
      authStatusArgs,
      input.timeoutMs,
      runCommand,
    ));
    probes.push(runClaudeAuthStatusProbe(
      "launchctl-asuser",
      "/bin/launchctl",
      ["asuser", String(input.uid), input.claudeBin, ...authStatusArgs],
      input.timeoutMs,
      runCommand,
    ));
  }
  return Promise.all(probes);
}

export function summarizeClaudeAuthSnapshot(input: {
  version: string;
  keychainScopes: Record<ClaudeAuthRequiredScope, boolean>;
  probes: ClaudeAuthStatusProbe[];
}): ClaudeAuthSnapshotSummary {
  const probeCounts: Record<ClaudeAuthProbeContext, number> = {
    "interactive-terminal": input.probes.filter((probe) => probe.context === "interactive-terminal").length,
    "launchctl-asuser": input.probes.filter((probe) => probe.context === "launchctl-asuser").length,
  };
  const statuses = input.probes.map((probe) => probe.status);
  const authStatus: ClaudeAuthStatus = statuses.includes("unauthenticated")
    ? "unauthenticated"
    : statuses.includes("unknown")
      ? "unknown"
      : statuses.includes("quota")
        ? "quota"
        : "authenticated";
  const completeProbeSet = Object.values(probeCounts).every((count) => count === CLAUDE_AUTH_STATUS_ATTEMPTS);
  const requiredScopesPresent = CLAUDE_AUTH_REQUIRED_SCOPES.every((scope) => input.keychainScopes[scope]);
  const status = input.version !== "unknown"
    && requiredScopesPresent
    && completeProbeSet
    && (authStatus === "authenticated" || authStatus === "quota")
    ? "pass"
    : "fail";

  return {
    version: input.version,
    status,
    authStatus,
    keychainScopes: input.keychainScopes,
    probeCounts,
    quotaObserved: authStatus === "quota",
    ...(status === "fail" ? { remediation: CLAUDE_AUTH_LOGIN_COMMAND } : {}),
  };
}

export function assessClaudeAuthCheck(
  before: ClaudeAuthSnapshotSummary,
  after: ClaudeAuthSnapshotSummary,
): ClaudeAuthCheck {
  const status = before.status === "pass" && after.status === "pass" ? "pass" : "fail";
  return {
    status,
    before,
    after,
    ...(status === "fail" ? { remediation: CLAUDE_AUTH_LOGIN_COMMAND } : {}),
    rebootWakeFollowUp: "next-scheduled-run-only",
    activeReboot: "prohibited",
  };
}

export type RootReviewSpawnBody = {
  target: typeof ROOT_SESSION;
  from: typeof SOURCE_SESSION;
  prompt: string;
  client_request_id: string;
  closure: {
    kind: "message";
    target: { type: "todo_pool" };
  };
  verification_predicate: {
    type: "git-log";
    repo_path: typeof SUPERMATRIX_REPO;
    since: { kind: "spawn_created_at" };
    message_regex: typeof UPGRADE_COMMIT_MESSAGE_REGEX;
    min_count: 1;
    expected_window_sec: 28800;
  };
};

type SpawnAdmissionErrorBody = {
  code?: unknown;
  error?: unknown;
  details?: unknown;
};

export type Spawn2DelegationRecord = {
  api: "spawn2.0";
  clientRequestId: string;
  response: Record<string, unknown>;
  closure?: string;
  status?: string;
  ref?: string;
  childSessionId: string;
  childSessionName?: string;
  messageRunId?: string;
  commId?: string;
  spawnCommId?: string;
};

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function weeklyUpgradeClientRequestId(runDate: string): string {
  return `${runDate}:${SOURCE_SESSION}:weekly-upgrade:${ROOT_SESSION}`;
}

export function buildRootReviewSpawnBody(
  prompt: string,
  runDate = formatWeeklyRunDate(),
): RootReviewSpawnBody {
  return {
    target: ROOT_SESSION,
    from: SOURCE_SESSION,
    prompt,
    client_request_id: weeklyUpgradeClientRequestId(runDate),
    closure: { kind: "message", target: { type: "todo_pool" } },
    verification_predicate: {
      type: "git-log",
      repo_path: SUPERMATRIX_REPO,
      since: { kind: "spawn_created_at" },
      message_regex: UPGRADE_COMMIT_MESSAGE_REGEX,
      min_count: 1,
      expected_window_sec: 28800,
    },
  };
}

export function formatWeeklyRunDate(now = new Date(), timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const field = (type: "year" | "month" | "day") => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error(`missing ${type} in ${timeZone} date format`);
    return value;
  };
  return `${field("year")}-${field("month")}-${field("day")}`;
}

export function resultFromVersionProbe(input: {
  cli: string;
  before: string;
  after: string;
  versionCommand: string;
  error?: string;
}): UpgradeResult {
  const after = input.after.trim() || "unknown";
  if (input.error) {
    return {
      cli: input.cli,
      before: input.before,
      after: input.before,
      changed: false,
      error: input.error.slice(0, 200),
    };
  }
  if (after === "unknown") {
    return {
      cli: input.cli,
      before: input.before,
      after,
      changed: false,
      error: `post-upgrade version probe failed: ${input.versionCommand} returned unknown`,
    };
  }
  return {
    cli: input.cli,
    before: input.before,
    after,
    changed: input.before !== after,
  };
}

export function shouldKickoffRootReview(
  results: UpgradeResult[],
  modelAuditRequiresReview = false,
  changesForReview?: UpgradeResult[],
): boolean {
  const hasChanges = changesForReview
    ? changesForReview.length > 0
    : results.some((result) => result.changed);
  // recovered（已回滚且恢复验证通过）的失败不阻断 review：此时系统状态是健康
  // 旧版本，其它已变更 CLI 的 drift 一周无人审的风险大于带伤 review 的风险。
  return (hasChanges || modelAuditRequiresReview)
    && results.every((result) => !result.error || result.recovered === true);
}

export type LastReviewedVersions = {
  runDate: string;
  reviewedAt: number;
  versions: Record<string, string>;
};

export function readLastReviewedVersions(): LastReviewedVersions | null {
  if (!existsSync(LAST_REVIEWED_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(LAST_REVIEWED_FILE, "utf-8")) as LastReviewedVersions;
    if (!parsed || typeof parsed !== "object" || typeof parsed.versions !== "object" || parsed.versions === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLastReviewedVersions(state: LastReviewedVersions): void {
  mkdirSync(dirname(LAST_REVIEWED_FILE), { recursive: true });
  writeFileSync(LAST_REVIEWED_FILE, JSON.stringify(state, null, 2));
}

// 与 last-reviewed 基线比对，得出真正需要 root review 的变更列表。
// before 用基线版本（真实 drift 起点），补跑时不会因本进程 changed:false 漏审。
// 基线缺失（首次运行）时退回本进程 changed 标志。
export function computeReviewChanges(
  results: UpgradeResult[],
  baseline: LastReviewedVersions | null,
): UpgradeResult[] {
  return results.filter((result) => {
    if (result.after === "unknown") return false;
    const baselineVersion = baseline?.versions[result.cli];
    if (baselineVersion === undefined) return result.changed;
    return result.after !== baselineVersion;
  }).map((result) => {
    const baselineVersion = baseline?.versions[result.cli];
    return baselineVersion !== undefined && baselineVersion !== result.before
      ? { ...result, before: baselineVersion, changed: true }
      : { ...result, changed: true };
  });
}

export type ChangelogCoverageAssessment =
  | { status: "not-required" }
  | { status: "ok" }
  | { status: "missing-section" }
  | { status: "incomplete"; missing: { cli: string; version: string }[] };

export function assessChangelogCoverage(
  rootReview: string,
  expected: ChangelogCoverageExpectation[] | undefined,
): ChangelogCoverageAssessment {
  const required = (expected ?? []).filter((entry) => entry.versions.length > 0);
  if (required.length === 0) return { status: "not-required" };
  const idx = rootReview.search(/^##\s*Changelog coverage\b/im);
  if (idx < 0) return { status: "missing-section" };
  const after = rootReview.slice(idx).replace(/^##\s*Changelog coverage[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = sectionEnd >= 0 ? after.slice(0, sectionEnd) : after;
  const missing: { cli: string; version: string }[] = [];
  for (const entry of required) {
    for (const version of entry.versions) {
      if (!section.includes(version)) missing.push({ cli: entry.cli, version });
    }
  }
  return missing.length > 0 ? { status: "incomplete", missing } : { status: "ok" };
}

export function normalizeSpawn2Delegation(body: unknown, clientRequestId: string): Spawn2DelegationRecord {
  if (!body || typeof body !== "object") {
    throw new Error("spawn2.0 returned non-object response");
  }
  const parsed = body as Record<string, unknown>;
  const childSessionId = stringField(parsed, "childSessionId");
  if (!childSessionId) {
    throw new Error("spawn2.0 response missing pollable childSessionId");
  }
  return {
    api: "spawn2.0",
    clientRequestId,
    response: parsed,
    ...(stringField(parsed, "closure") ? { closure: stringField(parsed, "closure") } : {}),
    ...(stringField(parsed, "status") ? { status: stringField(parsed, "status") } : {}),
    ...(stringField(parsed, "ref") ? { ref: stringField(parsed, "ref") } : {}),
    childSessionId,
    ...(stringField(parsed, "childSessionName") ? { childSessionName: stringField(parsed, "childSessionName") } : {}),
    ...(stringField(parsed, "messageRunId") ? { messageRunId: stringField(parsed, "messageRunId") } : {}),
    ...(stringField(parsed, "comm_id") ? { commId: stringField(parsed, "comm_id") } : {}),
    ...(stringField(parsed, "spawnCommId") ? { spawnCommId: stringField(parsed, "spawnCommId") } : {}),
  };
}

export function childSessionIdFromDelegation(record: Spawn2DelegationRecord | null | undefined): string | null {
  return record?.childSessionId ?? null;
}

export function childSessionIdFromPending(pending: PendingState): string | null {
  return childSessionIdFromDelegation(pending.delegation) ?? pending.childSessionId ?? null;
}

export function classifyPolledSessionResult(data: unknown): PolledSessionResult {
  if (!data || typeof data !== "object") {
    return { status: "failed", reason: "session result response was not an object" };
  }
  const parsed = data as Record<string, unknown>;
  const runStatus = typeof parsed.status === "string" ? parsed.status : "unknown";
  if (runStatus === "running") return { status: "running" };

  const finalMessage = typeof parsed.finalMessage === "string" ? parsed.finalMessage : "";
  if (runStatus === "completed" && finalMessage.trim()) {
    return { status: "done", finalMessage };
  }

  const errorMessage = typeof parsed.errorMessage === "string" ? parsed.errorMessage : "";
  const reason = errorMessage.trim()
    ? `${runStatus}: ${errorMessage.trim()}`
    : runStatus === "completed"
      ? "completed with empty finalMessage"
      : `terminal status ${runStatus} without finalMessage`;
  return { status: "failed", reason };
}

export function formatSpawnAdmissionError(status: number, body: unknown): string {
  if (!body || typeof body !== "object") return `HTTP ${status}`;
  const parsed = body as SpawnAdmissionErrorBody;
  const code = typeof parsed.code === "string" ? ` ${parsed.code}` : "";
  const error = typeof parsed.error === "string" ? `: ${parsed.error}` : "";
  const details = Array.isArray(parsed.details)
    ? parsed.details.filter((detail): detail is string => typeof detail === "string").join("; ")
    : "";
  return `HTTP ${status}${code}${error}${details ? ` - ${details}` : ""}`;
}

export function writeReceipt(payload: Record<string, unknown>): void {
  mkdirSync(dirname(RECEIPT_FILE), { recursive: true });
  writeFileSync(RECEIPT_FILE, JSON.stringify({ writtenAt: Date.now(), ...payload }, null, 2));
}

export function readPending(): PendingState | null {
  if (!existsSync(PENDING_FILE)) return null;
  try {
    return JSON.parse(readFileSync(PENDING_FILE, "utf-8")) as PendingState;
  } catch {
    return null;
  }
}

export function writePending(state: PendingState): void {
  mkdirSync(dirname(PENDING_FILE), { recursive: true });
  writeFileSync(PENDING_FILE, JSON.stringify(state, null, 2));
}

export function clearPending(): void {
  if (existsSync(PENDING_FILE)) rmSync(PENDING_FILE);
}

export function fileProposedAsIssues(rootReview: string): { count: number; ids: string[]; failed: number } {
  // 解析 root finalMessage 里的 ## Proposed for human 段，每条 bullet 自动 add
  // 进 watchdog 队列，避免 "看一眼忘了"。
  const idx = rootReview.search(/^##\s*Proposed for human\b/im);
  if (idx < 0) return { count: 0, ids: [], failed: 0 };
  const after = rootReview.slice(idx).replace(/^##\s*Proposed for human[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = (sectionEnd >= 0 ? after.slice(0, sectionEnd) : after).trim();
  if (section === "" || section === "无") return { count: 0, ids: [], failed: 0 };

  const bullets: string[] = [];
  let current = "";
  for (const line of section.split("\n")) {
    if (/^- /.test(line)) {
      if (current.trim()) bullets.push(current.trim());
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current.trim()) bullets.push(current.trim());

  const filed: string[] = [];
  let failed = 0;
  for (const raw of bullets) {
    const titleMatch = raw.match(/^-\s*\*\*(.+?)\*\*\s*[:：]\s*(.*)/s);
    const title = titleMatch
      ? `[CLI升级 review] ${titleMatch[1].trim().slice(0, 80)}`
      : `[CLI升级 review] ${raw.replace(/^-\s*/, "").split(/\n/)[0].slice(0, 80)}`;
    const description = `(由 weekly CLI upgrade root review 自动登记，待人工决策)\n\n${raw}`;
    try {
      const out = execFileSync("npx", ["tsx", "src/cli.ts", "add",
        "--title", title,
        "--source", "watchdog",
        "--description", description,
      ], { cwd: process.cwd(), encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/"id":\s*"([^"]+)"/);
      if (m) filed.push(m[1]);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { count: filed.length, ids: filed, failed };
}

export function fileChecklistMetaAsIssues(rootReview: string): { count: number; ids: string[]; failed: number } {
  // 解析 ## Checklist meta 段。每条建议（+ 增 / - 删 / ~ 改写）独立 add 一条 issue，
  // 由人审后手工编辑 docs/weekly-cli-upgrade-checklist.md。watchdog 自身不动 checklist 文件
  // 避免静默修改 review 规范。
  const idx = rootReview.search(/^##\s*Checklist meta\b/im);
  if (idx < 0) return { count: 0, ids: [], failed: 0 };
  const after = rootReview.slice(idx).replace(/^##\s*Checklist meta[^\n]*\n/, "");
  const sectionEnd = after.search(/\n##\s/);
  const section = (sectionEnd >= 0 ? after.slice(0, sectionEnd) : after).trim();
  if (section === "" || section === "无") return { count: 0, ids: [], failed: 0 };

  // 行级匹配：以 "- +" / "- -" / "- ~" 或 "+" / "-" / "~" 行起头
  const bullets: string[] = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^-?\s*([+\-~])\s+(.+)$/);
    if (m) bullets.push(`${m[1]} ${m[2].trim()}`);
  }
  if (bullets.length === 0) return { count: 0, ids: [], failed: 0 };

  const opLabel: Record<string, string> = { "+": "增加", "-": "删除", "~": "改写" };
  const filed: string[] = [];
  let failed = 0;
  for (const raw of bullets) {
    const op = raw[0]!;
    const body = raw.slice(2).trim();
    const title = `[CLI升级 checklist meta] ${opLabel[op] ?? op} — ${body.slice(0, 80)}`;
    const description = `(由 weekly CLI upgrade root review 自动登记的 checklist 演化建议，由人审后手工编辑 docs/weekly-cli-upgrade-checklist.md)\n\n操作：${opLabel[op] ?? op}\n建议原文：${raw}`;
    try {
      const out = execFileSync("npx", ["tsx", "src/cli.ts", "add",
        "--title", title,
        "--source", "watchdog",
        "--description", description,
      ], { cwd: process.cwd(), encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      const m = out.match(/"id":\s*"([^"]+)"/);
      if (m) filed.push(m[1]);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { count: filed.length, ids: filed, failed };
}

export function formatUpgradeLines(results: UpgradeResult[]): { lines: string[]; changed: number; failed: number } {
  let changed = 0;
  let failed = 0;
  const lines = results.map((r) => {
    if (r.error && r.recovered) { return `- ↩️ **${r.cli}**: ${r.before} 升级失败已回滚验证健康（${r.error}）`; }
    if (r.error) { failed++; return `- ❌ **${r.cli}**: ${r.before} → 升级失败（${r.error}）`; }
    if (r.held) { return `- ⏸ **${r.cli}**: ${r.before}（hold 中，跳过升级：${r.holdReason ?? "hold file present"}）`; }
    if (r.changed) { changed++; return `- ✅ **${r.cli}**: ${r.before} → ${r.after}`; }
    return `- ⏸ **${r.cli}**: ${r.before}（已是最新）`;
  });
  return { lines, changed, failed };
}
