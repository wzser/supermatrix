CREATE TABLE IF NOT EXISTS session_branches (
  session_id                TEXT NOT NULL,
  name                      TEXT NOT NULL,
  backend_session_id        TEXT,
  source_branch_name        TEXT,
  source_backend_session_id TEXT,
  fork_pending              INTEGER NOT NULL DEFAULT 0,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (session_id, name),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_branch_state (
  session_id          TEXT PRIMARY KEY,
  active_branch_name  TEXT NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

ALTER TABLE message_runs ADD COLUMN branch_name TEXT NOT NULL DEFAULT 'main';

CREATE INDEX IF NOT EXISTS idx_session_branches_session
  ON session_branches(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_runs_session_branch
  ON message_runs(session_id, branch_name, started_at DESC);
