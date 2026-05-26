import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from heartbeat_patrol.decision import (
    DecisionError,
    PatrolDecision,
    build_controller_prompt,
    parse_decision,
)
from heartbeat_patrol.sm_reader import SuperMatrixReader


def raw_decision(**overrides: object) -> str:
    payload: dict[str, object] = {
        "session": "scheduler",
        "items": [
            {
                "logical_key": "scheduler:stale-run-1",
                "severity": "warn",
                "decision": "spawn_collect",
                "reason": "A recent run is stale and needs evidence collection.",
                "target_session": "scheduler",
                "child_model": "gpt-5.4-mini",
                "prompt": "Inspect the stale run and report only evidence.",
            }
        ],
    }
    payload.update(overrides)
    return json.dumps(payload)


class DecisionTest(unittest.TestCase):
    def test_valid_decision_parses_to_dataclass(self) -> None:
        decision = parse_decision(raw_decision(), expected_session="scheduler")

        self.assertIsInstance(decision, PatrolDecision)
        self.assertEqual(decision.session, "scheduler")
        self.assertEqual(len(decision.items), 1)
        self.assertEqual(decision.items[0].logical_key, "scheduler:stale-run-1")
        self.assertEqual(decision.items[0].child_model, "gpt-5.4-mini")

    def test_invalid_json_raises(self) -> None:
        with self.assertRaises(DecisionError):
            parse_decision("{not json", expected_session="scheduler")

    def test_session_mismatch_raises(self) -> None:
        with self.assertRaises(DecisionError):
            parse_decision(raw_decision(session="watchdog"), expected_session="scheduler")

    def test_target_mismatch_raises(self) -> None:
        payload = json.loads(raw_decision())
        payload["items"][0]["target_session"] = "watchdog"

        with self.assertRaises(DecisionError):
            parse_decision(json.dumps(payload), expected_session="scheduler")

    def test_invalid_model_raises(self) -> None:
        payload = json.loads(raw_decision())
        payload["items"][0]["child_model"] = "gpt-5.4"

        with self.assertRaises(DecisionError):
            parse_decision(json.dumps(payload), expected_session="scheduler")

    def test_escalate_requires_escalation_model(self) -> None:
        payload = json.loads(raw_decision())
        payload["items"][0]["decision"] = "escalate"
        payload["items"][0]["child_model"] = "gpt-5.4-mini"

        with self.assertRaises(DecisionError):
            parse_decision(json.dumps(payload), expected_session="scheduler")

    def test_user_resume_decision_parses(self) -> None:
        payload = json.loads(raw_decision())
        payload["items"][0]["decision"] = "user_resume"
        payload["items"][0]["reason"] = "The latest run asks whether to continue the remaining explicit steps."
        payload["items"][0]["prompt"] = "Compose a natural user reply that asks the session to continue its remaining explicit steps."

        decision = parse_decision(json.dumps(payload), expected_session="scheduler")

        self.assertEqual(decision.items[0].decision, "user_resume")

    def test_logical_key_must_start_with_expected_session(self) -> None:
        payload = json.loads(raw_decision())
        payload["items"][0]["logical_key"] = "watchdog:stale-run-1"

        with self.assertRaises(DecisionError):
            parse_decision(json.dumps(payload), expected_session="scheduler")

    def test_unsafe_prompt_raises(self) -> None:
        unsafe_prompts = [
            "Spawn other sessions, call scheduler, and modify unrelated state.",
            "Spawn any session to inspect scheduler.",
            "Use /api/spawn to create a child session for scheduler.",
            "Call the scheduler and ask it to fix this.",
            "Do not wait; spawn other sessions now.",
            "Do not wait, spawn other sessions now.",
            "Never mind, call the scheduler and ask it to fix this.",
            "Do not only collect evidence, use /api/spawn now.",
            "Use the /api/spawn endpoint now.",
            "Call /api/spawn now.",
            "Invoke /api/spawn to create work.",
            "Spawn the scheduler to inspect this.",
            "Create one child session for scheduler.",
            "Create one session for scheduler.",
            "Contact the scheduler and ask it to fix this.",
        ]
        for prompt in unsafe_prompts:
            with self.subTest(prompt=prompt):
                payload = json.loads(raw_decision())
                payload["items"][0]["prompt"] = prompt

                with self.assertRaises(DecisionError):
                    parse_decision(json.dumps(payload), expected_session="scheduler")

    def test_safe_negative_prompt_parses(self) -> None:
        safe_prompts = [
            "Do not spawn other sessions; collect evidence only.",
            "Never call the scheduler. Report evidence only.",
            "Do not use /api/spawn. Collect evidence only.",
            "Do not create a session. Collect evidence only.",
            "Collect evidence about whether another session used /api/spawn yesterday.",
        ]
        for prompt in safe_prompts:
            with self.subTest(prompt=prompt):
                payload = json.loads(raw_decision())
                payload["items"][0]["prompt"] = prompt

                decision = parse_decision(json.dumps(payload), expected_session="scheduler")

                self.assertEqual(decision.items[0].prompt, prompt)

    def test_prompt_contract(self) -> None:
        prompt = build_controller_prompt(
            {"session": {"name": "scheduler"}, "recent_runs": [], "recent_cross_session": []},
            controller_model="gpt-5.4-mini",
            escalation_model="gpt-5.5",
        )

        self.assertIn("Return JSON only", prompt)
        self.assertIn("Default to skip", prompt)
        self.assertIn("Must skip when", prompt)
        self.assertIn("status/final-message contradictions", prompt)
        self.assertIn("mechanical continuation checkpoint", prompt)
        self.assertIn("already-approved multi-step plan", prompt)
        self.assertIn("real user choice gate", prompt)
        self.assertIn("user_resume", prompt)
        self.assertIn("natural user reply", prompt)
        self.assertIn("non-stale running run", prompt)
        self.assertIn("temporary provider or API rate limit", prompt)
        self.assertIn("At most one user_resume", prompt)
        self.assertIn("newer completed run", prompt)
        self.assertIn("Never infer stale merely because similar rows finished faster", prompt)
        self.assertIn("Top-level session must exactly equal Packet.session.name", prompt)
        self.assertIn("For skip, prefer omitting the item entirely", prompt)
        self.assertIn("Do not repeat no-cascade wording inside item.prompt", prompt)
        self.assertIn("no-cascade", prompt)
        self.assertIn("gpt-5.4-mini", prompt)
        self.assertIn("gpt-5.5", prompt)


