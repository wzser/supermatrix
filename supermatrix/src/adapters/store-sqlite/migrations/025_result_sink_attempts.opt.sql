CREATE TABLE result_sink_attempts (
  id TEXT PRIMARY KEY,
  spawn_comm_id TEXT,
  child_session_id TEXT NOT NULL,
  message_run_id TEXT,
  sink_index INTEGER NOT NULL,
  sink_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'skipped', 'failed')),
  note TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (spawn_comm_id) REFERENCES cross_session_log(id) ON DELETE SET NULL,
  FOREIGN KEY (child_session_id) REFERENCES sessions(id),
  FOREIGN KEY (message_run_id) REFERENCES message_runs(id)
);

CREATE INDEX idx_result_sink_attempts_spawn
  ON result_sink_attempts(spawn_comm_id, created_at DESC);
CREATE INDEX idx_result_sink_attempts_child
  ON result_sink_attempts(child_session_id, created_at DESC);
CREATE INDEX idx_result_sink_attempts_status
  ON result_sink_attempts(status, created_at DESC);
