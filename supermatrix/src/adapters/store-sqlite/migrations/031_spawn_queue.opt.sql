CREATE TABLE spawn_queue (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  spawn_input_json TEXT NOT NULL,
  caller_session TEXT,
  comm_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'expired', 'failed')),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  ttl_sec INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES sessions(id),
  FOREIGN KEY (caller_session) REFERENCES sessions(id),
  FOREIGN KEY (comm_id) REFERENCES cross_session_log(id)
);

CREATE INDEX idx_spawn_queue_parent_status_created
  ON spawn_queue(parent_id, status, created_at);
CREATE INDEX idx_spawn_queue_comm
  ON spawn_queue(comm_id);
