import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

describe("E2E: migration CONFIRM happy path", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("legacy task → preview → proposal → CONFIRM writes class+duration", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "legacy-sync",
      cron: "0 2 * * *",
      executor: "shell",
      config: { command: "python", cwd: "/tmp", timeout: 60_000 },
      createdBy: "amz-sql",
    }).id;

    const spawns: string[] = [];
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async (p) => {
        spawns.push(p.prompt);
        return { ok: true, childSessionId: `c-${spawns.length}` };
      },
      sendUserDm: async () => {},
      clock: () => 1000,
    });
    expect(ms.isPreviewSent("amz-sql")).toBe(true);
    expect(spawns).toHaveLength(1);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async (p) => {
        spawns.push(p.prompt);
        return { ok: true, childSessionId: `c-${spawns.length}` };
      },
      sendUserDm: async () => {},
      clock: () => 2000,
    });
    expect(ms.listPending()).toHaveLength(1);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true, status: "completed",
            finalMessage: "looks fine.\nACTION: CONFIRM expectedDuration=900000",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "x" }),
      sendUserDm: async () => {},
      clock: () => 3000,
    });

    const t = ts.getTask(taskId)!;
    expect(t.class).toBe("sync_job");
    expect(t.expectedDurationMs).toBe(900_000);
    expect(t.ownerSession).toBe("amz-sql");
  });
});
