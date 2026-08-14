#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir, hostname, release, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

export type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

export type QuotaWindow = {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes?: number;
  resetAtMs?: number;
  resetsAtText?: string;
};

export type CodexQuotaSnapshot =
  | {
      ok: true;
      observedAtMs: number;
      sourcePath: string;
      planType: string | null;
      primary: QuotaWindow;
      secondary?: QuotaWindow;
    }
  | {
      ok: false;
      error: string;
    };

export type ClaudeQuotaSnapshot =
  | {
      ok: true;
      observedAtMs: number;
      rawText: string;
      session?: QuotaWindow;
      weeklyAll?: QuotaWindow;
      weeklyFable?: QuotaWindow;
      accountIdentity?: ClaudeAccountIdentity;
    }
  | {
      ok: false;
      error: string;
      accountIdentity?: ClaudeAccountIdentity;
    };

export type ClaudeAccountIdentity = {
  fingerprint: string;
  cachedUsage: "absent" | "matched" | "mismatch" | "invalid";
};

export type KimiQuotaSnapshot =
  | {
      ok: true;
      observedAtMs: number;
      weekly: QuotaWindow;
      fiveHour: QuotaWindow;
    }
  | {
      ok: false;
      error: string;
    };

type KimiCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
  scope: string;
  tokenType: string;
};

type KimiUsageQueryOptions = {
  kimiCliPath: string;
  kimiHomeDir: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runCommand?: (file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
  now?: () => number;
};

type ClaudeUsageQueryOptions = {
  claudeUsageSnapshotPath: string;
  claudeSettingsPath?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  runCommand?: (
    file: string,
    args: string[],
    timeoutMs: number,
    env?: NodeJS.ProcessEnv,
    input?: string,
  ) => Promise<CommandResult>;
  now?: () => number;
  currentUser?: () => string;
};

export type SendLarkResult = {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  responsePreview: string;
};

type CliOptions = {
  dryRun: boolean;
  json: boolean;
  chatId: string;
  larkCliPath: string;
  claudeUsageSnapshotPath: string;
  kimiCliPath: string;
  kimiHomeDir: string;
  codexSessionsDir: string;
  codexMaxFiles: number;
  timeoutMs: number;
  receiptDir: string;
};

type QuotaStatusPayload = {
  nowMs: number;
  codex: CodexQuotaSnapshot;
  claude: ClaudeQuotaSnapshot;
  kimi: KimiQuotaSnapshot;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_STATUS_CHAT_ID = "oc_REDACTEDCHATID";
const DEFAULT_RECEIPT_DIR = "/Users/LOCAL_USER/SuperMatrixRuntime/data/quota-status";
const OUTPUT_LIMIT = 20_000;
const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.220 (external, cli)";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const MACOS_SECURITY_COMMAND = "/usr/bin/security";
const MACOS_CURL_COMMAND = "/usr/bin/curl";
const CLAUDE_STATUSLINE_MAX_AGE_MS = 10 * 60_000;
const CLAUDE_STATUSLINE_FUTURE_TOLERANCE_MS = 60_000;
const CURL_HTTP_STATUS_MARKER = "SM_HTTP_STATUS";
const DEFAULT_KIMI_CODE_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_REFRESH_MIN_THRESHOLD_S = 300;
const KIMI_REFRESH_THRESHOLD_RATIO = 0.5;
const KIMI_LOCK_STALE_MS = 10_000;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]`;
}

function percentWindow(raw: unknown): QuotaWindow | null {
  if (!isRecord(raw)) return null;
  const used = asNumber(raw["used_percent"]);
  const resetsAt = asNumber(raw["resets_at"]);
  const windowMinutes = asNumber(raw["window_minutes"]);
  if (used === null) return null;
  const result: QuotaWindow = {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
  };
  if (windowMinutes !== null) result.windowMinutes = windowMinutes;
  if (resetsAt !== null) result.resetAtMs = resetsAt < 10_000_000_000 ? resetsAt * 1000 : resetsAt;
  return result;
}

export function parseLatestCodexRateLimitsFromJsonl(content: string, sourcePath: string): CodexQuotaSnapshot {
  let latest: Extract<CodexQuotaSnapshot, { ok: true }> | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed["type"] !== "event_msg") continue;
    const payload = parsed["payload"];
    if (!isRecord(payload) || payload["type"] !== "token_count") continue;
    const rateLimits = payload["rate_limits"];
    if (!isRecord(rateLimits)) continue;
    const limitId = asString(rateLimits["limit_id"]);
    if (limitId !== null && limitId !== "codex") continue;
    const observedAtMs = Date.parse(asString(parsed["timestamp"]) ?? "");
    if (!Number.isFinite(observedAtMs)) continue;
    const primary = percentWindow(rateLimits["primary"]);
    const secondary = percentWindow(rateLimits["secondary"]);
    if (!primary) continue;
    const snapshot: Extract<CodexQuotaSnapshot, { ok: true }> = {
      ok: true,
      observedAtMs,
      sourcePath,
      planType: asString(rateLimits["plan_type"]),
      primary,
      ...(secondary ? { secondary } : {}),
    };
    if (!latest || snapshot.observedAtMs > latest.observedAtMs) latest = snapshot;
  }

  return latest ?? { ok: false, error: `no Codex rate_limits token_count events in ${sourcePath}` };
}

function parseClaudeLine(text: string, label: string): QuotaWindow | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(`^${escaped}:\\s*([0-9]+(?:\\.[0-9]+)?)% used\\s+.*?resets\\s+(.+)$`, "mu");
  const match = text.match(re);
  if (!match) return undefined;
  const used = Number(match[1]);
  if (!Number.isFinite(used)) return undefined;
  return {
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAtText: match[2].trim(),
  };
}

export function parseClaudeUsageJson(stdout: string, observedAtMs: number): ClaudeQuotaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (err) {
    return { ok: false, error: `Claude /usage returned non-JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rawText = isRecord(parsed) ? asString(parsed["result"]) : null;
  if (!rawText) return { ok: false, error: "Claude /usage JSON did not include result text" };
  const session = parseClaudeLine(rawText, "Current session");
  const weeklyAll = parseClaudeLine(rawText, "Current week (all models)");
  const weeklyFable = parseClaudeLine(rawText, "Current week (Fable)");
  if (!session && !weeklyAll && !weeklyFable) {
    return { ok: false, error: "Claude /usage result did not include recognizable quota lines" };
  }
  return {
    ok: true,
    observedAtMs,
    rawText,
    ...(session ? { session } : {}),
    ...(weeklyAll ? { weeklyAll } : {}),
    ...(weeklyFable ? { weeklyFable } : {}),
  };
}

