import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CodexModelAvailability,
  ModelAvailabilityResult,
} from "../../ports/CodexModelAvailability.ts";
import { getCodexModelCatalogFingerprint } from "../../ports/CodexModelCatalog.ts";
import { isConfirmedCodexModelUnavailable } from "./modelUnavailable.ts";
import { createCodexStreamState, parseCodexStream } from "./streamParser.ts";

const CACHE_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const TERMINATION_GRACE_MS = 500;
const PROBE_PROMPT = "Reply with exactly MODEL_AVAILABILITY_OK.";
const PROBE_RESPONSE = "MODEL_AVAILABILITY_OK";

export type ProbeProcessInput = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

export type ProbeProcessResult = {
  exitCode: number;
  stdout?: string | undefined;
  stderr?: string | undefined;
};

export type ProbeProcessHandle = {
  pid?: number | undefined;
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
};

export type ProbeProcessRunnerDependencies = {
  spawn?: (command: string, args: string[], options: {
    cwd: string;
    detached: true;
    stdio: ["ignore", "pipe", "pipe"];
  }) => ProbeProcessHandle;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
};

export type AuthStat = {
  path: string;
  size: number;
  mtimeMs: number;
  mode: number;
};

export type ModelAvailabilityProbeDependencies = {
  runProcess?: (input: ProbeProcessInput) => Promise<ProbeProcessResult>;
  now?: () => number;
  getCliVersion?: () => Promise<string>;
  getCatalogFingerprint?: () => string;
  getAuthStat?: () => Promise<AuthStat | null>;
  timeoutMs?: number;
  fs?: {
    makeTempDir(): Promise<string>;
    readDir(path: string): Promise<string[]>;
    removeDir(path: string): Promise<void>;
  };
};

export function createCodexModelAvailabilityProbe(
  dependencies: ModelAvailabilityProbeDependencies = {},
): CodexModelAvailability {
  const runProcess = dependencies.runProcess ?? defaultRunProcess;
  const now = dependencies.now ?? Date.now;
  const getCliVersion = dependencies.getCliVersion ?? defaultGetCliVersion;
  const getCatalogFingerprint =
    dependencies.getCatalogFingerprint ?? getCodexModelCatalogFingerprint;
  const getAuthStat = dependencies.getAuthStat ?? defaultGetAuthStat;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fs = dependencies.fs ?? defaultFs;
  const cache = new Map<string, ModelAvailabilityResult>();
  const inFlight = new Map<string, Promise<ModelAvailabilityResult>>();

  return {
    async probe(model: string): Promise<ModelAvailabilityResult> {
      const checkedAt = now();
      const key = cacheKey(
        model,
        await getCliVersion(),
        getCatalogFingerprint(),
        await getAuthStat(),
      );
      const cached = cache.get(key);
      if (cached && checkedAt - cached.checkedAt < CACHE_TTL_MS) return cached;

      const active = inFlight.get(key);
      if (active) return active;

      const execution = runProbe();
      inFlight.set(key, execution);
      try {
        return await execution;
      } finally {
        inFlight.delete(key);
      }

      async function runProbe(): Promise<ModelAvailabilityResult> {
        let tempDir: string | undefined;
        let result: ModelAvailabilityResult = {
          kind: "transient_failure",
          checkedAt,
          reason: "probe did not complete",
        };
        try {
          tempDir = await fs.makeTempDir();
          if ((await fs.readDir(tempDir)).length !== 0) {
            result = {
              kind: "transient_failure",
              checkedAt,
              reason: "probe temp directory was not empty",
            };
          } else {
            const processResult = await runProcess({
              command: "codex",
              args: [
                "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-rules",
                "--sandbox", "read-only", "--model", model, "--cd", tempDir, PROBE_PROMPT,
              ],
              cwd: tempDir,
              timeoutMs,
            });
            result = classifyProcessResult(processResult, checkedAt);
          }
        } catch (error) {
          result = {
            kind: "transient_failure",
            checkedAt,
            reason: error instanceof Error ? error.message : String(error),
          };
        } finally {
          if (tempDir) {
            try {
              await fs.removeDir(tempDir);
            } catch (error) {
              result = {
                kind: "transient_failure",
                checkedAt,
                reason: `cleanup failed: ${errorReason(error)}`,
              };
            }
          }
        }

        if (result.kind !== "transient_failure") cache.set(key, result);
        return result;
      }
    },
  };
}

