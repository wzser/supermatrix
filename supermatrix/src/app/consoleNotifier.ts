import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import { errorMessage } from "./errorMessage.ts";

export type NotifyLevel = "info" | "warn" | "error" | "success";

export type NotifyActionContext = Record<string, string | number | boolean | null>;

export type NotifyActionOption = {
  label: string;
  value: string;
  description?: string | undefined;
};

export type NotifyActions = {
  card_type: string;
  options: NotifyActionOption[];
  context?: NotifyActionContext | undefined;
};

export type NotifyInput = {
  source: string;
  title: string;
  body: string;
  level?: NotifyLevel | undefined;
  targetChatId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  actions?: NotifyActions | undefined;
};

// Structured failure code surfaced in degraded results and events log, so
// operators can grep / aggregate by failure class instead of by error string.
export type NotifyErrorCode =
  | "lark_card_rejected"
  | "lark_auth_failed"
  | "lark_other"
  | "network_timeout"
  | "rate_limited"
  | "unknown";

export type NotifyResult = {
  messageId: string;
  degraded: boolean;
  error?: string;
  code?: NotifyErrorCode;
  // Truthy when a same-source+title+body within the dedup window short-circuited
  // to the previously-sent messageId without hitting Feishu again.
  deduped?: boolean;
};

export type NotifySender = {
  sendCard(content: string, targetChatId?: string): Promise<{ messageId: string }>;
  sendText(text: string, targetChatId?: string): Promise<{ messageId: string }>;
};

export type Notifier = {
  notify(input: NotifyInput): Promise<NotifyResult>;
};

// Structural event emitted on every notify call (no body / title / metadata
// raw text — only counts + flags — so the events log is safe to share and
// grep without leaking business prompts).
export type NotifyEvent = {
  ts: string;
  event: "notified";
  source: string;
  level: NotifyLevel;
  chat_id: string | null;
  title_len: number;
  body_len: number;
  has_metadata: boolean;
  metadata_keys: number;
  outcome: "sent" | "degraded" | "deduped" | "rate_limited" | "failed";
  degraded: boolean;
  deduped: boolean;
  rate_limited: boolean;
  message_id: string | null;
  code?: NotifyErrorCode;
  error?: string;
};

const TEMPLATE_BY_LEVEL: Record<NotifyLevel, string> = {
  info: "yellow",
  warn: "orange",
  error: "red",
  success: "purple",
};
const NOTIFICATION_TITLE_PREFIX = "【通知卡片】";

const SHANGHAI_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatTimestamp(ms: number): string {
  return SHANGHAI_FMT.format(new Date(ms)) + " CST";
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function buildMetadataCollapsiblePanel(md: Record<string, unknown>): unknown[] {
  const n = Object.keys(md).length;
  const content = Object.entries(md)
    .map(([k, v]) => `**${k}**: ${stringifyValue(v)}`)
    .join("\n\n");
  return [
    { tag: "hr" },
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: `**详情 metadata (${n} 项)**` },
        vertical_align: "center",
        padding: "4px 0px 4px 8px",
        position: "top",
        width: "fill",
        icon: { tag: "standard_icon", token: "down-bold_outlined", color: "grey", size: "16px 16px" },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      elements: [{ tag: "markdown", content }],
    },
  ];
}

function renderMetadataText(md: Record<string, unknown>): string {
  return Object.entries(md)
    .map(([k, v]) => `${k}: ${stringifyValue(v)}`)
    .join("\n");
}

function prefixedTitle(title: string): string {
  return title.startsWith(NOTIFICATION_TITLE_PREFIX)
    ? title
    : `${NOTIFICATION_TITLE_PREFIX}${title}`;
}

function buildNotifyActionRow(actions: NotifyActions): Record<string, unknown> {
  const token = `na_${randomBytes(4).toString("hex")}`;
  return {
    // Card JSON 2.0 rejects the old tag:"action" wrapper. A column_set keeps
    // the option buttons on one row while each button stays a legal V2 element.
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    horizontal_spacing: "default",
    columns: actions.options.map((option, index) => ({
      tag: "column",
      width: "auto",
      vertical_align: "top",
      elements: [{
        tag: "button",
        element_id: `${token}_${index}`,
        text: { tag: "plain_text", content: option.label },
        type: "primary",
        value: {
          __notify_action: true,
          card_type: actions.card_type,
          value: option.value,
          token,
          ...(actions.context !== undefined ? { context: actions.context } : {}),
        },
      }],
    })),
    margin: "0px",
  };
}

