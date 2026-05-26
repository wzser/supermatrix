import { describe, it, expect, vi } from "vitest";
import { runDecisions, type ApplyFn } from "../../src/review/runner.js";
import type { ParsedDecision } from "../../src/review/replyParser.js";

describe("runDecisions", () => {
  function mockApply(responses: Array<{ ok: boolean; status: number; errorMessage?: string }>): ApplyFn {
    const queue = [...responses];
    return vi.fn(async () => queue.shift() ?? { ok: false, status: 500, errorMessage: "no response left" });
  }

  it("dispatches approved → /approve", async () => {
    const apply = mockApply([{ ok: true, status: 200 }]);
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "approved", reason: "fine" },
    ];
    const results = await runDecisions({ decisions, applyFn: apply });
    expect(apply).toHaveBeenCalledWith("/proposals/creation/r1/approve", { reason: "fine" });
    expect(results).toEqual([{ reviewId: "r1", decision: "approved", ok: true, status: 200 }]);
  });

  it("dispatches patched → /patch with body", async () => {
    const apply = mockApply([{ ok: true, status: 200 }]);
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "patched", reason: "cron too dense", patch: { cron: "*/5 * * * *" } },
    ];
    await runDecisions({ decisions, applyFn: apply });
    expect(apply).toHaveBeenCalledWith("/proposals/creation/r1/patch", {
      reason: "cron too dense",
      patch: { cron: "*/5 * * * *" },
    });
  });

  it("dispatches rejected with default disable=true → /reject", async () => {
    const apply = mockApply([{ ok: true, status: 200 }]);
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "rejected", reason: "bad", disable: true },
    ];
    await runDecisions({ decisions, applyFn: apply });
    expect(apply).toHaveBeenCalledWith("/proposals/creation/r1/reject", {
      reason: "bad",
      disable: true,
    });
  });

  it("dispatches escalated → /escalate", async () => {
    const apply = mockApply([{ ok: true, status: 200 }]);
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "escalated", reason: "unclear" },
    ];
    await runDecisions({ decisions, applyFn: apply });
    expect(apply).toHaveBeenCalledWith("/proposals/creation/r1/escalate", { reason: "unclear" });
  });

  it("continues on per-decision failure and reports each result", async () => {
    const apply = mockApply([
      { ok: true, status: 200 },
      { ok: false, status: 400, errorMessage: "already decided" },
      { ok: true, status: 200 },
    ]);
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "approved", reason: "fine" },
      { reviewId: "r2", decision: "rejected", reason: "bad", disable: true },
      { reviewId: "r3", decision: "escalated", reason: "huh" },
    ];
    const results = await runDecisions({ decisions, applyFn: apply });
    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("already decided");
    expect(results[2].ok).toBe(true);
  });

  it("catches thrown errors and records them", async () => {
    const apply: ApplyFn = async () => { throw new Error("boom"); };
    const decisions: ParsedDecision[] = [
      { reviewId: "r1", decision: "approved", reason: "fine" },
    ];
    const results = await runDecisions({ decisions, applyFn: apply });
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain("boom");
  });

  it("returns empty for empty decisions", async () => {
    const apply = mockApply([]);
    const results = await runDecisions({ decisions: [], applyFn: apply });
    expect(results).toEqual([]);
  });
});
