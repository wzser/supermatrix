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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { CALLER_ATTESTATION_ENV_VAR } from "../../domain/callerAttestation.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import {
  ClientSideConnection,
  ndJsonStream,
} from "@zed-industries/agent-client-protocol";
import type {
  SessionNotification,
  ContentBlock,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@zed-industries/agent-client-protocol";
import {
  askViaBroker,
  type CardAskBrokerRequest,
  type CardAskBrokerResult,
} from "../card-ask/askViaBroker.ts";
import {
  isAskUserQuestionPermission,
  parseAskUserQuestionPermission,
} from "./askUserPermission.ts";

export type AcpClientOptions = {
  /** Path to kimi binary. Defaults to SM_KIMI_CLI_PATH env or "kimi". */
  command?: string;
  /**
   * Args to pass to kimi. Defaults to `["--skills-dir", <dir>, "acp"]` where
   * `<dir>` resolves from `SM_KIMI_SKILLS_DIR` env or `~/.kimi/skills`.
   * `--skills-dir` is a top-level Kimi Code flag and must
   * precede the `acp` subcommand. Override here only in tests.
   */
  args?: string[];
  /**
   * Test-only injection. When provided, AcpClient uses these streams directly
   * and skips spawning a child process.
   *
   *   stdin  = where the client writes outgoing messages (→ server reads)
   *   stdout = where the client reads incoming messages  (← server writes)
   */
  streams?: { stdin: Writable; stdout: Readable };
  /**
   * Test-only injection. Sends one question card through the card-ask broker
   * and resolves with the user's answer. Defaults to the real HTTP client.
   */
  askBroker?: (req: CardAskBrokerRequest) => Promise<CardAskBrokerResult>;
  /** Test-only override for the managed child liveness check. */
  childLivenessProbe?: (pid: number) => Promise<AcpChildLiveness>;
  /** Test-only override for session/new and session/load RPC bounds. */
  sessionRpcTimeoutMs?: number;
  /** Test-only override for graceful child termination before SIGKILL. */
  disposeTermTimeoutMs?: number;
  /** Test-only override for the final SIGKILL wait. */
  disposeKillTimeoutMs?: number;
};

export type AcpClientState = "init" | "ready" | "dead";
export type AcpChildLiveness = "alive" | "stopped" | "dead" | "unknown";

const DEFAULT_SESSION_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_DISPOSE_TERM_TIMEOUT_MS = 2_000;
const DEFAULT_DISPOSE_KILL_TIMEOUT_MS = 2_000;
const CHILD_LIVENESS_PROBE_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);

class AcpSessionRpcTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "AcpSessionRpcTimeoutError";
  }
}

async function probeManagedChildLiveness(pid: number): Promise<AcpChildLiveness> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: CHILD_LIVENESS_PROBE_TIMEOUT_MS,
    });
    const stat = String(stdout).trim();
    if (!stat) return "dead";
    const stateCode = stat[0];
    if (stateCode === "T") return "stopped";
    if (stateCode === "Z" || stateCode === "X") return "dead";
    return "alive";
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 1 || code === "ESRCH") return "dead";
    return "unknown";
  }
}

/**
 * Resolve the skills directory to expose to kimi acp.
 *
 * Priority: `SM_KIMI_SKILLS_DIR` env → `~/.kimi/skills`. The directory holds
 * the shared-skill symlinks synced by skill-master; restricting kimi to it
 * keeps backend=kimi from inheriting claude-only skills under `~/.claude/skills`
 * (kimi's default scan path).
 */
export function resolveKimiSkillsDir(env: NodeJS.ProcessEnv): string {
  const override = env["SM_KIMI_SKILLS_DIR"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".kimi", "skills");
}

/**
 * Build the default argv for `kimi`, scoping skill discovery to the controlled
 * directory. `--skills-dir` is a top-level Kimi Code flag and
 * must precede the `acp` subcommand.
 */
