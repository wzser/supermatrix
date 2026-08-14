import sqlite3
import tempfile
import unittest
from pathlib import Path

from heartbeat_patrol.sm_reader import SuperMatrixReader


class SessionRunLandedSinceTest(unittest.TestCase):
    def _build_db(self, db_path: Path) -> None:
        with sqlite3.connect(db_path) as conn:
            conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)")
            # message_runs.started_at is stored as epoch milliseconds in production.
            conn.execute(
                "CREATE TABLE message_runs (id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER, status TEXT)"
            )
            conn.execute("INSERT INTO sessions VALUES ('s1', 'alpha')")
            conn.execute("INSERT INTO sessions VALUES ('s2', 'beta')")
            conn.execute("INSERT INTO message_runs VALUES ('r1', 's1', 1000, 'completed')")
            conn.execute("INSERT INTO message_runs VALUES ('r2', 's1', 5000, 'running')")

    def test_landing_detection_by_epoch_ms_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self._build_db(db_path)
            reader = SuperMatrixReader(db_path)

            # a run at 5000ms lands for any since_ms <= 5000
            self.assertTrue(reader.session_run_landed_since("alpha", 4000))
            self.assertTrue(reader.session_run_landed_since("alpha", 5000))
            # nothing at/after 6000ms
            self.assertFalse(reader.session_run_landed_since("alpha", 6000))
            # session with no runs
            self.assertFalse(reader.session_run_landed_since("beta", 0))
            # unknown session / empty name
            self.assertFalse(reader.session_run_landed_since("ghost", 0))
            self.assertFalse(reader.session_run_landed_since("", 0))


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
