CREATE TABLE IF NOT EXISTS watcher_exceptions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  spawn_comm_id TEXT,
  trigger_signal TEXT NOT NULL,
  tx_id TEXT,
  dedupe_key TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  lark_message_id TEXT,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_watcher_exceptions_ts ON watcher_exceptions(ts);
CREATE INDEX IF NOT EXISTS idx_watcher_exceptions_spawn ON watcher_exceptions(spawn_comm_id);
