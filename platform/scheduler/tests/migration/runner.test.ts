import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { createMigrationRunner } from "../../src/migration/runner.js";

describe("migrationRunner", () => {
  let db: Database.Database;
  let taskId: string;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const ts = createTaskStore(db);
    taskId = ts.createTask({
      name: "legacy-t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    }).id;
  });
  afterEach(() => db.close());

  it("sends a proposal successfully and records the childSessionId", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const runner = createMigrationRunner({
      taskStore: ts,
      migrationStore: ms,
      spawnFn: async (params) => {
        expect(params.target).toBe("owner-a");
        expect(params.prompt).toContain("migration proposal");
        return { ok: true, childSessionId: "child-1" };
      },
    });
    const r = await runner.sendNext(taskId, "owner-a");
    expect(r.sent).toBe(true);
    const pending = ms.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("child-1");
  });

  it("skips when owner already has a pending proposal", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    ms.scheduleProposal({
      taskId, ownerSession: "owner-a", childSessionId: "prev",
      spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
    });
    let spawnCalled = false;
    const runner = createMigrationRunner({
      taskStore: ts, migrationStore: ms,
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "x" };
      },
    });
    const r = await runner.sendNext(taskId, "owner-a");
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/pending/i);
    expect(spawnCalled).toBe(false);
  });

  it("returns sent=false and writes REJECT proposal on 404 (drop-dead owner)", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const runner = createMigrationRunner({
      taskStore: ts, migrationStore: ms,
      spawnFn: async () => ({ ok: false, status: 404 }),
      sendUserDm: async () => {},
    });
    const r = await runner.sendNext(taskId, "owner-a");
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/404/);
    // Pending is empty, but a default_applied REJECT row was written
    expect(ms.listPending()).toHaveLength(0);
    expect(ms.latestForTask(taskId)!.replyAction).toBe("REJECT");
  });

  it("spawn 404 writes REJECT proposal + fires userDM (no silent return)", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    let dmText = "";
    const runner = createMigrationRunner({
      taskStore: ts,
      migrationStore: ms,
      spawnFn: async () => ({ ok: false, status: 404 }),
      sendUserDm: async (text: string) => { dmText = text; },
      clock: () => 5000,
    });
    const r = await runner.sendNext(taskId, "ghost-owner");
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/404/);
    expect(dmText).toContain("ghost-owner");
    expect(dmText).toContain(taskId);
    const latest = ms.latestForTask(taskId)!;
    expect(latest.status).toBe("default_applied");
    expect(latest.replyAction).toBe("REJECT");
  });

  it("spawn 5xx also writes REJECT + userDM (treated as terminal)", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    let dmCalled = false;
    const runner = createMigrationRunner({
      taskStore: ts,
      migrationStore: ms,
      spawnFn: async () => ({ ok: false, status: 500 }),
      sendUserDm: async () => { dmCalled = true; },
      clock: () => 5000,
    });
    const r = await runner.sendNext(taskId, "owner-a");
    expect(r.sent).toBe(false);
    expect(dmCalled).toBe(true);
    expect(ms.latestForTask(taskId)!.replyAction).toBe("REJECT");
  });

  it("spawn throw (network glitch) returns sent=false but does NOT write REJECT (transient)", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    let dmCalled = false;
    const runner = createMigrationRunner({
      taskStore: ts,
      migrationStore: ms,
      spawnFn: async () => { throw new Error("ECONNREFUSED"); },
      sendUserDm: async () => { dmCalled = true; },
      clock: () => 5000,
    });
    const r = await runner.sendNext(taskId, "owner-a");
    expect(r.sent).toBe(false);
    expect(dmCalled).toBe(false);
    // No proposal persisted — next tick will retry
    expect(ms.latestForTask(taskId)).toBeUndefined();
  });
});
