import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { AgentBackend, RunInput } from "../../ports/AgentBackend.ts";
import { buildClaudeCommand, type ClaudeCommand } from "./commandBuilder.ts";
import { spawnAndStream, type StreamHandle } from "./process.ts";

export type ClaudeBackendOptions = {
  command?: string;
  buildCommand?: (input: RunInput) => ClaudeCommand;
  buildArgs?: (input: RunInput) => string[];
};

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;
  private readonly command: string;
  private readonly buildCommand: (input: RunInput) => ClaudeCommand;
  private readonly inflight = new Map<SessionId, StreamHandle>();

  constructor(opts: ClaudeBackendOptions = {}) {
    this.command = opts.command ?? "claude";
    this.buildCommand = opts.buildCommand ?? (
      opts.buildArgs
        ? (input: RunInput) => ({ args: opts.buildArgs!(input) })
        : buildClaudeCommand
    );
  }

  run(input: RunInput): AsyncIterable<AgentEvent> {
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
      env: { ...process.env, SM_SESSION_NAME: input.session.name },
      ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
      ...(inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs } : {}),
      ...(maxRuntimeMs !== undefined ? { maxRuntimeMs } : {}),
    });
    this.inflight.set(input.session.id, handle);
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const event of handle.iterable) {
            yield event;
          }
        } finally {
          self.inflight.delete(input.session.id);
        }
      },
    };
  }

  async cancel(sessionId: SessionId): Promise<void> {
    const handle = this.inflight.get(sessionId);
    if (!handle) return;
    handle.cancel();
  }
}
