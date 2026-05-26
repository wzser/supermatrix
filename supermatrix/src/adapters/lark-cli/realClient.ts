import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { AbsolutePath, CardId, LarkGroupId } from "../../domain/ids.ts";
import { asCardId, asLarkGroupId } from "../../domain/ids.ts";
import { extractStaWritebackCommandText } from "../../domain/staWritebackCommand.ts";
import type { RunStatus } from "../../ports/BindingStore.ts";
import type { LarkRawMessage, LarkSdkClient } from "./client.ts";

const execFileP = promisify(execFile);

type ExtractedAttachment = {
  kind: "image" | "file";
  fileKey: string;
  name: string;
};

const CARD_ACTION_PREFIX = "CARD_ACTION:";
function pickRecordField(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickStringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringifyActionValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return undefined;
}

function extractCardActionPrompt(parsed: Record<string, unknown>): string | undefined {
  const event = pickRecordField(parsed, "event");
  const action = pickRecordField(event, "action") ?? pickRecordField(parsed, "action");
  const value = action?.value ?? parsed.action_value;
  const actionJson = stringifyActionValue(value);
  return actionJson ? CARD_ACTION_PREFIX + actionJson : undefined;
}

function extractEventType(parsed: Record<string, unknown>): string | undefined {
  const header = pickRecordField(parsed, "header");
  return pickStringField(parsed, "type")
    ?? pickStringField(parsed, "event_type")
    ?? pickStringField(header, "event_type");
}

function extractCardActionMessage(parsed: Record<string, unknown>): LarkRawMessage | undefined {
  const text = extractCardActionPrompt(parsed);
  if (!text) return undefined;

  const event = pickRecordField(parsed, "event");
  const context = pickRecordField(event, "context") ?? pickRecordField(parsed, "context");
  const operator = pickRecordField(event, "operator") ?? pickRecordField(parsed, "operator");
  const header = pickRecordField(parsed, "header");
  const timestampRaw = header?.create_time ?? parsed.timestamp ?? parsed.create_time ?? event?.timestamp;
  const timestampMs = typeof timestampRaw === "string"
    ? Number.parseInt(timestampRaw, 10)
    : typeof timestampRaw === "number"
    ? timestampRaw
    : Date.now();

  return {
    messageId:
      pickStringField(context, "open_message_id")
      ?? pickStringField(parsed, "message_id")
      ?? pickStringField(parsed, "open_message_id")
      ?? pickStringField(event, "token")
      ?? `card_action_${Date.now()}`,
    groupId:
      pickStringField(context, "open_chat_id")
      ?? pickStringField(parsed, "chat_id")
      ?? pickStringField(parsed, "open_chat_id")
      ?? "card_action",
    userId:
      pickStringField(operator, "open_id")
      ?? pickStringField(parsed, "operator_id")
      ?? pickStringField(parsed, "user_id")
      ?? "",
    text,
    attachments: [],
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    chatType: "card_action",
  };
}

/**
 * Parse attachment metadata from the compact event `content` field.
 * Supports four formats used by Feishu:
 *  - `<file key="xxx" name="yyy"/>`
 *  - `<image key="xxx"/>` or `<image image_key="xxx"/>`
 *  - `[Image: img_xxx]`
 *  - `{"image_key":"img_xxx"}`
 */
export function extractAttachment(content: string): ExtractedAttachment | undefined {
  return extractAttachments(content)[0];
}

