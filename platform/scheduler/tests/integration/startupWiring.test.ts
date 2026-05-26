import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { wireUpVerifyScheduler } from "../../src/main.js";

describe("startup wiring", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    vi.useFakeTimers();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  it("wireUpVerifyScheduler starts a tick loop that processes due verifications", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);

    const task = taskStore.createTask({
      name: "wiring",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    verifyStore.scheduleVerification(run.id, Date.now() - 1);

    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      tickIntervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(150);

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("success");
    stop();
  });
});

describe("wireUpVerifyScheduler heal wiring", () => {
  it("returns a stop function and does not throw when db is not provided (no heal)", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      tickIntervalMs: 10_000,
    });
    expect(typeof stop).toBe("function");
    stop();
    db.close();
  });

  it("returns a stop function and wires heal when db is provided", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      db,
      tickIntervalMs: 10_000,
      healTickIntervalMs: 10_000,
    });
    expect(typeof stop).toBe("function");
    stop();
    db.close();
  });
});

describe("wireUpVerifyScheduler migration wiring", () => {
  it("runs migration tick without throwing when db is provided", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const stop = wireUpVerifyScheduler({
      taskStore,
      verifyStore,
      db,
      tickIntervalMs: 10_000,
      healTickIntervalMs: 10_000,
      migrationTickIntervalMs: 10_000,
    });
    expect(typeof stop).toBe("function");
    stop();
    db.close();
  });
});
