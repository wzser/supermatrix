import type { AgentEvent } from "../domain/events/agentEvent.ts";
import type { BackendKind } from "../domain/session.ts";
import type {
  CardId,
  LarkGroupId,
  MessageRunId,
  SessionId,
} from "../domain/ids.ts";
import type { RunStatus } from "../ports/BindingStore.ts";
import type { Clock } from "../ports/Clock.ts";
import type { LarkGateway } from "../ports/LarkGateway.ts";
import {
  classifyRunStatus,
  isTerminalErrorMessage,
  titleSuffixForRunStatus,
} from "./runStatus.ts";
import {
  accumulateUsage,
  normalizeCumulativeUsageEvent,
  type CollectedUsage,
  type UsageWatermark,
} from "./usageCollector.ts";
import { errorMessage } from "./errorMessage.ts";

export type ReplierDeps = {
  lark: LarkGateway;
  clock: Clock;
  monotonic?: () => number;
  reminderSchedule?: number[];
  idFactory?: () => string;
};

export type ConsumeInput = {
  groupId: LarkGroupId;
  sessionId: SessionId;
  runId: MessageRunId;
  sessionName: string;
  sessionModel: string | null;
  sessionBackend: BackendKind;
  usageBaseline?: UsageWatermark | null;
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

export function createReplier(deps: ReplierDeps) {
  const schedule = deps.reminderSchedule ?? DEFAULT_SCHEDULE;
  const monotonic = deps.monotonic ?? (() => Date.now());

  async function consume(input: ConsumeInput): Promise<ConsumeResult> {
    let runtimeModel: string | undefined;
    const buildTitle = (suffix: string, currentUsage?: CollectedUsage) => {
      const modelId = currentUsage?.model ?? runtimeModel ?? input.sessionModel;
      const modelDisplay = formatModel(modelId, input.sessionBackend);
      const base = `${input.sessionName} | ${modelDisplay} · ${suffix}`;
      const ctx = formatContextUsage(currentUsage, modelId, input.sessionBackend);
      return ctx ? `${base} | ${ctx}` : base;
    };

    const cardId = await deps.lark.postCard(input.groupId, "⌛ 正在处理…", buildTitle("running"));
    const startedAt = monotonic();
    const bodyLines: string[] = [];
    // Non-final assistant messages are process trace. The final card body is
    // driven by final assistant_message/completed events; non-final text is
    // only a fallback when a backend never emits a final event.
    const assistantTexts: string[] = [];
    const streamLog: StreamLogEntry[] = [];
    let finalMessage = "";
    let error: string | undefined;
    // Set once the backend has streamed a final assistant_message or a
    // `completed` event — i.e. the real response is already in hand. A
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
            bodyLines.push(`🔧 ${event.name}`);
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
            break;
          case "tool_result":
            bodyLines.push(`✅ ${event.name}`);
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
              finalMessage = event.text;
              completedCleanly = true;
              // Drop any non-terminal error accumulated earlier in the
              // stream — once the model delivers a final answer, prior
              // recoverable noise (e.g. codex "Reconnecting... N/5") is
              // resolved by definition. Terminal errors ([TIMEOUT] /
              // cancelled by user) keep their override semantics.
              if (error && !isTerminalErrorMessage(error)) {
                error = undefined;
              }
            }
            break;
          case "error":
            bodyLines.push(`❌ ${event.message}`);
            streamLog.push({ ts: deps.clock.now(), kind: "error", text: event.message });
            if (!completedCleanly || isTerminalErrorMessage(event.message)) {
              error = event.message;
            }
            break;
          case "completed":
            if (event.finalMessage.trim()) finalMessage = event.finalMessage;
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
      // stay gated on completedCleanly.
      const message = errorMessage(err);
      if (!completedCleanly || isTerminalErrorMessage(message)) {
        error = message;
      }
    }

    const runStatus = classifyRunStatus(error);
    const finalText =
      finalMessage
      || (assistantTexts.length > 0 ? assistantTexts.join("\n\n") : "")
      || (error ? `❌ ${error}` : "(no content)");
    const finalSuffix = titleSuffixForRunStatus(runStatus);
    const processLog = render();
    await deps.lark.finalizeCard(
      cardId,
      finalText,
      buildTitle(finalSuffix, usage),
      processLog.length > 0 ? processLog : undefined,
      runStatus,
    );
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

const MODEL_DISPLAY_MAP: Record<string, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  opus: "Opus 4.7",
  sonnet: "Sonnet 4.6",
  haiku: "Haiku 4.5",
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
};

// Only models whose context window has been confirmed appear here.
// Unknown models => formatContextUsage returns null => title drops the
// third segment entirely (preferred over fabricating a denominator).
// Codex runtime-reported `model_context_window` wins when present; these
// entries are fallback denominators for usage streams that lack that field.
const MODEL_CONTEXT_LIMIT: Record<BackendKind, Record<string, number>> = {
  claude: {
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
  // ACP 协议不承载 usage，eventTranslator 不发 usage 事件。
  // 此处保留空记录满足 Record<BackendKind, …> exhaustive；
  // formatContextUsage 走 "未知 limit → 返回 null" 分支自然不渲染 token 段。
  // kimi-cli 上游若补出 usage 通知，回来填具体 model→window 映射即可。
  kimi: {},
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
