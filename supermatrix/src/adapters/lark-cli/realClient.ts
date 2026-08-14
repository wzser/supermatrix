import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import type { AbsolutePath, CardId, LarkGroupId } from "../../domain/ids.ts";
import { asCardId, asLarkGroupId } from "../../domain/ids.ts";
import type { RunStatus } from "../../ports/BindingStore.ts";
import type {
  CardHeaderTemplate,
  DriveCommentFileType,
  ReferencedMessage,
} from "../../ports/LarkGateway.ts";
import type { LarkRawDriveComment, LarkRawInbound, LarkRawMessage, LarkSdkClient } from "./client.ts";
import { extractCardAskClick, postCardAskClick } from "../card-ask/click.ts";
import { extractNotifyActionClick, postNotifyActionClick } from "../notify-action/click.ts";

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

function extractEventId(parsed: Record<string, unknown>): string | undefined {
  const header = pickRecordField(parsed, "header");
  const event = pickRecordField(parsed, "event");
  return pickStringField(header, "event_id")
    ?? pickStringField(parsed, "event_id")
    ?? pickStringField(event, "event_id")
    ?? pickStringField(event, "uuid");
}

function normalizeDriveCommentFileType(value: string | undefined): DriveCommentFileType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "doc" ||
    normalized === "docx" ||
    normalized === "sheet" ||
    normalized === "file" ||
    normalized === "slides" ||
    normalized === "bitable"
  ) {
    return normalized;
  }
  return undefined;
}

function pickOpenId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return pickStringField(record, "open_id")
    ?? pickStringField(record, "user_id")
    ?? pickStringField(record, "id");
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
 * Collect image_keys from Feishu post (rich text) bodies, in document order.
 * Post paragraphs live under `content` / `content_v2` / `elements`, each an
 * array of paragraphs, each paragraph an array of tagged nodes.
 */
function extractPostImageKeys(parsed: {
  content?: unknown;
  content_v2?: unknown;
  elements?: unknown;
}): string[] {
  const keys: string[] = [];
  for (const field of [parsed.content, parsed.content_v2, parsed.elements]) {
    if (!Array.isArray(field)) continue;
    for (const paragraph of field) {
      if (!Array.isArray(paragraph)) continue;
      for (const node of paragraph) {
        if (
          node !== null &&
          typeof node === "object" &&
          (node as { tag?: unknown }).tag === "img" &&
          typeof (node as { image_key?: unknown }).image_key === "string" &&
          ((node as { image_key: string }).image_key).length > 0
        ) {
          keys.push((node as { image_key: string }).image_key);
        }
      }
    }
  }
  return keys;
}

/**
 * Parse attachment metadata from the compact event `content` field.
 * Supports four formats used by Feishu:
 *  - `<file key="xxx" name="yyy"/>`
 *  - `<image key="xxx"/>` or `<image image_key="xxx"/>`
 *  - `[Image: img_xxx]`
 *  - `{"image_key":"img_xxx"}`
 *  - post (rich text) JSON with {tag:"img",image_key} nodes
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
    const parsed = JSON.parse(content) as {
      image_key?: unknown;
      content?: unknown;
      content_v2?: unknown;
      elements?: unknown;
    };
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
    // Feishu post (rich text) messages carry images as {tag:"img",image_key}
    // nodes inside content / content_v2 / elements paragraph arrays — not in
    // any of the textual formats above. Walk all three fields; the dedup
    // below collapses keys repeated across content and content_v2.
    for (const imageKey of extractPostImageKeys(parsed)) {
      indexed.push({
        index: 0,
        attachment: { kind: "image", fileKey: imageKey, name: imageKey + ".png" },
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
  botAppSecret?: string;
  botOpenId?: string;
  ownerUserId: string;
  noProxy?: boolean;
  updateCardThrottleMs?: number;
  driveCommentPollPath?: string;
  driveCommentPollIntervalMs?: number;
  wsClientFactory?: (params: LarkWsClientParams) => LarkWsClient;
  eventDispatcherFactory?: () => LarkWsEventDispatcher;
};

type LarkCliRunConfig = Pick<RealLarkClientConfig, "larkCliPath" | "noProxy">;

export const DRIVE_COMMENT_EVENT_TYPE = "drive.notice.comment_add_v1";
export const LARK_WS_HEALTH_GRACE_MS = 90_000;

export type LarkWsHealthState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "unavailable";

export type LarkWsHealthSnapshot = {
  status: "ok" | "grace" | "degraded" | "unavailable";
  ingress: "node-sdk-ws" | "legacy-lark-cli";
  state: LarkWsHealthState;
  startedAt: number;
  stateSince: number;
  graceUntil?: number;
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
  lastError?: string;
  lastErrorAt?: number;
};

export type RealLarkClient = LarkSdkClient & {
  /** Non-secret snapshot of the process-owned node-sdk WS ingress. */
  getWsHealth(): LarkWsHealthSnapshot;
};

export type DriveCommentSubscriptionReconcileResult = {
  eventType: typeof DRIVE_COMMENT_EVENT_TYPE;
  identities: DriveCommentIdentitySubscriptionResult[];
};

export type DriveCommentIdentitySubscriptionResult = {
  identity: DriveCommentSubscriptionIdentity;
  initialStatus: boolean | null;
  createAttempted: boolean;
  finalStatus: boolean | null;
  error?: string;
};

export const DRIVE_COMMENT_SUBSCRIPTION_IDENTITIES = ["bot", "user"] as const;
export type DriveCommentSubscriptionIdentity =
  (typeof DRIVE_COMMENT_SUBSCRIPTION_IDENTITIES)[number];

type DriveUserSubscriptionStatusData = {
  is_subscribe?: unknown;
};

const DRIVE_SUBSCRIPTION_CLI_TIMEOUT_MS = 10_000;

type LarkWsClientParams = {
  appId: string;
  appSecret: string;
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
};

type LarkWsConnectionStatus = {
  state: Exclude<LarkWsHealthState, "unavailable">;
  lastConnectTime?: number;
  nextConnectTime?: number;
  reconnectAttempts: number;
};

type LarkWsClient = {
  start(params: { eventDispatcher: LarkWsEventDispatcher }): void | Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): LarkWsConnectionStatus;
};

type LarkWsEventDispatcher = {
  register(handles: Record<string, (data: Record<string, unknown>) => unknown | Promise<unknown>>): LarkWsEventDispatcher;
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

type DriveReplyContentElement = {
  type?: string;
  text_run?: { text?: string };
  person?: { name?: string; user_id?: string; open_id?: string; id?: string };
  docs_link?: { url?: string; title?: string };
};

type DriveReplyItem = {
  reply_id?: string;
  create_time?: number | string;
  user_id?: string;
  content?: { elements?: DriveReplyContentElement[] };
  extra?: Record<string, unknown>;
};

type DriveCommentItem = {
  comment_id?: string;
  create_time?: number | string;
  user_id?: string;
  quote?: string;
  content?: { elements?: DriveReplyContentElement[] };
  extra?: Record<string, unknown>;
  has_more?: boolean;
  page_token?: string;
  reply_list?: {
    replies?: DriveReplyItem[];
  };
};

type DriveCommentBatchQueryData = {
  items?: DriveCommentItem[];
};

type DriveCommentListData = {
  items?: DriveCommentItem[];
  page_token?: string;
  has_more?: boolean;
};

type DriveCommentReplyListData = {
  items?: DriveReplyItem[];
  page_token?: string;
  has_more?: boolean;
};

type DriveCommentPollWatch = {
  fileToken: string;
  fileType: DriveCommentFileType;
  tableId?: string;
  recordId?: string;
  since?: number;
  url?: string;
};

function resolveEnv(cfg: LarkCliRunConfig): NodeJS.ProcessEnv {
  if (cfg.noProxy === false) return process.env;
  return { ...process.env, LARK_CLI_NO_PROXY: "1" };
}

const larkWsLogger = {
  error: (...msg: unknown[]) => console.error("[lark-sdk]", ...msg),
  warn: (...msg: unknown[]) => console.warn("[lark-sdk]", ...msg),
  info: () => {},
  debug: () => {},
  trace: () => {},
};

function createDefaultWsClient(params: LarkWsClientParams): LarkWsClient {
  return new WSClient({
    appId: params.appId,
    appSecret: params.appSecret,
    logger: larkWsLogger,
    loggerLevel: LoggerLevel.warn,
    source: "supermatrix",
    ...(params.onReady ? { onReady: params.onReady } : {}),
    ...(params.onError ? { onError: params.onError } : {}),
    ...(params.onReconnecting ? { onReconnecting: params.onReconnecting } : {}),
    ...(params.onReconnected ? { onReconnected: params.onReconnected } : {}),
  });
}

function createDefaultEventDispatcher(): LarkWsEventDispatcher {
  return new EventDispatcher({
    logger: larkWsLogger,
    loggerLevel: LoggerLevel.warn,
  }) as LarkWsEventDispatcher;
}

function sanitizeWsHealthError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/\bauthorization\s*[:=]\s*[^\r\n]+/giu, "authorization=[redacted]")
    .replace(
      /\b(app[_-]?secret|access[_-]?token|tenant[_-]?access[_-]?token|token)\s*([:=])\s*[^\s,;]+/giu,
      "$1$2[redacted]",
    )
    .slice(0, 300);
}

