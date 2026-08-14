// src/adapters/backend-kimi/eventTranslator.ts
//
// Translates ACP `session/update.update` objects into SuperMatrix `AgentEvent`.
//
// Observed `sessionUpdate` discriminant values (from T0 fixtures, kimi-cli 1.37.0):
//   agent_message_chunk      — answer text chunk: { content: { type: "text", text } }
//   agent_thought_chunk      — thinking text chunk: { content: { type: "text", text } }
//   tool_call                — tool invocation start: { toolCallId, title, status, content[] }
//   tool_call_update         — tool arg streaming / status update: { toolCallId, status, content[], title? }
//   available_commands_update — session command list update (ignored)
//
// Tool-call detail: kimi does NOT include the tool input in the initial
// tool_call notification. Instead the args JSON is streamed as text chunks in
// the following in_progress tool_call_update content blocks, and the update
// `title` progressively gains detail ("Shell" → "Shell: echo hi"). So the
// tool_call event is buffered and emitted exactly once — as soon as the
// accumulated args JSON parses (with real args + extracted command), or at
// tool completion / turn end if it never does. This mirrors how codex's
// function_call arrives with complete arguments, keeping the card line
// informative ("🔧 Shell: command=echo hi") instead of a bare tool name.
//
// Thinking: agent_thought_chunk arrives word-by-word. Chunks are accumulated
// and flushed as a live `thinking` event at natural boundaries — before the
// first answer text, before a tool event, and at turn end — mirroring codex's
// per-commentary thinking lines instead of one blob after the run.
//
// Final / end-of-turn is carried by the PromptResponse.stopReason ("end_turn"),
// NOT as a session/update notification.
//
// NOTE: ACP carries NO usage / token notifications — no usage_update branch.

import type { AgentEvent } from "../../domain/events/agentEvent.ts";

export type PendingToolCall = {
  tcId: string;
  name: string; // base tool title, without the streamed ": <args>" suffix
  argsText: string; // accumulated raw args JSON streamed by in_progress updates
  emitted: boolean; // the tool_call AgentEvent has been emitted
  args: unknown; // parsed args, once the streamed JSON completes
  command?: string; // extracted display command (command/cmd/path/query/…)
};

export type TranslatorState = {
  sessionAnnounced: boolean;
  pendingAssistant: string;
  pendingThinking: string;
  toolCalls: Map<string, PendingToolCall>;
};

