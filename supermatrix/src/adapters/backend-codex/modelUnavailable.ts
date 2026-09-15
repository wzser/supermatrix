const CONFIRMED_CODES = new Set(["model_not_found", "model_not_available"]);
const EXACT_ENTITLEMENT_MESSAGE =
  /^The model `[^`]+` does not exist or you do not have access to it\.?$/u;
// Exact provider capacity message. This is a TRANSIENT condition (the same
// model succeeds moments later), so it warrants an identical replay — not a
// model swap. Match exactly so we never confuse it with an entitlement error
// or a generic "at capacity" substring.
const EXACT_CAPACITY_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

export function isConfirmedCodexModelUnavailable(error: unknown): boolean {
  for (const candidate of flattenErrorCandidates(error)) {
    if (typeof candidate === "string" && EXACT_ENTITLEMENT_MESSAGE.test(candidate.trim())) {
      return true;
    }
    if (isRecord(candidate)) {
      const code = typeof candidate.code === "string" ? candidate.code : "";
      const status = typeof candidate.status === "number" ? candidate.status : undefined;
      if (CONFIRMED_CODES.has(code) && (status === undefined || status === 400 || status === 404)) {
        return true;
      }
    }
  }
  return false;
}

export function isCodexModelAtCapacity(error: unknown): boolean {
  for (const candidate of flattenErrorCandidates(error)) {
    if (typeof candidate === "string" && candidate.trim() === EXACT_CAPACITY_MESSAGE) {
      return true;
    }
  }
  return false;
}

function flattenErrorCandidates(value: unknown): unknown[] {
  const candidates: unknown[] = [value];
  if (value instanceof Error) candidates.push(value.message);
  if (isRecord(value)) {
    candidates.push(value.error, value.message);
    if (isRecord(value.error)) candidates.push(value.error.message);
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