function passiveClaudeWindow(raw: unknown): QuotaWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = asNumber(raw["usedPercent"]);
  const remainingPercent = asNumber(raw["remainingPercent"]);
  const resetAtMs = asNumber(raw["resetAtMs"]);
  if (usedPercent === null || remainingPercent === null) return null;
  return {
    usedPercent,
    remainingPercent,
    ...(resetAtMs !== null ? { resetAtMs } : {}),
  };
}

export function parseClaudeStatuslineSnapshot(content: string, sourcePath: string): ClaudeQuotaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (err) {
    return {
      ok: false,
      error: `Claude status-line rate_limits snapshot is invalid (${sourcePath}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: `Claude status-line rate_limits snapshot is not an object: ${sourcePath}` };
  }
  const providers = Array.isArray(parsed["providers"]) ? parsed["providers"] : [];
  const provider = providers.find((item) => isRecord(item) && item["id"] === "claude");
  if (!isRecord(provider) || !Array.isArray(provider["limits"])) {
    return { ok: false, error: `Claude status-line rate_limits snapshot has no Claude provider: ${sourcePath}` };
  }
  const limits = provider["limits"];
  const fiveHour = passiveClaudeWindow(
    limits.find((item) => isRecord(item) && item["key"] === "five-hour"),
  );
  const sevenDay = passiveClaudeWindow(
    limits.find((item) => isRecord(item) && item["key"] === "seven-day"),
  );
  if (!fiveHour && !sevenDay) {
    return { ok: false, error: `Claude status-line rate_limits snapshot has no quota windows: ${sourcePath}` };
  }
  const observedAtMs =
    asNumber(provider["sourceObservedAt"]) ?? asNumber(parsed["generatedAt"]) ?? statSync(sourcePath).mtimeMs;
  return {
    ok: true,
    observedAtMs,
    rawText: "passive Claude status-line rate_limits",
    ...(fiveHour ? { session: fiveHour } : {}),
    ...(sevenDay ? { weeklyAll: sevenDay } : {}),
  };
}

function claudeOAuthWindow(raw: unknown): QuotaWindow | null {
  if (!isRecord(raw)) return null;
  const usedPercent = asNumber(raw["utilization"]);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  const resetsAt = asString(raw["resets_at"]);
  const resetAtMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
  };
}

function claudeModelScopedWindow(raw: unknown, displayName: string): QuotaWindow | null {
  if (!Array.isArray(raw)) return null;
  const entry = raw.find((item) => {
    if (!isRecord(item) || item["kind"] !== "weekly_scoped") return false;
    const scope = item["scope"];
    const model = isRecord(scope) ? scope["model"] : null;
    return isRecord(model) && asString(model["display_name"])?.toLowerCase() === displayName.toLowerCase();
  });
  if (!isRecord(entry)) return null;
  const usedPercent = asNumber(entry["percent"]);
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  const resetsAt = asString(entry["resets_at"]);
  const resetAtMs = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    ...(Number.isFinite(resetAtMs) ? { resetAtMs } : {}),
  };
}

export function parseClaudeOAuthUsageJson(content: string, observedAtMs: number): ClaudeQuotaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { ok: false, error: "Claude OAuth usage returned non-JSON" };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: "Claude OAuth usage returned a non-object payload" };
  }
  const session = claudeOAuthWindow(parsed["five_hour"]);
  const weeklyAll = claudeOAuthWindow(parsed["seven_day"]);
  const weeklyFable = claudeModelScopedWindow(parsed["limits"], "Fable");
  if (!session && !weeklyAll && !weeklyFable) {
    return { ok: false, error: "Claude OAuth usage did not include five_hour or seven_day quota windows" };
  }
  return {
    ok: true,
    observedAtMs,
    rawText: "official Claude OAuth usage API",
    ...(session ? { session } : {}),
    ...(weeklyAll ? { weeklyAll } : {}),
    ...(weeklyFable ? { weeklyFable } : {}),
  };
}

function readClaudeStatuslineSnapshot(path: string): ClaudeQuotaSnapshot {
  if (!existsSync(path)) {
    return { ok: false, error: `Claude status-line rate_limits snapshot not found: ${path}` };
  }
  try {
    return parseClaudeStatuslineSnapshot(readFileSync(path, "utf8"), path);
  } catch (err) {
    return {
      ok: false,
      error: `Claude status-line rate_limits snapshot is unreadable (${path}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

type ClaudeOAuthAccountContext = {
  accountUuid: string;
  organizationUuid: string;
  identity: ClaudeAccountIdentity;
  cachedUsage: Extract<ClaudeQuotaSnapshot, { ok: true }> | null;
};

function normalizeClaudeAccountUuid(value: unknown): string | null {
  const accountUuid = asString(value)?.trim();
  return accountUuid && !/[\r\n]/u.test(accountUuid) ? accountUuid : null;
}

function readClaudeOAuthAccountContext(path: string): ClaudeOAuthAccountContext | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const oauthAccount = parsed["oauthAccount"];
    const accountUuid = isRecord(oauthAccount) ? normalizeClaudeAccountUuid(oauthAccount["accountUuid"]) : null;
    const organizationUuid = isRecord(oauthAccount) ? asString(oauthAccount["organizationUuid"])?.trim() : null;
    if (!accountUuid || !organizationUuid || /[\r\n]/u.test(organizationUuid)) {
      return null;
    }
    const rawCachedUsage = parsed["cachedUsageUtilization"];
    let cachedUsage: Extract<ClaudeQuotaSnapshot, { ok: true }> | null = null;
    let cachedUsageState: ClaudeAccountIdentity["cachedUsage"] = "absent";
    if (rawCachedUsage !== undefined) {
      if (!isRecord(rawCachedUsage)) {
        cachedUsageState = "invalid";
      } else {
        const cachedAccountUuid = normalizeClaudeAccountUuid(rawCachedUsage["accountUuid"]);
        const fetchedAtMs = asNumber(rawCachedUsage["fetchedAtMs"]);
        const utilization = rawCachedUsage["utilization"];
        if (!cachedAccountUuid) {
          cachedUsageState = "invalid";
        } else if (cachedAccountUuid !== accountUuid) {
          cachedUsageState = "mismatch";
        } else if (fetchedAtMs === null || fetchedAtMs < 0) {
          cachedUsageState = "invalid";
        } else {
          const parsedUsage = parseClaudeOAuthUsageJson(JSON.stringify(utilization), fetchedAtMs);
          if (parsedUsage.ok) {
            cachedUsage = { ...parsedUsage, rawText: "cached Claude OAuth usage" };
            cachedUsageState = "matched";
          } else {
            cachedUsageState = "invalid";
          }
        }
      }
    }
    return {
      accountUuid,
      organizationUuid,
      identity: {
        fingerprint: `sha256:${createHash("sha256").update(accountUuid).digest("hex")}`,
        cachedUsage: cachedUsageState,
      },
      cachedUsage,
    };
  } catch {
    return null;
  }
}

function currentMacosLoginAccount(currentUser: (() => string) | undefined): string | null {
  try {
    const account = (currentUser ?? (() => userInfo().username))().trim();
    return account && !/[\r\n]/u.test(account) ? account : null;
  } catch {
    return null;
  }
}

function curlConfigValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
}

