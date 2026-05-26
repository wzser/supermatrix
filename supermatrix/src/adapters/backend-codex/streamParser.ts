import type { AgentEvent } from "../../domain/events/agentEvent.ts";

type JsonRecord = Record<string, unknown>;
type UsageEvent = Extract<AgentEvent, { kind: "usage" }>;
type UsageSource = "turn.completed" | "token_count";
type ParsedTurnUsage = UsageEvent & {
  source: UsageSource;
  rawOutputTokens: number;
};
type PendingTurnUsage = {
  coarse?: ParsedTurnUsage;
  rich?: ParsedTurnUsage;
};
type PendingToolCall = {
  name: string;
  command?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  const text = getString(value);
  return text && text.trim() ? text : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getNestedRecord(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function getOutputTextContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((item) => {
      if (!isRecord(item) || item.type !== "output_text") return undefined;
      return getString(item.text);
    })
    .filter((item): item is string => typeof item === "string")
    .join("");
  return getNonEmptyString(text);
}

function parseFunctionArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractCommandFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  return getNonEmptyString(args.cmd) ?? getNonEmptyString(args.command);
}

function hasUsageFields(record: JsonRecord): boolean {
  return (
    getNumber(record.input_tokens) !== undefined ||
    getNumber(record.cached_input_tokens) !== undefined ||
    getNumber(record.output_tokens) !== undefined ||
    getNumber(record.reasoning_output_tokens) !== undefined
  );
}

// State carried across chunks of a single codex run. spawnAndStream creates
// one and reuses it, so a per-chunk parse call does not re-announce `started`.
export type CodexStreamState = {
  sessionAnnounced: boolean;
  model?: string;
  pendingTurnUsage?: PendingTurnUsage | undefined;
  pendingAgentMessage?: string | undefined;
  pendingToolCalls?: Map<string, PendingToolCall>;
};

export function createCodexStreamState(fallbackModel?: string | null): CodexStreamState {
  return {
    sessionAnnounced: false,
    pendingToolCalls: new Map(),
    ...(fallbackModel ? { model: fallbackModel } : {}),
  };
}

export type ParseCodexStreamOptions = {
  flush?: boolean;
};

