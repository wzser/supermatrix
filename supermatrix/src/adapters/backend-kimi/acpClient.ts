// src/adapters/backend-kimi/acpClient.ts
//
// Wraps @zed-industries/agent-client-protocol ClientSideConnection.
// Manages the kimi acp child process lifecycle (lazy-spawn on first use).
//
// In tests, pass { streams } to inject pre-wired PassThrough streams
// instead of spawning the real kimi binary.
//
// ndJsonStream(output, input):
//   output = WritableStream — where to send encoded messages (→ child stdin)
//   input  = ReadableStream — where to receive messages    (← child stdout)
// Matches the working probe script (T0) which used:
//   ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import type {
  SessionNotification,
  ContentBlock,
  PromptResponse,
} from "@zed-industries/agent-client-protocol";

export type AcpClientOptions = {
  /** Path to kimi binary. Defaults to SM_KIMI_CLI_PATH env or "kimi". */
  command?: string;
  /** Args to pass to kimi. Defaults to ["acp"]. */
  args?: string[];
  /**
   * Test-only injection. When provided, AcpClient uses these streams directly
   * and skips spawning a child process.
   *
   *   stdin  = where the client writes outgoing messages (→ server reads)
   *   stdout = where the client reads incoming messages  (← server writes)
   */
  streams?: { stdin: Writable; stdout: Readable };
};

export type PromptArgs = {
  sessionId: string;
  blocks: ContentBlock[];
  onUpdate: (update: SessionNotification["update"]) => void;
};

export class AcpClient {
  private child: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private state: "init" | "ready" | "dead" = "init";
  private readyP: Promise<void> | null = null;
  private ensureReadyLock: Promise<void> | null = null;

  /** Routes sessionId → onUpdate callback during active prompts. */
  private updateRouters = new Map<
    string,
    (u: SessionNotification["update"]) => void
  >();

  /** Buffers the last chunks of stderr for diagnostics. */
  private stderrBuffer: Buffer[] = [];
  private onExitListener: (() => void) | null = null;
  private onErrorListener: ((err: Error) => void) | null = null;

  constructor(private readonly opts: AcpClientOptions = {}) {}

  /** Idempotent: initializes the ACP connection on first call. */
  async ensureReady(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state === "dead") throw new Error("AcpClient has been disposed");
    if (this.readyP) return this.readyP;
    if (this.ensureReadyLock) return this.ensureReadyLock;

