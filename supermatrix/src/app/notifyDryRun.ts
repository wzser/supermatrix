import type { Logger } from "../ports/Logger.ts";
import type { NotifySender } from "./consoleNotifier.ts";

export type NotifyDryRunDecision =
  | { dryRun: true; reason: string }
  | { dryRun: false };

// Decides whether this process may put a real Feishu message on the wire.
// VITEST is checked first and is deliberately not overridable: a test process
// must never be able to opt itself back into real sends (a WIP fixture reaching
// the bootstrap notify sender is exactly how a test card once landed in a real
// group). SM_NOTIFY_DRY_RUN=1 is the opt-in for a dev instance. Production sets
// neither, so live delivery is unchanged.
export function resolveNotifyDryRun(env: NodeJS.ProcessEnv): NotifyDryRunDecision {
  if (env["VITEST"]) return { dryRun: true, reason: "VITEST" };
  if (env["SM_NOTIFY_DRY_RUN"] === "1") return { dryRun: true, reason: "SM_NOTIFY_DRY_RUN=1" };
  return { dryRun: false };
}

// Wraps a NotifySender so a dry-run process renders and logs the card but never
// invokes the underlying sender. Succeeding (rather than throwing) keeps callers
// on their real success path; the om_dryrun_ prefix keeps the result from being
// mistaken for a delivered message.
export function withNotifyDryRun(
  sender: NotifySender,
  decision: NotifyDryRunDecision,
  logger: Logger,
  consoleGroupId?: string,
): NotifySender {
  if (!decision.dryRun) return sender;

  let seq = 0;
  const swallow = (kind: "card" | "text", payload: string, targetChatId?: string) => {
    seq += 1;
    logger.warn("notify: DRY-RUN — no Feishu message sent", {
      reason: decision.reason,
      kind,
      chatId: targetChatId ?? consoleGroupId ?? null,
      payload: payload.slice(0, 500),
    });
    return { messageId: `om_dryrun_${seq}` };
  };

  return {
    sendCard: async (content, targetChatId) => swallow("card", content, targetChatId),
    sendText: async (text, targetChatId) => swallow("text", text, targetChatId),
  };
}
