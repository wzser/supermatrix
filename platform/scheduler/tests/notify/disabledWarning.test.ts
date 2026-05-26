import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import {
  createDisabledWarningStore,
  computeCronPeriodMs,
  computeThreshold,
  runDisabledWarningTick,
} from "../../src/notify/disabledWarning.js";

const DAY = 86400_000;

describe("computeCronPeriodMs", () => {
  it("returns 7 days for weekly cron", () => {
    const ms = computeCronPeriodMs("0 8 * * 1", Date.UTC(2026, 3, 26));
    expect(ms).toBe(7 * DAY);
  });
  it("returns 2 days for every-2-day cron", () => {
    const ms = computeCronPeriodMs("0 4 2-30/2 * *", Date.UTC(2026, 3, 26));
    expect(ms).toBe(2 * DAY);
  });
  it("returns 30 minutes for every-30-min cron", () => {
    const ms = computeCronPeriodMs("*/30 * * * *", Date.UTC(2026, 3, 26));
    expect(ms).toBe(30 * 60_000);
  });
  it("returns null for invalid cron", () => {
    expect(computeCronPeriodMs("not-a-cron", Date.now())).toBeNull();
  });
});

describe("computeThreshold", () => {
  const t = Date.UTC(2026, 3, 26);
  it("weekly cron → 21 days", () => {
    expect(computeThreshold("0 8 * * 1", t)).toBe(21 * DAY);
  });
  it("every-2-day cron → 6 days", () => {
    expect(computeThreshold("0 4 2-30/2 * *", t)).toBe(6 * DAY);
  });
  it("hourly cron → bumped to 48h floor (not 3h)", () => {
    expect(computeThreshold("0 * * * *", t)).toBe(48 * 3600_000);
  });
  it("monthly cron → capped at 30d", () => {
    expect(computeThreshold("0 0 1 * *", t)).toBe(30 * DAY);
  });
  it("invalid cron → falls back to 48h floor", () => {
    expect(computeThreshold("invalid", t)).toBe(48 * 3600_000);
  });
});

describe("runDisabledWarningTick", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });
  afterEach(() => db.close());

  it("does nothing when task is enabled", async () => {
    const store = createTaskStore(db);
    store.createTask({
      name: "alive", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
    });
    expect(r.warned).toBe(0);
    expect(dmCount).toBe(0);
  });

  it("sends warning when disabled past threshold and never warned", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "stale", description: "每隔一天凌晨4点全量采集 Amazon 商品listing数据",
      cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "amz-radar",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    const dmCalls: string[] = [];
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async (s) => { dmCalls.push(s); },
      clock: () => 1000 + 7 * DAY,
    });
    expect(r.warned).toBe(1);
    expect(r.skipped).toBe(0);
    expect(dmCalls[0]).toContain("stale");
    expect(dmCalls[0]).toContain("amz-radar");
    expect(dmCalls[0]).toContain("已停用 7 天");
    expect(dmCalls[0]).toContain("每隔一天凌晨4点全量采集 Amazon 商品listing数据");
    expect(dmCalls[0]).toContain(t.id);
  });

  it("falls back to placeholder when task.description is empty", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "no-desc", description: "",
      cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    const dmCalls: string[] = [];
    await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async (s) => { dmCalls.push(s); },
      clock: () => 1000 + 7 * DAY,
    });
    expect(dmCalls[0]).toContain("无描述");
  });

  it("does not warn within the 7-day re-warn cooldown", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "recent-warn", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);
    const ws = createDisabledWarningStore(db);
    ws.upsertWarned(t.id, 1000 + 7 * DAY);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: ws,
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 8 * DAY,
    });
    expect(r.warned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(dmCount).toBe(0);
  });

  it("re-warns after 7 days have passed since last warning", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "old-warn", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);
    const ws = createDisabledWarningStore(db);
    ws.upsertWarned(t.id, 1000 + 7 * DAY);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: ws,
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 15 * DAY,
    });
    expect(r.warned).toBe(1);
    expect(dmCount).toBe(1);
  });

  it("does not warn when disabledFor < threshold (3 days for every-2-day cron)", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "fresh-disabled", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 3 * DAY,
    });
    expect(r.warned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(dmCount).toBe(0);
  });

  it("skips tasks tagged 已废弃 — no nag for ephemeral lifecycle", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "deprecated", description: "完成或主进程停止后自动停用",
      cron: "*/10 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring", expectedDurationMs: 60000, ownerSession: "nas",
      category: "已废弃",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 30 * DAY,
    });
    expect(r.warned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(dmCount).toBe(0);
  });

  it("skips tasks tagged 已完成 — healthy retirement after natural completion", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "completed-project", description: "项目结束自动停用",
      cron: "*/10 * * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring", expectedDurationMs: 60000, ownerSession: "owner",
      category: "已完成",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 30 * DAY,
    });
    expect(r.warned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(dmCount).toBe(0);
  });

  it("skips tasks tagged 一次性补跑 — one-shot lifecycle ends quietly", async () => {
    const store = createTaskStore(db);
    const t = store.createTask({
      name: "oneshot-followup", cron: "0 9 * * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "monitoring", expectedDurationMs: 60000, ownerSession: "owner",
      category: "一次性补跑",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, t.id);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 30 * DAY,
    });
    expect(r.warned).toBe(0);
    expect(dmCount).toBe(0);
  });

  it("evaluates multiple disabled tasks independently", async () => {
    const store = createTaskStore(db);
    const fresh = store.createTask({
      name: "fresh", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    const stale = store.createTask({
      name: "stale", cron: "0 4 2-30/2 * *", executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job", expectedDurationMs: 60000, ownerSession: "owner",
    });
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000 + 5 * DAY, fresh.id);
    db.prepare("UPDATE tasks SET enabled=0, updated_at=? WHERE id=?").run(1000, stale.id);

    let dmCount = 0;
    const r = await runDisabledWarningTick({
      taskStore: store,
      warningStore: createDisabledWarningStore(db),
      sendUserDm: async () => { dmCount++; },
      clock: () => 1000 + 7 * DAY,
    });
    expect(r.warned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(dmCount).toBe(1);
  });
});
