import type { AgentEvent } from "../../domain/events/agentEvent.ts";
import type { SessionId } from "../../domain/ids.ts";
import type { AgentBackend, RunInput } from "../../ports/AgentBackend.ts";
import { buildCodexArgs, resolveCodexRunModel } from "./commandBuilder.ts";
import { spawnAndStream, type StreamHandle } from "./process.ts";

export type CodexBackendOptions = {
  command?: string;
  buildArgs?: (input: RunInput) => string[];
};

const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export class CodexBackend implements AgentBackend {
  readonly kind = "codex" as const;
  private readonly command: string;
  private readonly buildArgs: (input: RunInput) => string[];
  private readonly inflight = new Map<SessionId, StreamHandle>();

  constructor(opts: CodexBackendOptions = {}) {
    this.command = opts.command ?? "codex";
    this.buildArgs = opts.buildArgs ?? buildCodexArgs;
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

    const handle = spawnAndStream({
      command: this.command,
      args: this.buildArgs(input),
      cwd: input.session.workdir,
      env: { ...process.env, SM_SESSION_NAME: input.session.name },
      fallbackModel: resolveCodexRunModel(input.session.model),
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
