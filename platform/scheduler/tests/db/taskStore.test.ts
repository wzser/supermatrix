import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore, type TaskStore } from "../../src/db/taskStore.js";

describe("TaskStore", () => {
  let db: Database.Database;
  let store: TaskStore;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createTaskStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("tasks", () => {
    const validTask = {
      name: "fetch-mail",
      cron: "0 9 * * *",
      executor: "shell" as const,
      config: { command: "node fetch.js", cwd: "/tmp", timeout: 30000 },
    };

    it("creates and retrieves a task", () => {
      const task = store.createTask(validTask);
      expect(task.name).toBe("fetch-mail");
      expect(task.cron).toBe("0 9 * * *");
      expect(task.executor).toBe("shell");
      expect(task.enabled).toBe(true);
      expect(task.notifyOnFailure).toBe(false);

      const found = store.getTask(task.id);
      expect(found).toEqual(task);
    });

    it("lists all tasks", () => {
      store.createTask(validTask);
      store.createTask({ ...validTask, name: "crawl-data", executor: "http", config: { url: "http://localhost", method: "POST", timeout: 5000 } });
      const tasks = store.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it("updates a task", () => {
      const task = store.createTask(validTask);
      const updated = store.updateTask(task.id, { cron: "0 10 * * *", enabled: false });
      expect(updated.cron).toBe("0 10 * * *");
      expect(updated.enabled).toBe(false);
      expect(updated.name).toBe("fetch-mail");
    });

    it("deletes a task", () => {
      const task = store.createTask(validTask);
      store.deleteTask(task.id);
      expect(store.getTask(task.id)).toBeNull();
    });

    it("rejects duplicate name", () => {
      store.createTask(validTask);
      expect(() => store.createTask(validTask)).toThrow();
    });
  });

  describe("task_runs", () => {
    it("records a run and retrieves history", () => {
      const task = store.createTask({
        name: "test-task",
        cron: "* * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
      });

      const run = store.createRun(task.id);
      expect(run.status).toBe("running");
      expect(run.taskId).toBe(task.id);

      store.completeRun(run.id, "success", "hello\n", null);

      const runs = store.listRuns(task.id, 10);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("success");
      expect(runs[0].output).toBe("hello\n");
    });

    it("records failure with error", () => {
      const task = store.createTask({
        name: "fail-task",
        cron: "* * * * *",
        executor: "shell",
        config: { command: "exit 1", cwd: "/tmp", timeout: 5000 },
      });

      const run = store.createRun(task.id);
      store.completeRun(run.id, "failed", "", "command not found");

      const runs = store.listRuns(task.id, 10);
      expect(runs[0].status).toBe("failed");
      expect(runs[0].error).toBe("command not found");
    });

    it("lists recent runs across all tasks", () => {
      const t1 = store.createTask({ name: "t1", cron: "* * * * *", executor: "shell", config: { command: "echo 1", cwd: "/tmp", timeout: 5000 } });
      const t2 = store.createTask({ name: "t2", cron: "* * * * *", executor: "shell", config: { command: "echo 2", cwd: "/tmp", timeout: 5000 } });
      const r1 = store.createRun(t1.id);
      const r2 = store.createRun(t2.id);
      store.completeRun(r1.id, "success", "1", null);
      store.completeRun(r2.id, "success", "2", null);

      const recent = store.listRecentRuns(10);
      expect(recent).toHaveLength(2);
    });
  });

  describe("task with class and expectedDuration", () => {
    it("persists and retrieves new fields", () => {
      const task = store.createTask({
        name: "new-class-task",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        createdBy: "tester",
        class: "monitoring",
        expectedDurationMs: 300000,
        overlapPolicy: "skip_if_running",
        ownerSession: "tester",
        overrides: { notify: { succeeded: { channel: "none" } } },
      });
      expect(task.class).toBe("monitoring");
      expect(task.expectedDurationMs).toBe(300000);
      expect(task.overlapPolicy).toBe("skip_if_running");
      expect(task.ownerSession).toBe("tester");
      expect(task.overrides).toEqual({ notify: { succeeded: { channel: "none" } } });
    });

    it("existing task without class has class=null", () => {
      const task = store.createTask({
        name: "legacy-task",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
      });
      expect(task.class).toBeNull();
      expect(task.expectedDurationMs).toBeNull();
      expect(task.overlapPolicy).toBeNull();
      expect(task.ownerSession).toBeNull();
      expect(task.overrides).toBeNull();
    });

    it("updateTask can independently set new fields", () => {
      const task = store.createTask({
        name: "update-target",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
      });
      const updated = store.updateTask(task.id, {
        class: "publication",
        expectedDurationMs: 120000,
        overlapPolicy: "queue",
        ownerSession: "owner-session",
        overrides: { notify: { failed: { channel: "feishu" } } },
      });
      expect(updated.class).toBe("publication");
      expect(updated.expectedDurationMs).toBe(120000);
      expect(updated.overlapPolicy).toBe("queue");
      expect(updated.ownerSession).toBe("owner-session");
      expect(updated.overrides).toEqual({ notify: { failed: { channel: "feishu" } } });
    });
  });

  describe("task_run with lifecycle fields", () => {
    it("creates run with trigger_status and final_status defaults from schema", () => {
      const task = store.createTask({
        name: "lifecycle-test-defaults",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);
      expect(run.triggerStatus).toBe("pending");
      expect(run.verifyStatus).toBe("pending");
      expect(run.finalStatus).toBe("pending");
      expect(run.verifyAttempts).toBe(0);
    });

    it("updates trigger status independently from final status (two axes)", () => {
      const task = store.createTask({
        name: "lifecycle-test-2",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo hi", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);
      store.updateRunTrigger(run.id, {
        triggerStatus: "ok",
        triggeredAt: Date.now(),
        runningPid: 12345,
      });
      const fetched = store.getRun(run.id)!;
      expect(fetched.triggerStatus).toBe("ok");
      expect(fetched.runningPid).toBe(12345);
      expect(fetched.finalStatus).toBe("pending");  // still pending on the verify axis
    });

    it("updateRunVerify can set evidence JSON and verifyStatus", () => {
      const task = store.createTask({
        name: "lifecycle-verify",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);
      store.updateRunVerify(run.id, {
        verifyStatus: "pass",
        verifyAttempts: 1,
        receiptEvidence: { exitCode: 0, foo: "bar" },
        processExitedAt: 1234567890,
      });
      const fetched = store.getRun(run.id)!;
      expect(fetched.verifyStatus).toBe("pass");
      expect(fetched.verifyAttempts).toBe(1);
      expect(fetched.receiptEvidence).toEqual({ exitCode: 0, foo: "bar" });
      expect(fetched.processExitedAt).toBe(1234567890);
    });

    it("updateRunVerify persists exitCode so it survives scheduler restart", () => {
      const task = store.createTask({
        name: "lifecycle-exit-code",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);

      // Default: a fresh run has no exit yet.
      expect(store.getRun(run.id)!.exitCode).toBeNull();

      store.updateRunVerify(run.id, {
        processExitedAt: 1234567890,
        exitCode: 0,
      });
      expect(store.getRun(run.id)!.exitCode).toBe(0);

      // Non-zero codes are preserved verbatim (proof needs them to fail).
      const run2 = store.createRun(task.id);
      store.updateRunVerify(run2.id, {
        processExitedAt: 1234567891,
        exitCode: 137,
      });
      expect(store.getRun(run2.id)!.exitCode).toBe(137);
    });

    it("updateRunFinal sets finalStatus, finishedAt, and mirrors to legacy status", () => {
      const task = store.createTask({
        name: "lifecycle-final",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);
      const t = Date.now();
      store.updateRunFinal(run.id, "success", t);
      const fetched = store.getRun(run.id)!;
      expect(fetched.finalStatus).toBe("success");
      expect(fetched.finishedAt).toBe(t);
      expect(fetched.status).toBe("success");  // legacy status mirror for backward compat
    });

    it("updateRunFinal with evidence_missing maps legacy status to 'failed'", () => {
      const task = store.createTask({
        name: "lifecycle-final-fail",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 5000 },
        class: "monitoring",
        expectedDurationMs: 300000,
        ownerSession: "tester",
      });
      const run = store.createRun(task.id);
      store.updateRunFinal(run.id, "evidence_missing", Date.now());
      const fetched = store.getRun(run.id)!;
      expect(fetched.finalStatus).toBe("evidence_missing");
      expect(fetched.status).toBe("failed");
    });
  });

  describe("updateRunFinal stamps last_success_at on success", () => {
    it("bumps tasks.last_success_at when finalStatus is 'success'", () => {
      const db2 = new Database(":memory:");
      applyMigrations(db2);
      const store2 = createTaskStore(db2);
      const task = store2.createTask({
        name: "classed-sync-test",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
        class: "sync_job",
        expectedDurationMs: 60_000,
        ownerSession: "owner",
      });
      const run = store2.createRun(task.id);
      const finishedAt = 1_800_000;
      store2.updateRunFinal(run.id, "success", finishedAt);
      const reloaded = store2.getTask(task.id)!;
      expect(reloaded.lastSuccessAt).toBe(finishedAt);
      db2.close();
    });

    it("does NOT touch last_success_at on non-success final status", () => {
      const db2 = new Database(":memory:");
      applyMigrations(db2);
      const store2 = createTaskStore(db2);
      const task = store2.createTask({
        name: "classed-fail-test",
        cron: "0 * * * *",
        executor: "shell",
        config: { command: "echo", cwd: "/tmp", timeout: 1000 },
        class: "publication",
        expectedDurationMs: 60_000,
        ownerSession: "owner",
      });
      const run = store2.createRun(task.id);
      store2.updateRunFinal(run.id, "evidence_missing", 2_000_000);
      expect(store2.getTask(task.id)!.lastSuccessAt).toBeNull();
      db2.close();
    });
  });
});
