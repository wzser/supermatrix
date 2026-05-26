import unittest
from datetime import datetime

from heartbeat_patrol.prefilter import provider_limit_pause_reason, should_check_with_model


class PrefilterTest(unittest.TestCase):
    def test_empty_packet_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_pending_session_todo_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [],
                "recent_cross_session": [],
                "pending_todos": [
                    {
                        "logical_key": "spawn-closure:comm-1",
                        "todo_type": "spawn_closure",
                        "status": "pending",
                    }
                ],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("pending session todo spawn_closure spawn-closure:comm-1", reasons)

    def test_stale_running_run_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [{"id": "mr_1", "status": "running", "started_at": 0}],
                "recent_cross_session": [],
            },
            now_ms=10_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("stale running run mr_1", reasons)

    def test_non_stale_running_session_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "running"},
                "recent_runs": [{"id": "mr_active", "status": "running", "started_at": 900_000}],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_stale_cross_session_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [],
                "recent_cross_session": [
                    {"kind": "spawn", "status": "pending", "created_at": 0, "child_model": "gpt-5.4-mini"}
                ],
            },
            now_ms=20_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("stale cross-session pending", reasons)

    def test_stale_cross_session_behind_newer_completed_run_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_newer",
                        "status": "completed",
                        "started_at": 20_000_000,
                        "finished_at": 21_000_000,
                    }
                ],
                "recent_cross_session": [
                    {
                        "kind": "spawn",
                        "status": "pending",
                        "created_at": 0,
                        "child_model": "gpt-5.4-mini",
                    }
                ],
            },
            now_ms=30_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_historical_failed_run_behind_newer_completed_run_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {"id": "mr_new", "status": "completed", "started_at": 900_000},
                    {"id": "mr_old", "status": "failed", "started_at": 0},
                ],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_latest_failed_run_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {"id": "mr_failed", "status": "failed", "started_at": 900_000},
                    {"id": "mr_old", "status": "completed", "started_at": 0},
                ],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("latest run mr_failed status failed", reasons)

    def test_completed_run_asking_to_continue_remaining_steps_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_steps",
                        "status": "completed",
                        "started_at": 900_000,
                        "final_message": "Step 1-4 已完成。是否继续完成 Step 5、6、7、8？",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("continuation checkpoint in latest run mr_steps", reasons)

    def test_completed_run_asking_generic_continue_with_step_plan_prompt_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_prompt_steps",
                        "status": "completed",
                        "started_at": 900_000,
                        "prompt": "请按 Step 1-8 完成这项长任务。",
                        "final_message": "已完成前 4 步。需要我继续吗？",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("continuation checkpoint in latest run mr_prompt_steps", reasons)

    def test_completed_run_with_generic_continue_question_without_step_plan_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_generic",
                        "status": "completed",
                        "started_at": 900_000,
                        "prompt": "帮我检查一下这个问题。",
                        "final_message": "初步检查完成。需要我继续吗？",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=1_000_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_completed_run_with_provider_limit_after_reset_requires_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "started_at": 900_000,
                        "final_message": "You've hit your limit · resets 2:50am (Asia/Shanghai)",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=int(datetime(2026, 5, 19, 3, 0).timestamp() * 1000),
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertTrue(should_check)
        self.assertIn("provider limit checkpoint in latest run mr_limited", reasons)

    def test_completed_run_with_provider_limit_before_reset_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "started_at": 900_000,
                        "final_message": "You've hit your limit · resets 2:50am (Asia/Shanghai)",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=int(datetime(2026, 5, 19, 2, 30).timestamp() * 1000),
            stale_running_minutes=90,
            child_sla_minutes=180,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_provider_limit_before_reset_requests_auto_pause(self):
        reason = provider_limit_pause_reason(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "final_message": "You've hit your limit · resets 2:50am (Asia/Shanghai)",
                    }
                ],
            },
            now_ms=int(datetime(2026, 5, 19, 2, 30).timestamp() * 1000),
        )

        self.assertEqual(reason, "provider limit in latest run mr_limited")

    def test_provider_limit_after_reset_does_not_request_auto_pause(self):
        reason = provider_limit_pause_reason(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "final_message": "You've hit your limit · resets 2:50am (Asia/Shanghai)",
                    }
                ],
            },
            now_ms=int(datetime(2026, 5, 19, 3, 0).timestamp() * 1000),
        )

        self.assertIsNone(reason)

    def test_provider_limit_without_reset_requests_auto_pause(self):
        reason = provider_limit_pause_reason(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "failed",
                        "error_message": "API Error: Server is temporarily limiting requests · Rate limited",
                    }
                ],
            },
            now_ms=int(datetime(2026, 5, 19, 3, 0).timestamp() * 1000),
        )

        self.assertEqual(reason, "provider limit in latest run mr_limited")


if __name__ == "__main__":
    unittest.main()
