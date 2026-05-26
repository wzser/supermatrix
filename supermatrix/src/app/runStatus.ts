import type { RunStatus } from "../ports/BindingStore.ts";

// Terminal error messages that must override a prior `completed` / final
// `assistant_message` — the stream delivered some output, then a watchdog or
// user action killed the run. Treating these as post-delivery noise (like we
// do for claude-CLI exit 1 or codex "Reconnecting...") would leave the card
// green / titled "done" while the body shows "❌ [TIMEOUT] …" — the exact
// divergence this module exists to prevent.
export function isTerminalErrorMessage(message: string): boolean {
  return message.startsWith("[TIMEOUT]") || message === "cancelled by user";
}

// Single source of truth for mapping a backend error string to a RunStatus.
// Used by the dispatcher to write DB rows AND by the replier to pick card
// title suffix / template color, so the two stay aligned.
export function classifyRunStatus(error?: string): RunStatus {
  if (!error) return "completed";
  if (error.startsWith("[TIMEOUT]")) return "timeout";
  if (error === "cancelled by user") return "cancelled";
  return "failed";
}

export function titleSuffixForRunStatus(status: RunStatus): string {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
  }
}
