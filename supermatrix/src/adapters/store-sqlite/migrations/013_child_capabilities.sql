-- Child session capability columns (scenario-driven type system).
-- Planned in <HOME>/.claude/plans/2026-04-21-child-session-capabilities-d-virtual-trinket.md §6 step 1.
-- Flat columns hold values queried by policy dispatch; capability_payload holds
-- the variable-shape resultSinks / eventBusContract as JSON.

ALTER TABLE sessions ADD COLUMN child_type TEXT;
ALTER TABLE sessions ADD COLUMN trigger_kind TEXT;
ALTER TABLE sessions ADD COLUMN post_identity TEXT;
ALTER TABLE sessions ADD COLUMN caller_invocation TEXT;
ALTER TABLE sessions ADD COLUMN continuation_hook TEXT;
ALTER TABLE sessions ADD COLUMN capability_payload TEXT;

CREATE INDEX idx_sessions_child_type ON sessions(child_type);

-- One-shot backfill for pre-existing child rows. keepAlive was never persisted,
-- so we classify heuristically: a child currently in 'idle' is almost certainly
-- a /btw ephemeral (keepAlive=true path); anything else is treated as one-shot.
-- This is best-effort only; from step 2 onward every new child row carries an
-- explicit child_type from spawn time.
UPDATE sessions
SET child_type = 'ephemeral_conversation'
WHERE scope = 'child' AND status = 'idle' AND child_type IS NULL;

UPDATE sessions
SET child_type = 'one_shot_delegation'
WHERE scope = 'child' AND child_type IS NULL;
