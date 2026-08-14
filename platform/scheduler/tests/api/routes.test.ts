import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/db/taskStore.js";
import { createCronEngine } from "../../src/cron/engine.js";
import { buildApp } from "../../src/api/routes.js";

function makeApp(
  sessionCategory?: (sessionName: string) => string | null | undefined,
  adminToken?: string,
  host = "127.0.0.1",
) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const store = createTaskStore(db);
  const engine = createCronEngine();
  const app = buildApp({
    store,
    engine,
    runTask: async () => {},
    sessionCategory,
    adminToken,
    host,
  });
  return { app, store, engine, db };
}

const goodScript = {
  name: "daily-x", owner: "ads-master", type: "script",
  config: { command: "echo hi", cwd: "/tmp" }, cron: "0 9 * * *",
};

const goodEmployeeReminder = {
  name: "zhishan-weekly-reminder",
  owner: "employee001",
  createdBy: "employee001",
  type: "session",
  oneshot: true,
  config: {
    url: "http://localhost:3501/api/spawn2.0",
    method: "POST",
    body: {
      from: "employee001",
      target: "employee001",
      prompt: "提醒我提交本周周报并更新 todo 状态",
      closure: { kind: "message", target: { type: "inline" } },
    },
    timeout: 1000,
  },
  cron: "0 9 * * *",
};

