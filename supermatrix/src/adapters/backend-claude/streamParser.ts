import type { AgentEvent } from "../../domain/events/agentEvent.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// State carried across chunks of a single claude run. spawnAndStream creates
// one and reuses it across every data event. Without this, each data chunk
// would emit a duplicate `started` event because every line in claude's
// stream-json output contains session_id as metadata.
export type ClaudeStreamState = {
  sessionAnnounced: boolean;
  model?: string;
  thinking?: boolean;
  // Set once we've emitted any usage event from an assistant-type record
  // during the stream. Result-type usage is a run total and would double
  // the accumulator if emitted on top of per-turn usages, so result only
  // emits usage when no assistant-turn usage was seen (back-compat with
  // fixtures that only carry usage on the terminal record).
  usageEmitted?: boolean;
};

export function createClaudeStreamState(): ClaudeStreamState {
  return { sessionAnnounced: false };
}

export function parseClaudeStream(
  lines: string[],
  state: ClaudeStreamState = createClaudeStreamState()
): AgentEvent[] {
  const events: AgentEvent[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;

    const type = record["type"];

    // 1. System / init events — carry session_id, model, thinking config.
    //    First one becomes `started`.
    if (type === "system") {
      // Cache model / thinking from the init envelope so they're available
      // even if session_id arrives in a later record.
      if (typeof record["model"] === "string" && record["model"]) {
        state.model = record["model"];
      }
      const thinkingField = record["thinking"];
      if (isRecord(thinkingField)) {
        state.thinking = thinkingField["type"] === "enabled";
      } else if (typeof thinkingField === "boolean") {
        state.thinking = thinkingField;
      }

      if (!state.sessionAnnounced) {
        const id = extractSessionId(record);
        if (id) {
          events.push({
            kind: "started",
            backendSessionId: id,
            ...(state.model ? { model: state.model } : {}),
            ...(state.thinking !== undefined ? { thinking: state.thinking } : {}),
          });
          state.sessionAnnounced = true;
        }
      }
      continue;
    }

    // 2. Assistant messages — a message has a content array whose entries can
    //    be text blocks, tool_use blocks, or thinking blocks. The message
    //    envelope's `usage` is per-LLM-call and lets us stream live context
    //    size into the card title without waiting for the terminal `result`.
    if (type === "assistant") {
      const message = record["message"];
      if (isRecord(message)) {
        const content = message["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue;
            const blockType = block["type"];
            if (blockType === "text") {
              const text = typeof block["text"] === "string" ? block["text"] : "";
              if (text) events.push({ kind: "thinking", text });
            } else if (blockType === "tool_use") {
              const name = typeof block["name"] === "string" ? block["name"] : "tool";
              const args = block["input"] ?? {};
              events.push({ kind: "tool_call", name, args });
            }
            // "thinking" (extended-thinking) blocks are noisy — skip.
          }
        }
        const msgUsage = message["usage"];
        const messageModel = typeof message["model"] === "string" ? (message["model"] as string) : null;
        const usageEvent = buildUsageEvent(msgUsage, messageModel, state.model ?? null);
        if (usageEvent) {
          events.push(usageEvent);
          state.usageEmitted = true;
        }
      }
      // Some runs also announce session_id here before system init arrives.
      if (!state.sessionAnnounced) {
        const id = extractSessionId(record);
        if (id) {
          events.push({
            kind: "started",
            backendSessionId: id,
            ...(state.model ? { model: state.model } : {}),
            ...(state.thinking !== undefined ? { thinking: state.thinking } : {}),
          });
          state.sessionAnnounced = true;
        }
      }
      continue;
    }

    // 3. User events (tool results fed back to assistant).
    if (type === "user") {
      const message = record["message"];
      if (isRecord(message)) {
        const content = message["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!isRecord(block)) continue;
            if (block["type"] === "tool_result") {
              events.push({
                kind: "tool_result",
                name: typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "tool",
                result: block["content"] ?? null,
              });
            }
          }
        }
      }
      continue;
    }

    // 4. Rate limit / hook / debug events — surface session id if present,
    //    otherwise silently skip.
    if (type === "rate_limit_event") {
      continue;
    }

    // 5. Explicit error envelope (rare — usually claude exits non-zero
    //    instead).
    if (type === "error") {
      const message = typeof record["message"] === "string" ? record["message"] : "unknown error";
      events.push({ kind: "error", message, recoverable: false });
      continue;
    }

    // 6. Final result.
    if (type === "result") {
      const isError = record["is_error"] === true;
      const finalMessage = extractFinalMessage(record);
      if (isError) {
        events.push({
          kind: "error",
          message: finalMessage || "claude returned is_error",
          recoverable: false,
        });
      } else {
        events.push({ kind: "assistant_message", text: finalMessage, final: true });
      }
      events.push({ kind: "completed", finalMessage });
      // Result.usage is the run-level total. If we already streamed per-turn
      // usages from assistant records, emitting it again would double the
      // accumulator (sum semantics). Only emit when no assistant usage
      // surfaced — i.e. fixtures/older stream shapes that only report on
      // the terminal record.
      if (!state.usageEmitted) {
        const recordModel = typeof record["model"] === "string" ? (record["model"] as string) : null;
        const usage = buildUsageEvent(record["usage"], recordModel, state.model ?? null);
        if (usage) events.push(usage);
      }
      continue;
    }

    // 7. Fallback for unknown "delta" shapes (kept for synthetic fixtures
    //    that predate the real-format rewrite).
    if (type === "message_delta" || type === "assistant_delta") {
      const text = extractDeltaText(record);
      if (text) events.push({ kind: "thinking", text });
      continue;
    }

    // 8. A line with only session_id and no type — still counts.
    if (!state.sessionAnnounced) {
      const id = extractSessionId(record);
      if (id) {
        events.push({
          kind: "started",
          backendSessionId: id,
          ...(state.model ? { model: state.model } : {}),
          ...(state.thinking !== undefined ? { thinking: state.thinking } : {}),
        });
        state.sessionAnnounced = true;
      }
    }
  }

  return events;
}

function extractSessionId(record: JsonRecord): string | undefined {
  for (const key of ["session_id", "sessionId", "id"]) {
    const v = record[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function extractDeltaText(record: JsonRecord): string | undefined {
  const delta = record["delta"];
  if (typeof delta === "string") return delta;
  if (isRecord(delta) && typeof delta["text"] === "string") return delta["text"];
  const text = record["text"];
  if (typeof text === "string") return text;
  return undefined;
}

// Accepts either `record.usage` (result envelope) or `record.message.usage`
// (per-assistant envelope) — both share the same Anthropic token-field
// shape, the only difference being where they live in the outer record.
function buildUsageEvent(
  usage: unknown,
  recordModel: string | null,
  fallbackModel: string | null
): Extract<AgentEvent, { kind: "usage" }> | undefined {
  if (!isRecord(usage)) return undefined;
  const input = toInt(usage["input_tokens"]);
  const output = toInt(usage["output_tokens"]);
  const cacheRead = toInt(usage["cache_read_input_tokens"]);
  const cacheWrite = toInt(usage["cache_creation_input_tokens"]);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  return {
    kind: "usage",
    model: recordModel || fallbackModel,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: 0,
    rawUsage: usage,
  };
}

function toInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function extractFinalMessage(record: JsonRecord): string {
  const direct = record["result"] ?? record["final"] ?? record["text"];
  if (typeof direct === "string") return direct;
  if (isRecord(direct)) {
    const maybe = direct["text"];
    if (typeof maybe === "string") return maybe;
  }
  return "";
}
