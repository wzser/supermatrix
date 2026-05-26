import type Database from "better-sqlite3";

export type BitableDeleteRetryEntry = {
  taskId: string;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
};

export type BitableDeleteRetryStore = {
  enqueue(taskId: string, error: unknown): void;
  list(): BitableDeleteRetryEntry[];
  dequeue(taskId: string): void;
};

const MAX_ERROR_LEN = 1000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return "";
  try {
    return String(err);
  } catch {
    return "[unstringifiable]";
  }
}

export function createBitableDeleteRetryStore(db: Database.Database): BitableDeleteRetryStore {
  const upsert = db.prepare(`
    INSERT INTO bitable_delete_retries (task_id, queued_at, attempts, last_error)
    VALUES (@taskId, @queuedAt, 1, @lastError)
    ON CONFLICT(task_id) DO UPDATE SET
      queued_at  = excluded.queued_at,
      attempts   = bitable_delete_retries.attempts + 1,
      last_error = excluded.last_error
  `);
  const selectAll = db.prepare(`
    SELECT task_id    AS taskId,
           queued_at  AS queuedAt,
           attempts   AS attempts,
           last_error AS lastError
    FROM bitable_delete_retries
    ORDER BY queued_at ASC
  `);
  const del = db.prepare(`DELETE FROM bitable_delete_retries WHERE task_id = ?`);

  return {
    enqueue(taskId, err) {
      const msg = errorMessage(err).slice(0, MAX_ERROR_LEN);
      upsert.run({ taskId, queuedAt: Date.now(), lastError: msg });
    },
    list() {
      return selectAll.all() as BitableDeleteRetryEntry[];
    },
    dequeue(taskId) {
      del.run(taskId);
    },
  };
}

export type DrainLogger = {
  info(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
};

export type DrainResult = { drained: number; failed: number };

export async function drainBitableDeleteQueue(
  store: BitableDeleteRetryStore,
  doDelete: (taskId: string) => Promise<void>,
  logger: DrainLogger,
): Promise<DrainResult> {
  const entries = store.list();
  if (entries.length === 0) return { drained: 0, failed: 0 };

  let drained = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      await doDelete(entry.taskId);
      store.dequeue(entry.taskId);
      drained++;
      logger.info(
        { taskId: entry.taskId, attempts: entry.attempts },
        "bitable delete retry succeeded",
      );
    } catch (err) {
      store.enqueue(entry.taskId, err);
      failed++;
      logger.error(
        { err, taskId: entry.taskId, attempts: entry.attempts + 1 },
        "bitable delete retry failed; remains queued",
      );
    }
  }
  logger.info({ drained, failed, total: entries.length }, "bitable delete queue drained");
  return { drained, failed };
}
