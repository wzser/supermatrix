CREATE TABLE message_run_canonical_pointers (
  message_run_id       TEXT NOT NULL,
  content_kind         TEXT NOT NULL CHECK (
    content_kind IN ('prompt', 'final_message', 'canonical_stream')
  ),
  backend_session_id   TEXT NOT NULL,
  canonical_object_id TEXT NOT NULL,
  content_sha256       TEXT NOT NULL CHECK (length(content_sha256) = 64),
  archive_path         TEXT NOT NULL,
  byte_offset          INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_length          INTEGER NOT NULL CHECK (byte_length > 0),
  schema_version       INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (message_run_id, content_kind),
  FOREIGN KEY (message_run_id) REFERENCES message_runs(id) ON DELETE CASCADE
);

CREATE INDEX idx_message_run_canonical_backend_object
  ON message_run_canonical_pointers(backend_session_id, canonical_object_id);

CREATE INDEX idx_message_run_canonical_archive_range
  ON message_run_canonical_pointers(archive_path, byte_offset);
