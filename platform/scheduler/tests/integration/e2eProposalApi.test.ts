import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createHealStore } from "../../src/heal/store.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { createCronEngine } from "../../src/cron/engine.js";
import { createApp } from "../../src/api/routes.js";
import { createTestKnownSessionsLoader } from "../helpers/testKnownSessions.js";

describe("E2E: GET /proposals/heal + /proposals/migration", () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(":memory:"); applyMigrations(db); });
  afterEach(() => db.close());

  it("heal + migration endpoints return proposal rows", async () => {
    const store = createTaskStore(db);
    const healStore = createHealStore(db);
    const migrationStore = createMigrationStore(db);
    const task = store.createTask({
      name: "t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    const run = store.createRun(task.id);
    healStore.scheduleProposal({
      taskId: task.id, runId: run.id, reason: "evidence_missing",
      spawnedAt: 1000, childSessionId: "c-heal",
    });
    migrationStore.scheduleProposal({
      taskId: task.id, ownerSession: "owner",
      childSessionId: "c-mig", spawnedAt: 2000,
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 60_000,
    });

    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, healStore, migrationStore,
      createTestKnownSessionsLoader(),
    );

    const healRes = await app.request("/proposals/heal");
    expect(healRes.status).toBe(200);
    const healRows = await healRes.json() as unknown[];
    expect(healRows).toHaveLength(1);

    const migRes = await app.request("/proposals/migration");
    expect(migRes.status).toBe(200);
    const migRows = await migRes.json() as unknown[];
    expect(migRows).toHaveLength(1);
  });

  it("?status filter works for pending", async () => {
    const store = createTaskStore(db);
    const healStore = createHealStore(db);
    const migrationStore = createMigrationStore(db);
    const task = store.createTask({
      name: "t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    const run = store.createRun(task.id);
    const h = healStore.scheduleProposal({
      taskId: task.id, runId: run.id, reason: "evidence_missing",
      spawnedAt: 1000, childSessionId: "c1",
    });
    healStore.markReplied(h.id, "SKIP", "", 2000);

    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, healStore, migrationStore,
      createTestKnownSessionsLoader(),
    );

    const pending = await app.request("/proposals/heal?status=pending");
    expect(await pending.json()).toEqual([]);

    const replied = await app.request("/proposals/heal?status=replied");
    const rows = await replied.json() as unknown[];
    expect(rows).toHaveLength(1);
  });

  it("?status=garbage → 400", async () => {
    const store = createTaskStore(db);
    const healStore = createHealStore(db);
    const migrationStore = createMigrationStore(db);
    const engine = createCronEngine(() => {}, new Map());
    const app = createApp(
      store, engine,
      undefined, undefined, undefined, healStore, migrationStore,
      createTestKnownSessionsLoader(),
    );
    const res = await app.request("/proposals/heal?status=bogus");
    expect(res.status).toBe(400);
  });
});
