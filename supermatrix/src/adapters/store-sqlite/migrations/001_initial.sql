CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  scope              TEXT NOT NULL,
  backend            TEXT NOT NULL,
  workdir            TEXT NOT NULL,
  backend_session_id TEXT,
  purpose            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  created_at         INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at         INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_updated_at ON sessions(updated_at);

CREATE TABLE bindings (
  group_id   TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT,
  uploaded_at   INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_attachments_session ON attachments(session_id, uploaded_at DESC);

CREATE TABLE constitution_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  rendered_at    INTEGER NOT NULL,
  git_commit_sha TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_constitution_history_session
  ON constitution_history(session_id, version DESC);

CREATE TABLE message_runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  group_id      TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  card_id       TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL,
  final_message TEXT,
  error_message TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX idx_message_runs_session
  ON message_runs(session_id, started_at DESC);
CREATE INDEX idx_message_runs_status ON message_runs(status);
