import type { BackendKind } from "../../domain/session.ts";
import { canonicalizeToken } from "../../domain/canonicalizeToken.ts";

// Shared backend alias table, consumed by BOTH /backend's string resolver and
// /new's `backend` enum (as enumAliases) so the two entry points cannot
// diverge. Keys are already canonical (NFKC + lowercase). Spec 7.2.
// NOTE: k2 -> kimi BACKEND here; distinct from k2 -> Kimi default MODEL in
// /model (KIMI_MODEL_ALIASES, unchanged).
export const BACKEND_ALIASES: Record<string, BackendKind> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  k2: "kimi",
};

const CANONICAL_BACKENDS = new Set<BackendKind>(["claude", "codex", "kimi"]);

// Canonical backend for a token (case-/NFKC-insensitive): a canonical member
// first, then a curated alias; null when neither.
export function resolveBackendAlias(token: string): BackendKind | null {
  const c = canonicalizeToken(token);
  if (CANONICAL_BACKENDS.has(c as BackendKind)) return c as BackendKind;
  return BACKEND_ALIASES[c] ?? null;
}
