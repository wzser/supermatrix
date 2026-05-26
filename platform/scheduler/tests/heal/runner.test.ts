import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore, type TaskStore } from "../../src/db/taskStore.js";
import { createHealStore, type HealStore } from "../../src/heal/store.js";
import { createHealRunner, parseSpawnResponse } from "../../src/heal/runner.js";
import { createRateLimitStore } from "../../src/heal/rateLimitStore.js";
import { RATE_LIMIT_QUIET_WINDOW_MS, RATE_LIMIT_SCOPE } from "../../src/heal/rateLimit.js";

describe("parseSpawnResponse", () => {
  it("returns ok:true on 200 with childSessionId", () => {
    const r = parseSpawnResponse(200, { childSessionId: "sess_abc" });
    expect(r).toEqual({ ok: true, childSessionId: "sess_abc" });
  });

  it("treats switched_async (HTTP 200 + ok:false + status:switched_async) as ok, using ref as the correlation id", () => {
    const r = parseSpawnResponse(200, {
      ok: false, status: "switched_async", ref: "async_xyz-123",
    });
    expect(r).toEqual({ ok: true, childSessionId: "async_xyz-123" });
  });

  it("returns ok:false when a 200 body is otherwise malformed (no childSessionId, not switched_async)", () => {
    const r = parseSpawnResponse(200, { ok: false, error: "something else" });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false with status on a 404", () => {
    expect(parseSpawnResponse(404, null)).toEqual({ ok: false, status: 404 });
  });

  it("returns ok:false with status on a 400 (transient under new spawn contract)", () => {
    expect(parseSpawnResponse(400, null)).toEqual({ ok: false, status: 400 });
  });

  it("returns ok:false with status on a 500", () => {
    expect(parseSpawnResponse(500, null)).toEqual({ ok: false, status: 500 });
  });
});

