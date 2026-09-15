import type { CommandHandler } from "../commandRegistry.ts";
import type {
  BindingStore,
  TokenUsageSummary,
  TokenUsageWindow,
} from "../../ports/BindingStore.ts";
import type { BackendKind } from "../../domain/session.ts";
import type { Clock } from "../../ports/Clock.ts";
import { computeWindowCutoffs, formatM, formatYi } from "../tokenUsageFormat.ts";

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

// Providers report usage on different bases, so the raw columns mean
// different things per backend and must not be rendered or summed as-is:
//   codex (OpenAI):  input_tokens ALREADY includes cached_input_tokens, and
//     the stream parser subtracts reasoning out of output_tokens.
//   claude/kimi (Anthropic-style): input_tokens EXCLUDES both cache halves,
//     and thinking is folded into output_tokens.
// Adding cacheRead to codex's inputTokens therefore double-counted every
// cached token in the `all` row, and reading outputTokens alone understated
// codex's generation by its reasoning share. Normalizing each window to
// (totalInput, generated) is what makes the per-session rows comparable and
// the 合计 row summable across mixed backends.
type NormalizedWindow = {
  /** Every input token sent to the model, cached or not. */
  totalInput: number;
  /** Every token the model produced, reasoning/thinking included. */
  generated: number;
  cacheRead: number;
  /** Input tokens that were not served from cache. */
  freshInput: number;
};

type NormalizedSummary = {
  today: NormalizedWindow;
  last7Days: NormalizedWindow;
  cumulative: NormalizedWindow;
};

function normalizeWindow(backend: BackendKind, w: TokenUsageWindow): NormalizedWindow {
  const totalInput =
    backend === "codex"
      ? w.inputTokens
      : w.inputTokens + w.cacheReadTokens + w.cacheWriteTokens;
  return {
    totalInput,
    generated: w.outputTokens + w.reasoningTokens,
    cacheRead: w.cacheReadTokens,
    // Collapses the old per-backend miss formulas into one identity:
    // codex  -> inputTokens - cacheRead
    // others -> (input + cacheRead + cacheWrite) - cacheRead = input + cacheWrite
    freshInput: Math.max(0, totalInput - w.cacheReadTokens),
  };
}

function normalizeSummary(backend: BackendKind, s: TokenUsageSummary): NormalizedSummary {
  return {
    today: normalizeWindow(backend, s.today),
    last7Days: normalizeWindow(backend, s.last7Days),
    cumulative: normalizeWindow(backend, s.cumulative),
  };
}

function emptyNormalizedWindow(): NormalizedWindow {
  return { totalInput: 0, generated: 0, cacheRead: 0, freshInput: 0 };
}

function addNormalizedWindow(acc: NormalizedWindow, w: NormalizedWindow): void {
  acc.totalInput += w.totalInput;
  acc.generated += w.generated;
  acc.cacheRead += w.cacheRead;
  acc.freshInput += w.freshInput;
}

function pickValue(w: NormalizedWindow, kind: Kind): number {
  if (kind === "in") return w.totalInput;
  if (kind === "out") return w.generated;
  return w.totalInput + w.generated;
}

function formatKindRow(kind: Kind, summary: NormalizedSummary): string {
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

function hitPct(cacheReadTokens: number, freshTokens: number): string {
  const denominator = cacheReadTokens + freshTokens;
  if (denominator <= 0) return "—";
  const pct = Math.min(100, Math.max(0, (cacheReadTokens / denominator) * 100));
  return `${pct.toFixed(1)}%`;
}

function cacheRows(summary: NormalizedSummary): string[] {
  return [
    formatNumberRow("cache", {
      today: summary.today.cacheRead,
      last7Days: summary.last7Days.cacheRead,
      cumulative: summary.cumulative.cacheRead,
    }),
    formatNumberRow("miss", {
      today: summary.today.freshInput,
      last7Days: summary.last7Days.freshInput,
      cumulative: summary.cumulative.freshInput,
    }),
    formatStringRow("hit%", {
      today: hitPct(summary.today.cacheRead, summary.today.freshInput),
      last7Days: hitPct(summary.last7Days.cacheRead, summary.last7Days.freshInput),
      cumulative: hitPct(summary.cumulative.cacheRead, summary.cumulative.freshInput),
    }),
  ];
}

function renderSession(label: string, summary: NormalizedSummary): string[] {
  return [
    NAME_INDENT + label,
    formatKindRow("in", summary),
    formatKindRow("out", summary),
    formatKindRow("all", summary),
    ...cacheRows(summary),
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
    const blocks: string[][] = [];
    // Totals accumulate the normalized windows. Summing the raw per-backend
    // columns first and normalizing after is not possible — the correction
    // depends on which provider produced each row.
    const totals: NormalizedSummary = {
      today: emptyNormalizedWindow(),
      last7Days: emptyNormalizedWindow(),
      cumulative: emptyNormalizedWindow(),
    };
    for (const s of sessions) {
      const summary = normalizeSummary(
        s.backend,
        await deps.store.getTokenUsageSummary(s.id, cutoffs),
      );
      addNormalizedWindow(totals.today, summary.today);
      addNormalizedWindow(totals.last7Days, summary.last7Days);
      addNormalizedWindow(totals.cumulative, summary.cumulative);
      blocks.push(renderSession(s.name, summary));
    }
    const header =
      NAME_INDENT +
      padEndVisual("", KIND_WIDTH) +
      padEndVisual("今日(百万)", COL_WIDTH) +
      padEndVisual("7日(亿)", COL_WIDTH) +
      "累计(亿)";
    const note =
      NAME_INDENT +
      "in=总输入(含缓存)，out=生成(含推理)，cache=命中输入，miss=未命中/新写输入，hit%=cache/(cache+miss)";
    const separatorWidth = KIND_WIDTH + COL_WIDTH * 2 + 10;
    const tableLines = [
      note,
      header,
      ...blocks.flat(),
      NAME_INDENT + "─".repeat(separatorWidth),
      NAME_INDENT + "合计",
      formatKindRow("in", totals),
      formatKindRow("out", totals),
      formatKindRow("all", totals),
      ...cacheRows(totals),
    ];
    // Wrap in a markdown code fence so Feishu renders the table in monospace
    // (plain text messages use proportional fonts — columns won't align).
    const body = "```\n" + tableLines.join("\n") + "\n```";
    return { replyCard: { title: "Token 使用", body } };
  };
}
