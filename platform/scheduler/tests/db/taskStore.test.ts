import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import type { Task } from "../../src/types.js";

function baseInput(over: Partial<Task> = {}) {
  return {
    name: "t", description: "", owner: "o", createdBy: "tester",
    type: "script" as const, config: { command: "echo hi", cwd: "/tmp" },
    cron: "0 9 * * *", enabled: true, oneshot: false, category: null,
    retryEnabled: false, retryMax: 0, retryDelayMs: 0,
    alertThreshold: 0, alertChannel: "owner_dm",
    ...over,
  };
}

describe("taskStore", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createTaskStore>;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createTaskStore(db);
  });

  it("creates and reads back a task with typed config + booleans", () => {
    const t = store.createTask(baseInput());
    const got = store.getTask(t.id)!;
    expect(got.type).toBe("script");
    expect(got.enabled).toBe(true);
    expect((got.config as { command: string }).command).toBe("echo hi");
    expect(got.lastSuccessAt).toBeNull();
  });

  it("persists an explicit retry exit-code scope", () => {
    const t = store.createTask({ ...baseInput(), retryExitCodes: [75] });
    expect(t.retryExitCodes).toEqual([75]);
    expect(store.getTask(t.id)!.retryExitCodes).toEqual([75]);

    const updated = store.updateTask(t.id, { retryExitCodes: [1, 75] })!;
    expect(updated.retryExitCodes).toEqual([1, 75]);
  });

  it("updates partial fields and bumps updated_at", () => {
    const t = store.createTask(baseInput());
    const updated = store.updateTask(t.id, { enabled: false, cron: "0 10 * * *" })!;
    expect(updated.enabled).toBe(false);
    expect(updated.cron).toBe("0 10 * * *");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(t.updatedAt);
  });

  it("createRun is pessimistic failed; finalizeRun success stamps last_success_at", () => {
    const t = store.createTask(baseInput());
    const runId = store.createRun(t.id, 1000);
    let runs = store.recentRuns(t.id, 10);
    expect(runs[0].outcome).toBe("failed");
    store.finalizeRun(runId, { outcome: "success", attempts: 1, pid: 4242 });
    runs = store.recentRuns(t.id, 10);
    expect(runs[0].outcome).toBe("success");
    expect(runs[0].pid).toBe(4242);
    expect(runs[0].finishedAt).not.toBeNull();
    expect(store.getTask(t.id)!.lastSuccessAt).not.toBeNull();
  });

  it("creates at most one delivery record for a task scheduled tick", () => {
    const t = store.createTask(baseInput());

    const first = store.createRun(t.id, 1100, 1000);
    const duplicate = store.createRun(t.id, 1200, 1000);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(store.recentRuns(t.id, 10)).toHaveLength(1);
  });

  it("recognizes a legacy delivery recorded milliseconds after its planned minute", () => {
    const t = store.createTask(baseInput());
    store.createRun(t.id, 1_004);

    expect(store.hasDeliveryForScheduledAt(t.id, 0)).toBe(true);
  });

  it("records an expired availability gap without claiming a business trigger", () => {
    const t = store.createTask(baseInput());

    expect(store.recordExpiredMissedSlot(t.id, 60_000, 120_000)).toBe(true);
    expect(store.recordExpiredMissedSlot(t.id, 60_000, 180_000)).toBe(false);

    const run = store.recentRuns(t.id, 1)[0];
    expect(run).toMatchObject({
      scheduledAt: 60_000,
      triggeredAt: 120_000,
      outcome: "expired",
      attempts: 0,
      pid: null,
      childSessionId: null,
    });
    expect(run.error).toContain("no business task was dispatched");
    expect(store.getTask(t.id)!.lastSuccessAt).toBeNull();
  });

  it("finalizeRun failed does NOT touch last_success_at", () => {
    const t = store.createTask(baseInput());
    const runId = store.createRun(t.id, 1000);
    store.finalizeRun(runId, { outcome: "failed", attempts: 2, error: "boom" });
    expect(store.getTask(t.id)!.lastSuccessAt).toBeNull();
    expect(store.recentRuns(t.id, 1)[0].attempts).toBe(2);
  });

  it("consecutiveFailures counts the trailing failed streak, resets on success", () => {
    const t = store.createTask(baseInput());
    const mk = (at: number, outcome: "success" | "failed") => {
      const r = store.createRun(t.id, at);
      store.finalizeRun(r!, { outcome, attempts: 1 });
    };
    mk(1, "failed"); mk(2, "failed");
    expect(store.consecutiveFailures(t.id)).toBe(2);
    mk(3, "success");
    expect(store.consecutiveFailures(t.id)).toBe(0);
    mk(4, "failed");
    expect(store.consecutiveFailures(t.id)).toBe(1);
  });

  it("orders runs by insertion when triggered_at ties, so the latest run wins the streak", () => {
    const t = store.createTask(baseInput());
    let scheduledAt = 0;
    const mk = (outcome: "success" | "failed") => {
      const r = store.createRun(t.id, 1000, ++scheduledAt * 60_000); // identical triggered_at, distinct scheduled ticks
      expect(r).not.toBeNull();
      store.finalizeRun(r, { outcome, attempts: 1 });
    };
    mk("failed"); mk("failed"); mk("success");
    // rowid tiebreaker keeps the success (inserted last) at the head → streak resets.
    expect(store.recentRuns(t.id, 1)[0].outcome).toBe("success");
    expect(store.consecutiveFailures(t.id)).toBe(0);
  });

  it("deleteTask removes the task", () => {
    const t = store.createTask(baseInput());
    expect(store.deleteTask(t.id)).toBe(true);
    expect(store.getTask(t.id)).toBeNull();
  });
});
