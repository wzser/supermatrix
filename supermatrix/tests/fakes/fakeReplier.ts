import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import type { BackendKind, EffortLevel } from "../../src/domain/session.ts";
import type { CardId, LarkGroupId, MessageRunId, SessionId } from "../../src/domain/ids.ts";
import { asCardId } from "../../src/domain/ids.ts";
import type { RunStatus } from "../../src/ports/BindingStore.ts";
import type { StreamLogEntry } from "../../src/app/replier.ts";
import type { UsageWatermark } from "../../src/app/usageCollector.ts";

export function createFakeReplier() {
  const consumed: Array<{ groupId: LarkGroupId; sessionId: SessionId; runId: MessageRunId; branchName?: string; askUserQuestionCardRouted?: boolean }> = [];
  return {
    consumed,
    async consume(input: {
      groupId: LarkGroupId;
      sessionId: SessionId;
      runId: MessageRunId;
      sessionName: string;
      branchName?: string;
      sessionModel: string | null;
      sessionEffort?: EffortLevel | null;
      sessionBackend: BackendKind;
      usageBaseline?: UsageWatermark | null;
      askUserQuestionCardRouted?: boolean;
      stream: AsyncIterable<AgentEvent>;
    }): Promise<{
      finalMessage: string;
      cardId: CardId;
      runStatus: RunStatus;
      streamLog: StreamLogEntry[];
      backendSessionId?: string;
    }> {
      consumed.push({
        groupId: input.groupId,
        sessionId: input.sessionId,
        runId: input.runId,
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.askUserQuestionCardRouted ? { askUserQuestionCardRouted: true } : {}),
      });
      const events: AgentEvent[] = [];
      for await (const e of input.stream) events.push(e);
      const final = events.find((e) => e.kind === "completed");
      const started = events.find((e) => e.kind === "started");
      return {
        finalMessage: final && final.kind === "completed" ? final.finalMessage : "",
        cardId: asCardId("fake_card"),
        runStatus: "completed",
        streamLog: [],
        ...(started && started.kind === "started" ? { backendSessionId: started.backendSessionId } : {}),
      };
    },
  };
}
