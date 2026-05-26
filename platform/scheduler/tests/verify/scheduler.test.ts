import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { startVerifyScheduler } from "../../src/verify/scheduler.js";

describe("verify scheduler tick loop", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("processes due verifications on tick", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const pastDue = Date.now() - 1000;
    verifyStore.scheduleVerification(run.id, pastDue);

    const stop = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      tickIntervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("success");
    stop();
  });

  it("stop() halts tick loop", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const spy = vi.fn();
    const stop = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      tickIntervalMs: 100,
      onTick: spy,
    });
    await vi.advanceTimersByTimeAsync(350);
    const count1 = spy.mock.calls.length;
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(spy.mock.calls.length).toBe(count1);
  });
});