export function extractAttachments(content: string): ExtractedAttachment[] {
  const indexed: Array<{ index: number; attachment: ExtractedAttachment }> = [];

  for (const match of content.matchAll(/<file\b([^>]*)\/?>/gu)) {
    const attrs = match[1];
    const fileKey = attrs.match(/\bkey="([^"]+)"/u)?.[1];
    const name = attrs.match(/\bname="([^"]+)"/u)?.[1];
    if (fileKey && name) {
      indexed.push({
        index: match.index ?? 0,
        attachment: { kind: "file", fileKey, name },
      });
    }
  }

  for (const match of content.matchAll(/<image\b([^>]*)\/?>/gu)) {
    const attrs = match[1];
    const imageKey = attrs.match(/\b(?:key|image_key)="([^"]+)"/u)?.[1];
    if (imageKey) {
      indexed.push({
        index: match.index ?? 0,
        attachment: { kind: "image", fileKey: imageKey, name: imageKey + ".png" },
      });
    }
  }

  for (const match of content.matchAll(/\[Image:\s*(img_[^\]\s]+)\]/giu)) {
    const imageKey = match[1];
    indexed.push({
      index: match.index ?? 0,
      attachment: { kind: "image", fileKey: imageKey, name: imageKey + ".png" },
    });
  }

  try {
    const parsed = JSON.parse(content) as { image_key?: unknown };
    if (typeof parsed.image_key === "string" && parsed.image_key.length > 0) {
      indexed.push({
        index: 0,
        attachment: {
          kind: "image",
          fileKey: parsed.image_key,
          name: parsed.image_key + ".png",
        },
      });
    }
  } catch {
    // not JSON
  }

  const seen = new Set<string>();
  return indexed
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.attachment)
    .filter((attachment) => {
      const key = attachment.kind + ":" + attachment.fileKey;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// ─── merge_forward expansion ────────────────────────────────────────────────
// lark-cli's --compact subscribe reduces msg_type=merge_forward to the
// 16-char "[Merged forward]" placeholder; we re-fetch the parent via
// /open-apis/im/v1/messages/mget. Feishu returns an already-formatted
// transcript wrapped in <forwarded_messages>...</forwarded_messages>
// (one "[ISO8601] sender:" line per message + indented body), so we strip
// the wrapper, cap by lines/chars, and trail with parent_message_id so the
// session can re-fetch the full transcript on demand.

export const MERGE_FORWARD_MAX_LINES = 30;
export const MERGE_FORWARD_MAX_CHARS = 4000;

const FORWARDED_OPEN = "<forwarded_messages>";
const FORWARDED_CLOSE = "</forwarded_messages>";
// One header line per forwarded sub-message: "[YYYY-MM-DDTHH:MM:SS+TZ] sender:"
const FORWARD_HEADER_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function extractForwardedTranscript(content: string): string | undefined {
  if (!content) return undefined;
  const startIdx = content.indexOf(FORWARDED_OPEN);
  const endIdx = content.lastIndexOf(FORWARDED_CLOSE);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx + FORWARDED_OPEN.length) {
    return undefined;
  }
  let body = content.slice(startIdx + FORWARDED_OPEN.length, endIdx);
  if (body.startsWith("\n")) body = body.slice(1);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return body;
}

function countForwardedMessages(lines: string[]): number {
  let n = 0;
  for (const l of lines) if (FORWARD_HEADER_RE.test(l)) n += 1;
  return n;
}

export function renderForwardedTranscript(opts: {
  parentMessageId: string;
  transcript: string;
}): string {
  const lines = opts.transcript.split("\n");
  const totalMsgs = countForwardedMessages(lines);
  const header = totalMsgs > 0
    ? `[Merged forward · ${totalMsgs}条消息]`
    : "[Merged forward]";
  const trail = `parent_message_id: ${opts.parentMessageId}`;

  const out: string[] = [header];
  let chars = header.length;
  let used = 0;
  let cutAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (used >= MERGE_FORWARD_MAX_LINES) { cutAt = i; break; }
    if (chars + line.length + 1 > MERGE_FORWARD_MAX_CHARS && used > 0) {
      cutAt = i;
      break;
    }
    out.push(line);
    chars += line.length + 1;
    used += 1;
  }
  if (cutAt >= 0) {
    const remaining = lines.length - cutAt;
    const remainingMsgs = countForwardedMessages(lines.slice(cutAt));
    out.push(
      remainingMsgs > 0
        ? `... (truncated, ${remaining} more lines / ${remainingMsgs} more messages — re-fetch via parent_message_id)`
        : `... (truncated, ${remaining} more lines — re-fetch via parent_message_id)`,
    );
  }
  out.push(trail);
  return out.join("\n");
}

export type RealLarkClientConfig = {
  larkCliPath: string;
  botAppId: string;
  botOpenId?: string;
  ownerUserId: string;
  noProxy?: boolean;
  updateCardThrottleMs?: number;
};

type LarkEnvelope<T> = {
  ok: boolean;
  identity?: string;
  data?: T;
  error?: { type: string; message: string };
};

type BotInfoData = {
  bot?: {
    open_id?: string;
  };
};

function resolveEnv(cfg: RealLarkClientConfig): NodeJS.ProcessEnv {
  if (cfg.noProxy === false) return process.env;
  return { ...process.env, LARK_CLI_NO_PROXY: "1" };
}

