// src/adapters/backend-kimi/eventTranslator.ts
//
// Translates ACP `session/update.update` objects into SuperMatrix `AgentEvent`.
//
// Observed `sessionUpdate` discriminant values (from T0 fixtures, kimi-cli 1.37.0):
//   agent_message_chunk      — answer text chunk: { content: { type: "text", text } }
//   agent_thought_chunk      — thinking text chunk: { content: { type: "text", text } }
//   tool_call                — tool invocation start: { toolCallId, title, status, content[] }
//   tool_call_update         — tool arg streaming / status update: { toolCallId, status, content[] }
//   available_commands_update — session command list update (ignored)
//
// Final / end-of-turn is carried by the PromptResponse.stopReason ("end_turn"),
// NOT as a session/update notification.
//
// NOTE: ACP carries NO usage / token notifications — no usage_update branch.

import type { AgentEvent } from "../../domain/events/agentEvent.ts";

export type TranslatorState = {
  sessionAnnounced: boolean;
  pendingAssistant: string;
  pendingThinking: string;
  toolCallTitles: Map<string, string>;
};

export function createTranslatorState(): TranslatorState {
  return {
    sessionAnnounced: false,
    pendingAssistant: "",
    pendingThinking: "",
    toolCallTitles: new Map(),
  };
}

// Extract text from an ACP content block.
// Handles two observed shapes:
//   Flat:   { type: "text", text: "..." }            — agent_message_chunk / agent_thought_chunk
//   Nested: { type: "content", content: { type: "text", text: "..." } }  — tool_call / tool_call_update
function blockText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
  if (b["type"] === "content" && b["content"]) return blockText(b["content"]);
  return "";
}

export function translateUpdate(update: unknown, state: TranslatorState): AgentEvent[] {
  if (!update || typeof update !== "object") return [];
  const u = update as Record<string, unknown>;
  const kind = u["sessionUpdate"];

  if (kind === "agent_message_chunk") {
    state.pendingAssistant += blockText(u["content"]);
    return [];
  }

  if (kind === "agent_thought_chunk") {
    // not observed to accumulate across multiple flush cycles in fixtures,
    // but we accumulate like message chunks for symmetry.
    state.pendingThinking += blockText(u["content"]);
    return [];
  }

  if (kind === "tool_call") {
    const tcId = String(u["toolCallId"] ?? "");
    const title = String(u["title"] ?? u["kind"] ?? "tool");
    state.toolCallTitles.set(tcId, title);
    return [{ kind: "tool_call", name: title, args: {} }];
  }

  if (kind === "tool_call_update") {
    const tcId = String(u["toolCallId"] ?? "");
    const title = state.toolCallTitles.get(tcId) ?? String(u["title"] ?? "tool");
    const status = u["status"];
    if (status === "completed" || status === "failed") {
      state.toolCallTitles.delete(tcId);
      return [
        {
          kind: "tool_result",
          name: title,
          result: {
            output: extractToolResultText(u),
            exitCode: status === "failed" ? 1 : 0,
          },
        },
      ];
    }
    // in_progress — streaming args; nothing to emit yet
    return [];
  }

  // available_commands_update and any future unknown kinds — ignore silently.
  return [];
}

export function flushTranslator(state: TranslatorState, stopReason: string): AgentEvent[] {
  const out: AgentEvent[] = [];

  if (state.pendingThinking) {
    out.push({ kind: "thinking", text: state.pendingThinking });
    state.pendingThinking = "";
  }

  if (stopReason === "cancelled") {
    out.push({ kind: "error", message: "kimi turn cancelled by user", recoverable: false });
    // M3: emit completed so downstream consumers (dispatcher, replier) can finalise.
    out.push({ kind: "completed", finalMessage: "" });
    return out;
  }

  if (state.pendingAssistant) {
    const text = state.pendingAssistant;
    state.pendingAssistant = "";
    out.push({ kind: "assistant_message", text, final: true });
    out.push({ kind: "completed", finalMessage: text });
    return out;
  }

  if (state.sessionAnnounced) {
    out.push({
      kind: "error",
      message: "kimi returned empty completion",
      recoverable: false,
    });
  }
  return out;
}

function extractToolResultText(update: Record<string, unknown>): string {
  const content = update["content"] ?? update["result"] ?? [];
  if (!Array.isArray(content)) return "";
  return content.map(blockText).filter(Boolean).join("");
}
