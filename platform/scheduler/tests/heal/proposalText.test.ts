import { describe, it, expect } from "vitest";
import { renderProposalText } from "../../src/heal/proposalText.js";

describe("renderProposalText", () => {
  it("includes task name, run id, reason, and action menu", () => {
    const text = renderProposalText({
      taskName: "amzdata-daily-inspection",
      runId: "run-abc",
      reason: "evidence_missing",
      triggeredAt: Date.UTC(2026, 3, 23, 1, 40, 0),
      evidence: { exitCode: 0, note: "SQL count returned 0" },
      idempotency: "non",
    });
    expect(text).toContain("amzdata-daily-inspection");
    expect(text).toContain("run-abc");
    expect(text).toContain("evidence_missing");
    expect(text).toContain("ACTION:");
    expect(text).toContain("RETRY");
    expect(text).toContain("SKIP");
    expect(text).toContain("DISABLE");
    expect(text).toContain("ADJUST");
  });

  it("includes evidence JSON in body", () => {
    const text = renderProposalText({
      taskName: "x",
      runId: "r",
      reason: "evidence_missing",
      triggeredAt: 1,
      evidence: { foo: "bar" },
      idempotency: "pure",
    });
    expect(text).toContain("foo");
    expect(text).toContain("bar");
  });

  it("annotates default action for non-idempotent tasks", () => {
    const text = renderProposalText({
      taskName: "x",
      runId: "r",
      reason: "evidence_missing",
      triggeredAt: 1,
      evidence: {},
      idempotency: "non",
    });
    expect(text).toMatch(/默认.*SKIP/);
  });

  it("annotates default action for pure tasks as RETRY", () => {
    const text = renderProposalText({
      taskName: "x",
      runId: "r",
      reason: "evidence_missing",
      triggeredAt: 1,
      evidence: {},
      idempotency: "pure",
    });
    expect(text).toMatch(/默认.*RETRY/);
  });

  it("documents PATCH block format for ADJUST self-apply", () => {
    const text = renderProposalText({
      taskName: "x",
      runId: "r",
      reason: "evidence_missing",
      triggeredAt: 1,
      evidence: {},
      idempotency: "non",
    });
    expect(text).toContain("PATCH:");
    expect(text).toContain("expectedDurationMs");
    expect(text).toContain("overrides");
  });
});