export function buildCardContent(input: NotifyInput, nowMs: number): string {
  const level = input.level ?? "info";
  const template = TEMPLATE_BY_LEVEL[level];
  const body = input.body.trim().length > 0 ? input.body : "_(empty body)_";
  const title = prefixedTitle(input.title);

  const elements: unknown[] = [{ tag: "markdown", content: body }];

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    elements.push(...buildMetadataCollapsiblePanel(input.metadata));
  }

  if (input.actions) {
    elements.push(buildNotifyActionRow(input.actions));
  }

  elements.push({
    tag: "markdown",
    content: `<font color='grey'>${input.source} · ${formatTimestamp(nowMs)}</font>`,
  });

  const card = {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    body: { elements },
  };
  return JSON.stringify(card);
}

export function buildPlainText(input: NotifyInput, nowMs: number): string {
  const level = input.level ?? "info";
  const parts = [`[${level}] ${input.source}: ${prefixedTitle(input.title)}`, input.body];
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    parts.push(renderMetadataText(input.metadata));
  }
  if (input.actions) {
    const options = input.actions.options.map((option) => `[${option.label}]`).join(" ");
    parts.push(`选项（按钮仅在卡片形态可用）：${options} —— 点击无响应请联系 ${input.source}`);
  }
  parts.push(`-- ${formatTimestamp(nowMs)} --`);
  return parts.filter((p) => p.length > 0).join("\n");
}

// Maps an Error thrown from the sender (lark-cli envelope) into a structured
// code. Matches text patterns from src/cli/bootstrap.ts runNotifyCli throws.
export function classifyNotifyError(err: unknown): NotifyErrorCode {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("etimedout")) return "network_timeout";
  if (msg.includes("99991663") || msg.includes("99991664") || msg.includes("auth") || msg.includes("token")) return "lark_auth_failed";
  if (msg.includes("card") && (msg.includes("invalid") || msg.includes("rejected") || msg.includes("231003"))) return "lark_card_rejected";
  if (msg.includes("lark-cli")) return "lark_other";
  return "unknown";
}

// Compute the dedup key from source+title+body. Actions become part of the key
// when present so different option/context cards cannot be swallowed in the
// same window; notifications without actions keep their historic key exactly.
function dedupKey(input: NotifyInput): string {
  const h = createHash("sha256");
  h.update(input.source);
  h.update("\0");
  h.update(input.title);
  h.update("\0");
  h.update(input.body);
  if (input.actions) {
    h.update("\0");
    h.update(JSON.stringify(input.actions));
  }
  return h.digest("hex").slice(0, 24);
}

type RateState = { count: number; windowStartMs: number };

export type NotifierOptions = {
  sender: NotifySender;
  clock: Clock;
  logger?: Logger;
  // Optional structural event sink (jsonl writer). Wired by bootstrap; tests
  // can pass an in-memory collector. Throws inside the sink are caught and
  // logged — they MUST NOT break a real notify.
  onEvent?: (event: NotifyEvent) => void;
  // Per-source token bucket: at most `rateLimitPerMinute` notifies/min from
  // the same `source`. Defaults to 60. Set 0 or negative to disable.
  rateLimitPerMinute?: number;
  // Dedup window: same source+title+body within this many ms short-circuits
  // to the prior messageId without re-sending. Defaults to 60_000. Set 0 to
  // disable dedup.
  dedupWindowMs?: number;
  // Resolve the default delivery chat for a notify whose caller did NOT set
  // targetChatId — typically "the bound group of the source session" (the
  // card's creator). Returning null means "no creator group found" and the
  // sender falls back to the Console group. Wired by bootstrap against the
  // BindingStore; omitted in tests that don't exercise creator-group routing.
  // Resolution precedence in notify(): explicit input.targetChatId  >
  // resolveDefaultChat(source)  >  sender's Console-group fallback.
  resolveDefaultChat?: (source: string) => Promise<string | null>;
};

