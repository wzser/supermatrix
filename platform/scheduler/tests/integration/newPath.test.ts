import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { runTaskNew } from "../../src/main.js";

describe("runTaskNew", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("shell task: creates run, triggers, schedules verify", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "shell-new",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo hi", cwd: "/tmp", timeout: 2000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });

    await runTaskNew(task, { taskStore, verifyStore });

    const runs = taskStore.listRuns(task.id, 10);
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run.triggerStatus).toBe("ok");
    expect(run.runningPid).toBeGreaterThan(0);

    const verRows = db.prepare("SELECT * FROM task_verifications WHERE run_id = ?").all(run.id) as Array<Record<string, unknown>>;
    expect(verRows.length).toBe(1);
    expect(verRows[0].due_at).toBeGreaterThan(Date.now());
  });

  it("shell trigger failure persists error to run record (cwd missing)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "shell-bad-cwd",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo hi", cwd: "/this/path/does/not/exist", timeout: 2000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });

    await runTaskNew(task, { taskStore, verifyStore });

    const runs = taskStore.listRuns(task.id, 10);
    expect(runs.length).toBe(1);
    const run = runs[0];
    expect(run.triggerStatus).toBe("failed");
    expect(run.finalStatus).toBe("trigger_failed");
    expect(run.error).toMatch(/cwd does not exist/);
  });

  it("http trigger failure (fetch throws) persists error to run record", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const err = new Error("The operation was aborted") as Error & { name: string };
      err.name = "AbortError";
      return Promise.reject(err);
    });
    try {
      const taskStore = createTaskStore(db);
      const verifyStore = createVerifyStore(db);
      const task = taskStore.createTask({
        name: "http-abort",
        cron: "0 * * * *",
        executor: "http",
        config: { url: "http://localhost:1/never", method: "POST", timeout: 100 },
        class: "notification",
        expectedDurationMs: 300000,
        ownerSession: "tester",
        overlapPolicy: "skip_if_running",
      });

      await runTaskNew(task, { taskStore, verifyStore });

      const runs = taskStore.listRuns(task.id, 10);
      expect(runs.length).toBe(1);
      const run = runs[0];
      expect(run.triggerStatus).toBe("failed");
      expect(run.finalStatus).toBe("trigger_failed");
      expect(run.error).toBe("The operation was aborted");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("advances next_run_at on shell trigger_failed (cwd missing)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "next-run-bump-shell",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo hi", cwd: "/this/path/does/not/exist", timeout: 2000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });
    db.prepare("UPDATE tasks SET next_run_at = 0 WHERE id = ?").run(task.id);

    await runTaskNew(task, { taskStore, verifyStore });

    const reloaded = taskStore.getTask(task.id)!;
    expect(reloaded.nextRunAt).not.toBeNull();
    expect(reloaded.nextRunAt!).toBeGreaterThan(Date.now());
  });

  it("advances next_run_at on http trigger_failed (fetch throws)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const err = new Error("boom") as Error & { name: string };
      err.name = "AbortError";
      return Promise.reject(err);
    });
    try {
      const taskStore = createTaskStore(db);
      const verifyStore = createVerifyStore(db);
      const task = taskStore.createTask({
        name: "next-run-bump-http",
        cron: "0 * * * *",
        executor: "http",
        config: { url: "http://localhost:1/never", method: "POST", timeout: 100 },
        class: "notification",
        expectedDurationMs: 300000,
        ownerSession: "tester",
        overlapPolicy: "skip_if_running",
      });
      db.prepare("UPDATE tasks SET next_run_at = 0 WHERE id = ?").run(task.id);

      await runTaskNew(task, { taskStore, verifyStore });

      const reloaded = taskStore.getTask(task.id)!;
      expect(reloaded.nextRunAt).not.toBeNull();
      expect(reloaded.nextRunAt!).toBeGreaterThan(Date.now());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("skips when overlap blocks (in-flight run exists)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "skip-me",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo hi", cwd: "/tmp", timeout: 2000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overlapPolicy: "skip_if_running",
    });
    const preRun = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(preRun.id, { triggerStatus: "ok", triggeredAt: Date.now(), runningPid: 9999 });

    await runTaskNew(task, { taskStore, verifyStore });

    const runs = taskStore.listRuns(task.id, 10);
    expect(runs.length).toBe(2);
    const latest = runs[0];
    expect(latest.triggerStatus).toBe("skipped_overlap");
    expect(latest.finalStatus).toBe("skipped_overlap");
  });
});
