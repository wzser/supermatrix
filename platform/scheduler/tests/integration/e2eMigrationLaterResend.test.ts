import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

const DAY = 24 * 3600_000;

describe("E2E: migration LATER then re-send", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("after LATER, next proposal spawns ≥7 days later", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "legacy-x",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "owner-b",
    }).id;
    ms.markPreviewSent("owner-b", 0);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "c1" }),
      sendUserDm: async () => {},
      clock: () => 1000,
    });
    expect(ms.listPending()).toHaveLength(1);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: true, status: "completed", finalMessage: "ACTION: LATER" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "n/a" }),
      sendUserDm: async () => {},
      clock: () => 2000,
    });
    expect(ms.listPending()).toHaveLength(0);
    expect(ms.countLaterForTask(taskId)).toBe(1);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "c2-early" }),
      sendUserDm: async () => {},
      clock: () => 2000 + 2 * DAY,
    });
    expect(ms.listPending()).toHaveLength(0);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "c2" }),
      sendUserDm: async () => {},
      clock: () => 2000 + 8 * DAY,
    });
    const pending = ms.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("c2");
  });
});
