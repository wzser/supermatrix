import type { ProofResult } from "../types.js";
import { parseExpectation, evaluateNumeric } from "./expectation.js";

type Deps = {
  target: Record<string, unknown>;
  expectation: string;
  triggeredAt: number;
  fetchImpl?: typeof fetch;
};

export async function evaluateHttpGet(deps: Deps): Promise<ProofResult> {
  const url = typeof deps.target.url === "string" ? deps.target.url : undefined;
  if (!url) {
    return { passed: false, retriable: false, evidence: { note: "http_get engine requires target.url" } };
  }

  let exp;
  try {
    exp = parseExpectation(deps.expectation);
  } catch (err) {
    return { passed: false, retriable: false, evidence: { note: "invalid expectation", error: String(err) } };
  }
  if (exp.kind !== "numeric") {
    return { passed: false, retriable: false, evidence: { note: "http_get engine only supports numeric expectations on status code" } };
  }

  const fetchFn = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { passed: false, retriable: true, evidence: { note: "network error", error: String(err) } };
  }
  const status = res.status;

  // If 5xx, treat as transient regardless of expectation.
  if (status >= 500 && status < 600) {
    return { passed: false, retriable: true, evidence: { status, note: "5xx transient" } };
  }

  const ok = evaluateNumeric(status, exp);
  if (ok) return { passed: true, retriable: false, evidence: { status } };

  return { passed: false, retriable: false, evidence: { status } };
}
