-- Usage reporting views (decisions.md D6 / plan §6 step 11 polish).
--
-- Raw token_usage rows always belong to the session that actually ran the
-- backend (a child for spawned work, a user session otherwise). Business
-- queries want two aggregation views:
--
--   * usage_by_parent: per-session totals, recursively folded up to the
--     root so "this session + everything it ever spawned" is one number.
--     Uses a recursive CTE to walk sessions.parent_id.
--   * usage_by_requester: per-requester totals for cross-session delegation
--     (`cross_session_log.kind='spawn'`), so the requester whose /spawn
--     triggered the work gets charged, not the target that hosted it.
--
-- Design constraint (decisions.md D6): no duplication of token rows at
-- write time; all aggregation flows through these views.

DROP VIEW IF EXISTS usage_by_parent;
CREATE VIEW usage_by_parent AS
WITH RECURSIVE ancestor(descendant_id, ancestor_id, depth) AS (
  -- Anchor: each session is its own ancestor at depth 0 (so a session gets
  -- credit for its own runs in the total).
  SELECT id, id, 0 FROM sessions
  UNION ALL
  -- Walk upward via parent_id. depth ceiling of 16 matches child-depth
  -- guardrail (3) with plenty of headroom — protects against cycles if
  -- someone ever manually corrupts the DB.
  SELECT a.descendant_id, s.parent_id, a.depth + 1
  FROM ancestor a
  JOIN sessions s ON s.id = a.ancestor_id
  WHERE s.parent_id IS NOT NULL AND a.depth < 16
)
SELECT
  a.ancestor_id                                AS session_id,
  SUM(u.input_tokens)                          AS input_tokens,
  SUM(u.output_tokens)                         AS output_tokens,
  SUM(u.cache_read_tokens)                     AS cache_read_tokens,
  SUM(u.cache_write_tokens)                    AS cache_write_tokens,
  SUM(u.reasoning_tokens)                      AS reasoning_tokens,
  COUNT(u.id)                                  AS run_count
FROM ancestor a
JOIN token_usage u ON u.session_id = a.descendant_id
GROUP BY a.ancestor_id;

DROP VIEW IF EXISTS usage_by_requester;
CREATE VIEW usage_by_requester AS
SELECT
  c.from_session_id                            AS requester_session_id,
  SUM(u.input_tokens)                          AS input_tokens,
  SUM(u.output_tokens)                         AS output_tokens,
  SUM(u.cache_read_tokens)                     AS cache_read_tokens,
  SUM(u.cache_write_tokens)                    AS cache_write_tokens,
  SUM(u.reasoning_tokens)                      AS reasoning_tokens,
  COUNT(u.id)                                  AS run_count
FROM cross_session_log c
JOIN token_usage u ON u.session_id = c.child_session_id
WHERE c.kind = 'spawn'
GROUP BY c.from_session_id;
