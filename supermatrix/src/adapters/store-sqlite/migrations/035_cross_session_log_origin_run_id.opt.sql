ALTER TABLE cross_session_log ADD COLUMN origin_run_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cross_session_log_origin_run_id
  ON cross_session_log(origin_run_id, created_at DESC)
  WHERE origin_run_id IS NOT NULL;
