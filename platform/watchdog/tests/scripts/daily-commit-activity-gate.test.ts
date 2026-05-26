import { describe, expect, it } from "vitest";
import {
  DAILY_COMMIT_ACTIVITY_WINDOW_MS,
  decideDailyCommitActivityGate,
  filterActivityRelevantDirtyFiles,
  getLastActivityMessageRunAtFromRows,
  isDailyCommitOperationalPrompt,
  splitDailyCommitResults,
} from "../../src/scripts/daily-commit-activity-gate.js";

const NOW = 1_779_153_000_000;
const OLD = NOW - DAILY_COMMIT_ACTIVITY_WINDOW_MS - 1;
const RECENT = NOW - DAILY_COMMIT_ACTIVITY_WINDOW_MS + 1;

describe("daily-commit activity gate", () => {
  it("defers an inactive repo whose dirty files are also stale", () => {
    const decision = decideDailyCommitActivityGate({
      now: NOW,
      lastMessageRunAt: OLD,
      latestDirtyMtime: OLD,
      repoName: "stale-session",
    });

    expect(decision.kind).toBe("defer");
    expect(decision.reason).toContain("deferred: inactive session");
    expect(decision.reason).toContain("24h");
  });

  it("processes a stale dirty set when the session had a recent message", () => {
    expect(
      decideDailyCommitActivityGate({
        now: NOW,
        lastMessageRunAt: RECENT,
        latestDirtyMtime: OLD,
        repoName: "active-session",
      }),
    ).toEqual({ kind: "process" });
  });

  it("processes a repo with recent dirty-file mtime even when the session is quiet", () => {
    expect(
      decideDailyCommitActivityGate({
        now: NOW,
        lastMessageRunAt: OLD,
        latestDirtyMtime: RECENT,
        repoName: "background-writer",
      }),
    ).toEqual({ kind: "process" });
  });

  it("defers repos with no message history and no readable dirty mtime", () => {
    const decision = decideDailyCommitActivityGate({
      now: NOW,
      lastMessageRunAt: null,
      latestDirtyMtime: null,
      repoName: "never-spoken",
    });

    expect(decision.kind).toBe("defer");
  });

  it("does not route deferred repos as skipped owner hints", () => {
    const split = splitDailyCommitResults([
      { committed: true },
      { committed: false },
      { committed: false, deferred: true },
      { committed: false, watchdogOwned: true },
    ]);

    expect(split.committed).toHaveLength(1);
    expect(split.skipped).toHaveLength(1);
    expect(split.deferred).toHaveLength(1);
    expect(split.watchdogOwned).toHaveLength(1);
  });

  it("ignores daily-commit operational prompts when finding recent activity", () => {
    const rows = [
      {
        started_at: RECENT,
        prompt:
          "[daily-commit hint · 2026-05-19]\n你的 repo \"after-sales\" 今早自动提交被跳过。",
      },
      {
        started_at: RECENT - 1,
        prompt: "上次 mr_5cf4799a 是临时 rate limit，继续重试这次 daily-commit 吧。",
      },
      {
        started_at: OLD,
        prompt: "客户售后邮件需要处理。",
      },
    ];

    expect(rows.slice(0, 2).every((row) => isDailyCommitOperationalPrompt(row.prompt))).toBe(true);
    expect(getLastActivityMessageRunAtFromRows(rows)).toBe(OLD);
  });

  it("does not treat owner-routed data paths as activity-relevant dirty files", () => {
    expect(
      filterActivityRelevantDirtyFiles([
        "data/follow-up.db",
        "data/email-samples/contact_zezut.com.jsonl",
        "src/followup.ts",
        "reports/daily.md",
      ]),
    ).toEqual(["src/followup.ts"]);
  });
});
