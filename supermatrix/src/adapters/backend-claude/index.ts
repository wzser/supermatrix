import { isThinkingBlockResumeError as isThinkingBlockResumeErrorText } from "../../domain/backendResumeErrors.ts";
import {
  CALLER_ATTESTATION_ENV_VAR,
  defaultCallerAttestationRegistry,
  type CallerAttestationRegistry,
} from "../../domain/callerAttestation.ts";
import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { MessageRunId, SessionId } from "../../domain/ids.ts";
import type { AgentBackend, RunInput, SteerInput, SteerResult } from "../../ports/AgentBackend.ts";
import {
  disableCardAskWhenBrokerUnhealthy,
  probeCardAskBrokerHealth,
  type CardAskHealthCheck,
} from "../card-ask/config.ts";
import { buildClaudeCommand, type ClaudeCommand } from "./commandBuilder.ts";
import { spawnAndStream, type StreamHandle } from "./process.ts";

export type ClaudeBackendOptions = {
  command?: string;
  buildCommand?: (input: RunInput) => ClaudeCommand;
  buildArgs?: (input: RunInput) => string[];
  cardAskHealthCheck?: CardAskHealthCheck;
  /** Runtime caller-provenance registry. Defaults to the process-wide one. */
  callerAttestations?: CallerAttestationRegistry;
};

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

type InflightRun = {
  handle: StreamHandle;
  messageRunId: MessageRunId;
};

export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;
  private readonly command: string;
  private readonly buildCommand: (input: RunInput) => ClaudeCommand;
  private readonly cardAskHealthCheck: CardAskHealthCheck;
  private readonly callerAttestations: CallerAttestationRegistry;
  private readonly inflight = new Map<SessionId, InflightRun>();

  constructor(opts: ClaudeBackendOptions = {}) {
    this.command = opts.command ?? "claude";
    this.buildCommand = opts.buildCommand ?? (
      opts.buildArgs
        ? (input: RunInput) => ({ args: opts.buildArgs!(input) })
        : buildClaudeCommand
    );
    this.cardAskHealthCheck = opts.cardAskHealthCheck ?? probeCardAskBrokerHealth;
    this.callerAttestations = opts.callerAttestations ?? defaultCallerAttestationRegistry;
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const runInput = await disableCardAskWhenBrokerUnhealthy(
          input,
          self.cardAskHealthCheck,
        );
        yield* self.runWithResumeRecovery(runInput);
      },
    };
  }

  private start(input: RunInput): StreamHandle {
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

    const command = this.buildCommand(input);
    const handle = spawnAndStream({
      command: this.command,
      args: command.args,
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
      ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
      ...(inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs } : {}),
      ...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
    });
    // Binding the handle to the exact messageRunId lets steer() reject stale
    // /now requests instead of injecting into whatever run happens to be
    // active. A resume-recovery restart re-binds the same run id to the fresh
    // handle; the replaced handle rejects its own pending steers on close.
    this.inflight.set(input.session.id, { handle, messageRunId: input.messageRunId });
    return handle;
  }

  private async *runWithResumeRecovery(input: RunInput): AsyncIterable<AgentEvent> {
    const shouldRetryFresh =
      input.answerOnly !== true && Boolean(input.session.backendSessionId);
    const handle = this.start(input);
    const buffered: AgentEvent[] = [];
    let released = false;

    try {
      for await (const event of handle.iterable) {
        if (!released) {
          if (event.kind === "started") {
            buffered.push(event);
            continue;
          }
          if (shouldRetryFresh && isThinkingBlockResumeError(event)) {
            const freshInput: RunInput = {
              ...input,
              session: { ...input.session, backendSessionId: null },
            };
            const freshHandle = this.start(freshInput);
            try {
              for await (const freshEvent of freshHandle.iterable) {
                yield freshEvent;
              }
            } finally {
              this.inflight.delete(input.session.id);
            }
            return;
          }
          released = true;
          for (const bufferedEvent of buffered) yield bufferedEvent;
        }
        yield event;
      }
      if (!released) {
        for (const bufferedEvent of buffered) yield bufferedEvent;
      }
    } finally {
      this.inflight.delete(input.session.id);
      // Covers the resume-retry path too: its `return` unwinds through here.
      // Revocation limits replay lifetime; it does not make the token
      // caller-bound or suitable for owner authorization.
      this.callerAttestations.revokeSession(input.session.id);
    }
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const running = this.inflight.get(sessionId);
    if (!running) return;
    running.handle.cancel();
  }

  async steer(input: SteerInput): Promise<SteerResult> {
    const running = this.inflight.get(input.sessionId);
    if (!running) {
      throw new Error("no active claude run for this session");
    }
    if (running.messageRunId !== input.expectedMessageRunId) {
      throw new Error("stale messageRunId: the active claude run has changed");
    }
    await running.handle.steer(input.text);
    return { accepted: true };
  }
}

function isThinkingBlockResumeError(event: AgentEvent): boolean {
  return event.kind === "error" && isThinkingBlockResumeErrorText(event.message);
}
