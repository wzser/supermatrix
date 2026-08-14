import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CALLER_ATTESTATION_ENV_VAR,
  defaultCallerAttestationRegistry,
  type CallerAttestationRegistry,
} from "../../domain/callerAttestation.ts";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { MessageRunId, SessionId } from "../../domain/ids.ts";
import type { AgentBackend, RunInput, SteerInput, SteerResult } from "../../ports/AgentBackend.ts";
import { SteerWindowClosedError } from "../../ports/AgentBackend.ts";
import {
  disableCardAskWhenBrokerUnhealthy,
  probeCardAskBrokerHealth,
  type CardAskHealthCheck,
} from "../card-ask/config.ts";
import { spawnAppServerProcess } from "./appServerProcess.ts";
import {
  buildCodexAppServerRunPlan,
  type CodexAppServerRunPlan,
  type CodexCommandBuilderEvidence,
} from "./commandBuilder.ts";
import { defaultCodexStateDbPath, preflightCodexState } from "./statePreflight.ts";
import {
  announceCodexAppServerThread,
  commitAppServerUsage,
  createCodexAppServerEventState,
  mapCodexAppServerNotification,
} from "./streamParser.ts";

export type CodexBackendOptions = {
  command?: string;
  buildRunPlan?: (input: RunInput) => CodexAppServerRunPlan;
  cardAskHealthCheck?: CardAskHealthCheck;
  commandHealthCheck?: CodexCommandHealthCheck;
  codexStateDbPath?: string | null;
  onEffortNormalized?: NonNullable<CodexCommandBuilderEvidence["onEffortNormalized"]>;
  /** Runtime caller-provenance registry. Defaults to the process-wide one. */
  callerAttestations?: CallerAttestationRegistry;
};

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const CODEX_COMMAND_HEALTH_TIMEOUT_MS = 5_000;
// After turn/interrupt (cancel) or turn completion, give the app-server this
// long to exit on its own before falling back to the process-group kill.
const SHUTDOWN_GRACE_MS = 3_000;
const execFileAsync = promisify(execFile);

export type CodexCommandHealthResult =
  | { kind: "ok" }
  | { kind: "fail"; reason: "missing" | "unusable"; error: string };

export type CodexCommandHealthCheck = (command: string) => Promise<CodexCommandHealthResult>;

