CREATE INDEX IF NOT EXISTS idx_sessions_backend_session_id
  ON sessions(backend_session_id)
  WHERE backend_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cross_session_log_child
  ON cross_session_log(child_session_id)
  WHERE child_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cross_session_log_bitable_record
  ON cross_session_log(bitable_record_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cross_session_log_stale_sync
  ON cross_session_log(finished_at, synced_at, created_at)
  WHERE bitable_record_id IS NOT NULL
    AND finished_at IS NOT NULL;
