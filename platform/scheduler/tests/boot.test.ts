import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { createTaskStore } from "../src/db/taskStore.js";
import { createCronEngine } from "../src/cron/engine.js";
import { loadTasksIntoEngine, recoverOrphanRuns } from "../src/boot.js";

describe("loadTasksIntoEngine", () => {
  let db: Database.Database;
  let engine: ReturnType<typeof createCronEngine>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    engine = createCronEngine();
  });

  afterEach(() => {
    engine.stopAll();
    db.close();
  });

  it("loads valid tasks and skips bad ones", () => {
    const store = createTaskStore(db);
    store.createTask({
      name: "good-task",
      cron: "0 9 * * *",
      executor: "shell",
      config: { command: "echo ok", cwd: "/tmp", timeout: 5000 },
    });

    db.prepare(
      "INSERT INTO tasks (id, name, cron, executor, config, enabled, notify_on_failure, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)"
    ).run("bad-id", "bad-task", "not a cron", "shell", '{"command":"echo","cwd":"/tmp","timeout":5000}', Date.now(), Date.now());

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, vi.fn(), logger);

    expect(result.loaded).toBe(1);
    expect(result.failed).toBe(1);
    expect(engine.list()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("handles all tasks being invalid", () => {
    db.prepare(
      "INSERT INTO tasks (id, name, cron, executor, config, enabled, notify_on_failure, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)"
    ).run("bad-1", "bad1", "xxx", "shell", '{}', Date.now(), Date.now());

    const store = createTaskStore(db);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, vi.fn(), logger);

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(engine.list()).toHaveLength(0);
  });

  it("rejects shell task whose config is missing timeout (would clamp to 1ms in setTimeout)", () => {
    db.prepare(
      "INSERT INTO tasks (id, name, cron, executor, config, enabled, notify_on_failure, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)"
    ).run("no-timeout-shell", "no-timeout-shell", "0 9 * * *", "shell", '{"command":"echo ok","cwd":"/tmp"}', Date.now(), Date.now());

    const store = createTaskStore(db);
    const onTask = vi.fn();
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, onTask, logger);

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(engine.list()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledOnce();
    const [warnArg, warnMsg] = logger.warn.mock.calls[0];
    expect(warnMsg).toMatch(/timeout/i);
    expect(warnArg).toMatchObject({ taskId: "no-timeout-shell" });
  });

  it("rejects shell task whose config.timeout is non-positive", () => {
    db.prepare(
      "INSERT INTO tasks (id, name, cron, executor, config, enabled, notify_on_failure, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)"
    ).run("bad-timeout-shell", "bad-timeout-shell", "0 9 * * *", "shell", '{"command":"echo ok","cwd":"/tmp","timeout":0}', Date.now(), Date.now());

    const store = createTaskStore(db);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, vi.fn(), logger);

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("rejects http task whose config is missing timeout", () => {
    db.prepare(
      "INSERT INTO tasks (id, name, cron, executor, config, enabled, notify_on_failure, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)"
    ).run("no-timeout-http", "no-timeout-http", "0 9 * * *", "http", '{"url":"http://localhost:3501/api/spawn","method":"POST"}', Date.now(), Date.now());

    const store = createTaskStore(db);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, vi.fn(), logger);

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][1]).toMatch(/timeout/i);
  });

  it("skips disabled tasks without counting as failure", () => {
    const store = createTaskStore(db);
    store.createTask({
      name: "disabled-task",
      cron: "0 9 * * *",
      executor: "shell",
      config: { command: "echo ok", cwd: "/tmp", timeout: 5000 },
    });
    store.updateTask(store.listTasks()[0].id, { enabled: false });

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = loadTasksIntoEngine(store.listTasks(), engine, vi.fn(), logger);

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("recoverOrphanRuns", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    store.createTask({
      name: "shell-task",
      cron: "0 9 * * *",
      executor: "shell",
      config: { command: "true", cwd: "/tmp", timeout: 5000 },
    });
  });

  afterEach(() => db.close());

  function insertRun(id: string, taskId: string, pid: number | null, startedAt: number) {
    db.prepare(
      "INSERT INTO task_runs (id, task_id, started_at, status, running_pid) VALUES (?, ?, ?, 'running', ?)"
    ).run(id, taskId, startedAt, pid);
  }

  function insertExitedRun(
    id: string,
    taskId: string,
    pid: number | null,
    startedAt: number,
    processExitedAt: number,
    exitCode: number | null,
  ) {
    db.prepare(
      "INSERT INTO task_runs (id, task_id, started_at, status, running_pid, process_exited_at, exit_code) VALUES (?, ?, ?, 'running', ?, ?, ?)"
    ).run(id, taskId, startedAt, pid, processExitedAt, exitCode);
  }

  it("marks runs with dead pids as failed; leaves alive-pid runs alone; skips pid=null legacy runs", () => {
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    insertRun("run-dead", tid, 99999, 1000);
    insertRun("run-alive", tid, 88888, 1000);
    insertRun("run-no-pid", tid, null, 1000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const isPidAlive = (pid: number) => pid === 88888;
    const result = recoverOrphanRuns(db, isPidAlive, logger, () => 5000);

    expect(result.recovered).toBe(1);
    expect(result.alive).toBe(1);
    expect(result.skippedNoPid).toBe(1);

    const dead = db.prepare("SELECT status, error, finished_at FROM task_runs WHERE id = ?").get("run-dead") as { status: string; error: string; finished_at: number };
    expect(dead.status).toBe("failed");
    expect(dead.error).toMatch(/orphan/i);
    expect(dead.error).toMatch(/99999/);
    expect(dead.finished_at).toBe(5000);

    const alive = db.prepare("SELECT status FROM task_runs WHERE id = ?").get("run-alive") as { status: string };
    expect(alive.status).toBe("running");

    const noPid = db.prepare("SELECT status, error, finished_at FROM task_runs WHERE id = ?").get("run-no-pid") as { status: string; error: string | null; finished_at: number | null };
    expect(noPid.status).toBe("running");
    expect(noPid.error).toBeNull();
    expect(noPid.finished_at).toBeNull();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("no-op when there are no running runs", () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => true, logger, () => 5000);

    expect(result.recovered).toBe(0);
    expect(result.alive).toBe(0);
    expect(result.skippedNoPid).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("handles isPidAlive throwing — treats as dead orphan", () => {
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    insertRun("run-throws", tid, 11111, 1000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const isPidAlive = () => { throw new Error("EPERM unexpected"); };
    const result = recoverOrphanRuns(db, isPidAlive, logger, () => 5000);

    expect(result.recovered).toBe(1);
    expect(result.alive).toBe(0);
  });

  it("does NOT mark a run orphan when process_exited_at is set (clean exit before bounce)", () => {
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    // pid is dead (child long gone), but the .then handler had time to write
    // process_exited_at + exit_code before the scheduler was bounced. The run
    // is genuinely "exited cleanly, awaiting verify tick" — not an orphan.
    insertExitedRun("run-clean-exit", tid, 99999, 1000, 2000, 0);
    insertExitedRun("run-clean-fail", tid, 99998, 1000, 2000, 137);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => false, logger, () => 5000);

    expect(result.recovered).toBe(0);
    for (const id of ["run-clean-exit", "run-clean-fail"]) {
      const r = db.prepare("SELECT status, error, finished_at FROM task_runs WHERE id = ?").get(id) as {
        status: string;
        error: string | null;
        finished_at: number | null;
      };
      expect(r.status).toBe("running");
      expect(r.error).toBeNull();
      expect(r.finished_at).toBeNull();
    }
  });

  it("backward-compat: pre-migration in-flight row (no process_exited_at, no exit_code) + dead pid is still orphan", () => {
    // A row created before migration_014 has process_exited_at=NULL AND exit_code=NULL,
    // because the .then handler only ran in older code that didn't write either column.
    // If pid is dead, recovery must still mark it orphan — otherwise old-data runs
    // with truly dead processes would silently linger forever.
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    insertRun("run-legacy-dead", tid, 77777, 1000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => false, logger, () => 5000);

    expect(result.recovered).toBe(1);
    const row = db.prepare("SELECT status, error FROM task_runs WHERE id = ?").get("run-legacy-dead") as {
      status: string;
      error: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/orphan/i);
  });

  it("only skips pid=null when there are also legitimate orphans to recover", () => {
    const tid = (db.prepare("SELECT id FROM tasks").get() as { id: string }).id;
    insertRun("run-dead", tid, 99999, 1000);
    insertRun("run-no-pid-a", tid, null, 1000);
    insertRun("run-no-pid-b", tid, null, 2000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => false, logger, () => 5000);

    expect(result.recovered).toBe(1);
    expect(result.skippedNoPid).toBe(2);

    for (const id of ["run-no-pid-a", "run-no-pid-b"]) {
      const r = db.prepare("SELECT status FROM task_runs WHERE id = ?").get(id) as { status: string };
      expect(r.status).toBe("running");
    }
  });

  it("skips runs whose task has class!=null even with dead pid (verify path handles those)", () => {
    const store = createTaskStore(db);
    const classedTask = store.createTask({
      name: "classed-shell",
      cron: "*/5 * * * *",
      executor: "shell",
      config: { command: "true", cwd: "/tmp", timeout: 5000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    const legacyTid = (db.prepare("SELECT id FROM tasks WHERE class IS NULL").get() as { id: string }).id;

    insertRun("run-classed-dead", classedTask.id, 55555, 1000);
    insertRun("run-legacy-dead", legacyTid, 66666, 1000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => false, logger, () => 5000);

    expect(result.recovered).toBe(1);
    expect(result.skippedClassed).toBe(1);

    const classedRow = db.prepare("SELECT status, error FROM task_runs WHERE id = ?").get("run-classed-dead") as { status: string; error: string | null };
    expect(classedRow.status).toBe("running");
    expect(classedRow.error).toBeNull();

    const legacyRow = db.prepare("SELECT status, error FROM task_runs WHERE id = ?").get("run-legacy-dead") as { status: string; error: string };
    expect(legacyRow.status).toBe("failed");
    expect(legacyRow.error).toMatch(/orphan/i);
  });

  it("class!=null run with dead pid AND null pid both get skipped", () => {
    const store = createTaskStore(db);
    const classedTask = store.createTask({
      name: "classed-task-2",
      cron: "*/5 * * * *",
      executor: "shell",
      config: { command: "true", cwd: "/tmp", timeout: 5000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });

    insertRun("run-classed-deadpid", classedTask.id, 44444, 1000);
    insertRun("run-classed-nopid", classedTask.id, null, 2000);

    const logger = { warn: vi.fn(), info: vi.fn() };
    const result = recoverOrphanRuns(db, () => false, logger, () => 5000);

    expect(result.recovered).toBe(0);
    expect(result.skippedClassed).toBe(2);
    expect(result.skippedNoPid).toBe(0);

    for (const id of ["run-classed-deadpid", "run-classed-nopid"]) {
      const r = db.prepare("SELECT status FROM task_runs WHERE id = ?").get(id) as { status: string };
      expect(r.status).toBe("running");
    }
  });
});
