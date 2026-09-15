CREATE TABLE scheduler_cleanup_requests (
  client_request_id TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  session_name      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 1,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  submitted_at      INTEGER
);

CREATE INDEX idx_scheduler_cleanup_requests_status
  ON scheduler_cleanup_requests(status, updated_at);
