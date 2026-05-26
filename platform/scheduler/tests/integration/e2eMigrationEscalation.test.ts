import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

const DAY = 24 * 3600_000;

describe("E2E: migration escalation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("after 2 LATER replies and >=14d, scheduler fires userDM", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "stubborn-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "owner-c",
    }).id;
    ms.markPreviewSent("owner-c", 0);

    const p1 = ms.scheduleProposal({ taskId, ownerSession: "owner-c", childSessionId: "c1", spawnedAt: 0, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000 });
    ms.markReplied(p1.id, "LATER", "", 100);
    const p2 = ms.scheduleProposal({ taskId, ownerSession: "owner-c", childSessionId: "c2", spawnedAt: DAY * 8, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000 });
    ms.markReplied(p2.id, "LATER", "", DAY * 8 + 100);

    const dms: string[] = [];
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "c3" }),
      sendUserDm: async (t) => { dms.push(t); },
      clock: () => DAY * 15,
    });
    expect(dms.some((t) => t.includes("stubborn-task") && t.includes("migration"))).toBe(true);
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(1);
  });
});
