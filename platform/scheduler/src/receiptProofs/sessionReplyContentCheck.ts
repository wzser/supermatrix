import type { ProofResult } from "./types.js";

type Deps = {
  childSessionId: string | null | undefined;
  asyncRef?: string | null;
  smBaseUrl?: string;
  fetchImpl?: typeof fetch;
  pattern: string;
  patternType: "contains" | "regex" | "json_path";
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

async function checkSessionReply(
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
    return { passed: false, retriable: true, evidence: { note: "poll network error", error: String(err) } };
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
  const content = typeof body.finalMessage === "string" ? body.finalMessage : "";
  if (!content) {
    return { passed: false, retriable: false, evidence: { note: "no finalMessage to check" } };
  }

  if (deps.patternType === "contains") {
    return content.includes(deps.pattern)
      ? { passed: true, retriable: false, evidence: { matched: "contains", pattern: deps.pattern } }
      : { passed: false, retriable: false, evidence: { note: "pattern not found", pattern: deps.pattern } };
  }
  if (deps.patternType === "regex") {
    let re: RegExp;
    try {
      re = new RegExp(deps.pattern);
    } catch (err) {
      return { passed: false, retriable: false, evidence: { note: "invalid regex", error: String(err) } };
    }
    return re.test(content)
      ? { passed: true, retriable: false, evidence: { matched: "regex", pattern: deps.pattern } }
      : { passed: false, retriable: false, evidence: { note: "regex did not match", pattern: deps.pattern } };
  }
  return {
    passed: false,
    retriable: false,
    evidence: { note: "json_path patternType reserved for future; treat as evidence_missing" },
  };
}

export async function evaluateSessionReplyContentCheck(deps: Deps): Promise<ProofResult> {
  const asyncRef = deps.asyncRef ??
    (typeof deps.childSessionId === "string" && deps.childSessionId.startsWith("async_")
      ? deps.childSessionId
      : null);

  if (asyncRef) {
    const base = deps.smBaseUrl ?? "http://localhost:3501";
    const fetchFn = deps.fetchImpl ?? fetch;
    const resolvedId = await resolveAsyncRef(asyncRef, base, fetchFn, deps.timeoutMs);
    if (resolvedId) {
      return checkSessionReply(resolvedId, deps);
    }
    return {
      passed: false,
      retriable: true,
      evidence: { note: "switched_async not yet resolved", asyncRef },
    };
  }

  if (deps.childSessionId) {
    return checkSessionReply(deps.childSessionId, deps);
  }
  return { passed: false, retriable: false, evidence: { note: "no childSessionId on run" } };
}
