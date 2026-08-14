#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type BackendName = "claude" | "codex" | "kimi";

export type ConnectivityFailureKind =
  | "auth"
  | "model_access"
  | "transport"
  | "missing_cli"
  | "timeout"
  | "degraded"
  | "http_status"
  | "bad_payload"
  | "unknown";

type KimiHealthRoundtrip = {
  ok: boolean;
  error?: string;
  rttMs?: number;
};

type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

type ProbeResult = {
  backend: BackendName;
  ok: boolean;
  model?: string;
  failureKind?: ConnectivityFailureKind;
  excerpt?: string;
  httpStatus?: number;
  pid?: number;
  roundtrip?: KimiHealthRoundtrip;
  state?: string;
  skipped?: boolean;
  skippedReason?: string;
};

type RepairResult = {
  type: string;
  status: "applied" | "skipped" | "failed";
  detail: string;
};

type CheckSummary = {
  ok: boolean;
  probes: ProbeResult[];
  repairs: RepairResult[];
  restartRecommended: boolean;
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SCRIPT_DIR, "..");
const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_FALLBACK_MODEL = "gpt-5.4";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_CLAUDE_AUTH_TIMEOUT_MS = 15_000;
const DEFAULT_KIMI_ACP_HEALTH_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 20_000;
const CODEX_ROUTE_STATE_CONTRACT_VERSION = "sm-switch.route-state/v1";

function defaultCodexRouteStatePath(env: NodeJS.ProcessEnv): string {
  const override = env["SM_CODEX_ROUTE_STATE_PATH"]?.trim();
  if (override) return override;
  const runtimeRoot = env["SM_RUNTIME_ROOT"] || "/Users/LOCAL_USER/SuperMatrixRuntime";
  return resolve(runtimeRoot, "data", "sm-switch", "route-state.json");
}

type CodexRouteState = {
  route: "openai" | "deepseek";
  models: string[];
};

/**
 * Read-only consumer of the sm-switch route state (contract
 * sm-switch.route-state/v1), mirroring src/adapters/backend-codex/routeState.ts.
 * Every failure mode (file missing, unreadable JSON, unknown contractVersion,
 * unknown route) returns null so the caller fails open to the route=openai
 * status quo — route-state problems must never fail the probe itself.
 */
async function readCodexRouteState(path: string): Promise<CodexRouteState | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed["contractVersion"] !== CODEX_ROUTE_STATE_CONTRACT_VERSION) return null;
  if (parsed["backend"] !== "codex") return null;
  const route = parsed["route"];
  if (route !== "openai" && route !== "deepseek") return null;
  const models: string[] = [];
  const pushModel = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !models.includes(trimmed)) models.push(trimmed);
  };
  pushModel(parsed["defaultModel"]);
  if (Array.isArray(parsed["servedModels"])) parsed["servedModels"].forEach(pushModel);
  return { route, models };
}

function clip(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text;
  return `${text.slice(0, OUTPUT_LIMIT)}\n[truncated]`;
}

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, 600);
}

export function classifyBackendConnectivityError(text: string, codexRoute?: string): ConnectivityFailureKind {
  const normalized = text.toLowerCase();
  if (normalized.includes("model_not_served")) {
    // Under route=deepseek the served model set is owned by sm-switch/sm-proxy;
    // model_not_served means route-state/proxy drift, not a repairable codex
    // connectivity failure — the gpt-5.4 fallback repair must not fire there.
    return codexRoute === "deepseek" ? "degraded" : "model_access";
  }
  if (
    normalized.includes("api error: 401") ||
    normalized.includes("failed to authenticate") ||
    normalized.includes("unauthorized") ||
    normalized.includes("oauth") ||
    normalized.includes("keychain") ||
    normalized.includes("forbidden")
  ) {
    return "auth";
  }
  if (
    normalized.includes("does not exist or you do not have access") ||
    normalized.includes("model_not_found") ||
    normalized.includes("unknown model") ||
    normalized.includes("invalid model")
  ) {
    return "model_access";
  }
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("etimedout")
  ) {
    return "timeout";
  }
  if (
    normalized.includes("socket connection was closed") ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("eai_again") ||
    normalized.includes("connection refused") ||
    normalized.includes("connection reset") ||
    normalized.includes("proxy") ||
    normalized.includes("tls") ||
    normalized.includes("certificate")
  ) {
    return "transport";
  }
  if (normalized.includes("enoent") || normalized.includes("command not found")) {
    return "missing_cli";
  }
  return "unknown";
}

