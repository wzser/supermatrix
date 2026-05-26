import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createHealStore } from "../../src/heal/store.js";
import { maybeEscalateSkips, createHealEscalationStore } from "../../src/heal/escalation.js";

const HOUR = 3600_000;

describe("maybeEscalateSkips", () => {
  let db: Database.Database;
  let taskId: string;
  let taskStore: ReturnType<typeof createTaskStore>;
  let healStore: ReturnType<typeof createHealStore>;
  let escalationStore: ReturnType<typeof createHealEscalationStore>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    taskStore = createTaskStore(db);
    healStore = createHealStore(db);
    escalationStore = createHealEscalationStore(db);
    const t = taskStore.createTask({
      name: "esc-task",
      description: "测试任务,5 分钟检查一次某个状态",
      cron: "*/5 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    taskId = t.id;
  });
  afterEach(() => db.close());

  function skipRun() {
    const run = taskStore.createRun(taskId);
    const p = healStore.scheduleProposal({
      taskId, runId: run.id, reason: "evidence_missing", spawnedAt: Date.now(), childSessionId: null,
    });
    healStore.markReplied(p.id, "SKIP", "", Date.now());
  }
  function successRun() {
    const run = taskStore.createRun(taskId);
    taskStore.updateRunFinal(run.id, "success", Date.now());
  }

  it("does nothing when consecutive SKIP streak < 4", async () => {
    skipRun();
    skipRun();
    skipRun();
    let called = false;
    await maybeEscalateSkips({
      healStore,
      taskStore,
      escalationStore,
      taskId,
      sendUserDm: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("fires userDM when 4 consecutive runs are SKIP'd, with the 4 required sections", async () => {
    skipRun();
    skipRun();
    skipRun();
    skipRun();
    let dmText = "";
    await maybeEscalateSkips({
      healStore,
      taskStore,
      escalationStore,
      taskId,
      sendUserDm: async (text) => {
        dmText = text;
      },
    });
    // 4 sections, Chinese, informational (no prescriptive jargon)
    expect(dmText).toContain("esc-task");
    expect(dmText).toContain("任务目的"); // 1. purpose
    expect(dmText).toContain("测试任务"); //    description rendered
    expect(dmText).toContain("执行频次"); // 2. cron/schedule
    expect(dmText).toContain("当前状态"); // 3. current state
    expect(dmText).toContain("4"); //         streak count
    expect(dmText).toContain("自愈尝试"); // 4. heal history
    // No more obscure English jargon
    expect(dmText).not.toContain("receipt proof config");
    expect(dmText).not.toContain("Consider reviewing");
  });

  it("does not fire when SKIPs are interrupted by successful runs (high-frequency task)", async () => {
    for (let i = 0; i < 6; i++) {
      skipRun();
      successRun();
    }
    let called = false;
    await maybeEscalateSkips({
      healStore,
      taskStore,
      escalationStore,
      taskId,
      sendUserDm: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  it("does not re-fire within the 24h cooldown (escalation spam suppression)", async () => {
    skipRun();
    skipRun();
    skipRun();
    skipRun();
    const t0 = Date.now();
    let firings = 0;
    // first call — fires once
    await maybeEscalateSkips({
      healStore, taskStore, escalationStore, taskId,
      sendUserDm: async () => { firings++; },
      clock: () => t0,
    });
    // second call 1h later — still inside cooldown, no fire
    await maybeEscalateSkips({
      healStore, taskStore, escalationStore, taskId,
      sendUserDm: async () => { firings++; },
      clock: () => t0 + 1 * HOUR,
    });
    // third call 23h later — still inside cooldown
    await maybeEscalateSkips({
      healStore, taskStore, escalationStore, taskId,
      sendUserDm: async () => { firings++; },
      clock: () => t0 + 23 * HOUR,
    });
    expect(firings).toBe(1);
  });

  it("re-fires after the 24h cooldown has elapsed", async () => {
    skipRun();
    skipRun();
    skipRun();
    skipRun();
    const t0 = Date.now();
    let firings = 0;
    await maybeEscalateSkips({
      healStore, taskStore, escalationStore, taskId,
      sendUserDm: async () => { firings++; },
      clock: () => t0,
    });
    await maybeEscalateSkips({
      healStore, taskStore, escalationStore, taskId,
      sendUserDm: async () => { firings++; },
      clock: () => t0 + 25 * HOUR,
    });
    expect(firings).toBe(2);
  });
});
