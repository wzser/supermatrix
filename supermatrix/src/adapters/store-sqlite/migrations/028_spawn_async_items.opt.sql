CREATE TABLE spawn_async_items (
  ref TEXT PRIMARY KEY,
  comm_id TEXT NOT NULL,
  caller_session TEXT,
  target_session TEXT,
  failed_phase TEXT NOT NULL,
  failure_kind TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  verdict TEXT,
  verdict_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  FOREIGN KEY (comm_id) REFERENCES cross_session_log(id)
);

CREATE INDEX idx_spawn_async_items_status ON spawn_async_items(status, updated_at);
CREATE INDEX idx_spawn_async_items_comm ON spawn_async_items(comm_id);