export async function probeCodexCommandHealth(command: string): Promise<CodexCommandHealthResult> {
  try {
    await execFileAsync(command, ["--version"], { timeout: CODEX_COMMAND_HEALTH_TIMEOUT_MS });
    return { kind: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
    return {
      kind: "fail",
      reason: code === "ENOENT" ? "missing" : "unusable",
      error: message,
    };
  }
}

function formatCodexCommandHealthError(
  command: string,
  result: Extract<CodexCommandHealthResult, { kind: "fail" }>,
): string {
  const action = "Set SM_CODEX_CLI_PATH to a working codex binary or reinstall @openai/codex, then restart SuperMatrix.";
  if (result.reason === "missing") {
    return `Codex CLI unavailable: command "${command}" was not found before starting the run. ${action} Probe error: ${result.error}`;
  }
  return `Codex CLI unusable: command "${command}" failed the pre-run --version probe. ${action} Probe error: ${result.error}`;
}

/** One live app-server run: the event stream plus steer/cancel controls. */
type CodexRunHandle = {
  iterable: AsyncIterable<AgentEvent>;
  cancel(): void;
  steer(text: string): Promise<SteerResult>;
};

type InflightRun = {
  handle: CodexRunHandle;
  messageRunId: MessageRunId;
};

export class CodexBackend implements AgentBackend {
  readonly kind = "codex" as const;
  private readonly command: string;
  private readonly buildRunPlan: (input: RunInput) => CodexAppServerRunPlan;
  private readonly cardAskHealthCheck: CardAskHealthCheck;
  private readonly commandHealthCheck: CodexCommandHealthCheck;
  private readonly codexStateDbPath: string | null;
  private readonly callerAttestations: CallerAttestationRegistry;
  private readonly inflight = new Map<SessionId, InflightRun>();

  constructor(opts: CodexBackendOptions = {}) {
    const envCommand = process.env["SM_CODEX_CLI_PATH"]?.trim();
    this.command = opts.command ?? (envCommand || "codex");
    this.buildRunPlan = opts.buildRunPlan ?? ((input) => buildCodexAppServerRunPlan(
      input,
      opts.onEffortNormalized ? { onEffortNormalized: opts.onEffortNormalized } : undefined,
    ));
    this.cardAskHealthCheck = opts.cardAskHealthCheck ?? probeCardAskBrokerHealth;
    this.commandHealthCheck = opts.commandHealthCheck ?? probeCodexCommandHealth;
    this.codexStateDbPath = opts.codexStateDbPath === undefined
      ? defaultCodexStateDbPath()
      : opts.codexStateDbPath;
    this.callerAttestations = opts.callerAttestations ?? defaultCallerAttestationRegistry;
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const commandHealth = await self.commandHealthCheck(self.command);
        if (commandHealth.kind === "fail") {
          yield {
            kind: "error",
            message: formatCodexCommandHealthError(self.command, commandHealth),
            recoverable: false,
          };
          return;
        }
        const cardAskInput = await disableCardAskWhenBrokerUnhealthy(
          input,
          self.cardAskHealthCheck,
        );
        const { input: runInput } = preflightCodexState(cardAskInput, self.codexStateDbPath);
        const handle = self.start(runInput);
        try {
          for await (const event of handle.iterable) {
            yield event;
          }
        } finally {
          self.inflight.delete(input.session.id);
          // The provenance token mapping is only live for the run that minted
          // it. This limits replay lifetime; it does not make the token
          // caller-bound or suitable for owner authorization.
          self.callerAttestations.revokeSession(input.session.id);
        }
      },
    };
  }

  private start(input: RunInput): CodexRunHandle {
    const plan = this.buildRunPlan(input);
    const inactivityTimeoutMs =
      input.session.inactivityTimeoutS === 0
        ? undefined
        : input.session.inactivityTimeoutS !== null
          ? input.session.inactivityTimeoutS * 1000
          : DEFAULT_INACTIVITY_TIMEOUT_MS;

    const maxRuntimeMs =
      input.session.maxRuntimeS && input.session.maxRuntimeS > 0
        ? input.session.maxRuntimeS * 1000
        : undefined;

    const handle = startCodexAppServerRun({
      command: this.command,
      plan,
      cwd: input.session.workdir,
      env: {
        ...process.env,
        SM_SESSION_NAME: input.session.name,
        [CALLER_ATTESTATION_ENV_VAR]: this.callerAttestations.mint({
          sessionId: input.session.id,
          sessionName: input.session.name,
          backend: this.kind,
          now: Date.now(),
        }),
      },
      ...(inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs } : {}),
      ...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
    });
    // Binding the handle to the exact messageRunId lets steer() reject stale
    // /now requests instead of injecting into whatever run happens to be
    // active. The replaced handle rejects its own pending steers on close.
    this.inflight.set(input.session.id, { handle, messageRunId: input.messageRunId });
    return handle;
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const running = this.inflight.get(sessionId);
    if (!running) return;
    running.handle.cancel();
  }

  async steer(input: SteerInput): Promise<SteerResult> {
    const running = this.inflight.get(input.sessionId);
    if (!running) {
      throw new Error("no active codex run for this session");
    }
    if (running.messageRunId !== input.expectedMessageRunId) {
      throw new Error("stale messageRunId: the active codex run has changed");
    }
    return running.handle.steer(input.text);
  }
}

type StartCodexAppServerRunOptions = {
  command: string;
  plan: CodexAppServerRunPlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  inactivityTimeoutMs?: number;
  maxRuntimeMs?: number;
};

