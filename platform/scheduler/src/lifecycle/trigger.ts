import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ExitInfo, TriggerResult } from "./types.js";
import { defaultHttpExecutorPredicate } from "../spawn/predicate.js";

function invalidTimeoutError(value: unknown): string {
  return `invalid timeout: ${String(value)} (must be a positive finite number of ms; relying on the setTimeout default lets Node clamp to 1ms and SIGTERM the child)`;
}

function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Safety net keeping scheduler-fired spawn bodies compatible with the
 * 2026-05-19 strict `/api/spawn` contract. Three adjustments, all HTTP-400
 * triggers if left wrong:
 *  - `verification_predicate` — inject a default `inbox-message` predicate if
 *    the body lacks one. The 1.0 strict admission 400s on missing predicate.
 *    Task configs SHOULD carry their own task-specific predicate; this default
 *    only prevents a hard 400 for pre-migration task configs.
 *  - `from` (caller session name) is required — inject `"scheduler"` as a
 *    last-resort fallback when a body carries none. Task configs should set
 *    a proper owner session; this only catches mis-authored ones.
 *  - `mode` is no longer accepted — the endpoint 400s on it. Strip any
 *    residual `mode` left over from the retired caller-pickable modes.
 * Non-spawn HTTP and bodies that already carry all required fields are
 * otherwise untouched.
 */
export function sanitizeSpawnBody(
  url: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return body;
  }
  if (pathname !== "/api/spawn") return body;
  if (!("target" in body)) return body;

  let needsSanitize = false;
  const hasFrom = typeof body.from === "string" && body.from.trim() !== "";
  if (!hasFrom || "mode" in body) needsSanitize = true;
  const hasPredicate = body.verification_predicate != null && typeof body.verification_predicate === "object";
  if (!hasPredicate) needsSanitize = true;
  if (!needsSanitize) return body;

  const next = { ...body };
  delete next.mode;
  if (!hasFrom) next.from = "scheduler";
  if (!hasPredicate) {
    next.verification_predicate = defaultHttpExecutorPredicate(
      typeof body.target === "string" ? body.target : "unknown",
    );
  }
  return next;
}

export async function triggerShell(config: {
  command: string;
  cwd: string;
  timeout: number;
}): Promise<TriggerResult> {
  if (!isValidTimeoutMs(config.timeout)) {
    return { triggerOk: false, error: invalidTimeoutError(config.timeout) };
  }
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    return { triggerOk: false, error: `cwd does not exist or is not a directory: ${config.cwd}` };
  }

  const child = spawn("/bin/sh", ["-c", config.command], {
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (!child.pid) {
    return { triggerOk: false, error: "spawn failed (no PID)" };
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  const exitPromise = new Promise<ExitInfo>((resolve) => {
    let killed = false;
    let resolved = false;

    const safeResolve = (info: ExitInfo) => {
      if (resolved) return;
      resolved = true;
      resolve(info);
    };

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // SIGKILL escalation after 5 s — always attempt regardless of child.killed,
      // which Node sets true on the first .kill() call (not on process exit).
      setTimeout(() => {
        child.kill("SIGKILL");
        // Force-resolve deadline: if grandchildren inherited the pipe FDs and keep
        // them open after SIGKILL, the 'close' event never fires. Cap the hang at
        // 10 s post-SIGKILL so the verify cycle doesn't burn 3×30 min of grace.
        // exitCode=-1 (non-zero, non-null) makes exit_zero return retriable:false
        // so the run finalizes as evidence_missing on the very next verify tick.
        setTimeout(() => {
          safeResolve({
            exitCode: -1,
            signal: "SIGKILL",
            stdout,
            stderr: `${stderr}\n[scheduler: force-resolved after SIGKILL; grandchild held stdio pipe open]`,
            exitedAt: Date.now(),
          });
        }, 10_000);
      }, 5_000);
    }, config.timeout);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      safeResolve({
        exitCode: code,
        signal,
        stdout,
        stderr: killed ? `${stderr}\n[killed by scheduler timeout]` : stderr,
        exitedAt: Date.now(),
      });
    });
  });

  return {
    triggerOk: true,
    pid: child.pid,
    exitPromise,
  };
}

export async function triggerHttp(
  config: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    timeout: number;
  },
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<TriggerResult> {
  if (!isValidTimeoutMs(config.timeout)) {
    return { triggerOk: false, error: invalidTimeoutError(config.timeout) };
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

  try {
    const res = await fetchFn(config.url, {
      method: config.method,
      headers: config.headers,
      body: JSON.stringify(sanitizeSpawnBody(config.url, config.body)),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { triggerOk: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data.ok === false) {
      // HTTP 200 + ok:false. `switched_async` means the framework accepted the
      // spawn and handed it to the watcher — a successful trigger, not a
      // failure. Any other ok:false is a spawn the endpoint reported as bad.
      if (data.status === "switched_async") {
        return {
          triggerOk: true,
          asyncRef: typeof data.ref === "string" ? data.ref : undefined,
        };
      }
      return {
        triggerOk: false,
        error: `spawn rejected: ${JSON.stringify(data).slice(0, 200)}`,
      };
    }
    const rawChildSessionId = data.childSessionId as string | undefined;
    // Self-spawns can return ok:true with an async_* ref posing as childSessionId.
    // Route it to asyncRef so verify + receipt resolvers take the resolution path.
    if (typeof rawChildSessionId === "string" && rawChildSessionId.startsWith("async_")) {
      return {
        triggerOk: true,
        asyncRef: rawChildSessionId,
      };
    }
    return {
      triggerOk: true,
      childSessionId: rawChildSessionId,
      childMessageRunId: data.messageRunId as string | undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    return { triggerOk: false, error: (err as Error).message };
  }
}
