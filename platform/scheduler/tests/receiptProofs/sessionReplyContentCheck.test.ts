import { describe, it, expect } from "vitest";
import { evaluateSessionReplyContentCheck } from "../../src/receiptProofs/sessionReplyContentCheck.js";

function makeFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}
const completedBody = (assistantText: string) => ({
  ok: true,
  status: "completed",
  finalMessage: assistantText,
});

describe("evaluateSessionReplyContentCheck", () => {
  it("matches contains pattern", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(200, completedBody("Here is the REPORT: 42 lines")) as unknown as typeof fetch,
      pattern: "REPORT:",
      patternType: "contains",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(true);
  });

  it("rejects when contains pattern missing", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(200, completedBody("done, nothing to say")) as unknown as typeof fetch,
      pattern: "REPORT:",
      patternType: "contains",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
  });

  it("matches regex pattern", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(200, completedBody("processed 123 rows")) as unknown as typeof fetch,
      pattern: "^processed \\d+ rows$",
      patternType: "regex",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(true);
  });

  it("rejects invalid regex without throwing", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(200, completedBody("anything")) as unknown as typeof fetch,
      pattern: "[",
      patternType: "regex",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });

  it("passes through retriable when session still running", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(202, { status: "running" }) as unknown as typeof fetch,
      pattern: "REPORT:",
      patternType: "contains",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
  });

  it("json_path returns non-retriable for now (v2)", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: "c1",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(200, completedBody("whatever")) as unknown as typeof fetch,
      pattern: "$.foo",
      patternType: "json_path",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });

  it("returns retriable when childSessionId missing but asyncRef present (switched_async unresolved)", async () => {
    const r = await evaluateSessionReplyContentCheck({
      childSessionId: null,
      asyncRef: "async_abc-123",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(404, { error: "not found" }) as unknown as typeof fetch,
      pattern: "REPORT:",
      patternType: "contains",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
    expect(r.evidence).toHaveProperty("asyncRef", "async_abc-123");
  });

  it("resolves asyncRef then checks content when resolution succeeds", async () => {
    // First call: resolveAsyncRef → returns resolved childSessionId
    // Second call: /api/sessions/resolved-id/result → returns completed body
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ childSessionId: "sess_child_xyz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(completedBody("REPORT: all good")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const r = await evaluateSessionReplyContentCheck({
      childSessionId: null,
      asyncRef: "async_abc-123",
      smBaseUrl: "http://sm",
      fetchImpl,
      pattern: "REPORT:",
      patternType: "contains",
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(true);
    expect(callCount).toBe(2);
  });
});
