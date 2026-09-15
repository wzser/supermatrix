// src/adapters/backend-kimi/askUserPermission.ts
//
// Maps kimi's built-in AskUserQuestion tool — surfaced over ACP as
// session/request_permission with toolCall.title === "AskUserQuestion" — onto
// the card-ask broker, so the question reaches the user as a Feishu card
// instead of being silently auto-approved by the unattended permission
// handler (2026-07-22 incident: phantom "user chose option 1" answers in
// ~24ms, acted on with real side effects).
//
// Param shape verified by probe against kimi-code 0.27.0
// (scripts/repair/probe-kimi-askuser.mjs):
//   toolCall.title   = "AskUserQuestion"
//   toolCall.content = [{ type: "content", content: { type: "text", text: <question> } }]
//   options          = [{ kind: "allow_once", name: <label>, optionId: "q0_opt_<i>" },
//                       { kind: "reject_once", name: "Skip", optionId: "q0_skip" }]
// Option descriptions are NOT carried over ACP; we fall back to the label so
// the broker's non-empty-description validation passes.

import type { RequestPermissionRequest } from "@zed-industries/agent-client-protocol";
import type { CardAskBrokerOption } from "../card-ask/askViaBroker.ts";

export type AskUserPermission = {
  question: string;
  /** value = the ACP optionId to echo back when the user picks this option. */
  options: CardAskBrokerOption[];
};

const ASK_USER_QUESTION_TITLE = "AskUserQuestion";
// The Feishu card renders 1-5 option buttons; anything outside that range
// cannot become a valid card and must fall back to cancel.
const MAX_CARD_OPTIONS = 5;

export function isAskUserQuestionPermission(
  params: RequestPermissionRequest,
): boolean {
  return params.toolCall?.title === ASK_USER_QUESTION_TITLE;
}

/**
 * Extract { question, options } from an AskUserQuestion permission request.
 * Returns null when the request cannot become a valid card (no question text,
 * or an option count the card cannot render) — the caller must then cancel
 * rather than auto-approve.
 */
export function parseAskUserQuestionPermission(
  params: RequestPermissionRequest,
): AskUserPermission | null {
  if (!isAskUserQuestionPermission(params)) return null;

  let question = "";
  for (const entry of params.toolCall?.content ?? []) {
    const text = (entry as { content?: { text?: unknown } }).content?.text;
    if (typeof text === "string" && text.trim().length > 0) {
      question = text.trim();
      break;
    }
  }
  if (!question) return null;

  const options: CardAskBrokerOption[] = (params.options ?? [])
    .filter(
      (o) =>
        o.kind === "allow_once" &&
        typeof o.name === "string" &&
        o.name.trim().length > 0 &&
        typeof o.optionId === "string" &&
        o.optionId.trim().length > 0,
    )
    .map((o) => ({
      label: o.name.trim(),
      value: o.optionId,
      description: o.name.trim(),
    }));
  if (options.length < 1 || options.length > MAX_CARD_OPTIONS) return null;

  return { question, options };
}
