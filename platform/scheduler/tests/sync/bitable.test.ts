import { describe, it, expect } from "vitest";
import { taskToFields } from "../../src/sync/bitable.js";
import type { Task, TaskRun } from "../../src/db/taskStore.js";

function makeLegacyTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    name: "legacy-task",
    description: "",
    cron: "0 * * * *",
    executor: "shell",
    config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    enabled: true,
    oneshot: false,
    notifyOnFailure: false,
    nextRunAt: null,
    lastSuccessAt: null,
    createdBy: "owner-a",
    createdAt: 0,
    updatedAt: 0,
    class: null,
    expectedDurationMs: null,
    overlapPolicy: null,
    ownerSession: null,
    overrides: null,
    migrationEscalationStage: 0,
    ...overrides,
  };
}

function makeClassedTask(overrides: Partial<Task> = {}): Task {
  return makeLegacyTask({
    class: "sync_job",
    expectedDurationMs: 1_800_000,
    overlapPolicy: "skip_if_running",
    ownerSession: "amz-sql",
    migrationEscalationStage: 0,
    ...overrides,
  });
}

describe("taskToFields", () => {
  it("legacy task (class=null) still emits all old fields", () => {
    const fields = taskToFields(makeLegacyTask());
    expect(fields["任务ID"]).toBe("t1");
    expect(fields["任务名"]).toBe("legacy-task");
    expect(fields["执行器"]).toBe("shell");
    expect(fields["状态"]).toBe("启用");
    expect(fields["任务分类"]).toBe("未迁移");
  });

  it("classed task emits class + expectedDuration + owner + overlap + escalation fields", () => {
    const fields = taskToFields(
      makeClassedTask({ overrides: { receiptProof: { kind: "exit_zero" } } })
    );
    expect(fields["任务分类"]).toBe("sync_job");
    expect(fields["预期时长(分钟)"]).toBe(30);
    expect(fields["Owner session"]).toBe("amz-sql");
    expect(fields["并发策略"]).toBe("skip_if_running");
    expect(fields["迁移阶段"]).toBe(0);
    expect(fields["覆盖配置"]).toContain("exit_zero");
  });

  it("classed task with no overrides emits empty string for 覆盖配置", () => {
    const fields = taskToFields(makeClassedTask());
    expect(fields["覆盖配置"]).toBe("");
  });

  it("latest run snapshot surfaces trigger/verify/final status separately", () => {
    const latestRun: TaskRun = {
      id: "r1",
      taskId: "t1",
      startedAt: 1000,
      finishedAt: 5000,
      status: "success",
      output: null,
      error: null,
      triggerStatus: "ok",
      triggeredAt: 2000,
      runningPid: null,
      childSessionId: null,
      childMessageRunId: null,
      processExitedAt: null,
      verifyStatus: "pass",
      verifyAttempts: 0,
      receiptEvidence: null,
      finalStatus: "success",
    };
    const fields = taskToFields(makeClassedTask(), latestRun);
    expect(fields["最近触发状态"]).toBe("ok");
    expect(fields["最近验证状态"]).toBe("pass");
    expect(fields["最近运行状态"]).toBe("success");
    expect(fields["最近触发时间"]).toBe(2000);
  });

  it("evidence_missing run surfaces trigger=ok + verify=fail separately (two-axis visibility)", () => {
    const latestRun: TaskRun = {
      id: "r2", taskId: "t1", startedAt: 1000, finishedAt: 5000,
      status: "failed", output: null, error: null,
      triggerStatus: "ok", triggeredAt: 2000,
      runningPid: null, childSessionId: null, childMessageRunId: null,
      processExitedAt: null,
      verifyStatus: "fail", verifyAttempts: 3,
      receiptEvidence: null, finalStatus: "evidence_missing",
    };
    const fields = taskToFields(makeClassedTask(), latestRun);
    expect(fields["最近触发状态"]).toBe("ok");        // 进程起来了
    expect(fields["最近验证状态"]).toBe("fail");      // 但凭证没过
    expect(fields["最近运行状态"]).toBe("evidence_missing");
  });

  it("latest run omitted → all three status fields fall back to 无", () => {
    const fields = taskToFields(makeClassedTask());
    expect(fields["最近触发状态"]).toBe("无");
    expect(fields["最近验证状态"]).toBe("无");
    expect(fields["最近运行状态"]).toBe("无");
    expect(fields["最近触发时间"]).toBeNull();
  });

  it("migrationEscalationStage=1 surfaces as numeric 1", () => {
    const fields = taskToFields(makeLegacyTask({ migrationEscalationStage: 1 }));
    expect(fields["迁移阶段"]).toBe(1);
  });
});
