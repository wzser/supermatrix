import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createHealStore } from "../../src/heal/store.js";

describe("healStore", () => {
  let db: Database.Database;
  let taskId: string;
  let runId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const task = taskStore.createTask({
      name: "heal-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    taskId = task.id;
    const run = taskStore.createRun(taskId);
    runId = run.id;
  });
  afterEach(() => db.close());

  it("scheduleProposal inserts a pending row", () => {
    const store = createHealStore(db);
    const p = store.scheduleProposal({
      taskId,
      runId,
      reason: "evidence_missing",
      spawnedAt: 1000,
      childSessionId: "c1",
    });
    expect(p.status).toBe("pending");
    expect(p.childSessionId).toBe("c1");
  });

  it("listPending returns only pending rows", () => {
    const store = createHealStore(db);
    const a = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1, childSessionId: "c1" });
    store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 2, childSessionId: "c2" });
    store.markReplied(a.id, "SKIP", "ACTION: SKIP", 100);
    const pending = store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("c2");
  });

  it("markReplied records action + raw reply", () => {
    const store = createHealStore(db);
    const p = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1, childSessionId: "c1" });
    store.markReplied(p.id, "RETRY", "ACTION: RETRY now please", 123);
    const updated = store.getProposal(p.id)!;
    expect(updated.status).toBe("replied");
    expect(updated.replyAction).toBe("RETRY");
    expect(updated.replyRaw).toBe("ACTION: RETRY now please");
    expect(updated.repliedAt).toBe(123);
  });

  it("markDefaultApplied uses SKIP as reply_action", () => {
    const store = createHealStore(db);
    const p = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1, childSessionId: "c1" });
    store.markDefaultApplied(p.id, "SKIP", 5000);
    const updated = store.getProposal(p.id)!;
    expect(updated.status).toBe("default_applied");
    expect(updated.replyAction).toBe("SKIP");
    expect(updated.defaultAppliedAt).toBe(5000);
  });

  it("markPendingRetry increments spawn_retry_count", () => {
    const store = createHealStore(db);
    const p = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1, childSessionId: null });
    store.markPendingRetry(p.id);
    store.markPendingRetry(p.id);
    const updated = store.getProposal(p.id)!;
    expect(updated.status).toBe("pending_retry");
    expect(updated.spawnRetryCount).toBe(2);
  });

  it("listAll returns all proposals regardless of status", () => {
    const store = createHealStore(db);
    const a = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1, childSessionId: "c1" });
    const b = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 2, childSessionId: "c2" });
    store.markReplied(a.id, "RETRY", "ACTION: RETRY", 100);
    store.markDefaultApplied(b.id, "SKIP", 200);
    expect(store.listAll()).toHaveLength(2);
    expect(store.listAll("replied")).toHaveLength(1);
    expect(store.listAll("default_applied")).toHaveLength(1);
    expect(store.listAll("pending")).toHaveLength(0);
  });

  it("countSkipsLast30Days counts SKIP+DISABLE defaults and replies in window", () => {
    const store = createHealStore(db);
    const now = Date.now();
    const old = now - 40 * 24 * 3600_000;
    const recent = now - 5 * 24 * 3600_000;

    const a = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: old, childSessionId: "c1" });
    store.markReplied(a.id, "SKIP", "", old + 1);

    const b = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: recent, childSessionId: "c2" });
    store.markReplied(b.id, "SKIP", "", recent + 1);

    const c = store.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: recent, childSessionId: "c3" });
    store.markDefaultApplied(c.id, "SKIP", recent + 2);

    expect(store.countSkipsLast30Days(taskId, now)).toBe(2);
  });

  describe("countConsecutiveSkippedRunsSinceSuccess", () => {
    function skipRun(taskStore: ReturnType<typeof createTaskStore>, healStore: ReturnType<typeof createHealStore>) {
      const run = taskStore.createRun(taskId);
      const p = healStore.scheduleProposal({
        taskId, runId: run.id, reason: "evidence_missing", spawnedAt: Date.now(), childSessionId: null,
      });
      healStore.markReplied(p.id, "SKIP", "", Date.now());
    }
    function successRun(taskStore: ReturnType<typeof createTaskStore>) {
      const run = taskStore.createRun(taskId);
      taskStore.updateRunFinal(run.id, "success", Date.now());
    }

    it("returns 0 when there are no skipped runs", () => {
      const store = createHealStore(db);
      expect(store.countConsecutiveSkippedRunsSinceSuccess(taskId)).toBe(0);
    });

    it("counts a streak of consecutive skipped runs", () => {
      const taskStore = createTaskStore(db);
      const store = createHealStore(db);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      expect(store.countConsecutiveSkippedRunsSinceSuccess(taskId)).toBe(4);
    });

    it("stops counting at the most recent successful run", () => {
      const taskStore = createTaskStore(db);
      const store = createHealStore(db);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      successRun(taskStore);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      expect(store.countConsecutiveSkippedRunsSinceSuccess(taskId)).toBe(3);
    });

    it("returns 0 when the latest run succeeded", () => {
      const taskStore = createTaskStore(db);
      const store = createHealStore(db);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      skipRun(taskStore, store);
      successRun(taskStore);
      expect(store.countConsecutiveSkippedRunsSinceSuccess(taskId)).toBe(0);
    });

    it("ignores non-skip non-success runs without breaking the streak", () => {
      const taskStore = createTaskStore(db);
      const store = createHealStore(db);
      skipRun(taskStore, store);
      const r = taskStore.createRun(taskId);
      taskStore.updateRunFinal(r.id, "trigger_failed", Date.now());
      skipRun(taskStore, store);
      expect(store.countConsecutiveSkippedRunsSinceSuccess(taskId)).toBe(2);
    });
  });
});