export function updateEnvAssignment(content: string, key: string, value: string): string {
  const sourceLines = content.endsWith("\n")
    ? content.slice(0, -1).split("\n")
    : content.length > 0
      ? content.split("\n")
      : [];
  let replaced = false;
  const pattern = new RegExp(`^(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`);
  const lines = sourceLines.map((line) => {
    if (!replaced && pattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) lines.push(`${key}=${value}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function selectedProxyName(proxy: unknown): string | null {
  if (!proxy || typeof proxy !== "object") return null;
  const record = proxy as Record<string, unknown>;
  const now = record["now"];
  if (typeof now === "string" && now.trim() !== "") return now;
  const fixed = record["fixed"];
  if (typeof fixed === "string" && fixed.trim() !== "") return fixed;
  return null;
}

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]!] = value;
  }
  return env;
}

async function readEnv(envFile: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(envFile, "utf8"));
  } catch {
    return {};
  }
}

function buildClaudeArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--permission-mode",
    "default",
    "--model",
    model,
    "Reply with exactly OK.",
  ];
}

function buildCodexArgs(model: string, repoDir: string): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--ephemeral",
    "--model",
    model,
    "-c",
    "model_reasoning_effort=low",
    "--cd",
    repoDir,
    "Reply with exactly OK and nothing else.",
  ];
}

async function runCommand(
  file: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result: CommandResult) => {
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
    // close fires after stdout/stderr are drained; exit can race the terminal
    // stream-json result and leave the probe with startup-hook lines only.
    child.on("close", (code) => {
      finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

function claudeTerminalResult(stdout: string): { ok: boolean } | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || event["type"] !== "result") continue;
    return {
      ok: event["subtype"] === "success" && event["is_error"] !== true,
    };
  }
  return null;
}

async function probeBackend(
  backend: BackendName,
  model: string,
  options: { timeoutMs: number; repoDir: string; env: NodeJS.ProcessEnv; claudeCli: string; codexCli: string; codexRoute?: string },
): Promise<ProbeResult> {
  const cmd =
    backend === "claude"
      ? { file: options.claudeCli, args: buildClaudeArgs(model) }
      : { file: options.codexCli, args: buildCodexArgs(model, options.repoDir) };
  const result = await runCommand(cmd.file, cmd.args, options.timeoutMs, options.env);
  const terminalResult = backend === "claude" ? claudeTerminalResult(result.stdout) : null;
  if (backend === "claude" ? terminalResult?.ok === true && !result.timedOut : result.ok) {
    return { backend, ok: true, model };
  }
  const combined = `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`;
  const classified = result.timedOut
    ? "timeout"
    : classifyBackendConnectivityError(combined, backend === "codex" ? options.codexRoute : undefined);
  const failureKind = backend === "claude" && terminalResult === null && classified === "unknown"
    ? "bad_payload"
    : classified;
  return {
    backend,
    ok: false,
    model,
    failureKind,
    excerpt: redact(combined).trim(),
  };
}

async function probeClaudeAuth(
  model: string,
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; claudeCli: string },
): Promise<ProbeResult> {
  const result = await runCommand(
    options.claudeCli,
    ["auth", "status"],
    options.timeoutMs,
    options.env,
  );
  let status: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      status = parsed as Record<string, unknown>;
    }
  } catch {
    status = null;
  }

  if (status?.["loggedIn"] === true) {
    return { backend: "claude", ok: true, model };
  }
  if (status?.["loggedIn"] === false) {
    const authMethod = typeof status["authMethod"] === "string" ? status["authMethod"] : "unknown";
    const apiProvider = typeof status["apiProvider"] === "string" ? status["apiProvider"] : "unknown";
    return {
      backend: "claude",
      ok: false,
      model,
      failureKind: "auth",
      excerpt: `claude auth status: loggedIn=false authMethod=${authMethod} apiProvider=${apiProvider}; run: claude auth login --claudeai`,
    };
  }

  const combined = `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`;
  const failureKind = result.timedOut ? "timeout" : classifyBackendConnectivityError(combined);
  return {
    backend: "claude",
    ok: false,
    model,
    failureKind,
    excerpt: redact(combined).trim() || "claude auth status returned no valid JSON",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kimiHealthDetails(payload: Record<string, unknown>): Pick<ProbeResult, "pid" | "roundtrip" | "state"> {
  const details: Pick<ProbeResult, "pid" | "roundtrip" | "state"> = {};
  if (typeof payload["pid"] === "number") details.pid = payload["pid"];
  if (typeof payload["state"] === "string") details.state = payload["state"];

  const rawRoundtrip = payload["roundtrip"];
  if (isRecord(rawRoundtrip) && typeof rawRoundtrip["ok"] === "boolean") {
    const roundtrip: KimiHealthRoundtrip = { ok: rawRoundtrip["ok"] };
    if (typeof rawRoundtrip["rttMs"] === "number") roundtrip.rttMs = rawRoundtrip["rttMs"];
    if (typeof rawRoundtrip["error"] === "string") roundtrip.error = rawRoundtrip["error"];
    details.roundtrip = roundtrip;
  }
  return details;
}

function kimiHealthFailure(
  failureKind: ConnectivityFailureKind,
  excerpt: string,
  details: Pick<ProbeResult, "pid" | "roundtrip" | "state"> = {},
  httpStatus?: number,
): ProbeResult {
  return {
    backend: "kimi",
    ok: false,
    failureKind,
    excerpt: redact(excerpt).trim(),
    ...details,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

/**
 * Probe the process-owned shared Kimi ACP health endpoint. This intentionally
 * does not invoke the Kimi CLI: launching a probe process would not exercise
 * the ACP connection that serves SuperMatrix sessions.
 */
async function probeKimiAcpHealth(options: {
  apiPort: string;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const endpoint = `http://127.0.0.1:${options.apiPort}/api/health/kimi-acp`;
  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureKind = /abort|timed out|timeout/i.test(message)
      ? "timeout"
      : "transport";
    return kimiHealthFailure(failureKind, `${endpoint}: ${message}`);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failureKind = /abort|timed out|timeout/i.test(message)
      ? "timeout"
      : "transport";
    return kimiHealthFailure(failureKind, `${endpoint}: ${message}`, {}, response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return kimiHealthFailure(
      response.status === 503 ? "degraded" : response.ok ? "bad_payload" : "http_status",
      `${endpoint}: HTTP ${response.status} returned invalid JSON: ${text}`,
      {},
      response.status,
    );
  }

  if (!isRecord(payload)) {
    return kimiHealthFailure(
      response.status === 503 ? "degraded" : response.ok ? "bad_payload" : "http_status",
      `${endpoint}: HTTP ${response.status} returned a non-object JSON payload`,
      {},
      response.status,
    );
  }

  const details = kimiHealthDetails(payload);
  if (!response.ok) {
    return kimiHealthFailure(
      response.status === 503 && payload["status"] === "degraded" ? "degraded" : "http_status",
      `${endpoint}: HTTP ${response.status} ${text}`,
      details,
      response.status,
    );
  }

  const healthy =
    payload["status"] === "ok" &&
    payload["backend"] === "kimi" &&
    payload["state"] === "ready" &&
    Number.isInteger(payload["pid"]) &&
    (payload["pid"] as number) > 0 &&
    details.roundtrip?.ok === true &&
    typeof details.roundtrip.rttMs === "number" &&
    Number.isFinite(details.roundtrip.rttMs) &&
    details.roundtrip.rttMs >= 0;
  if (healthy) {
    return { backend: "kimi", ok: true, ...details, httpStatus: response.status };
  }

  const degraded = payload["status"] === "degraded" || details.roundtrip?.ok === false;
  return kimiHealthFailure(
    degraded ? "degraded" : "bad_payload",
    `${endpoint}: HTTP ${response.status} ${text}`,
    details,
    response.status,
  );
}

async function fetchMihomoProxy(socketPath: string, name: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const result = await runCommand(
    "curl",
    [
      "-sS",
      "--max-time",
      "5",
      "--unix-socket",
      socketPath,
      `http://unix/proxies/${encodeURIComponent(name)}`,
    ],
    timeoutMs,
  );
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof parsed["message"] === "string" && parsed["message"] === "Resource not found") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function setMihomoProxy(
  socketPath: string,
  groupName: string,
  targetName: string,
  timeoutMs: number,
): Promise<boolean> {
  const result = await runCommand(
    "curl",
    [
      "-sS",
      "--max-time",
      "5",
      "-X",
      "PUT",
      "--unix-socket",
      socketPath,
      `http://unix/proxies/${encodeURIComponent(groupName)}`,
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ name: targetName }),
    ],
    timeoutMs,
  );
  return result.ok;
}

async function alignCodexProxyToClaude(options: {
  socketPath: string;
  codexGroup: string;
  claudeGroupCandidates: string[];
  timeoutMs: number;
  dryRun: boolean;
}): Promise<RepairResult> {
  if (!existsSync(options.socketPath)) {
    return { type: "mihomo_proxy_align", status: "skipped", detail: "mihomo socket not found" };
  }

  const codexProxy = await fetchMihomoProxy(options.socketPath, options.codexGroup, options.timeoutMs);
  if (!codexProxy) {
    return { type: "mihomo_proxy_align", status: "skipped", detail: `proxy group not found: ${options.codexGroup}` };
  }
  const codexChoices = Array.isArray(codexProxy["all"]) ? codexProxy["all"].filter((v): v is string => typeof v === "string") : [];
  const currentCodex = selectedProxyName(codexProxy);

  for (const candidateName of options.claudeGroupCandidates) {
    const claudeProxy = await fetchMihomoProxy(options.socketPath, candidateName, options.timeoutMs);
    if (!claudeProxy) continue;
    const selectedClaude = selectedProxyName(claudeProxy);
    const target = codexChoices.includes(candidateName)
      ? candidateName
      : selectedClaude && codexChoices.includes(selectedClaude)
        ? selectedClaude
        : null;
    if (!target) {
      return {
        type: "mihomo_proxy_align",
        status: "skipped",
        detail: `no shared target between ${options.codexGroup} and ${candidateName}`,
      };
    }
    if (currentCodex === target) {
      return { type: "mihomo_proxy_align", status: "skipped", detail: `${options.codexGroup} already uses ${target}` };
    }
    if (options.dryRun) {
      return { type: "mihomo_proxy_align", status: "applied", detail: `dry-run would set ${options.codexGroup} -> ${target}` };
    }
    const applied = await setMihomoProxy(options.socketPath, options.codexGroup, target, options.timeoutMs);
    return {
      type: "mihomo_proxy_align",
      status: applied ? "applied" : "failed",
      detail: applied ? `set ${options.codexGroup} -> ${target}` : `failed to set ${options.codexGroup} -> ${target}`,
    };
  }

  return { type: "mihomo_proxy_align", status: "skipped", detail: "claude proxy group not found" };
}

async function applyCodexFallback(options: {
  envFile: string;
  currentModel: string;
  fallbackModel: string;
  codexCli: string;
  timeoutMs: number;
  repoDir: string;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
}): Promise<{ probe: ProbeResult | null; repair: RepairResult }> {
  if (options.currentModel === options.fallbackModel) {
    return {
      probe: null,
      repair: { type: "codex_model_fallback", status: "skipped", detail: "already using fallback model" },
    };
  }
  const fallbackProbe = await probeBackend("codex", options.fallbackModel, {
    timeoutMs: options.timeoutMs,
    repoDir: options.repoDir,
    env: options.env,
    claudeCli: "claude",
    codexCli: options.codexCli,
  });
  if (!fallbackProbe.ok) {
    return {
      probe: fallbackProbe,
      repair: {
        type: "codex_model_fallback",
        status: "failed",
        detail: `fallback ${options.fallbackModel} failed: ${fallbackProbe.failureKind ?? "unknown"}`,
      },
    };
  }
  if (!options.dryRun) {
    const current = await readFile(options.envFile, "utf8").catch(() => "");
    await writeFile(options.envFile, updateEnvAssignment(current, "SM_CODEX_DEFAULT_MODEL", options.fallbackModel), "utf8");
  }
  return {
    probe: fallbackProbe,
    repair: {
      type: "codex_model_fallback",
      status: "applied",
      detail: `${options.currentModel} -> ${options.fallbackModel}${options.dryRun ? " (dry-run)" : ""}`,
    },
  };
}

async function runConnectivityCheck(args: string[]): Promise<CheckSummary> {
  const authOnly = args.includes("--auth-only");
  const repair = args.includes("--repair") && !authOnly;
  const dryRun = args.includes("--dry-run");
  const envFile = process.env["SM_BACKEND_API_ENV_FILE"] ?? resolve(REPO_DIR, ".env.local");
  const fileEnv = await readEnv(envFile);
  const mergedEnv: NodeJS.ProcessEnv = { ...fileEnv, ...process.env };
  const timeoutMs = Number(mergedEnv["SM_BACKEND_API_PROBE_TIMEOUT_MS"] ?? DEFAULT_TIMEOUT_MS);
  const claudeAuthTimeoutMs = Number(
    mergedEnv["SM_CLAUDE_AUTH_CHECK_TIMEOUT_MS"] ?? DEFAULT_CLAUDE_AUTH_TIMEOUT_MS,
  );
  const claudeModel = mergedEnv["SM_CLAUDE_DEFAULT_MODEL"] || DEFAULT_CLAUDE_MODEL;
  const codexModel = mergedEnv["SM_CODEX_DEFAULT_MODEL"] || DEFAULT_CODEX_MODEL;
  const codexFallbackModel = mergedEnv["SM_CODEX_FALLBACK_MODEL"] || DEFAULT_CODEX_FALLBACK_MODEL;
  const claudeCli = mergedEnv["SM_CLAUDE_CLI_PATH"] || "claude";
  const codexCli = mergedEnv["SM_CODEX_CLI_PATH"] || "codex";
  const repoDir = mergedEnv["SM_BACKEND_API_PROBE_CWD"] || REPO_DIR;
  const apiPort = mergedEnv["SM_API_PORT"] || "3501";
  const kimiAcpHealthTimeoutMs = Math.min(timeoutMs, DEFAULT_KIMI_ACP_HEALTH_TIMEOUT_MS);
  const claudeAuthProbe = await probeClaudeAuth(claudeModel, {
    timeoutMs: claudeAuthTimeoutMs,
    env: mergedEnv,
    claudeCli,
  });
  // Route-aware codex probe: read-only sm-switch route state, fail-open to the
  // route=openai status quo (gpt-5.5 + gpt-5.4 fallback) whenever the state is
  // missing/corrupt/unrecognized or explicitly openai.
  const codexRouteState = await readCodexRouteState(defaultCodexRouteStatePath(mergedEnv));
  const codexRoute = codexRouteState?.route ?? "openai";
  const codexProbeModel = codexRoute === "deepseek" ? codexRouteState?.models[0] : codexModel;
  const codexSkippedReason =
    codexRoute === "deepseek" && !codexProbeModel
      ? "route=deepseek but route-state.json has no usable defaultModel/servedModels"
      : null;
  const probes = authOnly
    ? [claudeAuthProbe]
    : await Promise.all([
        claudeAuthProbe.ok
          ? probeBackend("claude", claudeModel, {
              timeoutMs,
              repoDir,
              env: mergedEnv,
              claudeCli,
              codexCli,
            })
          : Promise.resolve(claudeAuthProbe),
        codexSkippedReason !== null
          ? Promise.resolve<ProbeResult>({
              // Not a connectivity failure: ok stays true (localwatch counts
              // failures off .ok) and skipped/skippedReason carry the cause.
              backend: "codex",
              ok: true,
              skipped: true,
              skippedReason: codexSkippedReason,
            })
          : probeBackend("codex", codexProbeModel ?? codexModel, {
              timeoutMs,
              repoDir,
              env: mergedEnv,
              claudeCli,
              codexCli,
              codexRoute,
            }),
        probeKimiAcpHealth({ apiPort, timeoutMs: kimiAcpHealthTimeoutMs }),
      ]);
  const repairs: RepairResult[] = [];
  let restartRecommended = false;

  if (repair && probes.some(
    (probe) => probe.backend !== "kimi" && (probe.failureKind === "transport" || probe.failureKind === "timeout"),
  )) {
    const explicitClaudeGroup = mergedEnv["SM_CLAUDE_PROXY_GROUP"];
    const claudeGroupCandidates = [
      explicitClaudeGroup,
      "Claude-Stable",
      "Claude Code Stable",
    ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
    repairs.push(await alignCodexProxyToClaude({
      socketPath: mergedEnv["SM_MIHOMO_SOCKET"] || "/tmp/verge/verge-mihomo.sock",
      codexGroup: mergedEnv["SM_CODEX_PROXY_GROUP"] || "Codex-Fast",
      claudeGroupCandidates,
      timeoutMs,
      dryRun,
    }));
  }

  const codexProbe = probes.find((probe) => probe.backend === "codex");
  // The gpt-5.4 fallback repair is openai-route only: under route=deepseek the
  // served set is owned by sm-switch/sm-proxy and model failures there mean
  // route-state drift (classified "degraded"), never a reason to rewrite
  // SM_CODEX_DEFAULT_MODEL.
  if (repair && codexRoute !== "deepseek" && codexProbe && !codexProbe.ok && codexProbe.failureKind === "model_access") {
    const fallback = await applyCodexFallback({
      envFile,
      currentModel: codexModel,
      fallbackModel: codexFallbackModel,
      codexCli,
      timeoutMs,
      repoDir,
      env: { ...mergedEnv, SM_CODEX_DEFAULT_MODEL: codexFallbackModel },
      dryRun,
    });
    repairs.push(fallback.repair);
    if (fallback.probe?.ok) {
      const index = probes.findIndex((probe) => probe.backend === "codex");
      probes[index] = fallback.probe;
      restartRecommended = true;
    }
  }

  return {
    ok: probes.every((probe) => probe.ok),
    probes,
    repairs,
    restartRecommended,
  };
}

async function main() {
  const summary = await runConnectivityCheck(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(summary.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(JSON.stringify({
      ok: false,
      probes: [],
      repairs: [],
      restartRecommended: false,
      error: redact(String(err)),
    }) + "\n");
    process.exit(1);
  });
}
