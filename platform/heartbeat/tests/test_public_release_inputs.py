import os
import unittest
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.api import ApiError, HeartbeatApi
from heartbeat_patrol.config import load_config


ROOT = Path(__file__).resolve().parents[1]


class PublicReleaseInputsTest(unittest.TestCase):
    def test_public_inputs_have_no_machine_or_remote_resource_identity(self):
        paths = [ROOT / "config" / "heartbeat.env.example", ROOT / "docs" / "heartbeat-function-overview.md"]
        public_text = "\n".join(path.read_text() for path in paths)
        self.assertNotRegex(public_text, r"/(?:Users|Volumes)/")
        self.assertNotRegex(public_text, r"\b(?:oc_|tbl|fld)[A-Za-z0-9]+")
        self.assertNotIn("/api/spawn\n", public_text)

    def test_default_config_is_portable_and_shared_todo_is_opt_in(self):
        with patch.dict(os.environ, {"SM_RUNTIME_ROOT": "/tmp/heartbeat-fixture"}, clear=True):
            cfg = load_config()

        self.assertEqual(cfg.controller_provider, "spawn")
        self.assertEqual(cfg.todomaster_session, "")
        self.assertEqual(cfg.sm_db_path, Path("/tmp/heartbeat-fixture/data/supermatrix.db"))
        self.assertEqual(cfg.state_db_path, Path("/tmp/heartbeat-fixture/heartbeat/heartbeat.sqlite"))

    def test_missing_todomaster_cannot_report_a_queued_handoff(self):
        api = HeartbeatApi(api_base="http://127.0.0.1:1", lark_cli="lark-cli", heartbeat_session="heartbeat")
        with self.assertRaisesRegex(ApiError, "not configured"):
            api.register_agent_todo(issue_key="heartbeat:example", body="owner action")

    def test_missing_dedupe_inputs_fail_closed_without_remote_defaults(self):
        api = HeartbeatApi(api_base="http://127.0.0.1:1", lark_cli="lark-cli", heartbeat_session="heartbeat")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ApiError, "configuration is incomplete"):
                api.find_registered_todo_problem_types(problem_types={"heartbeat:example"})

    def test_public_allowlist_ships_runtime_metadata_and_excludes_legacy_r26(self):
        document = (ROOT / "docs" / "heartbeat-function-overview.md").read_text()
        allowlist = document.split("## 8. Public package allowlist", 1)[1].split("```text", 1)[1].split(
            "```", 1
        )[0].splitlines()

        self.assertIn(".python-version", allowlist)
        self.assertIn("pyproject.toml", allowlist)
        self.assertIn("tests/test_public_release_inputs.py", allowlist)
        self.assertNotIn("scripts/r26-history-apply", allowlist)
        self.assertNotIn("tests/test_r26_history_apply.py", allowlist)
        self.assertIn("legacy `scripts/r26-history-apply`", document)


if __name__ == "__main__":
    unittest.main()
