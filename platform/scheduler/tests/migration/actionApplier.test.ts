import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { applyMigrationAction } from "../../src/migration/actionApplier.js";

describe("applyMigrationAction", () => {
  let db: Database.Database;
  let taskId: string;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const ts = createTaskStore(db);
    const t = ts.createTask({
      name: "legacy",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    });
    taskId = t.id;
  });
  afterEach(() => db.close());

  it("CONFIRM writes class + expectedDurationMs + ownerSession", () => {
    const ts = createTaskStore(db);
    applyMigrationAction({
      taskStore: ts, taskId,
      action: "CONFIRM", kv: { expectedDuration: "1800000" },
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
      ownerSession: "owner-a",
    });
    const t = ts.getTask(taskId)!;
    expect(t.class).toBe("sync_job");
    expect(t.expectedDurationMs).toBe(1_800_000);
    expect(t.ownerSession).toBe("owner-a");
  });

  it("CONFIRM without kv.expectedDuration falls back to suggested", () => {
    const ts = createTaskStore(db);
    applyMigrationAction({
      taskStore: ts, taskId,
      action: "CONFIRM", kv: {},
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 900_000,
      ownerSession: "owner-a",
    });
    expect(ts.getTask(taskId)!.expectedDurationMs).toBe(900_000);
  });

  it("MODIFY overrides class and expectedDuration", () => {
    const ts = createTaskStore(db);
    applyMigrationAction({
      taskStore: ts, taskId,
      action: "MODIFY", kv: { class: "publication", expectedDuration: "7200000" },
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
      ownerSession: "owner-a",
    });
    const t = ts.getTask(taskId)!;
    expect(t.class).toBe("publication");
    expect(t.expectedDurationMs).toBe(7_200_000);
  });

  it("MODIFY with invalid class keeps task unmigrated and returns error", () => {
    const ts = createTaskStore(db);
    const res = applyMigrationAction({
      taskStore: ts, taskId,
      action: "MODIFY", kv: { class: "bogus" },
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
      ownerSession: "owner-a",
    });
    expect(res.applied).toBe(false);
    expect(res.error).toMatch(/class/);
    expect(ts.getTask(taskId)!.class).toBeNull();
  });

  it("DISABLE flips enabled=false and leaves class NULL", () => {
    const ts = createTaskStore(db);
    applyMigrationAction({
      taskStore: ts, taskId,
      action: "DISABLE", kv: {},
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
      ownerSession: "owner-a",
    });
    const t = ts.getTask(taskId)!;
    expect(t.enabled).toBe(false);
    expect(t.class).toBeNull();
  });

  it("LATER is a no-op", () => {
    const ts = createTaskStore(db);
    const before = ts.getTask(taskId)!;
    applyMigrationAction({
      taskStore: ts, taskId,
      action: "LATER", kv: {},
      suggestedClass: "sync_job", suggestedExpectedDurationMs: 1_800_000,
      ownerSession: "owner-a",
    });
    const after = ts.getTask(taskId)!;
    expect(after.class).toBeNull();
    expect(after.enabled).toBe(before.enabled);
  });
});
