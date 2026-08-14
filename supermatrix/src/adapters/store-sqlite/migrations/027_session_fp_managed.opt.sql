-- FP-governance scope flag. Authority is the Feishu Bitable 'FP管辖' checkbox
-- column, pulled into this DB by first-principle/scripts/sync-session-table.sh.
-- nullable, default NULL:
--   NULL = unmarked — treated as in-scope (conservative default so the roster
--          does not empty out before FP backfills the column)
--   0    = explicitly out of FP governance scope
--   1    = explicitly in scope
-- Optional migration: a missing column degrades gracefully — rowToSession reads
-- it as null and renderOtherSessionsBlock keeps the session in the roster.
ALTER TABLE sessions ADD COLUMN fp_managed INTEGER;
