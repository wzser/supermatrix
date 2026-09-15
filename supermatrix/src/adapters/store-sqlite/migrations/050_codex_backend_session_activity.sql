ALTER TABLE sessions ADD COLUMN backend_session_updated_at INTEGER;

-- Existing threads predate the dedicated activity marker. Seed from their
-- latest completed main-branch run where possible; fall back to the historical
-- session timestamp so the first post-migration route decision remains stable.
UPDATE sessions
SET backend_session_updated_at = COALESCE(
  (
    SELECT MAX(COALESCE(message_runs.finished_at, message_runs.started_at))
    FROM message_runs
    WHERE message_runs.session_id = sessions.id
      AND message_runs.branch_name = 'main'
  ),
  updated_at
)
WHERE backend_session_id IS NOT NULL;