function asLarkWsHealthState(value: unknown): LarkWsHealthState | undefined {
  switch (value) {
    case "idle":
    case "connecting":
    case "connected":
    case "reconnecting":
    case "failed":
      return value;
    default:
      return undefined;
  }
}

function parseMessageTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
    }
  } catch {
    // Compact lark-cli output is already plain text.
  }
  return content;
}

function normalizeMessageReceiveEvent(parsed: Record<string, unknown>): Record<string, unknown> {
  const event = pickRecordField(parsed, "event") ?? parsed;
  const message = pickRecordField(event, "message") ?? pickRecordField(parsed, "message");
  if (!message) return parsed;

  const sender = pickRecordField(event, "sender") ?? pickRecordField(parsed, "sender");
  const senderId = pickRecordField(sender, "sender_id");
  const msgType = pickStringField(message, "message_type")
    ?? pickStringField(message, "msg_type")
    ?? pickStringField(parsed, "msg_type")
    ?? pickStringField(parsed, "message_type")
    ?? "text";
  const content = pickStringField(message, "content")
    ?? pickStringField(parsed, "content")
    ?? "";

  return {
    ...parsed,
    event_type: extractEventType(parsed) ?? "im.message.receive_v1",
    message_id: pickStringField(message, "message_id") ?? pickStringField(parsed, "message_id"),
    chat_id: pickStringField(message, "chat_id") ?? pickStringField(parsed, "chat_id"),
    sender_id: pickOpenId(senderId)
      ?? pickStringField(sender, "sender_id")
      ?? pickStringField(parsed, "sender_id"),
    sender_type: pickStringField(sender, "sender_type") ?? pickStringField(parsed, "sender_type"),
    chat_type: pickStringField(message, "chat_type") ?? pickStringField(parsed, "chat_type"),
    msg_type: msgType,
    message_type: msgType,
    content: parseMessageTextContent(content),
    timestamp: pickStringField(message, "create_time")
      ?? pickStringField(parsed, "timestamp")
      ?? pickStringField(parsed, "create_time"),
    parent_id: pickStringField(message, "parent_id") ?? pickStringField(parsed, "parent_id"),
    root_id: pickStringField(message, "root_id") ?? pickStringField(parsed, "root_id"),
    thread_id: pickStringField(message, "thread_id") ?? pickStringField(parsed, "thread_id"),
    mentions: message.mentions ?? parsed.mentions,
  };
}

