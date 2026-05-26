import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import pino from "pino";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { applyMigrations } from "./db/schema.js";
import { createTaskStore, type Task, type TaskRun, type TaskStore } from "./db/taskStore.js";
import { createCronEngine } from "./cron/engine.js";
import { executeShell } from "./executors/shell.js";
import { executeHttp } from "./executors/http.js";
import type { ShellConfig, HttpConfig } from "./executors/types.js";
import { resolveOverrides } from "./classes/resolveOverrides.js";
import type { DimensionValues } from "./classes/types.js";
import { createKnownSessionsLoader } from "./classes/knownSessions.js";
import { createExitTracker, type ExitTracker } from "./lifecycle/exitTracker.js";
import { createLookupExitContext } from "./lifecycle/exitContext.js";
import { triggerHttp, triggerShell } from "./lifecycle/trigger.js";
import { shouldSkipForOverlap } from "./overlap/policy.js";
import { createApp } from "./api/routes.js";
import type { TaskSyncHook, ConflictCheckHook } from "./api/routes.js";
import { createConsoleNotifier, type ConsoleNotifier, type NotifyParams } from "./notify/console.js";
import { resolveFailure } from "./notify/failureResolve.js";
import { executeWithRetry } from "./notify/executeWithRetry.js";
import { createBitableSync } from "./sync/bitable.js";
import { createBitableDeleteRetryStore, drainBitableDeleteQueue } from "./sync/deleteRetryStore.js";
import { analyzeConflicts } from "./analysis/conflicts.js";
import { resolveConflicts } from "./analysis/resolve.js";
import { loadTasksIntoEngine, recoverOrphanRuns, isPidAliveDefault } from "./boot.js";
import { createVerifyStore, type VerifyStore } from "./verify/store.js";
import { startVerifyScheduler } from "./verify/scheduler.js";
import { createNotifyRouter } from "./notify/v2/router.js";
import { inboxPredicate, DECISION_TOKENS, DELIVERY_TOKENS } from "./spawn/predicate.js";
import { createOwnerDM } from "./notify/v2/channels/ownerDM.js";
import { createUserDM, type RunCliFn } from "./notify/v2/channels/userDM.js";
import { createCustomChat } from "./notify/v2/channels/customChat.js";
import { createHealStore } from "./heal/store.js";
import { createHealRunner, parseSpawnResponse, type SpawnResult } from "./heal/runner.js";
import { runHealTick } from "./heal/scheduler.js";
import { maybeEscalateSkips, createHealEscalationStore } from "./heal/escalation.js";
import { createRateLimitStore } from "./heal/rateLimitStore.js";
import { createMigrationStore } from "./migration/store.js";
import { runMigrationTick } from "./migration/scheduler.js";
import {
  createDisabledWarningStore,
  runDisabledWarningTick,
} from "./notify/disabledWarning.js";
import { createCreationReviewStore } from "./review/creationReviewStore.js";
import { runCreationReviewTick } from "./review/scheduler.js";
import { runDecisionPollTick } from "./review/decisionPoll.js";
import { buildProposalText } from "./review/proposalText.js";
import { createOwnerNoticeSender } from "./review/ownerNotice.js";

const execFileAsync = promisify(execFile);

export function routeTaskExecution(task: Task): "legacy" | "new" {
  return task.class ? "new" : "legacy";
}

