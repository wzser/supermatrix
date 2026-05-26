import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { Cron } from "croner";

export type ExecutorKind = "shell" | "http";

export type TaskClass = "sync_job" | "publication" | "monitoring" | "delegation" | "notification";
export type TaskCategory =
  | "数据采集"
  | "数据加工"
  | "报告产出"
  | "业务巡检"
  | "跨会话委派"
  | "平台运维"
  | "一次性补跑"
  | "已完成"
  | "已废弃";
export const TASK_CATEGORIES: readonly TaskCategory[] = [
  "数据采集",
  "数据加工",
  "报告产出",
  "业务巡检",
  "跨会话委派",
  "平台运维",
  "一次性补跑",
  "已完成",
  "已废弃",
] as const;
export type OverlapPolicy = "skip_if_running" | "queue" | "kill_previous" | "allow_concurrent";

export type TriggerStatus = "pending" | "ok" | "failed" | "skipped_overlap";
export type VerifyStatus = "pending" | "pass" | "fail";
export type FinalStatus =
  | "pending"
  | "success"
  | "trigger_failed"
  | "evidence_missing"
  | "skipped_overlap"
  | "acknowledged_failure";

export type Task = {
  id: string;
  name: string;
  description: string;
  cron: string;
  executor: ExecutorKind;
  config: Record<string, unknown>;
  enabled: boolean;
  oneshot: boolean;
  notifyOnFailure: boolean;
  nextRunAt: number | null;
  lastSuccessAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  class: TaskClass | null;
  category: TaskCategory | null;
  expectedDurationMs: number | null;
  overlapPolicy: OverlapPolicy | null;
  ownerSession: string | null;
  overrides: Record<string, unknown> | null;
  migrationEscalationStage: number;
};

export type TaskRun = {
  id: string;
  taskId: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "success" | "failed";  // LEGACY — kept for backward compat
  output: string | null;
  error: string | null;
  // NEW (from Task 5):
  triggerStatus: TriggerStatus;
  triggeredAt: number | null;
  runningPid: number | null;
  childSessionId: string | null;
  childMessageRunId: string | null;
  asyncRef: string | null;
  processExitedAt: number | null;
  exitCode: number | null;
  verifyStatus: VerifyStatus;
  verifyAttempts: number;
  receiptEvidence: Record<string, unknown> | null;
  finalStatus: FinalStatus;
};

export type NewTaskInput = {
  name: string;
  description?: string;
  cron: string;
  executor: ExecutorKind;
  config: Record<string, unknown>;
  oneshot?: boolean;
  notifyOnFailure?: boolean;
  createdBy?: string;
  class?: TaskClass;
  category?: TaskCategory;
  expectedDurationMs?: number;
  overlapPolicy?: OverlapPolicy;
  ownerSession?: string;
  overrides?: Record<string, unknown>;
};

export type UpdateTaskInput = {
  name?: string;
  description?: string;
  cron?: string;
  executor?: ExecutorKind;
  config?: Record<string, unknown>;
  enabled?: boolean;
  oneshot?: boolean;
  notifyOnFailure?: boolean;
  createdBy?: string;
  class?: TaskClass | null;
  category?: TaskCategory | null;
  expectedDurationMs?: number | null;
  overlapPolicy?: OverlapPolicy | null;
  ownerSession?: string | null;
  overrides?: Record<string, unknown> | null;
  migrationEscalationStage?: number;
};

