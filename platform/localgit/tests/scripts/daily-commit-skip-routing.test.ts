import { describe, expect, it } from "vitest";
import { classifyDailyCommitSkipRouting } from "../../src/scripts/daily-commit-skip-routing.js";

describe("daily-commit skip routing", () => {
  it("keeps localgit-owned infrastructure failures out of owner handoff", () => {
    for (const skippedReason of [
      "processing error: spawnSync /Users/LOCAL_USER/.npm-global/bin/codex ETIMEDOUT",
      "skipped: daily-commit time budget (18min) exceeded — codex reviewer likely stalled",
      "daily-commit session selection failed: sqlite timeout",
      "processing error: spawnSync claude E2BIG",
      "processing error: stdout maxBuffer length exceeded ENOBUFS",
      "blocked: must-review dirty set could not be reviewed by localgit (processing error: spawnSync codex ETIMEDOUT); localgit must retry or improve reviewer capacity before owner routing",
      "blocked: must-review dirty set could not be reviewed by localgit (processing error: ENOENT: no such file or directory, open '/tmp/localgit-daily-codex/last-message.txt'); localgit must retry or improve reviewer capacity before owner routing",
      "blocked: must-review dirty set could not be reviewed by localgit (daily-commit time budget (18min) exceeded); localgit must retry or improve reviewer capacity before owner routing",
      "blocked: stale must-review dirty set queued for localgit review (deferred: inactive session and stale dirty set (> 24h without relevant message or source/config mtime change)); localgit must retry before owner routing",
    ]) {
      expect(classifyDailyCommitSkipRouting(skippedReason)).toEqual({
        routeToOwner: false,
        owner: "localgit",
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

  it("routes unresolved must-review content failures to the repo owner", () => {
    expect(
      classifyDailyCommitSkipRouting(
        "blocked: must-review dirty set could not be reviewed by localgit (safe action needed from repo domain); repo owner must split, verify, and commit or return a safe action",
      ),
    ).toEqual({
      routeToOwner: true,
      owner: "repo-owner",
    });
  });
});
