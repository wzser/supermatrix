ALTER TABLE sessions ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_sessions_heartbeat_enabled
  ON sessions(heartbeat_enabled, status, scope, updated_at);
