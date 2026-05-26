/**
 * Anthropic / Claude Opus rate-limit detection for the heal layer.
 *
 * Why this lives in heal: SK was getting flooded with false-alarm anomaly
 * escalations whose root cause was Claude Opus subscription rate-limit hitting
 * scheduler-fired children. Without detection, heal Step 1 (pure idempotency)
 * instantly retries → fresh failed comm → framework's spawn-closure watcher
 * sees another failed comm → escalates again → SK has to reconcile.
 *
 * The signature set is intentionally narrow. "limit" alone is way too noisy
 * (every long error message has it somewhere). We require one of the canonical
 * Anthropic / Claude Code markers below.
 */

export const RATE_LIMIT_QUIET_WINDOW_MS = 60 * 60 * 1000;
export const RATE_LIMIT_SCOPE = "anthropic";

// 1. "hit your limit"           — Claude Code subscription user-facing copy,
//                                  appears as "You've hit your limit · resets ...".
// 2. "rate_limit_error"         — Anthropic API 429 canonical error code.
// 3. "usage_limit_error"        — alternate Anthropic API code (weekly quota).
// 4. "rate[-_ ]?limit(ed|ing)?" — the plain noun/verb form ("rate limit",
//                                  "rate-limit", "rate limited"). Bounded by \b
//                                  on both sides so "incorporate" won't match.
// 5. "Anthropic ... 429"        — http error proxy phrasing.
const SIGNATURE_RE =
  /(?:hit your limit|rate_limit_error|usage_limit_error|\brate[-_\s]?limit(?:ed|ing)?\b|anthropic[^\n]{0,80}\b429\b)/i;

const EVIDENCE_TEXT_FIELDS = [
  "errorMessage",
  "finalMessage",
  "stderrTail",
  "stdoutTail",
  "note",
  "error",
] as const;

export function detectAnthropicRateLimit(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object") return false;
  const obj = evidence as Record<string, unknown>;
  for (const f of EVIDENCE_TEXT_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" && SIGNATURE_RE.test(v)) return true;
  }
  return false;
}

/**
 * Extract a short snippet of the matching text for audit/logging. Returns the
 * first matching field's value capped at 200 chars, or null if no match.
 */
export function extractRateLimitSnippet(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== "object") return null;
  const obj = evidence as Record<string, unknown>;
  for (const f of EVIDENCE_TEXT_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" && SIGNATURE_RE.test(v)) {
      return v.slice(0, 200);
    }
  }
  return null;
}
