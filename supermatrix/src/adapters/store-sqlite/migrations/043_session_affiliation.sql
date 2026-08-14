-- Governance ownership mirrored from Feishu Session.附属于.
-- Keep distinct from parent_id, which is runtime child-session lifecycle state.
ALTER TABLE sessions ADD COLUMN affiliated_to TEXT;
