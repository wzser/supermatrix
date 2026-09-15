CREATE TABLE drive_comment_mentions (
  dedupe_key     TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  file_token     TEXT NOT NULL,
  file_type      TEXT NOT NULL,
  comment_id     TEXT NOT NULL,
  reply_id       TEXT,
  from_user_id   TEXT,
  target_session TEXT NOT NULL,
  matched_rule   TEXT NOT NULL,
  status         TEXT NOT NULL,
  result_text    TEXT,
  error_message  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX idx_drive_comment_mentions_status_updated
  ON drive_comment_mentions(status, updated_at);
