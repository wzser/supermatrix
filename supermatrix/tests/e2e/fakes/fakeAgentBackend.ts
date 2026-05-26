import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import type { AgentBackend, RunInput } from "../../../src/ports/AgentBackend.ts";
import type { SessionId } from "../../../src/domain/ids.ts";

export type FakeBackendScript = (input: RunInput) => AgentEvent[];

export function makeFakeBackend(script: FakeBackendScript): AgentBackend {
  let scriptFn = script;
  return {
    kind: "claude",
    run(input: RunInput): AsyncIterable<AgentEvent> {
      const events = scriptFn(input);
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      };
    },
    async cancel(_sessionId: SessionId): Promise<void> {
      void _sessionId;
    },
    setScript(next: FakeBackendScript) {
      scriptFn = next;
    },
  } as AgentBackend & { setScript(next: FakeBackendScript): void };
}
