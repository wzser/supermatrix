CREATE INDEX IF NOT EXISTS idx_spawn_async_items_courier_status
  ON spawn_async_items(status, updated_at)
  WHERE status IN ('waiting_child', 'delivering');
