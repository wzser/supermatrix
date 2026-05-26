import type { NotifyContext } from "../types.js";
import { inboxPredicate, DELIVERY_TOKENS } from "../../../spawn/predicate.js";

export function createOwnerDM(opts: {
  spawnApiUrl: string;
  fetchImpl?: typeof fetch;
}) {
  const fetchFn = opts.fetchImpl ?? fetch;

  return async function sendOwnerDM(ctx: NotifyContext): Promise<void> {
    const header = eventToHeader(ctx.event);
    const prompt = `[scheduler notification - ${header}]

task: ${ctx.taskName} (id=${ctx.taskId})
run: ${ctx.runId}
event: ${ctx.event}

${ctx.message}

(this is an automated notification from scheduler; full heal protocol will arrive in a future release)`;

    const res = await fetchFn(opts.spawnApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: ctx.ownerSession,
        from: "scheduler",
        prompt,
        verification_predicate: inboxPredicate({
          sessionName: ctx.ownerSession,
          tokens: DELIVERY_TOKENS,
          expectedWindowSec: 3600,
        }),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`spawn to ownerDM failed: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  };
}

function eventToHeader(event: NotifyContext["event"]): string {
  if (event === "trigger_failed") return "trigger failed";
  if (event === "receipt_missing") return "completion receipt missing";
  return "succeeded";
}