export type TaskStore = {
  createTask(input: NewTaskInput): Task;
  getTask(id: string): Task | null;
  listTasks(): Task[];
  updateTask(id: string, input: UpdateTaskInput): Task;
  deleteTask(id: string): void;
  refreshNextRun(id: string): void;
  updateLastSuccess(id: string): void;
  createRun(taskId: string): TaskRun;
  /** @deprecated Legacy dual-status path (writes legacy `status` only; leaves `final_status` at 'pending'). Use `updateRunFinal` for the two-axis lifecycle. Callers in `src/main.ts` and `src/notify/failureResolve.ts` still depend on this as of Plan 1. */
  completeRun(id: string, status: "success" | "failed", output: string | null, error: string | null): void;
  listRuns(taskId: string, limit: number): TaskRun[];
  listRecentRuns(limit: number): TaskRun[];
  getRun(runId: string): TaskRun | undefined;
  updateRunTrigger(runId: string, patch: {
    triggerStatus: TriggerStatus;
    triggeredAt?: number;
    runningPid?: number;
    childSessionId?: string;
    childMessageRunId?: string;
    asyncRef?: string;
  }): void;
  updateRunVerify(runId: string, patch: {
    verifyStatus?: VerifyStatus;
    verifyAttempts?: number;
    receiptEvidence?: Record<string, unknown>;
    processExitedAt?: number;
    exitCode?: number | null;
  }): void;
  updateRunFinal(runId: string, finalStatus: FinalStatus, finishedAt: number, error?: string | null): void;
};

function rowToTask(row: Record<string, unknown>): Task {
  const overridesRaw = row.overrides as string | null | undefined;
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    cron: row.cron as string,
    executor: row.executor as ExecutorKind,
    config: JSON.parse(row.config as string),
    enabled: (row.enabled as number) === 1,
    oneshot: (row.oneshot as number) === 1,
    notifyOnFailure: (row.notify_on_failure as number) === 1,
    nextRunAt: (row.next_run_at as number) ?? null,
    lastSuccessAt: (row.last_success_at as number) ?? null,
    createdBy: (row.created_by as string) ?? "",
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    class: (row.class as TaskClass | null) ?? null,
    category: (row.category as TaskCategory | null) ?? null,
    expectedDurationMs: (row.expected_duration_ms as number | null) ?? null,
    overlapPolicy: (row.overlap_policy as OverlapPolicy | null) ?? null,
    ownerSession: (row.owner_session as string | null) ?? null,
    overrides: overridesRaw ? JSON.parse(overridesRaw) : null,
    migrationEscalationStage: (row.migration_escalation_stage as number | null) ?? 0,
  };
}

function rowToRun(row: Record<string, unknown>): TaskRun {
  const receiptRaw = row.receipt_evidence as string | null | undefined;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    startedAt: row.started_at as number,
    finishedAt: (row.finished_at as number) ?? null,
    status: (row.status as TaskRun["status"]) ?? "running",
    output: (row.output as string) ?? null,
    error: (row.error as string) ?? null,
    triggerStatus: (row.trigger_status as TriggerStatus) ?? "pending",
    triggeredAt: (row.triggered_at as number) ?? null,
    runningPid: (row.running_pid as number) ?? null,
    childSessionId: (row.child_session_id as string) ?? null,
    childMessageRunId: (row.child_message_run_id as string) ?? null,
    asyncRef: (row.async_ref as string) ?? null,
    processExitedAt: (row.process_exited_at as number) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    verifyStatus: (row.verify_status as VerifyStatus) ?? "pending",
    verifyAttempts: (row.verify_attempts as number) ?? 0,
    receiptEvidence: receiptRaw ? JSON.parse(receiptRaw) : null,
    finalStatus: (row.final_status as FinalStatus) ?? "pending",
  };
}

