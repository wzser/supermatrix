import { inboxPredicate, DELIVERY_TOKENS } from "../spawn/predicate.js";

export type OwnerNoticeSender = (
  target: string,
  prompt: string,
) => Promise<{ ok: boolean; error?: string }>;

export function createOwnerNoticeSender(opts: {
  spawnApiUrl: string;
  fetchImpl?: typeof fetch;
}): OwnerNoticeSender {
  const fetchFn = opts.fetchImpl ?? fetch;
  return async (target, prompt) => {
    try {
      const res = await fetchFn(opts.spawnApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          from: "scheduler",
          prompt,
          verification_predicate: inboxPredicate({
            sessionName: target,
            tokens: DELIVERY_TOKENS,
            expectedWindowSec: 3600,
          }),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