/**
 * Env for the shared kimi ACP child.
 *
 * kimi runs as ONE ACP process serving every kimi-backed session, so unlike
 * codex/claude there is no per-session process to carry a per-session identity.
 * Whatever SM_SESSION_NAME / SM_CALLER_ATTESTATION the SuperMatrix parent
 * happens to carry would otherwise be inherited by every kimi session's shell
 * and read back as that session's provenance — silent MISattribution, the exact
 * failure runtime-backed provenance exists to prevent. Stripping them makes
 * kimi honestly unattested instead.
 */
export function buildKimiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv["SM_SESSION_NAME"];
  delete childEnv[CALLER_ATTESTATION_ENV_VAR];
  // The card-ask askserver is injected via ACP session mcpServers, which
  // cannot carry a per-server toolTimeoutMs — so the MCP tool call falls
  // back to kimi's built-in default (≈60s, MCP SDK default). The card-ask
  // broker waits up to 300s for a human click (mcpAskServer allows 310s):
  // any click arriving after ~60s was settled by the broker but never
  // reached the model — MCP error -32001 Request timed out (2026-08-07
  // codexroot ask_user: broker logged "answered fix_both" 65s in, the
  // caller had already timed out). Raise the process-wide MCP tool timeout
  // past the broker window; an explicit operator setting wins.
  childEnv["KIMI_MCP_TOOL_TIMEOUT_MS"] ??= "330000";
  return childEnv;
}

export function buildDefaultKimiArgs(env: NodeJS.ProcessEnv): string[] {
  return ["--skills-dir", resolveKimiSkillsDir(env), "acp"];
}

export type PromptArgs = {
  sessionId: string;
  blocks: ContentBlock[];
  onUpdate: (update: SessionNotification["update"]) => void;
};

// kimi-code 0.26.0+ configOptions entry shape (session/new response and
// config_option_update notifications): we read the "model" and "thinking"
// selects.
type KimiConfigOption = {
  id?: string;
  currentValue?: string;
};

export class AcpClient {
  private child: ChildProcess | null = null;
  private conn: ClientSideConnection | null = null;
  private state: AcpClientState = "init";
  private readyP: Promise<void> | null = null;
  private ensureReadyLock: Promise<void> | null = null;

  /** Routes sessionId → onUpdate callback during active prompts. */
  private updateRouters = new Map<
    string,
    (u: SessionNotification["update"]) => void
  >();

  /** Dedupe keys for one-shot logging of unrouted session updates. */
  private unroutedUpdateLogOnce = new Set<string>();

  /** Buffers the last chunks of stderr for diagnostics. */
  private stderrBuffer: Buffer[] = [];
  private onExitListener: (() => void) | null = null;
  private onErrorListener: ((err: Error) => void) | null = null;

  // Raw JSON-RPC side channel. @zed-industries/agent-client-protocol 0.4.5
  // has a copy-paste bug: ClientSideConnection.setSessionModel sends
  // "session/set_mode" instead of "session/set_model" (dist/acp.js). Until an
  // upstream release fixes it, session/set_model goes over this raw path:
  // requests use a dedicated string-id namespace ("sm-raw-<n>") and the child
  // stdout is filtered so our responses never reach the lib's Connection.
  // Remove rawStdin/rawPending/sendRawRequest once the lib is fixed.
  private rawStdin: Writable | null = null;
  private rawSeq = 0;
  private rawPending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  /**
   * Last known model per ACP session, sourced from the session/new and
   * session/load response configOptions and from config_option_update
   * notifications. Lets the backend report the actual executing model on the
   * Lark card even when the SuperMatrix session follows Kimi's own default
   * (model=null).
   */
  private sessionModels = new Map<string, string>();

  /**
   * Last known thinking level per ACP session, from the same configOptions
   * sources as sessionModels (session/new, session/load and
   * session/set_config_option responses, config_option_update notifications).
   * kimi-code 0.30.0 K3 models advertise a "thinking" select with
   * low/high/max; K2.7 models are fixed-on. Lets the backend resolve a
   * null-model session's level against the ACP-observed model instead of
   * guessing.
   */
  private sessionThinking = new Map<string, string>();

  /**
   * Per-ACP-session card-ask route (broker URL + target chat), registered by
   * KimiBackend from the card-ask gate decision each run. Present → built-in
   * AskUserQuestion permission requests become real Feishu cards; absent →
   * they are cancelled (never auto-approved into a phantom answer).
   */
  private cardAskRoutes = new Map<string, { brokerUrl: string; chatId: string }>();

