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
  retry_count   INTEGER NOT NULL DEFAULT 0,
  required_owner TEXT,
  required_completion_marker TEXT,
  required_evidence_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, created_at ASC);

CREATE TABLE IF NOT EXISTS bitable_sync (
  issue_id    TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL
);
`;

const MIGRATION_V2 = `ALTER TABLE issues ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`;

const MIGRATION_V3 = `
CREATE TABLE IF NOT EXISTS weekly_review_standing_retries (
  issue_id        TEXT PRIMARY KEY,
  dispatches_json TEXT NOT NULL,
  recorded_at     INTEGER NOT NULL
);
`;

const STRUCTURED_EVIDENCE_COLUMNS = [
  { name: "required_owner", definition: "TEXT" },
  { name: "required_completion_marker", definition: "TEXT" },
  { name: "required_evidence_state", definition: "TEXT" },
] as const;

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(MIGRATION);

  // V2: add retry_count to existing databases that were created before this column existed
  const columns = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  const hasRetryCount = columns.some((c) => c.name === "retry_count");
  if (!hasRetryCount) {
    db.exec(MIGRATION_V2);
  }

  // V3: retry_count also records failed verification attempts, so E7 needs a
  // separate durable receipt to distinguish an actual owner re-dispatch.
  db.exec(MIGRATION_V3);

  // V4: weekly-review closure must use the reviewer-selected canonical owner
  // and marker instead of trying to recover ownership from free-form text.
  const currentColumns = db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
  const currentNames = new Set(currentColumns.map((column) => column.name));
  for (const column of STRUCTURED_EVIDENCE_COLUMNS) {
    if (!currentNames.has(column.name)) {
      db.exec(`ALTER TABLE issues ADD COLUMN ${column.name} ${column.definition};`);
    }
  }
}
