CREATE TABLE watcher_state (
  spawn_comm_id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_run_result TEXT
    CHECK (last_run_result IN ('true', 'false', 'transient_fail', 'permanent_fail')),
  last_run_error TEXT,
  last_run_duration_ms INTEGER,
  consecutive_false_count INTEGER NOT NULL DEFAULT 0,
  consecutive_transient_fail_count INTEGER NOT NULL DEFAULT 0,
  patch_count_24h INTEGER NOT NULL DEFAULT 0,
  transaction_started_at INTEGER,
  last_trigger_signal TEXT,
  next_eligible_at INTEGER,
  closed_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (spawn_comm_id) REFERENCES spawn_predicates(spawn_comm_id) ON DELETE CASCADE
);

CREATE INDEX idx_watcher_state_open
  ON watcher_state(closed_at, next_eligible_at, updated_at);
CREATE INDEX idx_watcher_state_transaction
  ON watcher_state(transaction_started_at);

CREATE TABLE watcher_ticks (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0,
  evaluated_count INTEGER NOT NULL DEFAULT 0,
  routed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  error_message TEXT
);

CREATE INDEX idx_watcher_ticks_ts
  ON watcher_ticks(ts);
