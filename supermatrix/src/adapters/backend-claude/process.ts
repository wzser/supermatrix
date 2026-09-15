import { spawn } from "node:child_process";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import { SteerWindowClosedError } from "../../ports/AgentBackend.ts";
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
  /**
   * Inject a user message into the active turn. Resolves only after Claude
   * replays the matching user envelope on stdout (--replay-user-messages);
   * a successful stdin write alone never resolves. Rejects exactly once on
   * result, close, timeout, cancel, spawn error, or stdin failure.
   */
  steer(text: string): Promise<void>;
};

type ReplayWaiter = {
  text: string;
  /** Marks the promise-less initial-prompt placeholder in the head slot. */
  initial?: boolean;
  resolve?: () => void;
  reject?: (err: Error) => void;
};

// Extracts the concatenated text of a replayed stdin user envelope. Returns
// undefined for anything that is not such an envelope — in particular for
// tool_result user events, which also arrive as {"type":"user"} lines.
function extractUserEnvelopeText(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  const rec = record as Record<string, unknown>;
  if (rec["type"] !== "user") return undefined;
  const message = rec["message"];
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let sawText = false;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_result") return undefined;
    if (b["type"] === "text" && typeof b["text"] === "string") {
      sawText = true;
      parts.push(b["text"]);
    }
  }
  return sawText ? parts.join("") : undefined;
}

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
    settlePendingSteers(new Error("claude process closed before the injected message was acknowledged"));
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: undefined as unknown as AgentEvent, done: true });
    }
  };

  // FIFO of stdin user envelopes still awaiting their replay echo. The head
  // entry is the next replay we expect; the initial prompt occupies the first
  // slot (with no promise) so its echo can never acknowledge a later steer
  // that happens to carry identical text. Settle-exactly-once is structural:
  // every settle path removes entries from this queue first.
  const replayWaiters: ReplayWaiter[] = [];
  let stdinFailure: Error | undefined;
  let turnInputEnded = false;
  let writeChain: Promise<void> = Promise.resolve();

  const settlePendingSteers = (err: Error) => {
    const waiters = replayWaiters.splice(0, replayWaiters.length);
    for (const w of waiters) w.reject?.(err);
  };

  // stdin closes once the turn's terminal result arrived — claude in
  // stream-json input mode would otherwise wait for more user messages
  // instead of exiting.
  const endTurnInput = () => {
    if (turnInputEnded) return;
    turnInputEnded = true;
    try { child.stdin?.end(); } catch { /* empty */ }
    settlePendingSteers(new Error("turn completed before the injected message was acknowledged"));
  };

  const tryAcknowledgeReplay = (line: string) => {
    if (replayWaiters.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const text = extractUserEnvelopeText(record);
    if (text === undefined) return;
    const head = replayWaiters[0]!;
    if (head.text !== text) {
      // Tolerant head slot: the initial-prompt placeholder exists only to
      // absorb its own echo. Replays are FIFO in stdin-write order, so a
      // different envelope echo arriving while the placeholder still heads
      // the queue means this CLI does not replay the initial prompt at all —
      // drop the placeholder so real steer waiters cannot starve behind it.
      if (head.initial && replayWaiters[1]?.text === text) {
        replayWaiters.shift();
        replayWaiters.shift()!.resolve?.();
      }
      return;
    }
    const acknowledged = replayWaiters.shift()!;
    acknowledged.resolve?.();
  };

  const writeUserEnvelope = (payload: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // A prior write failure already rejected every queued waiter; writing
      // this payload anyway would inject text the user was told failed.
      if (stdinFailure) {
        reject(stdinFailure);
        return;
      }
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || turnInputEnded) {
        reject(new Error("claude stdin is not writable"));
        return;
      }
      let settled = false;
      const flushed = stdin.write(payload, (err) => {
        if (err && !settled) {
          settled = true;
          reject(err);
        }
      });
      if (flushed) {
        if (!settled) {
          settled = true;
          resolve();
        }
      } else {
        stdin.once("drain", () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      }
    });

  const steer = (text: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (done || cancelled || timedOut || turnInputEnded) {
        // turnInputEnded fires on the terminal result, which can precede the
        // run row leaving `running` by a long way — the child keeps working
        // after stdin closes. Typed so /now can tell the user the text was
        // definitively not injected instead of leaking this string.
        reject(
          new SteerWindowClosedError(
            "claude",
            "claude run is no longer accepting injected messages",
          ),
        );
        return;
      }
      if (stdinFailure) {
        reject(stdinFailure);
        return;
      }
      if (opts.stdin === undefined || !child.stdin || child.stdin.destroyed) {
        reject(new Error("claude stdin is unavailable for this run"));
        return;
      }
      replayWaiters.push({ text, resolve, reject });
      const payload = JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }) + "\n";
      writeChain = writeChain
        .then(() => writeUserEnvelope(payload))
        .catch((err) => {
          const failure = err instanceof Error ? err : new Error(String(err));
          stdinFailure = failure;
          settlePendingSteers(failure);
        });
    });

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
      settlePendingSteers(new Error(`[TIMEOUT] inactivity: no output for ${Math.round(opts.inactivityTimeoutMs! / 1000)}s`));
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
      settlePendingSteers(new Error(`[TIMEOUT] max runtime: exceeded ${Math.round(opts.maxRuntimeMs! / 1000)}s`));
      killProcess();
    }, opts.maxRuntimeMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    maxRuntimeTimer = t;
  }

  resetInactivityTimer();

  if (opts.stdin !== undefined) {
    child.stdin?.on("error", (err) => {
      stdinFailure = err;
      settlePendingSteers(err);
    });
    // The initial envelope is written WITHOUT closing stdin so the turn stays
    // steerable; endTurnInput closes it once the terminal result arrives. Its
    // replay echo must be consumed first, so it claims the head waiter slot.
    const initialText = (() => {
      try {
        return extractUserEnvelopeText(JSON.parse(opts.stdin.trim()));
      } catch {
        return undefined;
      }
    })();
    if (initialText !== undefined) replayWaiters.push({ text: initialText, initial: true });
    child.stdin?.write(opts.stdin);
  }

  let buffer = "";
  // Parser state MUST be shared across chunks — without this, each chunk
  // re-announces `started` because every line in claude's stream-json has a
  // session_id field. See parseClaudeStream for context.
  const parserState: ClaudeStreamState = createClaudeStreamState();
  // Lines are processed one at a time so replay acknowledgements settle in
  // stream order relative to the terminal result of the same chunk.
  const processLine = (line: string) => {
    tryAcknowledgeReplay(line);
    const events = parseClaudeStream([line], parserState);
    for (const e of events) {
      push(e);
      if (e.kind === "completed") endTurnInput();
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    resetInactivityTimer();
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop() ?? "";
    for (const part of parts) processLine(part);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderrBuf += chunk));

  child.on("error", (err) => {
    push({ kind: "error", message: err.message, recoverable: false });
    finish();
  });

  child.on("close", (code) => {
    if (buffer.trim()) {
      processLine(buffer);
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
    } else if (parserState.emptyResultSeen && !parserState.terminalResultSeen) {
      // An empty successful result is not terminal while the stream is alive,
      // but a clean child exit without a later non-empty result must fail
      // closed. Never let streamCollector turn that shape into green done.
      push({
        kind: "error",
        message: "claude returned empty completion",
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
    settlePendingSteers(new Error("cancelled by user"));
    killProcess();
  };

  return { iterable, cancel, pid: child.pid ?? null, steer };
}
