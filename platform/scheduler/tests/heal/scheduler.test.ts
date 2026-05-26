import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createHealStore } from "../../src/heal/store.js";
import { runHealTick } from "../../src/heal/scheduler.js";
import { createRateLimitStore } from "../../src/heal/rateLimitStore.js";
import { RATE_LIMIT_QUIET_WINDOW_MS, RATE_LIMIT_SCOPE } from "../../src/heal/rateLimit.js";

function okResult(content: string) {
  return new Response(
    JSON.stringify({ ok: true, status: "completed", finalMessage: content }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("runHealTick", () => {
  let db: Database.Database;
  let taskId: string, runId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    const taskStore = createTaskStore(db);
    const t = taskStore.createTask({
      name: "tick-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner",
    });
    taskId = t.id;
    const run = taskStore.createRun(taskId);
    runId = run.id;
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: 1000 });
    taskStore.updateRunFinal(run.id, "evidence_missing", 5000);
  });
  afterEach(() => db.close());

  it("polls pending proposal and marks replied when ACTION present", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1000, childSessionId: "c1" });

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult("ok, understood.\nACTION: SKIP")) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("replied");
    expect(updated.replyAction).toBe("SKIP");
  });

  it("applies RETRY action by calling retryTaskFn", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1000, childSessionId: "c1" });

    let retriedTaskId = "";
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult("will do.\nACTION: RETRY")) as unknown as typeof fetch,
      retryTaskFn: async (tid) => {
        retriedTaskId = tid;
      },
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    expect(retriedTaskId).toBe(taskId);
    expect(healStore.getProposal(p.id)!.replyAction).toBe("RETRY");
  });

  it("applies DISABLE action by flipping task.enabled=false", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1000, childSessionId: "c1" });

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult("stopping.\nACTION: DISABLE")) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    expect(taskStore.getTask(taskId)!.enabled).toBe(false);
  });

  it("applies 24h timeout → default SKIP for non idempotency", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const spawnedAt = 1000;
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt, childSessionId: "c1" });
    const twentyFiveHoursLater = spawnedAt + 25 * 3600_000;

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: "running" }), { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => twentyFiveHoursLater,
    });

    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("default_applied");
    expect(updated.replyAction).toBe("SKIP");
  });

  it("24h timeout SKIP routes notification through Console card, not raw text DM", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const spawnedAt = 1000;
    healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt, childSessionId: "c1" });
    const twentyFiveHoursLater = spawnedAt + 25 * 3600_000;

    let cardPayload: { title: string; body: string; level: string; metadata?: Record<string, unknown> } | null = null;
    let userDmText: string | null = null;
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async (params) => {
        cardPayload = params as typeof cardPayload;
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: "running" }), { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async (text) => {
        userDmText = text;
      },
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => twentyFiveHoursLater,
    });

    expect(cardPayload).not.toBeNull();
    expect(userDmText).toBeNull();
    expect(cardPayload!.title).toContain("tick-test");
    expect(cardPayload!.metadata).toMatchObject({
      event: "heal_proposal_timeout",
      taskId,
      taskName: "tick-test",
      runId,
      defaultApplied: "SKIP",
    });
  });

  it("retries pending_retry proposal via spawnFn", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1000, childSessionId: null });
    healStore.markPendingRetry(p.id);

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => ({ ok: true, childSessionId: "retry-child" }),
      clock: () => 10_000,
    });

    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("pending");
    expect(updated.childSessionId).toBe("retry-child");
  });

  it("after 3 retries with spawn still failing, falls back through Console card", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 1000, childSessionId: null });
    healStore.markPendingRetry(p.id);
    healStore.markPendingRetry(p.id);
    healStore.markPendingRetry(p.id); // count=3

    let cardCalled = false;
    let userDmCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {
        cardCalled = true;
      },
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {
        userDmCalled = true;
      },
      spawnFn: async () => ({ ok: false, status: 404 }),
      clock: () => 10_000,
    });

    // Heal-timeout SKIP path now routes through Console card; userDm only on card failure.
    expect(cardCalled).toBe(true);
    expect(userDmCalled).toBe(false);
    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("default_applied");
  });

  it("ADJUST without PATCH but task self-modified after spawn → suppresses userDM", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(100, taskId);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 500, childSessionId: "c1" });
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(700, taskId);

    let userDmCalled = false;
    let retryCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult("已经自己修了。\nACTION: ADJUST")) as unknown as typeof fetch,
      retryTaskFn: async () => { retryCalled = true; },
      sendUserDm: async () => { userDmCalled = true; },
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    expect(userDmCalled).toBe(false);
    expect(retryCalled).toBe(false);
    expect(healStore.getProposal(p.id)!.replyAction).toBe("ADJUST");
  });

  it("ADJUST without PATCH and task NOT modified since spawn → still sends userDM (fallback)", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(100, taskId);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 500, childSessionId: "c1" });

    let userDmCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult("不知道咋办。\nACTION: ADJUST")) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => { userDmCalled = true; },
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    expect(userDmCalled).toBe(true);
    expect(healStore.getProposal(p.id)!.replyAction).toBe("ADJUST");
  });

  it("ADJUST with valid PATCH → applies via updateTask + triggers retry, no userDM", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 500, childSessionId: "c1" });

    let retriedTaskId = "";
    let userDmCalled = false;
    const reply = [
      "现在调一下。",
      "ACTION: ADJUST",
      "PATCH:",
      '{ "expectedDurationMs": 3600000, "overrides": { "receiptProof": { "kind": "exit_zero" } } }',
    ].join("\n");

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult(reply)) as unknown as typeof fetch,
      retryTaskFn: async (tid) => { retriedTaskId = tid; },
      sendUserDm: async () => { userDmCalled = true; },
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    const updatedTask = taskStore.getTask(taskId)!;
    expect(updatedTask.expectedDurationMs).toBe(3600000);
    expect(updatedTask.overrides).toEqual({ receiptProof: { kind: "exit_zero" } });
    expect(retriedTaskId).toBe(taskId);
    expect(userDmCalled).toBe(false);
  });

  it("processPending: failed child with Anthropic rate-limit → opens quiet window, proposal stays pending (no applyTimeout)", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const rateLimitStore = createRateLimitStore(db);
    const p = healStore.scheduleProposal({
      taskId,
      runId,
      reason: "evidence_missing",
      spawnedAt: 1000,
      childSessionId: "c1",
    });
    const nowMs = 10_000;

    let cardCalled = false;
    let userDmCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      rateLimitStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {
        cardCalled = true;
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: true,
            status: "failed",
            errorMessage: "Claude: You've hit your limit · resets 9pm",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {
        userDmCalled = true;
      },
      spawnFn: async () => ({ ok: true, childSessionId: "x" }),
      clock: () => nowMs,
    });

    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("pending"); // NOT default_applied
    expect(cardCalled).toBe(false);
    expect(userDmCalled).toBe(false);
    expect(rateLimitStore.getQuietUntil(RATE_LIMIT_SCOPE)).toBe(nowMs + RATE_LIMIT_QUIET_WINDOW_MS);
    const latest = rateLimitStore.getLatest(RATE_LIMIT_SCOPE);
    expect(latest!.sourceTaskId).toBe(taskId);
    expect(latest!.sourceSnippet).toContain("hit your limit");
  });

  it("processPendingRetry: active quiet window suppresses re-spawn", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const rateLimitStore = createRateLimitStore(db);
    const p = healStore.scheduleProposal({
      taskId,
      runId,
      reason: "evidence_missing",
      spawnedAt: 1000,
      childSessionId: null,
    });
    healStore.markPendingRetry(p.id);
    rateLimitStore.recordHit({
      scope: RATE_LIMIT_SCOPE,
      detectedAt: 1_000_000,
      quietUntil: 1_000_000 + RATE_LIMIT_QUIET_WINDOW_MS,
    });

    let spawnCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      rateLimitStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "x" };
      },
      clock: () => 1_000_000 + 30 * 60_000, // 30min into the window
    });

    expect(spawnCalled).toBe(false);
    const updated = healStore.getProposal(p.id)!;
    expect(updated.status).toBe("pending_retry");
    expect(updated.spawnRetryCount).toBe(1); // unchanged (the seed markPendingRetry)
  });

  it("processPendingRetry: expired quiet window allows re-spawn", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    const rateLimitStore = createRateLimitStore(db);
    const p = healStore.scheduleProposal({
      taskId,
      runId,
      reason: "evidence_missing",
      spawnedAt: 1000,
      childSessionId: null,
    });
    healStore.markPendingRetry(p.id);
    rateLimitStore.recordHit({
      scope: RATE_LIMIT_SCOPE,
      detectedAt: 1_000_000,
      quietUntil: 1_000_000 + RATE_LIMIT_QUIET_WINDOW_MS,
    });

    let spawnCalled = false;
    await runHealTick({
      healStore,
      taskStore,
      rateLimitStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => new Response("", { status: 202 })) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => {},
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "post-window-child" };
      },
      clock: () => 1_000_000 + RATE_LIMIT_QUIET_WINDOW_MS + 1,
    });

    expect(spawnCalled).toBe(true);
    expect(healStore.getProposal(p.id)!.childSessionId).toBe("post-window-child");
  });

  it("ADJUST with malformed PATCH JSON → falls through to self-mod check / userDM", async () => {
    const healStore = createHealStore(db);
    const taskStore = createTaskStore(db);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(100, taskId);
    const p = healStore.scheduleProposal({ taskId, runId, reason: "evidence_missing", spawnedAt: 500, childSessionId: "c1" });

    let userDmCalled = false;
    const reply = [
      "ACTION: ADJUST",
      "PATCH:",
      "{ this is not json",
    ].join("\n");

    await runHealTick({
      healStore,
      taskStore,
      smBaseUrl: "http://sm",
      notifyConsole: async () => {},
      fetchImpl: (async () => okResult(reply)) as unknown as typeof fetch,
      retryTaskFn: async () => {},
      sendUserDm: async () => { userDmCalled = true; },
      spawnFn: async () => ({ ok: true, childSessionId: "new" }),
      clock: () => 10_000,
    });

    expect(userDmCalled).toBe(true);
  });
});
