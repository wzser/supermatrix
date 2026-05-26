import type { AgentEvent } from "../../src/domain/events/agentEvent.ts";
import type { BackendKind } from "../../src/domain/session.ts";
import type { CardId, LarkGroupId, MessageRunId, SessionId } from "../../src/domain/ids.ts";
import { asCardId } from "../../src/domain/ids.ts";
import type { RunStatus } from "../../src/ports/BindingStore.ts";
import type { StreamLogEntry } from "../../src/app/replier.ts";
import type { UsageWatermark } from "../../src/app/usageCollector.ts";

export function createFakeReplier() {
  const consumed: Array<{ groupId: LarkGroupId; sessionId: SessionId; runId: MessageRunId }> = [];
  return {
    consumed,
    async consume(input: {
      groupId: LarkGroupId;
      sessionId: SessionId;
      runId: MessageRunId;
      sessionName: string;
      sessionModel: string | null;
      sessionBackend: BackendKind;
      usageBaseline?: UsageWatermark | null;
      stream: AsyncIterable<AgentEvent>;
    }): Promise<{
      finalMessage: string;
      cardId: CardId;
      runStatus: RunStatus;
      streamLog: StreamLogEntry[];
    }> {
      consumed.push({ groupId: input.groupId, sessionId: input.sessionId, runId: input.runId });
      const events: AgentEvent[] = [];
      for await (const e of input.stream) events.push(e);
      const final = events.find((e) => e.kind === "completed");
      return {
        finalMessage: final && final.kind === "completed" ? final.finalMessage : "",
        cardId: asCardId("fake_card"),
        runStatus: "completed",
        streamLog: [],
      };
    },
  };
}
