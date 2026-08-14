-- Sessions timestamps are health-critical: /api/health and dispatcher both
-- map active session rows through rowToSession. Repair historic dynamic-typing
-- drift and fail future non-integer timestamp writes at the SQLite boundary.

UPDATE sessions
SET created_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE created_at IS NULL OR typeof(created_at) != 'integer';

UPDATE sessions
SET updated_at = created_at
WHERE updated_at IS NULL OR typeof(updated_at) != 'integer';

CREATE TRIGGER IF NOT EXISTS sessions_timestamp_insert_guard
BEFORE INSERT ON sessions
FOR EACH ROW
WHEN NEW.created_at IS NULL
  OR NEW.updated_at IS NULL
  OR typeof(NEW.created_at) != 'integer'
  OR typeof(NEW.updated_at) != 'integer'
BEGIN
  SELECT RAISE(ABORT, 'sessions timestamps must be integer milliseconds');
END;

CREATE TRIGGER IF NOT EXISTS sessions_timestamp_update_guard
BEFORE UPDATE OF created_at, updated_at ON sessions
FOR EACH ROW
WHEN NEW.created_at IS NULL
  OR NEW.updated_at IS NULL
  OR typeof(NEW.created_at) != 'integer'
  OR typeof(NEW.updated_at) != 'integer'
BEGIN
  SELECT RAISE(ABORT, 'sessions timestamps must be integer milliseconds');
END;
