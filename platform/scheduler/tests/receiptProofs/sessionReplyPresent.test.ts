import { describe, it, expect } from "vitest";
import { evaluateSessionReplyPresent } from "../../src/receiptProofs/sessionReplyPresent.js";

function makeFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

describe("evaluateSessionReplyPresent", () => {
  it("returns retriable=true when session still running (202)", async () => {
    const r = await evaluateSessionReplyPresent(
      { childSessionId: "c1", smBaseUrl: "http://sm", fetchImpl: makeFetch(202, { status: "running" }) as unknown as typeof fetch, timeoutMs: 300000 }
    );
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
  });

  it("returns passed=true when completed with non-empty assistant message", async () => {
    const body = { ok: true, status: "completed", finalMessage: "done" };
    const r = await evaluateSessionReplyPresent(
      { childSessionId: "c1", smBaseUrl: "http://sm", fetchImpl: makeFetch(200, body) as unknown as typeof fetch, timeoutMs: 300000 }
    );
    expect(r.passed).toBe(true);
  });

  it("returns passed=false when completed but no assistant content", async () => {
    const body = { ok: true, status: "completed", data: { messages: [{ role: "user", content: "hi" }] } };
    const r = await evaluateSessionReplyPresent(
      { childSessionId: "c1", smBaseUrl: "http://sm", fetchImpl: makeFetch(200, body) as unknown as typeof fetch, timeoutMs: 300000 }
    );
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
  });

  it("returns passed=false and non-retriable on 500 (timeout)", async () => {
    const r = await evaluateSessionReplyPresent(
      { childSessionId: "c1", smBaseUrl: "http://sm", fetchImpl: makeFetch(500, { ok: false, error: "timeout" }) as unknown as typeof fetch, timeoutMs: 300000 }
    );
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
  });

  it("returns passed=false and non-retriable when childSessionId missing and no asyncRef", async () => {
    const r = await evaluateSessionReplyPresent(
      { childSessionId: null, smBaseUrl: "http://sm", fetchImpl: makeFetch(200, {}) as unknown as typeof fetch, timeoutMs: 300000 }
    );
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(false);
  });

  it("returns retriable when childSessionId missing but asyncRef present (switched_async unresolved)", async () => {
    const r = await evaluateSessionReplyPresent({
      childSessionId: null,
      asyncRef: "async_abc-123",
      smBaseUrl: "http://sm",
      fetchImpl: makeFetch(404, { error: "not found" }) as unknown as typeof fetch,
      timeoutMs: 300000,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
    expect(r.evidence).toHaveProperty("asyncRef", "async_abc-123");
  });
});
