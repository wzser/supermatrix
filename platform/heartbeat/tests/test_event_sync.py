import unittest
from unittest.mock import patch

from heartbeat_patrol.event_sync import build_bitable_rows, render_events_markdown, sync_events_to_feishu


class FakeSyncState:
    def __init__(self, events):
        self.events = events
        self.list_calls = []
        self.marked = []

    def list_unsynced_events(self, *, limit, exclude_noop=False, include_event_types=None):
        self.list_calls.append(
            {"limit": limit, "exclude_noop": exclude_noop, "include_event_types": include_event_types}
        )
        return self.events

    def mark_events_synced(self, event_ids, *, sync_ref):
        self.marked.append({"event_ids": event_ids, "sync_ref": sync_ref})


class EventSyncTest(unittest.TestCase):
    def test_render_events_markdown_includes_authority_and_rows(self):
        markdown = render_events_markdown(
            [
                {
                    "event_id": "hev_1",
                    "created_at": "2026-05-08T00:00:00+00:00",
                    "event_type": "spawn_started",
                    "target_session": "scheduler",
                    "logical_key": "scheduler:issue",
                    "decision": "spawn_collect",
                    "child_session_id": "sess_child_123",
                    "child_model": "gpt-5.4-mini",
                    "status": "running",
                    "summary": "needs follow-up",
                    "error": "",
                }
            ],
            generated_at="2026-05-08T00:01:00+00:00",
            local_db_path="/tmp/heartbeat.sqlite",
        )

        self.assertIn("Local authority: `/tmp/heartbeat.sqlite`", markdown)
        self.assertIn("| 2026-05-08T00:00:00+00:00 | spawn_started | running | scheduler |", markdown)
        self.assertIn("sess_child_123", markdown)

    def test_build_bitable_rows_preserves_local_statuses_and_timestamp(self):
        rows = build_bitable_rows(
            [
                {
                    "event_id": "hev_1",
                    "created_at": "2026-05-08T00:00:00+00:00",
                    "patrol_id": "patrol-1",
                    "event_type": "spawn_started",
                    "target_session": "scheduler",
                    "logical_key": "scheduler:issue",
                    "decision": "spawn_collect",
                    "child_session_id": "sess_child_123",
                    "child_model": "gpt-5.4-mini",
                    "status": "running",
                    "summary": "needs follow-up",
                    "error": "",
                    "source": "heartbeat",
                },
                {
                    "event_id": "hev_2",
                    "created_at": "2026-05-08T00:01:00+00:00",
                    "patrol_id": None,
                    "event_type": "session_prefilter_skip",
                    "status": "skipped",
                },
            ]
        )

        self.assertEqual(rows[0][0], "patrol-1")
        self.assertEqual(rows[0][1], 1778198400000)
        self.assertEqual(rows[0][8], "running")
        self.assertEqual(rows[1][0], "hev_2")
        self.assertEqual(rows[1][8], "skipped")

    def test_todo_enqueued_is_not_synced_as_success(self):
        rows = build_bitable_rows(
            [
                {
                    "event_id": "hev_todo_1",
                    "created_at": "2026-05-19T00:00:00+00:00",
                    "event_type": "todo_enqueued",
                    "target_session": "alpha",
                    "logical_key": "alpha:todo-1",
                    "status": "pending",
                    "summary": "queued",
                },
                {
                    "event_id": "hev_todo_2",
                    "created_at": "2026-05-19T00:01:00+00:00",
                    "event_type": "todo_injected",
                    "target_session": "alpha",
                    "logical_key": "alpha:todo-1",
                    "status": "sent",
                    "summary": "injected",
                },
            ]
        )

        self.assertEqual(rows[0][8], "pending")
        self.assertEqual(rows[1][8], "sent")

    def test_sync_events_to_feishu_requests_human_facing_events_only(self):
        state = FakeSyncState(
            [
                {
                    "event_id": "hev_1",
                    "created_at": "2026-05-08T00:00:00+00:00",
                    "event_type": "spawn_started",
                    "status": "running",
                }
            ]
        )

        with patch("heartbeat_patrol.event_sync.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stderr = ""
            run.return_value.stdout = ""
            result = sync_events_to_feishu(
                state=state,
                base_token="base",
                table_id="table",
                lark_cli="lark-cli",
                identity="user",
                limit=5,
            )

        self.assertEqual(
            state.list_calls,
            [
                {
                    "limit": 5,
                    "exclude_noop": False,
                    "include_event_types": (
                        "spawn_started",
                        "alert_sent",
                        "user_resume_sent",
                        "todo_enqueued",
                        "todo_injected",
                        "todo_injection_failed",
                        "heartbeat_paused",
                        "heartbeat_resumed",
                        "heartbeat_pause_expired",
                    ),
                }
            ],
        )
        self.assertEqual(state.marked[0]["event_ids"], ["hev_1"])
        self.assertEqual(result["synced"], 1)


if __name__ == "__main__":
    unittest.main()
