import { resolveBrokerUrl } from "./config.ts";

const CLICK_TIMEOUT_MS = 1_000;

export type CardAskClick = {
  token: string;
  value: unknown;
};

type BrokerEnv = {
  BROKER_URL?: string | undefined;
  BROKER_PORT?: string | undefined;
};

function pickRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function extractCardAskClick(data: Record<string, unknown>): CardAskClick | null {
  const event = pickRecord(data.event);
  const action = pickRecord(event?.action) ?? pickRecord(data.action);
  const value = pickRecord(action?.value);
  if (!value || value.__ask_user !== true || typeof value.token !== "string") return null;
  return { token: value.token, value: value.value };
}

export function resolveCardAskClickBrokerUrl(env: BrokerEnv = process.env): string {
  return resolveBrokerUrl(env);
}

export async function postCardAskClick(
  click: CardAskClick,
  env: BrokerEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL("/click", resolveCardAskClickBrokerUrl(env)), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(click),
      signal: AbortSignal.timeout(CLICK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null) as unknown;
    return Boolean(pickRecord(body)?.ok);
  } catch {
    return false;
  }
}
