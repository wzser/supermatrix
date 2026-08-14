import { describe, expect, it } from "vitest";
import {
  getLastActivityMessageRunAtFromRows,
  isDailyCommitOperationalPrompt,
  shouldReloadAfterDailyCommit,
  splitDailyCommitResults,
} from "../../src/scripts/daily-commit-activity-gate.js";

describe("daily-commit activity helpers", () => {
  it("does not reload for a hold-only persistence commit", () => {
    expect(shouldReloadAfterDailyCommit([{ committed: true, holdOnly: true }])).toBe(false);
    expect(shouldReloadAfterDailyCommit([{ committed: true, holdOnly: false }])).toBe(true);
  });
  it("filters daily-commit operational prompts out of activity detection", () => {
    expect(isDailyCommitOperationalPrompt("[定时任务 localgit-daily-commit] scheduler ...")).toBe(true);
    expect(isDailyCommitOperationalPrompt("please run the Daily Commit review")).toBe(true);
    expect(isDailyCommitOperationalPrompt("修一下补货脚本的 bug")).toBe(false);
  });

  it("returns the newest non-operational message run", () => {
    expect(
      getLastActivityMessageRunAtFromRows([
        { started_at: 3000, prompt: "npm run daily-commit per schedule" },
        { started_at: 2000, prompt: "real user work" },
        { started_at: 1000, prompt: "older user work" },
      ]),
    ).toBe(2000);
    expect(getLastActivityMessageRunAtFromRows([{ started_at: 3000, prompt: "daily commit run" }])).toBeNull();
  });

  it("splits results into committed / skipped / deferred / localgit-owned buckets", () => {
    const results = [
      { committed: true },
      { committed: false, deferred: true },
      { committed: false, localgitOwned: true },
      { committed: false },
    ];
    const split = splitDailyCommitResults(results);
    expect(split.committed.length).toBe(1);
    expect(split.deferred.length).toBe(1);
    expect(split.localgitOwned.length).toBe(1);
    expect(split.skipped.length).toBe(1);
  });

  it("reloads only when at least one repo committed", () => {
    expect(shouldReloadAfterDailyCommit([{ committed: false, deferred: true }])).toBe(false);
    expect(shouldReloadAfterDailyCommit([{ committed: false }, { committed: true }])).toBe(true);
  });
});
