-- Main-session backend changes must pass through the runtime-config mutation
-- transaction, which supplies the connection-local authorization function.
CREATE TRIGGER IF NOT EXISTS sessions_backend_write_guard
BEFORE UPDATE OF backend ON sessions
WHEN NEW.backend IS NOT OLD.backend
  AND sm_runtime_config_backend_write_allowed() <> 1
BEGIN
  SELECT RAISE(ABORT, 'sessions.backend changes require applySessionRuntimeConfigMutations');
END;
