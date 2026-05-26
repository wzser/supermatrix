import { describe, expect, test } from "vitest";
import {
  accumulateUsage,
  normalizeCumulativeUsageEvent,
} from "../../src/app/usageCollector.ts";
import { formatContextUsage } from "../../src/app/replier.ts";

const baseEvent = {
  kind: "usage" as const,
  model: "m",
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  reasoningTokens: 5,
  rawUsage: { x: 1 },
};

describe("accumulateUsage", () => {
  test("seeds fields from the first event", () => {
    const got = accumulateUsage(undefined, baseEvent);
    expect(got.inputTokens).toBe(1);
    expect(got.outputTokens).toBe(2);
    expect(got.cacheReadTokens).toBe(3);
    expect(got.cacheWriteTokens).toBe(4);
    expect(got.reasoningTokens).toBe(5);
    expect(got.latestInputTokens).toBe(1);
    expect(got.latestCacheReadTokens).toBe(3);
    expect(got.latestCacheWriteTokens).toBe(4);
    expect(got.latestContextWindowTokens).toBeNull();
    expect(got.model).toBe("m");
    expect(got.rawUsageJson).toBe('{"x":1}');
  });

  test("sums token fields across multiple events (Codex multi-turn case)", () => {
    const a = accumulateUsage(undefined, baseEvent);
    const b = accumulateUsage(a, { ...baseEvent, inputTokens: 10, outputTokens: 20 });
    expect(b.inputTokens).toBe(11);
    expect(b.outputTokens).toBe(22);
  });

  test("keeps cumulative sums while latest context fields track the final event", () => {
    const a = accumulateUsage(undefined, {
      ...baseEvent,
      inputTokens: 100,
      cacheReadTokens: 10,
      cacheWriteTokens: 1,
      contextWindowTokens: 258_400,
    });
    const b = accumulateUsage(a, {
      ...baseEvent,
      inputTokens: 200,
      cacheReadTokens: 20,
      cacheWriteTokens: 2,
      contextWindowTokens: 272_000,
    });
    const c = accumulateUsage(b, {
      ...baseEvent,
      inputTokens: 300,
      cacheReadTokens: 30,
      cacheWriteTokens: 3,
    });

    expect(c.inputTokens).toBe(600);
    expect(c.cacheReadTokens).toBe(60);
    expect(c.cacheWriteTokens).toBe(6);
    expect(c.latestInputTokens).toBe(300);
    expect(c.latestCacheReadTokens).toBe(30);
    expect(c.latestCacheWriteTokens).toBe(3);
    expect(c.latestContextWindowTokens).toBe(272_000);
  });

  test("latest non-null model wins", () => {
    const a = accumulateUsage(undefined, { ...baseEvent, model: null });
    const b = accumulateUsage(a, { ...baseEvent, model: "m2" });
    expect(b.model).toBe("m2");
  });

  test("unserializable rawUsage falls back gracefully", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const got = accumulateUsage(undefined, { ...baseEvent, rawUsage: cyclic });
    expect(got.rawUsageJson).toBeNull();
  });

  // Repro for watchdog issue f023723e (run mr_452cff5f, sess bresson):
  // codex's cacheWriteTokens went from 38_336 (baseline) → 0 (current event)
  // mid-run as the cache turned over. The old all-or-nothing canSubtract
  // gate saw current.cacheWriteTokens < previous.cacheWriteTokens and
  // skipped normalization entirely, so accumulateUsage absorbed the raw
  // 15M+ cumulative input/cache and formatContextUsage rendered
  // "15295.8k/272k" against a 272k window — the exact divergence reported.
  // Per-field clamp: regressed fields → delta 0; other fields normalize
  // normally so the rest of the row stays usable.
  test("normalizes per-field even when one cumulative counter regresses", () => {
    const baseline = {
      inputTokens: 15_200_000,
      outputTokens: 50_000,
      cacheReadTokens: 14_500_000,
      cacheWriteTokens: 38_336,
      reasoningTokens: 0,
    };
    const event = {
      kind: "usage" as const,
      model: "gpt-5.5",
      inputTokens: 15_300_000,
      outputTokens: 50_500,
      cacheReadTokens: 14_580_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      rawUsage: null,
    };

    const normalized = normalizeCumulativeUsageEvent(event, baseline);
    expect(normalized.event.inputTokens).toBe(100_000);
    expect(normalized.event.outputTokens).toBe(500);
    expect(normalized.event.cacheReadTokens).toBe(80_000);
    // Regressed field clamps to 0 so it does not pollute the title.
    expect(normalized.event.cacheWriteTokens).toBe(0);
    expect(normalized.nextWatermark).toEqual({
      inputTokens: 15_300_000,
      outputTokens: 50_500,
      cacheReadTokens: 14_580_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });

    const collected = accumulateUsage(undefined, normalized.event);
    const formatted = formatContextUsage(collected, "gpt-5.5", "codex");
    // Normalized used = 100k + 80k + 0 = 180k → "180k/272k", well within
    // the 272k window (the bug rendered "15295.8k/272k").
    expect(formatted).toBe("180k/272k");
  });

  test("normalizes resumed Codex cumulative counters against the previous watermark", () => {
    const baseline = {
      inputTokens: 24_255_780,
      outputTokens: 69_736,
      cacheReadTokens: 23_092_608,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const event = {
      kind: "usage" as const,
      model: "gpt-5.5",
      inputTokens: 24_329_459,
      outputTokens: 70_367,
      cacheReadTokens: 23_105_664,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      rawUsage: {
        input_tokens: 24_329_459,
        cached_input_tokens: 23_105_664,
        output_tokens: 70_367,
      },
    };

    const normalized = normalizeCumulativeUsageEvent(event, baseline);
    expect(normalized.event.inputTokens).toBe(73_679);
    expect(normalized.event.cacheReadTokens).toBe(13_056);
    expect(normalized.event.outputTokens).toBe(631);
    expect(normalized.nextWatermark).toEqual({
      inputTokens: 24_329_459,
      outputTokens: 70_367,
      cacheReadTokens: 23_105_664,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });

    const collected = accumulateUsage(undefined, normalized.event);
    expect(collected.latestInputTokens + collected.latestCacheReadTokens).toBe(86_735);
  });
});
