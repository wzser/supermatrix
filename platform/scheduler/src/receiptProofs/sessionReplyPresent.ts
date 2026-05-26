import type { ProofResult } from "./types.js";

type Deps = {
  childSessionId: string | null | undefined;
  asyncRef?: string | null;
  smBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs: number;
};

async function resolveAsyncRef(
  asyncRef: string,
  base: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const url = `${base}/api/spawn_async_items/${asyncRef}`;
  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.childSessionId === "string" && body.childSessionId.length > 0) {
      return body.childSessionId;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkSessionReplyPresent(
  childSessionId: string,
  deps: Deps,
): Promise<ProofResult> {
  const base = deps.smBaseUrl ?? "http://localhost:3501";
  const fetchFn = deps.fetchImpl ?? fetch;
  const url = `${base}/api/sessions/${childSessionId}/result`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(Math.min(deps.timeoutMs, 30_000)),
    });
  } catch (err) {
    return {
      passed: false,
      retriable: true,
      evidence: { note: "poll network error", error: String(err) },
    };
  }

  if (res.status === 202) {
    return { passed: false, retriable: true, evidence: { status: "running" } };
  }
  if (res.status >= 500) {
    return { passed: false, retriable: false, evidence: { status: res.status, note: "sm 5xx (likely timeout)" } };
  }
  if (!res.ok) {
    return { passed: false, retriable: false, evidence: { status: res.status } };
  }

  let body: { status?: string; finalMessage?: string | null; errorMessage?: string | null };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { passed: false, retriable: false, evidence: { note: "non-json body" } };
  }
  if (body.status === "running") {
    return { passed: false, retriable: true, evidence: { status: "running" } };
  }
  if (body.status === "failed" || body.status === "timeout") {
    return { passed: false, retriable: false, evidence: { status: body.status, errorMessage: body.errorMessage } };
  }
  const finalMessage = typeof body.finalMessage === "string" ? body.finalMessage.trim() : "";
  if (finalMessage.length > 0) {
    return { passed: true, retriable: false, evidence: { finalMessageLength: finalMessage.length } };
  }
  return {
    passed: false,
    retriable: false,
    evidence: { note: "completed but finalMessage empty" },
  };
}

export async function evaluateSessionReplyPresent(deps: Deps): Promise<ProofResult> {
  if (deps.childSessionId) {
    return checkSessionReplyPresent(deps.childSessionId, deps);
  }
  if (!deps.asyncRef) {
    return { passed: false, retriable: false, evidence: { note: "no childSessionId on run" } };
  }
  const base = deps.smBaseUrl ?? "http://localhost:3501";
  const fetchFn = deps.fetchImpl ?? fetch;
  const resolvedId = await resolveAsyncRef(deps.asyncRef, base, fetchFn, deps.timeoutMs);
  if (resolvedId) {
    return checkSessionReplyPresent(resolvedId, deps);
  }
  return { passed: false, retriable: true, evidence: { note: "switched_async not yet resolved", asyncRef: deps.asyncRef } };
}
