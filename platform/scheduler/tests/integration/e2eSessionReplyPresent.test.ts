import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { startVerifyScheduler } from "../../src/verify/scheduler.js";

describe("E2E: session_reply_present lifecycle", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("delegation task with session_reply_present passes when child session has assistant message", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "delegation-proof-test",
      cron: "0 * * * *",
      executor: "http",
      config: { url: "http://x/y", method: "POST", timeout: 1000 },
      class: "notification",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "session_reply_present", timeoutMs: 300_000 } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, {
      triggerStatus: "ok",
      triggeredAt: Date.now(),
      childSessionId: "child-xyz",
    });
    verifyStore.scheduleVerification(run.id, Date.now() - 1000);

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ ok: true, status: "completed", finalMessage: "done" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as unknown as typeof fetch;

    const stop = startVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: (rid) => ({ childSessionId: taskStore.getRun(rid)?.childSessionId, smBaseUrl: "http://sm", fetchImpl }),
      tickIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 200));
    stop();

    expect(taskStore.getRun(run.id)?.finalStatus).toBe("success");
  });
});
