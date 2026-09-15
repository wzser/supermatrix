import json
import os
import runpy
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.state import HeartbeatState


class EnqueueHeartbeatTodoScriptTest(unittest.TestCase):
    def create_sm_db(self, path: Path) -> None:
        with sqlite3.connect(path) as conn:
            conn.executescript(
                """
                CREATE TABLE sessions (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  scope TEXT NOT NULL,
                  backend TEXT,
                  model TEXT,
                  effort TEXT,
                  workdir TEXT,
                  status TEXT NOT NULL,
                  purpose TEXT,
                  heartbeat_enabled INTEGER NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE bindings (session_id TEXT NOT NULL, group_id TEXT);
                CREATE TABLE message_runs (
                  id TEXT, session_id TEXT, prompt TEXT, started_at TEXT,
                  finished_at TEXT, status TEXT, final_message TEXT, error_message TEXT
                );
                CREATE TABLE cross_session_log (
                  kind TEXT, from_session_id TEXT, to_session_id TEXT, prompt TEXT,
                  child_model TEXT, status TEXT, result_preview TEXT, error_message TEXT,
                  created_at TEXT, finished_at TEXT
                );
                """
            )
            conn.execute(
                """
                INSERT INTO sessions
                  (id, name, scope, backend, model, effort, workdir, status, purpose, heartbeat_enabled, updated_at)
                VALUES ('s1', 'alpha', 'user', 'codex', 'gpt-5.4-mini', 'medium', '/tmp/alpha', 'idle', 'alpha purpose', 1, '1')
                """
            )
            conn.execute(
                """
                INSERT INTO sessions
                  (id, name, scope, backend, model, effort, workdir, status, purpose, heartbeat_enabled, updated_at)
                VALUES ('s2', 'disabled-alpha', 'user', 'codex', 'gpt-5.4-mini', 'medium', '/tmp/disabled-alpha', 'idle', 'disabled purpose', 0, '1')
                """
            )
            conn.execute(
                """
                INSERT INTO sessions
                  (id, name, scope, backend, model, effort, workdir, status, purpose, heartbeat_enabled, updated_at)
                VALUES ('s3', 'heartbeat', 'user', 'codex', 'gpt-5.4-mini', 'medium', '/tmp/heartbeat', 'idle', 'heartbeat patrol', 0, '1')
                """
            )
            conn.execute("INSERT INTO bindings (session_id, group_id) VALUES ('s1', 'oc_alpha')")
            conn.execute("INSERT INTO bindings (session_id, group_id) VALUES ('s2', 'oc_disabled')")

    def test_script_enqueues_and_dedupes(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            cmd = [
                str(repo / "scripts" / "enqueue-heartbeat-todo"),
                "--session",
                "alpha",
                "--key",
                "alpha:todo-1",
                "--message",
                "请处理待办 1。",
                "--source",
                "test",
                "--source-session",
                "source-a",
                "--source-ref",
                "parent-1",
                "--todo-type",
                "research",
                "--expected-count",
                "2",
            ]
            first = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=10)
            second = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=10)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            first_payload = json.loads(first.stdout)
            second_payload = json.loads(second.stdout)
            self.assertEqual(first_payload["status"], "inserted")
            self.assertEqual(second_payload["status"], "duplicate")
            self.assertEqual(first_payload["batch_key"], second_payload["batch_key"])

    def test_script_rejects_unknown_session(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            completed = subprocess.run(
                [
                    str(repo / "scripts" / "enqueue-heartbeat-todo"),
                    "--session",
                    "missing",
                    "--key",
                    "missing:todo-1",
                    "--message",
                    "不会写入。",
                ],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )

        self.assertEqual(completed.returncode, 2)
        self.assertFalse(json.loads(completed.stdout)["ok"])

    def test_script_rejects_session_without_heartbeat_enabled(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            completed = subprocess.run(
                [
                    str(repo / "scripts" / "enqueue-heartbeat-todo"),
                    "--session",
                    "disabled-alpha",
                    "--key",
                    "disabled-alpha:todo-1",
                    "--message",
                    "不会写入。",
                ],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )

            self.assertEqual(completed.returncode, 3)
            payload = json.loads(completed.stdout)
            self.assertEqual(
                payload,
                {
                    "ok": False,
                    "status": "target_not_heartbeat_enabled",
                    "target_session": "disabled-alpha",
                },
            )
            with sqlite3.connect(hb_db) as conn:
                count = conn.execute("SELECT COUNT(*) FROM session_todos").fetchone()[0]
            self.assertEqual(count, 0)

    def test_self_spawn_closure_is_recorded_instead_of_rejected(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            state = HeartbeatState(hb_db)
            state.try_claim_spawn(
                logical_key="alpha:issue-1", target_session="alpha", child_model="gpt-5.4-mini"
            )
            state.mark_spawn_started(
                target_session="alpha",
                logical_key="alpha:issue-1",
                child_session_id="sess_child_1",
                spawn_comm_id="comm_abc_123",
            )
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            cmd = [
                str(repo / "scripts" / "enqueue-heartbeat-todo"),
                "--session",
                "heartbeat",
                "--key",
                "comm_abc_123",
                "--message",
                "这是你请求〔comm_abc_123〕的结果，框架兜底送回。child 结果正文。",
                "--source",
                "spawn-closure-watcher",
                "--source-session",
                "alpha",
                "--todo-type",
                "spawn_closure",
            ]
            first = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=10)
            second = subprocess.run(cmd, env=env, text=True, capture_output=True, timeout=10)

            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            first_payload = json.loads(first.stdout)
            second_payload = json.loads(second.stdout)
            self.assertTrue(first_payload["ok"])
            self.assertEqual(first_payload["status"], "recorded")
            self.assertTrue(first_payload["matched"])
            self.assertEqual(second_payload["status"], "duplicate")
            with sqlite3.connect(hb_db) as conn:
                spawn_row = conn.execute(
                    "SELECT status, final_summary FROM child_spawns WHERE spawn_comm_id = 'comm_abc_123'"
                ).fetchone()
                todo_count = conn.execute("SELECT COUNT(*) FROM session_todos").fetchone()[0]
                events = conn.execute(
                    """
                    SELECT status FROM heartbeat_events
                    WHERE event_type = 'self_spawn_closure_recorded'
                    """
                ).fetchall()
            self.assertEqual(spawn_row[0], "completed")
            self.assertIn("child 结果正文", spawn_row[1])
            self.assertEqual(todo_count, 0)
            self.assertEqual(events, [("completed",)])

    def test_self_spawn_closure_without_matching_child_is_still_accepted(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            completed = subprocess.run(
                [
                    str(repo / "scripts" / "enqueue-heartbeat-todo"),
                    "--session",
                    "heartbeat",
                    "--key",
                    "comm_resume_456",
                    "--message",
                    "composer child 的晚到结果。",
                    "--todo-type",
                    "spawn_closure",
                ],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["status"], "recorded")
            self.assertFalse(payload["matched"])
            with sqlite3.connect(hb_db) as conn:
                event = conn.execute(
                    "SELECT status FROM heartbeat_events WHERE event_type = 'self_spawn_closure_recorded'"
                ).fetchone()
            self.assertEqual(event[0], "unmatched")

    def test_self_non_closure_todo_is_still_rejected(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)
            env["HEARTBEAT_ENQUEUE_TRIGGER"] = "0"

            completed = subprocess.run(
                [
                    str(repo / "scripts" / "enqueue-heartbeat-todo"),
                    "--session",
                    "heartbeat",
                    "--key",
                    "heartbeat:misc-1",
                    "--message",
                    "不该注入给 heartbeat 的一般待办。",
                ],
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )

            self.assertEqual(completed.returncode, 3)
            self.assertFalse(json.loads(completed.stdout)["ok"])

    def test_enqueue_trigger_starts_todo_watch_and_logs_event(self):
        repo = Path(__file__).resolve().parents[1]
        module = runpy.run_path(str(repo / "scripts" / "enqueue-heartbeat-todo"))
        trigger_target_patrol = module["trigger_target_patrol"]
        with tempfile.TemporaryDirectory() as d:
            hb_db = Path(d) / "heartbeat.sqlite"
            state = HeartbeatState(hb_db)

            with patch.dict(os.environ, {"HEARTBEAT_ENQUEUE_TRIGGER_LOG_DIR": str(Path(d) / "logs")}, clear=False):
                with patch("subprocess.Popen") as popen:
                    popen.return_value.pid = 12345
                    result = trigger_target_patrol(
                        state=state,
                        target_session="alpha",
                        logical_key="alpha:todo-1",
                        todo_id="todo_1",
                    )

            self.assertEqual(result["status"], "started")
            self.assertEqual(result["mode"], "watch")
            self.assertEqual(result["pid"], 12345)
            command = popen.call_args.args[0]
            self.assertEqual(command[-2:], ["--session", "alpha"])
            self.assertTrue(command[1].endswith("heartbeat-todo-watch"), command)
            with sqlite3.connect(hb_db) as conn:
                row = conn.execute(
                    """
                    SELECT event_type, target_session, logical_key, status, trigger_source, trigger_cause
                    FROM heartbeat_events
                    WHERE event_type = 'todo_patrol_trigger_started'
                    """
                ).fetchone()
            self.assertEqual(
                row,
                (
                    "todo_patrol_trigger_started",
                    "alpha",
                    "alpha:todo-1",
                    "started",
                    "todo_pool",
                    "enqueue_trigger",
                ),
            )

    def test_enqueue_trigger_keeps_started_status_when_post_launch_audit_is_locked(self):
        repo = Path(__file__).resolve().parents[1]
        module = runpy.run_path(str(repo / "scripts" / "enqueue-heartbeat-todo"))
        trigger_target_patrol = module["trigger_target_patrol"]
        with tempfile.TemporaryDirectory() as d:
            state = HeartbeatState(Path(d) / "heartbeat.sqlite")
            with patch.dict(os.environ, {"HEARTBEAT_ENQUEUE_TRIGGER_LOG_DIR": str(Path(d) / "logs")}, clear=False):
                with patch("subprocess.Popen") as popen:
                    popen.return_value.pid = 12345
                    with patch.object(
                        state,
                        "log_event",
                        side_effect=sqlite3.OperationalError("database is locked"),
                    ):
                        result = trigger_target_patrol(
                            state=state,
                            target_session="alpha",
                            logical_key="alpha:todo-locked",
                            todo_id="todo_locked",
                        )

            self.assertEqual(result["status"], "started_audit_deferred")
            self.assertEqual(result["mode"], "watch")
            self.assertEqual(result["pid"], 12345)
            self.assertIn("database is locked", result["audit_error"])
            self.assertTrue(Path(result["log_path"]).is_file())

    def test_enqueue_trigger_falls_back_to_oneshot_patrol_when_watch_disabled(self):
        repo = Path(__file__).resolve().parents[1]
        module = runpy.run_path(str(repo / "scripts" / "enqueue-heartbeat-todo"))
        trigger_target_patrol = module["trigger_target_patrol"]
        with tempfile.TemporaryDirectory() as d:
            hb_db = Path(d) / "heartbeat.sqlite"
            state = HeartbeatState(hb_db)

            env_overrides = {
                "HEARTBEAT_ENQUEUE_TRIGGER_LOG_DIR": str(Path(d) / "logs"),
                "HEARTBEAT_TODO_WATCH_ENABLED": "0",
            }
            with patch.dict(os.environ, env_overrides, clear=False):
                with patch("subprocess.Popen") as popen:
                    popen.return_value.pid = 12345
                    result = trigger_target_patrol(
                        state=state,
                        target_session="alpha",
                        logical_key="alpha:todo-1",
                        todo_id="todo_1",
                    )

            self.assertEqual(result["status"], "started")
            self.assertEqual(result["mode"], "patrol")
            command = popen.call_args.args[0]
            self.assertTrue(command[1].endswith("heartbeat-patrol"), command)

    def test_enqueue_trigger_skips_when_heartbeat_is_paused(self):
        repo = Path(__file__).resolve().parents[1]
        module = runpy.run_path(str(repo / "scripts" / "enqueue-heartbeat-todo"))
        trigger_target_patrol = module["trigger_target_patrol"]
        with tempfile.TemporaryDirectory() as d:
            hb_db = Path(d) / "heartbeat.sqlite"
            state = HeartbeatState(hb_db)
            state.pause_session(session_name="alpha", minutes=60, reason="manual pause")

            with patch("subprocess.Popen") as popen:
                result = trigger_target_patrol(
                    state=state,
                    target_session="alpha",
                    logical_key="alpha:todo-1",
                    todo_id="todo_1",
                )

            self.assertEqual(result["status"], "skipped")
            self.assertEqual(result["reason"], "heartbeat_paused")
            popen.assert_not_called()
            with sqlite3.connect(hb_db) as conn:
                row = conn.execute(
                    """
                    SELECT event_type, target_session, logical_key, status, trigger_source, trigger_cause, summary
                    FROM heartbeat_events
                    WHERE event_type = 'todo_patrol_trigger_skipped_paused'
                    """
                ).fetchone()
            self.assertEqual(
                row[0:6],
                (
                    "todo_patrol_trigger_skipped_paused",
                    "alpha",
                    "alpha:todo-1",
                    "skipped",
                    "todo_pool",
                    "heartbeat_paused",
                ),
            )
            self.assertIn("manual pause", row[6])


if __name__ == "__main__":
    unittest.main()
