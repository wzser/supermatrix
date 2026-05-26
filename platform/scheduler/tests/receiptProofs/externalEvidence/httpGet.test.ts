import { describe, it, expect } from "vitest";
import { evaluateHttpGet } from "../../../src/receiptProofs/externalEvidence/httpGet.js";

function makeFetch(status: number) {
  return async () => new Response(null, { status });
}

describe("evaluateHttpGet", () => {
  it("passes when status in 2xx and expectation >= 200", async () => {
    const r = await evaluateHttpGet({
      target: { url: "http://x/y" },
      expectation: ">= 200",
      triggeredAt: 0,
      fetchImpl: makeFetch(204) as unknown as typeof fetch,
    });
    expect(r.passed).toBe(true);
  });

  it("fails when status fails comparator", async () => {
    const r = await evaluateHttpGet({
      target: { url: "http://x/y" },
      expectation: "== 200",
      triggeredAt: 0,
      fetchImpl: makeFetch(500) as unknown as typeof fetch,
    });
    expect(r.passed).toBe(false);
  });

  it("treats 5xx as retriable when expectation is >= 200", async () => {
    const r = await evaluateHttpGet({
      target: { url: "http://x/y" },
      expectation: ">= 200",
      triggeredAt: 0,
      fetchImpl: makeFetch(503) as unknown as typeof fetch,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
  });

  it("returns evidence.error on missing target.url", async () => {
    const r = await evaluateHttpGet({
      target: {},
      expectation: ">= 200",
      triggeredAt: 0,
      fetchImpl: makeFetch(200) as unknown as typeof fetch,
    });
    expect(r.passed).toBe(false);
    expect(r.evidence).toHaveProperty("note");
  });

  it("returns retriable=true on network error", async () => {
    const r = await evaluateHttpGet({
      target: { url: "http://x/y" },
      expectation: ">= 200",
      triggeredAt: 0,
      fetchImpl: (async () => {
        throw new Error("ENETUNREACH");
      }) as unknown as typeof fetch,
    });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
  });
});
