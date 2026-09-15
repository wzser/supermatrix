import sqlite3
import tempfile
import unittest
from pathlib import Path

from heartbeat_patrol.sm_reader import SuperMatrixReader


class SessionRunLandedSinceTest(unittest.TestCase):
    def _build_db(self, db_path: Path) -> None:
        long_prefix = "x" * 4000
        with sqlite3.connect(db_path) as conn:
            conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)")
            # message_runs.started_at is stored as epoch milliseconds in production.
            conn.execute(
                """
                CREATE TABLE message_runs (
                  id TEXT PRIMARY KEY,
                  session_id TEXT,
                  prompt TEXT,
                  started_at INTEGER,
                  status TEXT,
                  origin TEXT
                )
                """
            )
            conn.execute("INSERT INTO sessions VALUES ('s1', 'alpha')")
            conn.execute("INSERT INTO sessions VALUES ('s2', 'beta')")
            conn.executemany(
                "INSERT INTO message_runs VALUES (?, 's1', ?, ?, 'completed', ?)",
                [
                    ("human", "请处理待办 1。", 4000, "lark_user"),
                    ("unrelated", "无关的自动消息", 5000, "framework_synthetic"),
                    ("command", "Δ/next 请处理待办 1。", 6000, "lark_user_synthetic"),
                    ("legacy", "Δ请处理旧待办。", 7000, "lark_user_synthetic"),
                    ("drained", "请处理待办 1。\n附加内容", 8000, "framework_synthetic"),
                    ("shared-prefix", "相同前缀-实际待办", 9000, "framework_synthetic"),
                    ("long-prefix", f"{long_prefix}A", 10000, "framework_synthetic"),
                ],
            )

    def test_landing_requires_matching_synthetic_run_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self._build_db(db_path)
            reader = SuperMatrixReader(db_path)

            self.assertTrue(
                reader.session_todo_run_landed_since("alpha", 0, "请处理待办 1。\n附加内容")
            )
            self.assertTrue(
                reader.session_todo_run_landed_since("alpha", 0, "请处理旧待办。")
            )
            # Human runs, unrelated synthetic runs, and the /next command admission
            # itself are not proof that the queued todo was consumed.
            self.assertFalse(
                reader.session_todo_run_landed_since("alpha", 8100, "请处理待办 1。")
            )
            self.assertFalse(
                reader.session_todo_run_landed_since("alpha", 0, "不存在的待办")
            )
            self.assertFalse(
                reader.session_todo_run_landed_since("alpha", 0, "请处理待办 1。")
            )
            self.assertFalse(
                reader.session_todo_run_landed_since("alpha", 0, "相同前缀-")
            )
            long_prefix = "x" * 4000
            self.assertFalse(
                reader.session_todo_run_landed_since("alpha", 0, long_prefix)
            )
            self.assertTrue(
                reader.session_todo_run_landed_since("alpha", 0, f"{long_prefix}A")
            )
            self.assertFalse(
                reader.session_todo_run_landed_since("beta", 0, "请处理待办 1。")
            )
            self.assertFalse(reader.session_todo_run_landed_since("ghost", 0, "x"))
            self.assertFalse(reader.session_todo_run_landed_since("", 0, "x"))
            self.assertFalse(reader.session_todo_run_landed_since("alpha", 0, ""))


class CompletedHeartbeatChildResultTest(unittest.TestCase):
    def _build_db(self, db_path: Path) -> None:
        with sqlite3.connect(db_path) as conn:
            conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)")
            conn.execute(
                """
                CREATE TABLE cross_session_log (
                  id TEXT PRIMARY KEY,
                  from_session_id TEXT NOT NULL,
                  to_session_id TEXT NOT NULL,
                  prompt TEXT,
                  status TEXT NOT NULL,
                  result_preview TEXT,
                  final_message TEXT,
                  created_at INTEGER NOT NULL,
                  finished_at INTEGER
                )
                """
            )
            conn.executemany(
                "INSERT INTO sessions VALUES (?, ?)",
                [("heartbeat-id", "heartbeat"), ("deep-id", "deepautosearch")],
            )
            conn.executemany(
                """
                INSERT INTO cross_session_log (
                  id, from_session_id, to_session_id, prompt, status, result_preview,
                  final_message, created_at, finished_at
                ) VALUES (?, 'heartbeat-id', 'deep-id', ?, 'completed', ?, ?, ?, ?)
                """,
                [
                    (
                        "comm_exact",
                        "交付规则：直接在本回复给结果，勿另行回调。\n\n"
                        "Heartbeat follow-up for `deepautosearch:retry-1`.\nReason: timeout",
                        "",
                        "materialized result",
                        100,
                        500,
                    ),
                    (
                        "comm_wrong_key",
                        "Heartbeat follow-up for `deepautosearch:retry-2`.\nReason: timeout",
                        "",
                        "other result",
                        100,
                        500,
                    ),
                    (
                        "comm_empty_result",
                        "Heartbeat follow-up for `deepautosearch:retry-empty`.\nReason: timeout",
                        "",
                        "",
                        100,
                        500,
                    ),
                    (
                        "comm_stale_result",
                        "Heartbeat follow-up for `deepautosearch:retry-stale`.\nReason: timeout",
                        "",
                        "old result",
                        100,
                        150,
                    ),
                ],
            )

    def test_completed_result_requires_exact_logical_key_nonempty_output_and_newer_finish(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self._build_db(db_path)
            reader = SuperMatrixReader(db_path)

            results = reader.completed_heartbeat_child_results(
                [
                    {
                        "target_session": "deepautosearch",
                        "logical_key": "deepautosearch:retry-1",
                        "after_ms": 200,
                    },
                    {
                        "target_session": "deepautosearch",
                        "logical_key": "deepautosearch:retry-empty",
                        "after_ms": 200,
                    },
                    {
                        "target_session": "deepautosearch",
                        "logical_key": "deepautosearch:retry-stale",
                        "after_ms": 200,
                    },
                ]
            )

            self.assertEqual(set(results), {("deepautosearch", "deepautosearch:retry-1")})
            receipt = results[("deepautosearch", "deepautosearch:retry-1")]
            self.assertEqual(receipt["comm_id"], "comm_exact")
            self.assertEqual(receipt["finished_at"], 500)
            self.assertEqual(receipt["final_message"], "materialized result")


if __name__ == "__main__":
    unittest.main()