describe("v2 API", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => { ctx = makeApp(); });

  it("POST /tasks creates a task (201) and registers it in cron when enabled", async () => {
    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(goodScript),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("daily-x");
    expect(ctx.engine.list().some((e) => e.name === body.id)).toBe(true);
  });

  it("POST /tasks rejects unauthenticated forged oneshot script when admin token is configured", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null, "admin-token");

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodScript,
        name: "forged-oneshot-script",
        oneshot: true,
        owner: "ads-master",
        createdBy: "",
        enabled: true,
      }),
    });

    expect(res.status).toBe(403);
    expect(ctx.store.listTasks()).toHaveLength(0);
    expect(ctx.engine.list()).toHaveLength(0);
  });

  it("POST /tasks preserves loopback session oneshot self-service with a synthetic audit context", async () => {
    ctx = makeApp(undefined, "admin-token", "127.0.0.1");

    const response = await ctx.app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodEmployeeReminder, name: "loopback-self-service-oneshot" }),
    });

    expect(response.status).toBe(201);
    const created = await response.json();
    const audit = ctx.db.prepare(
      `SELECT action,actor_class,actor_session,source_comm_id,before_state,after_state
       FROM task_mutations WHERE task_id=?`,
    ).get(created.id) as {
      action: string;
      actor_class: string;
      actor_session: string;
      source_comm_id: string | null;
      before_state: string | null;
      after_state: string | null;
    };
    expect(audit).toMatchObject({
      action: "create",
      actor_class: "loopback_session_oneshot",
      actor_session: "loopback_session_oneshot",
      source_comm_id: null,
      before_state: null,
    });
    expect(JSON.parse(audit.after_state!)).toMatchObject({ id: created.id, oneshot: true, type: "session" });
  });

  it("POST /tasks blocks an unauthenticated session oneshot on a non-loopback host but allows the same authenticated request", async () => {
    ctx = makeApp(undefined, "admin-token", "0.0.0.0");
    const task = {
      name: "external-session-oneshot",
      owner: "ads-master",
      type: "session",
      oneshot: true,
      config: {
        url: "http://localhost:3501/api/spawn2.0",
        method: "POST",
        body: { target: "ads-master", prompt: "run arbitrary work" },
        timeout: 1000,
      },
      cron: "0 9 * * *",
    };

    const unauthenticated = await ctx.app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task),
    });
    expect(unauthenticated.status).toBe(403);
    expect(ctx.store.listTasks()).toHaveLength(0);
    expect(ctx.engine.list()).toHaveLength(0);

    const authenticated = await ctx.app.request("/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Scheduler-Auth": "admin-token",
        "X-SM-Actor-Session": "scheduler",
        "X-SM-Spawn-Comm-Id": "comm_test-external-session-oneshot",
      },
      body: JSON.stringify(task),
    });
    expect(authenticated.status).toBe(201);
  });

  it("POST /tasks rejects unknown type with 400 + structured errors", async () => {
    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodScript, type: "magic" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors.length).toBeGreaterThan(0);
  });

  it("POST /tasks rejects script with missing cwd dir", async () => {
    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodScript, config: { command: "x", cwd: "/no/such/xyz" } }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tasks rejects bad cron", async () => {
    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodScript, cron: "not a cron" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tasks rejects duplicate name", async () => {
    await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript) });
    const res = await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript) });
    expect(res.status).toBe(400);
  });

  it("POST /tasks allows employee reminder tasks that target the same employee session", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(goodEmployeeReminder),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.owner).toBe("employee001");
    expect(body.type).toBe("session");
  });

  it("POST /tasks fills safe defaults for employee reminders before validation", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodEmployeeReminder,
        createdBy: undefined,
        config: {
          ...goodEmployeeReminder.config,
          body: {
            prompt: "提醒我明天上午检查 todo 并记录跟进事项",
            closure: { kind: "message", target: { type: "inline" } },
          },
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.createdBy).toBe("employee001");
    expect(body.config.body.from).toBe("employee001");
    expect(body.config.body.target).toBe("employee001");
  });

  it("POST /tasks rejects employee script tasks", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodScript, owner: "employee001", createdBy: "employee001", oneshot: true }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 员工群只能创建提醒类 session 任务");
  });

  it("POST /tasks rejects employee-created tasks for another owner", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodEmployeeReminder,
        owner: "ads-master",
        createdBy: "employee001",
        config: {
          ...goodEmployeeReminder.config,
          body: { ...goodEmployeeReminder.config.body, target: "ads-master" },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 员工发起的任务 owner 必须是该员工群");
  });

  it("POST /tasks rejects employee reminder tasks targeting another session", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodEmployeeReminder,
        config: {
          ...goodEmployeeReminder.config,
          body: { ...goodEmployeeReminder.config.body, target: "ads-master" },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 提醒任务 target 必须等于员工群 owner");
  });

  it("POST /tasks rejects employee reminders sent through arbitrary HTTP endpoints", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodEmployeeReminder,
        config: { ...goodEmployeeReminder.config, url: "http://example.com/api/spawn2.0" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 提醒任务必须通过本机 /api/spawn2.0 发回员工群");
  });

  it("POST /tasks rejects employee tasks that ask for platform or business execution", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);

    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...goodEmployeeReminder,
        config: {
          ...goodEmployeeReminder.config,
          body: { ...goodEmployeeReminder.config.body, prompt: "提醒我执行 /spawn 去改 backend model 配置" },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 提醒内容不能包含业务、平台、代码或跨 session 执行动作");
  });

  it("PATCH /tasks/:id rejects employee reminder tasks changed into platform execution", async () => {
    ctx = makeApp((sessionName) => sessionName === "employee001" ? "员工" : null);
    const created = await (await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(goodEmployeeReminder),
    })).json();

    const res = await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          ...goodEmployeeReminder.config,
          body: { ...goodEmployeeReminder.config.body, prompt: "提醒我执行 /spawn 去改 backend model 配置" },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toContain("employee_task_policy: 提醒内容不能包含业务、平台、代码或跨 session 执行动作");
  });

  it("PATCH /tasks/:id updates and re-registers; DELETE unregisters", async () => {
    const created = await (await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript) })).json();
    const patch = await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(ctx.engine.list().some((e) => e.name === created.id)).toBe(false);
    const del = await ctx.app.request(`/tasks/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(ctx.store.getTask(created.id)).toBeNull();
  });

  it("requires scheduler admin to delete session and script oneshots, then retains deletion audit", async () => {
    ctx = makeApp(undefined, "admin-token", "127.0.0.1");
    const script = ctx.store.createTask({
      ...goodScript,
      name: "script-oneshot-delete",
      description: "",
      createdBy: "",
      enabled: true,
      oneshot: true,
      category: null,
      retryEnabled: false,
      retryMax: 0,
      retryDelayMs: 0,
      alertThreshold: 0,
      alertChannel: "none",
    } as never);
    const session = ctx.store.createTask({
      ...goodEmployeeReminder,
      name: "session-oneshot-delete",
      description: "",
      enabled: true,
      category: null,
      retryEnabled: false,
      retryMax: 0,
      retryDelayMs: 0,
      alertThreshold: 0,
      alertChannel: "none",
    } as never);

    expect((await ctx.app.request(`/tasks/${script.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await ctx.app.request(`/tasks/${session.id}`, { method: "DELETE" })).status).toBe(403);
    expect(ctx.store.getTask(script.id)).not.toBeNull();
    expect(ctx.store.getTask(session.id)).not.toBeNull();

    const headers = {
      "X-Scheduler-Auth": "admin-token",
      "X-SM-Actor-Session": "scheduler",
      "X-SM-Spawn-Comm-Id": "comm_test-oneshot-delete",
    };
    expect((await ctx.app.request(`/tasks/${script.id}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await ctx.app.request(`/tasks/${session.id}`, { method: "DELETE", headers })).status).toBe(200);

    const audits = ctx.db.prepare(
      "SELECT timestamp,task_id,action,actor_class FROM task_mutations ORDER BY task_id",
    ).all() as Array<{ timestamp: number; task_id: string; action: string; actor_class: string }>;
    expect(audits).toEqual([
      { timestamp: expect.any(Number), task_id: script.id, action: "delete", actor_class: "scheduler_admin" },
      { timestamp: expect.any(Number), task_id: session.id, action: "delete", actor_class: "scheduler_admin" },
    ].sort((a, b) => a.task_id.localeCompare(b.task_id)));
  });

  it("records a synthetic deletion with its real actor session and source comm id", async () => {
    ctx = makeApp(undefined, "admin-token");
    const task = ctx.store.createTask({
      ...goodScript,
      name: "synthetic-audit-delete",
      description: "synthetic task for mutation audit regression",
      createdBy: "scheduler",
      enabled: true,
      oneshot: true,
      category: null,
      retryEnabled: false,
      retryMax: 0,
      retryDelayMs: 0,
      alertThreshold: 0,
      alertChannel: "none",
    } as never);
    const sourceCommId = "comm_judg-2026-08-06-001-delete";

    const response = await ctx.app.request(`/tasks/${task.id}`, {
      method: "DELETE",
      headers: {
        "X-Scheduler-Auth": "admin-token",
        "X-SM-Actor-Session": "pinglunmaster",
        "X-SM-Spawn-Comm-Id": sourceCommId,
      },
    });

    expect(response.status).toBe(200);
    const audit = ctx.db.prepare(`
      SELECT actor_session, occurred_at_utc, action, task_id,
             before_state, after_state, source_comm_id
      FROM task_mutations
      WHERE task_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(task.id) as {
      actor_session: string;
      occurred_at_utc: string;
      action: string;
      task_id: string;
      before_state: string;
      after_state: string | null;
      source_comm_id: string;
    };

    expect(audit).toMatchObject({
      actor_session: "pinglunmaster",
      occurred_at_utc: expect.stringMatching(/Z$/),
      action: "delete",
      task_id: task.id,
      after_state: null,
      source_comm_id: sourceCommId,
    });
    expect(JSON.parse(audit.before_state)).toMatchObject({
      id: task.id,
      enabled: true,
      name: "synthetic-audit-delete",
    });
  });

  it("rejects configured writes when their caller context is absent", async () => {
    ctx = makeApp(undefined, "admin-token");
    const response = await ctx.app.request("/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Scheduler-Auth": "admin-token" },
      body: JSON.stringify({ ...goodScript, name: "missing-audit-context" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "missing mutation context" });
    expect(ctx.store.listTasks()).toHaveLength(0);
  });

  it("records create, update, disable, and delete mutations with explicit context", async () => {
    ctx = makeApp(undefined, "admin-token");
    const headers = (sourceCommId: string) => ({
      "content-type": "application/json",
      "X-Scheduler-Auth": "admin-token",
      "X-SM-Actor-Session": "pinglunmaster",
      "X-SM-Spawn-Comm-Id": sourceCommId,
    });
    const created = await (await ctx.app.request("/tasks", {
      method: "POST",
      headers: headers("comm_test-create"),
      body: JSON.stringify({ ...goodScript, name: "audited-task" }),
    })).json();
    expect((await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH",
      headers: headers("comm_test-update"),
      body: JSON.stringify({ description: "updated description" }),
    })).status).toBe(200);
    expect((await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH",
      headers: headers("comm_test-disable"),
      body: JSON.stringify({ enabled: false }),
    })).status).toBe(200);
    expect((await ctx.app.request(`/tasks/${created.id}`, {
      method: "DELETE",
      headers: headers("comm_test-delete"),
    })).status).toBe(200);

    const audits = ctx.db.prepare(
      `SELECT occurred_at_utc,task_id,action,actor_class,actor_session,
              source_comm_id,before_state,after_state
       FROM task_mutations WHERE task_id=? ORDER BY id`,
    ).all(created.id) as Array<{
      occurred_at_utc: string;
      task_id: string;
      action: string;
      actor_class: string;
      actor_session: string;
      source_comm_id: string;
      before_state: string | null;
      after_state: string | null;
    }>;
    expect(audits.map((audit) => ({
      occurred_at_utc: audit.occurred_at_utc,
      task_id: audit.task_id,
      action: audit.action,
      actor_class: audit.actor_class,
      actor_session: audit.actor_session,
      source_comm_id: audit.source_comm_id,
    }))).toEqual([
      { occurred_at_utc: expect.stringMatching(/Z$/), task_id: created.id, action: "create", actor_class: "scheduler_admin", actor_session: "pinglunmaster", source_comm_id: "comm_test-create" },
      { occurred_at_utc: expect.stringMatching(/Z$/), task_id: created.id, action: "update", actor_class: "scheduler_admin", actor_session: "pinglunmaster", source_comm_id: "comm_test-update" },
      { occurred_at_utc: expect.stringMatching(/Z$/), task_id: created.id, action: "disable", actor_class: "scheduler_admin", actor_session: "pinglunmaster", source_comm_id: "comm_test-disable" },
      { occurred_at_utc: expect.stringMatching(/Z$/), task_id: created.id, action: "delete", actor_class: "scheduler_admin", actor_session: "pinglunmaster", source_comm_id: "comm_test-delete" },
    ]);
    expect(audits[0].before_state).toBeNull();
    expect(JSON.parse(audits[0].after_state!)).toMatchObject({ id: created.id, enabled: true });
    expect(JSON.parse(audits[1].before_state!)).toMatchObject({ description: "" });
    expect(JSON.parse(audits[1].after_state!)).toMatchObject({ description: "updated description" });
    expect(JSON.parse(audits[2].before_state!)).toMatchObject({ enabled: true });
    expect(JSON.parse(audits[2].after_state!)).toMatchObject({ enabled: false });
    expect(JSON.parse(audits[3].before_state!)).toMatchObject({ enabled: false });
    expect(audits[3].after_state).toBeNull();
    expect(ctx.db.prepare("PRAGMA table_info(task_mutations)").all().map((c: { name: string }) => c.name))
      .toEqual([
        "id", "timestamp", "occurred_at_utc", "task_id", "action", "actor_class",
        "actor_session", "source_comm_id", "before_state", "after_state",
      ]);
  });

  it("PATCH /tasks/:id with one field does not blank untouched fields", async () => {
    const created = await (await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...goodScript, description: "keep me" }),
    })).json();
    expect(created.description).toBe("keep me");
    const patch = await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "平台运维" }),
    });
    expect(patch.status).toBe(200);
    const after = ctx.store.getTask(created.id)!;
    expect(after.description).toBe("keep me");
    expect(after.category).toBe("平台运维");
  });

  it("PATCH /tasks/:id persists retryExitCodes for a script task", async () => {
    const created = await (await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript),
    })).json();
    const patch = await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ retryExitCodes: [75] }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).retryExitCodes).toEqual([75]);
    expect(ctx.store.getTask(created.id)!.retryExitCodes).toEqual([75]);
  });

  it("POST /tasks rejects retryExitCodes for a session task", async () => {
    const res = await ctx.app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "session-no-exit-scope", owner: "ads-master", type: "session",
        config: {
          url: "http://localhost:3501/api/spawn2.0", method: "POST",
          body: { target: "ads-master", prompt: "run" }, timeout: 1000,
        },
        cron: "0 9 * * *", retryExitCodes: [75],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toContain("retryExitCodes: only supported for script tasks");
  });

  it("PATCH /tasks/:id rejects a type switch that orphans the existing config", async () => {
    const created = await (await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript) })).json();
    const res = await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session" }),
    });
    expect(res.status).toBe(400);
    expect(ctx.store.getTask(created.id)!.type).toBe("script");
  });

  it("POST /tasks/:id/run returns 202", async () => {
    const created = await (await ctx.app.request("/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(goodScript) })).json();
    const res = await ctx.app.request(`/tasks/${created.id}/run`, { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("GET /health is ok", async () => {
    expect((await ctx.app.request("/health")).status).toBe(200);
  });

  it("GET /mutations lists mutation audit read-only, filterable by task_id", async () => {
    ctx = makeApp(undefined, "admin-token");
    const headers = (sourceCommId: string) => ({
      "content-type": "application/json",
      "X-Scheduler-Auth": "admin-token",
      "X-SM-Actor-Session": "pinglunmaster",
      "X-SM-Spawn-Comm-Id": sourceCommId,
    });
    const created = await (await ctx.app.request("/tasks", {
      method: "POST",
      headers: headers("comm_mutations-create"),
      body: JSON.stringify({ ...goodScript, name: "mutation-query" }),
    })).json();
    await ctx.app.request(`/tasks/${created.id}`, {
      method: "PATCH",
      headers: headers("comm_mutations-update"),
      body: JSON.stringify({ alertThreshold: 7, description: "changed" }),
    });

    const noAuth = await ctx.app.request("/mutations?task_id=" + created.id);
    expect(noAuth.status).toBe(200);
    const rows = await noAuth.json() as Array<{
      taskId: string; action: string; actorSession: string; changedFields: string[];
    }>;
    expect(rows.map((r) => r.action)).toEqual(["update", "create"]);
    expect(rows.every((r) => r.taskId === created.id)).toBe(true);
    expect(rows.every((r) => r.actorSession === "pinglunmaster")).toBe(true);
    expect(rows[0].changedFields).toEqual(expect.arrayContaining(["alertThreshold", "description"]));

    const scoped = await (await ctx.app.request(`/mutations?task_id=${created.id}&limit=1`)).json() as unknown[];
    expect(scoped).toHaveLength(1);
    expect((scoped[0] as { action: string }).action).toBe("update");

    const global = await (await ctx.app.request("/mutations?limit=100")).json() as unknown[];
    expect(global.length).toBeGreaterThanOrEqual(2);
  });
});
