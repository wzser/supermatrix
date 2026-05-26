import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";

describe("verify store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("scheduleVerification persists a pending entry", () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t1",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    const dueAt = Date.now() + 300000;
    const v = verifyStore.scheduleVerification(run.id, dueAt);
    expect(v.status).toBe("pending");
    expect(v.dueAt).toBe(dueAt);
    expect(v.attempts).toBe(0);
  });

  it("pollDue returns only status=pending and due_at <= now", () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t2",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    const pastDue = Date.now() - 1000;
    const future = Date.now() + 300000;
    verifyStore.scheduleVerification(run.id, pastDue);
    verifyStore.scheduleVerification(run.id, future);
    const due = verifyStore.pollDue(Date.now());
    expect(due.length).toBe(1);
    expect(due[0].dueAt).toBe(pastDue);
  });

  it("rescheduleVerification bumps due_at and attempts", () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t3",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    const v = verifyStore.scheduleVerification(run.id, Date.now());
    const newDue = Date.now() + 1800000;
    verifyStore.rescheduleVerification(v.id, newDue);
    const reloaded = verifyStore.getVerification(v.id)!;
    expect(reloaded.dueAt).toBe(newDue);
    expect(reloaded.attempts).toBe(1);
  });

  it("finalizeVerification sets status=done", () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t4",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    const v = verifyStore.scheduleVerification(run.id, Date.now());
    verifyStore.finalizeVerification(v.id);
    const reloaded = verifyStore.getVerification(v.id)!;
    expect(reloaded.status).toBe("done");
    const due = verifyStore.pollDue(Date.now());
    expect(due).toEqual([]);
  });
});
