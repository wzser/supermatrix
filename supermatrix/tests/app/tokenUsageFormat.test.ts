import { describe, expect, test } from "vitest";
import {
  aggregateSummaries,
  computeWindowCutoffs,
  formatTokens,
  formatWindow,
  formatSummary,
} from "../../src/app/tokenUsageFormat.ts";

describe("formatTokens", () => {
  test("small numbers render as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands use k suffix with fraction below 10k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(9999)).toBe("10.0k");
  });

  test("larger thousands round to integer", () => {
    expect(formatTokens(12345)).toBe("12k");
    expect(formatTokens(999999)).toBe("1000k");
  });

  test("millions use M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(12_500_000)).toBe("13M");
  });
});

describe("formatWindow", () => {
  const base = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    rowCount: 0,
  };

  test("empty window renders as 0", () => {
    expect(formatWindow(base)).toBe("0");
  });

  test("non-empty without cache or reasoning", () => {
    expect(
      formatWindow({ ...base, rowCount: 1, inputTokens: 100, outputTokens: 50 })
    ).toBe("100/50");
  });

  test("includes cache read suffix when present", () => {
    expect(
      formatWindow({
        ...base,
        rowCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 2000,
      })
    ).toBe("100/50 +2.0kc");
  });

  test("includes reasoning when present", () => {
    expect(
      formatWindow({
        ...base,
        rowCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
      })
    ).toBe("100/50 +25r");
  });
});

describe("formatSummary", () => {
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    rowCount: 0,
  };

  test("three windows are labelled today / 7日 / 累计", () => {
    const got = formatSummary({ today: empty, last7Days: empty, cumulative: empty });
    expect(got).toContain("今日");
    expect(got).toContain("7日");
    expect(got).toContain("累计");
  });
});

describe("computeWindowCutoffs", () => {
  test("todayStart is local midnight <= now", () => {
    const now = Date.now();
    const { todayStart, weekStart } = computeWindowCutoffs(now);
    expect(todayStart).toBeLessThanOrEqual(now);
    // within 48h of now (local midnight can be ~24h back at worst)
    expect(now - todayStart).toBeLessThan(48 * 60 * 60 * 1000);
    // weekStart is exactly 7d before now
    expect(now - weekStart).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("aggregateSummaries", () => {
  const empty = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    rowCount: 0,
  };

  test("empty input returns all-zero summary", () => {
    const got = aggregateSummaries([]);
    expect(got.today).toEqual(empty);
    expect(got.last7Days).toEqual(empty);
    expect(got.cumulative).toEqual(empty);
  });

  test("sums every field across sessions per window", () => {
    const a = {
      today: { ...empty, inputTokens: 100, outputTokens: 50, rowCount: 1 },
      last7Days: { ...empty, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, rowCount: 3 },
      cumulative: { ...empty, inputTokens: 10_000, outputTokens: 5_000, reasoningTokens: 300, rowCount: 10 },
    };
    const b = {
      today: { ...empty, inputTokens: 23, outputTokens: 17, cacheWriteTokens: 5, rowCount: 2 },
      last7Days: { ...empty, inputTokens: 234, outputTokens: 100, rowCount: 4 },
      cumulative: { ...empty, inputTokens: 2_000, outputTokens: 1_000, cacheReadTokens: 400, rowCount: 7 },
    };
    const got = aggregateSummaries([a, b]);
    expect(got.today).toEqual({
      inputTokens: 123,
      outputTokens: 67,
      cacheReadTokens: 0,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      rowCount: 3,
    });
    expect(got.last7Days).toEqual({
      inputTokens: 1234,
      outputTokens: 600,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      rowCount: 7,
    });
    expect(got.cumulative).toEqual({
      inputTokens: 12_000,
      outputTokens: 6_000,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 300,
      rowCount: 17,
    });
  });
});
