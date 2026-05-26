import { describe, it, expect } from "vitest";
import { computeGraceAction, GRACE_MAX_ATTEMPTS, GRACE_INTERVAL_MS } from "../../src/verify/grace.js";

describe("grace window", () => {
  it("GRACE_MAX_ATTEMPTS is 3", () => {
    expect(GRACE_MAX_ATTEMPTS).toBe(3);
  });

  it("GRACE_INTERVAL_MS is 30min", () => {
    expect(GRACE_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it("on retriable fail with attempts < 3, reschedule at now+30min", () => {
    const now = 1_000_000_000_000;
    const action = computeGraceAction({ passed: false, retriable: true, evidence: {} }, 0, now);
    expect(action.kind).toBe("reschedule");
    expect(action.kind === "reschedule" && action.dueAt).toBe(now + 30 * 60 * 1000);
  });

  it("on retriable fail with attempts = 3, force evidence_missing", () => {
    const action = computeGraceAction({ passed: false, retriable: true, evidence: {} }, 3, Date.now());
    expect(action.kind).toBe("finalize_evidence_missing");
  });

  it("on non-retriable fail, force evidence_missing regardless of attempts", () => {
    const action = computeGraceAction({ passed: false, retriable: false, evidence: {} }, 0, Date.now());
    expect(action.kind).toBe("finalize_evidence_missing");
  });

  it("on pass, finalize success", () => {
    const action = computeGraceAction({ passed: true, retriable: false, evidence: {} }, 1, Date.now());
    expect(action.kind).toBe("finalize_success");
  });
});
