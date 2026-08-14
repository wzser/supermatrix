CREATE TABLE token_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT    NOT NULL,
  message_run_id     TEXT    NOT NULL UNIQUE,
  backend            TEXT    NOT NULL,
  model              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  raw_usage_json     TEXT,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (session_id)     REFERENCES sessions(id)     ON DELETE CASCADE,
  FOREIGN KEY (message_run_id) REFERENCES message_runs(id) ON DELETE CASCADE
);
CREATE INDEX idx_token_usage_session_created ON token_usage(session_id, created_at);
CREATE INDEX idx_token_usage_message_run     ON token_usage(message_run_id);