export function parseCodexStream(
  lines: string[],
  state: CodexStreamState = createCodexStreamState(),
  options: ParseCodexStreamOptions = {}
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

    rememberModel(state, record);

    // Session id: explicit session_id field, or thread.started with thread_id
    if (!state.sessionAnnounced) {
      const sid = getString(record.session_id);
      if (sid) {
        events.push({ kind: "started", backendSessionId: sid });
        state.sessionAnnounced = true;
      } else if (record.type === "thread.started") {
        const tid = getString(record.thread_id);
        if (tid) {
          events.push({ kind: "started", backendSessionId: tid });
          state.sessionAnnounced = true;
        }
      }
    }

    if (record.type === "turn.completed") {
      emitPendingAgentMessage(events, state, "final");
      const usage = parseTurnCompletedUsage(record, state.model);
      if (usage) {
        const committed = appendUsage(state, usage);
        if (committed) events.push(committed);
      }
      continue;
    }

    // Commentary is visible process narration. Keep it in the stream trace,
    // not in the final assistant body.
    if (record.type === "event_msg") {
      const payload = getNestedRecord(record, "payload");
      rememberModel(state, payload);
      if (payload?.type === "token_count") {
        const usage = parseTokenCountUsage(payload, state.model);
        if (usage) {
          const committed = appendUsage(state, usage);
          if (committed) events.push(committed);
        }
      } else if (payload?.type === "agent_message" && payload.phase === "commentary") {
        const msg = getNonEmptyString(payload.message);
        if (msg) {
          emitPendingAgentMessage(events, state, "thinking");
          events.push({ kind: "thinking", text: msg });
        }
      } else if (payload?.type === "task_complete") {
        // Codex completed the turn but produced no assistant message.
        // Observed on codex-cli 0.128.0 + effort=xhigh: the model exhausts
        // reasoning without emitting a final, then `task_complete` carries
        // `last_agent_message: null`. Without this guard the run lands as
        // completed + empty final, downstream sinks silently drop it, and
        // the user sees no reply at all. Emit a stable error so both the
        // replier and streamCollector mark the run failed; only when no
        // content was staged earlier in the turn (otherwise turn.completed
        // will flush the pending message normally).
        if (payload.last_agent_message === null && !state.pendingAgentMessage) {
          events.push({
            kind: "error",
            message: "codex returned empty completion (last_agent_message=null)",
            recoverable: false,
          });
        }
      }
      continue;
    }

    if (record.type === "response_item") {
      const payload = getNestedRecord(record, "payload");
      if (
        payload?.type === "message" &&
        payload.role === "assistant" &&
        payload.phase === "commentary"
      ) {
        const msg = getOutputTextContent(payload.content);
        if (msg) {
          emitPendingAgentMessage(events, state, "thinking");
          events.push({ kind: "thinking", text: msg });
        }
      }
      if (payload?.type === "function_call") {
        emitPendingAgentMessage(events, state, "thinking");
        const callId = getNonEmptyString(payload.call_id);
        const name = getNonEmptyString(payload.name) ?? "function_call";
        const args = parseFunctionArguments(payload.arguments);
        const command = extractCommandFromArgs(args) ?? getNonEmptyString(payload.command);
        const event: Extract<AgentEvent, { kind: "tool_call" }> = {
          kind: "tool_call",
          name,
          args,
        };
        if (callId) event.callId = callId;
        if (command) event.command = command;
        if (callId) {
          getPendingToolCalls(state).set(
            callId,
            command ? { name, command } : { name },
          );
        }
        events.push(event);
      } else if (payload?.type === "function_call_output") {
        emitPendingAgentMessage(events, state, "thinking");
        const callId = getNonEmptyString(payload.call_id);
        const pending = callId ? getPendingToolCalls(state).get(callId) : undefined;
        const name = pending?.name ?? getNonEmptyString(payload.name) ?? "function_call_output";
        const command = pending?.command ?? getNonEmptyString(payload.command);
        const event: Extract<AgentEvent, { kind: "tool_result" }> = {
          kind: "tool_result",
          name,
          result: { output: payload.output ?? "" },
        };
        if (callId) {
          event.callId = callId;
          getPendingToolCalls(state).delete(callId);
        }
        if (command) event.command = command;
        events.push(event);
      }
      continue;
    }

    if (record.type === "item.started") {
      const item = getNestedRecord(record, "item");
      if (item?.type === "command_execution") {
        emitPendingAgentMessage(events, state, "thinking");
        const command = getNonEmptyString(item.command) ?? "command_execution";
        events.push({ kind: "tool_call", name: command, args: {} });
      }
      continue;
    }

    if (record.type === "item.completed") {
      const item = getNestedRecord(record, "item");
      if (item?.type === "agent_message") {
        const text = getNonEmptyString(item.text);
        if (text) {
          emitPendingAgentMessage(events, state, "thinking");
          state.pendingAgentMessage = text;
        }
      } else if (item?.type === "command_execution") {
        emitPendingAgentMessage(events, state, "thinking");
        const command = getNonEmptyString(item.command) ?? "command_execution";
        events.push({
          kind: "tool_result",
          name: command,
          result: {
            output: getString(item.aggregated_output) ?? "",
            exitCode: getNumber(item.exit_code) ?? null,
          },
        });
      }
      continue;
    }

    const lastMsg = getNonEmptyString(record.last_assistant_message);
    if (lastMsg) {
      delete state.pendingAgentMessage;
      events.push({ kind: "assistant_message", text: lastMsg, final: true });
      events.push({ kind: "completed", finalMessage: lastMsg });
      continue;
    }

    if (record.type === "error") {
      const msg = getNonEmptyString(record.message) ?? "unknown codex error";
      events.push({ kind: "error", message: msg, recoverable: false });
      continue;
    }
  }

  if (options.flush) {
    emitPendingAgentMessage(events, state, "final");
    const committed = commitPendingUsage(state);
    if (committed) events.push(committed);
  }

  return events;
}