  private readonly askBroker: (
    req: CardAskBrokerRequest,
  ) => Promise<CardAskBrokerResult>;

  constructor(private readonly opts: AcpClientOptions = {}) {
    this.askBroker = opts.askBroker ?? askViaBroker;
  }

  /** Current lifecycle state of this shared ACP client. */
  getState(): AcpClientState {
    return this.state;
  }

  private async childLiveness(): Promise<AcpChildLiveness> {
    const child = this.child;
    if (!child) return "alive"; // injected streams have no managed OS process.
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return "dead";
    }
    return await (this.opts.childLivenessProbe ?? probeManagedChildLiveness)(child.pid);
  }

  private async invalidate(reason: string): Promise<never> {
    await this.dispose();
    throw new Error(`AcpClient has been disposed: ${reason}`);
  }

  private async assertManagedChildRunnable(): Promise<void> {
    const liveness = await this.childLiveness();
    if (liveness === "stopped" || liveness === "dead") {
      await this.invalidate(`managed ACP child is ${liveness}`);
    }
  }

  /**
   * Register (or clear, with `null`) the card-ask route for an ACP session.
   * Must be called once the ACP session id is known, on every run, so a
   * resumed session never carries a stale route from a previous gate decision.
   */
  setCardAskRoute(
    sessionId: string,
    route: { brokerUrl: string; chatId: string } | null,
  ): void {
    if (route) {
      this.cardAskRoutes.set(sessionId, route);
    } else {
      this.cardAskRoutes.delete(sessionId);
    }
  }

  /**
   * Answer a built-in AskUserQuestion permission request. Routes the question
   * to the card-ask broker when a route is registered for this session; any
   * failure to reach the user (no route, unrenderable request, broker error,
   * escape, timeout) resolves to "cancelled" — auto-approving here would
   * fabricate a user answer the human never gave.
   */
  private async answerAskUserQuestion(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = {
      outcome: { outcome: "cancelled" },
    };
    const parsed = parseAskUserQuestionPermission(params);
    const route = this.cardAskRoutes.get(params.sessionId);
    if (!parsed || !route) return cancelled;
    try {
      const result = await this.askBroker({
        brokerUrl: route.brokerUrl,
        chatId: route.chatId,
        question: parsed.question,
        options: parsed.options,
      });
      if (result.status === "answered") {
        return {
          outcome: { outcome: "selected", optionId: result.value },
        };
      }
    } catch {
      // Broker down / card send failed: cancel rather than fabricate an answer.
    }
    return cancelled;
  }

  /** Idempotent: initializes the ACP connection on first call. */
  async ensureReady(): Promise<void> {
    if (this.state === "ready") {
      await this.assertManagedChildRunnable();
      return;
    }
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
      const args = this.opts.args ?? buildDefaultKimiArgs(process.env);
      this.child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildKimiChildEnv(process.env),
      });
      // stderr, not stdout: `kimi-acp-health` runs this launcher inside the
      // standalone self-check CLI, whose stdout carries the machine-readable
      // report. A console.info here landed in that stream and made every
      // `JSON.parse(stdout)` consumer — including the weekly cli-upgrade
      // compatibility gate — fail on an otherwise ok:true report.
      // eslint-disable-next-line no-console
      console.error("[kimi-acp launch]", {
        command: cmd,
        args,
        pid: this.child.pid ?? null,
      });

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

    // Raw side channel (see rawPending comment): writes go straight to the
    // child stdin (each write is one full ndjson line, so interleaving with
    // the lib's writes is frame-safe); reads are filtered out of the child
    // stdout below before the lib's Connection sees them.
    this.rawStdin = nodeStdin;
    const filtered = new PassThrough();
    const decoder = new StringDecoder("utf8");
    let lineBuf = "";
    nodeStdout.on("data", (chunk: Buffer) => {
      lineBuf += decoder.write(chunk);
      let idx: number;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx + 1);
        lineBuf = lineBuf.slice(idx + 1);
        if (!this.routeRawResponse(line) && !this.consumeConfigOptionUpdate(line)) {
          filtered.write(this.normalizeToolCallUpdate(line));
        }
      }
    });
    nodeStdout.on("end", () => filtered.end());
    nodeStdout.on("error", (err: Error) => filtered.destroy(err));

    // Convert Node streams to Web Streams (required by ndJsonStream).
    // ndJsonStream(output, input):
    //   output = where to WRITE outgoing messages → nodeStdin (child stdin)
    //   input  = where to READ incoming messages  ← child stdout (via filter)
    const webOutput = Writable.toWeb(nodeStdin);
    const webInput = Readable.toWeb(filtered);
    const stream = ndJsonStream(webOutput, webInput);

    this.conn = new ClientSideConnection(
      (_agent) => ({
        sessionUpdate: async (params: SessionNotification) => {
          try {
            const router = this.updateRouters.get(params.sessionId);
            if (router) {
              router(params.update);
            } else {
              // No SM run is consuming this session's updates. Today the CLI
              // only emits updates during client-prompted turns, so anything
              // arriving here means upstream started streaming autonomous
              // (notification-driven) turns — the signal to retire the
              // wire-log watch (docs/upstream-kimi-cli/issue-5). Log once per
              // (session, update kind) to stay noise-free until then.
              const kind = (params.update as { sessionUpdate?: unknown }).sessionUpdate;
              const key = `${params.sessionId}:${String(kind)}`;
              if (!this.unroutedUpdateLogOnce.has(key)) {
                this.unroutedUpdateLogOnce.add(key);
                // eslint-disable-next-line no-console
                console.warn("[kimi-acp unrouted session update]", {
                  sessionId: params.sessionId,
                  kind,
                });
              }
            }
          } catch {
            // Swallow errors from the consumer callback to protect the ACP stream.
          }
        },

        requestPermission: async (params) => {
          // kimi's built-in AskUserQuestion arrives here as a permission
          // request (toolCall.title === "AskUserQuestion"). It must reach the
          // user as a Feishu card — auto-approving it fabricates a user answer
          // (2026-07-22 incident: phantom "user chose option 1" in ~24ms,
          // acted on with real side effects).
          if (isAskUserQuestionPermission(params)) {
            return this.answerAskUserQuestion(params);
          }
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
      if (this.state === "dead") {
        throw new Error("AcpClient has been disposed");
      }
      this.state = "ready";
    } catch (err) {
      // C1: reset readyP so the next ensureReady() can retry.
      this.readyP = null;
      if (this.state !== "dead") this.state = "init";
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

  private async runBoundedSessionRpc<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.state === "dead") throw new Error("AcpClient has been disposed");
    await this.assertManagedChildRunnable();

    const timeoutMs = this.opts.sessionRpcTimeoutMs ?? DEFAULT_SESSION_RPC_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new AcpSessionRpcTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
        Promise.resolve().then(run).then(resolve, reject);
      });
    } catch (err) {
      if (err instanceof AcpSessionRpcTimeoutError) {
        await this.invalidate(err.message);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Create a new kimi session and return its sessionId. */
  async newSession(params: { cwd: string; mcpServers?: any[] }): Promise<string> {
    const conn = this.conn;
    if (!conn) throw new Error("AcpClient not ready — call ensureReady() first");
    const resp = await this.runBoundedSessionRpc("session/new", () => conn.newSession({
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    }));
    // kimi-code returns its configOptions (current model included) on the
    // session/new response; the field is beyond the 0.4.5 lib's typed shape.
    this.recordConfigOptions(
      resp.sessionId,
      (resp as { configOptions?: KimiConfigOption[] }).configOptions,
    );
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

  /**
   * Select the model for one ACP session (`session/set_model`). Per-session:
   * other sessions multiplexed on the same child process are unaffected
   * (verified on kimi-code 0.26.0 via /status read-back).
   *
   * Sent over the raw side channel, NOT this.conn.setSessionModel — the 0.4.5
   * lib method mistakenly emits "session/set_mode" (see rawPending comment).
   */
  async setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    if (!this.conn) throw new Error("AcpClient not ready — call ensureReady() first");
    await this.sendRawRequest("session/set_model", {
      sessionId: params.sessionId,
      modelId: params.modelId,
    });
  }

  /**
   * Set a per-session config option (`session/set_config_option`, kimi-code
   * 0.30.0) — used for the K3 thinking level (configId "thinking"). Same raw
   * side channel as setSessionModel: the 0.4.5 lib predates the method. The
   * response carries the session's full configOptions, which are recorded so
   * later read-backs (getSessionModel / getSessionThinking) stay fresh.
   * Server-side rejections (e.g. K2.7 fixed-on answering -32602) propagate —
   * callers must fail closed rather than prompt with the wrong level.
   */
  async setSessionConfigOption(params: {
    sessionId: string;
    configId: string;
    value: string;
  }): Promise<void> {
    if (!this.conn) throw new Error("AcpClient not ready — call ensureReady() first");
    const result = await this.sendRawRequest("session/set_config_option", {
      sessionId: params.sessionId,
      configId: params.configId,
      value: params.value,
    });
    this.recordConfigOptions(
      params.sessionId,
      (result as { configOptions?: KimiConfigOption[] } | undefined)?.configOptions,
    );
  }

  /** Raw JSON-RPC request over the child stdio, bypassing the lib Connection. */
  private sendRawRequest(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const stdin = this.rawStdin;
    if (!stdin) throw new Error("AcpClient not ready — call ensureReady() first");
    const id = `sm-raw-${++this.rawSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rawPending.delete(id);
        reject(new Error(`raw request timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.rawPending.set(id, { resolve, reject, timer });
      stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  /**
   * Bounded no-turn roundtrip for the already-managed shared ACP connection.
   * `session/list` is advertised by Kimi ACP and does not create a session or
   * send a prompt, unlike `session/new` and `session/prompt`.
   */
  async probeHealth(timeoutMs = DEFAULT_SESSION_RPC_TIMEOUT_MS): Promise<{ rttMs: number }> {
    await this.ensureReady();
    const startedAt = Date.now();
    try {
      await this.sendRawRequest("session/list", {}, timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.invalidate(`shared ACP roundtrip failed: ${message}`);
    }
    return { rttMs: Date.now() - startedAt };
  }

  /**
   * kimi-code 0.26.0 emits `config_option_update` session notifications (e.g.
   * after session/set_model). The 0.4.5 lib schema predates them and logs a
   * noisy "Error handling notification" for every one, so consume them here:
   * record the current model, then drop the line before the lib sees it.
   * Returns true when the line was such a notification.
   */
  private consumeConfigOptionUpdate(line: string): boolean {
    if (!line.includes('"config_option_update"')) return false; // cheap pre-filter
    let msg: {
      method?: string;
      params?: {
        sessionId?: string;
        update?: { sessionUpdate?: string; configOptions?: KimiConfigOption[] };
      };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    if (
      msg.method !== "session/update" ||
      msg.params?.update?.sessionUpdate !== "config_option_update"
    ) {
      return false;
    }
    this.recordConfigOptions(msg.params.sessionId, msg.params.update.configOptions);
    return true;
  }

  /** Fit kimi-code's primitive rawOutput to the ACP SDK 0.4.5 record schema. */
  private normalizeToolCallUpdate(line: string): string {
    if (!line.includes('"tool_call_update"') || !line.includes('"rawOutput"')) {
      return line;
    }
    let msg: {
      method?: string;
      params?: { update?: { sessionUpdate?: string; rawOutput?: unknown } };
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return line;
    }
    const update = msg.params?.update;
    if (
      msg.method !== "session/update" ||
      update?.sessionUpdate !== "tool_call_update" ||
      update.rawOutput === undefined ||
      (typeof update.rawOutput === "object" && update.rawOutput !== null && !Array.isArray(update.rawOutput))
    ) {
      return line;
    }
    update.rawOutput = { value: update.rawOutput };
    return `${JSON.stringify(msg)}\n`;
  }

  private recordConfigOptions(
    sessionId: string | undefined,
    configOptions: KimiConfigOption[] | undefined,
  ): void {
    if (!sessionId || !Array.isArray(configOptions)) return;
    const model = configOptions.find((o) => o.id === "model")?.currentValue;
    if (typeof model === "string" && model.length > 0) {
      this.sessionModels.set(sessionId, model);
    }
    const thinking = configOptions.find((o) => o.id === "thinking")?.currentValue;
    if (typeof thinking === "string" && thinking.length > 0) {
      this.sessionThinking.set(sessionId, thinking);
    }
  }

  /** Last known model for an ACP session, or undefined when never observed. */
  getSessionModel(acpSessionId: string): string | undefined {
    return this.sessionModels.get(acpSessionId);
  }

  /** Last known thinking level for an ACP session, or undefined when never observed. */
  getSessionThinking(acpSessionId: string): string | undefined {
    return this.sessionThinking.get(acpSessionId);
  }

  /** Returns true when the line was a response to a raw request (consumed). */
  private routeRawResponse(line: string): boolean {
    if (!line.includes('"sm-raw-')) return false; // cheap pre-filter
    let msg: { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };
    try {
      msg = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof msg.id !== "string" || !msg.id.startsWith("sm-raw-")) return false;
    const pending = this.rawPending.get(msg.id);
    if (!pending) return true; // ours but timed out — still swallow it
    this.rawPending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error !== undefined) {
      pending.reject(
        new Error(`ACP error ${msg.error.code ?? ""}: ${msg.error.message ?? JSON.stringify(msg.error)}`),
      );
    } else {
      pending.resolve(msg.result);
    }
    return true;
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
  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: any[];
  }): Promise<void> {
    const conn = this.conn;
    if (!conn)
      throw new Error("AcpClient not ready — call ensureReady() first");
    const resp = await this.runBoundedSessionRpc("session/load", () => conn.loadSession({
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    }));
    // Like session/new, kimi-code returns the resumed session's configOptions
    // (beyond the 0.4.5 lib's typed shape) — record them so a model-null run
    // on a resumed session resolves its level against the real config, not a
    // stale pre-restart snapshot.
    this.recordConfigOptions(
      params.sessionId,
      (resp as { configOptions?: KimiConfigOption[] } | undefined)?.configOptions,
    );
  }

  /** Returns the PID of the spawned kimi child process, or null if using injected streams. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("error", onExit);
    });
  }

  private async reapManagedChild(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    // SIGTERM alone remains pending for a process in T/stopped state. Resume it
    // first, then terminate and escalate if it still retains ACP pipes.
    try {
      child.kill("SIGCONT");
    } catch {
      /* process already gone */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* process already gone */
    }
    const termTimeoutMs = this.opts.disposeTermTimeoutMs ?? DEFAULT_DISPOSE_TERM_TIMEOUT_MS;
    if (await this.waitForChildExit(child, termTimeoutMs)) return;

    try {
      child.kill("SIGKILL");
    } catch {
      /* process already gone */
    }
    const killTimeoutMs = this.opts.disposeKillTimeoutMs ?? DEFAULT_DISPOSE_KILL_TIMEOUT_MS;
    await this.waitForChildExit(child, killTimeoutMs);
  }

  /**
   * Tear down the ACP connection. Idempotent — safe to call multiple times.
   * Reaps the spawned child, including stopped (`T`) processes, before return.
   */
  async dispose(): Promise<void> {
    if (this.state === "dead") return;
    this.state = "dead";

    // H1: clear active routers so any late updates are dropped.
    this.updateRouters.clear();

    // Reject in-flight raw requests so callers don't hang until timeout.
    for (const [, pending] of this.rawPending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("AcpClient disposed"));
    }
    this.rawPending.clear();
    this.rawStdin = null;
    this.sessionModels.clear();
    this.sessionThinking.clear();

    const child = this.child;
    if (child) {
      await this.reapManagedChild(child);
      // H1: remove event listeners to avoid leaking references on old ChildProcess objects.
      if (this.onExitListener) {
        child.off("exit", this.onExitListener);
        this.onExitListener = null;
      }
      if (this.onErrorListener) {
        child.off("error", this.onErrorListener);
        this.onErrorListener = null;
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
