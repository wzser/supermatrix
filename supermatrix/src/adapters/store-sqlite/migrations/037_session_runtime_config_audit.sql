CREATE TABLE IF NOT EXISTS session_runtime_config_audit (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  before_json TEXT NOT NULL,
  requested_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  catalog_source TEXT NOT NULL,
  catalog_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_session_runtime_config_audit_session_created
  ON session_runtime_config_audit(session_id, created_at DESC);
