import type Database from "better-sqlite3";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,
  cron             TEXT NOT NULL,
  executor         TEXT NOT NULL,
  config           TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  notify_on_failure INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  output      TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_started ON task_runs(started_at DESC);
`;

const MIGRATION_002 = `
ALTER TABLE tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';
`;

const MIGRATION_003 = `
ALTER TABLE tasks ADD COLUMN oneshot INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_004 = `
ALTER TABLE tasks ADD COLUMN next_run_at INTEGER;
`;

const MIGRATION_005 = `
ALTER TABLE tasks ADD COLUMN created_by TEXT NOT NULL DEFAULT '';
`;

const MIGRATION_006 = `
ALTER TABLE tasks ADD COLUMN last_success_at INTEGER;
`;

const MIGRATION_007 = `
  ALTER TABLE tasks ADD COLUMN class TEXT;
  ALTER TABLE tasks ADD COLUMN expected_duration_ms INTEGER;
  ALTER TABLE tasks ADD COLUMN overlap_policy TEXT;
  ALTER TABLE tasks ADD COLUMN owner_session TEXT;
  ALTER TABLE tasks ADD COLUMN overrides TEXT;
`;

const MIGRATION_008 = `
  ALTER TABLE task_runs ADD COLUMN trigger_status TEXT;
  ALTER TABLE task_runs ADD COLUMN triggered_at INTEGER;
  ALTER TABLE task_runs ADD COLUMN running_pid INTEGER;
  ALTER TABLE task_runs ADD COLUMN child_session_id TEXT;
  ALTER TABLE task_runs ADD COLUMN child_message_run_id TEXT;
  ALTER TABLE task_runs ADD COLUMN process_exited_at INTEGER;
  ALTER TABLE task_runs ADD COLUMN verify_status TEXT DEFAULT 'pending';
  ALTER TABLE task_runs ADD COLUMN verify_attempts INTEGER DEFAULT 0;
  ALTER TABLE task_runs ADD COLUMN receipt_evidence TEXT;
  ALTER TABLE task_runs ADD COLUMN final_status TEXT DEFAULT 'pending';
`;

const MIGRATION_009 = `
  CREATE TABLE IF NOT EXISTS task_verifications (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_task_verifications_due
    ON task_verifications(status, due_at);
`;

const MIGRATION_010 = `
  CREATE TABLE IF NOT EXISTS heal_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    spawned_at INTEGER NOT NULL,
    child_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    spawn_retry_count INTEGER NOT NULL DEFAULT 0,
    reply_action TEXT,
    reply_raw TEXT,
    replied_at INTEGER,
    default_applied_at INTEGER
  );
`;

const MIGRATION_011 = `
  CREATE TABLE IF NOT EXISTS migration_proposals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    owner_session TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    child_session_id TEXT,
    spawned_at INTEGER NOT NULL,
    replied_at INTEGER,
    reply_action TEXT,
    reply_raw TEXT,
    default_applied_at INTEGER,
    suggested_class TEXT NOT NULL,
    suggested_expected_duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_migration_proposals_task ON migration_proposals(task_id, spawned_at);
  CREATE INDEX IF NOT EXISTS idx_migration_proposals_owner_status ON migration_proposals(owner_session, status);

  CREATE TABLE IF NOT EXISTS migration_preview_sent (
    owner_session TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
  );

  ALTER TABLE tasks ADD COLUMN migration_escalation_stage INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_012 = `
  CREATE TABLE IF NOT EXISTS bitable_delete_retries (
    task_id    TEXT PRIMARY KEY,
    queued_at  INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
`;

const MIGRATION_013 = `
  CREATE TABLE IF NOT EXISTS disabled_warnings (
    task_id        TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    last_warned_at INTEGER NOT NULL
  );
`;

const MIGRATION_014 = `
  ALTER TABLE task_runs ADD COLUMN exit_code INTEGER;
`;

const MIGRATION_015 = `
  ALTER TABLE tasks ADD COLUMN category TEXT;
`;

const MIGRATION_016 = `
CREATE TABLE IF NOT EXISTS creation_reviews (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger         TEXT NOT NULL,
  task_snapshot   TEXT NOT NULL,
  l1_report       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  dispatched_at   INTEGER,
  decided_at      INTEGER,
  decision_reason TEXT,
  decision_patch  TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_creation_reviews_status ON creation_reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_creation_reviews_task ON creation_reviews(task_id);
`;

const MIGRATION_017 = `
  CREATE TABLE IF NOT EXISTS heal_escalations (
    task_id           TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    last_escalated_at INTEGER NOT NULL
  );
`;

const MIGRATION_018 = `
  CREATE TABLE IF NOT EXISTS rate_limit_quiet (
    scope          TEXT PRIMARY KEY,
    quiet_until_ms INTEGER NOT NULL,
    detected_at_ms INTEGER NOT NULL,
    source_task_id TEXT,
    source_run_id  TEXT,
    source_snippet TEXT
  );
`;

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(MIGRATION);

  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "description")) {
    db.exec(MIGRATION_002);
  }
  if (!cols.some((c) => c.name === "oneshot")) {
    db.exec(MIGRATION_003);
  }
  if (!cols.some((c) => c.name === "next_run_at")) {
    db.exec(MIGRATION_004);
  }
  if (!cols.some((c) => c.name === "created_by")) {
    db.exec(MIGRATION_005);
  }
  if (!cols.some((c) => c.name === "last_success_at")) {
    db.exec(MIGRATION_006);
  }

  const tasksCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!tasksCols.some((c) => c.name === "class")) {
    db.exec(MIGRATION_007);
  }

  const runsCols = db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
  if (!runsCols.some((c) => c.name === "trigger_status")) {
    db.exec(MIGRATION_008);
  }

  const tv = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_verifications'").get();
  if (!tv) {
    db.exec(MIGRATION_009);
  }

  const hp = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='heal_proposals'").get();
  if (!hp) {
    db.exec(MIGRATION_010);
  }

  const mp = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_proposals'").get();
  if (!mp) {
    db.exec(MIGRATION_011);
  }

  const bdr = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bitable_delete_retries'").get();
  if (!bdr) {
    db.exec(MIGRATION_012);
  }

  const dw = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='disabled_warnings'").get();
  if (!dw) {
    db.exec(MIGRATION_013);
  }

  const runsCols2 = db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
  if (!runsCols2.some((c) => c.name === "exit_code")) {
    db.exec(MIGRATION_014);
  }

  const tasksCols2 = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!tasksCols2.some((c) => c.name === "category")) {
    db.exec(MIGRATION_015);
  }

  const cr = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='creation_reviews'").get();
  if (!cr) {
    db.exec(MIGRATION_016);
  }

  const he = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='heal_escalations'").get();
  if (!he) {
    db.exec(MIGRATION_017);
  }

  const rlq = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limit_quiet'").get();
  if (!rlq) {
    db.exec(MIGRATION_018);
  }

  const runsCols3 = db.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
  if (!runsCols3.some((c) => c.name === "async_ref")) {
    db.exec(`ALTER TABLE task_runs ADD COLUMN async_ref TEXT`);
  }
}