export async function runTaskNew(
  task: Task,
  deps: {
    taskStore: TaskStore;
    verifyStore: VerifyStore;
    exitTracker?: ExitTracker;
  }
): Promise<void> {
  const skipForOverlap = shouldSkipForOverlap(deps.taskStore, task);
  const run = deps.taskStore.createRun(task.id);
  if (skipForOverlap) {
    const now = Date.now();
    deps.taskStore.updateRunTrigger(run.id, { triggerStatus: "skipped_overlap", triggeredAt: now });
    deps.taskStore.updateRunFinal(run.id, "skipped_overlap", now);
    return;
  }

  const triggeredAt = Date.now();
  const effective: DimensionValues = resolveOverrides(
    task.class!,
    task.overrides as Partial<DimensionValues> | null
  );

  if (effective.kind === "script") {
    const shellCfg = task.config as { command: string; cwd: string; timeout: number };
    const triggerResult = await triggerShell(shellCfg);
    if (!triggerResult.triggerOk) {
      deps.taskStore.updateRunTrigger(run.id, { triggerStatus: "failed", triggeredAt });
      deps.taskStore.updateRunFinal(run.id, "trigger_failed", Date.now(), triggerResult.error);
      deps.taskStore.refreshNextRun(task.id);
      return;
    }
    deps.taskStore.updateRunTrigger(run.id, {
      triggerStatus: "ok",
      triggeredAt,
      runningPid: triggerResult.pid,
    });
    if (triggerResult.exitPromise) {
      deps.exitTracker?.register(run.id, triggerResult.exitPromise);
    }
    void triggerResult.exitPromise?.then((exitInfo) => {
      deps.taskStore.updateRunVerify(run.id, {
        processExitedAt: exitInfo.exitedAt,
        exitCode: exitInfo.exitCode,
      });
    }).catch((err) => {
      console.error(`exit tracking failed for run ${run.id}:`, err);
    });
  } else {
    const httpCfg = task.config as {
      url: string;
      method: string;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
      timeout: number;
    };
    const triggerResult = await triggerHttp({
      url: httpCfg.url,
      method: httpCfg.method,
      headers: httpCfg.headers ?? {},
      body: httpCfg.body ?? {},
      timeout: httpCfg.timeout,
    });
    if (!triggerResult.triggerOk) {
      deps.taskStore.updateRunTrigger(run.id, { triggerStatus: "failed", triggeredAt });
      deps.taskStore.updateRunFinal(run.id, "trigger_failed", Date.now(), triggerResult.error);
      deps.taskStore.refreshNextRun(task.id);
      return;
    }
    deps.taskStore.updateRunTrigger(run.id, {
      triggerStatus: "ok",
      triggeredAt,
      childSessionId: triggerResult.childSessionId,
      childMessageRunId: triggerResult.childMessageRunId,
      asyncRef: triggerResult.asyncRef,
    });
    if (triggerResult.asyncRef) {
      console.warn(
        `[scheduler] run ${run.id} (task ${task.id}) spawn switched to async fallback; ref=${triggerResult.asyncRef}`,
      );
    }
  }

  deps.verifyStore.scheduleVerification(run.id, triggeredAt + task.expectedDurationMs!);
}