function computeNextRun(cron: string, enabled: boolean): number | null {
  if (!enabled) return null;
  try {
    const next = new Cron(cron).nextRun();
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function createTaskStore(db: Database.Database): TaskStore {
  const insertTask = db.prepare(`
    INSERT INTO tasks (id, name, description, cron, executor, config, enabled, oneshot, notify_on_failure, next_run_at, created_by, created_at, updated_at, class, expected_duration_ms, overlap_policy, owner_session, overrides, category)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const selectTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const selectAllTasks = db.prepare("SELECT * FROM tasks ORDER BY created_at DESC");
  const removeTask = db.prepare("DELETE FROM tasks WHERE id = ?");
  const updateNextRun = db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?");
  const updateLastSuccessStmt = db.prepare("UPDATE tasks SET last_success_at = ? WHERE id = ?");

  const insertRun = db.prepare(`
    INSERT INTO task_runs (id, task_id, started_at, status)
    VALUES (?, ?, ?, 'running')
  `);

  const finishRun = db.prepare(`
    UPDATE task_runs SET finished_at = ?, status = ?, output = ?, error = ? WHERE id = ?
  `);

  const selectRuns = db.prepare(
    "SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?"
  );

  const selectRecentRuns = db.prepare(
    "SELECT * FROM task_runs ORDER BY started_at DESC, rowid DESC LIMIT ?"
  );

  const getRunStmt = db.prepare("SELECT * FROM task_runs WHERE id = ?");

  const updateRunTriggerStmt = db.prepare(`
    UPDATE task_runs SET
      trigger_status = ?, triggered_at = ?, running_pid = ?,
      child_session_id = ?, child_message_run_id = ?, async_ref = ?
    WHERE id = ?
  `);

  const updateRunVerifyStmt = db.prepare(`
    UPDATE task_runs SET
      verify_status = COALESCE(?, verify_status),
      verify_attempts = COALESCE(?, verify_attempts),
      receipt_evidence = COALESCE(?, receipt_evidence),
      process_exited_at = COALESCE(?, process_exited_at),
      exit_code = COALESCE(?, exit_code)
    WHERE id = ?
  `);

  const updateRunFinalStmt = db.prepare(`
    UPDATE task_runs SET final_status = ?, finished_at = ?, status = ?, error = COALESCE(?, error) WHERE id = ?
  `);

  const stampLastSuccessStmt = db.prepare(
    "UPDATE tasks SET last_success_at = ? WHERE id = (SELECT task_id FROM task_runs WHERE id = ?)"
  );

  return {
    createTask(input) {
      const id = randomUUID();
      const now = Date.now();
      const nextRun = computeNextRun(input.cron, true);
      insertTask.run(
        id, input.name, input.description ?? "", input.cron, input.executor,
        JSON.stringify(input.config), input.oneshot ? 1 : 0, input.notifyOnFailure ? 1 : 0,
        nextRun, input.createdBy ?? "", now, now,
        input.class ?? null,
        input.expectedDurationMs ?? null,
        input.overlapPolicy ?? null,
        input.ownerSession ?? null,
        input.overrides !== undefined ? JSON.stringify(input.overrides) : null,
        input.category ?? null
      );
      return rowToTask(selectTask.get(id) as Record<string, unknown>);
    },

    getTask(id) {
      const row = selectTask.get(id) as Record<string, unknown> | undefined;
      return row ? rowToTask(row) : null;
    },

    listTasks() {
      return (selectAllTasks.all() as Record<string, unknown>[]).map(rowToTask);
    },

    updateTask(id, input) {
      const existing = selectTask.get(id) as Record<string, unknown> | undefined;
      if (!existing) throw new Error(`Task not found: ${id}`);

      const fields: string[] = [];
      const values: unknown[] = [];

      if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
      if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
      if (input.cron !== undefined) { fields.push("cron = ?"); values.push(input.cron); }
      if (input.executor !== undefined) { fields.push("executor = ?"); values.push(input.executor); }
      if (input.config !== undefined) { fields.push("config = ?"); values.push(JSON.stringify(input.config)); }
      if (input.enabled !== undefined) { fields.push("enabled = ?"); values.push(input.enabled ? 1 : 0); }
      if (input.oneshot !== undefined) { fields.push("oneshot = ?"); values.push(input.oneshot ? 1 : 0); }
      if (input.notifyOnFailure !== undefined) { fields.push("notify_on_failure = ?"); values.push(input.notifyOnFailure ? 1 : 0); }
      if (input.createdBy !== undefined) { fields.push("created_by = ?"); values.push(input.createdBy); }
      if (input.class !== undefined) { fields.push("class = ?"); values.push(input.class); }
      if (input.category !== undefined) { fields.push("category = ?"); values.push(input.category); }
      if (input.expectedDurationMs !== undefined) { fields.push("expected_duration_ms = ?"); values.push(input.expectedDurationMs); }
      if (input.overlapPolicy !== undefined) { fields.push("overlap_policy = ?"); values.push(input.overlapPolicy); }
      if (input.ownerSession !== undefined) { fields.push("owner_session = ?"); values.push(input.ownerSession); }
      if (input.overrides !== undefined) { fields.push("overrides = ?"); values.push(input.overrides === null ? null : JSON.stringify(input.overrides)); }
      if (input.migrationEscalationStage !== undefined) { fields.push("migration_escalation_stage = ?"); values.push(input.migrationEscalationStage); }

      if (fields.length === 0) return rowToTask(existing);

      const now = Date.now();
      fields.push("updated_at = ?");
      values.push(now);

      if (input.cron !== undefined || input.enabled !== undefined) {
        const cron = input.cron ?? (existing.cron as string);
        const enabled = input.enabled ?? ((existing.enabled as number) === 1);
        fields.push("next_run_at = ?");
        values.push(computeNextRun(cron, enabled));
      }

      values.push(id);

      db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      return rowToTask(selectTask.get(id) as Record<string, unknown>);
    },

    deleteTask(id) {
      removeTask.run(id);
    },

    refreshNextRun(id) {
      const task = this.getTask(id);
      if (!task) return;
      updateNextRun.run(computeNextRun(task.cron, task.enabled), id);
    },

    updateLastSuccess(id) {
      updateLastSuccessStmt.run(Date.now(), id);
    },

    createRun(taskId) {
      const id = randomUUID();
      const now = Date.now();
      insertRun.run(id, taskId, now);
      return rowToRun(getRunStmt.get(id) as Record<string, unknown>);
    },

    /** @deprecated Legacy dual-status path (writes legacy `status` only; leaves `final_status` at 'pending'). Use `updateRunFinal` for the two-axis lifecycle. Callers in `src/main.ts` and `src/notify/failureResolve.ts` still depend on this as of Plan 1. */
    completeRun(id, status, output, error) {
      finishRun.run(Date.now(), status, output, error, id);
    },

    listRuns(taskId, limit) {
      return (selectRuns.all(taskId, limit) as Record<string, unknown>[]).map(rowToRun);
    },

    listRecentRuns(limit) {
      return (selectRecentRuns.all(limit) as Record<string, unknown>[]).map(rowToRun);
    },

    getRun(runId) {
      const row = getRunStmt.get(runId) as Record<string, unknown> | undefined;
      return row ? rowToRun(row) : undefined;
    },

    updateRunTrigger(runId, patch) {
      updateRunTriggerStmt.run(
        patch.triggerStatus,
        patch.triggeredAt ?? null,
        patch.runningPid ?? null,
        patch.childSessionId ?? null,
        patch.childMessageRunId ?? null,
        patch.asyncRef ?? null,
        runId
      );
    },

    updateRunVerify(runId, patch) {
      updateRunVerifyStmt.run(
        patch.verifyStatus ?? null,
        patch.verifyAttempts ?? null,
        patch.receiptEvidence ? JSON.stringify(patch.receiptEvidence) : null,
        patch.processExitedAt ?? null,
        patch.exitCode ?? null,
        runId
      );
    },

    updateRunFinal(runId, finalStatus, finishedAt, error) {
      const legacyStatus: TaskRun["status"] =
        finalStatus === "success" ? "success" :
        finalStatus === "pending" ? "running" : "failed";
      updateRunFinalStmt.run(finalStatus, finishedAt, legacyStatus, error ?? null, runId);
      if (finalStatus === "success") {
        stampLastSuccessStmt.run(finishedAt, runId);
      }
    },
  };
}