    this.ensureReadyLock = this.start().finally(() => {
      this.ensureReadyLock = null;
    });
    this.readyP = this.ensureReadyLock;
    return this.readyP;
  }

  private async start(): Promise<void> {
    let nodeStdin: Writable;
    let nodeStdout: Readable;

    if (this.opts.streams) {
      // Test injection: use provided streams, no child process spawned.
      nodeStdin = this.opts.streams.stdin;
      nodeStdout = this.opts.streams.stdout;
    } else {
      const cmd =
        this.opts.command ??
        (process.env["SM_KIMI_CLI_PATH"] as string | undefined) ??
        "kimi";
      const args = this.opts.args ?? ["acp"];
      this.child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });

      this.stderrBuffer = [];
      this.child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrBuffer.push(chunk);
        if (this.stderrBuffer.length > 50) this.stderrBuffer.shift();
      });

      this.onExitListener = () => {
        this.state = "dead";
      };
      this.onErrorListener = () => {
        this.state = "dead";
      };
      this.child.on("exit", this.onExitListener);
      this.child.on("error", this.onErrorListener);

      nodeStdin = this.child.stdin!;
      nodeStdout = this.child.stdout!;
    }

    // Convert Node streams to Web Streams (required by ndJsonStream).
    // ndJsonStream(output, input):
    //   output = where to WRITE outgoing messages → nodeStdin (child stdin)
    //   input  = where to READ incoming messages  ← nodeStdout (child stdout)
    const webOutput = Writable.toWeb(nodeStdin);
    const webInput = Readable.toWeb(nodeStdout);
    const stream = ndJsonStream(webOutput, webInput);

    this.conn = new ClientSideConnection(
      (_agent) => ({
        sessionUpdate: async (params: SessionNotification) => {
          try {
            const router = this.updateRouters.get(params.sessionId);
            if (router) router(params.update);
          } catch {
            // Swallow errors from the consumer callback to protect the ACP stream.
          }
        },

        requestPermission: async (params) => {
          // Auto-approve. SuperMatrix runs in unattended mode.
          // T0 verified kimi uses optionIds: approve / approve_for_session / reject.
          // Prefer approve_for_session so kimi doesn't re-prompt within the session.
          //
          // ACP RequestPermissionResponse.outcome shape:
          //   { outcome: "selected", optionId } | { outcome: "cancelled" }
          // (Yes, .outcome.outcome — the spec nests it that way.)
          const options = params.options ?? [];
          const sessionApprove = options.find(
            (o) => o.optionId === "approve_for_session",
          );
          const anyApprove = options.find((o) => /approve/i.test(o.optionId));
          const fallback = options[0];
          const chosen = sessionApprove ?? anyApprove ?? fallback;
          return {
            outcome: {
              outcome: "selected",
              optionId: chosen?.optionId ?? "approve_for_session",
            },
          };
        },

        // We don't advertise fs or terminal capabilities to kimi.
        readTextFile: async () => {
          throw new Error("fs.readTextFile not advertised by SuperMatrix client");
        },
        writeTextFile: async () => {
          throw new Error(
            "fs.writeTextFile not advertised by SuperMatrix client",
          );
        },
        createTerminal: async () => {
          throw new Error(
            "terminal.create not advertised by SuperMatrix client",
          );
        },
      }),
      stream,
    );

    try {
      await this.conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          // We advertise neither fs nor terminal — kimi runs its own subprocesses
          // internally (Python-side) and asks consent via session/request_permission;
          // we never need to host file-system or terminal RPC for the agent.
        },
      });
      this.state = "ready";
    } catch (err) {
      // C1: reset readyP so the next ensureReady() can retry.
      this.readyP = null;
      this.state = "init";
      const stderrText = Buffer.concat(this.stderrBuffer)
        .toString("utf-8")
        .trim();
      if (stderrText) {
        // eslint-disable-next-line no-console
        console.error("[kimi-acp stderr on init failure]", stderrText.slice(0, 2000));
      }
      throw err;
    }
  }

  /** Create a new kimi session and return its sessionId. */
  async newSession(params: { cwd: string; mcpServers?: any[] }): Promise<string> {
    if (!this.conn) throw new Error("AcpClient not ready — call ensureReady() first");
    const resp = await this.conn.newSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    return resp.sessionId;
  }

  /** Send a prompt and stream updates via onUpdate. Resolves when the turn completes. */
  async prompt(args: PromptArgs): Promise<PromptResponse> {
    if (!this.conn) throw new Error("AcpClient not ready — call ensureReady() first");
    this.updateRouters.set(args.sessionId, args.onUpdate);
    try {
      return await this.conn.prompt({
        sessionId: args.sessionId,
        prompt: args.blocks,
      });
    } finally {
      this.updateRouters.delete(args.sessionId);
    }
  }

  /** Cancel an in-flight prompt. Errors are swallowed (fire-and-forget). */
  async cancel(sessionId: string): Promise<void> {
    if (!this.conn) return;
    try {
      await this.conn.cancel({ sessionId });
    } catch {
      /* swallow */
    }
  }

  /** Resume an existing kimi session (requires kimi to advertise loadSession capability). */
  async loadSession(params: { sessionId: string; cwd: string }): Promise<void> {
    if (!this.conn)
      throw new Error("AcpClient not ready — call ensureReady() first");
    await this.conn.loadSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: [],
    });
  }

  /** Returns the PID of the spawned kimi child process, or null if using injected streams. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Tear down the ACP connection. Idempotent — safe to call multiple times.
   * Sends SIGTERM to the child process if one was spawned.
   */
  async dispose(): Promise<void> {
    if (this.state === "dead") return;
    this.state = "dead";

    // H1: clear active routers so any late updates are dropped.
    this.updateRouters.clear();

    // H1: remove event listeners to avoid leaking references on zombie ChildProcess objects.
    if (this.child) {
      if (this.onExitListener) {
        this.child.off("exit", this.onExitListener);
        this.onExitListener = null;
      }
      if (this.onErrorListener) {
        this.child.off("error", this.onErrorListener);
        this.onErrorListener = null;
      }
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* process already gone */
      }
    }

    // H3: surface any stderr that was buffered before we tear down.
    const stderrText = Buffer.concat(this.stderrBuffer).toString("utf-8").trim();
    if (stderrText) {
      // eslint-disable-next-line no-console
      console.error("[kimi-acp stderr on dispose]", stderrText.slice(0, 2000));
    }

    this.conn = null;
    this.child = null;
    this.readyP = null;
    this.ensureReadyLock = null;
  }
}
