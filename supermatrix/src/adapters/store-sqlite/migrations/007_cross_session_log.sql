CREATE TABLE cross_session_log (
  id               TEXT PRIMARY KEY,
  from_session_id  TEXT NOT NULL,
  to_session_id    TEXT NOT NULL,
  kind             TEXT NOT NULL,
  prompt           TEXT,
  child_session_id TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  result_preview   TEXT,
  error_message    TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  FOREIGN KEY (from_session_id) REFERENCES sessions(id),
  FOREIGN KEY (to_session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_cross_session_log_from ON cross_session_log(from_session_id, created_at DESC);
CREATE INDEX idx_cross_session_log_to ON cross_session_log(to_session_id, created_at DESC);
