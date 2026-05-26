import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createExitTracker } from "../../src/lifecycle/exitTracker.js";
import { runTaskNew, wireUpVerifyScheduler } from "../../src/main.js";
import { createVerifyStore } from "../../src/verify/store.js";

describe("E2E: shell monitoring task with exit_zero proof", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("full success lifecycle", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const exitTracker = createExitTracker();

    const task = taskStore.createTask({
      name: "e2e-shell",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo hi && exit 0", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 1000,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });

    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: (runId) => exitTracker.lookup(runId),
      tickIntervalMs: 100,
    });

    await runTaskNew(task, { taskStore, verifyStore, exitTracker });
    await new Promise((r) => setTimeout(r, 2500));

    const runs = taskStore.listRuns(task.id, 10);
    expect(runs.length).toBe(1);
    expect(runs[0].finalStatus).toBe("success");
    expect(runs[0].verifyStatus).toBe("pass");
    stop();
  });

  it("evidence_missing when command exits non-zero", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const exitTracker = createExitTracker();

    const task = taskStore.createTask({
      name: "e2e-fail",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "exit 42", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 500,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });

    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: (runId) => exitTracker.lookup(runId),
      tickIntervalMs: 100,
    });

    await runTaskNew(task, { taskStore, verifyStore, exitTracker });
    await new Promise((r) => setTimeout(r, 2000));

    const runs = taskStore.listRuns(task.id, 10);
    expect(runs[0].finalStatus).toBe("evidence_missing");
    stop();
  });
});
