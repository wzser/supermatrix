import json
import os
import subprocess
import tempfile
from pathlib import Path
import unittest

from heartbeat_patrol.event_sync import (
    build_bitable_rows,
    build_todo_aggregate_bitable_row,
    build_todo_bitable_row,
    render_events_markdown,
    sync_events_to_feishu,
    sync_todo_aggregates_to_feishu,
    sync_todos_to_feishu,
)


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


class FakeTodoSyncState:
    def __init__(self, todos):
        self.todos = todos
        self.list_calls = []
        self.marked = []
        self.refs = []

    def list_unsynced_todos(self, *, limit):
        self.list_calls.append({"limit": limit})
        return self.todos

    def mark_todo_feishu_ref(self, *, todo_id, sync_ref):
        self.refs.append({"todo_id": todo_id, "sync_ref": sync_ref})

    def mark_todos_synced(self, todo_ids, *, sync_ref):
        self.marked.append({"todo_ids": todo_ids, "sync_ref": sync_ref})


class FakeTodoAggregateSyncState:
    def __init__(self, aggregates):
        self.aggregates = aggregates
        self.list_calls = []
        self.marked = []
        self.refs = []

    def list_unsynced_todo_aggregates(self, *, limit):
        self.list_calls.append({"limit": limit})
        return self.aggregates

    def mark_todo_aggregate_feishu_ref(self, *, aggregate_key, sync_ref):
        self.refs.append({"aggregate_key": aggregate_key, "sync_ref": sync_ref})

    def mark_todo_aggregates_synced(self, aggregates, *, sync_ref):
        self.marked.append({"aggregates": aggregates, "sync_ref": sync_ref})


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
        self.assertEqual(rows[0][8], "scheduler")
        self.assertEqual(rows[0][11], "running")
        self.assertEqual(rows[1][0], "hev_2")
        self.assertEqual(rows[1][11], "skipped")

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

        self.assertEqual(rows[0][11], "pending")
        self.assertEqual(rows[1][11], "sent")

    def test_build_bitable_rows_includes_trigger_metadata_and_injected_message(self):
        rows = build_bitable_rows(
            [
                {
                    "event_id": "hev_1",
                    "created_at": "2026-05-19T00:00:00+00:00",
                    "event_type": "todo_injected",
                    "target_session": "alpha",
                    "logical_key": "alpha:todo-1",
                    "trigger_source": "todo_pool",
                    "trigger_cause": "spawn_closure",
                    "trigger_location": "alpha",
                    "status": "sent",
                    "injected_message": "继续处理这条结果。",
                }
            ]
        )

        self.assertEqual(rows[0][6:9], ["todo_pool", "spawn_closure", "alpha"])
        self.assertEqual(rows[0][12], "继续处理这条结果。")

    def test_build_todo_bitable_row_uses_local_status_and_injected_detail(self):
        row = build_todo_bitable_row(
            {
                "todo_id": "todo_1",
                "created_at": "2026-05-19T00:00:00+00:00",
                "target_session": "alpha",
                "logical_key": "alpha:todo-1",
                "batch_key": "batch-1",
                "source_session": "supermatrix-root",
                "source_ref": "comm_1",
                "todo_type": "spawn_closure",
                "status": "injected",
                "message": "raw child result",
                "claimed_at": "2026-05-19T00:01:00+00:00",
                "injected_at": "2026-05-19T00:02:00+00:00",
                "finished_at": "2026-05-19T00:02:00+00:00",
                "source": "spawn_closure",
                "detail": "structured injected message",
            }
        )

        self.assertEqual(row["todo_id"], "todo_1")
        self.assertEqual(row["status"], "injected")
        self.assertEqual(row["injected_message"], "structured injected message")
        self.assertEqual(row["created_at"], 1779148800000)

    def test_build_todo_bitable_row_leaves_missing_datetimes_blank(self):
        row = build_todo_bitable_row(
            {
                "todo_id": "todo_1",
                "created_at": "2026-05-19T00:00:00+00:00",
                "status": "failed",
                "message": "raw",
            }
        )

        self.assertIsNone(row["claimed_at"])
        self.assertIsNone(row["injected_at"])
        self.assertIsNone(row["finished_at"])

    def test_build_todo_aggregate_bitable_row_answers_recorded_and_triggered(self):
        row = build_todo_aggregate_bitable_row(
            {
                "aggregate_key": "comm_1",
                "source_ref": "comm_1",
                "target_sessions": "alpha",
                "item_count": 2,
                "statuses": "failed,injected",
                "final_status": "injected",
                "recorded_in_pool": "yes",
                "triggered": "yes",
                "triggered_count": 1,
                "failed_count": 1,
                "first_created_at": "2026-05-19T00:00:00+00:00",
                "last_injected_at": "2026-05-19T00:02:00+00:00",
                "latest_injected_message": "已注入内容",
            }
        )

        self.assertEqual(row["aggregate_key"], "comm_1")
        self.assertEqual(row["recorded_in_pool"], "yes")
        self.assertEqual(row["triggered"], "yes")
        self.assertEqual(row["final_status"], "injected")
        self.assertEqual(row["last_injected_at"], 1779148920000)

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

        result = sync_events_to_feishu(
            state=state,
            base_token="base",
            table_id="table",
            lark_cli="lark-cli",
            identity="user",
            limit=5,
        )

        self.assertEqual(state.list_calls, [])
        self.assertEqual(state.marked, [])
        self.assertEqual(
            result,
            {
                "synced": 0,
                "asset_id": "heartbeat.runtime.events",
                "base_token": "base",
                "table_id": "table",
                "status": "disabled",
                "reason": "sync_direction=none; local SQLite is authoritative",
                "mode": "none",
                "bounded_limit": 100,
            },
        )

    def test_sync_todos_to_feishu_upserts_and_marks_local_rows(self):
        state = FakeTodoSyncState(
            [
                {
                    "todo_id": "todo_1",
                    "created_at": "2026-05-19T00:00:00+00:00",
                    "target_session": "alpha",
                    "logical_key": "alpha:todo-1",
                    "status": "injected",
                    "message": "raw",
                    "detail": "injected",
                }
            ]
        )

        result = sync_todos_to_feishu(
            state=state,
            base_token="base",
            table_id="todo_table",
            lark_cli="lark-cli",
            identity="user",
            limit=5,
        )

        self.assertEqual(state.list_calls, [])
        self.assertEqual(state.refs, [])
        self.assertEqual(state.marked, [])
        self.assertEqual(result["asset_id"], "heartbeat.runtime.todo_pool")
        self.assertEqual(result["status"], "disabled")
        self.assertEqual(result["mode"], "none")

    def test_sync_todo_aggregates_to_feishu_upserts_by_aggregate_key(self):
        aggregate = {
            "aggregate_key": "comm_1",
            "row_hash": "hash1",
            "source_ref": "comm_1",
            "final_status": "injected",
            "recorded_in_pool": "yes",
            "triggered": "yes",
        }
        state = FakeTodoAggregateSyncState([aggregate])

        result = sync_todo_aggregates_to_feishu(
            state=state,
            base_token="base",
            table_id="agg_table",
            lark_cli="lark-cli",
            identity="user",
            limit=5,
        )

        self.assertEqual(state.list_calls, [])
        self.assertEqual(state.refs, [])
        self.assertEqual(state.marked, [])
        self.assertEqual(result["asset_id"], "heartbeat.runtime.todo_aggregate")
        self.assertEqual(result["status"], "disabled")
        self.assertEqual(result["mode"], "none")


