import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

describe("E2E: migration with bad/missing owner", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("task with missing createdBy → userDM once + REJECT proposal", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ts.createTask({
      name: "orphan-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "",
    });

    let dmCount = 0;
    for (let i = 0; i < 3; i++) {
      await runMigrationTick({
        taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
        fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
        spawnFn: async () => ({ ok: true, childSessionId: "should-not-fire" }),
        sendUserDm: async () => { dmCount++; },
        clock: () => 1000 + i,
      });
    }
    expect(dmCount).toBe(1); // only first tick alerts
    expect(ms.listAll("default_applied")).toHaveLength(1);
  });

  it("task with createdBy pointing to unreachable session (404) → userDM + REJECT", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "ghost-owner-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "i-do-not-exist",
    }).id;
    ms.markPreviewSent("i-do-not-exist", 0);

    let dmText = "";
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: false, status: 404 }),
      sendUserDm: async (t) => { dmText = t; },
      clock: () => 2000,
    });

    expect(dmText).toContain("i-do-not-exist");
    expect(dmText).toContain(taskId);
    const latest = ms.latestForTask(taskId)!;
    expect(latest.replyAction).toBe("REJECT");
  });
});
