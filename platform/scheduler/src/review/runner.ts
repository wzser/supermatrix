import type { ParsedDecision } from "./replyParser.js";

export type ApplyFn = (
  path: string,
  body: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  errorMessage?: string;
}>;

export type ApplyResult = {
  reviewId: string;
  decision: ParsedDecision["decision"];
  ok: boolean;
  status?: number;
  error?: string;
};

export type RunDecisionsOpts = {
  decisions: ParsedDecision[];
  applyFn: ApplyFn;
};

function buildRequest(d: ParsedDecision): { path: string; body: Record<string, unknown> } {
  const base = `/proposals/creation/${d.reviewId}`;
  switch (d.decision) {
    case "approved":
      return { path: `${base}/approve`, body: { reason: d.reason } };
    case "patched":
      return {
        path: `${base}/patch`,
        body: { reason: d.reason, patch: d.patch ?? {} },
      };
    case "rejected":
      return {
        path: `${base}/reject`,
        body: { reason: d.reason, disable: d.disable ?? true },
      };
    case "escalated":
      return { path: `${base}/escalate`, body: { reason: d.reason } };
  }
}

export async function runDecisions(opts: RunDecisionsOpts): Promise<ApplyResult[]> {
  const { decisions, applyFn } = opts;
  const results: ApplyResult[] = [];

  for (const d of decisions) {
    const { path, body } = buildRequest(d);
    try {
      const resp = await applyFn(path, body);
      if (resp.ok) {
        results.push({
          reviewId: d.reviewId,
          decision: d.decision,
          ok: true,
          status: resp.status,
        });
      } else {
        results.push({
          reviewId: d.reviewId,
          decision: d.decision,
          ok: false,
          status: resp.status,
          error: resp.errorMessage ?? `HTTP ${resp.status}`,
        });
      }
    } catch (err) {
      results.push({
        reviewId: d.reviewId,
        decision: d.decision,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  return results;
}