export function wireUpVerifyScheduler(opts: {
  taskStore: TaskStore;
  verifyStore: VerifyStore;
  db?: Database.Database;
  lookupExitContext?: (runId: string) => {
    exitCode?: number | null;
    httpStatus?: number;
    sessionReply?: unknown;
    childSessionId?: string | null;
    asyncRef?: string | null;
    smBaseUrl?: string;
    fetchImpl?: typeof fetch;
  };
  tickIntervalMs?: number;
  healTickIntervalMs?: number;
  migrationTickIntervalMs?: number;
  disabledWarningTickIntervalMs?: number;
  spawnApiUrl?: string;
  smBaseUrl?: string;
  larkCliPath?: string;
  userOpenId?: string;
  retryTaskFn?: (taskId: string) => Promise<void>;
  syncTask?: (task: Task, latestRun?: TaskRun) => Promise<void>;
  unregisterCron?: (taskId: string) => void;
  notifier?: ConsoleNotifier;
  notifyApiUrl?: string;
}): () => void {
  const runCli: RunCliFn = async (cmd, args) => {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 1024 * 1024 });
    return { stdout, stderr };
  };
  const router = createNotifyRouter({
    ownerDM: createOwnerDM({ spawnApiUrl: opts.spawnApiUrl ?? "http://localhost:3501/api/spawn" }),
    userDM: createUserDM({
      larkCliPath: opts.larkCliPath ?? "lark-cli",
      userOpenId: opts.userOpenId ?? "LARK_OWNER_OPEN_ID",
      runCli,
    }),
    customChat: createCustomChat({
      larkCliPath: opts.larkCliPath ?? "lark-cli",
      runCli,
    }),
  });

  const spawnApiUrl = opts.spawnApiUrl ?? "http://localhost:3501/api/spawn";
  const smBaseUrl = opts.smBaseUrl ?? "http://localhost:3501";
  const healStore = opts.db ? createHealStore(opts.db) : null;
  const escalationStore = opts.db ? createHealEscalationStore(opts.db) : null;
  const rateLimitStore = opts.db ? createRateLimitStore(opts.db) : null;

  const spawnFn = async (params: {
    target: string;
    from: string;
    prompt: string;
    verification_predicate: Record<string, unknown>;
  }): Promise<SpawnResult> => {
    const res = await fetch(spawnApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    let body: unknown = null;
    if (res.ok) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return parseSpawnResponse(res.status, body);
  };

  const sendUserDm = async (text: string) => {
    await runCli(opts.larkCliPath ?? "lark-cli", [
      "im",
      "+messages-send",
      "--user-id",
      opts.userOpenId ?? "LARK_OWNER_OPEN_ID",
      "--as",
      "bot",
      "--text",
      text,
    ]);
  };

  const notifier =
    opts.notifier ??
    createConsoleNotifier({ apiUrl: opts.notifyApiUrl ?? "http://localhost:3501/api/notify" });
  const notifyConsole = (params: NotifyParams) => notifier.notifyOrThrow(params);

  const retryTaskFn =
    opts.retryTaskFn ??
    (async (taskId: string) => {
      const task = opts.taskStore.getTask(taskId);
      if (!task) return;
      const exitTracker = createExitTracker();
      await runTaskNew(task, { taskStore: opts.taskStore, verifyStore: opts.verifyStore, exitTracker });
    });

  const healRunner = healStore
    ? createHealRunner({
        taskStore: opts.taskStore,
        healStore,
        spawnFn,
        notifyConsole,
        sendUserDm,
        retryTaskFn,
        rateLimitStore: rateLimitStore ?? undefined,
      })
    : null;

  const stopVerify = startVerifyScheduler({
    taskStore: opts.taskStore,
    verifyStore: opts.verifyStore,
    lookupExitContext: opts.lookupExitContext ?? (() => ({ smBaseUrl })),
    tickIntervalMs: opts.tickIntervalMs ?? 1000,
    notify: (rule, ctx) => router.route(rule, ctx),
    heal: healRunner
      ? async (args) => {
          await healRunner.runHeal(args);
          if (healStore && escalationStore) {
            await maybeEscalateSkips({
              healStore,
              taskStore: opts.taskStore,
              escalationStore,
              taskId: args.taskId,
              sendUserDm,
            });
          }
        }
      : undefined,
    syncTask: opts.syncTask,
    unregisterCron: opts.unregisterCron,
  });

  let healTimer: ReturnType<typeof setInterval> | null = null;
  if (healStore) {
    const healIntervalMs = opts.healTickIntervalMs ?? 60_000;
    healTimer = setInterval(() => {
      runHealTick({
        healStore,
        taskStore: opts.taskStore,
        smBaseUrl,
        retryTaskFn,
        notifyConsole,
        sendUserDm,
        spawnFn,
        rateLimitStore: rateLimitStore ?? undefined,
      }).catch((err) => console.error("heal tick error:", err));
    }, healIntervalMs);
  }

  let migrationTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.db) {
    const migrationStore = createMigrationStore(opts.db);
    const migrationIntervalMs = opts.migrationTickIntervalMs ?? 60 * 60_000; // 1h default
    migrationTimer = setInterval(() => {
      runMigrationTick({
        taskStore: opts.taskStore,
        migrationStore,
        smBaseUrl,
        spawnFn,
        sendUserDm,
        syncTask: opts.syncTask,
      }).catch((err) => console.error("migration tick error:", err));
    }, migrationIntervalMs);
  }

  let disabledWarningTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.db) {
    const warningStore = createDisabledWarningStore(opts.db);
    const intervalMs = opts.disabledWarningTickIntervalMs ?? 60 * 60_000; // 1h default
    disabledWarningTimer = setInterval(() => {
      runDisabledWarningTick({
        taskStore: opts.taskStore,
        warningStore,
        sendUserDm,
      }).catch((err) => console.error("disabled-warning tick error:", err));
    }, intervalMs);
  }

  return () => {
    stopVerify();
    if (healTimer) clearInterval(healTimer);
    if (migrationTimer) clearInterval(migrationTimer);
    if (disabledWarningTimer) clearInterval(disabledWarningTimer);
  };
}

