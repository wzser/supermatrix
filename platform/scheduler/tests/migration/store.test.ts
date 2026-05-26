import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";

describe("migrationStore", () => {
  let db: Database.Database;
  let taskId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const t = taskStore.createTask({
      name: "legacy-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    });
    taskId = t.id;
  });
  afterEach(() => db.close());

  it("scheduleProposal inserts a pending row", () => {
    const store = createMigrationStore(db);
    const p = store.scheduleProposal({
      taskId,
      ownerSession: "owner-a",
      childSessionId: "c1",
      spawnedAt: 1000,
      suggestedClass: "sync_job",
      suggestedExpectedDurationMs: 1_800_000,
    });
    expect(p.status).toBe("pending");
    expect(p.childSessionId).toBe("c1");
    expect(p.suggestedClass).toBe("sync_job");
  });

  it("listPending returns only pending rows", () => {
    const store = createMigrationStore(db);
    const a = store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c1", spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    store.scheduleProposal({ taskId, ownerSession: "owner-b", childSessionId: "c2", spawnedAt: 2, suggestedClass: "publication", suggestedExpectedDurationMs: 1 });
    store.markReplied(a.id, "CONFIRM", "ACTION: CONFIRM", 100);
    expect(store.listPending()).toHaveLength(1);
  });

  it("ownerHasPendingProposal returns true only for owners with pending rows", () => {
    const store = createMigrationStore(db);
    store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c1", spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    expect(store.ownerHasPendingProposal("owner-a")).toBe(true);
    expect(store.ownerHasPendingProposal("owner-b")).toBe(false);
  });

  it("countLaterForTask counts LATER replies (including default_applied LATER)", () => {
    const store = createMigrationStore(db);
    const p1 = store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c1", spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    store.markReplied(p1.id, "LATER", "ACTION: LATER", 10);
    const p2 = store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c2", spawnedAt: 20, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    store.markDefaultApplied(p2.id, "LATER", 50);
    expect(store.countLaterForTask(taskId)).toBe(2);
  });

  it("latestForTask returns most recent by spawnedAt", () => {
    const store = createMigrationStore(db);
    store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c1", spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    const p2 = store.scheduleProposal({ taskId, ownerSession: "owner-a", childSessionId: "c2", spawnedAt: 100, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    expect(store.latestForTask(taskId)?.id).toBe(p2.id);
  });

  it("listAll returns all proposals and supports status filter", () => {
    const store = createMigrationStore(db);
    const a = store.scheduleProposal({ taskId, ownerSession: "o1", childSessionId: "c1", spawnedAt: 1, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1 });
    store.scheduleProposal({ taskId, ownerSession: "o2", childSessionId: "c2", spawnedAt: 2, suggestedClass: "publication", suggestedExpectedDurationMs: 1 });
    store.markReplied(a.id, "CONFIRM", "", 100);
    expect(store.listAll()).toHaveLength(2);
    expect(store.listAll("replied")).toHaveLength(1);
    expect(store.listAll("pending")).toHaveLength(1);
    expect(store.listAll("default_applied")).toHaveLength(0);
  });

  it("previewSent round-trip", () => {
    const store = createMigrationStore(db);
    expect(store.isPreviewSent("owner-x")).toBe(false);
    store.markPreviewSent("owner-x", 500);
    expect(store.isPreviewSent("owner-x")).toBe(true);
  });
});
