const CLICK_TIMEOUT_MS = 1_000;
const DEFAULT_NOTIFY_ACTION_FORWARD_URL = "http://127.0.0.1:3510/webhooks/notify-card";

export type NotifyActionClick = {
  cardType: string;
  value: unknown;
  token: unknown;
  context?: unknown;
  operatorOpenId?: string;
  chatId?: string;
  openMessageId?: string;
  eventTime?: string | number;
};

type NotifyActionForwardEnv = {
  NOTIFY_ACTION_FORWARD_URL?: string | undefined;
};

function pickRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickEventTime(...values: unknown[]): string | number | undefined {
  return values.find((value): value is string | number => typeof value === "string" || typeof value === "number");
}

export function extractNotifyActionClick(data: Record<string, unknown>): NotifyActionClick | null {
  const event = pickRecord(data.event);
  const action = pickRecord(event?.action) ?? pickRecord(data.action);
  const actionValue = pickRecord(action?.value);
  if (!actionValue || actionValue.__notify_action !== true || typeof actionValue.card_type !== "string") {
    return null;
  }

  const eventContext = pickRecord(event?.context) ?? pickRecord(data.context);
  const operator = pickRecord(event?.operator) ?? pickRecord(data.operator);
  const header = pickRecord(data.header);
  const operatorOpenId = pickString(operator, "open_id");
  const chatId = pickString(eventContext, "chat_id") ?? pickString(eventContext, "open_chat_id");
  const openMessageId = pickString(eventContext, "open_message_id");
  const eventTime = pickEventTime(
    header?.create_time,
    event?.create_time,
    event?.event_time,
    event?.timestamp,
    data.create_time,
    data.event_time,
    data.timestamp,
  );
  return {
    cardType: actionValue.card_type,
    value: actionValue.value,
    token: actionValue.token,
    ...(Object.prototype.hasOwnProperty.call(actionValue, "context") ? { context: actionValue.context } : {}),
    ...(operatorOpenId !== undefined ? { operatorOpenId } : {}),
    ...(chatId !== undefined ? { chatId } : {}),
    ...(openMessageId !== undefined ? { openMessageId } : {}),
    ...(eventTime !== undefined ? { eventTime } : {}),
  };
}

export function resolveNotifyActionForwardUrl(env: NotifyActionForwardEnv = process.env): string {
  return env.NOTIFY_ACTION_FORWARD_URL?.trim() || DEFAULT_NOTIFY_ACTION_FORWARD_URL;
}

export async function postNotifyActionClick(
  click: NotifyActionClick,
  env: NotifyActionForwardEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    card_type: click.cardType,
    value: click.value,
    token: click.token,
  };
  if (click.context !== undefined) payload.context = click.context;
  if (click.operatorOpenId !== undefined) payload.operator_open_id = click.operatorOpenId;
  if (click.chatId !== undefined) payload.chat_id = click.chatId;
  if (click.openMessageId !== undefined) payload.open_message_id = click.openMessageId;
  if (click.eventTime !== undefined) payload.event_time = click.eventTime;

  try {
    const response = await fetchImpl(new URL(resolveNotifyActionForwardUrl(env)), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CLICK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
