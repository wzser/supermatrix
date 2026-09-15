const ERROR_MESSAGE_KEYS = ["message", "error", "reason"] as const;

export function errorMessage(err: unknown, fallback = "unknown error"): string {
  const extracted = extractErrorMessage(err, new Set());
  if (extracted) return extracted;
  const message = stringifyUnknown(err);
  return message.length > 0 ? message : fallback;
}

function extractErrorMessage(value: unknown, seen: Set<object>): string | undefined {
  if (value instanceof Error) return value.message || undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (!value || typeof value !== "object") return undefined;

  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ERROR_MESSAGE_KEYS) {
    const extracted = extractErrorMessage(record[key], seen);
    if (extracted) return extracted;
  }

  return undefined;
}

function stringifyUnknown(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") return json;
  } catch {
    return "unserializable object error";
  }
  return String(value);
}
