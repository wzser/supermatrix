import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

describe("E2E: migration DISABLE", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("owner replies DISABLE → task.enabled becomes false, class stays NULL", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "dead-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "owner-d",
    }).id;
    ms.markPreviewSent("owner-d", 0);
    ms.scheduleProposal({ taskId, ownerSession: "owner-d", childSessionId: "c1", spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000 });

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: true, status: "completed", finalMessage: "ACTION: DISABLE" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "n/a" }),
      sendUserDm: async () => {},
      clock: () => 2000,
    });

    const t = ts.getTask(taskId)!;
    expect(t.enabled).toBe(false);
    expect(t.class).toBeNull();
  });
});