function startCodexAppServerRun(opts: StartCodexAppServerRunOptions): CodexRunHandle {
  const { plan } = opts;
  const state = createCodexAppServerEventState(plan.model);

  const queue: AgentEvent[] = [];
  let waiter: ((value: IteratorResult<AgentEvent>) => void) | undefined;
  let done = false;
  let cancelled = false;
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let maxRuntimeTimer: ReturnType<typeof setTimeout> | undefined;

  let threadId: string | null = null;
  let activeTurnId: string | null = null;

  const push = (event: AgentEvent) => {
    if (done) return;
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const finish = () => {
    if (done) return;
    done = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w({ value: undefined as unknown as AgentEvent, done: true });
    }
  };

  const scheduleKillFallback = (graceMs: number) => {
    const t = setTimeout(() => appHandle.kill(), graceMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    void appHandle.exited.then(() => clearTimeout(t));
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
      appHandle.kill();
    }, opts.inactivityTimeoutMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    inactivityTimer = t;
  };

  const appHandle = spawnAppServerProcess({
    command: opts.command,
    args: plan.appServerArgs,
    cwd: opts.cwd,
    env: opts.env,
    onNotification: (notification) => {
      resetInactivityTimer();
      if (notification.method === "turn/started") {
        const params = notification.params;
        if (typeof params === "object" && params !== null) {
          const turn = (params as Record<string, unknown>).turn;
          if (typeof turn === "object" && turn !== null) {
            const id = (turn as Record<string, unknown>).id;
            if (typeof id === "string" && id) activeTurnId = id;
          }
        }
      }
      const finishedBefore = state.turnFinished;
      for (const event of mapCodexAppServerNotification(
        notification.method,
        notification.params,
        state,
      )) {
        push(event);
      }
      if (!finishedBefore && state.turnFinished) {
        // Terminal turn notification: the run is over regardless of process
        // exit timing. Finish the stream now, let the child exit on stdin
        // EOF, and keep the process-group kill as the cleanup fallback.
        activeTurnId = null;
        finish();
        appHandle.endInput();
        scheduleKillFallback(SHUTDOWN_GRACE_MS);
      }
    },
  });

  if (opts.maxRuntimeMs) {
    const t = setTimeout(() => {
      if (done || cancelled || timedOut) return;
      timedOut = true;
      push({
        kind: "error",
        message: `[TIMEOUT] max runtime: exceeded ${Math.round(opts.maxRuntimeMs! / 1000)}s`,
        recoverable: false,
      });
      appHandle.kill();
    }, opts.maxRuntimeMs);
    if (typeof t === "object" && "unref" in t) t.unref();
    maxRuntimeTimer = t;
  }

  resetInactivityTimer();

  // Process death before turn completion is a run failure (or the tail of a
  // cancel/timeout that already produced its event).
  void appHandle.exited.then(({ code, signal, stderr }) => {
    if (done) return;
    // Death without turn/completed (timeout kill, crash) would otherwise drop
    // the run's tokens entirely; flush the last observed snapshot first.
    const usage = commitAppServerUsage(state);
    if (usage) push(usage);
    if (timedOut) {
      // error already pushed by the timer callback
    } else if (cancelled) {
      push({ kind: "error", message: "cancelled by user", recoverable: false });
    } else {
      const exitLabel = code !== null ? `exit ${code}` : `signal ${signal ?? "unknown"}`;
      push({
        kind: "error",
        message: stderr || `codex app-server closed (${exitLabel})`,
        recoverable: false,
      });
    }
    finish();
  });

  const drive = async (): Promise<void> => {
    await appHandle.protocol.initialize({
      clientInfo: { name: "supermatrix", version: "0.1.0" },
    });
    appHandle.protocol.initialized();
    const threadResult = plan.resumeThreadId
      ? await appHandle.protocol.threadResume(
          plan.threadParams as { threadId: string } & Record<string, unknown>,
        )
      : await appHandle.protocol.threadStart(plan.threadParams);
    resetInactivityTimer();
    for (const event of announceCodexAppServerThread(threadResult, state)) {
      push(event);
    }
    if (plan.routeChangeNotice) {
      // This is emitted only after thread/start succeeded, so the user sees
      // the reason for the intentional continuity break without receiving a
      // misleading notice when the new thread itself could not be created.
      push({ kind: "thinking", text: plan.routeChangeNotice });
    }
    const startedThreadId = extractThreadId(threadResult) ?? plan.resumeThreadId;
    if (!startedThreadId) {
      throw new Error("codex app-server returned no thread id");
    }
    threadId = startedThreadId;
    const turnResult = await appHandle.protocol.turnStart({
      threadId: startedThreadId,
      input: plan.turnInput,
      ...(plan.turnEffort ? { effort: plan.turnEffort } : {}),
    });
    resetInactivityTimer();
    // Timing-agnostic: some servers respond to turn/start immediately with
    // the created turn, others only at turn end. turn/started (handled in
    // onNotification) is the primary active-turn-id source; this is backup.
    if (activeTurnId === null && !state.turnFinished) {
      const turnId = extractTurnId(turnResult);
      if (turnId) activeTurnId = turnId;
    }
  };

  void drive().catch((err: unknown) => {
    if (done || cancelled || timedOut || state.turnFinished) return;
    push({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      recoverable: false,
    });
    finish();
    appHandle.kill();
  });

  const cancel = () => {
    if (cancelled || done || timedOut) return;
    cancelled = true;
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (maxRuntimeTimer) clearTimeout(maxRuntimeTimer);
    const tid = threadId;
    const turnId = activeTurnId;
    if (tid && turnId && !state.turnFinished) {
      // Prefer the protocol-level interrupt: the server aborts the turn and
      // emits turn/completed(interrupted), which maps to "cancelled by user"
      // and finishes the stream. Kill remains the fallback for a server that
      // does not comply within the grace window.
      appHandle.protocol
        .turnInterrupt({ threadId: tid, turnId })
        .catch(() => appHandle.kill());
      scheduleKillFallback(SHUTDOWN_GRACE_MS);
    } else {
      appHandle.kill();
    }
  };

  const steer = async (text: string): Promise<SteerResult> => {
    // Atomic precondition check: no awaits between these guards and the
    // JSON-RPC stdin write inside turnSteer, so a completion race cannot
    // slip in between check and send.
    if (done || cancelled || timedOut || state.turnFinished) {
      // Same window-closed class as claude's turnInputEnded guard — kept
      // symmetric so /now renders one actionable reply for both backends.
      throw new SteerWindowClosedError("codex", "codex turn already completed");
    }
    if (!threadId || !activeTurnId) {
      throw new Error("codex turn not started yet; no active turn to steer");
    }
    const expectedTurnId = activeTurnId;
    const result = await appHandle.protocol.turnSteer({
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
    const confirmedTurnId = extractSteerTurnId(result);
    if (confirmedTurnId !== expectedTurnId) {
      throw new Error(
        `codex turn/steer confirmed a different turn (expected ${expectedTurnId}, got ${confirmedTurnId ?? "none"})`,
      );
    }
    return { accepted: true, backendTurnId: confirmedTurnId };
  };

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
          finish();
          return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
        },
      };
    },
  };

  return { iterable, cancel, steer };
}

function extractThreadId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const thread = (result as Record<string, unknown>).thread;
  if (typeof thread !== "object" || thread === null) return null;
  const id = (thread as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

function extractTurnId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const turn = (result as Record<string, unknown>).turn;
  if (typeof turn !== "object" || turn === null) return null;
  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : null;
}

function extractSteerTurnId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const turnId = (result as Record<string, unknown>).turnId;
  return typeof turnId === "string" && turnId ? turnId : null;
}
