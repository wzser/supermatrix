import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Task, TaskRun, RunOutcome } from "../types.js";

type TaskRow = {
  id: string; name: string; description: string; owner: string; created_by: string;
  type: string; config: string; cron: string; enabled: number; oneshot: number;
  category: string | null; retry_enabled: number; retry_exit_codes: string | null;
  retry_max: number; retry_delay_ms: number;
  alert_threshold: number; alert_channel: string; last_success_at: number | null;
  created_at: number; updated_at: number;
};

type RunRow = {
  id: string; task_id: string; scheduled_at: number | null; triggered_at: number; finished_at: number | null;
  outcome: string; attempts: number; error: string | null;
  pid: number | null; child_session_id: string | null;
};

type MutationRow = {
  id: number; timestamp: number; occurred_at_utc: string; task_id: string; action: string;
  actor_class: string | null; actor_session: string | null; source_comm_id: string | null;
  before_state: string | null; after_state: string | null;
};

const EXPIRED_MISSED_SLOT_ERROR =
  "availability expired: scheduled slot exceeded the boot catch-up window; no business task was dispatched or replayed";

function normalizeScheduledAt(scheduledAt: number | null): number | null {
  return scheduledAt === null ? null : Math.floor(scheduledAt / 60_000) * 60_000;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id, name: r.name, description: r.description, owner: r.owner, createdBy: r.created_by,
    type: r.type as Task["type"], config: JSON.parse(r.config), cron: r.cron,
    enabled: !!r.enabled, oneshot: !!r.oneshot, category: r.category,
    retryEnabled: !!r.retry_enabled,
    retryExitCodes: r.retry_exit_codes === null ? undefined : JSON.parse(r.retry_exit_codes),
    retryMax: r.retry_max, retryDelayMs: r.retry_delay_ms,
    alertThreshold: r.alert_threshold, alertChannel: r.alert_channel,
    lastSuccessAt: r.last_success_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToRun(r: RunRow): TaskRun {
  return {
    id: r.id, taskId: r.task_id, scheduledAt: r.scheduled_at, triggeredAt: r.triggered_at, finishedAt: r.finished_at,
    outcome: r.outcome as RunOutcome, attempts: r.attempts, error: r.error,
    pid: r.pid, childSessionId: r.child_session_id,
  };
}

export type CreateTaskInput = Omit<Task, "id" | "lastSuccessAt" | "createdAt" | "updatedAt">;
export type MutationActorClass =
  | "scheduler_admin"
  | "loopback_session_oneshot"
  | "scheduler_runtime"
  | "write_lock_unconfigured";
export type MutationAction = "create" | "update" | "delete" | "disable";
export type MutationAuditContext = {
  actorClass: MutationActorClass;
  actorSession: string;
  sourceCommId: string | null;
};
export type TaskMutation = {
  id: number;
  timestamp: number;
  occurredAtUtc: string;
  taskId: string;
  action: MutationAction;
  actorClass: MutationActorClass | null;
  actorSession: string | null;
  sourceCommId: string | null;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

function diffChangedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => {
    const lhs = before?.[key];
    const rhs = after?.[key];
    return JSON.stringify(lhs) !== JSON.stringify(rhs);
  }).sort();
}

function rowToMutation(row: MutationRow): TaskMutation {
  const parse = (raw: string | null): Record<string, unknown> | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const before = parse(row.before_state);
  const after = parse(row.after_state);
  return {
    id: row.id,
    timestamp: row.timestamp,
    occurredAtUtc: row.occurred_at_utc,
    taskId: row.task_id,
    action: row.action as MutationAction,
    actorClass: row.actor_class as MutationActorClass | null,
    actorSession: row.actor_session,
    sourceCommId: row.source_comm_id,
    changedFields: diffChangedFields(before, after),
    before,
    after,
  };
}


