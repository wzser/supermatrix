import { Hono } from "hono";
import { z } from "zod";
import type { TaskStore } from "../db/taskStore.js";
import { validateCron } from "../cron/engine.js";
import type { CronEngine } from "../cron/engine.js";
import { resolveOverrides } from "../classes/resolveOverrides.js";
import { checkHardConstraints } from "../classes/hardConstraints.js";
import { lintTaskInput, type LintInput } from "../classes/creationLint.js";
import type { DimensionValues } from "../classes/types.js";
import type { HealStore } from "../heal/store.js";
import type { MigrationStore } from "../migration/store.js";
import type { CreationReviewStore } from "../review/creationReviewStore.js";
import type { OwnerNoticeSender } from "../review/ownerNotice.js";

function zodIssuesToErrors(zodError: z.ZodError) {
  return zodError.issues.map((i) => ({
    code: "schema_invalid",
    field: i.path.length > 0 ? i.path.join(".") : "(root)",
    message: i.message,
    hint: "See docs/migrating-from-legacy.md for required POST /tasks fields. Lint codes catalog: sop/creation-lint-errors.md.",
  }));
}

const taskClassSchema = z.enum(["sync_job", "publication", "monitoring", "delegation", "notification"]);
const taskCategorySchema = z.enum([
  "数据采集", "数据加工", "报告产出", "业务巡检", "跨会话委派", "平台运维", "一次性补跑", "已完成", "已废弃",
]);
const overlapPolicySchema = z.enum(["skip_if_running", "queue", "kill_previous", "allow_concurrent"]);

const shellConfigSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1),
  timeout: z.number().positive(),
});

const httpConfigSchema = z.object({
  url: z.string().min(1),
  method: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeout: z.number().positive(),
});

const createTaskSchema = z.object({
  name: z.string().min(1).max(40),
  description: z.string().max(200).optional(),
  cron: z.string().min(9).refine((v) => validateCron(v), "Invalid cron expression"),
  executor: z.enum(["shell", "http"]),
  config: z.record(z.string(), z.unknown()),
  oneshot: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  createdBy: z.string().max(40).optional(),
  class: taskClassSchema,
  category: taskCategorySchema,
  expectedDurationMs: z.number().int().positive().max(86400000),
  overlapPolicy: overlapPolicySchema.optional(),
  ownerSession: z.string().min(1),
  overrides: z.record(z.string(), z.unknown()).optional(),
}).superRefine((data, ctx) => {
  const schema = data.executor === "shell" ? shellConfigSchema : httpConfigSchema;
  if (!schema.safeParse(data.config).success) {
    ctx.addIssue({
      code: "custom",
      message: "Invalid config for executor type",
      path: ["config"],
    });
  }
});

const updateTaskSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  description: z.string().max(200).optional(),
  cron: z.string().min(9).refine((v) => validateCron(v), "Invalid cron expression").optional(),
  executor: z.enum(["shell", "http"]).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  oneshot: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  createdBy: z.string().max(40).optional(),
  class: taskClassSchema.optional(),
  category: taskCategorySchema.optional(),
  expectedDurationMs: z.number().int().positive().max(86400000).optional(),
  overlapPolicy: overlapPolicySchema.optional(),
  ownerSession: z.string().min(1).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
}).refine((d) => Object.keys(d).length > 0, "At least one field required");

