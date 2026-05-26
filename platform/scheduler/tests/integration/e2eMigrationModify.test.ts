import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

describe("E2E: migration MODIFY", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("owner replies MODIFY class=publication expectedDuration=7200000", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "amz-daily-inspection",
      cron: "0 22 * * *",
      executor: "shell",
      config: { command: "python", cwd: "/tmp", timeout: 60_000 },
      createdBy: "amzdata",
    }).id;
    ms.markPreviewSent("amzdata", 0);
    ms.scheduleProposal({
      taskId, ownerSession: "amzdata", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true, status: "completed",
            finalMessage: "ACTION: MODIFY class=publication expectedDuration=7200000",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "x" }),
      sendUserDm: async () => {},
      clock: () => 2000,
    });

    const t = ts.getTask(taskId)!;
    expect(t.class).toBe("publication");
    expect(t.expectedDurationMs).toBe(7_200_000);
  });
});