function withClaudeAccountIdentity(snapshot: ClaudeQuotaSnapshot, identity: ClaudeAccountIdentity): ClaudeQuotaSnapshot {
  return { ...snapshot, accountIdentity: identity };
}

function fallbackToAccountBoundClaudeCache(
  accountContext: ClaudeOAuthAccountContext,
  error: string,
): ClaudeQuotaSnapshot {
  if (accountContext.cachedUsage) {
    return withClaudeAccountIdentity(accountContext.cachedUsage, accountContext.identity);
  }
  if (accountContext.identity.cachedUsage === "mismatch") {
    return {
      ok: false,
      error: "Claude cached usage belongs to a different oauthAccount; refusing attribution",
      accountIdentity: accountContext.identity,
    };
  }
  return { ok: false, error, accountIdentity: accountContext.identity };
}

function sameClaudeQuotaWindow(left: QuotaWindow | undefined, right: QuotaWindow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.usedPercent === right.usedPercent &&
    left.remainingPercent === right.remainingPercent &&
    left.windowMinutes === right.windowMinutes &&
    left.resetAtMs === right.resetAtMs &&
    left.resetsAtText === right.resetsAtText
  );
}

function sameClaudeAccountUsage(
  left: Extract<ClaudeQuotaSnapshot, { ok: true }>,
  right: Extract<ClaudeQuotaSnapshot, { ok: true }>,
): boolean {
  return (
    sameClaudeQuotaWindow(left.session, right.session) &&
    sameClaudeQuotaWindow(left.weeklyAll, right.weeklyAll) &&
    sameClaudeQuotaWindow(left.weeklyFable, right.weeklyFable)
  );
}

