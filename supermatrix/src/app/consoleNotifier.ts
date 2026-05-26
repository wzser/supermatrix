import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import { errorMessage } from "./errorMessage.ts";

export type NotifyLevel = "info" | "warn" | "error";

export type NotifyInput = {
  source: string;
  title: string;
  body: string;
  level?: NotifyLevel | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type NotifyResult = {
  messageId: string;
  degraded: boolean;
  error?: string;
};

export type NotifySender = {
  sendCard(content: string): Promise<{ messageId: string }>;
  sendText(text: string): Promise<{ messageId: string }>;
};

export type Notifier = {
  notify(input: NotifyInput): Promise<NotifyResult>;
};

const TEMPLATE_BY_LEVEL: Record<NotifyLevel, string> = {
  info: "blue",
  warn: "orange",
  error: "red",
};

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

function renderMetadataMd(md: Record<string, unknown>): string {
  return Object.entries(md)
    .map(([k, v]) => `- **${k}**: ${stringifyValue(v)}`)
    .join("\n");
}

function renderMetadataText(md: Record<string, unknown>): string {
  return Object.entries(md)
    .map(([k, v]) => `${k}: ${stringifyValue(v)}`)
    .join("\n");
}

export function buildCardContent(input: NotifyInput, nowMs: number): string {
  const level = input.level ?? "info";
  const template = TEMPLATE_BY_LEVEL[level];
  const body = input.body.trim().length > 0 ? input.body : "_(empty body)_";

  const elements: unknown[] = [
    { tag: "div", text: { tag: "lark_md", content: body } },
  ];

  if (input.metadata && Object.keys(input.metadata).length > 0) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: renderMetadataMd(input.metadata) },
    });
  }

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: `${input.source} · ${formatTimestamp(nowMs)}`,
      },
    ],
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: input.title },
      template,
    },
    elements,
  };
  return JSON.stringify(card);
}

export function buildPlainText(input: NotifyInput, nowMs: number): string {
  const level = input.level ?? "info";
  const parts = [`[${level}] ${input.source}: ${input.title}`, input.body];
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    parts.push(renderMetadataText(input.metadata));
  }
  parts.push(`-- ${formatTimestamp(nowMs)} --`);
  return parts.filter((p) => p.length > 0).join("\n");
}

export function createConsoleNotifier(deps: {
  sender: NotifySender;
  clock: Clock;
  logger?: Logger;
}): Notifier {
  return {
    async notify(input: NotifyInput): Promise<NotifyResult> {
      const nowMs = Number(deps.clock.now());
      const cardContent = buildCardContent(input, nowMs);
      try {
        const { messageId } = await deps.sender.sendCard(cardContent);
        return { messageId, degraded: false };
      } catch (cardErr) {
        const cardErrMsg = errorMessage(cardErr);
        deps.logger?.warn("notify: card failed, falling back to text", {
          err: cardErrMsg,
          source: input.source,
          title: input.title,
        });
        const text = buildPlainText(input, nowMs);
        const { messageId } = await deps.sender.sendText(text);
        return { messageId, degraded: true, error: cardErrMsg };
      }
    },
  };
}
