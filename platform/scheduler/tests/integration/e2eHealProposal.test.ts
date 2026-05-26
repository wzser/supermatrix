import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { createHealStore } from "../../src/heal/store.js";
import { createHealRunner } from "../../src/heal/runner.js";
import { runVerification } from "../../src/verify/runner.js";
import { runHealTick } from "../../src/heal/scheduler.js";

describe("E2E: heal Step 2 proposal + owner reply", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("publication (non) spawns proposal; owner replies SKIP; proposal resolved", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const healStore = createHealStore(db);
    const task = taskStore.createTask({
      name: "non-proposal-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner-sess",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);

    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: true, childSessionId: "child-proposal" }),
      sendUserDm: async () => {},
      retryTaskFn: async () => {},
    });

    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      heal: (args) => runner.runHeal(args),
    });

    const pending = healStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("child-proposal");

    // Owner replies SKIP via next tick
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: true, status: "completed", finalMessage: "ACTION: SKIP" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "unused" }),
    });

    const resolved = healStore.getProposal(pending[0].id)!;
    expect(resolved.status).toBe("replied");
    expect(resolved.replyAction).toBe("SKIP");
  });
});
