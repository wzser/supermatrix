import os
import unittest
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.config import load_config


class ConfigTest(unittest.TestCase):
    def test_defaults_use_spawn_with_portable_runtime_paths(self):
        with patch.dict(os.environ, {"SM_RUNTIME_ROOT": "/tmp/heartbeat-fixture"}, clear=True):
            cfg = load_config()

        self.assertEqual(cfg.controller_provider, "spawn")
        self.assertEqual(cfg.controller_model, "gpt-5.4-mini")
        self.assertEqual(cfg.todomaster_session, "")
        self.assertEqual(cfg.sm_db_path, Path("/tmp/heartbeat-fixture/data/supermatrix.db"))
        self.assertEqual(cfg.state_db_path, Path("/tmp/heartbeat-fixture/heartbeat/heartbeat.sqlite"))
        self.assertNotEqual(cfg.sm_db_path.resolve(), cfg.state_db_path.resolve())
        self.assertEqual(cfg.max_sessions_per_patrol, 0)
        self.assertEqual(cfg.max_controller_concurrency, 0)
        self.assertEqual(cfg.max_escalation_concurrency, 3)
        self.assertTrue(cfg.model_prefilter_enabled)

    def test_todo_watch_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            cfg = load_config()

        self.assertTrue(cfg.todo_watch_enabled)
        self.assertEqual(cfg.todo_watch_poll_seconds, 5.0)
        self.assertEqual(cfg.todo_watch_idle_debounce_seconds, 8.0)
        self.assertEqual(cfg.todo_watch_max_minutes, 45.0)

    def test_action_failure_backoff_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            cfg = load_config()

        self.assertEqual(cfg.action_failure_threshold, 3)
        self.assertEqual(cfg.action_cooldown_minutes, 360)

    def test_unrecovered_escalation_defaults(self):
        with patch.dict(os.environ, {}, clear=True):
            cfg = load_config()

        self.assertEqual(cfg.unrecovered_escalation_threshold, 3)
        self.assertEqual(cfg.unrecovered_window_minutes, 360)
        self.assertEqual(cfg.unrecovered_reescalate_minutes, 720)
        self.assertEqual(cfg.unrecovered_max_unreconciled_hours, 24)

    def test_todo_watch_can_be_disabled(self):
        with patch.dict(os.environ, {"HEARTBEAT_TODO_WATCH_ENABLED": "0"}, clear=True):
            cfg = load_config()

        self.assertFalse(cfg.todo_watch_enabled)


if __name__ == "__main__":
    unittest.main()