export function createTaskStore(db: Database.Database) {
  const insertTask = db.prepare(`
    INSERT INTO tasks (id,name,description,owner,created_by,type,config,cron,enabled,oneshot,
      category,retry_enabled,retry_exit_codes,retry_max,retry_delay_ms,alert_threshold,alert_channel,
      last_success_at,created_at,updated_at)
    VALUES (@id,@name,@description,@owner,@created_by,@type,@config,@cron,@enabled,@oneshot,
      @category,@retry_enabled,@retry_exit_codes,@retry_max,@retry_delay_ms,@alert_threshold,@alert_channel,
      NULL,@created_at,@updated_at)`);
  const selectTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectAll = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC");
  const deleteTaskStmt = db.prepare("DELETE FROM tasks WHERE id = ?");
  const selectMutations = db.prepare(
    `SELECT * FROM task_mutations ORDER BY timestamp DESC, id DESC LIMIT ?`);
  const selectMutationsByTask = db.prepare(
    `SELECT * FROM task_mutations WHERE task_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?`);
  const insertTaskMutation = db.prepare(
    `INSERT INTO task_mutations (
      timestamp,occurred_at_utc,task_id,action,actor_class,
      actor_session,source_comm_id,before_state,after_state
    ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertRun = db.prepare(
    `INSERT OR IGNORE INTO task_runs (id,task_id,scheduled_at,triggered_at,outcome,attempts)
     VALUES (?,?,?,?, 'failed', 1)`);
  const selectRuns = db.prepare(
    "SELECT * FROM task_runs WHERE task_id = ? ORDER BY triggered_at DESC, rowid DESC LIMIT ?");
  const stampSuccess = db.prepare("UPDATE tasks SET last_success_at = ?, updated_at = ? WHERE id = ?");

  function recordTaskMutation(
    timestamp: number,
    taskId: string,
    action: MutationAction,
    context: MutationAuditContext,
    beforeState: Task | null,
    afterState: Task | null,
  ): void {
    insertTaskMutation.run(
      timestamp,
      new Date(timestamp).toISOString(),
      taskId,
      action,
      context.actorClass,
      context.actorSession,
      context.sourceCommId,
      beforeState === null ? null : JSON.stringify(beforeState),
      afterState === null ? null : JSON.stringify(afterState),
    );
  }

  function createTask(input: CreateTaskInput, auditContext?: MutationAuditContext): Task {
    const now = Date.now();
    const id = randomUUID();
    return db.transaction(() => {
      insertTask.run({
        id, name: input.name, description: input.description ?? "", owner: input.owner,
        created_by: input.createdBy ?? "", type: input.type,
        config: JSON.stringify(input.config), cron: input.cron,
        enabled: input.enabled ? 1 : 0, oneshot: input.oneshot ? 1 : 0,
        category: input.category ?? null,
        retry_enabled: input.retryEnabled ? 1 : 0,
        retry_exit_codes: input.retryExitCodes === undefined ? null : JSON.stringify(input.retryExitCodes),
        retry_max: input.retryMax,
        retry_delay_ms: input.retryDelayMs, alert_threshold: input.alertThreshold,
        alert_channel: input.alertChannel, created_at: now, updated_at: now,
      });
      const task = getTask(id)!;
      if (auditContext) recordTaskMutation(now, id, "create", auditContext, null, task);
      return task;
    })();
  }

  function getTask(id: string): Task | null {
    const row = selectTask.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  function listTasks(): Task[] {
    return (selectAll.all() as TaskRow[]).map(rowToTask);
  }

  function updateTask(
    id: string,
    patch: Partial<CreateTaskInput>,
    auditContext?: MutationAuditContext,
  ): Task | null {
    return db.transaction(() => {
      const cur = getTask(id);
      if (!cur) return null;
      const next: CreateTaskInput = {
        name: patch.name ?? cur.name, description: patch.description ?? cur.description,
        owner: patch.owner ?? cur.owner, createdBy: patch.createdBy ?? cur.createdBy,
        type: patch.type ?? cur.type, config: patch.config ?? cur.config,
        cron: patch.cron ?? cur.cron,
        enabled: patch.enabled ?? cur.enabled, oneshot: patch.oneshot ?? cur.oneshot,
        category: patch.category !== undefined ? patch.category : cur.category,
        retryEnabled: patch.retryEnabled ?? cur.retryEnabled,
        retryExitCodes: patch.retryExitCodes ?? cur.retryExitCodes,
        retryMax: patch.retryMax ?? cur.retryMax, retryDelayMs: patch.retryDelayMs ?? cur.retryDelayMs,
        alertThreshold: patch.alertThreshold ?? cur.alertThreshold,
        alertChannel: patch.alertChannel ?? cur.alertChannel,
      };
      const now = Date.now();
      db.prepare(`UPDATE tasks SET name=@name,description=@description,owner=@owner,created_by=@created_by,
        type=@type,config=@config,cron=@cron,enabled=@enabled,oneshot=@oneshot,category=@category,
        retry_enabled=@retry_enabled,retry_exit_codes=@retry_exit_codes,retry_max=@retry_max,retry_delay_ms=@retry_delay_ms,
        alert_threshold=@alert_threshold,alert_channel=@alert_channel,updated_at=@updated_at
        WHERE id=@id`).run({
        id, name: next.name, description: next.description, owner: next.owner, created_by: next.createdBy,
        type: next.type, config: JSON.stringify(next.config), cron: next.cron,
        enabled: next.enabled ? 1 : 0, oneshot: next.oneshot ? 1 : 0, category: next.category ?? null,
        retry_enabled: next.retryEnabled ? 1 : 0,
        retry_exit_codes: next.retryExitCodes === undefined ? null : JSON.stringify(next.retryExitCodes),
        retry_max: next.retryMax,
        retry_delay_ms: next.retryDelayMs, alert_threshold: next.alertThreshold,
        alert_channel: next.alertChannel, updated_at: now,
      });
      const updated = getTask(id)!;
      if (auditContext) {
        const action: MutationAction = cur.enabled && !updated.enabled ? "disable" : "update";
        recordTaskMutation(now, id, action, auditContext, cur, updated);
      }
      return updated;
    })();
  }

  function deleteTask(id: string, auditContext?: MutationAuditContext): boolean {
    return db.transaction(() => {
      const cur = getTask(id);
      if (!cur) return false;
      const deleted = deleteTaskStmt.run(id).changes > 0;
      if (deleted && auditContext) {
        recordTaskMutation(Date.now(), id, "delete", auditContext, cur, null);
      }
      return deleted;
    })();
  }

  function listMutations(taskId: string | undefined, limit: number): TaskMutation[] {
    const rows = (taskId
      ? selectMutationsByTask.all(taskId, limit)
      : selectMutations.all(limit)) as MutationRow[];
    return rows.map(rowToMutation);
  }

  const selectRunForScheduledAt = db.prepare(
    `SELECT 1 FROM task_runs
     WHERE task_id = ?
       AND scheduled_at >= ?
       AND scheduled_at < ?
     LIMIT 1`);

  function createRun(taskId: string, triggeredAt: number, scheduledAt?: number | null): string | null {
    const id = randomUUID();
    const recordedScheduledAt = scheduledAt === undefined
      ? triggeredAt
      : normalizeScheduledAt(scheduledAt);
    const result = insertRun.run(id, taskId, recordedScheduledAt, triggeredAt);
    return result.changes === 1 ? id : null;
  }

  function hasDeliveryForScheduledAt(taskId: string, scheduledAt: number): boolean {
    const normalized = normalizeScheduledAt(scheduledAt)!;
    return Boolean(selectRunForScheduledAt.get(taskId, normalized, normalized + 60_000));
  }

  function recordExpiredMissedSlot(taskId: string, scheduledAt: number, observedAt = Date.now()): boolean {
    const runId = createRun(taskId, observedAt, scheduledAt);
    if (!runId) return false;
    finalizeRun(runId, {
      outcome: "expired",
      attempts: 0,
      error: EXPIRED_MISSED_SLOT_ERROR,
    });
    return true;
  }

  function finalizeRun(runId: string, fields: {
    outcome: RunOutcome; attempts: number; error?: string;
    pid?: number; childSessionId?: string;
  }): void {
    const now = Date.now();
    db.prepare(`UPDATE task_runs SET outcome=?, attempts=?, error=?, pid=?, child_session_id=?,
      finished_at=? WHERE id=?`).run(
      fields.outcome, fields.attempts, fields.error ?? null,
      fields.pid ?? null, fields.childSessionId ?? null, now, runId);
    if (fields.outcome === "success") {
      const row = db.prepare("SELECT task_id FROM task_runs WHERE id=?").get(runId) as
        { task_id: string } | undefined;
      if (row) stampSuccess.run(now, now, row.task_id);
    }
  }

  function recentRuns(taskId: string, limit: number): TaskRun[] {
    return (selectRuns.all(taskId, limit) as RunRow[]).map(rowToRun);
  }

  function consecutiveFailures(taskId: string): number {
    const rows = selectRuns.all(taskId, 1000) as RunRow[]; // DESC by triggered_at
    let n = 0;
    for (const r of rows) {
      if (r.outcome === "failed") n++;
      else break;
    }
    return n;
  }

  return {
    createTask, getTask, listTasks, updateTask, deleteTask,
    listMutations,
    createRun, hasDeliveryForScheduledAt, recordExpiredMissedSlot,
    finalizeRun, recentRuns, consecutiveFailures,
  };
}

export type TaskStore = ReturnType<typeof createTaskStore>;
