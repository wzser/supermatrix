import { describe, expect, it } from "vitest";
import { formatRunHealthLine, summarizeRunHealth } from "../../src/scripts/daily-commit-run-health.js";
import { FAST_PATH_REASON, type FileDisposition } from "../../src/scripts/daily-commit-judgment-matrix.js";

const fastPath = (file: string): FileDisposition => ({
  file,
  class: "source",
  verdict: "SAFE",
  reason: FAST_PATH_REASON,
  source: "l0",
});

describe("daily-commit run health summary", () => {
  it("counts fast-path files only when the repo actually committed", () => {
    const health = summarizeRunHealth([
      { committed: true, dispositions: [fastPath("src/a.ts"), fastPath("sop/b.md")] },
      // Judged safe but the commit never landed — must not be reported as carried.
      { committed: false, dispositions: [fastPath("src/c.ts")] },
    ]);
    expect(health.fastPathCommitted).toBe(2);
  });

  it("separates reviewer failures that still landed a safe subset (2026-08-05 case)", () => {
    const health = summarizeRunHealth([
      {
        committed: true,
        reviewerFailure: "blocked: ... ETIMEDOUT",
        dispositions: [
          fastPath("src/a.ts"),
          { file: "x.md", class: "source", verdict: "UNREVIEWED", source: "l2-fresh" },
        ],
      },
      {
        committed: false,
        reviewerFailure: "blocked: ... ETIMEDOUT",
        dispositions: [{ file: "y.md", class: "source", verdict: "UNREVIEWED", source: "l2-fresh" }],
      },
    ]);
    expect(health.reviewerFailures).toBe(2);
    expect(health.partialAfterReviewerFailure).toBe(1);
    expect(health.unreviewed).toBe(2);
    expect(health.fastPathCommitted).toBe(1);
  });

  it("renders a one-line card summary carrying every mechanism signal", () => {
    const line = formatRunHealthLine({
      fastPathCommitted: 54,
      reviewerFailures: 2,
      partialAfterReviewerFailure: 1,
      pendingOwner: 14978,
      unreviewed: 60,
    });
    expect(line).toContain("fast-path 提交 54 文件");
    expect(line).toContain("reviewer 失败 2 仓");
    expect(line).toContain("1 仓仍落库安全子集");
    expect(line).toContain("待复审 60 文件");
    expect(line).toContain("待 owner 裁决 14978 文件");
  });

  it("omits optional clauses on a fully healthy run", () => {
    const line = formatRunHealthLine(summarizeRunHealth([{ committed: true, dispositions: [fastPath("src/a.ts")] }]));
    expect(line).toContain("fast-path 提交 1 文件");
    expect(line).toContain("reviewer 失败 0 仓");
    expect(line).not.toContain("安全子集");
    expect(line).not.toContain("待复审");
  });
});