describe("healRunner", () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let healStore: HealStore;
  let taskId: string;
  let runId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    taskStore = createTaskStore(db);
    healStore = createHealStore(db);
    const t = taskStore.createTask({
      name: "heal-runner-test",
      cron: "0 * * * *",
      executor: "shell",
      config: { command: "echo", cwd: "/tmp", timeout: 1000 },
      class: "publication",
      expectedDurationMs: 60_000,
      ownerSession: "owner-abc",
    });
    taskId = t.id;
    const run = taskStore.createRun(taskId);
    runId = run.id;
    taskStore.updateRunTrigger(run.id, { triggerStatus: "ok", triggeredAt: 1000 });
  });
  afterEach(() => db.close());

  it("Step 1: pure idempotency triggers retryTaskFn and does not spawn proposal", async () => {
    let retried = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => {
        throw new Error("should not be called for pure path");
      },
      notifyConsole: async () => {},
      sendUserDm: async () => {},
      retryTaskFn: async (tid) => {
        expect(tid).toBe(taskId);
        retried = true;
      },
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "pure",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 1,
    });
    expect(retried).toBe(true);
    expect(healStore.listPending()).toHaveLength(0);
  });

  it("Step 2: non idempotency spawns proposal and records childSessionId", async () => {
    let spawnCalled = false;
    let userDmCalled = false;
    let cardCalled = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async (params) => {
        spawnCalled = true;
        expect(params.target).toBe("owner-abc");
        expect("mode" in params).toBe(false);
        expect(params.prompt).toContain("heal proposal");
        return { ok: true, childSessionId: "child-xyz" };
      },
      notifyConsole: async () => {
        cardCalled = true;
      },
      sendUserDm: async () => {
        userDmCalled = true;
      },
      retryTaskFn: async () => {
        throw new Error("should not be called for non path");
      },
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 3,
    });
    expect(spawnCalled).toBe(true);
    expect(userDmCalled).toBe(false);
    expect(cardCalled).toBe(false);
    const pending = healStore.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].childSessionId).toBe("child-xyz");
  });

  it("Step 3: owner unreachable (404) routes proposal through Console card, not raw text DM", async () => {
    let cardPayload: { title: string; body: string; level: string; metadata?: Record<string, unknown> } | null = null;
    let userDmText: string | null = null;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: false, status: 404 }),
      notifyConsole: async (params) => {
        cardPayload = params as typeof cardPayload;
      },
      sendUserDm: async (text) => {
        userDmText = text;
      },
      retryTaskFn: async () => {},
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "ghost-owner",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 3,
    });
    // Card MUST be sent and userDm MUST NOT be touched on the happy path.
    expect(cardPayload).not.toBeNull();
    expect(userDmText).toBeNull();
    expect(cardPayload!.title).toContain("heal-runner-test");
    expect(cardPayload!.body).toContain("ghost-owner");
    expect(cardPayload!.body).toContain("需要关注");
    expect(cardPayload!.body).toContain("任务目的");
    expect(cardPayload!.body).toContain("原计划执行时间");
    expect(cardPayload!.body).toContain("当前状态");
    expect(cardPayload!.body).toContain("自愈尝试");
    // Console can't reply — card MUST NOT carry the owner-only ACTION instructions.
    expect(cardPayload!.body).not.toContain("ACTION: ADJUST");
    expect(cardPayload!.body).not.toContain("回复格式");
    expect(cardPayload!.level).toBe("warn");
    expect(cardPayload!.metadata).toMatchObject({
      event: "heal_owner_unreachable",
      taskId,
      taskName: "heal-runner-test",
      runId,
      anomaly: "evidence_missing",
      ownerSession: "ghost-owner",
      ownerStatus: 404,
      defaultAction: "SKIP",
    });
    // 404 is terminal: proposal is marked default_applied, NOT pending_retry
    const allRows = [...healStore.listPending(), ...healStore.listPendingRetry()];
    expect(allRows).toHaveLength(0);
    const row = db
      .prepare("SELECT * FROM heal_proposals WHERE task_id = ?")
      .get(taskId) as Record<string, unknown>;
    expect(row.status).toBe("default_applied");
    expect(row.reply_action).toBe("SKIP");
  });

  it("Step 3: skips the Console card for retired tasks (disabled), still marks proposal default_applied SKIP", async () => {
    taskStore.updateTask(taskId, { enabled: false });
    let cardCalled = false;
    let userDmCalled = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: false, status: 404 }),
      notifyConsole: async () => {
        cardCalled = true;
      },
      sendUserDm: async () => {
        userDmCalled = true;
      },
      retryTaskFn: async () => {},
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "ghost-owner",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 3,
    });
    expect(cardCalled).toBe(false);
    expect(userDmCalled).toBe(false);
    const row = db
      .prepare("SELECT * FROM heal_proposals WHERE task_id = ?")
      .get(taskId) as Record<string, unknown>;
    expect(row.status).toBe("default_applied");
    expect(row.reply_action).toBe("SKIP");
  });

  it("Step 3: when Console card itself fails, falls back to a SHORT diagnostic DM (not the long proposal)", async () => {
    let userDmText: string | null = null;
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => ({ ok: false, status: 404 }),
      notifyConsole: async () => {
        throw new Error("console notify HTTP 500: boom");
      },
      sendUserDm: async (text) => {
        userDmText = text;
      },
      retryTaskFn: async () => {},
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "ghost-owner",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 3,
    });
    expect(userDmText).not.toBeNull();
    // Diagnostic must NOT echo the full proposal text — no ACTION list, no PATCH block.
    expect(userDmText).not.toContain("ACTION: ADJUST");
    expect(userDmText).not.toContain("回复格式");
    expect(userDmText).not.toContain("RETRY     现在补跑一次");
    expect(userDmText).toContain("card-send failed");
    expect(userDmText).toContain("heal-runner-test");
    expect(userDmText).toContain("ghost-owner");
    expect(userDmText!.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("rate-limit hit in evidence: pure-idempotency does NOT retry, opens quiet window", async () => {
    const rateLimitStore = createRateLimitStore(db);
    let retried = false;
    let spawnCalled = false;
    let nowMs = 1_700_000_000_000;
    const runner = createHealRunner({
      taskStore,
      healStore,
      rateLimitStore,
      clock: () => nowMs,
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "x" };
      },
      notifyConsole: async () => {},
      sendUserDm: async () => {},
      retryTaskFn: async () => {
        retried = true;
      },
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "pure",
      triggeredAt: 1000,
      evidence: { status: "failed", errorMessage: "You've hit your limit · resets 9pm" },
      verifyAttempts: 1,
    });
    expect(retried).toBe(false);
    expect(spawnCalled).toBe(false);
    expect(rateLimitStore.getQuietUntil(RATE_LIMIT_SCOPE)).toBe(nowMs + RATE_LIMIT_QUIET_WINDOW_MS);
    const latest = rateLimitStore.getLatest(RATE_LIMIT_SCOPE);
    expect(latest!.sourceTaskId).toBe(taskId);
    expect(latest!.sourceRunId).toBe(runId);
    expect(latest!.sourceSnippet).toContain("hit your limit");
  });

  it("rate-limit hit in evidence: non-idempotency does NOT spawn proposal, opens quiet window", async () => {
    const rateLimitStore = createRateLimitStore(db);
    let spawnCalled = false;
    let cardCalled = false;
    let userDmCalled = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      rateLimitStore,
      clock: () => 2_000_000,
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "x" };
      },
      notifyConsole: async () => {
        cardCalled = true;
      },
      sendUserDm: async () => {
        userDmCalled = true;
      },
      retryTaskFn: async () => {},
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { errorMessage: "anthropic responded with 429 Too Many Requests" },
      verifyAttempts: 3,
    });
    expect(spawnCalled).toBe(false);
    expect(cardCalled).toBe(false);
    expect(userDmCalled).toBe(false);
    expect(healStore.listPending()).toHaveLength(0);
    expect(healStore.listPendingRetry()).toHaveLength(0);
    expect(rateLimitStore.getQuietUntil(RATE_LIMIT_SCOPE)).toBe(2_000_000 + RATE_LIMIT_QUIET_WINDOW_MS);
  });

  it("active quiet window: suppresses heal even when evidence has no rate-limit signature", async () => {
    const rateLimitStore = createRateLimitStore(db);
    rateLimitStore.recordHit({
      scope: RATE_LIMIT_SCOPE,
      detectedAt: 1_000,
      quietUntil: 1_000 + RATE_LIMIT_QUIET_WINDOW_MS,
    });
    let retried = false;
    let spawnCalled = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      rateLimitStore,
      clock: () => 1_000 + 30 * 60_000, // 30min into the 60min window
      spawnFn: async () => {
        spawnCalled = true;
        return { ok: true, childSessionId: "x" };
      },
      notifyConsole: async () => {},
      sendUserDm: async () => {},
      retryTaskFn: async () => {
        retried = true;
      },
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "pure",
      triggeredAt: 1000,
      evidence: { note: "unrelated failure" },
      verifyAttempts: 1,
    });
    expect(retried).toBe(false);
    expect(spawnCalled).toBe(false);
  });

  it("expired quiet window: heal proceeds normally", async () => {
    const rateLimitStore = createRateLimitStore(db);
    rateLimitStore.recordHit({
      scope: RATE_LIMIT_SCOPE,
      detectedAt: 1_000,
      quietUntil: 1_000 + RATE_LIMIT_QUIET_WINDOW_MS,
    });
    let retried = false;
    const runner = createHealRunner({
      taskStore,
      healStore,
      rateLimitStore,
      clock: () => 1_000 + RATE_LIMIT_QUIET_WINDOW_MS + 1, // 1ms past expiry
      spawnFn: async () => ({ ok: true, childSessionId: "x" }),
      notifyConsole: async () => {},
      sendUserDm: async () => {},
      retryTaskFn: async () => {
        retried = true;
      },
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "pure",
      triggeredAt: 1000,
      evidence: { note: "unrelated" },
      verifyAttempts: 1,
    });
    expect(retried).toBe(true);
  });

  it("Step 3: transient spawn error (network) records pending_retry", async () => {
    const runner = createHealRunner({
      taskStore,
      healStore,
      spawnFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      notifyConsole: async () => {},
      sendUserDm: async () => {},
      retryTaskFn: async () => {},
    });
    await runner.runHeal({
      taskId,
      runId,
      taskName: "heal-runner-test",
      ownerSession: "owner-abc",
      idempotency: "non",
      triggeredAt: 1000,
      evidence: { note: "test" },
      verifyAttempts: 3,
    });
    const retry = healStore.listPendingRetry();
    expect(retry).toHaveLength(1);
  });
});