class SuperMatrixReaderTest(unittest.TestCase):
    def create_db(self, db_path: Path) -> None:
        with sqlite3.connect(db_path) as conn:
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
                CREATE TABLE bindings (
                  session_id TEXT NOT NULL,
                  group_id TEXT
                );
                CREATE TABLE message_runs (
                  id TEXT PRIMARY KEY,
                  session_id TEXT NOT NULL,
                  prompt TEXT,
                  started_at TEXT,
                  finished_at TEXT,
                  status TEXT,
                  final_message TEXT,
                  error_message TEXT
                );
                CREATE TABLE cross_session_log (
                  kind TEXT,
                  from_session_id TEXT,
                  to_session_id TEXT,
                  prompt TEXT,
                  child_model TEXT,
                  status TEXT,
                  result_preview TEXT,
                  error_message TEXT,
                  created_at TEXT,
                  finished_at TEXT
                );
                """
            )

    def insert_session(
        self,
        conn: sqlite3.Connection,
        *,
        session_id: str,
        name: str,
        scope: str = "user",
        status: str = "idle",
        enabled: int = 1,
        updated_at: str = "2026-05-06T00:00:00Z",
    ) -> None:
        conn.execute(
            """
            INSERT INTO sessions
              (id, name, scope, backend, model, effort, workdir, status, purpose, heartbeat_enabled, updated_at)
            VALUES (?, ?, ?, 'codex', 'gpt-5.4-mini', 'medium', ?, ?, ?, ?, ?)
            """,
            (session_id, name, scope, f"/tmp/{name}", status, f"{name} purpose", enabled, updated_at),
        )
        conn.execute(
            "INSERT INTO bindings (session_id, group_id) VALUES (?, ?)",
            (session_id, f"group-{name}"),
        )

    def test_list_enabled_sessions_includes_non_child_scopes_and_excludes_disabled_rows(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)
            with sqlite3.connect(db_path) as conn:
                self.insert_session(
                    conn,
                    session_id="root-1",
                    name="codexroot",
                    scope="root",
                    updated_at="2026-05-06T00:00:00Z",
                )
                self.insert_session(
                    conn,
                    session_id="user-1",
                    name="scheduler",
                    scope="user",
                    updated_at="2026-05-06T00:01:00Z",
                )
                self.insert_session(conn, session_id="disabled-1", name="disabled", enabled=0)
                self.insert_session(conn, session_id="deleted-1", name="deleted", status="deleted")
                self.insert_session(conn, session_id="child-1", name="child", scope="child")
                self.insert_session(conn, session_id="heartbeat-1", name="heartbeat")

            sessions = SuperMatrixReader(db_path).list_enabled_sessions()

        self.assertEqual([session["name"] for session in sessions], ["codexroot", "scheduler"])
        self.assertEqual([session["scope"] for session in sessions], ["root", "user"])

    def test_list_enabled_sessions_orders_by_updated_at_then_name(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)
            with sqlite3.connect(db_path) as conn:
                self.insert_session(conn, session_id="later-1", name="later", updated_at="2026-05-06T00:02:00Z")
                self.insert_session(conn, session_id="same-b", name="beta", updated_at="2026-05-06T00:01:00Z")
                self.insert_session(conn, session_id="same-a", name="alpha", updated_at="2026-05-06T00:01:00Z")
                self.insert_session(conn, session_id="first-1", name="first", updated_at="2026-05-06T00:00:00Z")

            sessions = SuperMatrixReader(db_path).list_enabled_sessions()

        self.assertEqual([session["name"] for session in sessions], ["first", "alpha", "beta", "later"])

    def test_build_packet_bounds_runs_and_cross_session_rows(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)
            with sqlite3.connect(db_path) as conn:
                self.insert_session(conn, session_id="scheduler-1", name="scheduler")
                for index in range(5):
                    conn.execute(
                        """
                        INSERT INTO message_runs
                          (id, session_id, prompt, started_at, finished_at, status, final_message, error_message)
                        VALUES (?, 'scheduler-1', ?, ?, NULL, 'completed', ?, NULL)
                        """,
                        (
                            f"run-{index}",
                            f"prompt-{index}",
                            f"2026-05-06T00:0{index}:00Z",
                            f"final-{index}",
                        ),
                    )
                for index in range(12):
                    conn.execute(
                        """
                        INSERT INTO cross_session_log
                          (kind, from_session_id, to_session_id, prompt, child_model, status,
                           result_preview, error_message, created_at, finished_at)
                        VALUES ('spawn', 'scheduler-1', 'watchdog-1', ?, 'gpt-5.4-mini', 'completed',
                                ?, NULL, ?, NULL)
                        """,
                        (
                            f"cross-prompt-{index}",
                            f"preview-{index}",
                            f"2026-05-06T00:{index:02d}:00Z",
                        ),
                    )

            session = {"id": "scheduler-1", "name": "scheduler"}
            packet = SuperMatrixReader(db_path).build_packet(session, max_recent_runs=3)

        self.assertEqual(packet["session"], session)
        self.assertEqual([run["id"] for run in packet["recent_runs"]], ["run-4", "run-3", "run-2"])
        self.assertEqual(len(packet["recent_cross_session"]), 10)
        self.assertEqual(packet["recent_cross_session"][0]["prompt"], "cross-prompt-11")

    def test_build_packet_rejects_invalid_recent_run_limit(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)

            with self.assertRaises(ValueError):
                SuperMatrixReader(db_path).build_packet({"id": "scheduler-1"}, max_recent_runs=-1)

    def test_build_packet_caps_huge_recent_run_limit(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)
            with sqlite3.connect(db_path) as conn:
                self.insert_session(conn, session_id="scheduler-1", name="scheduler")
                for index in range(60):
                    conn.execute(
                        """
                        INSERT INTO message_runs
                          (id, session_id, prompt, started_at, finished_at, status, final_message, error_message)
                        VALUES (?, 'scheduler-1', ?, ?, NULL, 'completed', ?, NULL)
                        """,
                        (
                            f"run-{index}",
                            f"prompt-{index}",
                            f"2026-05-06T00:{index:02d}:00Z",
                            f"final-{index}",
                        ),
                    )

            packet = SuperMatrixReader(db_path).build_packet({"id": "scheduler-1"}, max_recent_runs=1000)

        self.assertEqual(len(packet["recent_runs"]), 50)

    def test_build_packet_truncates_text_fields(self) -> None:
        long_text = "x" * 4010
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "supermatrix.db"
            self.create_db(db_path)
            with sqlite3.connect(db_path) as conn:
                self.insert_session(conn, session_id="scheduler-1", name="scheduler")
                conn.execute(
                    """
                    INSERT INTO message_runs
                      (id, session_id, prompt, started_at, finished_at, status, final_message, error_message)
                    VALUES ('run-1', 'scheduler-1', ?, '2026-05-06T00:00:00Z', NULL, 'failed', ?, ?)
                    """,
                    (long_text, long_text, long_text),
                )
                conn.execute(
                    """
                    INSERT INTO cross_session_log
                      (kind, from_session_id, to_session_id, prompt, child_model, status,
                       result_preview, error_message, created_at, finished_at)
                    VALUES ('spawn', 'scheduler-1', 'watchdog-1', ?, 'gpt-5.4-mini', 'failed',
                            ?, ?, '2026-05-06T00:00:00Z', NULL)
                    """,
                    (long_text, long_text, long_text),
                )

            packet = SuperMatrixReader(db_path).build_packet({"id": "scheduler-1"}, max_recent_runs=1)

        run = packet["recent_runs"][0]
        comm = packet["recent_cross_session"][0]
        self.assertEqual(len(run["prompt"]), 4000)
        self.assertEqual(len(run["final_message"]), 4000)
        self.assertEqual(len(run["error_message"]), 4000)
        self.assertEqual(len(comm["prompt"]), 4000)
        self.assertEqual(len(comm["result_preview"]), 4000)
        self.assertEqual(len(comm["error_message"]), 4000)


if __name__ == "__main__":
    unittest.main()
