UPDATE sessions
SET heartbeat_enabled = 1
WHERE status != 'deleted'
  AND scope != 'child'
  AND name != 'heartbeat';
