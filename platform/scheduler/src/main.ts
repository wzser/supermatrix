import Database from "better-sqlite3";
import { serve } from "@hono/node-server";
import pino from "pino";
import { applyMigrations } from "./db/schema.js";
import { createTaskStore } from "./db/taskStore.js";
import { createCronEngine } from "./cron/engine.js";
import { triggerShell, triggerHttp } from "./executors/trigger.js";
import { runTask } from "./dispatch.js";
import { createAlertSender } from "./notify/alert.js";
import { buildApp } from "./api/routes.js";
import { loadConfig, assertAdminToken, type Config } from "./config.js";
import { createSessionCategoryLookupFromPath } from "./sessionCategory.js";
import { findBootExpiredCandidates, recoverMissedTasks } from "./recovery.js";
import type { Task } from "./types.js";

const log = pino({ name: "scheduler-v2" });

export function bootScheduler(db: Database.Database, config: Config) {
  applyMigrations(db);
  const store = createTaskStore(db);
  const engine = createCronEngine();
  const sendAlert = createAlertSender({ smApiUrl: config.smBaseUrl });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const dispatchOne = (task: Task, scheduledAt?: number) =>
    runTask(task, {
      store,
      trigger: { shell: triggerShell, http: triggerHttp },
      sendAlert,
      onOneshotDone: (id) => {
        try {
          engine.unregister(id);
        } catch {
          // already unregistered
        }
      },
      sleep,
    }, scheduledAt === undefined ? {} : { scheduledAt });

  const tasks = store.listTasks();
  for (const task of tasks) {
    if (task.enabled) engine.register(task.id, task.cron, (scheduledAt) => { void dispatchOne(task, scheduledAt); });
  }

  const bootAt = Date.now();
  for (const candidate of findBootExpiredCandidates(tasks, bootAt, store.hasDeliveryForScheduledAt)) {
    if (store.recordExpiredMissedSlot(candidate.task.id, candidate.scheduledAt, bootAt)) {
      log.warn(
        { taskId: candidate.task.id, scheduledAt: candidate.scheduledAt, observedAt: bootAt },
        "recorded expired missed scheduler slot without dispatch or business replay",
      );
    }
  }

  void recoverMissedTasks(tasks, bootAt, store.hasDeliveryForScheduledAt, async (candidate) => {
    log.warn({ taskId: candidate.task.id, scheduledAt: candidate.scheduledAt }, "recovering missed opted-in scheduler tick");
    await dispatchOne(candidate.task, candidate.scheduledAt);
  }).catch((err) => log.error({ err }, "boot-time missed-tick recovery failed"));

  const sessionCategory = createSessionCategoryLookupFromPath(config.smDbPath);
  const app = buildApp({
    store,
    engine,
    runTask: dispatchOne,
    adminToken: config.adminToken,
    host: config.host,
    sessionCategory,
  });
  return { app, engine, store };
}

if (process.env.VITEST !== "true") {
  const config = loadConfig();
  try {
    assertAdminToken(config);
  } catch (err) {
    log.fatal({ err }, "refusing to start: SCHEDULER_ADMIN_TOKEN missing");
    process.exit(1);
  }
  const db = new Database(config.dbPath);
  const { app } = bootScheduler(db, config);
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) =>
    log.info({ host: config.host, port: info.port }, "scheduler-v2 listening"));
}
