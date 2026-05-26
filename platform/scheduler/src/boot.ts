import type Database from "better-sqlite3";
import type { Task } from "./db/taskStore.js";
import type { CronEngine } from "./cron/engine.js";

type BootLogger = {
  warn: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
};

export type OrphanRecoveryResult = {
  recovered: number;
  alive: number;
  skippedNoPid: number;
  skippedClassed: number;
};

export function isPidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function recoverOrphanRuns(
  db: Database.Database,
  isPidAlive: (pid: number) => boolean,
  logger: BootLogger,
  now: () => number = Date.now,
): OrphanRecoveryResult {
  const rows = db.prepare(`
    SELECT r.id, r.task_id, r.running_pid, r.started_at, r.process_exited_at, t.class as task_class
    FROM task_runs r LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.status = 'running'
  `).all() as Array<{ id: string; task_id: string; running_pid: number | null; started_at: number; process_exited_at: number | null; task_class: string | null }>;

  const orphans: Array<{ id: string; task_id: string; pid: number; startedAt: number; reason: string }> = [];
  let alive = 0;
  let skippedNoPid = 0;
  let skippedClassed = 0;
  for (const r of rows) {
    // Child already exited cleanly and the .then handler persisted the exit
    // before the scheduler bounced. The pid is dead by definition; the verify
    // tick will pick this up via the DB-fallback exitCode path. Marking it
    // orphan here corrupts a successful run.
    if (r.process_exited_at != null) {
      continue;
    }
    // class!=null tasks have the verify scheduler as the authoritative finalizer
    // (it polls task_verifications and writes final_status via receiptProof).
    // Boot recovery preempting that path produces success rows with stale
    // "orphan: ..." in the error column (COALESCE preserves it through
    // updateRunFinal). Skip and let verify do its job.
    if (r.task_class != null) {
      skippedClassed++;
      continue;
    }
    if (r.running_pid == null) {
      skippedNoPid++;
      continue;
    }
    let stillAlive = false;
    try {
      stillAlive = isPidAlive(r.running_pid);
    } catch {
      stillAlive = false;
    }
    if (stillAlive) {
      alive++;
      continue;
    }
    orphans.push({
      id: r.id,
      task_id: r.task_id,
      pid: r.running_pid,
      startedAt: r.started_at,
      reason: `orphan: scheduler restart, pid ${r.running_pid} dead`,
    });
  }

  const t = now();
  const updateStmt = db.prepare(
    "UPDATE task_runs SET status='failed', finished_at=?, error=? WHERE id=?"
  );
  for (const o of orphans) {
    updateStmt.run(t, o.reason, o.id);
    logger.warn(
      { runId: o.id, taskId: o.task_id, pid: o.pid, ageMs: t - o.startedAt },
      o.reason,
    );
  }

  if (orphans.length > 0 || alive > 0 || skippedNoPid > 0 || skippedClassed > 0) {
    logger.info(
      { recovered: orphans.length, alive, skippedNoPid, skippedClassed },
      "boot-time orphan recovery complete (class!=null rows skipped — verify scheduler will finalize them; pid=null legacy rows skipped — clean manually if stuck)",
    );
  }

  return { recovered: orphans.length, alive, skippedNoPid, skippedClassed };
}

function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function loadTasksIntoEngine(
  tasks: Task[],
  engine: CronEngine,
  onTask: (taskId: string) => void,
  logger: BootLogger,
): { loaded: number; failed: number } {
  let loaded = 0;
  let failed = 0;

  for (const task of tasks) {
    if (!task.enabled) continue;
    const timeout = (task.config as { timeout?: unknown } | null)?.timeout;
    if (!isValidTimeoutMs(timeout)) {
      failed++;
      logger.warn(
        { taskId: task.id, taskName: task.name, executor: task.executor, configTimeout: timeout },
        "skipped task during boot: config.timeout missing or invalid (must be a positive finite number of ms; setTimeout would clamp to 1ms and SIGTERM the child immediately)",
      );
      continue;
    }
    try {
      engine.register(task.id, task.cron, () => onTask(task.id));
      loaded++;
    } catch (err) {
      failed++;
      logger.warn(
        { taskId: task.id, taskName: task.name, cron: task.cron, error: err instanceof Error ? err.message : String(err) },
        "skipped bad task during boot",
      );
    }
  }

  logger.info({ loaded, failed }, "task loading complete");
  return { loaded, failed };
}
