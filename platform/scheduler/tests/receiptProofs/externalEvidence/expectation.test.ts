import { describe, it, expect } from "vitest";
import { parseExpectation, evaluateNumeric, evaluateMtimeVsTrigger } from "../../../src/receiptProofs/externalEvidence/expectation.js";

describe("parseExpectation", () => {
  it("parses numeric comparators", () => {
    expect(parseExpectation(">= 1")).toEqual({ kind: "numeric", op: ">=", rhs: 1 });
    expect(parseExpectation("> 0")).toEqual({ kind: "numeric", op: ">", rhs: 0 });
    expect(parseExpectation("== 5")).toEqual({ kind: "numeric", op: "==", rhs: 5 });
    expect(parseExpectation("< 10")).toEqual({ kind: "numeric", op: "<", rhs: 10 });
    expect(parseExpectation("<= 3")).toEqual({ kind: "numeric", op: "<=", rhs: 3 });
  });
  it("parses mtime > trigger", () => {
    expect(parseExpectation("mtime > trigger")).toEqual({ kind: "mtime_gt_trigger" });
  });
  it("throws on garbage", () => {
    expect(() => parseExpectation("totally bogus")).toThrow();
  });
});

describe("evaluateNumeric", () => {
  it("compares correctly", () => {
    expect(evaluateNumeric(5, { kind: "numeric", op: ">=", rhs: 1 })).toBe(true);
    expect(evaluateNumeric(0, { kind: "numeric", op: ">=", rhs: 1 })).toBe(false);
    expect(evaluateNumeric(5, { kind: "numeric", op: "==", rhs: 5 })).toBe(true);
    expect(evaluateNumeric(5, { kind: "numeric", op: "==", rhs: 4 })).toBe(false);
    expect(evaluateNumeric(5, { kind: "numeric", op: "<", rhs: 10 })).toBe(true);
  });
});

describe("evaluateMtimeVsTrigger", () => {
  it("true when mtime > trigger", () => {
    expect(evaluateMtimeVsTrigger(2000, 1000)).toBe(true);
  });
  it("false when mtime <= trigger", () => {
    expect(evaluateMtimeVsTrigger(1000, 1000)).toBe(false);
    expect(evaluateMtimeVsTrigger(500, 1000)).toBe(false);
  });
});
