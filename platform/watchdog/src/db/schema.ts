import type Database from "better-sqlite3";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS issues (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,
  description   TEXT NOT NULL,
  verification  TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  result        TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, created_at ASC);

CREATE TABLE IF NOT EXISTS bitable_sync (
  issue_id    TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL
);
`;

const MIGRATION_V2 = `ALTER TABLE issues ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`;

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(MIGRATION);

  // V2: add retry_count to existing databases that were created before this column existed
  const columns = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  const hasRetryCount = columns.some((c) => c.name === "retry_count");
  if (!hasRetryCount) {
    db.exec(MIGRATION_V2);
  }
}
