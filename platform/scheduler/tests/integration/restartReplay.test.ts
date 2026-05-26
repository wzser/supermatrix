import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { startVerifyScheduler } from "../../src/verify/scheduler.js";

describe("E2E: verify scheduler replay after restart", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("pending verification survives 'restart' (scheduler stop/restart)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);

    const task = taskStore.createTask({
      name: "replay-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });

    // Schedule a verification due in the past (simulating: triggered, then scheduler crashed)
    const pastDue = Date.now() - 1000;
    verifyStore.scheduleVerification(run.id, pastDue);

    // "first scheduler run" — stop immediately without processing
    const stop1 = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      tickIntervalMs: 10000, // doesn't fire before we stop
    });
    stop1();

    // Verify still pending
    let pending = db
      .prepare("SELECT COUNT(*) as n FROM task_verifications WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(1);

    // "restart" — start a new scheduler; should pick up the pending verification
    const stop2 = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      tickIntervalMs: 100,
    });

    await new Promise((r) => setTimeout(r, 300));

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("success");

    pending = db
      .prepare("SELECT COUNT(*) as n FROM task_verifications WHERE status = 'pending'")
      .get() as { n: number };
    expect(pending.n).toBe(0);

    stop2();
  });
});