function parseLimit(raw: string | undefined): number | null {
  const n = Number(raw ?? 20);
  if (!Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

type RunTaskFn = (taskId: string) => void;

export type TaskSyncHook = {
  syncTask(task: import("../db/taskStore.js").Task): void;
  deleteTask(taskId: string): void;
};

export type ConflictCheckHook = {
  check(task: import("../db/taskStore.js").Task): void;
};

export function createApp(
  store: TaskStore,
  engine: CronEngine,
  runTask?: RunTaskFn,
  sync?: TaskSyncHook,
  conflictCheck?: ConflictCheckHook,
  healStore?: HealStore,
  migrationStore?: MigrationStore,
  knownSessionsLoader: () => Set<string> = () => new Set(),
  creationReviewStore?: CreationReviewStore,
  ownerNoticeSender?: OwnerNoticeSender,
): Hono {
  const app = new Hono();

  app.post("/tasks", async (c) => {
    const parsed = createTaskSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      const missingClassed = parsed.error.issues.some((i) =>
        i.path[0] === "class" || i.path[0] === "expectedDurationMs" || i.path[0] === "ownerSession" || i.path[0] === "category",
      );
      const body: Record<string, unknown> = {
        error: parsed.error.message,
        errors: zodIssuesToErrors(parsed.error),
      };
      if (missingClassed) {
        body.hint = "POST /tasks requires `class` + `category` + `expectedDurationMs` + `ownerSession`. category enum: 数据采集 / 数据加工 / 报告产出 / 业务巡检 / 跨会话委派 / 平台运维 / 一次性补跑 / 已完成 / 已废弃. See docs/migrating-from-legacy.md.";
      }
      return c.json(body, 400);
    }

    try {
      const input = parsed.data;
      if (input.class) {
        const overrides = input.overrides as Partial<DimensionValues> | undefined;
        resolveOverrides(input.class, overrides);
        const constraint = checkHardConstraints(input.class, overrides);
        if (!constraint.ok) {
          return c.json({
            error: constraint.reason,
            errors: [{
              code: "hard_constraint_violation",
              field: "overrides",
              message: constraint.reason,
              hint: "See src/classes/hardConstraints.ts for the class-specific constraints (e.g. delegation requires session_reply_* receiptProof).",
            }],
          }, 400);
        }
        input.overlapPolicy ??= "skip_if_running";
      }
      // After hardConstraints, before createTask: run mechanical lint.
      const lintInput: LintInput = {
        name: input.name,
        description: input.description,
        cron: input.cron,
        executor: input.executor,
        config: input.config,
        class: input.class,
        category: input.category,
        expectedDurationMs: input.expectedDurationMs,
        ownerSession: input.ownerSession,
        overrides: input.overrides as Partial<DimensionValues> | null | undefined,
      };
      const lintResult = lintTaskInput(lintInput, knownSessionsLoader());
      if (!lintResult.ok) {
        return c.json({
          error: "task input failed lint",
          errors: lintResult.errors,
        }, 400);
      }
      const task = store.createTask(input);
      if (task.enabled && runTask) {
        engine.register(task.id, task.cron, () => runTask(task.id));
      }
      sync?.syncTask(task);
      conflictCheck?.check(task);
      if (creationReviewStore && task.class) {
        try {
          creationReviewStore.create({
            taskId: task.id,
            trigger: "post_create",
            taskSnapshot: { ...task, config: typeof task.config === 'string' ? JSON.parse(task.config) : task.config },
          });
        } catch (err) {
          // Don't fail the POST if review insertion fails (best-effort).
          console.error('creation_review insert failed', err);
        }
      }
      return c.json(task, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.get("/tasks", (c) => {
    const createdBy = c.req.query("createdBy");
    const enabled = c.req.query("enabled");
    let tasks = store.listTasks();
    if (createdBy) tasks = tasks.filter((t) => t.createdBy === createdBy);
    if (enabled !== undefined) tasks = tasks.filter((t) => t.enabled === (enabled === "true"));
    return c.json(tasks);
  });

  app.get("/tasks/:id", (c) => {
    const task = store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  app.patch("/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.getTask(id);
    if (!existing) return c.json({ error: "Task not found" }, 404);

    const parsed = updateTaskSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        error: parsed.error.message,
        errors: zodIssuesToErrors(parsed.error),
      }, 400);
    }

    if (parsed.data.executor !== undefined || parsed.data.config !== undefined) {
      const effectiveExecutor = parsed.data.executor ?? existing.executor;
      const effectiveConfig = parsed.data.config ?? existing.config;
      const cfgSchema = effectiveExecutor === "shell" ? shellConfigSchema : httpConfigSchema;
      const cfgParsed = cfgSchema.safeParse(effectiveConfig);
      if (!cfgParsed.success) {
        return c.json({
          error: `Invalid config for executor '${effectiveExecutor}': ${cfgParsed.error.message}`,
          errors: zodIssuesToErrors(cfgParsed.error),
        }, 400);
      }
    }

    // Build merged effective task for hardConstraints + lint.
    const mergedClass = (parsed.data.class ?? existing.class) as LintInput["class"] | null | undefined;

    // Only run new checks when merged result is classed (legacy non-classed PATCH stays open).
    if (mergedClass) {
      const mergedOverrides = (parsed.data.overrides ?? existing.overrides) as
        | Partial<DimensionValues> | null | undefined;

      // (a) hardConstraints — same call as POST, wrapped in unified error format.
      const constraint = checkHardConstraints(mergedClass, mergedOverrides);
      if (!constraint.ok) {
        return c.json({
          error: constraint.reason,
          errors: [{
            code: "hard_constraint_violation",
            field: "overrides",
            message: constraint.reason,
            hint: "See src/classes/hardConstraints.ts for class-specific constraints.",
          }],
        }, 400);
      }

      // (b) Pre-check: classed task must have expectedDurationMs set (runtime
      // dereferences it as `task.expectedDurationMs!`). Reject if merged is null,
      // surface pre-existing data corruption rather than passing it.
      const mergedEDM = parsed.data.expectedDurationMs ?? existing.expectedDurationMs;
      if (mergedEDM === null || mergedEDM === undefined) {
        return c.json({
          error: "classed task missing expectedDurationMs",
          errors: [{
            code: "classed_task_missing_expected_duration",
            field: "expectedDurationMs",
            message: "Classed task requires expectedDurationMs; merged result is null. Runtime would crash at `triggeredAt + null`.",
            hint: "PATCH expectedDurationMs explicitly (e.g. 60000).",
          }],
        }, 400);
      }

      // (c) creationLint on merged.
      const merged: LintInput = {
        name: parsed.data.name ?? existing.name,
        description: parsed.data.description ?? existing.description,
        cron: parsed.data.cron ?? existing.cron,
        executor: parsed.data.executor ?? existing.executor,
        config: (parsed.data.config ?? existing.config) as Record<string, unknown>,
        class: mergedClass,
        category: (parsed.data.category ?? existing.category) as string,
        expectedDurationMs: mergedEDM,
        ownerSession: parsed.data.ownerSession ?? existing.ownerSession ?? "",
        overrides: mergedOverrides,
      };
      const lintResult = lintTaskInput(merged, knownSessionsLoader());
      if (!lintResult.ok) {
        return c.json({
          error: "patched task fails lint",
          errors: lintResult.errors,
        }, 400);
      }
    }

    const updated = store.updateTask(id, parsed.data);

    if (runTask) {
      if (updated.enabled) {
        engine.register(id, updated.cron, () => runTask(id));
      } else {
        try { engine.unregister(id); } catch {}
      }
    }

    sync?.syncTask(updated);
    if (parsed.data.cron !== undefined || parsed.data.enabled !== undefined) {
      conflictCheck?.check(updated);
    }
    if (creationReviewStore && updated.class) {
      try {
        creationReviewStore.create({
          taskId: updated.id,
          trigger: "post_patch",
          taskSnapshot: { ...updated, config: typeof updated.config === 'string' ? JSON.parse(updated.config) : updated.config },
        });
      } catch (err) {
        console.error('creation_review insert failed', err);
      }
    }
    return c.json(updated);
  });

  app.delete("/tasks/:id", (c) => {
    const id = c.req.param("id");
    const existing = store.getTask(id);
    if (!existing) return c.json({ error: "Task not found" }, 404);

    try { engine.unregister(id); } catch {}
    store.deleteTask(id);
    sync?.deleteTask(id);
    return c.body(null, 204);
  });

  app.post("/tasks/:id/run", (c) => {
    const id = c.req.param("id");
    const task = store.getTask(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    if (runTask) {
      runTask(id);
    }

    return c.json({ message: "triggered" }, 202);
  });

  app.get("/tasks/:id/runs", (c) => {
    const id = c.req.param("id");
    const task = store.getTask(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be an integer between 1 and 100" }, 400);
    return c.json(store.listRuns(id, limit));
  });

  app.get("/runs/recent", (c) => {
    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) return c.json({ error: "limit must be an integer between 1 and 100" }, 400);
    return c.json(store.listRecentRuns(limit));
  });

  app.get("/proposals/heal", (c) => {
    if (!healStore) return c.json({ error: "heal store not wired (db not provided to scheduler)" }, 503);
    const status = c.req.query("status");
    const VALID = ["pending", "replied", "default_applied", "pending_retry"] as const;
    if (status && !(VALID as readonly string[]).includes(status)) {
      return c.json({ error: `invalid status. allowed: ${VALID.join(",")}` }, 400);
    }
    const rows = healStore.listAll(status as typeof VALID[number] | undefined);
    return c.json(rows);
  });

  app.get("/proposals/migration", (c) => {
    if (!migrationStore) return c.json({ error: "migration store not wired (db not provided to scheduler)" }, 503);
    const status = c.req.query("status");
    const VALID = ["pending", "replied", "default_applied"] as const;
    if (status && !(VALID as readonly string[]).includes(status)) {
      return c.json({ error: `invalid status. allowed: ${VALID.join(",")}` }, 400);
    }
    const rows = migrationStore.listAll(status as typeof VALID[number] | undefined);
    return c.json(rows);
  });

  const CREATION_REVIEW_STATUSES = [
    "pending", "dispatched", "approved", "patched", "rejected", "escalated", "expired",
  ] as const;

  app.get("/proposals/creation", (c) => {
    if (!creationReviewStore) {
      return c.json({ error: "creation review store not wired (db not provided to scheduler)" }, 503);
    }
    const status = c.req.query("status");
    if (status && !(CREATION_REVIEW_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: `invalid status. allowed: ${CREATION_REVIEW_STATUSES.join(",")}` }, 400);
    }
    const rows = creationReviewStore.listAll(status as typeof CREATION_REVIEW_STATUSES[number] | undefined);
    return c.json(rows);
  });

  app.post("/proposals/creation/:id/approve", async (c) => {
    if (!creationReviewStore) return c.json({ error: "creation review store not wired" }, 503);
    const id = c.req.param("id");
    const review = creationReviewStore.get(id);
    if (!review) return c.json({ error: "review not found" }, 404);
    if (review.status !== "pending" && review.status !== "dispatched" && review.status !== "escalated") {
      return c.json({ error: `review already decided (status=${review.status})` }, 400);
    }
    const body = await c.req.json().catch(() => null) as { reason?: unknown } | null;
    const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason is required (non-empty string)" }, 400);
    creationReviewStore.decide(id, { status: "approved", reason });
    return c.json(creationReviewStore.get(id));
  });

  app.post("/proposals/creation/:id/patch", async (c) => {
    if (!creationReviewStore) return c.json({ error: "creation review store not wired" }, 503);
    const id = c.req.param("id");
    const review = creationReviewStore.get(id);
    if (!review) return c.json({ error: "review not found" }, 404);
    if (review.status !== "pending" && review.status !== "dispatched" && review.status !== "escalated") {
      return c.json({ error: `review already decided (status=${review.status})` }, 400);
    }
    const body = await c.req.json().catch(() => null) as { reason?: unknown; patch?: unknown } | null;
    const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason is required (non-empty string)" }, 400);
    const patch = body?.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return c.json({ error: "patch is required (object)" }, 400);
    }

    // Apply the patch via the internal PATCH /tasks/:id route first.
    const innerRes = await app.request(`/tasks/${review.taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (innerRes.status >= 400) {
      const innerBody = await innerRes.json().catch(() => ({ error: "inner PATCH failed" }));
      // Don't mark review as patched if PATCH failed.
      return c.json(innerBody, innerRes.status as 400 | 404);
    }

    creationReviewStore.decide(id, {
      status: "patched",
      reason,
      patch: patch as Record<string, unknown>,
    });
    return c.json(creationReviewStore.get(id));
  });

  app.post("/proposals/creation/:id/reject", async (c) => {
    if (!creationReviewStore) return c.json({ error: "creation review store not wired" }, 503);
    const id = c.req.param("id");
    const review = creationReviewStore.get(id);
    if (!review) return c.json({ error: "review not found" }, 404);
    if (review.status !== "pending" && review.status !== "dispatched" && review.status !== "escalated") {
      return c.json({ error: `review already decided (status=${review.status})` }, 400);
    }
    const body = await c.req.json().catch(() => null) as { reason?: unknown; disable?: unknown } | null;
    const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason is required (non-empty string)" }, 400);
    const disable = body?.disable !== false;  // default true

    creationReviewStore.decide(id, { status: "rejected", reason });

    if (disable) {
      const innerRes = await app.request(`/tasks/${review.taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      if (innerRes.status >= 400) {
        const innerBody = await innerRes.json().catch(() => ({ error: "inner PATCH failed" }));
        return c.json(innerBody, innerRes.status as 400 | 404);
      }

      // Best-effort ownerDM: task got disabled, owner needs to know why.
      if (ownerNoticeSender) {
        try {
          const task = store.getTask(review.taskId);
          const owner = task?.ownerSession;
          if (task && owner) {
            const prompt = `[scheduler creation_review rejected]

你的任务创建被 scheduler session 拒绝且已自动 disable：

task: ${task.name} (id=${task.id})
review: ${review.id}
reason: ${reason}

如果不同意，可以重新启用：
  PATCH http://localhost:3500/tasks/${task.id}  body: { "enabled": true }
或者修复后重新 POST。`;
            const r = await ownerNoticeSender(owner, prompt);
            if (!r.ok) console.error("creation_review reject ownerDM failed", { owner, error: r.error });
          }
        } catch (err) {
          console.error("creation_review reject ownerDM threw", err);
        }
      }
    }
    return c.json(creationReviewStore.get(id));
  });

  app.post("/proposals/creation/:id/escalate", async (c) => {
    if (!creationReviewStore) return c.json({ error: "creation review store not wired" }, 503);
    const id = c.req.param("id");
    const review = creationReviewStore.get(id);
    if (!review) return c.json({ error: "review not found" }, 404);
    if (review.status !== "pending" && review.status !== "dispatched") {
      return c.json({ error: `review already decided (status=${review.status})` }, 400);
    }
    const body = await c.req.json().catch(() => null) as { reason?: unknown } | null;
    const reason = body && typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason is required (non-empty string)" }, 400);
    creationReviewStore.decide(id, { status: "escalated", reason });

    // Best-effort ownerDM: escalate doesn't disable the task; owner needs to judge.
    if (ownerNoticeSender) {
      try {
        const task = store.getTask(review.taskId);
        const owner = task?.ownerSession;
        if (task && owner) {
          const prompt = `[scheduler creation_review escalated]

你的任务创建被 scheduler session 升级人工审核：

task: ${task.name} (id=${task.id})
review: ${review.id}
reason: ${reason}

任务仍在运行（escalate 不会 disable）。需要你判断该 approve / patch / reject。

GET http://localhost:3500/proposals/creation/${review.id}
POST /proposals/creation/${review.id}/{approve,patch,reject}`;
          const r = await ownerNoticeSender(owner, prompt);
          if (!r.ok) console.error("creation_review escalate ownerDM failed", { owner, error: r.error });
        }
      } catch (err) {
        console.error("creation_review escalate ownerDM threw", err);
      }
    }
    return c.json(creationReviewStore.get(id));
  });

  app.get("/health", (c) => {
    const jobs = engine.list();
    return c.json({
      status: "ok",
      tasks: jobs.length,
      uptime: process.uptime(),
    });
  });

  return app;
}
