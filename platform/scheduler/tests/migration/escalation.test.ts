import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createMigrationStore } from "../../src/migration/store.js";
import { maybeEscalateMigration } from "../../src/migration/escalation.js";

const DAY = 24 * 3600_000;

describe("maybeEscalateMigration", () => {
  let db: Database.Database;
  let taskId: string;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const ts = createTaskStore(db);
    taskId = ts.createTask({
      name: "esc-t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
    }).id;
  });
  afterEach(() => db.close());

  it("does nothing when laterCount < 2", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const p = ms.scheduleProposal({
      taskId, ownerSession: "o", childSessionId: "c",
      spawnedAt: 0, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
    });
    ms.markReplied(p.id, "LATER", "", 100);
    let called = false;
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 15,
      sendUserDm: async () => { called = true; },
    });
    expect(called).toBe(false);
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(0);
  });

  it("fires stage 1 userDM when laterCount>=2 and first proposal was >=14d ago", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const p1 = ms.scheduleProposal({
      taskId, ownerSession: "o", childSessionId: "c1",
      spawnedAt: 0, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
    });
    ms.markReplied(p1.id, "LATER", "", 100);
    const p2 = ms.scheduleProposal({
      taskId, ownerSession: "o", childSessionId: "c2",
      spawnedAt: DAY * 8, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
    });
    ms.markReplied(p2.id, "LATER", "", DAY * 8 + 100);

    let dmText = "";
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 15,
      sendUserDm: async (t) => { dmText = t; },
    });
    expect(dmText).toContain("esc-t");
    expect(dmText).toContain("migration");
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(1);
  });

  it("fires stage 2 userDM when laterCount>=3 and first proposal was >=30d ago", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const times = [0, DAY * 8, DAY * 16];
    for (const t of times) {
      const p = ms.scheduleProposal({
        taskId, ownerSession: "o", childSessionId: `c${t}`,
        spawnedAt: t, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
      });
      ms.markReplied(p.id, "LATER", "", t + 100);
    }
    ts.updateTask(taskId, { migrationEscalationStage: 1 });

    let dmText = "";
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 31,
      sendUserDm: async (t) => { dmText = t; },
    });
    expect(dmText).toContain("esc-t");
    expect(dmText).toContain("30");
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(2);
  });

  it("fires stage 1 first (not stage 2) even when laterCount>=3 and days>=30 but stage is still 0", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const times = [0, DAY * 8, DAY * 16];
    for (const t of times) {
      const p = ms.scheduleProposal({
        taskId, ownerSession: "o", childSessionId: `c${t}`,
        spawnedAt: t, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
      });
      ms.markReplied(p.id, "LATER", "", t + 100);
    }
    // stage stays at 0 — this tick should advance to 1, NOT skip straight to 2.

    let dmText = "";
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 31,
      sendUserDm: async (t) => { dmText = t; },
    });
    expect(dmText).toContain("esc-t");
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(1);
    // On a later tick (with stage now 1), escalation to 2 should then fire.
    let dm2 = "";
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 31,
      sendUserDm: async (t) => { dm2 = t; },
    });
    expect(dm2).toContain("30");
    expect(ts.getTask(taskId)!.migrationEscalationStage).toBe(2);
  });

  it("does not re-fire the same stage twice", async () => {
    const ts = createTaskStore(db);
    const ms = createMigrationStore(db);
    const p1 = ms.scheduleProposal({
      taskId, ownerSession: "o", childSessionId: "c1",
      spawnedAt: 0, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
    });
    ms.markReplied(p1.id, "LATER", "", 100);
    const p2 = ms.scheduleProposal({
      taskId, ownerSession: "o", childSessionId: "c2",
      spawnedAt: DAY * 8, suggestedClass: "sync_job", suggestedExpectedDurationMs: 1,
    });
    ms.markReplied(p2.id, "LATER", "", DAY * 8 + 100);
    ts.updateTask(taskId, { migrationEscalationStage: 1 });

    let called = false;
    await maybeEscalateMigration({
      taskStore: ts, migrationStore: ms, taskId, nowMs: DAY * 15,
      sendUserDm: async () => { called = true; },
    });
    expect(called).toBe(false);
  });
});