export function startSchedulerService(env: Record<string, string | undefined> = process.env): void {
  const config = loadConfig(env);
  const logger = pino({ level: config.logLevel });

  const db = new Database(config.dbPath);
  applyMigrations(db);
  logger.info({ dbPath: config.dbPath }, "database ready");

  const store = createTaskStore(db);
  const verifyStore = createVerifyStore(db);
  const exitTracker = createExitTracker();
  const engine = createCronEngine();
  const notifier = createConsoleNotifier({
    apiUrl: config.notifyApiUrl,
    logger,
  });
  let sync:
    | {
        syncTask(task: Task, latestRun?: TaskRun): void;
        deleteTask(id: string): void;
      }
    | undefined;

  async function executeByTask(task: Task) {
    if (task.executor === "shell") {
      return executeShell(task.config as unknown as ShellConfig);
    }
    return executeHttp(task.config as unknown as HttpConfig);
  }

  async function spawnCall(target: string, prompt: string): Promise<string> {
    if (!config.spawnApiUrl) {
      throw new Error("spawn API not configured");
    }
    const res = await fetch(config.spawnApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target, from: "scheduler", prompt,
        verification_predicate: inboxPredicate({
          sessionName: target,
          tokens: DECISION_TOKENS,
        }),
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = (await res.json()) as { ok: boolean; finalMessage?: string; error?: string };
    if (!data.ok) throw new Error(data.error ?? "spawn failed");
    return data.finalMessage ?? "";
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function runTaskLegacy(task: Task): Promise<void> {
    const run = store.createRun(task.id);
    logger.info({ taskId: task.id, taskName: task.name }, "task triggered");

    const execOnce = async () => {
      try {
        return await executeByTask(task);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    };

    const outcome = await executeWithRetry(
      { execute: execOnce, sleep, logger },
      { maxTransientRetries: config.transientRetryCount, transientDelayMs: config.transientRetryDelayMs },
    );
    const result = outcome.finalResult;

    const status = result.success ? "success" : "failed";
    store.completeRun(run.id, status, result.output, result.error);
    logger.info(
      { taskId: task.id, taskName: task.name, status, attempts: outcome.attempts, transientRetries: outcome.transientRetries, failureClass: outcome.lastClass },
      "task completed",
    );

    if (!result.success && task.notifyOnFailure) {
      if (outcome.lastClass === "transient_network") {
        const prefix = `[瞬时网络错误] 已自动重试 ${outcome.transientRetries} 次仍失败；不打扰任务创建者，建议运维/Watchdog 处理。\n\n`;
        await notifier.notifyFailure(task.name, `${prefix}${result.error ?? "unknown error"}`, {
          taskId: task.id,
          runId: run.id,
          failureClass: "transient_network",
          attempts: outcome.attempts,
        });
      } else if (task.createdBy && config.spawnApiUrl) {
        await resolveFailure(task, result, run.id, {
          spawnCall,
          executeByTask,
          notifier,
          store,
          logger,
        });
      } else {
        await notifier.notifyFailure(task.name, result.error ?? "unknown error", {
          taskId: task.id,
          runId: run.id,
        });
      }
    }

    if (result.success) {
      store.updateLastSuccess(task.id);
      if (task.oneshot) {
        store.updateTask(task.id, { enabled: false });
        try {
          engine.unregister(task.id);
        } catch {}
        logger.info({ taskId: task.id, taskName: task.name }, "oneshot task disabled after success");
      } else {
        store.refreshNextRun(task.id);
      }
    } else {
      store.refreshNextRun(task.id);
    }

    const latest = store.getTask(task.id);
    if (latest) sync?.syncTask(latest);
  }

  async function runTask(taskId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task || !task.enabled) return;
    if (routeTaskExecution(task) === "legacy") {
      await runTaskLegacy(task);
    } else {
      await runTaskNew(task, { taskStore: store, verifyStore, exitTracker });
    }
  }

  const inflight = new Set<Promise<void>>();

  function trackTask(taskId: string): void {
    const p = runTask(taskId)
      .catch((err) => logger.error({ err, taskId }, "runTask error"))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  if (config.bitableBaseToken && config.bitableTableId) {
    const bs = createBitableSync(
      { larkCliPath: config.larkCliPath, baseToken: config.bitableBaseToken, tableId: config.bitableTableId },
      logger,
    );
    // syncTask errors are swallowed (sync is a mirror, not a source of truth — a
    // later sync overwrites a missed one). deleteTask errors are NOT swallowed:
    // a dropped delete leaves an orphan bitable record forever, so we queue it
    // and retry on the next scheduler boot.
    const deleteRetryStore = createBitableDeleteRetryStore(db);
    sync = {
      syncTask: (task, latestRun) => { bs.syncTask(task, latestRun).catch(() => {}); },
      deleteTask: (taskId) => {
        bs.deleteTask(taskId).catch((err) => {
          deleteRetryStore.enqueue(taskId, err);
          logger.error({ err, taskId }, "bitable delete failed; queued for retry");
        });
      },
    };
    void drainBitableDeleteQueue(
      deleteRetryStore,
      (id) => bs.deleteTask(id),
      logger,
    ).catch((err) => logger.error({ err }, "bitable delete queue drain crashed"));
    logger.info("bitable sync enabled");
  }

  let conflictCheck: ConflictCheckHook | undefined;
  if (config.spawnApiUrl) {
    conflictCheck = {
      check(task) {
        const allTasks = store.listTasks();
        analyzeConflicts(task, allTasks, (prompt) => spawnCall("scheduler", prompt), logger)
          .then((result) => {
            if (!result.hasConflicts) {
              logger.info({ taskId: task.id }, "conflict check: no conflicts");
              return;
            }
            logger.warn({ taskId: task.id, conflicts: result.conflicts.length }, "conflict check: conflicts found");
            return resolveConflicts(task, result.conflicts, {
              store,
              spawnTo: spawnCall,
              notify: (text) => notifier.notify({
                title: "定时任务冲突未解决",
                body: text,
                level: "warn",
                metadata: { triggerTaskId: task.id, triggerTaskName: task.name },
              }),
              sync: sync ? (t) => sync!.syncTask(t) : undefined,
              reregister: (t) => {
                if (t.enabled) engine.register(t.id, t.cron, () => trackTask(t.id));
              },
              logger,
            });
          })
          .catch((err) => logger.error({ err, taskId: task.id }, "conflict check error"));
      },
    };
    logger.info("conflict analysis enabled");
  }

  const healStoreForApi = createHealStore(db);
  const migrationStoreForApi = createMigrationStore(db);

  const knownSessionsLoader = createKnownSessionsLoader(config.supermatrixDbPath);
  const creationReviewStore = createCreationReviewStore(db);
  const ownerNoticeSender = createOwnerNoticeSender({ spawnApiUrl: config.spawnApiUrl });
  const app = createApp(
    store, engine, trackTask, sync, conflictCheck,
    healStoreForApi, migrationStoreForApi,
    knownSessionsLoader, creationReviewStore, ownerNoticeSender,
  );

  recoverOrphanRuns(db, isPidAliveDefault, logger);

  const tasks = store.listTasks();
  loadTasksIntoEngine(tasks, engine, trackTask, logger);

  for (const task of tasks) {
    if (task.enabled && task.nextRunAt === null) {
      store.refreshNextRun(task.id);
    }
  }

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    logger.info({ host: config.host, port: config.port }, "scheduler service started");
  });

  const reviewTickHandle = setInterval(async () => {
    try {
      const spawnFn: import("./review/scheduler.js").SpawnFn = async (params) => {
        try {
          const res = await fetch(config.spawnApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          if (!res.ok) return { ok: false, error: `spawn HTTP ${res.status}` };
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };
      const result = await runCreationReviewTick({
        store: creationReviewStore,
        spawnFn,
        proposalTextBuilder: buildProposalText,
        batchThreshold: config.creationReviewBatchThreshold,
        maxAgeMs: config.creationReviewMaxAgeMs,
      });
      if (result.dispatched > 0) {
        logger.info({ dispatched: result.dispatched, reviewIds: result.reviewIds }, "creation_review batch dispatched");
      }
    } catch (err) {
      logger.error({ err }, "creation_review tick failed");
    }
  }, config.creationReviewTickIntervalMs);

  const decisionPollHandle = setInterval(async () => {
    try {
      const result = await runDecisionPollTick({
        store: creationReviewStore,
        staleAfterMs: config.creationReviewExpireMs,
        notifyOwnerFn: async (expired) => {
          // Group expired reviews by owner so each owner gets one consolidated DM.
          const byOwner = new Map<string, typeof expired>();
          for (const r of expired) {
            const owner = (r.taskSnapshot.ownerSession as string | undefined) || "unknown";
            if (!byOwner.has(owner)) byOwner.set(owner, []);
            byOwner.get(owner)!.push(r);
          }
          for (const [owner, list] of byOwner) {
            if (owner === "unknown") continue;  // can't DM unknown
            const taskLines = list
              .map((r) => {
                const name = (r.taskSnapshot.name as string | undefined) ?? "(unnamed)";
                return `- ${name} (task=${r.taskId.slice(0, 8)}, review=${r.id.slice(0, 8)})`;
              })
              .join("\n");
            const prompt = `[scheduler creation_review expired]

你 owner 的 ${list.length} 条 task creation review 超过 24h 未决议，已自动 expired。任务仍在运行，但 L2 语义审核没完成 — 可能需要你手动看一下。

涉及任务：
${taskLines}

查 review（含 L1 报告 / 建议的 patch 内容）：GET http://localhost:3500/proposals/creation?status=expired

expired 是终态，无法补审 —— approve/patch/reject/escalate 只接受 pending/dispatched。
如对某条 review 有疑虑，直接查任务现状并按需处理：
  GET   http://localhost:3500/tasks/:id   看当前定义
  PATCH http://localhost:3500/tasks/:id   改定义（如 { "enabled": false } 停用）`;
            const r = await ownerNoticeSender(owner, prompt);
            if (!r.ok) {
              logger.warn({ owner, error: r.error }, "creation_review expire ownerDM failed");
            }
          }
        },
      });
      if (result.expired > 0) {
        logger.warn({ expired: result.expired, expiredReviewIds: result.expiredReviewIds }, "creation_review batch expired without decision");
      }
    } catch (err) {
      logger.error({ err }, "creation_review decision poll failed");
    }
  }, config.creationReviewDecisionPollIntervalMs);

  const stopVerifyScheduler = wireUpVerifyScheduler({
    taskStore: store,
    verifyStore,
    db,
    tickIntervalMs: 1000,
    spawnApiUrl: config.spawnApiUrl,
    smBaseUrl: config.spawnApiUrl.replace(/\/api\/spawn$/, ""),
    notifyApiUrl: config.notifyApiUrl,
    notifier,
    larkCliPath: config.larkCliPath,
    userOpenId: config.userDmOpenId,
    lookupExitContext: createLookupExitContext({
      exitTracker,
      store,
      smBaseUrl: config.spawnApiUrl.replace(/\/api\/spawn$/, ""),
    }),
    syncTask: sync
      ? async (task, latestRun) => { sync!.syncTask(task, latestRun); }
      : undefined,
    unregisterCron: (taskId) => engine.unregister(taskId),
  });

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("shutting down...");
    stopVerifyScheduler();
    clearInterval(reviewTickHandle);
    clearInterval(decisionPollHandle);
    engine.stopAll();
    server.close();

    if (inflight.size > 0) {
      logger.info({ count: inflight.size }, "waiting for in-flight tasks");
      const timer = setTimeout(() => {
        logger.warn("shutdown timeout reached, forcing exit");
        db.close();
        process.exit(1);
      }, 30_000);
      timer.unref();
      await Promise.allSettled([...inflight]);
      clearTimeout(timer);
    }

    db.close();
    logger.info("shutdown complete");
    process.exit(0);
  }

  process.on("SIGINT", () => { shutdown(); });
  process.on("SIGTERM", () => { shutdown(); });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint ? import.meta.url === pathToFileURL(entrypoint).href : false;
}

if (isMainModule()) {
  startSchedulerService();
}
