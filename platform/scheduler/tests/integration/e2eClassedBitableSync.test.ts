import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { runVerification } from "../../src/verify/runner.js";
import { taskToFields } from "../../src/sync/bitable.js";
import type { Task, TaskRun } from "../../src/db/taskStore.js";

describe("E2E: classed task Bitable sync", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("classed sync_job success → sync fires with new fields populated", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "e2e-classed-sync",
      cron: "0 2 * * *",
      executor: "shell",
      config: { command: "python", cwd: "/tmp", timeout: 60_000 },
      class: "sync_job",
      expectedDurationMs: 1_800_000,
      ownerSession: "amz-sql",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);

    let captured: { task?: Task; latestRun?: TaskRun } = {};
    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      syncTask: async (t, latest) => {
        captured = { task: t, latestRun: latest };
      },
    });

    expect(captured.task?.class).toBe("sync_job");
    expect(captured.latestRun?.finalStatus).toBe("success");

    const fields = taskToFields(captured.task!, captured.latestRun);
    expect(fields["任务分类"]).toBe("sync_job");
    expect(fields["预期时长(分钟)"]).toBe(30);
    expect(fields["Owner session"]).toBe("amz-sql");
    expect(fields["最近运行状态"]).toBe("success");
    expect(fields["覆盖配置"]).toContain("exit_zero");

    // last_success_at written transitively via updateRunFinal
    expect(captured.task?.lastSuccessAt).toBe(fields["上次成功执行"]);
    expect(captured.task?.lastSuccessAt).not.toBeNull();
  });
});
