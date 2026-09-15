// A resumed Claude transcript can carry extended-thinking blocks that the next
// request rejects: either the signature no longer validates, or (after a model
// switch) the prior assistant turn's thinking blocks "cannot be modified". Both
// mean the resumed backend session is poisoned — the persisted backendSessionId
// must be cleared so the next turn starts fresh instead of re-resuming the poison.
//
// Shared between the Claude backend adapter (which retries fresh in-memory) and
// the app-layer run loops (which must persist-clear the poisoned id on failure).
export const THINKING_BLOCK_RESUME_ERROR_RE =
  /Invalid `?signature`? in `?thinking`? block|Invalid signature in thinking block|(?:thinking|redacted_thinking)\b[\s\S]{0,120}cannot be modified/u;

export function isThinkingBlockResumeError(text: string | undefined | null): boolean {
  if (!text) return false;
  return THINKING_BLOCK_RESUME_ERROR_RE.test(text);
}

// Codex can persist a malformed/oversized history item and then reject every
// subsequent resume before tool execution. Keep this narrower than generic
// 400/Bad Request handling: a generic request error may be a model/provider
// incompatibility that must remain resumable.
export const CODEX_ARRAY_PARAM_RESUME_ERROR_RE =
  /\[ArrayParam\]\s*\[input\[\d+\]\.content\]\s*\[array_above_max_length\]/u;

export function isCodexArrayParamResumeError(text: string | undefined | null): boolean {
  if (!text) return false;
  return CODEX_ARRAY_PARAM_RESUME_ERROR_RE.test(text);
}