async function runLarkCli<T>(
  cfg: RealLarkClientConfig,
  args: string[]
): Promise<T> {
  let stdout = "";
  try {
    const result = await execFileP(cfg.larkCliPath, args, {
      env: resolveEnv(cfg),
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    stdout = e.stdout ?? "";
    if (!stdout) {
      throw new Error(
        `lark-cli ${args.join(" ")} failed: ${e.stderr?.trim() || e.message}`
      );
    }
  }

  let parsed: LarkEnvelope<T>;
  try {
    parsed = JSON.parse(stdout) as LarkEnvelope<T>;
  } catch {
    throw new Error(
      `lark-cli ${args[0]} ${args[1] ?? ""} returned non-JSON: ${stdout.slice(0, 200)}`
    );
  }

  if (parsed.ok === false) {
    throw new Error(
      `lark-cli ${args[0]} ${args[1] ?? ""} error [${parsed.error?.type ?? "unknown"}]: ${
        parsed.error?.message ?? "unknown"
      }`
    );
  }
  if (parsed.data === undefined) {
    throw new Error(
      `lark-cli ${args[0]} ${args[1] ?? ""} ok without data`
    );
  }
  return parsed.data;
}

async function fetchBotOpenId(cfg: RealLarkClientConfig): Promise<string | undefined> {
  if (cfg.botOpenId) return cfg.botOpenId;
  try {
    const result = await execFileP(cfg.larkCliPath, [
      "api", "GET",
      "/open-apis/bot/v3/info",
      "--as", "bot",
    ], {
      env: resolveEnv(cfg),
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout) as BotInfoData & { data?: BotInfoData };
    const openId = parsed.bot?.open_id ?? parsed.data?.bot?.open_id;
    return typeof openId === "string" && openId.length > 0
      ? openId
      : undefined;
  } catch (err) {
    console.warn(
      `[lark-cli] bot open_id lookup failed; @ mention detection may rely on app_id only: ${
        (err as Error).message
      }`
    );
    return undefined;
  }
}

function collectMentionStrings(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMentionStrings(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectMentionStrings(nested, out);
  }
}

function collectMentionCandidates(parsed: Record<string, unknown>): Set<string> {
  const candidates = new Set<string>();
  collectMentionStrings(parsed.mentions, candidates);

  const event = pickRecordField(parsed, "event");
  collectMentionStrings(event?.mentions, candidates);

  const message = pickRecordField(event, "message") ?? pickRecordField(parsed, "message");
  collectMentionStrings(message?.mentions, candidates);

  const content = typeof parsed.content === "string" ? parsed.content : "";
  for (const match of content.matchAll(/<at\b[^>]*(?:user_id|open_id|app_id)="([^"]+)"/gu)) {
    if (match[1]) candidates.add(match[1]);
  }
  return candidates;
}

export function eventMentionsBot(
  parsed: Record<string, unknown>,
  ids: { botAppId?: string | undefined; botOpenId?: string | undefined },
): boolean {
  if (parsed.is_at_bot === true || parsed.at_bot === true || parsed.mentioned_bot === true) {
    return true;
  }

  const allowed = new Set(
    [ids.botAppId, ids.botOpenId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  if (allowed.size === 0) return false;

  const candidates = collectMentionCandidates(parsed);
  for (const candidate of candidates) {
    if (allowed.has(candidate)) return true;
  }
  return false;
}

type MgetMessage = {
  message_id?: string;
  msg_type?: string;
  content?: string;
  body?: { content?: string };
  sender?: { name?: string };
  create_time?: string | number;
};

type MgetData = {
  messages?: MgetMessage[];
  // Older / alt response shape from some lark-cli builds — kept for safety.
  items?: MgetMessage[];
};

type MessageDetailItem = {
  message_id?: string;
  mentions?: unknown;
  body?: { content?: string };
};

type MessageDetailData = {
  items?: MessageDetailItem[];
};

async function fetchMessageDetail(
  cfg: RealLarkClientConfig,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await execFileP(cfg.larkCliPath, [
      "api", "GET",
      `/open-apis/im/v1/messages/${messageId}`,
      "--as", "bot",
    ], {
      env: resolveEnv(cfg),
      maxBuffer: 2 * 1024 * 1024,
    });
    const parsed = JSON.parse(result.stdout) as { data?: MessageDetailData };
    const item = parsed.data?.items?.[0];
    if (!item) return undefined;
    const detail: Record<string, unknown> = {};
    if (item.mentions !== undefined) detail.mentions = item.mentions;
    if (typeof item.body?.content === "string") {
      try {
        const body = JSON.parse(item.body.content) as { text?: unknown };
        if (typeof body.text === "string") detail.content = body.text;
      } catch {
        detail.content = item.body.content;
      }
    }
    return detail;
  } catch (err) {
    console.warn(
      `[lark-cli] message mention lookup failed for ${messageId}: ${(err as Error).message}`
    );
    return undefined;
  }
}

async function expandMergeForward(
  cfg: RealLarkClientConfig,
  parentMessageId: string,
): Promise<string> {
  let parent: MgetData;
  try {
    parent = await runLarkCli<MgetData>(cfg, [
      "im",
      "+messages-mget",
      "--as",
      "bot",
      "--message-ids",
      parentMessageId,
    ]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `[Merged forward · fetch failed: ${reason} · parent_message_id: ${parentMessageId}]`;
  }

  const list = parent.messages ?? parent.items ?? [];
  const item = list[0];
  const rawContent = typeof item?.content === "string"
    ? item.content
    : typeof item?.body?.content === "string"
      ? item.body.content
      : "";
  const transcript = extractForwardedTranscript(rawContent);
  if (transcript === undefined || transcript.length === 0) {
    return `[Merged forward · 内容不可解析 · parent_message_id: ${parentMessageId}]`;
  }
  return renderForwardedTranscript({ parentMessageId, transcript });
}

type CreateChatData = {
  chat_id: string;
  chat_type: string;
  name: string;
  owner_id?: string;
};

type SendMessageData = {
  chat_id: string;
  message_id: string;
  create_time: string;
};

type CardHeaderTemplate = "blue" | "green" | "red" | "grey";

export type AsyncChildCompletedMessage = {
  childId: string;
  childName: string;
  childType: string;
  result: string;
  commId?: string;
};

// Authoritative status-to-template mapping. Prefer this over prefix-sniffing:
// a body that starts with 💬 / 📄 but whose terminal status is timeout leaves
// the card green under prefix-sniffing, even though the run actually died.
export function templateForRunStatus(status: RunStatus): CardHeaderTemplate {
  switch (status) {
    case "completed":
      return "green";
    case "cancelled":
      return "grey";
    case "failed":
    case "timeout":
      return "red";
    case "running":
      return "blue";
  }
}

// Feishu card JSON payload has an upper bound; long scheduler runs with big
// stream logs plus a multi-turn final body were overflowing the PATCH limit
// and forcing finalizeCard into the text fallback, which left the card stuck
// in "running". Cap the stream log at this size; full log remains in DB.
export const MAX_PROCESS_LOG_CHARS = 20_000;
const PROCESS_LOG_TRUNCATE_MARKER = "\n\n…(已截断 stream log，完整请看 DB message_run)";

export function truncateProcessLog(log: string, max = MAX_PROCESS_LOG_CHARS): string {
  if (log.length <= max) return log;
  const keep = Math.max(0, max - PROCESS_LOG_TRUNCATE_MARKER.length);
  return log.slice(0, keep) + PROCESS_LOG_TRUNCATE_MARKER;
}

export function parseAsyncChildCompletedMessage(text: string): AsyncChildCompletedMessage | null {
  const open = /<sm-child-completed\b([^>]*)>/u.exec(text);
  if (!open || open.index === undefined) return null;
  const attrs = parseXmlishAttrs(open[1] ?? "");
  const childId = attrs.child_id;
  if (!childId) return null;

  const bodyStart = open.index + open[0].length;
  const close = text.indexOf("</sm-child-completed>", bodyStart);
  if (close < 0) return null;

  const body = text.slice(bodyStart, close);
  const resultOpen = body.indexOf("<result>");
  const resultClose = body.lastIndexOf("</result>");
  if (resultOpen < 0 || resultClose < resultOpen) return null;

  const rawResult = body.slice(resultOpen + "<result>".length, resultClose);
  const parsed: AsyncChildCompletedMessage = {
    childId,
    childName: attrs.child_name ?? "子 session",
    childType: attrs.child_type ?? "unknown",
    result: trimOneEnvelopeNewline(rawResult),
  };
  const commId = extractAsyncChildCommId(text, attrs);
  if (commId) parsed.commId = commId;
  return parsed;
}

export function buildAsyncChildCompletedCardJson(text: string, processLog?: string): string | null {
  const parsed = parseAsyncChildCompletedMessage(text);
  if (!parsed) return null;

  const result = parsed.result.trim().length > 0
    ? parsed.result
    : "_(子 session 未返回内容)_";
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: "异步回传 · 延迟投递 · 查看完整回传" },
        background_color: "grey-100",
        vertical_align: "center",
        padding: "4px 0px 4px 8px",
        icon_position: "right",
      },
      elements: [{ tag: "markdown", content: renderAsyncChildCompletedMarkdown(parsed, result) }],
    },
  ];
  const processLogPanel = buildProcessLogPanel(processLog);
  if (processLogPanel) elements.push(processLogPanel);

  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: buildAsyncChildCompletedTitle(parsed) },
      template: "grey" satisfies CardHeaderTemplate,
    },
    body: {
      elements,
    },
  };
  return JSON.stringify(card);
}

function parseXmlishAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/\s([A-Za-z_][\w:-]*)="([^"]*)"/gu)) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) attrs[key] = unescapeXmlishAttr(value);
  }
  return attrs;
}

function unescapeXmlishAttr(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function trimOneEnvelopeNewline(value: string): string {
  return value.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "");
}

function extractAsyncChildCommId(text: string, attrs: Record<string, string>): string | undefined {
  if (attrs.comm_id) return attrs.comm_id;
  if (attrs.comm) return attrs.comm;
  if (attrs.communication_id) return attrs.communication_id;

  const fromChineseReceipt = text.match(/请求〔([^〕\s]+)〕/u)?.[1];
  if (fromChineseReceipt) return fromChineseReceipt;
  const fromLabel = text.match(/\bcomm(?:_id)?\s*[:=]\s*([A-Za-z0-9_.:-]+)/u)?.[1];
  if (fromLabel) return fromLabel;
  return text.match(/\(comm:\s*([^),\s]+)(?:[),\s])/u)?.[1];
}

function buildAsyncChildCompletedTitle(input: AsyncChildCompletedMessage): string {
  const meta = [
    ...(input.commId ? [`comm: ${input.commId}`] : []),
    `id: ${input.childId}`,
    `type: ${input.childType}`,
  ];
  return `[异步回传] ${input.childName} 的回复 (${meta.join(", ")})`;
}

