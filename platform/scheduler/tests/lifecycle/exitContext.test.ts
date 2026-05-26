import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore, type TaskStore } from "../../src/db/taskStore.js";
import { createExitTracker } from "../../src/lifecycle/exitTracker.js";
import { createLookupExitContext } from "../../src/lifecycle/exitContext.js";

describe("createLookupExitContext", () => {
  let db: Database.Database;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createTaskStore(db);
    const task = store.createTask({
      name: "exit-ctx-task",
      cron: "0 9 * * *",
      executor: "shell",
      config: { command: "true", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 60000,
      ownerSession: "tester",
    });
    taskId = task.id;
  });

  afterEach(() => db.close());

  it("returns the in-memory exit code when the tracker has it (no DB read needed)", async () => {
    const tracker = createExitTracker();
    const run = store.createRun(taskId);
    tracker.register(run.id, Promise.resolve({
      exitCode: 0, signal: null, stdout: "", stderr: "", exitedAt: 1000,
    }));
    await new Promise((r) => setImmediate(r));

    const lookup = createLookupExitContext({
      exitTracker: tracker, store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup(run.id).exitCode).toBe(0);
  });

  it("falls back to the persisted exit_code when the tracker has no record (post-restart)", () => {
    // Simulate: child exited cleanly, .then wrote exit_code to DB, then scheduler bounced.
    // After restart, the new tracker is empty. Lookup must read from DB.
    const run = store.createRun(taskId);
    store.updateRunVerify(run.id, { processExitedAt: 2000, exitCode: 0 });

    const freshTracker = createExitTracker(); // brand-new memory after restart
    const lookup = createLookupExitContext({
      exitTracker: freshTracker, store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup(run.id).exitCode).toBe(0);
  });

  it("falls back and surfaces non-zero exit codes (proof must be able to fail)", () => {
    const run = store.createRun(taskId);
    store.updateRunVerify(run.id, { processExitedAt: 2000, exitCode: 137 });

    const freshTracker = createExitTracker();
    const lookup = createLookupExitContext({
      exitTracker: freshTracker, store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup(run.id).exitCode).toBe(137);
  });

  it("returns null when tracker says still-running (do not fall back to a possibly-stale DB row)", () => {
    const tracker = createExitTracker();
    const run = store.createRun(taskId);
    // Register a never-resolving promise: in-memory says "still running".
    tracker.register(run.id, new Promise(() => {}));

    const lookup = createLookupExitContext({
      exitTracker: tracker, store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup(run.id).exitCode).toBeNull();
  });

  it("returns null exitCode when neither tracker nor DB knows (unknown run)", () => {
    const lookup = createLookupExitContext({
      exitTracker: createExitTracker(), store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup("never-existed").exitCode).toBeNull();
  });

  it("includes childSessionId from the persisted run (used by other proof types)", () => {
    const run = store.createRun(taskId);
    store.updateRunTrigger(run.id, {
      triggerStatus: "ok",
      triggeredAt: Date.now(),
      childSessionId: "child-abc",
    });
    const lookup = createLookupExitContext({
      exitTracker: createExitTracker(), store, smBaseUrl: "http://localhost:3501",
    });
    expect(lookup(run.id).childSessionId).toBe("child-abc");
    expect(lookup(run.id).smBaseUrl).toBe("http://localhost:3501");
  });
});
