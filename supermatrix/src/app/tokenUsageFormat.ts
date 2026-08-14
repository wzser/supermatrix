import type {
  TokenUsageSummary,
  TokenUsageWindow,
  TokenUsageWindowCutoffs,
} from "../ports/BindingStore.ts";
import { asTimestamp, type Timestamp } from "../domain/ids.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Local midnight (00:00 in the machine's timezone) expressed as epoch ms,
// matching the tz the user sees. /status and /list say "今日" relative to
// wall-clock today, not UTC today.
export function computeWindowCutoffs(now: number): TokenUsageWindowCutoffs {
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return {
    todayStart: asTimestamp(todayStart),
    weekStart: asTimestamp(now - 7 * MS_PER_DAY),
  };
}

// Fixed-unit formatters for the /tokens table.
// Today column uses millions (百万); weekly and cumulative use 亿 (100M).
export function formatM(n: number): string {
  return (n / 1_000_000).toFixed(2);
}

export function formatYi(n: number): string {
  return (n / 100_000_000).toFixed(4);
}

// Render "12.3k" / "1.2M" / plain number. Keeps table widths short.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return v >= 10 ? `${Math.round(v)}k` : `${v.toFixed(1)}k`;
  }
  const v = n / 1_000_000;
  return v >= 10 ? `${Math.round(v)}M` : `${v.toFixed(2)}M`;
}

// Single window → "in/out (+cache_read, +reasoning)" compact form.
// Omits zero tails. cache_write and row counts are hidden to keep it tight.
export function formatWindow(w: TokenUsageWindow): string {
  if (w.rowCount === 0) return "0";
  const main = `${formatTokens(w.inputTokens)}/${formatTokens(w.outputTokens)}`;
  const extras: string[] = [];
  if (w.cacheReadTokens > 0) extras.push(`+${formatTokens(w.cacheReadTokens)}c`);
  if (w.reasoningTokens > 0) extras.push(`+${formatTokens(w.reasoningTokens)}r`);
  return extras.length > 0 ? `${main} ${extras.join(" ")}` : main;
}

// Three-window inline summary, e.g. "今日 1.2k/500  7日 8.3k/4.1k  累计 102k/45k"
export function formatSummary(summary: TokenUsageSummary): string {
  return [
    `今日 ${formatWindow(summary.today)}`,
    `7日 ${formatWindow(summary.last7Days)}`,
    `累计 ${formatWindow(summary.cumulative)}`,
  ].join("  ");
}

function sumWindow(windows: TokenUsageWindow[]): TokenUsageWindow {
  const acc: TokenUsageWindow = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    rowCount: 0,
  };
  for (const w of windows) {
    acc.inputTokens += w.inputTokens;
    acc.outputTokens += w.outputTokens;
    acc.cacheReadTokens += w.cacheReadTokens;
    acc.cacheWriteTokens += w.cacheWriteTokens;
    acc.reasoningTokens += w.reasoningTokens;
    acc.rowCount += w.rowCount;
  }
  return acc;
}

// Merge per-session summaries into a single "totals" summary. Each window is
// summed independently — today+today, last7+last7, cumulative+cumulative.
export function aggregateSummaries(summaries: TokenUsageSummary[]): TokenUsageSummary {
  return {
    today: sumWindow(summaries.map((s) => s.today)),
    last7Days: sumWindow(summaries.map((s) => s.last7Days)),
    cumulative: sumWindow(summaries.map((s) => s.cumulative)),
  };
}

export { type Timestamp };