function renderAsyncChildCompletedMarkdown(input: AsyncChildCompletedMessage, result: string): string {
  return [
    "**异步回传 / 延迟投递**",
    `- 来源：${input.childName}`,
    ...(input.commId ? [`- comm ID：${input.commId}`] : []),
    `- child ID：${input.childId}`,
    `- 类型：${input.childType}`,
    "",
    result,
  ].join("\n");
}

function buildProcessLogPanel(processLog?: string): Record<string, unknown> | null {
  if (!processLog || processLog.trim().length === 0) return null;
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: "📋 查看流式过程" },
      background_color: "grey-100",
      vertical_align: "center",
      padding: "4px 0px 4px 8px",
      icon_position: "right",
    },
    elements: [{ tag: "markdown", content: truncateProcessLog(processLog) }],
  };
}

/**
 * Feishu card schema 2.0 JSON. Used for post/update/finalize — a single card's
 * schema must be consistent across its lifecycle (patch can't switch 1.0 ⇄ 2.0),
 * so every call site shares this builder. When `processLog` is provided, a
 * collapsed panel is appended so the streaming trace stays viewable on finalize.
 */
export function buildCardJson(
  body: string,
  template: CardHeaderTemplate,
  title: string,
  processLog?: string,
): string {
  const asyncChildCard = buildAsyncChildCompletedCardJson(body, processLog);
  if (asyncChildCard) return asyncChildCard;

  const trimmed = body.trim().length > 0 ? body : "_(等待输出…)_";
  const elements: Array<Record<string, unknown>> = [
    { tag: "markdown", content: trimmed },
  ];
  const processLogPanel = buildProcessLogPanel(processLog);
  if (processLogPanel) elements.push(processLogPanel);
  const card = {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    body: { elements },
  };
  return JSON.stringify(card);
}

// Exported for unit tests. Tries full PATCH first; on failure, retries without
// processLog (the biggest and most common overflow source); only if both PATCH
// attempts fail does it fall back to sending the answer as plain text. Without
// the retry, any oversized card — scheduler long-run is the regular offender —
// leaves the card header stuck on "running" and duplicates the body as a bare
// message outside the card.
export async function finalizeCardWithFallback(
  cardId: string,
  patchWithLog: () => Promise<void>,
  patchWithoutLog: () => Promise<void>,
  fallbackText: () => Promise<void>,
  hasProcessLog: boolean,
): Promise<"patched" | "patched-without-log" | "fallback"> {
  try {
    await patchWithLog();
    return "patched";
  } catch (err) {
    if (!hasProcessLog) {
      console.warn(
        `[lark-cli] finalizeCard PATCH failed for ${cardId}: ${(err as Error).message}`,
      );
      await fallbackText();
      return "fallback";
    }
    try {
      await patchWithoutLog();
      console.warn(
        `[lark-cli] finalizeCard retried without processLog for ${cardId} (first attempt: ${(err as Error).message})`,
      );
      return "patched-without-log";
    } catch (err2) {
      console.warn(
        `[lark-cli] finalizeCard PATCH failed (both attempts) for ${cardId}: first=${(err as Error).message} retry=${(err2 as Error).message}`,
      );
      await fallbackText();
      return "fallback";
    }
  }
}