function emitPendingAgentMessage(
  events: AgentEvent[],
  state: CodexStreamState,
  mode: "thinking" | "final"
): void {
  const text = state.pendingAgentMessage;
  if (!text) return;
  delete state.pendingAgentMessage;
  if (mode === "thinking") {
    events.push({ kind: "thinking", text });
  } else {
    events.push({ kind: "assistant_message", text, final: true });
    events.push({ kind: "completed", finalMessage: text });
  }
}

function getPendingToolCalls(state: CodexStreamState): Map<string, PendingToolCall> {
  if (!state.pendingToolCalls) state.pendingToolCalls = new Map();
  return state.pendingToolCalls;
}

function rememberModel(state: CodexStreamState, record: JsonRecord | undefined): void {
  if (!record) return;
  const model = getNonEmptyString(record.model);
  if (model) state.model = model;
}

function parseTurnCompletedUsage(
  record: JsonRecord,
  fallbackModel: string | undefined
): ParsedTurnUsage | undefined {
  const usage = getNestedRecord(record, "usage");
  if (!usage) return undefined;
  return buildParsedTurnUsage("turn.completed", usage, fallbackModel);
}

function parseTokenCountUsage(
  payload: JsonRecord,
  fallbackModel: string | undefined
): ParsedTurnUsage | undefined {
  const info = getNestedRecord(payload, "info");
  if (!info) return undefined;
  const usage = getNestedRecord(info, "last_token_usage") ?? (hasUsageFields(info) ? info : undefined);
  if (!usage) return undefined;
  return buildParsedTurnUsage(
    "token_count",
    usage,
    fallbackModel,
    toPositiveIntOrUndefined(info.model_context_window),
  );
}

function buildParsedTurnUsage(
  source: UsageSource,
  usage: JsonRecord,
  fallbackModel: string | undefined,
  contextWindowTokens?: number
): ParsedTurnUsage | undefined {
  const inputTokens = toInt(usage.input_tokens);
  const cacheReadTokens = toInt(usage.cached_input_tokens);
  const rawOutputTokens = toInt(usage.output_tokens);
  const reasoningTokens = toInt(usage.reasoning_output_tokens);
  if (inputTokens + cacheReadTokens + rawOutputTokens + reasoningTokens === 0) return undefined;
  return {
    kind: "usage",
    source,
    model: getNonEmptyString(usage.model) ?? fallbackModel ?? null,
    inputTokens,
    outputTokens:
      reasoningTokens > 0 ? Math.max(0, rawOutputTokens - reasoningTokens) : rawOutputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    rawUsage: stripUndefined({
      input_tokens: inputTokens,
      cached_input_tokens: cacheReadTokens,
      output_tokens: rawOutputTokens,
      ...(reasoningTokens > 0 ? { reasoning_output_tokens: reasoningTokens } : {}),
      ...(getNonEmptyString(usage.model) ?? fallbackModel
        ? { model: getNonEmptyString(usage.model) ?? fallbackModel }
        : {}),
    }),
    rawOutputTokens,
  };
}

