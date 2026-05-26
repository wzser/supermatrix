import type { AgentEvent } from "../domain/events/agentEvent.ts";

export type CollectedUsage = {
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  latestInputTokens: number;
  latestCacheReadTokens: number;
  latestCacheWriteTokens: number;
  latestContextWindowTokens: number | null;
  rawUsageJson: string | null;
};

type UsageEvent = Extract<AgentEvent, { kind: "usage" }>;

export type UsageWatermark = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

// Aggregates multiple usage events within a single message_run.
// Codex may emit several turn.completed events per run; Claude emits once.
// Cumulative values accumulate by sum for billing/storage; latest values
// preserve the most recent context snapshot for card display.
// model takes the latest non-null value.
// rawUsageJson preserves the last event's native usage for forensics.
export function accumulateUsage(
  prev: CollectedUsage | undefined,
  event: UsageEvent
): CollectedUsage {
  const base: CollectedUsage = prev ?? {
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    latestInputTokens: 0,
    latestCacheReadTokens: 0,
    latestCacheWriteTokens: 0,
    latestContextWindowTokens: null,
    rawUsageJson: null,
  };
  let serialized: string | null;
  try {
    serialized = event.rawUsage === undefined ? null : JSON.stringify(event.rawUsage);
  } catch {
    serialized = null;
  }
  return {
    model: event.model ?? base.model,
    inputTokens: base.inputTokens + event.inputTokens,
    outputTokens: base.outputTokens + event.outputTokens,
    cacheReadTokens: base.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + event.cacheWriteTokens,
    reasoningTokens: base.reasoningTokens + event.reasoningTokens,
    latestInputTokens: event.inputTokens,
    latestCacheReadTokens: event.cacheReadTokens,
    latestCacheWriteTokens: event.cacheWriteTokens,
    latestContextWindowTokens: event.contextWindowTokens ?? base.latestContextWindowTokens,
    rawUsageJson: serialized ?? base.rawUsageJson,
  };
}

// Codex's per-turn cumulative counters can regress on individual fields
// (notably cacheWriteTokens after a cache turnover; cacheReadTokens after
// the cache resets). The previous all-or-nothing gate fell back to the raw
// cumulative event when any single field went backwards, which made
// formatContextUsage render multi-million-token "X/272k" titles. Clamp
// per field instead: regressed fields contribute 0 for this turn, others
// normalize as usual.
export function normalizeCumulativeUsageEvent(
  event: UsageEvent,
  previous: UsageWatermark | null | undefined,
): { event: UsageEvent; nextWatermark: UsageWatermark } {
  const current = watermarkFromEvent(event);
  if (!previous) {
    return { event, nextWatermark: current };
  }
  return {
    event: {
      ...event,
      inputTokens: clampDelta(current.inputTokens, previous.inputTokens),
      outputTokens: clampDelta(current.outputTokens, previous.outputTokens),
      cacheReadTokens: clampDelta(current.cacheReadTokens, previous.cacheReadTokens),
      cacheWriteTokens: clampDelta(current.cacheWriteTokens, previous.cacheWriteTokens),
      reasoningTokens: clampDelta(current.reasoningTokens, previous.reasoningTokens),
    },
    nextWatermark: current,
  };
}

function watermarkFromEvent(event: UsageEvent): UsageWatermark {
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    reasoningTokens: event.reasoningTokens,
  };
}

function clampDelta(current: number, previous: number): number {
  return Math.max(current - previous, 0);
}