function classifyProcessResult(
  result: ProbeProcessResult,
  checkedAt: number,
): ModelAvailabilityResult {
  if (result.exitCode === 0 && hasExpectedCompletedResponse(result.stdout)) {
    return { kind: "available", checkedAt };
  }
  const timeout = result.stderr?.match(/codex probe timed out after[^\r\n]*/iu)?.[0];
  if (timeout !== undefined) {
    return { kind: "transient_failure", checkedAt, reason: timeout };
  }
  const errors = parseOutput(result.stdout, result.stderr).filter(
    (error) => !isLifecycleEvent(error),
  );
  const unavailable = errors.find(isConfirmedCodexModelUnavailable);
  if (unavailable !== undefined) {
    return { kind: "unavailable", checkedAt, reason: errorReason(unavailable) };
  }
  return {
    kind: "transient_failure",
    checkedAt,
    reason: errorReason(errors[0] ?? `codex exited ${result.exitCode}`),
  };
}

function isLifecycleEvent(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("type" in error)) return false;
  return error.type === "thread.started" || error.type === "turn.started";
}

function hasExpectedCompletedResponse(stdout = ""): boolean {
  const state = createCodexStreamState();
  const events = parseCodexStream(stdout.split(/\r?\n/u), state, { flush: true });
  if (events.some((event) => event.kind === "error")) return false;
  const completed = events.filter((event) => event.kind === "completed");
  return (
    completed.length === 1 &&
    normalizeProbeFinalMessage(completed[0]?.finalMessage) === PROBE_RESPONSE
  );
}

// The probe asks the model to "Reply with exactly MODEL_AVAILABILITY_OK." and
// confirms the sentinel came back. Replies are free-form model text, so an
// available model can still wrap the sentinel in trivial edge formatting:
// gpt-5.6-sol deterministically echoes the instruction's own trailing period
// ("MODEL_AVAILABILITY_OK."), and other models may add quotes/backticks or
// surrounding whitespace. Strip that edge formatting before the exact match so
// the probe verifies the sentinel content instead of rejecting an available
// model over punctuation — which otherwise surfaced as spurious Codex spawn
// admission "校验失败" for sessions pinned to gpt-5.6-sol. Internal content is
// preserved, so an unrelated reply still fails the match.
function normalizeProbeFinalMessage(message: string | undefined): string {
  return (message ?? "")
    .trim()
    .replace(/^["'`*]+/u, "")
    .replace(/["'`*.!?。！？]+$/u, "")
    .trim();
}

function parseOutput(stdout = "", stderr = ""): unknown[] {
  const parsed: unknown[] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { parsed.push(JSON.parse(trimmed)); } catch { parsed.push(trimmed); }
  }
  return parsed;
}

function errorReason(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) return JSON.stringify(error);
  return String(error);
}

function cacheKey(model: string, cliVersion: string, catalog: string, auth: AuthStat | null): string {
  return createHash("sha256")
    .update(JSON.stringify({ model, cliVersion, catalog, auth }))
    .digest("hex");
}

const defaultFs = {
  makeTempDir: () => mkdtemp(join(tmpdir(), "supermatrix-codex-model-probe-")),
  readDir: (path: string) => readdir(path),
  removeDir: (path: string) => rm(path, { recursive: true, force: true }),
};

export function createProbeProcessRunner(
  dependencies: ProbeProcessRunnerDependencies = {},
): (input: ProbeProcessInput) => Promise<ProbeProcessResult> {
  const spawnProcess = dependencies.spawn ?? ((command, args, options) =>
    spawn(command, args, options));
  const killProcessGroup = dependencies.killProcessGroup ?? ((pid, signal) => {
    process.kill(-pid, signal);
  });

  return (input) => new Promise((resolve) => {
    const child = spawnProcess(input.command, input.args, {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    const settle = (result: ProbeProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };
    const timeoutResult = (): ProbeProcessResult => ({
      exitCode: 1,
      stdout,
      stderr: stderr || `codex probe timed out after ${input.timeoutMs}ms`,
    });
    const timeoutTimer = setTimeout(() => {
      if (child.pid !== undefined) {
        try { killProcessGroup(child.pid, "SIGTERM"); } catch { /* already exited */ }
      }
      graceTimer = setTimeout(() => {
        if (child.pid !== undefined) {
          try { killProcessGroup(child.pid, "SIGKILL"); } catch { /* already exited */ }
        }
        settle(timeoutResult());
      }, TERMINATION_GRACE_MS);
    }, input.timeoutMs);

    child.once("error", (error) => settle({ exitCode: 1, stdout, stderr: error.message }));
    child.once("close", (code) => settle({ exitCode: code ?? 1, stdout, stderr }));
  });
}

const defaultRunProcess = createProbeProcessRunner();

async function defaultGetCliVersion(): Promise<string> {
  const result = await defaultRunProcess({
    command: "codex", args: ["--version"], cwd: tmpdir(), timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return result.stdout?.trim() || `unknown:${result.exitCode}`;
}

async function defaultGetAuthStat(): Promise<AuthStat | null> {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  try {
    const metadata = await stat(path);
    return { path, size: metadata.size, mtimeMs: metadata.mtimeMs, mode: metadata.mode };
  } catch {
    return null;
  }
}
