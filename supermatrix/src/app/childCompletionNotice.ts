import { fallbackChildCompletionSummary } from "./childCompletionSummary.ts";
import type { Session } from "../domain/session.ts";
import type { LarkGroupId, SessionId, Timestamp } from "../domain/ids.ts";
import type { BindingStore } from "../ports/BindingStore.ts";
import type { Logger } from "../ports/Logger.ts";

export type ChildCompletionNoticeInput = {
  commId: string;
  callerSessionId: SessionId;
  childSession: Session;
  completedAt: Timestamp;
  finalMessage?: string;
};

export type ChildCompletionNotifier = (input: ChildCompletionNoticeInput) => Promise<void>;
export type ChildCompletionSummaryProvider = (input: ChildCompletionNoticeInput) => Promise<string | null>;

export type ChildCompletionNotifierDeps = {
  store: Pick<BindingStore, "findBySession">;
  lark: {
    sendMessage(groupId: LarkGroupId, text: string, identity?: "bot" | "user"): Promise<void>;
  };
  summaryProvider?: ChildCompletionSummaryProvider;
  logger?: Logger;
};

export function renderChildCompletionNotice(input: ChildCompletionNoticeInput, summary?: string | null): string {
  const lines = [
    input.commId,
    formatCstTime(input.completedAt),
    `子 session ${input.childSession.name} 已执行完成。`,
  ];
  if (summary) {
    lines.push(`内容概括：${summary}`);
  }
  return lines.join("\n");
}

export function createChildCompletionNotifier(
  deps: ChildCompletionNotifierDeps,
): ChildCompletionNotifier {
  return async (input) => {
    const binding = await deps.store.findBySession(input.callerSessionId);
    if (!binding) {
      deps.logger?.warn("child completion notice skipped: caller binding missing", {
        comm_id: input.commId,
        caller_session_id: input.callerSessionId,
        child_session_id: input.childSession.id,
      });
      return;
    }

    const summary = await summarizeCompletion(deps, input);
    await deps.lark.sendMessage(binding.groupId, renderChildCompletionNotice(input, summary), "bot");
  };
}

async function summarizeCompletion(
  deps: ChildCompletionNotifierDeps,
  input: ChildCompletionNoticeInput,
): Promise<string | null> {
  if (!deps.summaryProvider) return fallbackChildCompletionSummary(input);
  try {
    return (await deps.summaryProvider(input)) ?? fallbackChildCompletionSummary(input);
  } catch (err) {
    deps.logger?.warn("child completion summary failed", {
      comm_id: input.commId,
      child_session_id: input.childSession.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return fallbackChildCompletionSummary(input);
  }
}

function formatCstTime(ms: Timestamp): string {
  const cstOffsetMs = 8 * 60 * 60 * 1000;
  return `${new Date(ms + cstOffsetMs).toISOString().slice(0, 19).replace("T", " ")} CST`;
}
