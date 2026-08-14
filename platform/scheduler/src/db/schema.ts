import type Database from "better-sqlite3";

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      description     TEXT NOT NULL DEFAULT '',
      owner           TEXT NOT NULL,
      created_by      TEXT NOT NULL DEFAULT '',
      type            TEXT NOT NULL,            -- 'script' | 'session'
      config          TEXT NOT NULL,            -- JSON
      cron            TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      oneshot         INTEGER NOT NULL DEFAULT 0,
      category        TEXT,
      retry_enabled   INTEGER NOT NULL DEFAULT 0,
      retry_exit_codes TEXT,
      retry_max       INTEGER NOT NULL DEFAULT 0,
      retry_delay_ms  INTEGER NOT NULL DEFAULT 0,
      alert_threshold INTEGER NOT NULL DEFAULT 0,
      alert_channel   TEXT NOT NULL DEFAULT 'owner_dm',
      last_success_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id              TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      scheduled_at    INTEGER,
      triggered_at    INTEGER NOT NULL,
      finished_at     INTEGER,
      outcome         TEXT NOT NULL DEFAULT 'failed',  -- 'success' | 'failed'
      attempts        INTEGER NOT NULL DEFAULT 1,
      error           TEXT,
      pid             INTEGER,
      child_session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_runs_task
      ON task_runs(task_id, triggered_at DESC);

    -- Deliberately no foreign key: deletion attribution must survive task deletion.
    CREATE TABLE IF NOT EXISTS task_mutations (
      id              INTEGER PRIMARY KEY,
      timestamp       INTEGER NOT NULL,
      occurred_at_utc TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'disable')),
      actor_class     TEXT,
      actor_session   TEXT,
      source_comm_id  TEXT,
      before_state    TEXT,
      after_state     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_task_mutations_task
      ON task_mutations(task_id, timestamp DESC);
  `);

  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!taskColumns.some((column) => column.name === "retry_exit_codes")) {
    db.exec("ALTER TABLE tasks ADD COLUMN retry_exit_codes TEXT");
  }

  const mutationColumns = db.prepare("PRAGMA table_info(task_mutations)").all() as Array<{ name: string }>;
  const mutationColumnNames = new Set(mutationColumns.map((column) => column.name));
  const mutationSchema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_mutations'",
  ).get() as { sql: string } | undefined;
  const mutationActionsCurrent = Boolean(
    mutationSchema?.sql.includes("'update'") && mutationSchema?.sql.includes("'disable'"),
  );
  const requiredMutationColumns = [
    "id", "timestamp", "occurred_at_utc", "task_id", "action", "actor_class",
    "actor_session", "source_comm_id", "before_state", "after_state",
  ];
  if (!mutationActionsCurrent || requiredMutationColumns.some((column) => !mutationColumnNames.has(column))) {
    const priorColumn = (name: string, fallback = "NULL") =>
      mutationColumnNames.has(name) ? name : fallback;
    const priorOccurredAt = mutationColumnNames.has("occurred_at_utc")
      ? "COALESCE(occurred_at_utc, strftime('%Y-%m-%dT%H:%M:%fZ', timestamp / 1000.0, 'unixepoch'))"
      : "strftime('%Y-%m-%dT%H:%M:%fZ', timestamp / 1000.0, 'unixepoch')";
    const priorAction = mutationColumnNames.has("action")
      ? "CASE action WHEN 'patch' THEN 'update' ELSE action END"
      : "'update'";

    db.transaction(() => {
      db.exec(`
        CREATE TABLE task_mutations_rebuild (
          id              INTEGER PRIMARY KEY,
          timestamp       INTEGER NOT NULL,
          occurred_at_utc TEXT NOT NULL,
          task_id         TEXT NOT NULL,
          action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'disable')),
          actor_class     TEXT,
          actor_session   TEXT,
          source_comm_id  TEXT,
          before_state    TEXT,
          after_state     TEXT
        );
        INSERT INTO task_mutations_rebuild (
          id,timestamp,occurred_at_utc,task_id,action,actor_class,
          actor_session,source_comm_id,before_state,after_state
        )
        SELECT
          ${priorColumn("id")},
          ${priorColumn("timestamp")},
          ${priorOccurredAt},
          ${priorColumn("task_id")},
          ${priorAction},
          ${priorColumn("actor_class")},
          ${priorColumn("actor_session")},
          ${priorColumn("source_comm_id")},
          ${priorColumn("before_state")},
          ${priorColumn("after_state")}
        FROM task_mutations;
        DROP TABLE task_mutations;
        ALTER TABLE task_mutations_rebuild RENAME TO task_mutations;
      `);
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_mutations_task
      ON task_mutations(task_id, timestamp DESC)
  `);

  const runColumns = db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "scheduled_at")) {
    db.exec("ALTER TABLE task_runs ADD COLUMN scheduled_at INTEGER");
    db.exec(`
      UPDATE task_runs
      SET scheduled_at = triggered_at
      WHERE scheduled_at IS NULL
        AND (SELECT COUNT(*) FROM task_runs AS same_tick
             WHERE same_tick.task_id = task_runs.task_id
               AND same_tick.triggered_at = task_runs.triggered_at) = 1
    `);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_task_scheduled
      ON task_runs(task_id, scheduled_at)
      WHERE scheduled_at IS NOT NULL
  `);
}
