import { describe, it, expect } from "vitest";
import { evaluateExitZero } from "../../src/receiptProofs/exitZero.js";

describe("exit_zero proof", () => {
  it("pass when process exit code is 0", () => {
    const result = evaluateExitZero({ exitCode: 0 });
    expect(result.passed).toBe(true);
  });

  it("fail when exit code is non-zero", () => {
    const result = evaluateExitZero({ exitCode: 1 });
    expect(result.passed).toBe(false);
    expect(result.evidence).toEqual({ exitCode: 1 });
  });

  it("fail when process is still running (exitCode null)", () => {
    const result = evaluateExitZero({ exitCode: null });
    expect(result.passed).toBe(false);
    expect(result.retriable).toBe(true);
  });
});