export function createTranslatorState(): TranslatorState {
  return {
    sessionAnnounced: false,
    pendingAssistant: "",
    pendingThinking: "",
    toolCalls: new Map(),
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

// Strip the progressively-streamed args detail kimi appends to update titles
// ("Shell: echo hi" → "Shell"). Initial tool_call titles carry no detail.
function baseTitle(raw: string): string {
  const idx = raw.indexOf(":");
  return idx > 0 ? raw.slice(0, idx) : raw;
}

// Keys replier.summarizeToolPayload prefers when rendering a one-line summary;
// reused here to pick the tool_call `command` display field.
const COMMAND_ARG_KEYS = ["command", "cmd", "path", "file_path", "filePath", "query", "q", "url"];

function pickCommandArg(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of COMMAND_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// Try to complete the pending call's args from the streamed JSON text.
// kimi-cli streams args as cumulative snapshots — each in_progress update
// carries the full JSON text so far ("{", "{\"command", "{\"command\": \"echo hi\"}"),
// not a delta — so the newest text replaces the previous one. Returns true
// once the JSON parses (args + command become available).
function completeArgs(p: PendingToolCall, latestText?: string): boolean {
  if (latestText) p.argsText = latestText;
  const text = p.argsText.trim();
  if (!text) return false;
  try {
    p.args = JSON.parse(text);
  } catch {
    return false;
  }
  const cmd = pickCommandArg(p.args);
  if (cmd === undefined) delete p.command;
  else p.command = cmd;
  return true;
}

function toolCallEvent(p: PendingToolCall): AgentEvent {
  const event: Extract<AgentEvent, { kind: "tool_call" }> = {
    kind: "tool_call",
    name: p.name,
    args: p.args ?? {},
    callId: p.tcId,
  };
  if (p.command) event.command = p.command;
  return event;
}

// Flush accumulated thought chunks as one live thinking event. Codex emits
// thinking per commentary message; this gives kimi the same interleaving of
// 💭 lines with tool activity instead of a single blob at turn end.
function flushThinking(state: TranslatorState, out: AgentEvent[]): void {
  const text = state.pendingThinking;
  state.pendingThinking = "";
  if (text.trim()) out.push({ kind: "thinking", text });
}

export function translateUpdate(update: unknown, state: TranslatorState): AgentEvent[] {
  if (!update || typeof update !== "object") return [];
  const u = update as Record<string, unknown>;
  const kind = u["sessionUpdate"];

  if (kind === "agent_message_chunk") {
    // First answer text ends the thinking phase — flush thoughts so the card
    // shows 💭 before the final 💬.
    const out: AgentEvent[] = [];
    flushThinking(state, out);
    state.pendingAssistant += blockText(u["content"]);
    return out;
  }

  if (kind === "agent_thought_chunk") {
    // not observed to accumulate across multiple flush cycles in fixtures,
    // but we accumulate like message chunks for symmetry.
    state.pendingThinking += blockText(u["content"]);
    return [];
  }

  if (kind === "tool_call") {
    const tcId = String(u["toolCallId"] ?? "");
    // Buffer, don't emit yet — the args arrive in the following updates.
    state.toolCalls.set(tcId, {
      tcId,
      name: baseTitle(String(u["title"] ?? u["kind"] ?? "tool")),
      argsText: extractToolResultText(u),
      emitted: false,
      args: undefined,
    });
    return [];
  }

  if (kind === "tool_call_update") {
    const tcId = String(u["toolCallId"] ?? "");
    let p = state.toolCalls.get(tcId);
    if (!p) {
      p = {
        tcId,
        name: baseTitle(String(u["title"] ?? "tool")),
        argsText: "",
        emitted: false,
        args: undefined,
      };
      state.toolCalls.set(tcId, p);
    }
    const status = u["status"];

    if (status === "completed" || status === "failed") {
      const out: AgentEvent[] = [];
      flushThinking(state, out);
      if (!p.emitted) {
        // Args never completed streaming — emit with whatever detail we have.
        completeArgs(p);
        out.push(toolCallEvent(p));
        p.emitted = true;
      }
      state.toolCalls.delete(tcId);
      const result: Extract<AgentEvent, { kind: "tool_result" }> = {
        kind: "tool_result",
        name: p.name,
        result: {
          output: extractToolResultText(u),
          exitCode: status === "failed" ? 1 : 0,
        },
        callId: tcId,
      };
      if (p.command) result.command = p.command;
      out.push(result);
      return out;
    }

    // in_progress — args JSON streams in as cumulative snapshots.
    if (!p.emitted && completeArgs(p, extractToolResultText(u))) {
      const out: AgentEvent[] = [];
      flushThinking(state, out);
      out.push(toolCallEvent(p));
      p.emitted = true;
      return out;
    }
    return [];
  }

  // available_commands_update and any future unknown kinds — ignore silently.
  return [];
}

// Flush everything still pending that is safe to surface regardless of how
// the turn ended: accumulated thinking and tool calls that were never emitted
// (args never finished streaming). Used by flushTranslator and by the
// timeout/user-cancel terminal paths in index.ts so those paths don't lose
// the turn's trailing activity.
export function flushPendingContent(state: TranslatorState): AgentEvent[] {
  const out: AgentEvent[] = [];
  flushThinking(state, out);
  for (const p of state.toolCalls.values()) {
    if (!p.emitted) {
      completeArgs(p);
      out.push(toolCallEvent(p));
    }
  }
  state.toolCalls.clear();
  return out;
}

export function flushTranslator(state: TranslatorState, stopReason: string): AgentEvent[] {
  const out: AgentEvent[] = flushPendingContent(state);

  if (stopReason === "cancelled") {
    // Canonical terminal cancel marker (see app/runStatus.ts) — shared with
    // claude/codex so kimi user-cancels classify as "cancelled", not "failed".
    // Adapter-initiated timeout kills never reach here: index.ts intercepts
    // them earlier and emits "[TIMEOUT] …" instead.
    out.push({ kind: "error", message: "cancelled by user", recoverable: false });
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
