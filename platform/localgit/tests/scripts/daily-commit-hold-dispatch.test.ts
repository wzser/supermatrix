import { describe, expect, it } from "vitest";
import {
  buildHoldReviewDispatch,
  spawnHoldReview,
} from "../../src/scripts/daily-commit-hold-dispatch.js";

describe("hold review dispatch", () => {
  it("builds an idempotent owner task with exact branch and files", () => {
    const dispatch = buildHoldReviewDispatch({
      date: "2026-07-14",
      repo: "scheduler",
      repoPath: "/repo/scheduler",
      originalBranch: "main",
      holdBranch: "localgit/hold/scheduler/abc123def456",
      holdCommit: "a".repeat(40),
      dirtyFingerprint: "abc123def4567890",
      files: ["src/a.ts"],
    });

    expect(dispatch.payload.target).toBe("scheduler");
    expect(dispatch.payload.client_request_id).toBe("2026-07-14:localgit:scheduler:hold-review-abc123def456");
    expect(dispatch.payload.prompt).toContain("localgit/hold/scheduler/abc123def456");
    expect(dispatch.payload.prompt).toContain(`--hold-commit ${"a".repeat(40)}`);
    expect(dispatch.payload.prompt).toContain("src/a.ts");
    expect(dispatch.payload.closure.target.type).toBe("todo_pool");
  });

  it("accepts scheduler-style 202 and auditable duplicate 409 receipts", () => {
    const dispatch = buildHoldReviewDispatch({
      date: "2026-07-14", repo: "scheduler", repoPath: "/repo/scheduler", originalBranch: "main",
      holdBranch: "localgit/hold/scheduler/abc123def456", holdCommit: "a".repeat(40),
      dirtyFingerprint: "abc123def4567890", files: ["src/a.ts"],
    });
    expect(spawnHoldReview(dispatch, { runCommand: () => '{"ok":true,"mode":"async_kickoff","closure":"todo_pool","ref":"x","spawnCommId":"comm_x"}\n202' }).accepted).toBe(true);
    expect(spawnHoldReview(dispatch, { runCommand: () => '{"duplicate":true,"existing":{"commId":"comm_x","status":"pending"}}\n409' }).accepted).toBe(true);
  });

  it("rejects a duplicate whose original spawn failed", () => {
    const dispatch = buildHoldReviewDispatch({
      date: "2026-07-14", repo: "scheduler", repoPath: "/repo/scheduler", originalBranch: "main",
      holdBranch: "localgit/hold/scheduler/abc123def456", holdCommit: "a".repeat(40),
      dirtyFingerprint: "abc123def4567890", files: ["src/a.ts"],
    });
    expect(() => spawnHoldReview(dispatch, {
      runCommand: () => '{"duplicate":true,"existing":{"commId":"comm_x","status":"failed"}}\n409',
    })).toThrow("HTTP 409");
  });
});
