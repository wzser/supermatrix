import { describe, it, expect } from "vitest";
import { renderHealCard, isTaskRetired } from "../../src/heal/cardFormat.js";

describe("renderHealCard", () => {
  const base = {
    taskId: "task-123",
    taskName: "daily-bitable-sync",
    taskDescription: "每天同步多维表格的最新业务数据",
    ownerSession: "supermatrix-root",
    triggeredAt: new Date("2026-05-20T04:36:00Z").getTime(),
    reason: "evidence_missing",
    evidence: { exitCode: null, note: "process still running" },
    defaultAction: "SKIP" as const,
  };

  it("owner_unreachable card contains all four required sections", () => {
    const body = renderHealCard({
      ...base,
      scenario: "owner_unreachable",
      ownerStatus: 404,
    });
    expect(body).toContain("daily-bitable-sync");
    expect(body).toContain("每天同步多维表格的最新业务数据"); // 1. 任务目的
    expect(body).toContain("2026-05-20"); // 2. 原计划执行时间
    expect(body).toContain("evidence_missing"); // 3. 当前状态: anomaly
    expect(body).toContain("process still running"); //    + evidence detail
    expect(body).toContain("supermatrix-root"); // 4. 自愈尝试: owner
    expect(body).toContain("404"); //              + status
  });

  it("timeout card surfaces the heal-attempt history (spawn_retry_count, 24h no reply)", () => {
    const body = renderHealCard({
      ...base,
      scenario: "timeout",
      spawnRetryCount: 2,
    });
    expect(body).toContain("24"); // 24h no reply
    expect(body).toContain("supermatrix-root");
    expect(body).toMatch(/retry|2/);
  });

  it("does NOT include the owner-only ACTION reply instructions (Console card is read-only)", () => {
    const body = renderHealCard({
      ...base,
      scenario: "owner_unreachable",
      ownerStatus: 404,
    });
    expect(body).not.toContain("ACTION: ADJUST");
    expect(body).not.toContain("ACTION: RETRY");
    expect(body).not.toContain("回复格式");
    expect(body).not.toContain("RETRY     现在补跑一次");
    expect(body).not.toContain("PATCH: {");
  });

  it("points to the API for manual intervention (since Console can't reply)", () => {
    const body = renderHealCard({
      ...base,
      scenario: "owner_unreachable",
      ownerStatus: 404,
    });
    expect(body).toContain("task-123");
    expect(body).toMatch(/PATCH|localhost:3500\/tasks/);
  });

  it("falls back to a placeholder when task description is empty", () => {
    const body = renderHealCard({
      ...base,
      taskDescription: "",
      scenario: "owner_unreachable",
      ownerStatus: 404,
    });
    expect(body).toContain("无描述");
  });
});

describe("isTaskRetired", () => {
  it("returns true when the task is disabled", () => {
    expect(isTaskRetired({ enabled: false, category: "业务巡检" })).toBe(true);
  });

  it("returns true for retirement categories", () => {
    expect(isTaskRetired({ enabled: true, category: "已完成" })).toBe(true);
    expect(isTaskRetired({ enabled: true, category: "已废弃" })).toBe(true);
    expect(isTaskRetired({ enabled: true, category: "一次性补跑" })).toBe(true);
  });

  it("returns false for an active task in a normal category", () => {
    expect(isTaskRetired({ enabled: true, category: "业务巡检" })).toBe(false);
  });

  it("returns false when both enabled and category null", () => {
    expect(isTaskRetired({ enabled: true, category: null })).toBe(false);
  });
});