export function createRealLarkClient(cfg: RealLarkClientConfig): LarkSdkClient {
  const throttleMs = cfg.updateCardThrottleMs ?? 2_000;
  const lastUpdateAt = new Map<string, number>();
  const groupForCard = new Map<string, LarkGroupId>();
  type SubscribeChild = ChildProcessByStdio<null, Readable, Readable>;
  const inflightSubscribers = new Set<SubscribeChild>();

  // Track outbound message IDs so the subscription callback can skip echoes.
  // The --compact flag may strip sender_type, so ID-based dedup is the
  // reliable mechanism; the sender_type check is kept as a secondary guard.
  const outboundIds = new Set<string>();
  const MAX_OUTBOUND_IDS = 500;
  const trackOutbound = (msgId: string) => {
    outboundIds.add(msgId);
    if (outboundIds.size > MAX_OUTBOUND_IDS) {
      const first = outboundIds.values().next().value;
      if (first) outboundIds.delete(first);
    }
  };
  let botOpenIdCache = cfg.botOpenId;
  let botOpenIdPromise: Promise<string | undefined> | undefined;

  const getBotOpenId = async (): Promise<string | undefined> => {
    if (botOpenIdCache !== undefined) return botOpenIdCache;
    if (!cfg.botAppId) return undefined;
    botOpenIdPromise ??= fetchBotOpenId(cfg).then((openId) => {
      botOpenIdCache = openId;
      return openId;
    });
    return botOpenIdPromise;
  };

  const messageMentionsBot = async (
    parsed: Record<string, unknown>,
    messageId: string,
  ): Promise<boolean> => {
    if (eventMentionsBot(parsed, { botAppId: cfg.botAppId, botOpenId: botOpenIdCache })) {
      return true;
    }
    const botOpenId = await getBotOpenId();
    const ids = { botAppId: cfg.botAppId, botOpenId };
    if (eventMentionsBot(parsed, ids)) return true;

    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (!messageId || !/@(?:_user_\d+|[^\s]+)/u.test(content)) return false;
    const detail = await fetchMessageDetail(cfg, messageId);
    return detail ? eventMentionsBot(detail, ids) : false;
  };

  const sendTextAsBot = async (groupId: LarkGroupId, text: string): Promise<SendMessageData> => {
    const data = await runLarkCli<SendMessageData>(cfg, [
      "im", "+messages-send",
      "--as", "bot",
      "--chat-id", groupId,
      "--text", text,
    ]);
    trackOutbound(data.message_id);
    return data;
  };

  const sendTextAsUser = async (groupId: LarkGroupId, text: string): Promise<SendMessageData> => {
    // Same lark-cli message endpoint, just --as user. SPIKE_NOTES.md confirms
    // the CLI supports this for normal messaging. Outbound id tracking is
    // symmetric with sendTextAsBot so subscription dedup still works.
    const data = await runLarkCli<SendMessageData>(cfg, [
      "im", "+messages-send",
      "--as", "user",
      "--chat-id", groupId,
      "--text", text,
    ]);
    trackOutbound(data.message_id);
    return data;
  };

  const sendCardAsBot = async (
    groupId: LarkGroupId,
    body: string,
    template: CardHeaderTemplate,
    title: string,
    processLog?: string,
  ): Promise<SendMessageData> => {
    const data = await runLarkCli<SendMessageData>(cfg, [
      "im", "+messages-send",
      "--as", "bot",
      "--chat-id", groupId,
      "--msg-type", "interactive",
      "--content", buildCardJson(body, template, title, processLog),
    ]);
    trackOutbound(data.message_id);
    return data;
  };

  const sendCardJsonAsBot = async (
    groupId: LarkGroupId,
    cardJson: string,
  ): Promise<SendMessageData> => {
    const data = await runLarkCli<SendMessageData>(cfg, [
      "im", "+messages-send",
      "--as", "bot",
      "--chat-id", groupId,
      "--msg-type", "interactive",
      "--content", cardJson,
    ]);
    trackOutbound(data.message_id);
    return data;
  };

  const patchCardAsBot = async (
    messageId: string,
    body: string,
    template: CardHeaderTemplate,
    title: string,
    processLog?: string,
  ): Promise<void> => {
    await runLarkCli<Record<string, unknown>>(cfg, [
      "api", "PATCH",
      `/open-apis/im/v1/messages/${messageId}`,
      "--data", JSON.stringify({ content: buildCardJson(body, template, title, processLog) }),
      "--as", "bot",
    ]);
  };

  return {
    async sendText(groupId: LarkGroupId, text: string, identity?: "bot" | "user"): Promise<void> {
      if (identity === "user") {
        await sendTextAsUser(groupId, text);
      } else {
        const asyncChildCard = buildAsyncChildCompletedCardJson(text);
        if (asyncChildCard) {
          try {
            await sendCardJsonAsBot(groupId, asyncChildCard);
            return;
          } catch (err) {
            console.warn(
              `[lark-cli] async child completion card failed; falling back to text: ${(err as Error).message}`,
            );
          }
        }
        await sendTextAsBot(groupId, text);
      }
    },

    async createGroup(name: string, _ownerUserId: string): Promise<LarkGroupId> {
      void _ownerUserId;
      const data = await runLarkCli<CreateChatData>(cfg, [
        "im", "+chat-create",
        "--as", "user",
        "--name", name,
        "--type", "private",
        "--bots", cfg.botAppId,
      ]);
      return asLarkGroupId(data.chat_id);
    },

    async inviteUser(groupId: LarkGroupId, userId: string): Promise<void> {
      await runLarkCli<Record<string, unknown>>(cfg, [
        "api", "POST",
        `/open-apis/im/v1/chats/${groupId}/members`,
        "--params", JSON.stringify({ member_id_type: "open_id" }),
        "--data", JSON.stringify({ id_list: [userId] }),
        "--as", "user",
      ]);
    },

    async renameGroup(groupId: LarkGroupId, name: string): Promise<void> {
      await runLarkCli<Record<string, unknown>>(cfg, [
        "api", "PUT",
        `/open-apis/im/v1/chats/${groupId}`,
        "--data", JSON.stringify({ name }),
        "--as", "user",
      ]);
    },

    async getGroupName(groupId: LarkGroupId): Promise<string> {
      const data = await runLarkCli<{ name?: string }>(cfg, [
        "api", "GET",
        `/open-apis/im/v1/chats/${groupId}`,
        "--as", "user",
      ]);
      return data.name ?? "";
    },

    async dissolveGroup(groupId: LarkGroupId): Promise<void> {
      try {
        await runLarkCli<Record<string, unknown>>(cfg, [
          "api", "DELETE",
          `/open-apis/im/v1/chats/${groupId}/members`,
          "--params", JSON.stringify({ member_id_type: "app_id" }),
          "--data", JSON.stringify({ id_list: [cfg.botAppId] }),
          "--as", "user",
        ]);
      } catch (err) {
        console.warn(
          `[lark-cli] dissolveGroup: bot-leave fallback failed for ${groupId}: ${
            (err as Error).message
          }`
        );
      }
    },

    async postCard(groupId: LarkGroupId, initialText: string, title: string): Promise<CardId> {
      const data = await sendCardAsBot(groupId, initialText, "blue", title);
      const cardId = asCardId(data.message_id);
      groupForCard.set(cardId, groupId);
      lastUpdateAt.set(cardId, Date.now());
      return cardId;
    },

    async updateCard(cardId: CardId, text: string, title: string): Promise<void> {
      const now = Date.now();
      const last = lastUpdateAt.get(cardId) ?? 0;
      if (now - last < throttleMs) return;
      const groupId = groupForCard.get(cardId);
      if (!groupId) return;
      lastUpdateAt.set(cardId, now);
      try {
        await patchCardAsBot(cardId, text, "blue", title);
      } catch (err) {
        console.warn(`[lark-cli] updateCard PATCH failed for ${cardId}: ${(err as Error).message}`);
      }
    },

    async finalizeCard(
      cardId: CardId,
      text: string,
      title: string,
      processLog?: string,
      runStatus?: RunStatus,
    ): Promise<void> {
      const groupId = groupForCard.get(cardId);
      groupForCard.delete(cardId);
      lastUpdateAt.delete(cardId);
      if (!groupId) return;
      const template: CardHeaderTemplate = runStatus
        ? templateForRunStatus(runStatus)
        : text.startsWith("❌")
          ? "red"
          : "green";
      const hasProcessLog = processLog !== undefined && processLog.trim().length > 0;
      await finalizeCardWithFallback(
        cardId,
        () => patchCardAsBot(cardId, text, template, title, processLog),
        () => patchCardAsBot(cardId, text, template, title, undefined),
        async () => { await sendTextAsBot(groupId, text); },
        hasProcessLog,
      );
    },

    async downloadAttachment(opts: {
      messageId: string;
      fileKey: string;
      type: "image" | "file";
      destPath: AbsolutePath;
    }): Promise<void> {
      const cwd = dirname(opts.destPath);
      const filename = basename(opts.destPath);
      try {
        await execFileP(cfg.larkCliPath, [
          "im", "+messages-resources-download",
          "--as", "bot",
          "--message-id", opts.messageId,
          "--file-key", opts.fileKey,
          "--type", opts.type,
          "--output", filename,
        ], { cwd, env: resolveEnv(cfg) });
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        throw new Error(
          `lark-cli download failed (${opts.type} ${opts.fileKey}): ${e.stderr?.trim() || e.message}`
        );
      }
      const st = await stat(opts.destPath).catch(() => undefined);
      if (!st || st.size === 0) {
        throw new Error(
          `lark-cli download produced empty file for ${opts.type} ${opts.fileKey}`
        );
      }
    },

    subscribeInbound(cb: (raw: LarkRawMessage) => void): () => void {
      let stopped = false;
      let currentChild: SubscribeChild | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let backoffMs = 2_000;
      const maxBackoffMs = 30_000;

      const spawnOne = (): void => {
        if (stopped) return;
        const child = spawn(
          cfg.larkCliPath,
          [
            "event", "+subscribe",
            "--as", "bot",
            "--event-types", "im.message.receive_v1,card.action.trigger",
            "--compact",
            "--quiet",
          ],
          {
            env: resolveEnv(cfg),
            stdio: ["ignore", "pipe", "pipe"],
            // Own process group so we can kill the entire tree (node wrapper
            // + lark-cli Go binary) at once via negative PID. Without this,
            // killing the direct child leaves the grandchild holding the
            // Feishu single-instance subscribe lock.
            detached: true,
          }
        ) as SubscribeChild;

        currentChild = child;
        inflightSubscribers.add(child);

        let gotFirstOutput = false;

        child.on("error", (err) => {
          console.error(`[lark-cli] subscribe error: ${err.message}`);
        });
        child.on("exit", (code, signal) => {
          inflightSubscribers.delete(child);
          if (currentChild === child) currentChild = undefined;
          if (stopped) return;
          if (code === 0 && signal === null) {
            // Lark closed the WebSocket cleanly — still want to reconnect.
          }
          if (!gotFirstOutput) {
            // Probably hit the single-instance lock. Back off and retry.
            console.error(
              `[lark-cli] subscribe child exited before first event (code=${code ?? "null"} signal=${signal ?? "null"}); reconnecting in ${backoffMs}ms`
            );
          } else {
            console.error(
              `[lark-cli] subscribe child exited after running (code=${code ?? "null"} signal=${signal ?? "null"}); reconnecting in ${backoffMs}ms`
            );
            // Reset backoff since we had a healthy session.
            backoffMs = 2_000;
          }
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
            spawnOne();
          }, backoffMs);
        });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", () => {
          // Suppress — we already run with --quiet; errors come via exit code.
        });

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on("line", (line) => {
          void (async () => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("[")) return;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            return;
          }
          const eventType = extractEventType(parsed);
          if (eventType === "card.action.trigger") {
            gotFirstOutput = true;
            const cardActionMessage = extractCardActionMessage(parsed);
            if (cardActionMessage) cb(cardActionMessage);
            return;
          }
          if (eventType !== "im.message.receive_v1") return;

          gotFirstOutput = true;

          const messageId = typeof parsed.message_id === "string" ? parsed.message_id : "";

          // Primary echo-loop guard: skip messages we sent ourselves.
          if (messageId && outboundIds.delete(messageId)) return;

          // Secondary guard: sender_type (may be absent in --compact output).
          // Feishu button automations may post from another bot app. Allow the
          // explicit STA writeback command through while keeping other app
          // messages suppressed to avoid echo loops.
          const senderType = parsed.sender_type ?? parsed.sender_id_type;
          const senderId = typeof parsed.sender_id === "string" ? parsed.sender_id : "";
          const content = typeof parsed.content === "string" ? parsed.content : "";
          const staWritebackAppCommand = extractStaWritebackCommandText(content);
          if (senderType === "app" && (!staWritebackAppCommand || senderId === cfg.botAppId)) return;
          const groupId = typeof parsed.chat_id === "string" ? parsed.chat_id : "";
          if (!messageId || !groupId) return;

          const chatType = typeof parsed.chat_type === "string" ? parsed.chat_type : undefined;
          const msgType = (parsed.msg_type ?? parsed.message_type ?? "text") as string;
          const timestampRaw = parsed.timestamp ?? parsed.create_time;
          const timestampMs = typeof timestampRaw === "string"
            ? Number.parseInt(timestampRaw, 10)
            : typeof timestampRaw === "number"
            ? timestampRaw
            : Date.now();
          const mentionedBot = await messageMentionsBot(parsed, messageId);

          const attachments: LarkRawMessage["attachments"] = [];
          let text = staWritebackAppCommand ?? content;

          const extractedAttachments = extractAttachments(content);
          for (const extracted of extractedAttachments) {
            attachments.push({
              kind: extracted.kind,
              remoteKey: extracted.fileKey,
              originalName: extracted.name,
            });
          }
          if (msgType === "image" && extractedAttachments.some((a) => a.kind === "image")) {
            // For pure image messages, the "content" is just the key — provide
            // a human-readable placeholder so the prompt isn't empty.
            text = `[用户发送了图片]`;
          } else if (msgType === "file" && extractedAttachments.some((a) => a.kind === "file")) {
            text = `[用户发送了文件]`;
          }

          if (msgType === "merge_forward") {
            // --compact subscribe collapses merge_forward to a 16-char
            // "[Merged forward]" placeholder; fetch the real sub-messages via
            // mget asynchronously and emit the expanded transcript when ready.
            // Fire-and-forget — other inbound events are not blocked.
            void (async () => {
              const expanded = await expandMergeForward(cfg, messageId);
              cb({
                messageId,
                groupId,
                userId: senderId,
                text: expanded,
                mentionedBot,
                attachments: [],
                timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
                ...(chatType !== undefined ? { chatType } : {}),
              });
            })();
            return;
          }

          cb({
            messageId,
            groupId,
            userId: senderId,
            text,
            mentionedBot,
            attachments,
            timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
            ...(chatType !== undefined ? { chatType } : {}),
          });
          })().catch((err) => {
            console.warn(`[lark-cli] subscribe line handling failed: ${(err as Error).message}`);
          });
        });
      };

      spawnOne();

      return () => {
        stopped = true;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        if (currentChild && !currentChild.killed && typeof currentChild.pid === "number") {
          try {
            // Negative pid → kill entire process group (node wrapper +
            // lark-cli Go binary together). See the detached:true comment
            // in spawnOne above.
            process.kill(-currentChild.pid, "SIGTERM");
          } catch {
            try {
              currentChild.kill("SIGTERM");
            } catch {
              // already gone
            }
          }
        }
      };
    },
  };
}
