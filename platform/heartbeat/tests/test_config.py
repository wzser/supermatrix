import os
import unittest
from unittest.mock import patch

from heartbeat_patrol.config import load_config


class ConfigTest(unittest.TestCase):
    def test_defaults_use_minimax_full_batch_and_full_concurrency(self):
        with patch.dict(os.environ, {}, clear=True):
            cfg = load_config()

        self.assertEqual(cfg.controller_provider, "minimax")
        self.assertEqual(cfg.controller_model, "MiniMax-M2.7")
        self.assertEqual(cfg.max_sessions_per_patrol, 0)
        self.assertEqual(cfg.max_controller_concurrency, 0)
        self.assertEqual(cfg.max_escalation_concurrency, 3)
        self.assertTrue(cfg.model_prefilter_enabled)


if __name__ == "__main__":
    unittest.main()