// Returns the usage event to emit right now, if the incoming record forced
// us to close out an earlier pending turn. Otherwise the pending turn is
// still being filled in (coarse + rich merge) and the caller emits nothing.
function appendUsage(
  state: CodexStreamState,
  usage: ParsedTurnUsage
): UsageEvent | undefined {
  const pending = state.pendingTurnUsage;
  if (!pending) {
    state.pendingTurnUsage =
      usage.source === "token_count" ? { rich: usage } : { coarse: usage };
    return undefined;
  }

  if (usage.source === "token_count") {
    if (pending.rich && isSameTurnUsage(pending.rich, usage)) {
      return undefined;
    }
    if (pending.coarse && isSameTurn(pending.coarse, usage)) {
      pending.rich = usage;
      return undefined;
    }
    const committed = commitPendingUsage(state);
    state.pendingTurnUsage = { rich: usage };
    return committed;
  }

  if (pending.rich && isSameTurn(pending.rich, usage)) {
    pending.coarse = usage;
    return undefined;
  }
  if (pending.coarse && isSameTurnUsage(pending.coarse, usage)) {
    return undefined;
  }
  const committed = commitPendingUsage(state);
  state.pendingTurnUsage = { coarse: usage };
  return committed;
}

function isSameTurnUsage(a: ParsedTurnUsage, b: ParsedTurnUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.rawOutputTokens === b.rawOutputTokens &&
    a.reasoningTokens === b.reasoningTokens
  );
}

function isSameTurn(a: ParsedTurnUsage, b: ParsedTurnUsage): boolean {
  return (
    a.rawOutputTokens === b.rawOutputTokens &&
    fieldsCompatible(a.inputTokens, b.inputTokens) &&
    fieldsCompatible(a.cacheReadTokens, b.cacheReadTokens)
  );
}

function fieldsCompatible(a: number, b: number): boolean {
  return a === b || a === 0 || b === 0;
}

function commitPendingUsage(state: CodexStreamState): UsageEvent | undefined {
  const chosen = mergePendingTurnUsage(state.pendingTurnUsage);
  delete state.pendingTurnUsage;
  if (!chosen) return undefined;
  return {
    kind: "usage",
    model: chosen.model,
    inputTokens: chosen.inputTokens,
    outputTokens: chosen.outputTokens,
    cacheReadTokens: chosen.cacheReadTokens,
    cacheWriteTokens: chosen.cacheWriteTokens,
    reasoningTokens: chosen.reasoningTokens,
    ...(chosen.contextWindowTokens ? { contextWindowTokens: chosen.contextWindowTokens } : {}),
    rawUsage: chosen.rawUsage,
  };
}

function mergePendingTurnUsage(
  pending: PendingTurnUsage | undefined
): ParsedTurnUsage | undefined {
  const coarse = pending?.coarse;
  const rich = pending?.rich;
  const chosen = rich ?? coarse;
  if (!chosen) return undefined;

  const inputTokens = Math.max(coarse?.inputTokens ?? 0, rich?.inputTokens ?? 0);
  const cacheReadTokens = Math.max(coarse?.cacheReadTokens ?? 0, rich?.cacheReadTokens ?? 0);
  const rawOutputTokens = Math.max(coarse?.rawOutputTokens ?? 0, rich?.rawOutputTokens ?? 0);
  const reasoningTokens = rich?.reasoningTokens ?? coarse?.reasoningTokens ?? 0;
  const model = rich?.model ?? coarse?.model ?? null;
  const contextWindowTokens = rich?.contextWindowTokens ?? coarse?.contextWindowTokens ?? null;

  return {
    kind: "usage",
    source: rich ? rich.source : coarse!.source,
    model,
    inputTokens,
    outputTokens:
      reasoningTokens > 0 ? Math.max(0, rawOutputTokens - reasoningTokens) : rawOutputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    reasoningTokens,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    rawUsage: stripUndefined({
      input_tokens: inputTokens,
      cached_input_tokens: cacheReadTokens,
      output_tokens: rawOutputTokens,
      ...(reasoningTokens > 0 ? { reasoning_output_tokens: reasoningTokens } : {}),
      ...(model ? { model } : {}),
    }),
    rawOutputTokens,
  };
}

function toInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function toPositiveIntOrUndefined(value: unknown): number | undefined {
  const int = toInt(value);
  return int > 0 ? int : undefined;
}

function stripUndefined<T extends JsonRecord>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  ) as T;
}
