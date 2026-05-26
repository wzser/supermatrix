import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { runMigrationTick } from "../../src/migration/scheduler.js";

const DAY = 24 * 3600_000;

function okPollBody(content: string) {
  return new Response(
    JSON.stringify({ ok: true, status: "completed", finalMessage: content }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("runMigrationTick", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("sends preview before any proposal for a new owner", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    });

    const spawns: string[] = [];
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => okPollBody("ACTION: CONFIRM")) as unknown as typeof fetch,
      spawnFn: async (params) => {
        spawns.push(params.prompt);
        return { ok: true, childSessionId: `c-${spawns.length}` };
      },
      sendUserDm: async () => {},
      clock: () => 1000,
    });

    expect(ms.isPreviewSent("owner-a")).toBe(true);
    expect(ms.listPending()).toHaveLength(0);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toContain("预告");
  });

  it("sends first proposal after preview was sent", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    });
    ms.markPreviewSent("owner-a", 1);

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "p-1" }),
      sendUserDm: async () => {},
      clock: () => 2000,
    });

    const pending = ms.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("p-1");
  });

  it("applies CONFIRM reply by writing task class + expectedDuration", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    }).id;
    ms.markPreviewSent("owner-a", 0);
    ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });

    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => okPollBody("ACTION: CONFIRM expectedDuration=3600000")) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "ignored" }),
      sendUserDm: async () => {},
      clock: () => 2000,
    });

    const t = ts.getTask(taskId)!;
    expect(t.class).toBe("sync_job");
    expect(t.expectedDurationMs).toBe(3_600_000);
    expect(t.ownerSession).toBe("owner-a");
  });

  it("24h no reply applies default LATER", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    }).id;
    ms.markPreviewSent("owner-a", 0);
    const p = ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });

    const twentyFiveHoursLater = 1000 + 25 * 3600_000;
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "n/a" }),
      sendUserDm: async () => {},
      clock: () => twentyFiveHoursLater,
    });

    const prop = ms.getProposal(p.id)!;
    expect(prop.status).toBe("default_applied");
    expect(prop.replyAction).toBe("LATER");
  });

  it("re-sends proposal 7 days after LATER", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    }).id;
    ms.markPreviewSent("owner-a", 0);
    const p = ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });
    ms.markReplied(p.id, "LATER", "ACTION: LATER", 2000);

    const eightDaysLater = 2000 + 8 * DAY;
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "c2" }),
      sendUserDm: async () => {},
      clock: () => eightDaysLater,
    });

    const pending = ms.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("c2");
    expect(taskId).toBeTruthy();
  });

  it("skips re-send when last LATER was <7 days ago", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "t1", cron: "0 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 }, createdBy: "owner-a",
    }).id;
    ms.markPreviewSent("owner-a", 0);
    const p = ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });
    ms.markReplied(p.id, "LATER", "ACTION: LATER", 2000);

    const twoDaysLater = 2000 + 2 * DAY;
    let spawned = false;
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => {
        spawned = true;
        return { ok: true, childSessionId: "unused" };
      },
      sendUserDm: async () => {},
      clock: () => twoDaysLater,
    });

    expect(spawned).toBe(false);
    expect(ms.listPending()).toHaveLength(0);
    expect(taskId).toBeTruthy();
  });

  it("calls syncTask after applying CONFIRM reply", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "migrate-then-sync",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "owner-a",
    }).id;
    ms.markPreviewSent("owner-a", 0);
    ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "c1",
      spawnedAt: 1000, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });

    let syncedClass: string | null = null;
    await runMigrationTick({
      taskStore: ts, migrationStore: ms, smBaseUrl: "http://sm",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: true, status: "completed", finalMessage: "ACTION: CONFIRM expectedDuration=3600000" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
      spawnFn: async () => ({ ok: true, childSessionId: "n/a" }),
      sendUserDm: async () => {},
      syncTask: async (t) => { syncedClass = t.class; },
      clock: () => 2000,
    });

    expect(syncedClass).toBe("sync_job");
  });

  it("task with no resolvable owner writes REJECT proposal + fires userDM once", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const taskId = ts.createTask({
      name: "no-owner-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      createdBy: "",
    }).id;

    let dmCount = 0;
    const deps = {
      taskStore: ts,
      migrationStore: ms,
      smBaseUrl: "http://sm",
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      spawnFn: async () => { throw new Error("spawn must not be called for no-owner task"); },
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000,
    };

    await runMigrationTick(deps);
    expect(dmCount).toBe(1);
    const latest = ms.latestForTask(taskId)!;
    expect(latest.status).toBe("default_applied");
    expect(latest.replyAction).toBe("REJECT");

    // Next tick — should NOT DM again (latest is REJECT, scheduler skips)
    await runMigrationTick({ ...deps, clock: () => 2000 });
    expect(dmCount).toBe(1);
  });
});
