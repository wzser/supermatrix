import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { BackendKind, EffortLevel } from "../domain/session.ts";
import type {
  CardId,
  LarkGroupId,
  MessageRunId,
  SessionId,
} from "../domain/ids.ts";
import type { RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { CardHeaderTemplate, LarkGateway } from "../ports/LarkGateway.ts";
import {
  classifyRunStatus,
  isTerminalErrorMessage,
  MISSING_TERMINAL_EVIDENCE_ERROR,
  titleSuffixForRunStatus,
} from "./runStatus.ts";
import {
  accumulateUsage,
  normalizeCumulativeUsageEvent,
  type CollectedUsage,
  type UsageWatermark,
} from "./usageCollector.ts";
import { errorMessage } from "./errorMessage.ts";
import type { AutoFileDelivery } from "./autoFileDelivery.ts";
import {
  resolveRunExecutionConfig,
  type RunExecutionConfig,
} from "../ports/RunExecutionConfig.ts";
import { resolveKimiThinkingLevel } from "../ports/KimiModelCatalog.ts";

export type ReplierDeps = {
  lark: LarkGateway;
  clock: Clock;
  monotonic?: () => number;
  reminderSchedule?: number[];
  idFactory?: () => string;
  autoFileDelivery?: AutoFileDelivery;
};

export type ConsumeInput = {
  groupId: LarkGroupId;
  sessionId: SessionId;
  runId: MessageRunId;
  sessionName: string;
  branchName?: string;
  sessionModel: string | null;
  sessionEffort?: EffortLevel | null;
  execution?: RunExecutionConfig;
  getExecutionConfig?: () => RunExecutionConfig;
  sessionBackend: BackendKind;
  usageBaseline?: UsageWatermark | null;
  runStartedAtMs?: number;
  /**
   * Set when this run's built-in AskUserQuestion tool is routed to a real
   * Feishu card (kimi backend + card-ask gate on + broker healthy). The
   * legacy plain-text question mirror (maybeSendAskUserQuestion) must then
   * stay silent, or the user sees every question twice (card + text).
   */
  askUserQuestionCardRouted?: boolean;
  /**
   * Completed-card header override (e.g. "violet" for kimi autonomous turns
   * so they stand out from ordinary conversation runs). Forwarded to the
   * gateway, which applies it only to the green completed state.
   */
  completedTemplate?: CardHeaderTemplate;
  stream: AsyncIterable<AgentEvent>;
};

export type StreamLogEntry =
  | { ts: number; kind: "thinking"; text: string }
  | { ts: number; kind: "tool_call"; name: string; args: unknown; callId?: string; command?: string }
  | { ts: number; kind: "tool_result"; name: string; result: unknown; callId?: string; command?: string }
  | { ts: number; kind: "assistant_message"; text: string; final: boolean }
  | { ts: number; kind: "error"; text: string };

export type ConsumeResult = {
  finalMessage: string;
  cardId: CardId;
  error?: string;
  runStatus: RunStatus;
  backendSessionId?: string;
  runtimeModel?: string;
  runtimeThinking?: boolean;
  usage?: CollectedUsage;
  // Stream events in arrival order. Persisted by the dispatcher into
  // message_runs.stream_log so past runs' reply and tool forensics can be
  // recovered without grepping backend rollout files.
  streamLog: StreamLogEntry[];
};

const DEFAULT_SCHEDULE = [60_000, 180_000, 420_000, 900_000, 1_800_000];
const REPEAT_INTERVAL_MS = 1_800_000;

type AskUserQuestionOption = {
  label: string;
  value: string;
  description?: string;
};

type AskUserQuestionTextInput = {
  header?: string;
  question: string;
  options: AskUserQuestionOption[];
};

export function createReplier(deps: ReplierDeps) {
  const schedule = deps.reminderSchedule ?? DEFAULT_SCHEDULE;
  const monotonic = deps.monotonic ?? (() => Date.now());

  async function consume(input: ConsumeInput): Promise<ConsumeResult> {
    let runtimeModel: string | undefined;
    const initialExecution = input.execution ?? resolveRunExecutionConfig({
      backend: input.sessionBackend,
      model: input.sessionModel,
      effort: input.sessionEffort ?? null,
    });
    const buildTitle = (suffix: string, currentUsage?: CollectedUsage) => {
      const execution = input.getExecutionConfig?.() ?? initialExecution;
      const modelId = currentUsage?.model ?? runtimeModel ?? input.sessionModel;
      const modelDisplay = formatModel(modelId, input.sessionBackend);
      const effortDisplay = formatExecutionEffort(
        execution,
        runtimeModel,
      );
      const displaySessionName = input.branchName
        ? `${input.sessionName}@${input.branchName}`
        : input.sessionName;
      const base = `${displaySessionName} | ${modelDisplay} · ${suffix}`;
      return `${base} | ${effortDisplay} | ${input.runId}`;
    };

    const cardId = await deps.lark.postCard(input.groupId, "⌛ 正在处理…", buildTitle("running"));
    const startedAt = monotonic();
    const bodyLines: string[] = [];
    // Non-final assistant messages are process trace. The final card body is
    // driven by final assistant_message/completed events; non-final text is
    // only a fallback when a backend never emits a final event.
    const assistantTexts: string[] = [];
    const assistantFinalText = (terminalText: string) => {
      const joined = joinVisibleAssistantTexts(assistantTexts);
      if (input.sessionBackend === "claude" && joined) return joined;
      return terminalText;
    };
    const streamLog: StreamLogEntry[] = [];
    let finalMessage = "";
    let error: string | undefined;
    // Set once the backend has streamed a non-empty final assistant_message
    // or a `completed` receipt — i.e. the real response is already in hand.
    // A silently cut stream must not become a zero-byte completed run. A
    // later *non-terminal* `error` event / stream throw is treated as
    // post-delivery noise (claude CLI exit 1 with empty stderr after final
    // result, codex "Reconnecting... 5/5" after the full response streamed,
    // etc.) and must not flip the card to "failed". Terminal errors
    // ([TIMEOUT] / cancelled by user) are kill signals and must override
    // the prior completion — otherwise the card title stays "done" while
    // the body shows "❌ [TIMEOUT] …", which is exactly the
    // watchdog-reported divergence this branch exists to fix.
    let completedCleanly = false;
    let backendSessionId: string | undefined;
    let runtimeThinking: boolean | undefined;
    let usage: CollectedUsage | undefined;
    let usageWatermark = input.usageBaseline ?? null;
    let reminderIdx = 0;
    let lastReminderLine: string | undefined;

    const render = () => bodyLines.join("\n");

    async function updateCard() {
      const combined = lastReminderLine ? render() + "\n" + lastReminderLine : render();
      await deps.lark.updateCard(cardId, combined || "⌛ 正在处理…", buildTitle("running", usage));
    }

    function checkReminder() {
      const elapsed = monotonic() - startedAt;
      while (reminderIdx < schedule.length && schedule[reminderIdx] <= elapsed) {
        reminderIdx += 1;
        lastReminderLine = `⏱ 已运行 ${Math.round(elapsed / 1000)}s，最近活动：${bodyLines.at(-1) ?? ""}`;
      }
      if (reminderIdx >= schedule.length && schedule.length > 0) {
        const lastScheduled = schedule[schedule.length - 1];
        if (elapsed > lastScheduled) {
          const extrasFired = Math.floor((elapsed - lastScheduled) / REPEAT_INTERVAL_MS);
          const total = schedule.length + Math.max(0, extrasFired);
          if (total > reminderIdx) {
            reminderIdx = total;
            lastReminderLine = `⏱ 已运行 ${Math.round(elapsed / 1000)}s，最近活动：${bodyLines.at(-1) ?? ""}`;
          }
        }
      }
    }

    try {
      for await (const event of input.stream) {
        checkReminder();
        switch (event.kind) {
          case "started":
            backendSessionId = event.backendSessionId;
            if (event.model) {
              runtimeModel = event.model;
            }
            if (event.thinking !== undefined) runtimeThinking = event.thinking;
            bodyLines.push(`🔗 session 启动 (${event.backendSessionId})`);
            break;
          case "thinking":
            bodyLines.push(`💭 ${truncate(event.text, 120)}`);
            streamLog.push({ ts: deps.clock.now(), kind: "thinking", text: event.text });
            break;
          case "tool_call":
            bodyLines.push(formatToolLine("🔧", event));
            {
              const entry: StreamLogEntry = {
                ts: deps.clock.now(),
                kind: "tool_call",
                name: event.name,
                args: event.args,
              };
              if (event.callId) entry.callId = event.callId;
              if (event.command) entry.command = event.command;
              streamLog.push(entry);
            }
            await maybeSendAskUserQuestion(deps.lark, input, event);
            break;
          case "tool_result":
            bodyLines.push(formatToolLine("✅", event));
            {
              const entry: StreamLogEntry = {
                ts: deps.clock.now(),
                kind: "tool_result",
                name: event.name,
                result: event.result,
              };
              if (event.callId) entry.callId = event.callId;
              if (event.command) entry.command = event.command;
              streamLog.push(entry);
            }
            break;
          case "assistant_message":
            bodyLines.push(`💬 ${truncate(event.text, 240)}`);
            assistantTexts.push(event.text);
            streamLog.push({
              ts: deps.clock.now(),
              kind: "assistant_message",
              text: event.text,
              final: event.final,
            });
            if (event.final) {
              finalMessage = assistantFinalText(event.text);
              completedCleanly = finalMessage.trim().length > 0;
              // Drop any non-terminal error accumulated earlier in the
              // stream — once the model delivers a final answer, prior
              // recoverable noise (e.g. codex "Reconnecting... N/5") is
              // resolved by definition. Terminal errors ([TIMEOUT] /
              // cancelled by user) keep their override semantics.
              if (completedCleanly && error && !isTerminalErrorMessage(error)) {
                error = undefined;
              }
            }
            break;
          case "error":
            bodyLines.push(`❌ ${event.message}`);
            streamLog.push({ ts: deps.clock.now(), kind: "error", text: event.message });
            // First non-terminal error wins — aligned with collectStream, so a
            // later downstream error (e.g. codex_models_manager child-exit noise
            // after a real "at capacity" cause) cannot mask the root cause.
            // Terminal errors ([TIMEOUT] / cancelled by user) always override.
            if (isTerminalErrorMessage(event.message)) {
              error = event.message;
            } else if (!completedCleanly && error === undefined) {
              error = event.message;
            }
            break;
          case "completed":
            if (event.finalMessage.trim()) {
              finalMessage = assistantFinalText(event.finalMessage);
            }
            completedCleanly = true;
            break;
          case "usage":
            if (input.sessionBackend === "codex" && input.usageBaseline) {
              const normalized = normalizeCumulativeUsageEvent(event, usageWatermark);
              usageWatermark = normalized.nextWatermark;
              usage = accumulateUsage(usage, normalized.event);
            } else {
              usage = accumulateUsage(usage, event);
            }
            if (usage.model) runtimeModel = usage.model;
            break;
        }
        await updateCard();
      }
    } catch (err) {
      // Same guard as the `error` event: terminal errors override, others
      // stay gated on completedCleanly AND first-error-wins.
      const message = errorMessage(err);
      streamLog.push({ ts: deps.clock.now(), kind: "error", text: message });
      if (isTerminalErrorMessage(message)) {
        error = message;
      } else if (!completedCleanly && error === undefined) {
        error = message;
      }
    }

    if (!error && !completedCleanly) {
      error = MISSING_TERMINAL_EVIDENCE_ERROR;
      streamLog.push({ ts: deps.clock.now(), kind: "error", text: error });
    }

    const runStatus = classifyRunStatus(error);
    const assistantFallback = joinVisibleAssistantTexts(assistantTexts);
    // A final assistant answer always wins. Absent one, a live error beats
    // non-final model commentary: otherwise a failed run's card body shows
    // stale narration (e.g. the codex "正在自动重试一次…" notice) instead of the
    // actual error. Only when there is no error does genuine commentary serve
    // as the fallback body.
    const finalText =
      finalMessage
      || (error ? `❌ ${error}` : assistantFallback)
      || "(no content)";
    const finalSuffix = titleSuffixForRunStatus(runStatus);
    const processLog = renderProcessLog(backendSessionId, streamLog);
    await deps.lark.finalizeCard(
      cardId,
      finalText,
      buildTitle(finalSuffix, usage),
      processLog.length > 0 ? processLog : undefined,
      runStatus,
      input.completedTemplate,
    );
    if (deps.autoFileDelivery) {
      try {
        await deps.autoFileDelivery.deliver({
          groupId: input.groupId,
          sessionName: input.sessionName,
          runId: input.runId,
          finalMessage: finalText,
          ...(input.runStartedAtMs !== undefined ? { runStartedAtMs: input.runStartedAtMs } : {}),
        });
      } catch {
        // Auto delivery is best-effort and must not change the run result.
      }
    }
    return {
      finalMessage: finalText,
      cardId,
      runStatus,
      streamLog,
      ...(error ? { error } : {}),
      ...(backendSessionId ? { backendSessionId } : {}),
      ...(runtimeModel ? { runtimeModel } : {}),
      ...(runtimeThinking !== undefined ? { runtimeThinking } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  return { consume };
}

async function maybeSendAskUserQuestion(
  lark: LarkGateway,
  input: ConsumeInput,
  event: Extract<AgentEvent, { kind: "tool_call" }>,
): Promise<void> {
  if (!isAskUserQuestionTool(event.name)) return;
  // The question already reached the user as an interactive card via the
  // card-ask broker (kimi built-in AskUserQuestion routing) — mirroring it
  // again as plain text would show every question twice.
  if (input.askUserQuestionCardRouted) return;
  const question = parseAskUserQuestionArgs(event.args);
  if (!question) return;

  const textInput: AskUserQuestionTextInput = {
    question: question.question,
    options: question.options,
  };
  if (question.header) textInput.header = question.header;

  await lark.sendMessage(input.groupId, formatAskUserQuestionText(textInput));
}

function isAskUserQuestionTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return normalized === "askuserquestion"
    || normalized === "askuser"
    || normalized === "requestuserinput";
}

function parseAskUserQuestionArgs(args: unknown): {
  header?: string;
  question: string;
  options: AskUserQuestionOption[];
} | null {
  const root = asRecord(args);
  if (!root) return null;
  const firstQuestion = Array.isArray(root.questions)
    ? asRecord(root.questions[0])
    : root;
  if (!firstQuestion) return null;
  const question = pickString(firstQuestion, "question")
    ?? pickString(firstQuestion, "prompt")
    ?? pickString(firstQuestion, "text");
  if (!question) return null;

  const parsed = {
    question,
    options: parseAskUserOptions(firstQuestion.options),
  };
  const header = pickString(firstQuestion, "header") ?? pickString(firstQuestion, "title");
  return {
    ...parsed,
    ...(header ? { header } : {}),
  };
}

function parseAskUserOptions(options: unknown): AskUserQuestionOption[] {
  if (!Array.isArray(options)) return [];
  const parsed: AskUserQuestionOption[] = [];
  for (const option of options) {
    if (typeof option === "string" && option.trim().length > 0) {
      parsed.push({ label: option.trim(), value: option.trim() });
      continue;
    }
    const record = asRecord(option);
    if (!record) continue;
    const label = pickString(record, "label")
      ?? pickString(record, "text")
      ?? pickString(record, "title")
      ?? pickString(record, "name");
    if (!label) continue;
    const value = pickString(record, "value") ?? label;
    const description = pickString(record, "description");
    parsed.push({
      label,
      value,
      ...(description ? { description } : {}),
    });
  }
  return parsed;
}

function formatAskUserQuestionText(input: AskUserQuestionTextInput): string {
  const lines = [
    ...(input.header ? [input.header] : []),
    input.question,
  ];
  if (input.options.length > 0) {
    lines.push(
      "",
      ...input.options.map((option, index) => {
        const suffix = option.description ? ` - ${option.description}` : "";
        return `${index + 1}. ${option.label}${suffix}`;
      }),
    );
  }
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function joinVisibleAssistantTexts(texts: string[]): string {
  return texts.filter((text) => text.trim().length > 0).join("\n\n");
}

function renderProcessLog(
  backendSessionId: string | undefined,
  entries: StreamLogEntry[],
): string {
  const lines: string[] = [];
  if (backendSessionId) {
    lines.push(`🔗 session 启动 (${backendSessionId})`);
  }

  let toolCallCount = 0;
  let toolResultCount = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "thinking":
        lines.push(`💭 ${entry.text}`);
        break;
      case "assistant_message":
        lines.push(`💬 ${entry.text}`);
        break;
      case "error":
        lines.push(`❌ ${entry.text}`);
        break;
      case "tool_call":
        toolCallCount += 1;
        break;
      case "tool_result":
        toolResultCount += 1;
        break;
    }
  }

  if (toolCallCount > 0 || toolResultCount > 0) {
    lines.push(
      `🧰 已隐藏 ${toolCallCount} 次工具调用和 ${toolResultCount} 次工具结果；完整记录见 DB message_runs`,
    );
  }
  return lines.join("\n");
}

function formatToolLine(
  icon: "🔧" | "✅",
  event: Extract<AgentEvent, { kind: "tool_call" | "tool_result" }>,
): string {
  const detail =
    event.command
    ?? summarizeToolPayload(event.kind === "tool_call" ? event.args : event.result);
  const label = detail ? `${event.name}: ${detail}` : event.name;
  return truncate(`${icon} ${label}`, 150);
}

function summarizeToolPayload(payload: unknown): string | undefined {
  if (typeof payload === "string") return compact(payload);
  if (typeof payload === "number" || typeof payload === "boolean") return String(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  const record = payload as Record<string, unknown>;
  for (const key of ["cmd", "command", "query", "q", "path", "file", "url", "output", "status"]) {
    const value = summarizeScalar(record[key]);
    if (value) return `${key}=${value}`;
  }
  for (const [key, value] of Object.entries(record)) {
    const summary = summarizeScalar(value);
    if (summary) return `${key}=${summary}`;
  }
  return undefined;
}

function summarizeScalar(value: unknown): string | undefined {
  if (typeof value === "string") return compact(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function compact(text: string): string | undefined {
  const singleLine = text.replace(/\s+/gu, " ").trim();
  return singleLine || undefined;
}

const MODEL_DISPLAY_MAP: Record<string, string> = {
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  opus: "Opus 5",
  sonnet: "Sonnet 5",
  haiku: "Haiku 4.5",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5-codex": "GPT-5 Codex",
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
  "codex-mini-latest": "Codex Mini",
  "kimi-code/kimi-for-coding": "K2.7 Coding",
  "kimi-code/kimi-for-coding-highspeed": "K2.7 Highspeed",
  "kimi-code/k3": "K3",
  "kimi-code/k3-256k": "K3 256K",
};

// Only models whose context window has been confirmed appear here.
// Unknown models => formatContextUsage returns null rather than fabricating a
// denominator.
// Codex runtime-reported `model_context_window` wins when present; these
// entries are fallback denominators for usage streams that lack that field.
const MODEL_CONTEXT_LIMIT: Record<BackendKind, Record<string, number>> = {
  claude: {
    "claude-opus-5": 1_000_000,
    "claude-sonnet-5": 1_000_000,
    "claude-opus-4-8": 200_000,
    "claude-opus-4-7": 1_000_000,
    "claude-opus-4-6": 1_000_000,
    "claude-sonnet-4-6": 1_000_000,
    "claude-haiku-4-5-20251001": 200_000,
    "claude-haiku-4-5": 200_000,
    opus: 1_000_000,
    sonnet: 1_000_000,
    haiku: 200_000,
  },
  codex: {
    "gpt-5.5": 272_000,
    "gpt-5.4": 272_000,
    "gpt-5.4-mini": 272_000,
    "gpt-5.3-codex": 272_000,
    "gpt-5.3-codex-spark": 128_000,
    "gpt-5.2": 272_000,
    "gpt-5.2-codex": 272_000,
    "gpt-5-codex": 272_000,
    "gpt-5.1-codex-max": 272_000,
    "gpt-5.1-codex-mini": 272_000,
  },
  // ACP 协议不承载 usage 通知，eventTranslator 不发 usage 事件，所以这些
  // denominator 目前不会被渲染（usage undefined → formatContextUsage 返回
  // null）。k3-256k 的 262144 已确认；其余仍按 kimi-code config.toml 的
  // max_context_size 预填，上游一旦补出 usage 通知即自动生效。
  kimi: {
    "kimi-code/kimi-for-coding": 262_144,
    "kimi-code/kimi-for-coding-highspeed": 262_144,
    "kimi-code/k3": 1_048_576,
    "kimi-code/k3-256k": 262_144,
  },
};

// Numerator counts only tokens occupying context (input + both cache halves);
// outputTokens / reasoningTokens describe the response side and are excluded.
export function formatContextUsage(
  usage: CollectedUsage | undefined,
  model: string | null,
  _backend: BackendKind,
): string | null {
  if (!usage) return null;
  const stripped = model?.replace(/\[[^\]]*\]$/, "");
  const limit =
    usage.latestContextWindowTokens ??
    (stripped ? MODEL_CONTEXT_LIMIT[_backend][stripped] : undefined);
  if (limit === undefined) return null;
  const used =
    usage.latestInputTokens + usage.latestCacheReadTokens + usage.latestCacheWriteTokens;
  const usedK = Math.round(used / 100) / 10;
  const limitK = Math.round(limit / 1000);
  return `${usedK}k/${limitK}k`;
}

export function formatModel(model: string | null, backend: BackendKind): string {
  if (model) {
    const stripped = model.replace(/\[[^\]]*\]$/, "");
    const explicit = MODEL_DISPLAY_MAP[stripped];
    if (explicit) return explicit;
    const m = stripped.match(/(?:claude[-_])?(\w+)[-_](\d+)[-_](\d+)/i);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + "." + m[3];
    return stripped;
  }
  if (backend === "codex") return "Codex";
  if (backend === "kimi") return "Kimi";
  return "Claude";
}

function formatExecutionEffort(
  execution: RunExecutionConfig,
  runtimeModel?: string,
): string {
  // Kimi K3 effort resolves to a native level in the execution config when
  // the model is concrete (default → high), so the title can show it
  // directly. A model-null kimi execution carries the raw requested effort
  // through for the backend; the title then resolves against the runtime
  // model reported by the backend's started event — showing the actual
  // LOW/HIGH/MAX once K3 is known, but DEFAULT for an unknown model or K2.7
  // (fixed-on) so the card never advertises a level the run cannot apply.
  if (execution.backend === "kimi") {
    const capabilityModel = execution.model ?? runtimeModel;
    if (!capabilityModel) return "DEFAULT";
    let level: string | null;
    try {
      level = resolveKimiThinkingLevel(capabilityModel, execution.effort);
    } catch {
      // Unmappable token (e.g. claude-only ultracode leaking through legacy
      // data) — never fabricate a level on the card.
      return "DEFAULT";
    }
    return level ? level.toUpperCase() : "DEFAULT";
  }
  return (execution.effort ?? "default").toUpperCase();
}
