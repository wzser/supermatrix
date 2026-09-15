import { existsSync, statSync } from "node:fs";
import { Hono } from "hono";
import { z, type ZodError } from "zod";
import type { Task, TaskType } from "../types.js";
import type { TaskStore, CreateTaskInput, MutationAuditContext } from "../db/taskStore.js";
import type { CronEngine } from "../cron/engine.js";
import { validateCron } from "../cron/engine.js";
import { createWriteLock, mutationActorClass } from "./auth.js";

export type ApiDeps = {
  store: TaskStore;
  engine: CronEngine;
  runTask: (task: Task, scheduledAt?: number) => Promise<void>;
  adminToken?: string;
  host: string;
  sessionCategory?: (sessionName: string) => string | null | undefined | Promise<string | null | undefined>;
};

const scriptConfigSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  timeout: z.number().finite().positive().optional(),
});

const sessionConfigSchema = z.object({
  url: z.url(),
  method: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.looseObject({
    target: z.string().min(1),
    prompt: z.string().min(1),
  }),
  timeout: z.number().finite().positive(),
});

const baseTaskSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  owner: z.string().min(1),
  createdBy: z.string().default(""),
  type: z.enum(["script", "session"]),
  config: z.unknown(),
  cron: z.string().refine(validateCron, { message: "invalid cron expression" }),
  enabled: z.boolean().default(true),
  oneshot: z.boolean().default(false),
  category: z.string().nullable().default(null),
  retryEnabled: z.boolean().default(false),
  retryExitCodes: z.array(z.int().min(0)).optional(),
  retryMax: z.int().min(0).default(0),
  retryDelayMs: z.int().min(0).default(0),
  alertThreshold: z.int().min(0).default(0),
  alertChannel: z
    .string()
    .refine((v) => v === "owner_dm" || v === "none" || v.startsWith("oc_"), {
      message: "must be 'owner_dm', 'none', or start with 'oc_'",
    })
    .default("owner_dm"),
});
type TaskData = z.infer<typeof baseTaskSchema>;

function renderIssues(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function validateConfigByType(type: TaskType, config: unknown, errors: string[]): void {
  if (type === "script") {
    const parsed = scriptConfigSchema.safeParse(config);
    if (!parsed.success) {
      errors.push(...renderIssues(parsed.error));
      return;
    }
    const { cwd } = parsed.data;
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      errors.push(`config.cwd: '${cwd}' is not an existing directory`);
    }
  } else {
    const parsed = sessionConfigSchema.safeParse(config);
    if (!parsed.success) errors.push(...renderIssues(parsed.error));
  }
}

