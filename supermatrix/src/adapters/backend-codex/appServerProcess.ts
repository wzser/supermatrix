import { spawn } from "node:child_process";
import { normalizeCodexChildEnv } from "./process.ts";
import {
  createAppServerProtocol,
  type AppServerNotification,
  type AppServerProtocol,
} from "./appServerProtocol.ts";

// Per-run bidirectional stdio transport for `codex app-server`. Spawns one
// child per SuperMatrix run (the protocol layer enforces the one-thread
// invariant), wires newline-delimited stdout into JSON-RPC correlation, and
// reuses the detached process-group + SIGTERM→SIGKILL grace semantics of the
// legacy exec-json helper in process.ts without touching its contract.

export type AppServerProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
  onNotification?: (notification: AppServerNotification) => void;
};

export type AppServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

export type AppServerProcessHandle = {
  protocol: AppServerProtocol;
  pid: number | null;
  /** Resolves once the child has exited (or failed to spawn). Never rejects. */
  exited: Promise<AppServerExit>;
  /** Graceful shutdown: EOF on stdin lets the app-server exit on its own. */
  endInput(): void;
  /** Process-group SIGTERM, escalating to SIGKILL after killGraceMs. */
  kill(): void;
};

export function spawnAppServerProcess(opts: AppServerProcessOptions): AppServerProcessHandle {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: normalizeCodexChildEnv(opts.env ?? process.env),
    detached: true,
  });

  // Unref child so it doesn't keep our process alive if abandoned
  child.unref();

  let stderrBuf = "";
  let stdoutBuf = "";
  let killed = false;

  const protocol = createAppServerProtocol({
    writeLine: (line) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || !stdin.writable) {
        throw new Error("codex app-server stdin is closed");
      }
      stdin.write(`${line}\n`);
    },
    ...(opts.onNotification ? { onNotification: opts.onNotification } : {}),
  });

  // EPIPE from a child that closed its stdin read end arrives asynchronously,
  // so the synchronous destroyed/writable guard in writeLine cannot catch it;
  // without this handler it becomes an uncaughtException that kills the whole
  // parent process. Same convention as backend-claude/process.ts.
  child.stdin?.on("error", (err) => {
    protocol.failAllPending(err instanceof Error ? err : new Error(String(err)));
  });

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    const parts = stdoutBuf.split(/\r?\n/u);
    stdoutBuf = parts.pop() ?? "";
    for (const part of parts) protocol.handleLine(part);
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (stderrBuf += chunk));

  const exited = new Promise<AppServerExit>((resolve) => {
    let settled = false;
    child.on("error", (err) => {
      protocol.failAllPending(err);
      if (settled) return;
      settled = true;
      resolve({ code: null, signal: null, stderr: stderrBuf.trim() || err.message });
    });
    child.on("close", (code, signal) => {
      if (stdoutBuf.trim()) {
        protocol.handleLine(stdoutBuf);
        stdoutBuf = "";
      }
      const detail = stderrBuf.trim();
      const exitLabel = code !== null ? `exit ${code}` : `signal ${signal ?? "unknown"}`;
      protocol.failAllPending(
        new Error(
          killed
            ? "codex app-server killed"
            : `codex app-server closed (${exitLabel})${detail ? `: ${detail}` : ""}`,
        ),
      );
      if (settled) return;
      settled = true;
      resolve({ code, signal, stderr: detail });
    });
  });

  const endInput = (): void => {
    try {
      child.stdin?.end();
    } catch {
      /* empty */
    }
  };

  const kill = (): void => {
    killed = true;
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

  return { protocol, pid: child.pid ?? null, exited, endInput, kill };
}
