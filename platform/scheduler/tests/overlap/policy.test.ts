import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { shouldSkipForOverlap } from "../../src/overlap/policy.js";

describe("overlap policy skip_if_running", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("allows trigger when no run is in-flight", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "t1",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });
    const shouldSkip = shouldSkipForOverlap(store, task);
    expect(shouldSkip).toBe(false);
  });

  it("blocks trigger when previous run is still running", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "t2",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });
    const run = store.createRun(task.id);
    store.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now(), runningPid: 12345 });
    const shouldSkip = shouldSkipForOverlap(store, task);
    expect(shouldSkip).toBe(true);
  });

  it("allows trigger when previous run has finished", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "t3",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });
    const run = store.createRun(task.id);
    store.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    store.updateRunFinal(run.id, "success", Date.now());
    const shouldSkip = shouldSkipForOverlap(store, task);
    expect(shouldSkip).toBe(false);
  });

  it("allows trigger for legacy task (overlapPolicy is null)", () => {
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "legacy",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
    });
    expect(shouldSkipForOverlap(store, task)).toBe(false);
  });
});
