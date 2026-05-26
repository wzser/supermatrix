import { describe, it, expect } from "vitest";
import { buildProposalText } from "../../src/review/proposalText.js";
import type { CreationReview } from "../../src/review/creationReviewStore.js";

function fixtureReview(id: string, taskId: string, taskName: string): CreationReview {
  return {
    id,
    taskId,
    trigger: "post_create",
    taskSnapshot: { id: taskId, name: taskName, cron: "0 9 * * *", class: "monitoring" },
    l1Report: null,
    status: "pending",
    dispatchedAt: null,
    decidedAt: null,
    decisionReason: null,
    decisionPatch: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("buildProposalText", () => {
  it("includes header with count and SOP reference", () => {
    const text = buildProposalText({ reviews: [fixtureReview("r1", "t1", "alpha")] });
    expect(text).toContain("1 条 task creation");
    expect(text).toContain("sop/creation-review-decisions.md");
  });

  it("includes API endpoints reference (approve/patch/reject/escalate)", () => {
    const text = buildProposalText({ reviews: [fixtureReview("r1", "t1", "alpha")] });
    expect(text).toContain("/proposals/creation/:review_id/approve");
    expect(text).toContain("/proposals/creation/:review_id/patch");
    expect(text).toContain("/proposals/creation/:review_id/reject");
    expect(text).toContain("/proposals/creation/:review_id/escalate");
  });

  it("emits one block per review with review_id / task_id / trigger / snapshot", () => {
    const reviews = [
      fixtureReview("r1", "t1", "alpha"),
      fixtureReview("r2", "t2", "beta"),
    ];
    const text = buildProposalText({ reviews });
    expect(text).toContain("REVIEW #1 of 2");
    expect(text).toContain("REVIEW #2 of 2");
    expect(text).toContain("review_id: r1");
    expect(text).toContain("review_id: r2");
    expect(text).toContain("\"name\": \"alpha\"");
    expect(text).toContain("\"name\": \"beta\"");
  });

  it("uses custom schedulerBaseUrl in API reference", () => {
    const text = buildProposalText({
      reviews: [fixtureReview("r1", "t1", "alpha")],
      schedulerBaseUrl: "http://scheduler-prod:3500",
    });
    expect(text).toContain("http://scheduler-prod:3500");
    expect(text).not.toContain("localhost:3500");
  });

  it("defaults schedulerBaseUrl to localhost:3500 when omitted", () => {
    const text = buildProposalText({ reviews: [fixtureReview("r1", "t1", "alpha")] });
    expect(text).toContain("localhost:3500");
  });

  it("handles empty review list (returns header-only)", () => {
    const text = buildProposalText({ reviews: [] });
    expect(text).toContain("0 条 task creation");
    expect(text).not.toContain("REVIEW #");
  });

  it("serializes taskSnapshot as readable JSON", () => {
    const r = fixtureReview("r1", "t1", "alpha");
    r.taskSnapshot = { name: "x", config: { command: "echo y" } };
    const text = buildProposalText({ reviews: [r] });
    expect(text).toContain("\"command\": \"echo y\"");
  });
});
