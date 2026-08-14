import type { AgentEvent } from "../../../src/domain/events/agentEvent.ts";
import type {
  AgentBackend,
  RunInput,
  SteerInput,
  SteerResult,
} from "../../../src/ports/AgentBackend.ts";
import type { SessionId } from "../../../src/domain/ids.ts";

export type FakeBackendScript = (input: RunInput) => AgentEvent[];
export type FakeBackendSteer = (input: SteerInput) => Promise<SteerResult>;

export type FakeAgentBackend = AgentBackend & {
  readonly runInputs: RunInput[];
  readonly steerCalls: SteerInput[];
  readonly cancelCalls: SessionId[];
  setScript(next: FakeBackendScript): void;
  setSteer(next: FakeBackendSteer): void;
};

export function makeFakeBackend(script: FakeBackendScript): FakeAgentBackend {
  let scriptFn = script;
  let steerFn: FakeBackendSteer = async () => ({ accepted: true });
  const runInputs: RunInput[] = [];
  const steerCalls: SteerInput[] = [];
  const cancelCalls: SessionId[] = [];
  return {
    kind: "claude",
    runInputs,
    steerCalls,
    cancelCalls,
    run(input: RunInput): AsyncIterable<AgentEvent> {
      runInputs.push(input);
      const events = scriptFn(input);
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      };
    },
    async cancel(sessionId: SessionId): Promise<void> {
      cancelCalls.push(sessionId);
    },
    async steer(input: SteerInput): Promise<SteerResult> {
      steerCalls.push(input);
      return await steerFn(input);
    },
    setScript(next: FakeBackendScript) {
      scriptFn = next;
    },
    setSteer(next: FakeBackendSteer) {
      steerFn = next;
    },
  };
}
