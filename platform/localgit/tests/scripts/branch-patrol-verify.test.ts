import { describe, expect, it } from "vitest";
import { verifyPatrolRun } from "../../src/scripts/branch-patrol-verify.js";
import type { BranchInventory, PatrolEvidence } from "../../src/scripts/branch-patrol-core.js";

function item(branch: string, klass: BranchInventory["class"] = "C3"): BranchInventory {
  return {
    repo: "scratch", repoPath: "/repo/scratch", branch, trunk: "main", currentBranch: "main",
    class: klass, branchHead: `${branch}-head`, trunkHead: "main-before", ahead: 1, behind: 1,
    ageDays: 2, conflictFiles: [],
  };
}

function row(source: BranchInventory, overrides: Partial<PatrolEvidence> = {}): PatrolEvidence & { run_id: string } {
  return { ...source, action: "report", run_id: "patrol-1", ...overrides };
}

describe("branch patrol verifier", () => {
  it("fails when any allowlisted repo inventory failed", () => {
    const result = verifyPatrolRun({
      runId: "patrol-1",
      inventory: [],
      inventoryErrors: ["broken: git branch failed"],
      evidence: [],
    }, {
      branchHead: () => undefined, trunkHead: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("broken: git branch failed");
  });

  it("fails when an enumerated branch lacks evidence", () => {
    const a = item("feature/a");
    const b = item("feature/b");
    const result = verifyPatrolRun({ runId: "patrol-1", inventory: [a, b], evidence: [row(a)] }, {
      branchHead: () => "unchanged", trunkHead: () => "main-before",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("feature/b");
  });

  it("rejects a C2 action whose live trunk SHA differs", () => {
    const c2 = item("feature/ff", "C2");
    const evidence = row(c2, { action: "fast_forwarded_and_deleted", shaBefore: "main-before", shaAfter: "feature/ff-head" });
    const result = verifyPatrolRun({ runId: "patrol-1", inventory: [c2], evidence: [evidence] }, {
      branchHead: () => undefined, trunkHead: () => "unexpected",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("sha_after");
  });

  it("passes complete report-only evidence", () => {
    const c3 = item("feature/clean");
    const result = verifyPatrolRun({ runId: "patrol-1", inventory: [c3], evidence: [row(c3)] }, {
      branchHead: () => "feature/clean-head", trunkHead: () => "main-before",
    });
    expect(result.ok).toBe(true);
  });
});
