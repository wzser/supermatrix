import { spawn } from "node:child_process";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import {
  createCodexStreamState,
  parseCodexStream,
  type CodexStreamState,
} from "./streamParser.ts";

// codex-cli 0.128.0 prints this line to stderr at startup on every `exec`
// invocation (verified across gpt-5.3 / gpt-5.4 / gpt-5.5, with --json, with
// stdin=ignore). It is informational, not an error — but when codex exits
// non-zero it gets included in stderrBuf and used to be the entire
// error_message, masking the real API error from stdout JSON.
// Exact-match (not startsWith) so future variants like
// "Reading additional input from stdin... failed: …" still surface.
const CODEX_STDIN_PROMPT_NOISE = "Reading additional input from stdin...";

function filterKnownCodexStderrNoise(stderr: string): string {
  return stderr
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== CODEX_STDIN_PROMPT_NOISE)
    .join("\n")
    .trim();
}

export type StreamOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  fallbackModel?: string | null;
  killGraceMs?: number;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
};

export type StreamHandle = {
  iterable: AsyncIterable<AgentEvent>;
  cancel(): void;
  pid: number | null;
};

function normalizeCodexChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...env };
  for (const [lower, upper] of [
    ["http_proxy", "HTTP_PROXY"],
    ["https_proxy", "HTTPS_PROXY"],
    ["all_proxy", "ALL_PROXY"],
    ["no_proxy", "NO_PROXY"],
  ] as const) {
    const lowerValue = normalized[lower];
    const upperValue = normalized[upper];
    if (upperValue && !lowerValue) {
      normalized[lower] = upperValue;
    } else if (lowerValue && !upperValue) {
      normalized[upper] = lowerValue;
    }
  }
  return normalized;
}

export function spawnAndStream(opts: StreamOptions): StreamHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: normalizeCodexChildEnv(opts.env ?? process.env),
    detached: true,
  });

  // Unref child so it doesn't keep our process alive if abandoned
  child.unref();

  const queue: AgentEvent[] = [];
  let waiter: ((value: IteratorResult<AgentEvent>) => void) | undefined;
  let done = false;
  let cancelled = false;
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;
  let stderrBuf = "";

  const push = (event: AgentEvent) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const finish = () => {
    done = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: undefined as unknown as AgentEvent, done: true });
    }
  };

  const killProcess = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* empty */ }
    }
    const grace = opts.killGraceMs ?? 3_000;
    const t = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try { if (child.pid) child.kill("SIGKILL"); } catch { /* empty */ }
      }
    }, grace);
    if (typeof t === "object" && "unref" in t) t.unref();
  };

  const resetInactivityTimer = () => {
    if (!opts.inactivityTimeoutMs || done || cancelled || timedOut) return;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    const t = setTimeout(() => {
      if (done || cancelled || timedOut) return;
      timedOut = true;
      push({
        kind: "error",
        message: `[TIMEOUT] inactivity: no output for ${Math.round(opts.inactivityTimeoutMs! / 1000)}s`,
        recoverable: false,
      });
      killProcess();
    }, opts.inactivityTimeoutMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    inactivityTimer = t;
  };

  if (opts.maxRuntimeMs) {
    const t = setTimeout(() => {
      if (done || cancelled || timedOut) return;
      timedOut = true;
      push({
        kind: "error",
        message: `[TIMEOUT] max runtime: exceeded ${Math.round(opts.maxRuntimeMs! / 1000)}s`,
        recoverable: false,
      });
      killProcess();
    }, opts.maxRuntimeMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    maxRuntimeTimer = t;
  }

  resetInactivityTimer();

  let buffer = "";
  // Track whether a real error already came through the stdout JSON stream
  // (e.g. codex emitting `{"type":"error",...}` for an API 400). The close
  // handler uses this to avoid piling on a useless `exit X` on top of the
  // already-informative error when stderr only carries known noise.
  let sawError = false;
  const parserState: CodexStreamState = createCodexStreamState(opts.fallbackModel);
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    resetInactivityTimer();
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() ?? "";
    const events = parseCodexStream(parts, parserState);
    for (const e of events) {
      if (e.kind === "error") sawError = true;
      push(e);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderrBuf += chunk));

  child.on("error", (err) => {
    push({ kind: "error", message: err.message, recoverable: false });
    finish();
  });

  child.on("close", (code) => {
    const tail = parseCodexStream(buffer.trim() ? [buffer] : [], parserState, { flush: true });
    for (const e of tail) {
      if (e.kind === "error") sawError = true;
      push(e);
    }
    if (timedOut) {
      // error already pushed by timer callback — just finish
    } else if (cancelled) {
      push({ kind: "error", message: "cancelled by user", recoverable: false });
    } else if (code !== 0) {
      // Strip codex CLI's startup stdin-prompt line; it's informational, not
      // an error, and used to clobber the real API error from stdout JSON.
      const filteredStderr = filterKnownCodexStderrNoise(stderrBuf);
      // If stdout already surfaced a real error and stderr only had noise,
      // don't pile on a low-information `exit ${code}` event — first-error-wins
      // in streamCollector will keep the informative one anyway, but we still
      // save a useless entry in the stream_log forensics trail.
      if (filteredStderr || !sawError) {
        push({
          kind: "error",
          message: filteredStderr || `exit ${code}`,
          recoverable: false,
        });
      }
    }
    finish();
  });

  const iterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return(): Promise<IteratorResult<AgentEvent>> {
          cancel();
          return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
        },
      };
    },
  };

  const cancel = () => {
    if (cancelled || done || timedOut) return;
    cancelled = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
    killProcess();
  };

  return { iterable, cancel, pid: child.pid ?? null };
}
