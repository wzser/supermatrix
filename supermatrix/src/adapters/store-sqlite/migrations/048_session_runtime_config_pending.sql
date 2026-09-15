CREATE TABLE IF NOT EXISTS session_runtime_config_pending (
  session_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  requested_json TEXT NOT NULL,
  catalog_source TEXT NOT NULL,
  catalog_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_runtime_config_pending_updated
  ON session_runtime_config_pending(updated_at ASC);
