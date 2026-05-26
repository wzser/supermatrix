import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { createHealStore } from "../../src/heal/store.js";
import { createHealRunner } from "../../src/heal/runner.js";
import { runVerification } from "../../src/verify/runner.js";

describe("E2E: heal Step 1 pure auto-retry", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("sync_job (pure) auto-retries once on evidence_missing", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const healStore = createHealStore(db);
    const task = taskStore.createTask({
      name: "pure-retry-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);

    let retried = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: true, childSessionId: "n/a" }),
      sendUserDm: async () => {},
      retryTaskFn: async (tid) => {
        expect(tid).toBe(task.id);
        retried = true;
      },
    });

    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      heal: (args) => runner.runHeal(args),
    });

    expect(taskStore.getRun(run.id)!.finalStatus).toBe("evidence_missing");
    expect(retried).toBe(true);
    expect(healStore.listPending()).toHaveLength(0);
  });
});
