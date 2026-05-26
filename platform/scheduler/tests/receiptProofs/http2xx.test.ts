import { describe, it, expect } from "vitest";
import { evaluateHttp2xx } from "../../src/receiptProofs/http2xx.js";

describe("http_2xx proof", () => {
  it("pass when status 200", () => {
    expect(evaluateHttp2xx({ httpStatus: 200 }).passed).toBe(true);
  });

  it("pass when status 299", () => {
    expect(evaluateHttp2xx({ httpStatus: 299 }).passed).toBe(true);
  });

  it("fail when status 300", () => {
    expect(evaluateHttp2xx({ httpStatus: 300 }).passed).toBe(false);
  });

  it("fail when status 500", () => {
    expect(evaluateHttp2xx({ httpStatus: 500 }).passed).toBe(false);
  });

  it("fail retriably when status undefined (response not yet received)", () => {
    const r = evaluateHttp2xx({ httpStatus: undefined });
    expect(r.passed).toBe(false);
    expect(r.retriable).toBe(true);
  });
});
