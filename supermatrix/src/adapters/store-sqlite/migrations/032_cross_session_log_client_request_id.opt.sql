ALTER TABLE cross_session_log ADD COLUMN client_request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cross_session_log_client_request_id
  ON cross_session_log(client_request_id, status, created_at DESC);
