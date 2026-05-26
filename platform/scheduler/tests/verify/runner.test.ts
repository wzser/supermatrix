import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createVerifyStore } from "../../src/verify/store.js";
import { runVerification } from "../../src/verify/runner.js";

describe("runVerification", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("success path: exit_zero passes -> finalize success", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
    });

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("success");
    expect(reloaded.verifyStatus).toBe("pass");
    const v2 = verifyStore.getVerification(v.id)!;
    expect(v2.status).toBe("done");
  });

  it("fail path: exit_zero fails -> finalize evidence_missing", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t2",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
    });

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("evidence_missing");
    expect(reloaded.verifyStatus).toBe("fail");
  });

  it("oneshot+classed task at finalize_success disables task + calls unregisterCron", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "oneshot-classed",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      oneshot: true,
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    const unregistered: string[] = [];
    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      unregisterCron: (taskId) => { unregistered.push(taskId); },
    });

    const reloadedRun = taskStore.getRun(run.id)!;
    expect(reloadedRun.finalStatus).toBe("success");
    const reloadedTask = taskStore.getTask(task.id)!;
    expect(reloadedTask.enabled).toBe(false);
    expect(unregistered).toEqual([task.id]);
  });

  it("non-oneshot+classed at finalize_success leaves task enabled", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "recurring-classed",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    const unregistered: string[] = [];
    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      unregisterCron: (taskId) => { unregistered.push(taskId); },
    });

    const reloadedTask = taskStore.getTask(task.id)!;
    expect(reloadedTask.enabled).toBe(true);
    expect(unregistered).toEqual([]);
  });

  it("oneshot+classed at finalize_evidence_missing leaves task enabled (only success disables)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "oneshot-classed-fail",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      oneshot: true,
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    const unregistered: string[] = [];
    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      unregisterCron: (taskId) => { unregistered.push(taskId); },
    });

    const reloadedTask = taskStore.getTask(task.id)!;
    expect(reloadedTask.enabled).toBe(true);
    expect(unregistered).toEqual([]);
  });

  it("retriable fail reschedules, doesn't finalize", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "t3",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: null }),
    });

    const reloaded = taskStore.getRun(run.id)!;
    expect(reloaded.finalStatus).toBe("pending");
    const v2 = verifyStore.getVerification(v.id)!;
    expect(v2.status).toBe("pending");
    expect(v2.attempts).toBe(1);
    expect(v2.dueAt).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
  });
});

describe("runVerification notifies on state transition", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("calls notify on finalize_evidence_missing with receipt_missing event", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "notify-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "sync_job",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    const notifyMock = vi.fn().mockResolvedValue(undefined);

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      notify: notifyMock,
    });

    expect(notifyMock).toHaveBeenCalled();
    const [rule, ctx] = notifyMock.mock.calls[0];
    expect(ctx.event).toBe("receipt_missing");
    expect(rule.channel).toBe("ownerDM");
  });

  it("no notify on success when succeeded.channel is none (default)", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "notify-success",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "sync_job",
      expectedDurationMs: 300000,
      ownerSession: "tester",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    const notifyMock = vi.fn().mockResolvedValue(undefined);
    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      notify: notifyMock,
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("passes childSessionId and smBaseUrl from deps to proof evaluator", async () => {
    const db2 = new Database(":memory:");
    applyMigrations(db2);
    const taskStore = createTaskStore(db2);
    const verifyStore = createVerifyStore(db2);
    const task = taskStore.createTask({
      name: "reply-proof-task",
      cron: "0 * * * *",
      executor: "http",
      config: { url: "http://localhost/x", method: "POST", timeout: 1000 },
      class: "delegation",
      expectedDurationMs: 600_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "session_reply_content_check", pattern: "REPORT:", patternType: "contains", timeoutMs: 300_000 } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, {
      triggerStatus: "ok",
      triggeredAt: Date.now() - 1000,
      childSessionId: "child_abc",
    });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);

    let gotUrl = "";
    const fetchImpl = (async (url: string) => {
      gotUrl = String(url);
      return new Response(
        JSON.stringify({ ok: true, status: "completed", finalMessage: "REPORT: ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: (runId) => ({ childSessionId: taskStore.getRun(runId)?.childSessionId, smBaseUrl: "http://sm", fetchImpl }),
    });

    expect(gotUrl).toBe("http://sm/api/sessions/child_abc/result");
    expect(taskStore.getRun(run.id)?.finalStatus).toBe("success");
    db2.close();
  });

  it("calls heal on evidence_missing for classed tasks", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "heal-trigger-task",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000); // attempts = 3, forces evidence_missing

    let healArgs: unknown = null;
    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      heal: async (args) => {
        healArgs = args;
      },
    });

    expect(taskStore.getRun(run.id)?.finalStatus).toBe("evidence_missing");
    expect(healArgs).not.toBeNull();
    expect((healArgs as { taskId: string }).taskId).toBe(task.id);
    db.close();
  });

  it("invokes syncTask on finalize_success with the reloaded task + latest run", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "sync-on-success",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "sync_job",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);

    let synced: { taskId?: string; latestRunId?: string } = {};
    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
      syncTask: async (t, latest) => {
        synced = { taskId: t.id, latestRunId: latest?.id };
      },
    });

    expect(synced.taskId).toBe(task.id);
    expect(synced.latestRunId).toBe(run.id);
    db.close();
  });

  it("invokes syncTask on finalize_evidence_missing", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "sync-on-evidence-missing",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
      overrides: { receiptProof: { kind: "exit_zero" } },
    });
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    const ver = verifyStore.scheduleVerification(run.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);
    verifyStore.rescheduleVerification(ver.id, Date.now() - 1000);

    let synced = false;
    await runVerification(ver.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
      syncTask: async () => { synced = true; },
    });

    expect(synced).toBe(true);
    db.close();
  });

  it("finalize_success advances next_run_at for non-oneshot tasks", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "next-run-after-success",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    db.prepare("UPDATE tasks SET next_run_at = 0 WHERE id = ?").run(task.id);
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 0 }),
    });

    const reloaded = taskStore.getTask(task.id)!;
    expect(reloaded.nextRunAt).not.toBeNull();
    expect(reloaded.nextRunAt!).toBeGreaterThan(Date.now());
  });

  it("finalize_evidence_missing advances next_run_at", async () => {
    const taskStore = createTaskStore(db);
    const verifyStore = createVerifyStore(db);
    const task = taskStore.createTask({
      name: "next-run-after-evidence-missing",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 5000 },
      class: "monitoring",
      expectedDurationMs: 300000,
      ownerSession: "tester",
    });
    db.prepare("UPDATE tasks SET next_run_at = 0 WHERE id = ?").run(task.id);
    const run = taskStore.createRun(task.id);
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: Date.now() });
    taskStore.updateRunVerify(run.id, { processExitedAt: Date.now() });
    const v = verifyStore.scheduleVerification(run.id, Date.now());

    await runVerification(v.id, {
      taskStore,
      verifyStore,
      lookupExitContext: () => ({ exitCode: 1 }),
    });

    const reloaded = taskStore.getTask(task.id)!;
    expect(reloaded.nextRunAt).not.toBeNull();
    expect(reloaded.nextRunAt!).toBeGreaterThan(Date.now());
  });
});