async function runLarkCli<T>(
  cfg: LarkCliRunConfig,
  args: string[],
  timeoutMs?: number,
): Promise<T> {
  let stdout = "";
  try {
    const result = await execFileP(cfg.larkCliPath, args, {
      env: resolveEnv(cfg),
      maxBuffer: 20 * 1024 * 1024,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    const stdoutText = e.stdout ?? "";
    const stderrText = e.stderr ?? "";
    stdout = stdoutText.trim() ? stdoutText : "";
    if (!stdout && stderrText.trim().startsWith("{")) {
      stdout = stderrText;
    }
    if (!stdout) {
      if (timeoutMs !== undefined && e.killed) {
        throw new Error(
          `lark-cli ${args[0]} ${args[1] ?? ""} timed out after ${timeoutMs}ms`,
        );
      }
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

async function readDriveCommentSubscriptionStatus(
  cfg: LarkCliRunConfig,
  identity: DriveCommentSubscriptionIdentity,
): Promise<boolean> {
  const data = await runLarkCli<DriveUserSubscriptionStatusData>(cfg, [
    "drive", "user", "subscription_status",
    "--as", identity,
    "--event-type", DRIVE_COMMENT_EVENT_TYPE,
    "--format", "json",
  ], DRIVE_SUBSCRIPTION_CLI_TIMEOUT_MS);
  if (typeof data.is_subscribe !== "boolean") {
    throw new Error("Drive comment subscription status missing boolean is_subscribe");
  }
  return data.is_subscribe;
}

async function reconcileDriveCommentIdentitySubscription(
  cfg: LarkCliRunConfig,
  identity: DriveCommentSubscriptionIdentity,
): Promise<DriveCommentIdentitySubscriptionResult> {
  let initialStatus: boolean | null = null;
  let createAttempted = false;
  try {
    initialStatus = await readDriveCommentSubscriptionStatus(cfg, identity);
    if (initialStatus) {
      return {
        identity,
        initialStatus,
        createAttempted,
        finalStatus: true,
      };
    }

    createAttempted = true;
    await runLarkCli<Record<string, unknown>>(cfg, [
      "drive", "user", "subscription",
      "--as", identity,
      "--data", JSON.stringify({ event_type: DRIVE_COMMENT_EVENT_TYPE }),
      "--format", "json",
    ], DRIVE_SUBSCRIPTION_CLI_TIMEOUT_MS);
    const finalStatus = await readDriveCommentSubscriptionStatus(cfg, identity);
    if (!finalStatus) {
      return {
        identity,
        initialStatus,
        createAttempted,
        finalStatus,
        error: `Drive comment subscription (${identity}) remained false after create`,
      };
    }
    return {
      identity,
      initialStatus,
      createAttempted,
      finalStatus,
    };
  } catch (err) {
    return {
      identity,
      initialStatus,
      createAttempted,
      finalStatus: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reconcileDriveCommentSubscription(
  cfg: LarkCliRunConfig,
): Promise<DriveCommentSubscriptionReconcileResult> {
  const identities: DriveCommentIdentitySubscriptionResult[] = [];
  for (const identity of DRIVE_COMMENT_SUBSCRIPTION_IDENTITIES) {
    identities.push(await reconcileDriveCommentIdentitySubscription(cfg, identity));
  }
  return {
    eventType: DRIVE_COMMENT_EVENT_TYPE,
    identities,
  };
}

function driveTextElement(text: string): { type: "text_run"; text_run: { text: string } } {
  return { type: "text_run", text_run: { text } };
}

function renderDriveReplyContent(content: DriveReplyItem["content"]): string {
  const elements = content?.elements ?? [];
  const parts: string[] = [];
  for (const element of elements) {
    if (element.type === "text_run" && element.text_run?.text) {
      parts.push(element.text_run.text);
    } else if (element.type === "person") {
      parts.push(element.person?.name ? `@${element.person.name}` : "@user");
    } else if (element.type === "docs_link") {
      parts.push(element.docs_link?.title ?? element.docs_link?.url ?? "[docs_link]");
    }
  }
  return parts.join("").trim();
}

function buildDriveCommentContext(item: DriveCommentItem, replyId?: string) {
  const directText = renderDriveReplyContent(item.content);
  const replyItems = item.reply_list?.replies ?? [];
  const replies = replyItems
    .map((reply) => renderDriveReplyContent(reply.content))
    .filter((text) => text.length > 0);
  if (replyId) {
    const matchedText = renderDriveReplyContent(
      replyItems.find((reply) => reply.reply_id === replyId)?.content,
    );
    const threadReplies = [
      ...(matchedText && directText ? [directText] : []),
      ...replyItems
        .filter((reply) => reply.reply_id !== replyId)
        .map((reply) => renderDriveReplyContent(reply.content))
        .filter((text) => text.length > 0),
    ];
    return {
      text: matchedText || directText || "",
      ...(item.quote !== undefined ? { quote: item.quote } : {}),
      threadReplies,
    };
  }
  const text = directText || replies.shift() || "";
  return {
    text,
    ...(item.quote !== undefined ? { quote: item.quote } : {}),
    threadReplies: replies,
  };
}

function pickDriveCommentAnchor(
  item: DriveCommentItem,
  replyId: string | undefined,
): { tableId?: string; recordId?: string } {
  const reply = replyId
    ? item.reply_list?.replies?.find((candidate) => candidate.reply_id === replyId)
    : undefined;
  const extras = [
    pickRecordField(reply, "extra"),
    pickRecordField(item, "extra"),
  ];
  const notifyExtras = extras
    .map((extra) => pickRecordField(extra, "notify_extra"))
    .filter((value): value is Record<string, unknown> => value !== undefined);
  const records = [...notifyExtras, ...extras];
  const tableId = pickFirstStringField(records, ["table", "table_id", "tableId"]);
  const recordId = pickFirstStringField(records, ["record", "record_id", "recordId"]);
  return {
    ...(tableId ? { tableId } : {}),
    ...(recordId ? { recordId } : {}),
  };
}

type BitableRecord = { recordId: string; fields: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractBitableRecord(value: unknown, expectedRecordId: string): BitableRecord | undefined {
  const candidates: unknown[] = [];
  if (isRecord(value)) {
    candidates.push(value.record);
    if (Array.isArray(value.records)) candidates.push(...value.records);
    const dataObject = isRecord(value.data) ? value.data : value;
    if (dataObject !== value) {
      candidates.push(dataObject.record);
      if (Array.isArray(dataObject.records)) candidates.push(...dataObject.records);
    }

    const rows = dataObject.data;
    const fieldNames = dataObject.fields;
    const recordIds = dataObject.record_id_list;
    if (Array.isArray(rows) && Array.isArray(fieldNames)) {
      for (const [rowIndex, row] of rows.entries()) {
        if (!Array.isArray(row)) continue;
        const rowRecordId = Array.isArray(recordIds)
          ? pickStringValue(recordIds[rowIndex])
          : rows.length === 1
            ? expectedRecordId
            : undefined;
        if (rowRecordId !== expectedRecordId) continue;
        const fields: Record<string, unknown> = {};
        for (const [fieldIndex, fieldName] of fieldNames.entries()) {
          if (typeof fieldName === "string" && fieldName.length > 0) {
            fields[fieldName] = row[fieldIndex];
          }
        }
        return { recordId: expectedRecordId, fields };
      }
    }
  }
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.fields)) continue;
    const recordId = pickStringField(candidate, "record_id")
      ?? pickStringField(candidate, "recordId")
      ?? pickStringField(candidate, "id");
    if (recordId === expectedRecordId) return { recordId, fields: candidate.fields };
  }
  return undefined;
}

function pickStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function driveReplyMentionsBot(reply: DriveReplyItem, botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  for (const element of reply.content?.elements ?? []) {
    if (element.type !== "person") continue;
    const person = element.person;
    if (!person) continue;
    if (pickOpenId(person) === botOpenId) return true;
  }
  return false;
}

function driveCommentDirectReply(item: DriveCommentItem): DriveReplyItem | undefined {
  if (!item.content) return undefined;
  return {
    content: item.content,
    ...(item.comment_id !== undefined ? { reply_id: item.comment_id } : {}),
    ...(item.create_time !== undefined ? { create_time: item.create_time } : {}),
    ...(item.user_id !== undefined ? { user_id: item.user_id } : {}),
  };
}

async function readDriveCommentPollWatches(pathname: string): Promise<DriveCommentPollWatch[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pathname, "utf8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.warn(`[lark-cli] drive comment poll watch read failed: ${(err as Error).message}`);
    return [];
  }

  const rawWatches = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { watches?: unknown }).watches)
    ? (parsed as { watches: unknown[] }).watches
    : [];
  const watches: DriveCommentPollWatch[] = [];
  for (const raw of rawWatches) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const fileToken = typeof record.fileToken === "string" && record.fileToken.length > 0
      ? record.fileToken
      : undefined;
    const fileType = normalizeDriveCommentFileType(
      typeof record.fileType === "string" ? record.fileType : undefined,
    );
    if (!fileToken || !fileType) continue;
    const since = numberField(record.since);
    const url = pickStringField(record, "url");
    const tableId = pickStringField(record, "tableId") ?? pickStringField(record, "table_id");
    const recordId = pickStringField(record, "recordId")
      ?? pickStringField(record, "record_id")
      ?? recordIdFromDriveCommentUrl(url);
    watches.push({
      fileToken,
      fileType,
      ...(tableId ? { tableId } : {}),
      ...(recordId ? { recordId } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(url ? { url } : {}),
    });
  }
  return watches;
}

function mergeDriveCommentWatches(watches: DriveCommentPollWatch[]): DriveCommentPollWatch[] {
  const merged = new Map<string, DriveCommentPollWatch>();
  for (const watch of watches) {
    const key = `${watch.fileType}:${watch.fileToken}:${watch.tableId ?? ""}:${watch.recordId ?? ""}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, watch);
      continue;
    }
    if (watch.since === undefined || existing.since === undefined) {
      const next = { ...existing, ...watch };
      const since = existing.since ?? watch.since;
      if (since !== undefined) next.since = since;
      merged.set(key, next);
      continue;
    }
    merged.set(key, {
      ...existing,
      ...watch,
      since: Math.min(existing.since, watch.since),
    });
  }
  return [...merged.values()];
}

const MAX_DRIVE_COMMENT_PAGES = 1_000;

async function fetchDriveCommentPage(
  cfg: LarkCliRunConfig,
  watch: DriveCommentPollWatch,
  pageToken?: string,
): Promise<DriveCommentListData> {
  return runLarkCli<DriveCommentListData>(cfg, [
    "drive", "file.comments", "list",
    "--as", "bot",
    "--params", JSON.stringify({
      file_token: watch.fileToken,
      file_type: watch.fileType,
      user_id_type: "open_id",
      need_reaction: false,
      page_size: 100,
      ...(pageToken !== undefined ? { page_token: pageToken } : {}),
    }),
    "--format", "json",
  ]);
}

async function fetchDriveCommentReplyPage(
  cfg: LarkCliRunConfig,
  watch: DriveCommentPollWatch,
  commentId: string,
  pageToken?: string,
): Promise<DriveCommentReplyListData> {
  return runLarkCli<DriveCommentReplyListData>(cfg, [
    "drive", "file.comment.replys", "list",
    "--as", "bot",
    "--params", JSON.stringify({
      file_token: watch.fileToken,
      file_type: watch.fileType,
      comment_id: commentId,
      page_size: 100,
      ...(pageToken !== undefined ? { page_token: pageToken } : {}),
    }),
    "--format", "json",
  ]);
}

async function collectDriveCommentReplies(
  cfg: LarkCliRunConfig,
  watch: DriveCommentPollWatch,
  item: DriveCommentItem,
): Promise<Array<{ commentId: string; reply: DriveReplyItem }>> {
  const commentId = item.comment_id;
  if (!commentId) return [];
  const replies = new Map<string, DriveReplyItem>();
  const embedded = [
    ...(driveCommentDirectReply(item) ? [driveCommentDirectReply(item) as DriveReplyItem] : []),
    ...(item.reply_list?.replies ?? []),
  ];
  for (const reply of embedded) {
    if (reply.reply_id) replies.set(reply.reply_id, reply);
  }
  if (item.has_more === true || item.page_token !== undefined) {
    let pageToken: string | undefined = item.page_token;
    let pages = 0;
    do {
      const data = await fetchDriveCommentReplyPage(cfg, watch, commentId, pageToken);
      for (const reply of data.items ?? []) {
        if (reply.reply_id) replies.set(reply.reply_id, reply);
      }
      pageToken = data.has_more === true ? data.page_token : undefined;
      pages += 1;
      if (pages >= MAX_DRIVE_COMMENT_PAGES) {
        console.warn(
          `[lark-cli] drive comment reply pagination hit ${MAX_DRIVE_COMMENT_PAGES} page cap for comment ${commentId}; further replies skipped`,
        );
        break;
      }
    } while (pageToken !== undefined);
  }
  return [...replies.values()].map((reply) => ({ commentId, reply }));
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

function allowedBotIds(ids: { botAppId?: string | undefined; botOpenId?: string | undefined }): Set<string> {
  return new Set(
    [ids.botAppId, ids.botOpenId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
}

export function eventMentionsBot(
  parsed: Record<string, unknown>,
  ids: { botAppId?: string | undefined; botOpenId?: string | undefined },
): boolean {
  if (parsed.is_at_bot === true || parsed.at_bot === true || parsed.mentioned_bot === true) {
    return true;
  }

  const allowed = allowedBotIds(ids);
  if (allowed.size === 0) return false;

  const candidates = collectMentionCandidates(parsed);
  for (const candidate of candidates) {
    if (allowed.has(candidate)) return true;
  }
  return false;
}

function noticeMentionsBot(
  event: Record<string, unknown>,
  noticeMeta: Record<string, unknown> | undefined,
  ids: { botAppId?: string | undefined; botOpenId?: string | undefined },
): boolean {
  if (event.is_mentioned !== true) return false;

  const allowed = allowedBotIds(ids);
  if (allowed.size === 0) return true;

  const targetUserId = pickOpenId(noticeMeta?.to_user_id);
  if (!targetUserId) return true;
  return allowed.has(targetUserId);
}

const DRIVE_COMMENT_TARGET_URL_FIELDS = [
  "record_url",
  "record_link",
  "target_url",
  "target_link",
  "resource_url",
  "file_url",
  "comment_url",
  "url",
  "link",
  "href",
] as const;

function pickDriveCommentUrlValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^https?:\/\//u.test(trimmed) ? trimmed : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return pickDriveCommentUrlValue(record.url)
    ?? pickDriveCommentUrlValue(record.href)
    ?? pickDriveCommentUrlValue(record.link);
}

function pickDriveCommentTargetUrl(
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const field of DRIVE_COMMENT_TARGET_URL_FIELDS) {
      const url = pickDriveCommentUrlValue(record[field]);
      if (url) return url;
    }
  }
  return undefined;
}

function pickFirstStringField(
  records: Array<Record<string, unknown> | undefined>,
  fields: readonly string[],
): string | undefined {
  for (const record of records) {
    for (const field of fields) {
      const value = pickStringField(record, field);
      if (value) return value;
    }
  }
  return undefined;
}

function recordIdFromDriveCommentUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const queryRecordId = parsed.searchParams.get("record_id") ?? parsed.searchParams.get("recordId");
    if (queryRecordId?.trim()) return queryRecordId.trim();
    const match = parsed.pathname.match(/\/record\/([^/]+)/u);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function pickDriveCommentRecordId(
  url: string | undefined,
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  return pickFirstStringField(records, ["record_id", "recordId"]) ?? recordIdFromDriveCommentUrl(url);
}

function pickDriveCommentTableId(
  ...records: Array<Record<string, unknown> | undefined>
): string | undefined {
  return pickFirstStringField(records, ["table_id", "tableId"]);
}

export function parseDriveCommentEvent(
  parsed: Record<string, unknown>,
  ids: { botAppId?: string | undefined; botOpenId?: string | undefined },
): LarkRawDriveComment | undefined {
  if (extractEventType(parsed) !== "drive.notice.comment_add_v1") return undefined;

  const event = pickRecordField(parsed, "event") ?? parsed;
  const noticeMeta = pickRecordField(event, "notice_meta") ?? pickRecordField(parsed, "notice_meta");
  const comment = pickRecordField(event, "comment") ?? pickRecordField(parsed, "comment");
  const target = pickRecordField(event, "target") ?? pickRecordField(noticeMeta, "target");
  const resource = pickRecordField(event, "resource") ?? pickRecordField(noticeMeta, "resource");
  const commentContent = pickStringField(comment, "content")
    ?? pickStringField(comment, "text")
    ?? pickStringField(event, "content")
    ?? pickStringField(parsed, "content");
  const mentionPayload: Record<string, unknown> = {
    ...parsed,
    content: commentContent ?? "",
    mentions: comment?.mentions ?? event.mentions ?? parsed.mentions,
    is_at_bot: comment?.is_at_bot ?? event.is_at_bot ?? parsed.is_at_bot,
    at_bot: comment?.at_bot ?? event.at_bot ?? parsed.at_bot,
    mentioned_bot: comment?.mentioned_bot ?? event.mentioned_bot ?? parsed.mentioned_bot,
  };
  if (!eventMentionsBot(mentionPayload, ids) && !eventMentionsBot(parsed, ids) && !noticeMentionsBot(event, noticeMeta, ids)) {
    return undefined;
  }

  const eventId = extractEventId(parsed);
  const contextRecords = [event, noticeMeta, target, resource, parsed];
  const fileToken = pickFirstStringField(contextRecords, ["file_token", "fileToken", "token"]);
  const fileType = normalizeDriveCommentFileType(
    pickFirstStringField(contextRecords, ["file_type", "fileType"]),
  );
  const tableId = pickDriveCommentTableId(...contextRecords);
  const commentId = pickStringField(event, "comment_id")
    ?? pickStringField(comment, "comment_id")
    ?? pickStringField(parsed, "comment_id");
  if (!eventId || !fileToken || !fileType || !commentId) return undefined;

  const operator = event.operator_id ?? event.operator ?? parsed.operator_id ?? parsed.operator;
  const fromUserId = pickOpenId(operator)
    ?? pickOpenId(noticeMeta?.from_user_id)
    ?? pickStringField(event, "user_id")
    ?? pickStringField(comment, "user_id")
    ?? pickStringField(parsed, "user_id");
  const replyId = pickStringField(event, "reply_id")
    ?? pickStringField(comment, "reply_id")
    ?? pickStringField(parsed, "reply_id");
  const url = pickDriveCommentTargetUrl(event, comment, noticeMeta, parsed, target, resource);
  const recordId = pickDriveCommentRecordId(url, ...contextRecords, comment);

  return {
    kind: "drive_comment",
    source: {
      kind: "drive_comment",
      eventId,
      fileToken,
      fileType,
      ...(tableId !== undefined ? { tableId } : {}),
      ...(recordId !== undefined ? { recordId } : {}),
      commentId,
      ...(replyId !== undefined ? { replyId } : {}),
      ...(fromUserId !== undefined ? { fromUserId } : {}),
      ...(url !== undefined ? { url } : {}),
    },
  };
}

type MgetMessage = {
  message_id?: string;
  msg_type?: string;
  content?: string;
  body?: { content?: string };
  mentions?: unknown;
  sender?: { id?: string; open_id?: string; name?: string };
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

function extractReferencedMessageId(parsed: Record<string, unknown>): string | undefined {
  const event = pickRecordField(parsed, "event");
  const eventMessage = pickRecordField(event, "message");
  const message = pickRecordField(parsed, "message");
  const candidates = [parsed, eventMessage, message, event];
  const directKeys = [
    "reply_to",
    "parent_id",
    "parent_message_id",
    "reply_to_message_id",
    "reply_message_id",
    "replied_message_id",
  ];
  for (const key of directKeys) {
    for (const candidate of candidates) {
      const value = pickStringField(candidate, key);
      if (value) return value;
    }
  }
  for (const key of ["root_id", "root_message_id"]) {
    for (const candidate of candidates) {
      const value = pickStringField(candidate, key);
      if (value) return value;
    }
  }
  return undefined;
}

function parseTimestampMs(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  const parsed = /^\d+$/u.test(trimmed) ? Number.parseInt(trimmed, 10) : Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractReferencedText(item: MgetMessage): { text?: string; parseError?: string } {
  const rawContent = typeof item.content === "string"
    ? item.content
    : typeof item.body?.content === "string"
      ? item.body.content
      : undefined;
  if (rawContent === undefined || rawContent.length === 0) {
    return { parseError: "referenced message content missing" };
  }

  try {
    const parsed = JSON.parse(rawContent) as unknown;
    if (typeof parsed === "string") return { text: parsed };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.text === "string") return { text: record.text };
      if (typeof record.content === "string") return { text: record.content };
    }
    return { parseError: "unsupported referenced message content shape" };
  } catch {
    return { text: rawContent };
  }
}

function referencedMessageFromMgetItem(messageId: string, item: MgetMessage): ReferencedMessage {
  const ref: ReferencedMessage = {
    messageId: item.message_id ?? messageId,
  };
  const senderId = typeof item.sender?.id === "string" && item.sender.id.length > 0
    ? item.sender.id
    : typeof item.sender?.open_id === "string" && item.sender.open_id.length > 0
      ? item.sender.open_id
      : undefined;
  if (senderId) ref.senderId = senderId;
  if (typeof item.sender?.name === "string" && item.sender.name.length > 0) {
    ref.senderName = item.sender.name;
  }
  const timestampMs = parseTimestampMs(item.create_time);
  if (timestampMs !== undefined) ref.timestampMs = timestampMs;
  const content = extractReferencedText(item);
  if (content.text !== undefined) ref.text = content.text;
  if (content.parseError !== undefined) ref.parseError = content.parseError;
  return ref;
}

async function fetchReferencedMessage(
  cfg: RealLarkClientConfig,
  messageId: string,
): Promise<ReferencedMessage> {
  let data: MgetData;
  try {
    data = await runLarkCli<MgetData>(cfg, [
      "im",
      "+messages-mget",
      "--as",
      "bot",
      "--message-ids",
      messageId,
      // We only read content/sender/create_time; skip the 1.0.46-default
      // reactions enrichment so we don't pay an extra reactions API call.
      "--no-reactions",
    ]);
  } catch (err) {
    return {
      messageId,
      fetchError: err instanceof Error ? err.message : String(err),
    };
  }

  const list = data.messages ?? data.items ?? [];
  const item = list.find((candidate) => candidate.message_id === messageId) ?? list[0];
  if (!item) {
    return {
      messageId,
      fetchError: "referenced message not found in mget response",
    };
  }
  return referencedMessageFromMgetItem(messageId, item);
}

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

async function fetchMessageMgetMentionDetail(
  cfg: RealLarkClientConfig,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const data = await runLarkCli<MgetData>(cfg, [
      "im",
      "+messages-mget",
      "--as",
      "bot",
      "--message-ids",
      messageId,
      "--no-reactions",
      "--format",
      "json",
    ]);
    const list = data.messages ?? data.items ?? [];
    const item = list.find((candidate) => candidate.message_id === messageId) ?? list[0];
    if (!item) return undefined;
    const detail: Record<string, unknown> = {};
    if (item.mentions !== undefined) detail.mentions = item.mentions;
    if (typeof item.content === "string") detail.content = item.content;
    return detail;
  } catch (err) {
    console.warn(
      `[lark-cli] message mention mget lookup failed for ${messageId}: ${(err as Error).message}`
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
      "--no-reactions",
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
// stream logs plus a multi-turn final body may overflow the PATCH limit. Keep
// the final stream trace folded, preserve its beginning and latest tail, cap it
// here, and retry without it on overflow.
export const MAX_PROCESS_LOG_CHARS = 20_000;

// A process log shorter than this renders expanded, so short runs stay
// readable without a click — codex demotes every non-terminal agent_message to
// a thinking event, so on that backend the panel can hold the turn's only
// substance (docs/codex-final-message-loss-2026-08-03.md). Longer traces stay
// collapsed: expanding them buries the answer and pushes the panel below
// Feishu's own "展开更多" fold on tall cards. 800 measured against all 423
// runs on 2026-08-03 — p50=268, p75=689, p90=1658.
export const PROCESS_LOG_AUTO_EXPAND_MAX_CHARS = 500;
const PROCESS_LOG_TRUNCATE_MARKER = "\n\n…(已截断 stream log，完整请看 DB message_runs)";

export function truncateProcessLog(log: string, max = MAX_PROCESS_LOG_CHARS): string {
  if (log.length <= max) return log;
  if (max <= PROCESS_LOG_TRUNCATE_MARKER.length) {
    return PROCESS_LOG_TRUNCATE_MARKER.slice(0, Math.max(0, max));
  }
  const keep = Math.max(0, max - PROCESS_LOG_TRUNCATE_MARKER.length);
  const headLength = Math.ceil(keep / 2);
  const tailLength = keep - headLength;
  return (
    log.slice(0, headLength) +
    PROCESS_LOG_TRUNCATE_MARKER +
    log.slice(log.length - tailLength)
  );
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
  elements.push(...buildProcessLogElements(processLog));

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

// Returns the hint line plus the panel, in render order. Callers spread it —
// The hint lives in the panel header, on its own line under the title, so the
// affordance and its explanation stay together instead of adding a separate
// card element above the panel.
function buildProcessLogElements(processLog?: string): Array<Record<string, unknown>> {
  if (!processLog || processLog.trim().length === 0) return [];
  const expanded = processLog.length < PROCESS_LOG_AUTO_EXPAND_MAX_CHARS;
  // Already expanded → the content is right there, so "点击查看详情" would be
  // telling the user to click something they don't need to click.
  const hint = expanded
    ? "以下为模型输出过程中的关键要点。"
    : "以下为模型输出过程中的关键要点。如果 final message 信息不够，可以点击查看详情。";
  return [
    {
      tag: "collapsible_panel",
      expanded,
      header: {
        title: {
          tag: "markdown",
          content: `📋 查看流式过程\n<font color='grey'>${hint}</font>`,
        },
        background_color: "turquoise-100",
        vertical_align: "center",
        padding: "4px 0px 4px 8px",
        icon: {
          tag: "standard_icon",
          token: "down-bold_outlined",
          color: "turquoise",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      elements: [{ tag: "markdown", content: truncateProcessLog(processLog) }],
    },
  ];
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
  elements.push(...buildProcessLogElements(processLog));
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

function isMarkdownTableDelimiterRow(line: string | undefined): boolean {
  if (line === undefined) return false;
  const t = line.trim();
  // A GFM delimiter row is built only from pipes, dashes, colons and spaces,
  // and must contain at least one column separator (a dash). "| --- | :--: |".
  return t.includes("|") && t.includes("-") && /^[|\-:\s]+$/u.test(t);
}

function looksLikeMarkdownTableLine(line: string | undefined): boolean {
  if (line === undefined) return false;
  const t = line.trim();
  return t.length > 0 && t.includes("|");
}

// Feishu card schema 2.0 renders GFM markdown tables as native table
// components, which are capped per card. A finalize body with many tables (an
// SOP draft is the regular offender) is rejected outright with
// code=230099 / ErrCode=11310 "card table number over limit", and every PATCH
// attempt fails. Rewriting each table block as a fenced code block keeps the
// content readable (a monospace pipe grid) while emitting zero table
// components, so the card PATCH succeeds and the answer stays INSIDE the card
// instead of leaking out as a bare standalone message.
//
// Exported for unit tests.
export function degradeMarkdownTables(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let insideFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/u.test(line)) {
      // Respect existing code fences — tables inside them never render as
      // table components, so leave the block untouched.
      insideFence = !insideFence;
      out.push(line);
      i++;
      continue;
    }
    if (
      !insideFence &&
      looksLikeMarkdownTableLine(line) &&
      isMarkdownTableDelimiterRow(lines[i + 1])
    ) {
      const block: string[] = [line, lines[i + 1] ?? ""];
      i += 2;
      while (i < lines.length && looksLikeMarkdownTableLine(lines[i])) {
        block.push(lines[i] ?? "");
        i++;
      }
      out.push("```", ...block, "```");
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// Exported for unit tests. Finalize ladder, in order of preference, each step
// keeping the answer INSIDE the original card:
//   1. full PATCH (body + processLog panel) — the happy path;
//   2. PATCH without processLog (the biggest, most common overflow source);
//   3. card-safe PATCH — degrade markdown tables to fenced code so an
//      ErrCode 11310 "card table number over limit" body still fits;
//   4. only when EVERY card PATCH fails, fall back to a bare text message.
// Before step 3 existed, an oversized-table body skipped straight to the text
// fallback, leaving the card header stuck on "running" and duplicating the
// final answer as a standalone message outside the card.
export async function finalizeCardWithFallback(
  cardId: string,
  patchWithLog: () => Promise<void>,
  patchWithoutLog: () => Promise<void>,
  patchCardSafe: () => Promise<void>,
  fallbackText: () => Promise<void>,
  hasProcessLog: boolean,
): Promise<"patched" | "patched-without-log" | "patched-card-safe" | "fallback"> {
  try {
    await patchWithLog();
    return "patched";
  } catch (err) {
    const attempts: string[] = [`full=${(err as Error).message}`];
    if (hasProcessLog) {
      try {
        await patchWithoutLog();
        console.warn(
          `[lark-cli] finalizeCard retried without processLog for ${cardId} (${attempts.join(" ")})`,
        );
        return "patched-without-log";
      } catch (err2) {
        attempts.push(`without-log=${(err2 as Error).message}`);
      }
    }
    try {
      await patchCardSafe();
      console.warn(
        `[lark-cli] finalizeCard patched with table-safe degrade for ${cardId} (${attempts.join(" ")})`,
      );
      return "patched-card-safe";
    } catch (err3) {
      attempts.push(`card-safe=${(err3 as Error).message}`);
      console.warn(
        `[lark-cli] finalizeCard ALL card PATCH attempts failed for ${cardId}; ` +
          `falling back to standalone text message (${attempts.join(" ")})`,
      );
      await fallbackText();
      return "fallback";
    }
  }
}

const POST_CARD_RETRY_DELAY_MS = 500;

function isTransientCardPostError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 429|Too Many Requests|rate limit|TAT response/i.test(message);
}

async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createRealLarkClient(cfg: RealLarkClientConfig): RealLarkClient {
  const throttleMs = cfg.updateCardThrottleMs ?? 2_000;
  const lastUpdateAt = new Map<string, number>();
  const groupForCard = new Map<string, LarkGroupId>();
  type SubscribeChild = ChildProcessByStdio<null, Readable, Readable>;
  const inflightSubscribers = new Set<SubscribeChild>();
  const wsIngressEnabled = Boolean(cfg.botAppSecret || cfg.wsClientFactory);
  const wsCreatedAt = Date.now();
  let currentWsClient: LarkWsClient | undefined;
  let wsStartedAt = wsCreatedAt;
  let wsState: LarkWsHealthState = wsIngressEnabled ? "idle" : "unavailable";
  let wsStateSince = wsCreatedAt;
  let wsLastError: string | undefined;
  let wsLastErrorAt: number | undefined;
  let wsTerminalFailure = false;

  const setWsState = (next: LarkWsHealthState, now = Date.now()): void => {
    if (wsState === next) return;
    wsState = next;
    wsStateSince = now;
  };

  const markWsReady = (): void => {
    wsTerminalFailure = false;
    wsLastError = undefined;
    wsLastErrorAt = undefined;
    setWsState("connected");
  };

  const markWsReconnecting = (): void => {
    setWsState("reconnecting");
  };

  const markWsFailure = (err: unknown): void => {
    wsTerminalFailure = true;
    wsLastError = sanitizeWsHealthError(err);
    wsLastErrorAt = Date.now();
    setWsState("failed", wsLastErrorAt);
  };

  const getWsHealth = (): LarkWsHealthSnapshot => {
    if (!wsIngressEnabled) {
      return {
        status: "unavailable",
        ingress: "legacy-lark-cli",
        state: "unavailable",
        startedAt: wsCreatedAt,
        stateSince: wsCreatedAt,
        reconnectAttempts: 0,
      };
    }

    let sdkStatus: LarkWsConnectionStatus | undefined;
    try {
      sdkStatus = currentWsClient?.getConnectionStatus?.();
    } catch (err) {
      markWsFailure(err);
    }
    const observed = wsTerminalFailure
      ? "failed"
      : asLarkWsHealthState(sdkStatus?.state) ?? wsState;
    setWsState(observed);

    const now = Date.now();
    const graceUntil = wsStateSince + LARK_WS_HEALTH_GRACE_MS;
    const transient = wsState === "idle" || wsState === "connecting" || wsState === "reconnecting";
    const status = wsState === "connected"
      ? "ok"
      : transient && now <= graceUntil
        ? "grace"
        : "degraded";

    return {
      status,
      ingress: "node-sdk-ws",
      state: wsState,
      startedAt: wsStartedAt,
      stateSince: wsStateSince,
      ...(transient ? { graceUntil } : {}),
      ...(sdkStatus?.lastConnectTime !== undefined ? { lastConnectTime: sdkStatus.lastConnectTime } : {}),
      ...(sdkStatus?.nextConnectTime !== undefined ? { nextConnectTime: sdkStatus.nextConnectTime } : {}),
      reconnectAttempts: sdkStatus?.reconnectAttempts ?? 0,
      ...(wsLastError !== undefined ? { lastError: wsLastError } : {}),
      ...(wsLastErrorAt !== undefined ? { lastErrorAt: wsLastErrorAt } : {}),
    };
  };

  // Track outbound message IDs so the subscription callback can skip echoes.
  // The --compact flag may strip sender_type, so ID-based dedup is the
  // reliable mechanism; the sender_type check is kept as a secondary guard.
  const outboundIds = new Set<string>();
  const MAX_OUTBOUND_IDS = 500;
  const inboundIds = new Set<string>();
  const MAX_INBOUND_IDS = 10_000;
  const trackOutbound = (msgId: string) => {
    outboundIds.add(msgId);
    if (outboundIds.size > MAX_OUTBOUND_IDS) {
      const first = outboundIds.values().next().value;
      if (first) outboundIds.delete(first);
    }
  };
  const claimInbound = (msgId: string): boolean => {
    if (inboundIds.has(msgId)) return false;
    inboundIds.add(msgId);
    if (inboundIds.size > MAX_INBOUND_IDS) {
      const first = inboundIds.values().next().value;
      if (first) inboundIds.delete(first);
    }
    return true;
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
    if (detail && eventMentionsBot(detail, ids)) return true;
    const mgetDetail = await fetchMessageMgetMentionDetail(cfg, messageId);
    return mgetDetail ? eventMentionsBot(mgetDetail, ids) : false;
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
    getWsHealth,

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
      let cardPostError: unknown;
      try {
        const data = await sendCardAsBot(groupId, initialText, "blue", title);
        const cardId = asCardId(data.message_id);
        groupForCard.set(cardId, groupId);
        lastUpdateAt.set(cardId, Date.now());
        return cardId;
      } catch (err) {
        cardPostError = err;
        if (isTransientCardPostError(err)) {
          await wait(POST_CARD_RETRY_DELAY_MS);
          try {
            const data = await sendCardAsBot(groupId, initialText, "blue", title);
            const cardId = asCardId(data.message_id);
            groupForCard.set(cardId, groupId);
            lastUpdateAt.set(cardId, Date.now());
            return cardId;
          } catch (retryErr) {
            cardPostError = retryErr;
          }
        }
      }

      console.warn(
        `[lark-cli] postCard interactive send failed; falling back to text for ${groupId}: ${
          (cardPostError as Error).message
        }`,
      );
      try {
        const data = await sendTextAsBot(groupId, `${title}\n${initialText}`);
        const cardId = asCardId(data.message_id);
        groupForCard.set(cardId, groupId);
        lastUpdateAt.set(cardId, Date.now());
        return cardId;
      } catch (textErr) {
        console.warn(
          `[lark-cli] postCard text fallback failed for ${groupId}; continuing run with synthetic card id: ${
            (textErr as Error).message
          }`,
        );
      }

      const cardId = asCardId(`synthetic-post-card-${Date.now()}`);
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
      completedTemplate?: CardHeaderTemplate,
    ): Promise<void> {
      const groupId = groupForCard.get(cardId);
      groupForCard.delete(cardId);
      lastUpdateAt.delete(cardId);
      if (!groupId) return;
      const statusTemplate: CardHeaderTemplate = runStatus
        ? templateForRunStatus(runStatus)
        : text.startsWith("❌")
          ? "red"
          : "green";
      // The override recolors only the completed (green) state — a failed or
      // cancelled run keeps its loud red/grey header no matter who asked.
      const template =
        statusTemplate === "green" && completedTemplate ? completedTemplate : statusTemplate;
      const hasProcessLog = processLog !== undefined && processLog.trim().length > 0;
      await finalizeCardWithFallback(
        cardId,
        () => patchCardAsBot(cardId, text, template, title, processLog),
        () => patchCardAsBot(cardId, text, template, title, undefined),
        () => patchCardAsBot(cardId, degradeMarkdownTables(text), template, title, undefined),
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

    async getDriveCommentContext(source) {
      const data = await runLarkCli<DriveCommentBatchQueryData>(cfg, [
        "drive", "file.comments", "batch_query",
        "--as", "bot",
        "--params", JSON.stringify({
          file_token: source.fileToken,
          file_type: source.fileType,
          user_id_type: "open_id",
        }),
        "--data", JSON.stringify({
          comment_ids: [source.commentId],
          need_reaction: false,
        }),
      ]);
      const item = data.items?.find((candidate) => candidate.comment_id === source.commentId)
        ?? data.items?.[0];
      if (!item) {
        throw new Error(`Drive comment not found: ${source.fileToken}/${source.commentId}`);
      }
      const context = buildDriveCommentContext(item, source.replyId);
      const anchor = pickDriveCommentAnchor(item, source.replyId);
      const tableId = source.tableId ?? anchor.tableId;
      const recordId = source.recordId ?? anchor.recordId ?? recordIdFromDriveCommentUrl(source.url);
      if (source.fileType !== "bitable" || !tableId || !recordId) return context;

      const recordData = await runLarkCli<unknown>(cfg, [
        "base", "+record-get",
        "--as", "user",
        "--base-token", source.fileToken,
        "--table-id", tableId,
        "--record-id", recordId,
        "--format", "json",
      ]);
      const bitableRecord = extractBitableRecord(recordData, recordId);
      if (!bitableRecord) {
        throw new Error(`Bitable record not found or incomplete: ${source.fileToken}/${tableId}/${recordId}`);
      }
      return { ...context, bitableRecord: { ...bitableRecord, tableId } };
    },

    async replyToDriveComment(input) {
      await runLarkCli<Record<string, unknown>>(cfg, [
        "drive", "file.comment.replys", "create",
        "--as", "bot",
        "--params", JSON.stringify({
          file_token: input.source.fileToken,
          file_type: input.source.fileType,
          comment_id: input.source.commentId,
          user_id_type: "open_id",
        }),
        "--data", JSON.stringify({
          content: {
            elements: [driveTextElement(input.text)],
          },
        }),
      ]);
    },

    async createDriveComment(input) {
      await runLarkCli<Record<string, unknown>>(cfg, [
        "drive", "file.comments", "create_v2",
        "--as", "bot",
        "--params", JSON.stringify({
          file_token: input.source.fileToken,
        }),
        "--data", JSON.stringify({
          file_type: input.source.fileType,
          reply_elements: input.mentionUserId
            ? [
                { type: "mention_user", mention_user: input.mentionUserId },
                { type: "text", text: ` ${input.text}` },
              ]
            : [{ type: "text", text: input.text }],
        }),
      ]);
    },

    subscribeInbound(cb: (raw: LarkRawInbound) => void): () => Promise<void> {
      let stopped = false;
      let currentChild: SubscribeChild | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let pollInFlight = false;
      let activePollPromise: Promise<void> | undefined;
      let cancellationGeneration = 0;
      let backoffMs = 2_000;
      const maxBackoffMs = 30_000;
      const pollSeen = new Set<string>();
      const pollIntervalMs = cfg.driveCommentPollIntervalMs ?? 15_000;

      const handleParsedEvent = async (input: Record<string, unknown>): Promise<void> => {
        let parsed = input;
        const eventType = extractEventType(parsed);
        if (eventType === "card.action.trigger") {
          const cardAskClick = extractCardAskClick(parsed);
          if (cardAskClick) {
            const delivered = await postCardAskClick(cardAskClick);
            if (!delivered) {
              console.warn("[lark-cli] failed to forward ask_user card click to broker");
            }
            return;
          }
          const notifyActionClick = extractNotifyActionClick(parsed);
          if (notifyActionClick) {
            const forwarded = await postNotifyActionClick(notifyActionClick);
            if (!forwarded) {
              console.warn("[lark-cli] failed to forward notify action card click");
            }
            return;
          }
          const cardActionMessage = extractCardActionMessage(parsed);
          if (cardActionMessage) cb(cardActionMessage);
          return;
        }
        if (eventType === "drive.notice.comment_add_v1") {
          const commentEvent = pickRecordField(parsed, "event") ?? parsed;
          console.log("[lark-cli] drive.notice.comment_add_v1 received", {
            eventId: extractEventId(parsed),
            fileToken: pickStringField(commentEvent, "file_token")
              ?? pickStringField(commentEvent, "token"),
            commentId: pickStringField(commentEvent, "comment_id"),
            replyId: pickStringField(commentEvent, "reply_id"),
          });
          const botOpenId = await getBotOpenId();
          const driveComment = parseDriveCommentEvent(parsed, {
            botAppId: cfg.botAppId,
            botOpenId,
          });
          if (driveComment) cb(driveComment);
          return;
        }
        if (eventType !== "im.message.receive_v1") return;

        parsed = normalizeMessageReceiveEvent(parsed);

        const messageId = typeof parsed.message_id === "string" ? parsed.message_id : "";

        if (messageId && !claimInbound(messageId)) return;

        // Primary echo-loop guard: skip messages we sent ourselves.
        if (messageId && outboundIds.delete(messageId)) return;

        // Secondary guard: sender_type (may be absent in --compact output).
        // App-originated messages stay suppressed to avoid echo loops. Domain
        // automations must enter through their owning session/API, not by
        // punching command-specific holes in the global inbound gateway.
        const senderType = parsed.sender_type ?? parsed.sender_id_type;
        const senderId = typeof parsed.sender_id === "string" ? parsed.sender_id : "";
        const content = typeof parsed.content === "string" ? parsed.content : "";
        if (senderType === "app") return;
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
        const referencedMessageId = extractReferencedMessageId(parsed);
        const referencedMessage = referencedMessageId
          ? await fetchReferencedMessage(cfg, referencedMessageId)
          : undefined;

        const attachments: LarkRawMessage["attachments"] = [];
        let text = content;

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
              ...(referencedMessage !== undefined ? { referencedMessage } : {}),
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
          ...(referencedMessage !== undefined ? { referencedMessage } : {}),
          attachments,
          timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
          ...(chatType !== undefined ? { chatType } : {}),
        });
      };

      const withEventType = (
        eventType: string,
        data: Record<string, unknown>,
      ): Record<string, unknown> => ({
        ...data,
        event_type: extractEventType(data) ?? eventType,
      });

      const startWsClient = (): void => {
        const appSecret = cfg.botAppSecret;
        if (!appSecret && !cfg.wsClientFactory) return;
        const eventDispatcher = (cfg.eventDispatcherFactory ?? createDefaultEventDispatcher)();
        eventDispatcher.register({
          "im.message.receive_v1": async (data) => {
            if (stopped) return;
            await handleParsedEvent(withEventType("im.message.receive_v1", data));
          },
          "drive.notice.comment_add_v1": async (data) => {
            if (stopped) return;
            await handleParsedEvent(withEventType("drive.notice.comment_add_v1", data));
          },
          "card.action.trigger": async (data) => {
            if (!stopped) {
              await handleParsedEvent(withEventType("card.action.trigger", data));
            }
            return {};
          },
        });
        currentWsClient = (cfg.wsClientFactory ?? createDefaultWsClient)({
          appId: cfg.botAppId,
          appSecret: appSecret ?? "",
          onReady: markWsReady,
          onError: markWsFailure,
          onReconnecting: markWsReconnecting,
          onReconnected: markWsReady,
        });
        wsStartedAt = Date.now();
        wsTerminalFailure = false;
        wsLastError = undefined;
        wsLastErrorAt = undefined;
        setWsState("connecting", wsStartedAt);
        try {
          void Promise.resolve(currentWsClient.start({ eventDispatcher })).catch((err: unknown) => {
            markWsFailure(err);
            console.error(`[lark-sdk] ws start failed: ${sanitizeWsHealthError(err)}`);
          });
        } catch (err) {
          markWsFailure(err);
          console.error(`[lark-sdk] ws start failed: ${sanitizeWsHealthError(err)}`);
        }
      };

      const emitPolledDriveComments = async (generation: number): Promise<void> => {
        if (!cfg.driveCommentPollPath || pollInFlight || stopped) return;
        pollInFlight = true;
        try {
          const watches = mergeDriveCommentWatches(
            await readDriveCommentPollWatches(cfg.driveCommentPollPath),
          );
          if (stopped || generation !== cancellationGeneration) return;
          if (watches.length === 0) return;
          const botOpenId = await getBotOpenId();
          if (stopped || generation !== cancellationGeneration) return;
          for (const watch of watches) {
            if (stopped || generation !== cancellationGeneration) return;
            let pageToken: string | undefined;
            let pages = 0;
            do {
              if (stopped || generation !== cancellationGeneration) return;
              const data = await fetchDriveCommentPage(cfg, watch, pageToken);
              if (stopped || generation !== cancellationGeneration) return;
              for (const item of data.items ?? []) {
                const commentId = item.comment_id;
                if (!commentId) continue;
                const collected = await collectDriveCommentReplies(cfg, watch, item);
                if (stopped || generation !== cancellationGeneration) return;
                for (const { commentId: collectedCommentId, reply } of collected) {
                  const replyId = reply.reply_id;
                  const createTime = numberField(reply.create_time);
                  if (!replyId || createTime === undefined) continue;
                  if (watch.since !== undefined && createTime <= watch.since) continue;
                  if (!driveReplyMentionsBot(reply, botOpenId)) continue;
                  const eventId = `poll:${watch.fileType}:${watch.fileToken}:${collectedCommentId}:${replyId}:${createTime}`;
                  if (pollSeen.has(eventId)) continue;
                  pollSeen.add(eventId);
                  if (stopped || generation !== cancellationGeneration) return;
                  cb({
                    kind: "drive_comment",
                    source: {
                      kind: "drive_comment",
                      eventId,
                      fileToken: watch.fileToken,
                      fileType: watch.fileType,
                      ...(watch.tableId ? { tableId: watch.tableId } : {}),
                      ...(watch.recordId ? { recordId: watch.recordId } : {}),
                      commentId: collectedCommentId,
                      replyId,
                      ...(reply.user_id ? { fromUserId: reply.user_id } : {}),
                      ...(watch.url ? { url: watch.url } : {}),
                    },
                  });
                }
              }
              pageToken = data.has_more === true ? data.page_token : undefined;
              pages += 1;
              if (pages >= MAX_DRIVE_COMMENT_PAGES) {
                console.warn(
                  `[lark-cli] drive comment list pagination hit ${MAX_DRIVE_COMMENT_PAGES} page cap for file ${watch.fileToken}; further comments skipped`,
                );
                break;
              }
            } while (pageToken !== undefined);
          }
        } finally {
          pollInFlight = false;
        }
      };

      const scheduleDriveCommentPoll = (): void => {
        if (!cfg.driveCommentPollPath || stopped) return;
        pollTimer = setTimeout(() => {
          pollTimer = undefined;
          const generation = cancellationGeneration;
          const pollPromise = emitPolledDriveComments(generation);
          activePollPromise = pollPromise;
          pollPromise
            .catch((err) => {
              console.warn(`[lark-cli] drive comment poll failed: ${(err as Error).message}`);
            })
            .finally(() => {
              if (activePollPromise === pollPromise) activePollPromise = undefined;
              if (!stopped && generation === cancellationGeneration) scheduleDriveCommentPoll();
            });
        }, pollIntervalMs);
      };

      const spawnOne = (): void => {
        if (stopped) return;
        const child = spawn(
          cfg.larkCliPath,
          [
            "event", "+subscribe",
            "--as", "bot",
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
          if (extractEventType(parsed)) gotFirstOutput = true;
          await handleParsedEvent(parsed);
          })().catch((err) => {
            console.warn(`[lark-cli] subscribe line handling failed: ${(err as Error).message}`);
          });
        });
      };

      if (cfg.botAppSecret || cfg.wsClientFactory) {
        startWsClient();
      } else {
        spawnOne();
      }
      const initialGeneration = cancellationGeneration;
      const initialPollPromise = emitPolledDriveComments(initialGeneration);
      activePollPromise = initialPollPromise;
      void initialPollPromise
        .catch((err) => {
          console.warn(`[lark-cli] drive comment poll failed: ${(err as Error).message}`);
        })
        .finally(() => {
          if (activePollPromise === initialPollPromise) activePollPromise = undefined;
          if (!stopped && initialGeneration === cancellationGeneration) scheduleDriveCommentPoll();
        });

      return async () => {
        stopped = true;
        cancellationGeneration += 1;
        const pollToWait = activePollPromise;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = undefined;
        }
        currentWsClient?.close({ force: true });
        currentWsClient = undefined;
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
        await pollToWait;
      };
    },
  };
}