export async function queryClaudeUsage(options: ClaudeUsageQueryOptions): Promise<ClaudeQuotaSnapshot> {
  const now = options.now ?? Date.now;
  const requestStartedAtMs = now();
  const accountContext = readClaudeOAuthAccountContext(options.claudeSettingsPath ?? join(homedir(), ".claude.json"));
  if (!accountContext) {
    return { ok: false, error: "Claude account context is unavailable in ~/.claude.json" };
  }
  const cachedUsage = accountContext.cachedUsage;
  if (!cachedUsage && accountContext.identity.cachedUsage !== "absent") {
    return fallbackToAccountBoundClaudeCache(
      accountContext,
      `Claude account-bound cached usage is ${accountContext.identity.cachedUsage}; refusing attribution`,
    );
  }
  const passiveSnapshot = readClaudeStatuslineSnapshot(options.claudeUsageSnapshotPath);
  if (
    cachedUsage &&
    passiveSnapshot.ok &&
    passiveSnapshot.observedAtMs >= requestStartedAtMs - CLAUDE_STATUSLINE_MAX_AGE_MS &&
    passiveSnapshot.observedAtMs <= requestStartedAtMs + CLAUDE_STATUSLINE_FUTURE_TOLERANCE_MS
  ) {
    if (sameClaudeAccountUsage(passiveSnapshot, cachedUsage)) {
      return withClaudeAccountIdentity(passiveSnapshot, accountContext.identity);
    }
  }

  const runner = options.runCommand ?? runCommand;
  const macosAccount = currentMacosLoginAccount(options.currentUser);
  if (!macosAccount) {
    return { ok: false, error: "current macOS login account is unavailable" };
  }
  const credentialResult = await runner(
    MACOS_SECURITY_COMMAND,
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-a", macosAccount, "-w"],
    options.timeoutMs,
  );
  if (!credentialResult.ok) {
    return fallbackToAccountBoundClaudeCache(accountContext, "Claude OAuth credential unavailable in macOS Keychain");
  }

  let parsedCredential: unknown;
  try {
    parsedCredential = JSON.parse(credentialResult.stdout) as unknown;
  } catch {
    return fallbackToAccountBoundClaudeCache(accountContext, "Claude OAuth credential in macOS Keychain is invalid");
  }
  const oauth = isRecord(parsedCredential) ? parsedCredential["claudeAiOauth"] : null;
  const accessToken = isRecord(oauth) ? asString(oauth["accessToken"]) : null;
  const expiresAt = isRecord(oauth) ? asNumber(oauth["expiresAt"]) : null;
  if (!accessToken || /[\r\n]/u.test(accessToken) || expiresAt === null) {
    return fallbackToAccountBoundClaudeCache(accountContext, "Claude OAuth credential in macOS Keychain is invalid");
  }
  if (requestStartedAtMs >= expiresAt) {
    return fallbackToAccountBoundClaudeCache(
      accountContext,
      "Claude OAuth access token is expired; authentication refresh is disabled",
    );
  }

  const curlConfig = [
    `url = "${CLAUDE_OAUTH_USAGE_URL}"`,
    'request = "GET"',
    `header = "Authorization: Bearer ${curlConfigValue(accessToken)}"`,
    'header = "Content-Type: application/json"',
    `header = "User-Agent: ${CLAUDE_CODE_USER_AGENT}"`,
    `header = "anthropic-beta: ${CLAUDE_OAUTH_BETA}"`,
    `header = "x-organization-uuid: ${curlConfigValue(accountContext.organizationUuid)}"`,
    "silent",
    "show-error",
    `max-time = "${(options.timeoutMs / 1000).toFixed(3)}"`,
    `write-out = "\\n${CURL_HTTP_STATUS_MARKER}:%{http_code}\\n"`,
    "",
  ].join("\n");
  const curlResult = await runner(
    MACOS_CURL_COMMAND,
    ["--disable", "--no-location", "--config", "-"],
    options.timeoutMs,
    options.env ?? process.env,
    curlConfig,
  );
  if (!curlResult.ok) {
    return fallbackToAccountBoundClaudeCache(accountContext, "Claude OAuth usage request failed");
  }
  const statusMatch = curlResult.stdout.match(
    new RegExp(`\\n${CURL_HTTP_STATUS_MARKER}:(\\d{3})\\n?$`, "u"),
  );
  if (!statusMatch || statusMatch.index === undefined) {
    return fallbackToAccountBoundClaudeCache(accountContext, "Claude OAuth usage request failed");
  }
  const status = Number(statusMatch[1]);
  if (status === 401 || status === 403) {
    return fallbackToAccountBoundClaudeCache(
      accountContext,
      `Claude OAuth usage unavailable (HTTP ${status}); authentication refresh is disabled`,
    );
  }
  if (status < 200 || status >= 300) {
    return fallbackToAccountBoundClaudeCache(accountContext, `Claude OAuth usage unavailable (HTTP ${status})`);
  }
  const liveUsage = parseClaudeOAuthUsageJson(curlResult.stdout.slice(0, statusMatch.index), now());
  if (!liveUsage.ok) return fallbackToAccountBoundClaudeCache(accountContext, liveUsage.error);
  return withClaudeAccountIdentity(liveUsage, accountContext.identity);
}

function kimiNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kimiResetAtMs(raw: JsonRecord): number | undefined {
  for (const key of ["resetTime", "reset_at", "resetAt", "reset_time"]) {
    const value = raw[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    const numeric = kimiNumber(value);
    if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  return undefined;
}

function kimiQuotaWindow(raw: unknown): QuotaWindow | null {
  if (!isRecord(raw)) return null;
  const limit = kimiNumber(raw["limit"]);
  let used = kimiNumber(raw["used"]);
  const remaining = kimiNumber(raw["remaining"]);
  if (limit === null || limit <= 0) return null;
  if (used === null && remaining !== null) used = limit - remaining;
  if (used === null) return null;
  const usedPercent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  const resetAtMs = kimiResetAtMs(raw);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
  };
}

function isFiveHourKimiWindow(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const duration = kimiNumber(raw["duration"]);
  const timeUnit = asString(raw["timeUnit"] ?? raw["time_unit"])?.toUpperCase() ?? "";
  return (duration === 300 && timeUnit.includes("MINUTE")) || (duration === 5 && timeUnit.includes("HOUR"));
}

export function parseKimiUsageJson(stdout: string, observedAtMs: number): KimiQuotaSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (err) {
    return { ok: false, error: `Kimi /usages returned non-JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: "Kimi /usages returned a non-object payload" };

  const weekly = kimiQuotaWindow(parsed["usage"]);
  const limits = Array.isArray(parsed["limits"]) ? parsed["limits"] : [];
  const fiveHourEntry = limits.find((item) => isRecord(item) && isFiveHourKimiWindow(item["window"]));
  const fiveHour = isRecord(fiveHourEntry) ? kimiQuotaWindow(fiveHourEntry["detail"] ?? fiveHourEntry) : null;
  if (!weekly || !fiveHour) {
    return { ok: false, error: "Kimi /usages did not include weekly and 5h quota windows" };
  }
  return { ok: true, observedAtMs, weekly, fiveHour };
}

function kimiCredentialPath(kimiHomeDir: string): string {
  return join(kimiHomeDir, "credentials", "kimi-code.json");
}

function readKimiCredential(path: string): KimiCredential {
  if (!existsSync(path)) throw new Error(`Kimi credential not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Kimi credential is unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error(`Kimi credential is invalid: ${path}`);
  const accessToken = asString(parsed["access_token"]);
  const expiresAt = kimiNumber(parsed["expires_at"]);
  const expiresIn = kimiNumber(parsed["expires_in"]);
  if (!accessToken || expiresAt === null || expiresIn === null) {
    throw new Error(`Kimi credential is invalid: ${path}`);
  }
  return {
    accessToken,
    refreshToken: asString(parsed["refresh_token"]) ?? "",
    expiresAt,
    expiresIn,
    scope: asString(parsed["scope"]) ?? "",
    tokenType: asString(parsed["token_type"]) ?? "Bearer",
  };
}

function needsKimiRefresh(credential: KimiCredential, nowMs: number): boolean {
  if (credential.expiresAt <= 0) return false;
  const threshold = Math.max(KIMI_REFRESH_MIN_THRESHOLD_S, credential.expiresIn * KIMI_REFRESH_THRESHOLD_RATIO);
  return credential.expiresAt - Math.floor(nowMs / 1000) < threshold;
}

function writeKimiCredentialAtomic(path: string, credential: KimiCredential): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const wire = {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_at: credential.expiresAt,
    scope: credential.scope,
    token_type: credential.tokenType,
    expires_in: credential.expiresIn,
  };
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(wire, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function asciiHeader(value: string, fallback = "unknown"): string {
  const cleaned = value.replaceAll(/[^\u0020-\u007E]/gu, "").trim();
  return cleaned || fallback;
}

function readOrCreateKimiDeviceId(kimiHomeDir: string): string {
  const path = join(kimiHomeDir, "device_id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {}
  mkdirSync(kimiHomeDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    writeFileSync(path, `${id}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return id;
  } catch {
    const existing = readFileSync(path, "utf8").trim();
    if (!existing) throw new Error(`Kimi device id is empty: ${path}`);
    return existing;
  }
}

function kimiDeviceHeaders(kimiHomeDir: string, version: string): Record<string, string> {
  return {
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": asciiHeader(version),
    "X-Msh-Device-Name": asciiHeader(hostname()),
    "X-Msh-Device-Model": asciiHeader(`${process.platform} ${release()} ${arch()}`),
    "X-Msh-Os-Version": asciiHeader(release()),
    "X-Msh-Device-Id": readOrCreateKimiDeviceId(kimiHomeDir),
  };
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err["code"] === "string" ? err["code"] : undefined;
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withKimiRefreshLock<T>(kimiHomeDir: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  const oauthDir = join(kimiHomeDir, "oauth");
  const lockTarget = join(oauthDir, "kimi-code");
  const lockDir = `${lockTarget}.lock`;
  mkdirSync(oauthDir, { recursive: true, mode: 0o700 });
  closeSync(openSync(lockTarget, "a", 0o600));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > KIMI_LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch (staleErr) {
        if (errorCode(staleErr) === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error(`Kimi OAuth refresh lock timed out: ${lockDir}`);
      await wait(250);
    }
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockDir, now, now);
    } catch {}
  }, 1_000);
  heartbeat.unref();
  try {
    return await action();
  } finally {
    clearInterval(heartbeat);
    try {
      rmdirSync(lockDir);
    } catch {}
  }
}

function apiErrorDetail(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    for (const key of ["error_description", "message", "detail", "error"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (isRecord(value)) {
        for (const nestedKey of ["message", "error_description", "detail", "code", "type"]) {
          const nested = value[nestedKey];
          if (typeof nested === "string" && nested.trim()) return nested.trim();
        }
      }
    }
  } catch {}
  return null;
}

async function readKimiCliVersion(
  kimiCliPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  runner: NonNullable<KimiUsageQueryOptions["runCommand"]>,
): Promise<string> {
  const result = await runner(kimiCliPath, ["--version"], timeoutMs, env);
  if (!result.ok) {
    const detail = clip(`${result.error ?? ""}\n${result.stderr}\n${result.stdout}`).trim();
    throw new Error(detail || `kimi --version exited ${result.code}`);
  }
  const version = result.stdout.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u)?.[0];
  if (!version) throw new Error(`kimi --version returned an unrecognized value: ${result.stdout.trim()}`);
  return version;
}

async function refreshKimiCredential(input: {
  credential: KimiCredential;
  kimiHomeDir: string;
  version: string;
  oauthHost: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<KimiCredential> {
  if (!input.credential.refreshToken) throw new Error("Kimi credential has no refresh_token; run /login interactively");
  const url = `${input.oauthHost}/api/oauth/token`;
  const body = new URLSearchParams({
    client_id: KIMI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: input.credential.refreshToken,
  }).toString();
  const response = await input.fetchImpl(url, {
    method: "POST",
    headers: {
      ...kimiDeviceHeaders(input.kimiHomeDir, input.version),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = apiErrorDetail(text);
    throw new Error(`Kimi OAuth refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Kimi OAuth refresh returned non-JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) throw new Error("Kimi OAuth refresh returned a non-object payload");
  const accessToken = asString(parsed["access_token"]);
  const refreshToken = asString(parsed["refresh_token"]);
  const expiresIn = kimiNumber(parsed["expires_in"]);
  if (!accessToken || !refreshToken || expiresIn === null || expiresIn <= 0) {
    throw new Error("Kimi OAuth refresh response is missing access_token, refresh_token, or expires_in");
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(input.now() / 1000) + expiresIn,
    expiresIn,
    scope: asString(parsed["scope"]) ?? input.credential.scope,
    tokenType: asString(parsed["token_type"]) ?? input.credential.tokenType,
  };
}

async function requestKimiUsage(
  baseUrl: string,
  credential: KimiCredential,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetchImpl(`${baseUrl}/usages`, {
    headers: {
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

export async function queryKimiUsage(options: KimiUsageQueryOptions): Promise<KimiQuotaSnapshot> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runner = options.runCommand ?? runCommand;
  const now = options.now ?? Date.now;
  const credentialPath = kimiCredentialPath(options.kimiHomeDir);
  const baseUrl = (env["KIMI_CODE_BASE_URL"] ?? DEFAULT_KIMI_CODE_BASE_URL).replace(/\/+$/u, "");
  const oauthHost = (env["KIMI_CODE_OAUTH_HOST"] ?? env["KIMI_OAUTH_HOST"] ?? DEFAULT_KIMI_OAUTH_HOST).replace(/\/+$/u, "");

  try {
    let credential = readKimiCredential(credentialPath);
    const refreshUnderLock = async (force: boolean, rejectedAccessToken?: string): Promise<KimiCredential> => {
      return await withKimiRefreshLock(options.kimiHomeDir, options.timeoutMs, async () => {
        const current = readKimiCredential(credentialPath);
        if (force && rejectedAccessToken !== undefined && current.accessToken !== rejectedAccessToken) return current;
        if (!force && !needsKimiRefresh(current, now())) return current;
        const version = await readKimiCliVersion(options.kimiCliPath, options.timeoutMs, env, runner);
        const refreshed = await refreshKimiCredential({
          credential: current,
          kimiHomeDir: options.kimiHomeDir,
          version,
          oauthHost,
          timeoutMs: options.timeoutMs,
          fetchImpl,
          now,
        });
        writeKimiCredentialAtomic(credentialPath, refreshed);
        return refreshed;
      });
    };

    if (needsKimiRefresh(credential, now())) credential = await refreshUnderLock(false);
    let response = await requestKimiUsage(baseUrl, credential, options.timeoutMs, fetchImpl);
    if (response.status === 401) {
      const rejectedAccessToken = credential.accessToken;
      credential = await refreshUnderLock(true, rejectedAccessToken);
      response = await requestKimiUsage(baseUrl, credential, options.timeoutMs, fetchImpl);
    }
    if (!response.ok) {
      const detail = apiErrorDetail(response.text);
      return {
        ok: false,
        error: `Kimi /usages failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      };
    }
    return parseKimiUsageJson(response.text, now());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function cstParts(ms: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatCstDateTime(ms: number): string {
  const parts = cstParts(ms);
  return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]} CST`;
}

function formatCstTime(ms: number): string {
  const parts = cstParts(ms);
  return `${parts["hour"]}:${parts["minute"]}`;
}

function formatCstReset(ms: number | undefined, nowMs: number): string {
  if (ms === undefined) return "unknown";
  const now = cstParts(nowMs);
  const reset = cstParts(ms);
  if (now["year"] === reset["year"] && now["month"] === reset["month"] && now["day"] === reset["day"]) {
    return `${reset["hour"]}:${reset["minute"]}`;
  }
  return `${reset["month"]}-${reset["day"]} ${reset["hour"]}:${reset["minute"]}`;
}

function formatPlan(planType: string | null): string {
  if (!planType) return "";
  return ` ${planType.slice(0, 1).toUpperCase()}${planType.slice(1)}`;
}

function formatWindow(name: string, window: QuotaWindow, nowMs: number): string {
  if (window.resetAtMs !== undefined) {
    return `- ${name}: used ${window.usedPercent}% / remain ${window.remainingPercent}%, reset ${formatCstReset(window.resetAtMs, nowMs)}`;
  }
  if (window.resetsAtText) {
    return `- ${name}: used ${window.usedPercent}% / remain ${window.remainingPercent}%, reset ${window.resetsAtText}`;
  }
  return `- ${name}: used ${window.usedPercent}% / remain ${window.remainingPercent}%`;
}

function codexWindowName(window: QuotaWindow, fallback: "primary" | "secondary"): string {
  if (window.windowMinutes === 300) return "5h";
  if (window.windowMinutes === 10_080) return "weekly";
  if (window.windowMinutes !== undefined) return `${window.windowMinutes}m`;
  return fallback;
}

export function buildQuotaStatusMessage(payload: QuotaStatusPayload): string {
  const lines = [`AI 额度状态｜${formatCstDateTime(payload.nowMs)}`, ""];

  if (payload.codex.ok) {
    lines.push(`Codex${formatPlan(payload.codex.planType)}`);
    lines.push(formatWindow(codexWindowName(payload.codex.primary, "primary"), payload.codex.primary, payload.nowMs));
    if (payload.codex.secondary) {
      lines.push(formatWindow(codexWindowName(payload.codex.secondary, "secondary"), payload.codex.secondary, payload.nowMs));
    }
    lines.push(`Codex source: local rate_limits @ ${formatCstTime(payload.codex.observedAtMs)}`);
  } else {
    lines.push(`Codex: 查询失败 - ${payload.codex.error}`);
  }

  lines.push("");

  if (payload.claude.ok) {
    lines.push("Claude");
    if (payload.claude.session) lines.push(formatWindow("session", payload.claude.session, payload.nowMs));
    if (payload.claude.weeklyAll) lines.push(formatWindow("weekly all", payload.claude.weeklyAll, payload.nowMs));
    if (payload.claude.weeklyFable) lines.push(formatWindow("weekly Fable", payload.claude.weeklyFable, payload.nowMs));
  } else {
    lines.push(`Claude: 查询失败 - ${payload.claude.error}`);
  }

  lines.push("");

  if (payload.kimi.ok) {
    lines.push("Kimi Code");
    lines.push(formatWindow("weekly", payload.kimi.weekly, payload.nowMs));
    lines.push(formatWindow("5h", payload.kimi.fiveHour, payload.nowMs));
    lines.push(`Kimi source: local OAuth + Kimi /usages @ ${formatCstTime(payload.kimi.observedAtMs)}`);
  } else {
    lines.push(`Kimi Code: 查询失败 - ${payload.kimi.error}`);
  }

  lines.push(
    "",
    "note: Codex 来自本机 session JSONL 的最新 rate_limits；Claude 优先读取 status-line 快照，缺失时用未过期 access token 单次只读查询官方 /api/oauth/usage；Kimi 来自本机 OAuth 认证后的结构化 /usages API。",
  );
  return lines.join("\n");
}

export async function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): Promise<CommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    child.stdin.on("error", () => undefined);
    child.stdin.end(input);

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = clip(stdout + String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = clip(stderr + String(chunk));
    });
    child.on("error", (err) => {
      finish({ ok: false, code: null, stdout, stderr, timedOut, error: String(err) });
    });
    child.on("exit", (code) => {
      finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

export async function sendLarkText(input: {
  larkCliPath: string;
  chatId: string;
  text: string;
  timeoutMs: number;
  runCommand?: (file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<CommandResult>;
}): Promise<SendLarkResult> {
  const runner = input.runCommand ?? runCommand;
  const result = await runner(
    input.larkCliPath,
    ["im", "+messages-send", "--as", "bot", "--chat-id", input.chatId, "--text", input.text],
    input.timeoutMs,
  );
  const responsePreview = clip(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}${result.error ? `\n${result.error}` : ""}`).slice(0, 1000);
  if (!result.ok) return { ok: false, code: result.code, timedOut: result.timedOut, responsePreview };
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    return { ok: isRecord(parsed) && parsed["ok"] === true, code: result.code, timedOut: result.timedOut, responsePreview };
  } catch {
    return { ok: false, code: result.code, timedOut: result.timedOut, responsePreview };
  }
}

function listJsonlFiles(root: string, maxFiles: number): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(path);
      } else if (st.isFile() && path.endsWith(".jsonl")) {
        files.push({ path, mtimeMs: st.mtimeMs });
      }
    }
  };
  visit(root);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles).map((file) => file.path);
}

function findLatestCodexRateLimits(sessionsDir: string, maxFiles: number): CodexQuotaSnapshot {
  if (!existsSync(sessionsDir)) return { ok: false, error: `Codex sessions dir not found: ${sessionsDir}` };
  let latest: Extract<CodexQuotaSnapshot, { ok: true }> | null = null;
  for (const file of listJsonlFiles(sessionsDir, maxFiles)) {
    const snapshot = parseLatestCodexRateLimitsFromJsonl(readFileSync(file, "utf8"), file);
    if (snapshot.ok && (!latest || snapshot.observedAtMs > latest.observedAtMs)) latest = snapshot;
  }
  return latest ?? { ok: false, error: `no Codex rate_limits found in latest ${maxFiles} session files` };
}

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;
  let json = false;
  let chatId = process.env.SM_QUOTA_STATUS_CHAT_ID ?? DEFAULT_STATUS_CHAT_ID;
  let larkCliPath = process.env.SM_LARK_CLI_PATH ?? join(REPO_DIR, "node_modules/.bin/lark-cli");
  let claudeUsageSnapshotPath =
    process.env.SM_CLAUDE_USAGE_SNAPSHOT_PATH ??
    process.env.CLAUDE_USAGE_SNAPSHOT_PATH ??
    join(homedir(), ".claude", "usage-status.json");
  let kimiCliPath = process.env.SM_KIMI_CLI_PATH ?? "kimi";
  let kimiHomeDir = process.env.SM_KIMI_CODE_HOME ?? process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  let codexSessionsDir = process.env.SM_CODEX_SESSIONS_DIR ?? "/Users/LOCAL_USER/.codex/sessions";
  let codexMaxFiles = Number(process.env.SM_QUOTA_CODEX_MAX_FILES ?? 200);
  let timeoutMs = Number(process.env.SM_QUOTA_STATUS_TIMEOUT_MS ?? 60_000);
  let receiptDir = process.env.SM_QUOTA_STATUS_RECEIPT_DIR ?? DEFAULT_RECEIPT_DIR;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--chat-id") {
      const next = argv[i + 1];
      if (!next) throw new Error("--chat-id requires a value");
      chatId = next;
      i += 1;
    } else if (arg === "--lark-cli") {
      const next = argv[i + 1];
      if (!next) throw new Error("--lark-cli requires a path");
      larkCliPath = next;
      i += 1;
    } else if (arg === "--claude-usage-snapshot") {
      const next = argv[i + 1];
      if (!next) throw new Error("--claude-usage-snapshot requires a path");
      claudeUsageSnapshotPath = next;
      i += 1;
    } else if (arg === "--kimi-cli") {
      const next = argv[i + 1];
      if (!next) throw new Error("--kimi-cli requires a command");
      kimiCliPath = next;
      i += 1;
    } else if (arg === "--kimi-home") {
      const next = argv[i + 1];
      if (!next) throw new Error("--kimi-home requires a path");
      kimiHomeDir = next;
      i += 1;
    } else if (arg === "--codex-sessions-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--codex-sessions-dir requires a path");
      codexSessionsDir = next;
      i += 1;
    } else if (arg === "--codex-max-files") {
      const next = argv[i + 1];
      if (!next) throw new Error("--codex-max-files requires a number");
      codexMaxFiles = Number(next);
      i += 1;
    } else if (arg === "--timeout-ms") {
      const next = argv[i + 1];
      if (!next) throw new Error("--timeout-ms requires a number");
      timeoutMs = Number(next);
      i += 1;
    } else if (arg === "--receipt-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--receipt-dir requires a path");
      receiptDir = next;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!chatId.trim()) throw new Error("status chat id is empty");
  if (!Number.isFinite(codexMaxFiles) || codexMaxFiles <= 0) throw new Error("codex max files must be positive");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be positive");

  return {
    dryRun,
    json,
    chatId,
    larkCliPath,
    claudeUsageSnapshotPath: resolve(claudeUsageSnapshotPath),
    kimiCliPath,
    kimiHomeDir: resolve(kimiHomeDir),
    codexSessionsDir: resolve(codexSessionsDir),
    codexMaxFiles,
    timeoutMs,
    receiptDir: resolve(receiptDir),
  };
}

function writeReceipt(receiptDir: string, payload: unknown, nowMs: number): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
  const path = join(receiptDir, `${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const codex = findLatestCodexRateLimits(opts.codexSessionsDir, opts.codexMaxFiles);
  const [claude, kimi] = await Promise.all([
    queryClaudeUsage({
      claudeUsageSnapshotPath: opts.claudeUsageSnapshotPath,
      timeoutMs: opts.timeoutMs,
    }),
    queryKimiUsage({
      kimiCliPath: opts.kimiCliPath,
      kimiHomeDir: opts.kimiHomeDir,
      timeoutMs: opts.timeoutMs,
    }),
  ]);
  const message = buildQuotaStatusMessage({ nowMs, codex, claude, kimi });
  const send = opts.dryRun
    ? null
    : await sendLarkText({ larkCliPath: opts.larkCliPath, chatId: opts.chatId, text: message, timeoutMs: opts.timeoutMs });
  const receiptPath = writeReceipt(opts.receiptDir, { nowMs, chatId: opts.chatId, codex, claude, kimi, message, send }, nowMs);

  if (opts.json) {
    console.log(JSON.stringify({ ok: send ? send.ok : true, receiptPath, codex, claude, kimi, send, message }, null, 2));
  } else {
    console.log(message);
    console.log(`receipt: ${receiptPath}`);
    if (send) console.log(`send: ok=${send.ok} code=${send.code ?? "-"} timedOut=${send.timedOut}`);
  }

  if (send && !send.ok) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  });
}
