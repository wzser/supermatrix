import type { CommandHandler } from "../commandRegistry.ts";
import type {
  BindingStore,
  TokenUsageSummary,
  TokenUsageWindow,
} from "../../ports/BindingStore.ts";
import type { BackendKind } from "../../domain/session.ts";
import type { Clock } from "../../ports/Clock.ts";
import {
  aggregateSummaries,
  computeWindowCutoffs,
  formatM,
  formatYi,
} from "../tokenUsageFormat.ts";

export type TokensHandlerDeps = {
  store: BindingStore;
  clock: Clock;
};

const NAME_INDENT = "  ";
const KIND_INDENT = "    ";
const KIND_WIDTH = 6;
const COL_WIDTH = 16;

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function padEndVisual(s: string, width: number): string {
  const w = visualWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

type Kind = "in" | "out" | "all";

type WindowValues = {
  today: number;
  last7Days: number;
  cumulative: number;
};

type StringWindowValues = {
  today: string;
  last7Days: string;
  cumulative: string;
};

type CacheTotals = {
  todayCache: number;
  todayMiss: number;
  weekCache: number;
  weekMiss: number;
  cumulativeCache: number;
  cumulativeMiss: number;
};

function pickValue(w: TokenUsageWindow, kind: Kind): number {
  if (kind === "in") return w.inputTokens;
  if (kind === "out") return w.outputTokens;
  return (
    w.inputTokens +
    w.outputTokens +
    w.cacheReadTokens +
    w.cacheWriteTokens +
    w.reasoningTokens
  );
}

function formatKindRow(kind: Kind, summary: TokenUsageSummary): string {
  return formatNumberRow(kind, {
    today: pickValue(summary.today, kind),
    last7Days: pickValue(summary.last7Days, kind),
    cumulative: pickValue(summary.cumulative, kind),
  });
}

function formatNumberRow(kind: string, values: WindowValues): string {
  return (
    KIND_INDENT +
    padEndVisual(kind, KIND_WIDTH) +
    padEndVisual(formatM(values.today), COL_WIDTH) +
    padEndVisual(formatYi(values.last7Days), COL_WIDTH) +
    formatYi(values.cumulative)
  );
}

function formatStringRow(kind: string, values: StringWindowValues): string {
  return (
    KIND_INDENT +
    padEndVisual(kind, KIND_WIDTH) +
    padEndVisual(values.today, COL_WIDTH) +
    padEndVisual(values.last7Days, COL_WIDTH) +
    values.cumulative
  );
}

function freshInputTokens(backend: BackendKind, window: TokenUsageWindow): number {
  if (backend === "codex") {
    return Math.max(0, window.inputTokens - window.cacheReadTokens);
  }
  return window.inputTokens + window.cacheWriteTokens;
}

function hitPct(cacheReadTokens: number, freshTokens: number): string {
  const denominator = cacheReadTokens + freshTokens;
  if (denominator <= 0) return "—";
  const pct = Math.min(100, Math.max(0, (cacheReadTokens / denominator) * 100));
  return `${pct.toFixed(1)}%`;
}

function cacheRows(backend: BackendKind, summary: TokenUsageSummary): string[] {
  const todayMiss = freshInputTokens(backend, summary.today);
  const weekMiss = freshInputTokens(backend, summary.last7Days);
  const cumulativeMiss = freshInputTokens(backend, summary.cumulative);
  return [
    formatNumberRow("cache", {
      today: summary.today.cacheReadTokens,
      last7Days: summary.last7Days.cacheReadTokens,
      cumulative: summary.cumulative.cacheReadTokens,
    }),
    formatNumberRow("miss", {
      today: todayMiss,
      last7Days: weekMiss,
      cumulative: cumulativeMiss,
    }),
    formatStringRow("hit%", {
      today: hitPct(summary.today.cacheReadTokens, todayMiss),
      last7Days: hitPct(summary.last7Days.cacheReadTokens, weekMiss),
      cumulative: hitPct(summary.cumulative.cacheReadTokens, cumulativeMiss),
    }),
  ];
}

function renderSession(label: string, summary: TokenUsageSummary, backend: BackendKind): string[] {
  return [
    NAME_INDENT + label,
    formatKindRow("in", summary),
    formatKindRow("out", summary),
    formatKindRow("all", summary),
    ...cacheRows(backend, summary),
  ];
}

function addCacheTotals(totals: CacheTotals, backend: BackendKind, summary: TokenUsageSummary): void {
  totals.todayCache += summary.today.cacheReadTokens;
  totals.todayMiss += freshInputTokens(backend, summary.today);
  totals.weekCache += summary.last7Days.cacheReadTokens;
  totals.weekMiss += freshInputTokens(backend, summary.last7Days);
  totals.cumulativeCache += summary.cumulative.cacheReadTokens;
  totals.cumulativeMiss += freshInputTokens(backend, summary.cumulative);
}

function renderTotalCacheRows(totals: CacheTotals): string[] {
  return [
    formatNumberRow("cache", {
      today: totals.todayCache,
      last7Days: totals.weekCache,
      cumulative: totals.cumulativeCache,
    }),
    formatNumberRow("miss", {
      today: totals.todayMiss,
      last7Days: totals.weekMiss,
      cumulative: totals.cumulativeMiss,
    }),
    formatStringRow("hit%", {
      today: hitPct(totals.todayCache, totals.todayMiss),
      last7Days: hitPct(totals.weekCache, totals.weekMiss),
      cumulative: hitPct(totals.cumulativeCache, totals.cumulativeMiss),
    }),
  ];
}

export function createTokensHandler(deps: TokensHandlerDeps): CommandHandler {
  return async () => {
    const sessions = await deps.store.listActiveSessions();
    if (sessions.length === 0) {
      return { replyText: "当前没有 active session。使用 /new 创建一个。" };
    }
    const now = deps.clock.now();
    const cutoffs = computeWindowCutoffs(now);
    const summaries: TokenUsageSummary[] = [];
    const blocks: string[][] = [];
    const cacheTotals: CacheTotals = {
      todayCache: 0,
      todayMiss: 0,
      weekCache: 0,
      weekMiss: 0,
      cumulativeCache: 0,
      cumulativeMiss: 0,
    };
    for (const s of sessions) {
      const summary = await deps.store.getTokenUsageSummary(s.id, cutoffs);
      summaries.push(summary);
      addCacheTotals(cacheTotals, s.backend, summary);
      blocks.push(renderSession(s.name, summary, s.backend));
    }
    const header =
      NAME_INDENT +
      padEndVisual("", KIND_WIDTH) +
      padEndVisual("今日(百万)", COL_WIDTH) +
      padEndVisual("7日(亿)", COL_WIDTH) +
      "累计(亿)";
    const note =
      NAME_INDENT + "cache=命中输入，miss=未命中/新写输入，hit%=cache/(cache+miss)";
    const separatorWidth = KIND_WIDTH + COL_WIDTH * 2 + 10;
    const totalSummary = aggregateSummaries(summaries);
    const tableLines = [
      note,
      header,
      ...blocks.flat(),
      NAME_INDENT + "─".repeat(separatorWidth),
      NAME_INDENT + "合计",
      formatKindRow("in", totalSummary),
      formatKindRow("out", totalSummary),
      formatKindRow("all", totalSummary),
      ...renderTotalCacheRows(cacheTotals),
    ];
    // Wrap in a markdown code fence so Feishu renders the table in monospace
    // (plain text messages use proportional fonts — columns won't align).
    const body = "```\n" + tableLines.join("\n") + "\n```";
    return { replyCard: { title: "Token 使用", body } };
  };
}
