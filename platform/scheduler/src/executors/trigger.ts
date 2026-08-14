import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { ScriptConfig, SessionConfig, TriggerResult } from "../types.js";
import { sanitizeSpawnBody, type SchedulerSpawnContext } from "../spawn/sanitizeSpawnBody.js";

export async function triggerShell(args: {
  config: ScriptConfig;
  schedulerContext?: SchedulerSpawnContext;
}): Promise<TriggerResult> {
  const { config, schedulerContext: ctx } = args;
  if (!existsSync(config.cwd) || !statSync(config.cwd).isDirectory()) {
    return { ok: false, error: `cwd does not exist or is not a directory: ${config.cwd}` };
  }

  const env = ctx
    ? {
        ...process.env,
        // Run the script under the OWNER's identity, not scheduler's. The v2
        // process inherits SM_SESSION_NAME=scheduler from its launching shell;
        // passing it through unchanged makes owner scripts that resolve their
        // session/group from $SM_SESSION_NAME mis-attribute to scheduler (wrong
        // Feishu group; spawn caller=scheduler → child callbacks routed back to
        // scheduler's pool). Override it with the task owner.
        SM_SESSION_NAME: ctx.owner,
        SM_SCHEDULER_TASK_ID: ctx.taskId,
        SM_SCHEDULER_RUN_ID: ctx.runId,
        SM_SCHEDULER_TRIGGERED_AT: String(ctx.triggeredAt),
      }
    : process.env;

  // Wait-for-exit mode: used when config.timeout is set.
  // success = exit code 0; non-zero exit or timeout = failure.
  if (config.timeout !== undefined) {
    const stderrChunks: Buffer[] = [];
    const child = spawn("/bin/sh", ["-c", config.command], {
      cwd: config.cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env,
    });

    if (!child.pid) {
      return { ok: false, error: "spawn failed (no PID)" };
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    return new Promise<TriggerResult>((resolve) => {
      let settled = false;
      const settle = (r: TriggerResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        settle({ ok: false, error: `timeout after ${config.timeout}ms` });
      }, config.timeout);

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          settle({ ok: true, pid: child.pid });
        } else {
          const stderr = Buffer.concat(stderrChunks).toString().slice(0, 500).trim();
          settle({
            ok: false,
            error: `exit ${code ?? "signal " + String(signal)}${stderr ? ": " + stderr : ""}`,
            exitCode: code ?? undefined,
          });
        }
      });
    });
  }

  // Fire-and-forget: success = got a PID. We deliberately do not track the child's exit.
  const child = spawn("/bin/sh", ["-c", config.command], {
    cwd: config.cwd,
    detached: true,
    stdio: "ignore",
    env,
  });

  if (!child.pid) {
    return { ok: false, error: "spawn failed (no PID)" };
  }
  child.unref();
  return { ok: true, pid: child.pid };
}

export async function triggerHttp(
  config: SessionConfig & { schedulerContext?: SchedulerSpawnContext },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<TriggerResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  const pathname = (() => {
    try {
      return new URL(config.url).pathname;
    } catch {
      return "";
    }
  })();

  try {
    const res = await fetchFn(config.url, {
      method: config.method,
      headers: config.headers ?? {},
      body: JSON.stringify(
        sanitizeSpawnBody({
          pathname,
          body: config.body,
          schedulerContext: config.schedulerContext,
        }),
      ),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    // switched_async: the framework accepted the spawn and routed the child to the
    // async watcher, returning a `ref` instead of a sync childSessionId. The child
    // did start, so under fire-and-forget this is a trigger success — the ref is the
    // child reference. (Whether the work lands is the owner's job, not scheduler's.)
    if (data.status === "switched_async" && typeof data.ref === "string") {
      return { ok: true, childSessionId: data.ref };
    }
    if (data.ok === false) {
      return { ok: false, error: `spawn rejected: ${JSON.stringify(data).slice(0, 200)}` };
    }
    const childId = data.childSessionId;
    if (typeof childId !== "string" || childId.startsWith("async_")) {
      return { ok: false, error: `no real child_session_id (got: ${String(childId)})` };
    }
    return { ok: true, childSessionId: childId };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: (err as Error).message };
  }
}
