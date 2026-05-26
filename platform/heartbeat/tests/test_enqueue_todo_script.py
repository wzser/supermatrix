import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
