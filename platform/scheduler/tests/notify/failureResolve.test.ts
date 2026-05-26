import { describe, it, expect, vi } from "vitest";
import { resolveFailure } from "../../src/notify/failureResolve.js";
import type { Task } from "../../src/db/taskStore.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "test-task",
    description: "",
    cron: "0 0 * * *",
    executor: "shell",
    config: { command: "echo hi", cwd: "/tmp", timeout: 1000 },
    enabled: true,
    oneshot: false,
    notifyOnFailure: true,
    nextRunAt: null,
    lastSuccessAt: null,
    createdBy: "amz-sql",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<Parameters<typeof resolveFailure>[3]> = {}) {
  return {
    spawnCall: vi.fn().mockResolvedValue('{"status":"fixed","summary":"patched the script"}'),
    executeByTask: vi.fn().mockResolvedValue({ success: true, output: "ok", error: null }),
    notifier: { notifyFailure: vi.fn().mockResolvedValue(undefined) },
    store: {
      createRun: vi.fn().mockReturnValue({ id: "run-2" }),
      completeRun: vi.fn(),
      updateLastSuccess: vi.fn(),
      refreshNextRun: vi.fn(),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("resolveFailure", () => {
  it("suppresses Feishu when session fixes and verify succeeds", async () => {
    const task = makeTask();
    const deps = makeDeps();
    const originalResult = { success: false, output: "", error: "traceback" };

    await resolveFailure(task, originalResult, "run-orig", deps);

    expect(deps.spawnCall).toHaveBeenCalledOnce();
    expect(deps.spawnCall.mock.calls[0][0]).toBe("amz-sql");
    expect(deps.executeByTask).toHaveBeenCalledWith(task);
    expect(deps.store.createRun).toHaveBeenCalledWith("task-1");
    expect(deps.store.completeRun).toHaveBeenCalledWith("run-2", "success", "ok", null);
    expect(deps.store.updateLastSuccess).toHaveBeenCalledWith("task-1");
    expect(deps.notifier.notifyFailure).not.toHaveBeenCalled();
  });

  it("escalates to Feishu when verify fails after session claims fixed", async () => {
    const task = makeTask();
    const deps = makeDeps({
      executeByTask: vi.fn().mockResolvedValue({ success: false, output: "", error: "still broken" }),
    });
    const originalResult = { success: false, output: "", error: "traceback" };

    await resolveFailure(task, originalResult, "run-orig", deps);

    expect(deps.notifier.notifyFailure).toHaveBeenCalledOnce();
    const [taskName, errorArg, metadata] = deps.notifier.notifyFailure.mock.calls[0];
    expect(taskName).toBe("test-task");
    expect(errorArg).toContain("traceback");
    expect(errorArg).toContain("[修复后重跑仍失败]");
    expect(errorArg).toContain("patched the script");
    expect(metadata).toEqual({ taskId: "task-1", runId: "run-orig" });
    expect(deps.store.updateLastSuccess).not.toHaveBeenCalled();
  });

  it("escalates to Feishu with cant_fix annotation", async () => {
    const task = makeTask();
    const deps = makeDeps({
      spawnCall: vi.fn().mockResolvedValue('{"status":"cant_fix","summary":"upstream API changed"}'),
    });
    const originalResult = { success: false, output: "", error: "timeout" };

    await resolveFailure(task, originalResult, "run-orig", deps);

    expect(deps.executeByTask).not.toHaveBeenCalled();
    expect(deps.notifier.notifyFailure).toHaveBeenCalledOnce();
    const [, errorArg, metadata] = deps.notifier.notifyFailure.mock.calls[0];
    expect(errorArg).toContain("timeout");
    expect(errorArg).toContain("[无法自动修复]");
    expect(errorArg).toContain("upstream API changed");
    expect(metadata).toEqual({ taskId: "task-1", runId: "run-orig" });
  });

  it("escalates when reply is not valid JSON", async () => {
    const deps = makeDeps({
      spawnCall: vi.fn().mockResolvedValue("I am not JSON"),
    });
    await resolveFailure(makeTask(), { success: false, output: "", error: "e" }, "run-orig", deps);
    expect(deps.notifier.notifyFailure).toHaveBeenCalledOnce();
    expect(deps.notifier.notifyFailure.mock.calls[0][1]).toContain("[协商失败]");
  });

  it("escalates when reply has invalid status", async () => {
    const deps = makeDeps({
      spawnCall: vi.fn().mockResolvedValue('{"status":"maybe"}'),
    });
    await resolveFailure(makeTask(), { success: false, output: "", error: "e" }, "run-orig", deps);
    expect(deps.notifier.notifyFailure).toHaveBeenCalledOnce();
    expect(deps.notifier.notifyFailure.mock.calls[0][1]).toContain("[协商失败]");
  });

  it("escalates when spawnCall throws", async () => {
    const deps = makeDeps({
      spawnCall: vi.fn().mockRejectedValue(new Error("spawn timeout")),
    });
    await resolveFailure(makeTask(), { success: false, output: "", error: "e" }, "run-orig", deps);
    expect(deps.notifier.notifyFailure).toHaveBeenCalledOnce();
    const errorArg = deps.notifier.notifyFailure.mock.calls[0][1];
    expect(errorArg).toContain("[协商失败]");
    expect(errorArg).toContain("spawn timeout");
  });
});
