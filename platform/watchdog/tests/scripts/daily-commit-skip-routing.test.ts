import { describe, expect, it } from "vitest";
import { classifyDailyCommitSkipRouting } from "../../src/scripts/daily-commit-skip-routing.js";

describe("daily-commit skip routing", () => {
  it("keeps watchdog-owned infrastructure failures out of owner handoff", () => {
    for (const skippedReason of [
      "processing error: spawnSync codex ETIMEDOUT",
      "skipped: daily-commit time budget (18min) exceeded — codex reviewer likely stalled",
      "daily-commit control fetch failed: sqlite timeout",
      "processing error: spawnSync claude E2BIG",
      "processing error: stdout maxBuffer length exceeded ENOBUFS",
    ]) {
      expect(classifyDailyCommitSkipRouting(skippedReason)).toEqual({
        routeToOwner: false,
        owner: "watchdog",
      });
    }
  });

  it("routes only content decisions that require repo/domain judgment", () => {
    for (const skippedReason of [
      "owner-routed data/ export includes business evidence; repo owner must decide whether to keep or ignore",
      "possible secret in .env.local; owner must rotate or remove before commit",
      "mixed unrelated source and data changes require split commits",
      "codex reviewer judged unsafe: private customer data may be included",
    ]) {
      expect(classifyDailyCommitSkipRouting(skippedReason)).toEqual({
        routeToOwner: true,
        owner: "repo-owner",
      });
    }
  });
});
