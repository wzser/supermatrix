import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from heartbeat_patrol.prefilter import (
    provider_limit_pause,
    provider_limit_pause_reason,
    should_check_with_model,
    trim_packet_to_candidate_window,
)


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

    def test_latest_failed_run_older_than_candidate_window_skips_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_old_timeout",
                        "status": "timeout",
                        "started_at": 0,
                        "finished_at": 1_000,
                        "error_message": "boot reconcile: backend process gone",
                    }
                ],
                "recent_cross_session": [],
            },
            now_ms=(25 * 60 * 60 * 1000) + 1_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
            candidate_max_age_minutes=24 * 60,
        )

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["no local candidate signal"])

    def test_old_failed_run_does_not_block_pending_todo(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_old_timeout",
                        "status": "timeout",
                        "started_at": 0,
                        "finished_at": 1_000,
                    }
                ],
                "recent_cross_session": [],
                "pending_todos": [
                    {
                        "logical_key": "spawn-closure:comm-1",
                        "todo_type": "spawn_closure",
                        "status": "pending",
                    }
                ],
            },
            now_ms=(25 * 60 * 60 * 1000) + 1_000,
            stale_running_minutes=90,
            child_sla_minutes=180,
            candidate_max_age_minutes=24 * 60,
        )

        self.assertTrue(should_check)
        self.assertEqual(reasons, ["pending session todo spawn_closure spawn-closure:comm-1"])

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

    def test_latest_user_cancelled_run_suppresses_model(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_cancelled",
                        "status": "cancelled",
                        "started_at": 950_000,
                        "final_message": "❌ cancelled by user",
                        "error_message": "cancelled by user",
                    },
                    {
                        "id": "mr_steps",
                        "status": "completed",
                        "started_at": 900_000,
                        "prompt": "请按 Step 1-8 完成这项长任务。",
                        "final_message": "已完成前 4 步。需要我继续吗？",
                    },
                ],
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

        self.assertFalse(should_check)
        self.assertEqual(reasons, ["latest run mr_cancelled cancelled by user"])

    def test_external_share_confirmation_gate_skips_continuation_checkpoint(self):
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_share",
                        "status": "completed",
                        "started_at": 900_000,
                        "prompt": "请按 Step 1-2 搭建文件外发能力。",
                        "final_message": "Step 1 已完成。是否继续发布对外分享下载链接？",
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
        started_at = int(datetime(2026, 5, 19, 2, 0).timestamp() * 1000)
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "started_at": started_at,
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
        started_at = int(datetime(2026, 5, 19, 2, 0).timestamp() * 1000)
        should_check, reasons = should_check_with_model(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_limited",
                        "status": "completed",
                        "started_at": started_at,
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

        self.assertIn("provider limit in latest run mr_limited", reason)
        self.assertIn("reset_at=", reason)

    def test_weekly_limit_date_time_requests_pause_until_absolute_reset(self):
        now_ms = int(datetime(2026, 7, 5, 18, 10).timestamp() * 1000)
        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_weekly",
                        "status": "failed",
                        "finished_at": now_ms - 1000,
                        "error_message": "You've hit your weekly limit · resets Jul 7 at 4pm (Asia/Shanghai)",
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "weekly")
        self.assertEqual(pause.scope, "backend_model")
        self.assertEqual(
            pause.reset_at.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M"),
            "2026-07-07 16:00",
        )

    def test_completed_report_quoting_provider_limit_does_not_request_pause(self):
        now_ms = int(datetime(2026, 8, 3, 16, 50, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)

        pause = provider_limit_pause(
            {
                "session": {"name": "cachem", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_report",
                        "status": "completed",
                        "finished_at": now_ms - 1_000,
                        "final_message": (
                            "诊断已经完成。独立请求当时返回 "
                            "`You've hit your weekly limit · resets Aug 4 at 4pm (Asia/Shanghai)`，"
                            "但当前主任务已经正常完成。"
                        ),
                        "error_message": "",
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNone(pause)

    def test_usage_limit_try_again_date_is_parsed_as_shared_absolute_reset(self):
        now_ms = int(datetime(2026, 8, 1, 9, 40, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)

        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_usage",
                        "status": "failed",
                        "finished_at": now_ms,
                        "error_message": (
                            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
                            "to purchase more credits or try again at Aug 5th, 2026 12:09 PM."
                        ),
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "usage")
        self.assertEqual(pause.scope, "backend_model")
        self.assertEqual(pause.reset_at, datetime(2026, 8, 5, 4, 9, tzinfo=timezone.utc))

    def test_named_model_limit_wording_is_shared_even_without_reset(self):
        now_ms = int(datetime(2026, 8, 3, 16, 50, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)

        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_fable",
                        "status": "failed",
                        "finished_at": now_ms,
                        "error_message": (
                            "You've reached your Fable 5 limit. "
                            "Run /usage-credits to continue or switch models with /model."
                        ),
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "model")
        self.assertEqual(pause.scope, "backend_model")
        self.assertIsNone(pause.reset_at)

    def test_quota_wording_with_will_reset_on_date_is_parsed(self):
        now_ms = int(datetime(2026, 8, 3, 16, 50, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)

        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_quota",
                        "status": "failed",
                        "finished_at": now_ms,
                        "error_message": (
                            "Your weekly quota has been exceeded. "
                            "It will reset on Aug 6th, 2026 at 9:30 PM (Asia/Shanghai)."
                        ),
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "weekly")
        self.assertEqual(
            pause.reset_at.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M"),
            "2026-08-06 21:30",
        )

    def test_unrelated_lark_http_429_is_not_a_provider_limit(self):
        now_ms = int(datetime(2026, 8, 3, 16, 50, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000)

        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_lark_429",
                        "status": "failed",
                        "finished_at": now_ms,
                        "error_message": (
                            "lark-cli im +messages-send failed: SDK returned an invalid JSON response: "
                            "failed to parse TAT response (HTTP 429)"
                        ),
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNone(pause)

    def test_session_limit_time_only_uses_run_time_to_pick_next_reset_day(self):
        run_finished_ms = int(datetime(2026, 7, 4, 23, 30).timestamp() * 1000)
        now_ms = int(datetime(2026, 7, 4, 23, 40).timestamp() * 1000)
        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_session",
                        "status": "failed",
                        "finished_at": run_finished_ms,
                        "error_message": "You've hit your session limit · resets 2am (Asia/Shanghai)",
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "session")
        self.assertEqual(
            pause.reset_at.astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M"),
            "2026-07-05 02:00",
        )

    def test_malformed_reset_text_falls_back_to_short_provider_pause(self):
        now_ms = int(datetime(2026, 7, 5, 18, 10).timestamp() * 1000)
        pause = provider_limit_pause(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_malformed",
                        "status": "failed",
                        "finished_at": now_ms - 1000,
                        "error_message": "You've hit your weekly limit · resets 99pm (Asia/Shanghai)",
                    }
                ],
            },
            now_ms=now_ms,
        )

        self.assertIsNotNone(pause)
        self.assertEqual(pause.limit_kind, "weekly")
        self.assertIsNone(pause.reset_at)

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

        self.assertIn("provider limit in latest run mr_limited", reason)

    def test_old_provider_limit_does_not_request_auto_pause(self):
        reason = provider_limit_pause_reason(
            {
                "session": {"name": "alpha", "status": "idle"},
                "recent_runs": [
                    {
                        "id": "mr_old_limited",
                        "status": "failed",
                        "started_at": 0,
                        "finished_at": 1_000,
                        "error_message": "API Error: Server is temporarily limiting requests · Rate limited",
                    }
                ],
            },
            now_ms=(25 * 60 * 60 * 1000) + 1_000,
            candidate_max_age_minutes=24 * 60,
        )

        self.assertIsNone(reason)

    def test_trim_packet_to_candidate_window_removes_old_activity_but_keeps_recent(self):
        packet = {
            "session": {"name": "alpha", "status": "idle"},
            "recent_runs": [
                {"id": "mr_recent", "status": "failed", "finished_at": 86_401_000},
                {"id": "mr_old", "status": "failed", "finished_at": 1_000},
            ],
            "recent_cross_session": [
                {"status": "pending", "created_at": 86_401_000},
                {"status": "pending", "created_at": 1_000},
            ],
            "pending_todos": [{"logical_key": "todo-1"}],
        }

        trimmed = trim_packet_to_candidate_window(
            packet,
            now_ms=(25 * 60 * 60 * 1000) + 1_000,
            candidate_max_age_minutes=24 * 60,
        )

        self.assertEqual([run["id"] for run in trimmed["recent_runs"]], ["mr_recent"])
        self.assertEqual([item["created_at"] for item in trimmed["recent_cross_session"]], [86_401_000])
        self.assertEqual(trimmed["pending_todos"], [{"logical_key": "todo-1"}])


if __name__ == "__main__":
    unittest.main()
