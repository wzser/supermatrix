CREATE TABLE response_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id        TEXT UNIQUE NOT NULL,
  source             TEXT NOT NULL,
  source_ref         TEXT NOT NULL,
  source_url         TEXT,
  mentioner          TEXT,
  mentioned_at       INTEGER NOT NULL,
  trigger_text       TEXT,
  response_text      TEXT,
  response_at        INTEGER,
  response_status    TEXT NOT NULL,
  response_error     TEXT,
  mirror_status      TEXT NOT NULL DEFAULT 'pending',
  mirror_record_id   TEXT,
  mirror_synced_at   INTEGER,
  mirror_error       TEXT,
  mirror_retry_count INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_response_log_mirror_status
  ON response_log(mirror_status)
  WHERE mirror_status != 'ok';

CREATE INDEX idx_response_log_mentioned_at
  ON response_log(mentioned_at);