class SyncHeartbeatEventsScriptTest(unittest.TestCase):
    def test_script_returns_disabled_receipts_without_feishu_config(self):
        repo_root = Path(__file__).resolve().parents[1]
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = os.environ.copy()
        for key in (
            "HEARTBEAT_LOG_FEISHU_BASE_TOKEN",
            "HEARTBEAT_TRIGGER_FEISHU_TABLE_ID",
            "HEARTBEAT_LOG_FEISHU_TABLE_ID",
            "HEARTBEAT_TODO_FEISHU_TABLE_ID",
            "HEARTBEAT_TODO_AGG_FEISHU_TABLE_ID",
        ):
            env.pop(key, None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["HEARTBEAT_STATE_DB"] = str(Path(tmp.name) / "heartbeat.sqlite")

        completed = subprocess.run(
            [str(repo_root / "scripts" / "sync-heartbeat-events")],
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["events"]["asset_id"], "heartbeat.runtime.events")
        self.assertEqual(payload["todos"]["asset_id"], "heartbeat.runtime.todo_pool")
        self.assertEqual(payload["todo_aggregates"]["asset_id"], "heartbeat.runtime.todo_aggregate")
        self.assertEqual(payload["events"]["status"], "disabled")
        self.assertEqual(payload["todos"]["status"], "disabled")
        self.assertEqual(payload["todo_aggregates"]["status"], "disabled")


if __name__ == "__main__":
    unittest.main()