function validateRetryExitCodesByType(
  type: TaskType,
  retryExitCodes: number[] | undefined,
  errors: string[],
): void {
  if (retryExitCodes !== undefined && type !== "script") {
    errors.push("retryExitCodes: only supported for script tasks");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const EMPLOYEE_REMINDER_TERMS = /提醒|待办|todo|周报|月报|季报|会议|开会|复盘|跟进|查看|检查|记录/u;
const EMPLOYEE_FORBIDDEN_TERMS =
  /\/spawn|\/backend|\/model|\/skills|\/branch|backend|model|spawn|shell|curl|https?:\/\/|http|api|API|executor|代码|改代码|写代码|执行脚本|脚本|接口|平台|业务|数仓|广告|listing|补货|领星|跨\s*session|跨会话|派活|配置|维护|巡检|部署|重启|数据库|SQL/u;

function normalizeEmployeeTaskData(data: TaskData, employeeSessionNames: Set<string>): TaskData {
  if (!employeeSessionNames.has(data.owner)) return data;
  const next: TaskData = {
    ...data,
    createdBy: data.createdBy.trim() === "" ? data.owner : data.createdBy,
  };
  if (next.type !== "session" || !isRecord(next.config)) return next;

  const config = { ...next.config };
  const body = isRecord(config.body) ? { ...config.body } : {};
  if (typeof body.target !== "string" || body.target.trim() === "") body.target = next.owner;
  if (typeof body.from !== "string" || body.from.trim() === "") body.from = next.owner;
  config.body = body;
  return { ...next, config };
}

function employeeTaskPolicyErrors(data: TaskData, employeeSessionNames: Set<string>): string[] {
  const errors: string[] = [];
  if (!employeeSessionNames.has(data.owner)) {
    errors.push("employee_task_policy: 员工发起的任务 owner 必须是该员工群");
  }
  if (data.createdBy && data.createdBy !== data.owner) {
    errors.push("employee_task_policy: 员工提醒任务 createdBy 必须为空或等于员工群 owner");
  }
  if (data.type !== "session") {
    errors.push("employee_task_policy: 员工群只能创建提醒类 session 任务");
    return errors;
  }

  const config = isRecord(data.config) ? data.config : {};
  const body = isRecord(config.body) ? config.body : {};
  const target = typeof body.target === "string" ? body.target.trim() : "";
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const url = (() => {
    try {
      return typeof config.url === "string" ? new URL(config.url) : null;
    } catch {
      return null;
    }
  })();
  const isLoopback = url ? ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) : false;

  if (!url || !isLoopback || url.pathname !== "/api/spawn2.0") {
    errors.push("employee_task_policy: 提醒任务必须通过本机 /api/spawn2.0 发回员工群");
  }
  if (typeof config.method === "string" && config.method.toUpperCase() !== "POST") {
    errors.push("employee_task_policy: 提醒任务必须使用 POST 调用 /api/spawn2.0");
  }
  if (target !== data.owner) {
    errors.push("employee_task_policy: 提醒任务 target 必须等于员工群 owner");
  }
  if (from !== data.owner) {
    errors.push("employee_task_policy: 提醒任务 from 必须等于员工群 owner");
  }
  if ("mode" in body || "supermatrix_internal" in body || "verification_predicate" in body) {
    errors.push("employee_task_policy: 提醒任务不能携带 mode、supermatrix_internal 或 verification_predicate");
  }
  const closure = isRecord(body.closure) ? body.closure : null;
  const closureKind = typeof closure?.kind === "string" ? closure.kind : "";
  const closureTarget = closure && isRecord(closure.target) ? closure.target : null;
  const closureType = typeof closureTarget?.type === "string" ? closureTarget.type : "";
  if (closureKind && closureKind !== "message") {
    errors.push("employee_task_policy: 提醒任务 closure.kind 只能使用 message");
  }
  if (closureType && closureType !== "inline") {
    errors.push("employee_task_policy: 提醒任务 closure 只能使用 inline");
  }
  if (!EMPLOYEE_REMINDER_TERMS.test(prompt)) {
    errors.push("employee_task_policy: 提醒内容必须是提醒、待办、周报、月报、会议、复盘或个人跟进记录");
  }
  if (EMPLOYEE_FORBIDDEN_TERMS.test(prompt)) {
    errors.push("employee_task_policy: 提醒内容不能包含业务、平台、代码或跨 session 执行动作");
  }
  return errors;
}

async function resolveEmployeeSessionNames(
  data: TaskData,
  lookup?: ApiDeps["sessionCategory"],
): Promise<Set<string>> {
  const employeeSessionNames = new Set<string>();
  if (!lookup) return employeeSessionNames;
  const names = [data.owner, data.createdBy].filter((name): name is string => Boolean(name));
  for (const name of new Set(names)) {
    if ((await lookup(name)) === "员工") employeeSessionNames.add(name);
  }
  return employeeSessionNames;
}

function clampLimit(raw: string | undefined, def: number): number {
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

function syncCron(deps: ApiDeps, task: Task): void {
  if (task.enabled) {
    deps.engine.register(task.id, task.cron, (scheduledAt) => {
      void deps.runTask(task, scheduledAt);
    });
  } else {
    try {
      deps.engine.unregister(task.id);
    } catch {
      // not-registered is fine
    }
  }
}

function mutationAuditContext(
  deps: ApiDeps,
  header: (name: string) => string | undefined,
  options: { allowLoopbackSessionOneshot?: boolean } = {},
): MutationAuditContext | null {
  const actorClass = mutationActorClass(deps.adminToken, header("X-Scheduler-Auth"));
  // This route is only reached after createWriteLock has admitted the exact
  // loopback session-oneshot exception. It has no authenticated caller identity,
  // so retain the audit event with an explicit synthetic actor rather than
  // treating request-supplied attribution headers as trustworthy.
  if (options.allowLoopbackSessionOneshot && actorClass === "loopback_session_oneshot") {
    return {
      actorClass,
      actorSession: "loopback_session_oneshot",
      sourceCommId: null,
    };
  }
  const actorSession = header("X-SM-Actor-Session")?.trim();
  const sourceCommId = header("X-SM-Spawn-Comm-Id")?.trim();
  if (!actorSession || !sourceCommId) return null;
  return {
    actorClass,
    actorSession,
    sourceCommId,
  };
}

function missingMutationContext() {
  return {
    ok: false,
    error: "missing mutation context",
    requiredHeaders: ["X-SM-Actor-Session", "X-SM-Spawn-Comm-Id"],
  };
}

export function buildApp(deps: ApiDeps): Hono {
  const app = new Hono();
  const { store } = deps;
  const lock = createWriteLock({ adminToken: deps.adminToken, host: deps.host });

  app.get("/health", (c) => c.json({ ok: true, service: "scheduler-v2" }));

  app.post("/tasks", lock, async (c) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = baseTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, errors: renderIssues(parsed.error) }, 400);
    }
    let data = parsed.data;
    const errors: string[] = [];
    const employeeSessionNames = await resolveEmployeeSessionNames(data, deps.sessionCategory);
    data = normalizeEmployeeTaskData(data, employeeSessionNames);
    validateConfigByType(data.type, data.config, errors);
    validateRetryExitCodesByType(data.type, data.retryExitCodes, errors);
    if (employeeSessionNames.size > 0) {
      errors.push(...employeeTaskPolicyErrors(data, employeeSessionNames));
    }
    if (store.listTasks().some((t) => t.name === data.name)) {
      errors.push(`name: '${data.name}' already exists`);
    }
    if (errors.length > 0) return c.json({ ok: false, errors }, 400);

    const auditContext = deps.adminToken
      ? mutationAuditContext(deps, (name) => c.req.header(name), {
        allowLoopbackSessionOneshot: data.oneshot && data.type === "session",
      })
      : undefined;
    if (auditContext === null) return c.json(missingMutationContext(), 400);

    const task = store.createTask(
      data as unknown as CreateTaskInput,
      auditContext,
    );
    syncCron(deps, task);
    return c.json(task, 201);
  });

  app.get("/tasks", (c) => c.json(store.listTasks()));

  app.get("/tasks/:id", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ ok: false, error: "not found" }, 404);
    return c.json(task);
  });

  app.patch("/tasks/:id", lock, async (c) => {
    const id = c.req.param("id");
    const cur = store.getTask(id);
    if (!cur) return c.json({ ok: false, error: "not found" }, 404);

    const raw = await c.req.json().catch(() => undefined);
    const parsed = baseTaskSchema.partial().safeParse(raw);
    if (!parsed.success) {
      return c.json({ ok: false, errors: renderIssues(parsed.error) }, 400);
    }
    // partial() still injects .default() values for omitted keys, which would
    // clobber untouched fields (e.g. blank an existing description). Keep only
    // the keys the caller actually sent.
    const sent = raw as Record<string, unknown>;
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([k]) => k in sent),
    ) as typeof parsed.data;
    const errors: string[] = [];
    if (patch.config !== undefined || patch.type !== undefined) {
      validateConfigByType(patch.type ?? cur.type, patch.config ?? cur.config, errors);
    }
    let nextData: TaskData = {
      name: patch.name ?? cur.name,
      description: patch.description ?? cur.description,
      owner: patch.owner ?? cur.owner,
      createdBy: patch.createdBy ?? cur.createdBy,
      type: patch.type ?? cur.type,
      config: patch.config ?? cur.config,
      cron: patch.cron ?? cur.cron,
      enabled: patch.enabled ?? cur.enabled,
      oneshot: patch.oneshot ?? cur.oneshot,
      category: patch.category !== undefined ? patch.category : cur.category,
      retryEnabled: patch.retryEnabled ?? cur.retryEnabled,
      retryExitCodes: patch.retryExitCodes ?? cur.retryExitCodes,
      retryMax: patch.retryMax ?? cur.retryMax,
      retryDelayMs: patch.retryDelayMs ?? cur.retryDelayMs,
      alertThreshold: patch.alertThreshold ?? cur.alertThreshold,
      alertChannel: patch.alertChannel ?? cur.alertChannel,
    };
    const employeeSessionNames = await resolveEmployeeSessionNames(nextData, deps.sessionCategory);
    nextData = normalizeEmployeeTaskData(nextData, employeeSessionNames);
    validateRetryExitCodesByType(nextData.type, nextData.retryExitCodes, errors);
    if (employeeSessionNames.size > 0) {
      errors.push(...employeeTaskPolicyErrors(nextData, employeeSessionNames));
    }
    if (patch.name !== undefined && patch.name !== cur.name &&
        store.listTasks().some((t) => t.name === patch.name)) {
      errors.push(`name: '${patch.name}' already exists`);
    }
    if (errors.length > 0) return c.json({ ok: false, errors }, 400);

    const auditContext = deps.adminToken
      ? mutationAuditContext(deps, (name) => c.req.header(name))
      : undefined;
    if (auditContext === null) return c.json(missingMutationContext(), 400);

    const updated = store.updateTask(
      id,
      (employeeSessionNames.size > 0 ? nextData : patch) as Partial<CreateTaskInput>,
      auditContext,
    );
    if (!updated) return c.json({ ok: false, error: "not found" }, 404);
    syncCron(deps, updated);
    return c.json(updated);
  });

  app.delete("/tasks/:id", lock, (c) => {
    const id = c.req.param("id");
    const auditContext = deps.adminToken
      ? mutationAuditContext(deps, (name) => c.req.header(name))
      : undefined;
    if (auditContext === null) return c.json(missingMutationContext(), 400);
    try {
      deps.engine.unregister(id);
    } catch {
      // not-registered is fine
    }
    const deleted = store.deleteTask(
      id,
      auditContext,
    );
    if (!deleted) return c.json({ ok: false, error: "not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/tasks/:id/run", lock, (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ ok: false, error: "not found" }, 404);
    void deps.runTask(task);
    return c.json({ ok: true, accepted: true }, 202);
  });

  app.get("/tasks/:id/runs", (c) => {
    const id = c.req.param("id");
    if (!store.getTask(id)) return c.json({ ok: false, error: "not found" }, 404);
    const limit = clampLimit(c.req.query("limit"), 20);
    return c.json(store.recentRuns(id, limit));
  });

  app.get("/runs/recent", (c) => {
    const limit = clampLimit(c.req.query("limit"), 50);
    const all = store
      .listTasks()
      .flatMap((t) => store.recentRuns(t.id, 100))
      .sort((a, b) => b.triggeredAt - a.triggeredAt)
      .slice(0, limit);
    return c.json(all);
  });

  app.get("/mutations", (c) => {
    const taskId = c.req.query("task_id")?.trim() || undefined;
    const limit = clampLimit(c.req.query("limit"), 50);
    return c.json(store.listMutations(taskId, limit));
  });

  return app;
}
