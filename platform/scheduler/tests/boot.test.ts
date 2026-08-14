import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { createTaskStore } from "../src/db/taskStore.js";
import { bootScheduler } from "../src/main.js";
import { loadConfig } from "../src/config.js";

describe("bootScheduler", () => {
  it("loads enabled tasks into the cron engine and skips disabled ones", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const on = store.createTask({
      name: "on", description: "", owner: "o", createdBy: "x", type: "script",
      config: { command: "true", cwd: "/tmp" }, cron: "0 9 * * *", enabled: true,
      oneshot: false, category: null, retryEnabled: false, retryMax: 0, retryDelayMs: 0,
      alertThreshold: 0, alertChannel: "none",
    });
    store.createTask({
      name: "off", description: "", owner: "o", createdBy: "x", type: "script",
      config: { command: "true", cwd: "/tmp" }, cron: "0 9 * * *", enabled: false,
      oneshot: false, category: null, retryEnabled: false, retryMax: 0, retryDelayMs: 0,
      alertThreshold: 0, alertChannel: "none",
    });
    const { engine } = bootScheduler(db, loadConfig({}));
    const names = engine.list().map((e) => e.name);
    expect(names).toContain(on.id);
    expect(names).toHaveLength(1);
    engine.stopAll();
  });

  it("records an expired availability gap at boot without dispatching its business task", () => {
    const createdAt = Date.parse("2026-07-24T00:00:00+08:00");
    const now = Date.parse("2026-07-26T21:30:00+08:00");
    const deliveredToday = Date.parse("2026-07-26T00:43:00+08:00");
    const missedYesterday = Date.parse("2026-07-25T00:43:00+08:00");
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = createTaskStore(db);
    const task = store.createTask({
      name: "availability-gap", description: "", owner: "ziniao", createdBy: "scheduler",
      type: "script", config: { command: "false", cwd: "/tmp", catchUpOnBoot: true },
      cron: "43 0 * * *", enabled: true, oneshot: false, category: null,
      retryEnabled: false, retryMax: 0, retryDelayMs: 0, alertThreshold: 0, alertChannel: "none",
    });
    const deliveredRun = store.createRun(task.id, deliveredToday, deliveredToday)!;
    store.finalizeRun(deliveredRun, { outcome: "success", attempts: 1, pid: 123 });

    dateNow.mockReturnValue(now);
    const { engine, store: bootStore } = bootScheduler(db, loadConfig({}));
    try {
      const expired = bootStore.recentRuns(task.id, 10).find((run) => run.outcome === "expired");
      expect(expired).toMatchObject({
        scheduledAt: missedYesterday,
        triggeredAt: now,
        outcome: "expired",
        attempts: 0,
        pid: null,
        childSessionId: null,
      });
      expect(expired?.error).toContain("no business task was dispatched");
    } finally {
      engine.stopAll();
      dateNow.mockRestore();
    }
  });
});