export function createConsoleNotifier(deps: NotifierOptions): Notifier {
  const rateLimitPerMinute = deps.rateLimitPerMinute ?? 60;
  const rateLimitEnabled = rateLimitPerMinute > 0;
  const dedupWindowMs = deps.dedupWindowMs ?? 60_000;
  const dedupEnabled = dedupWindowMs > 0;

  const rateState = new Map<string, RateState>();
  const dedupCache = new Map<string, { messageId: string; ts: number }>();

  const emit = (event: NotifyEvent) => {
    if (!deps.onEvent) return;
    try { deps.onEvent(event); }
    catch (e) { deps.logger?.warn("notify: event sink threw", { err: errorMessage(e) }); }
  };

  return {
    async notify(input: NotifyInput): Promise<NotifyResult> {
      const nowMs = Number(deps.clock.now());
      const level = input.level ?? "info";
      // Resolve delivery target up front so the events log records where the
      // card actually lands. Precedence: explicit targetChatId (caller chose
      // a group) > the source session's bound group (the card's creator) >
      // null → sender's Console-group fallback. resolveDefaultChat failures
      // must never break a notify, so swallow + fall through to Console.
      let targetChatId = input.targetChatId;
      if (!targetChatId && deps.resolveDefaultChat) {
        try {
          targetChatId = (await deps.resolveDefaultChat(input.source)) ?? undefined;
        } catch (e) {
          deps.logger?.warn("notify: resolveDefaultChat threw; falling back to console group", {
            source: input.source,
            err: errorMessage(e),
          });
        }
      }
      const chatId = targetChatId ?? null;
      const baseEventFields = {
        ts: new Date(nowMs).toISOString(),
        event: "notified" as const,
        source: input.source,
        level,
        chat_id: chatId,
        title_len: input.title.length,
        body_len: input.body.length,
        has_metadata: !!(input.metadata && Object.keys(input.metadata).length > 0),
        metadata_keys: input.metadata ? Object.keys(input.metadata).length : 0,
      };

      // 1) Dedup short-circuit. Same source+title+body within window → return
      // the prior messageId. Prevents retry loops or duplicate triggers from
      // flooding the channel with identical cards.
      if (dedupEnabled) {
        const key = dedupKey(input);
        const cached = dedupCache.get(key);
        if (cached && nowMs - cached.ts < dedupWindowMs) {
          emit({
            ...baseEventFields,
            outcome: "deduped",
            degraded: false,
            deduped: true,
            rate_limited: false,
            message_id: cached.messageId,
          });
          return { messageId: cached.messageId, degraded: false, deduped: true };
        }
      }

      // 2) Rate limit per source. Token bucket reset every 60s of wall clock.
      if (rateLimitEnabled) {
        let st = rateState.get(input.source);
        if (!st || nowMs - st.windowStartMs >= 60_000) {
          st = { count: 0, windowStartMs: nowMs };
          rateState.set(input.source, st);
        }
        if (st.count >= rateLimitPerMinute) {
          const err = `rate limit: source '${input.source}' exceeded ${rateLimitPerMinute}/min`;
          deps.logger?.warn("notify rate-limited", { source: input.source, limit: rateLimitPerMinute });
          emit({
            ...baseEventFields,
            outcome: "rate_limited",
            degraded: false,
            deduped: false,
            rate_limited: true,
            message_id: null,
            code: "rate_limited",
            error: err,
          });
          // Surface as a real error so the HTTP layer returns 4xx — callers
          // need to know their notify was dropped, not silently succeed.
          throw new Error(err);
        }
        st.count += 1;
      }

      const cardContent = buildCardContent(input, nowMs);
      try {
        const { messageId } = await deps.sender.sendCard(cardContent, targetChatId);
        if (dedupEnabled) dedupCache.set(dedupKey(input), { messageId, ts: nowMs });
        emit({
          ...baseEventFields,
          outcome: "sent",
          degraded: false,
          deduped: false,
          rate_limited: false,
          message_id: messageId,
        });
        return { messageId, degraded: false };
      } catch (cardErr) {
        const cardErrMsg = errorMessage(cardErr);
        const code = classifyNotifyError(cardErr);
        deps.logger?.warn("notify: card failed, falling back to text", {
          err: cardErrMsg,
          code,
          source: input.source,
          title: input.title,
        });
        const text = buildPlainText(input, nowMs);
        try {
          const { messageId } = await deps.sender.sendText(text, targetChatId);
          if (dedupEnabled) dedupCache.set(dedupKey(input), { messageId, ts: nowMs });
          emit({
            ...baseEventFields,
            outcome: "degraded",
            degraded: true,
            deduped: false,
            rate_limited: false,
            message_id: messageId,
            code,
            error: cardErrMsg,
          });
          return { messageId, degraded: true, error: cardErrMsg, code };
        } catch (textErr) {
          const textErrMsg = errorMessage(textErr);
          emit({
            ...baseEventFields,
            outcome: "failed",
            degraded: true,
            deduped: false,
            rate_limited: false,
            message_id: null,
            code: classifyNotifyError(textErr),
            error: textErrMsg,
          });
          throw textErr;
        }
      }
    },
  };
}
