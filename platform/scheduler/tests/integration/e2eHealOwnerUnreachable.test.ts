import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { createHealStore } from "../../src/heal/store.js";
import { createHealRunner } from "../../src/heal/runner.js";
import { runVerification } from "../../src/verify/runner.js";

describe("E2E: heal Step 3 owner unreachable fallback", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("non task with 404 owner routes proposal through Console card and persists audit row", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const healStore = createHealStore(db);
    const task = taskStore.createTask({
      name: "owner-unreachable-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "ghost-owner",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);

    let cardPayload: { title: string; body: string; metadata?: Record<string, unknown> } | null = null;
    let userDmText = "";
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: false, status: 404 }),
      notifyConsole: async (params) => {
        cardPayload = params as typeof cardPayload;
      },
      sendUserDm: async (text) => {
        userDmText = text;
      },
      retryTaskFn: async () => {},
    });

    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      heal: (args) => runner.runHeal(args),
    });

    expect(cardPayload).not.toBeNull();
    expect(userDmText).toBe("");
    expect(cardPayload!.body).toContain("ghost-owner");
    expect(cardPayload!.body).toContain("需要关注");
    expect(cardPayload!.body).toContain("任务目的");
    expect(cardPayload!.metadata).toMatchObject({
      event: "heal_owner_unreachable",
      ownerSession: "ghost-owner",
      ownerStatus: 404,
    });
    const allRows = [...healStore.listPending(), ...healStore.listPendingRetry()];
    expect(allRows).toHaveLength(0);
    const row = db
      .prepare("SELECT * FROM heal_proposals WHERE task_id = ?")
      .get(task.id) as Record<string, unknown>;
    expect(row.status).toBe("default_applied");
    expect(row.reply_action).toBe("SKIP");
  });
});
