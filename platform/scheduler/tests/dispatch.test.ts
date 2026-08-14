import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { createTaskStore } from "../src/db/taskStore.js";
import { runTask } from "../src/dispatch.js";
import type { Task } from "../src/types.js";

function mkTask(store: ReturnType<typeof createTaskStore>, over: Partial<Task> = {}): Task {
  return store.createTask({
    name: over.name ?? "t", description: "", owner: "o", createdBy: "x",
    type: over.type ?? "script", config: over.config ?? { command: "true", cwd: "/tmp" },
    cron: "0 9 * * *", enabled: true, oneshot: over.oneshot ?? false, category: null,
    retryEnabled: over.retryEnabled ?? false, retryExitCodes: over.retryExitCodes,
    retryMax: over.retryMax ?? 0,
    retryDelayMs: over.retryDelayMs ?? 0,
    alertThreshold: over.alertThreshold ?? 0, alertChannel: over.alertChannel ?? "owner_dm",
  });
}

describe("runTask", () => {
  let db: Database.Database;
  let store: ReturnType<typeof createTaskStore>;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    store = createTaskStore(db);
  });

  const noopAlert = vi.fn();
  const deps = (over: Record<string, unknown> = {}) => ({
    store,
    trigger: {
      shell: vi.fn(async () => ({ ok: true, pid: 123 })),
      http: vi.fn(async () => ({ ok: true, childSessionId: "sess-1" })),
    },
    sendAlert: noopAlert,
    onOneshotDone: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...over,
  });

  it("script success writes a success run with pid + last_success_at", async () => {
    const task = mkTask(store);
    const d = deps();
    await runTask(task, d);
    const run = store.recentRuns(task.id, 1)[0];
    expect(run.outcome).toBe("success");
    expect(run.pid).toBe(123);
    expect(store.getTask(task.id)!.lastSuccessAt).not.toBeNull();
  });

  it("session success records childSessionId", async () => {
    const task = mkTask(store, { type: "session",
      config: { url: "http://x/api/spawn2.0", method: "POST", body: { target: "a", prompt: "p" }, timeout: 1000 } });
    await runTask(task, deps());
    expect(store.recentRuns(task.id, 1)[0].childSessionId).toBe("sess-1");
  });

  it("does not deliver the same scheduled tick twice", async () => {
    const task = mkTask(store);
    const d = deps();

    await runTask(task, d, { scheduledAt: 1000 });
    await runTask(task, d, { scheduledAt: 1000 });

    expect(d.trigger.shell).toHaveBeenCalledOnce();
    expect(store.recentRuns(task.id, 10)).toHaveLength(1);
  });

  it("retries a script exit code 75 up to retryMax then finalizes failed", async () => {
    const task = mkTask(store, { retryEnabled: true, retryExitCodes: [75], retryMax: 2, retryDelayMs: 10 });
    const shell = vi.fn(async () => ({ ok: false as const, error: "exit 75", exitCode: 75 }));
    const sleep = vi.fn(async () => {});
    await runTask(task, deps({ trigger: { shell, http: vi.fn() }, sleep }));
    const run = store.recentRuns(task.id, 1)[0];
    expect(run.outcome).toBe("failed");
    expect(shell).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(run.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a scoped script exit code outside retryExitCodes", async () => {
    const task = mkTask(store, { retryEnabled: true, retryExitCodes: [75], retryMax: 5, retryDelayMs: 10 });
    const shell = vi.fn(async () => ({ ok: false as const, error: "exit 1", exitCode: 1 }));
    const sleep = vi.fn(async () => {});
    await runTask(task, deps({ trigger: { shell, http: vi.fn() }, sleep }));
    const run = store.recentRuns(task.id, 1)[0];
    expect(shell).toHaveBeenCalledOnce();
    expect(run.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps legacy retryEnabled behavior for a script exit code", async () => {
    const task = mkTask(store, { retryEnabled: true, retryMax: 2, retryDelayMs: 10 });
    const shell = vi.fn(async () => ({ ok: false as const, error: "exit 1", exitCode: 1 }));
    const sleep = vi.fn(async () => {});
    await runTask(task, deps({ trigger: { shell, http: vi.fn() }, sleep }));
    const run = store.recentRuns(task.id, 1)[0];
    expect(shell).toHaveBeenCalledTimes(3); // 1 + 2 legacy retries
    expect(run.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("keeps legacy retryEnabled behavior for a failed session trigger", async () => {
    const task = mkTask(store, {
      type: "session",
      config: { url: "http://x/api/spawn2.0", method: "POST", body: { target: "a", prompt: "p" }, timeout: 1000 },
      retryEnabled: true,
      retryMax: 5,
      retryDelayMs: 10,
    });
    const http = vi.fn(async () => ({ ok: false as const, error: "HTTP 503" }));
    const sleep = vi.fn(async () => {});
    await runTask(task, deps({ trigger: { shell: vi.fn(), http }, sleep }));
    expect(http).toHaveBeenCalledTimes(6); // 1 + retryMax
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("does not retry when retryEnabled is false", async () => {
    const task = mkTask(store, { retryEnabled: false, retryMax: 5 });
    const shell = vi.fn(async () => ({ ok: false as const, error: "x" }));
    await runTask(task, deps({ trigger: { shell, http: vi.fn() } }));
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("fires alert exactly when consecutive failures == threshold", async () => {
    const task = mkTask(store, { alertThreshold: 2 });
    const shell = vi.fn(async () => ({ ok: false as const, error: "x" }));
    const sendAlert = vi.fn();
    const d = deps({ trigger: { shell, http: vi.fn() }, sendAlert });
    await runTask(store.getTask(task.id)!, d); // fail #1 -> N=1, no alert
    expect(sendAlert).not.toHaveBeenCalled();
    await runTask(store.getTask(task.id)!, d); // fail #2 -> N=2 == threshold -> alert
    expect(sendAlert).toHaveBeenCalledOnce();
    await runTask(store.getTask(task.id)!, d); // fail #3 -> N=3 != 2 -> no second alert
    expect(sendAlert).toHaveBeenCalledOnce();
  });

  it("oneshot success disables task and calls onOneshotDone", async () => {
    const task = mkTask(store, { oneshot: true });
    const onOneshotDone = vi.fn();
    await runTask(task, deps({ onOneshotDone }));
    expect(store.getTask(task.id)!.enabled).toBe(false);
    expect(onOneshotDone).toHaveBeenCalledWith(task.id);
    const audit = db.prepare(`
      SELECT action,actor_class,actor_session,source_comm_id,before_state,after_state
      FROM task_mutations WHERE task_id=? ORDER BY id DESC LIMIT 1
    `).get(task.id) as {
      action: string;
      actor_class: string;
      actor_session: string;
      source_comm_id: string | null;
      before_state: string;
      after_state: string;
    };
    expect(audit).toMatchObject({
      action: "disable",
      actor_class: "scheduler_runtime",
      actor_session: "scheduler",
      source_comm_id: null,
    });
    expect(JSON.parse(audit.before_state)).toMatchObject({ enabled: true });
    expect(JSON.parse(audit.after_state)).toMatchObject({ enabled: false });
  });
});
