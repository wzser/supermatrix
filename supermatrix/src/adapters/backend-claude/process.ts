import { spawn } from "node:child_process";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import {
  createClaudeStreamState,
  parseClaudeStream,
  type ClaudeStreamState,
} from "./streamParser.ts";

export type StreamOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
  stdin?: string;
};

export type StreamHandle = {
  iterable: AsyncIterable<AgentEvent>;
  cancel(): void;
  pid: number | null;
};

export function spawnAndStream(opts: StreamOptions): StreamHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
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

  if (opts.stdin !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdin);
  }

  let buffer = "";
  // Parser state MUST be shared across chunks — without this, each chunk
  // re-announces `started` because every line in claude's stream-json has a
  // session_id field. See parseClaudeStream for context.
  const parserState: ClaudeStreamState = createClaudeStreamState();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    resetInactivityTimer();
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() ?? "";
    const events = parseClaudeStream(parts, parserState);
    for (const e of events) push(e);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderrBuf += chunk));

  child.on("error", (err) => {
    push({ kind: "error", message: err.message, recoverable: false });
    finish();
  });

  child.on("close", (code) => {
    if (buffer.trim()) {
      const tail = parseClaudeStream([buffer], parserState);
      for (const e of tail) push(e);
    }
    if (timedOut) {
      // error already pushed by timer callback — just finish
    } else if (cancelled) {
      push({ kind: "error", message: "cancelled by user", recoverable: false });
    } else if (code !== 0) {
      push({
        kind: "error",
        message: stderrBuf.trim() || `exit ${code}`,
        recoverable: false,
      });
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
