from __future__ import annotations

import fcntl
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.completion import build_completion_summary, write_completion_summary
from heartbeat_patrol.state import HeartbeatState


class CompletionSummaryTest(unittest.TestCase):
    def _build_coverage_summary(
        self,
        *,
        status: str = "completed",
        stats: dict | None = None,
        errors: list[str] | None = None,
    ) -> dict:
        with tempfile.TemporaryDirectory() as directory:
            return build_completion_summary(
                state=HeartbeatState(Path(directory) / "heartbeat.sqlite"),
                completion_id="attempt-coverage",
                patrol_id="patrol-coverage",
                status=status,
                started_at="2026-07-27T01:00:00+00:00",
                finished_at="2026-07-27T01:00:01+00:00",
                stats=stats or {},
                errors=errors or [],
                feishu_sync={},
                landing_deadline_seconds=3600,
                snapshot={
                    "todos": {"live": 0, "terminal": 0, "over_sla_landing": 0},
                    "unrecovered": {"targets": 0, "failures": 0, "active": []},
                    "escalation_handoffs": {"recent": []},
                },
            )

    def _insert_todo(
        self,
        state: HeartbeatState,
        *,
        todo_id: str,
        status: str,
        created_at: str,
        injected_at: str | None = None,
    ) -> None:
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                """
                INSERT INTO session_todos
                  (todo_id, target_session, logical_key, source_session, source_ref, todo_type,
                   status, message, created_at, injected_at, source)
                VALUES (?, 'alpha', ?, 'source', 'ref', 'general', ?, 'message', ?, ?, 'heartbeat')
                """,
                (todo_id, f"alpha:{todo_id}", status, created_at, injected_at),
            )

    def test_summary_binds_run_and_reports_current_completion_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = HeartbeatState(Path(directory) / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            state.finish_patrol(
                patrol_id,
                sessions_scanned=7,
                items_detected=2,
                alerts_sent=1,
                spawns_started=1,
                spawns_skipped_duplicate=0,
                errors=[],
            )
            now = datetime.now(timezone.utc).replace(microsecond=0)
            created_at = (now - timedelta(hours=3)).isoformat()
            self._insert_todo(state, todo_id="pending", status="pending", created_at=created_at)
            self._insert_todo(state, todo_id="claimed", status="claimed", created_at=created_at)
            self._insert_todo(
                state,
                todo_id="overdue-injected",
                status="injected",
                created_at=created_at,
                injected_at=(now - timedelta(hours=2)).isoformat(),
            )
            self._insert_todo(
                state,
                todo_id="fresh-injected",
                status="injected",
                created_at=created_at,
                injected_at=(now - timedelta(minutes=10)).isoformat(),
            )
            self._insert_todo(state, todo_id="completed", status="completed", created_at=created_at)
            self._insert_todo(state, todo_id="failed", status="failed", created_at=created_at)
            self._insert_todo(state, todo_id="cleared", status="cleared", created_at=created_at)
            self._insert_todo(
                state,
                todo_id="legacy",
                status="legacy_ignored",
                created_at=created_at,
            )
            state.record_unrecovered_target(
                action_type="user_resume",
                target_session="alpha",
                logical_key="alpha:resume-timeout",
                error="timeout",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="beta",
                logical_key="beta:spawn-timeout-1",
                error="timeout 1",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="beta",
                logical_key="beta:spawn-timeout-2",
                error="timeout 2",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            escalation_event_id = state.log_event(
                patrol_id=patrol_id,
                event_type="unrecovered_item_escalated",
                target_session="alpha",
                logical_key="alpha:resume-3",
                decision="user_resume",
                status="escalated",
                summary="alpha user_resume unrecovered",
                error="console timeout",
            )
            handoff_id = state.record_unrecovered_escalation_handoff(
                escalation_event_id=escalation_event_id,
                patrol_id=patrol_id,
                action_type="user_resume",
                target_session="alpha",
                logical_key="alpha:resume-3",
                failure_count=3,
                window_started_at="2026-07-22T13:00:00+00:00",
                error="console timeout",
            )
            state.record_unrecovered_handoff_transport(
                handoff_id=handoff_id,
                status="delivered",
                message_id="om_handoff_123",
                detail="",
            )

            summary = build_completion_summary(
                state=state,
                completion_id="attempt-1",
                patrol_id=patrol_id,
                status="completed",
                started_at="2026-07-22T13:10:00+00:00",
                finished_at="2026-07-22T13:10:01+00:00",
                stats={
                    "unrecovered_targets_escalated": 1,
                    "unrecovered_targets_reconciled": 2,
                    "spawns_reconciled_timeout": 3,
                    "todos_landing_verified": 4,
                    "todos_landing_unconfirmed": 5,
                },
                errors=[],
                feishu_sync={
                    "events": {"status": "disabled", "mode": "none"},
                    "todos": {"status": "disabled", "mode": "none"},
                    "todo_aggregates": {"status": "disabled", "mode": "none"},
                },
                landing_deadline_seconds=3600,
            )

            self.assertEqual(summary["status"], "completed")
            self.assertEqual(summary["run"], {
                "completion_id": "attempt-1",
                "patrol_id": patrol_id,
                "started_at": "2026-07-22T13:10:00+00:00",
                "finished_at": "2026-07-22T13:10:01+00:00",
            })
            self.assertEqual(summary["todos"], {
                "live": 4,
                "terminal": 4,
                "over_sla_landing": 1,
            })
            self.assertEqual(summary["unrecovered"]["targets"], 2)
            self.assertEqual(summary["unrecovered"]["failures"], 3)
            self.assertEqual(
                {(entry["action_type"], entry["target_session"], entry["failure_count"])
                 for entry in summary["unrecovered"]["active"]},
                {("user_resume", "alpha", 1), ("spawn", "beta", 2)},
            )
            self.assertEqual(summary["actions"], {
                "escalated": 1,
                "reconciled": 2,
                "spawn_timeouts_reconciled": 3,
                "todo_landings_verified": 4,
                "todo_landings_unconfirmed": 5,
            })
            self.assertEqual(summary["feishu_mirror"]["events"], {"status": "disabled", "mode": "none"})
            receipt = summary["escalation_handoffs"]["recent"][0]
            self.assertEqual(receipt["handoff_id"], handoff_id)
            self.assertEqual(receipt["target_session"], "alpha")
            self.assertEqual(receipt["error"], "console timeout")
            self.assertEqual(
                receipt["notify"],
                {"status": "delivered", "message_id": "om_handoff_123", "detail": ""},
            )
            self.assertEqual(
                receipt["handoff"],
                {
                    "owner_session": "heartbeat",
                    "ledger_ref": f"unrecovered_escalation_handoffs/{handoff_id}",
                    "acceptance_status": "awaiting_acceptance",
                },
            )
            self.assertEqual(receipt["recovery"], {"status": "awaiting_acceptance"})

            output_dir = Path(directory) / "completion"
            write_completion_summary(summary=summary, directory=output_dir)
            self.assertEqual(json.loads((output_dir / "attempt-1.json").read_text()), summary)
            self.assertEqual(json.loads((output_dir / "latest.json").read_text()), summary)

    def test_full_unscoped_coverage_is_complete(self) -> None:
        summary = self._build_coverage_summary(
            stats={
                "coverage_scope": "full",
                "eligible_sessions": 3,
                "sessions_scanned": 3,
                "items_detected": 2,
            }
        )

        self.assertEqual(
            summary["coverage"],
            {
                "scope": "full",
                "eligible_sessions": 3,
                "sessions_scanned": 3,
                "items_detected": 2,
                "coverage_complete": True,
            },
        )

    def test_targeted_batched_and_errored_runs_never_claim_complete_coverage(self) -> None:
        cases = (
            (
                "targeted",
                "completed",
                {"coverage_scope": "targeted", "eligible_sessions": 1, "sessions_scanned": 1, "items_detected": 0},
                [],
            ),
            (
                "batched",
                "completed",
                {"coverage_scope": "batched", "eligible_sessions": 3, "sessions_scanned": 2, "items_detected": 1},
                [],
            ),
            (
                "errored_full",
                "failed",
                {"coverage_scope": "full", "eligible_sessions": 3, "sessions_scanned": 3, "items_detected": 1},
                ["controller failed"],
            ),
        )

        for name, status, stats, errors in cases:
            with self.subTest(name=name):
                summary = self._build_coverage_summary(status=status, stats=stats, errors=errors)
                self.assertEqual(summary["coverage"]["scope"], stats["coverage_scope"])
                self.assertEqual(summary["coverage"]["eligible_sessions"], stats["eligible_sessions"])
                self.assertEqual(summary["coverage"]["sessions_scanned"], stats["sessions_scanned"])
                self.assertEqual(summary["coverage"]["items_detected"], stats["items_detected"])
                self.assertFalse(summary["coverage"]["coverage_complete"])

    def test_coverage_is_serialized_in_completion_receipt(self) -> None:
        summary = self._build_coverage_summary(
            stats={
                "coverage_scope": "full",
                "eligible_sessions": 2,
                "sessions_scanned": 2,
                "items_detected": 0,
            }
        )
        expected_coverage = {
            "scope": "full",
            "eligible_sessions": 2,
            "sessions_scanned": 2,
            "items_detected": 0,
            "coverage_complete": True,
        }

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "completion"
            write_completion_summary(summary=summary, directory=output_dir)
            serialized = json.loads((output_dir / "attempt-coverage.json").read_text())

        self.assertEqual(serialized["coverage"], expected_coverage)


class HeartbeatPatrolCompletionScriptTest(unittest.TestCase):
    def _load_script_module(self, name: str):
        script_path = Path(__file__).resolve().parents[1] / "scripts" / "heartbeat-patrol"
        loader = SourceFileLoader(name, str(script_path))
        spec = importlib.util.spec_from_loader(name, loader)
        assert spec is not None
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module

    def test_lock_contention_is_skipped_receipt_and_temporary_failure(self) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            lock_path = base / "heartbeat.lock"
            completion_dir = base / "completion"
            env = os.environ.copy()
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["HEARTBEAT_STATE_DB"] = str(base / "heartbeat.sqlite")
            env["SM_DB_PATH"] = str(base / "missing-supermatrix.sqlite")
            env["HEARTBEAT_PATROL_LOCK_PATH"] = str(lock_path)
            env["HEARTBEAT_COMPLETION_DIR"] = str(completion_dir)

            with lock_path.open("a") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                completed = subprocess.run(
                    [str(repo_root / "scripts" / "heartbeat-patrol")],
                    cwd=repo_root,
                    env=env,
                    text=True,
                    capture_output=True,
                    timeout=10,
                )

            self.assertEqual(completed.returncode, 75, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertEqual(result["status"], "skipped")
            summary = json.loads((completion_dir / "latest.json").read_text())
            self.assertEqual(summary["status"], "skipped")
            self.assertIsNone(summary["run"]["patrol_id"])
            self.assertFalse((base / "heartbeat.sqlite").exists())
            self.assertEqual(summary["todos"], {"live": 0, "terminal": 0, "over_sla_landing": 0})
            self.assertEqual(
                summary["coverage"],
                {
                    "scope": "lock_skipped",
                    "eligible_sessions": None,
                    "sessions_scanned": 0,
                    "items_detected": 0,
                    "coverage_complete": False,
                },
            )

    def test_full_patrol_retries_state_startup_lock_and_emits_completed_receipt(self) -> None:
        """A transient SQLite writer must not erase an hourly full-sweep receipt."""
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            state_path = base / "heartbeat.sqlite"
            completion_dir = base / "completion"
            state = HeartbeatState(state_path)
            module = self._load_script_module("heartbeat_patrol_script_startup_lock_retry")
            case = self

            class FinishedRunner:
                def run_once(self, *, session_names=None):
                    case.assertIsNone(session_names)
                    patrol_id = state.start_patrol("MiniMax-M2.7")
                    state.finish_patrol(
                        patrol_id,
                        sessions_scanned=1,
                        items_detected=0,
                        alerts_sent=0,
                        spawns_started=0,
                        spawns_skipped_duplicate=0,
                        errors=[],
                    )
                    return {
                        "patrol_id": patrol_id,
                        "stats": {
                            "coverage_scope": "full",
                            "eligible_sessions": 1,
                            "sessions_scanned": 1,
                            "items_detected": 0,
                        },
                        "errors": [],
                    }

            def build_runner(cfg, *, state):
                case.assertEqual(state.path, state_path)
                return FinishedRunner()

            env = {
                "PYTHONDONTWRITEBYTECODE": "1",
                "HEARTBEAT_STATE_DB": str(state_path),
                "HEARTBEAT_COMPLETION_DIR": str(completion_dir),
                "HEARTBEAT_PATROL_LOCK_PATH": str(base / "heartbeat.lock"),
            }
            stdout = io.StringIO()
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(
                    module,
                    "HeartbeatState",
                    side_effect=[sqlite3.OperationalError("database is locked"), state],
                ) as state_constructor,
                patch.object(module, "build_default_runner", side_effect=build_runner),
                patch.object(sys, "argv", ["heartbeat-patrol"]),
                redirect_stdout(stdout),
            ):
                return_code = module.main()

            self.assertEqual(return_code, 0)
            self.assertEqual(state_constructor.call_count, 2)
            result = json.loads(stdout.getvalue())
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["state_startup_retries"], 1)
            summary = json.loads((completion_dir / "latest.json").read_text())
            self.assertTrue(summary["coverage"]["coverage_complete"])

    def test_feishu_sync_exception_marks_result_and_patrol_completion_failed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            state_path = base / "heartbeat.sqlite"
            completion_dir = base / "completion"
            state = HeartbeatState(state_path)
            patrol_id = state.start_patrol("MiniMax-M2.7")
            state.finish_patrol(
                patrol_id,
                sessions_scanned=1,
                items_detected=0,
                alerts_sent=0,
                spawns_started=0,
                spawns_skipped_duplicate=0,
                errors=[],
            )

            class FinishedRunner:
                def run_once(self, *, session_names=None):
                    return {"patrol_id": patrol_id, "stats": {}, "errors": []}

            env = {
                "PYTHONDONTWRITEBYTECODE": "1",
                "HEARTBEAT_STATE_DB": str(state_path),
                "HEARTBEAT_COMPLETION_DIR": str(completion_dir),
                "HEARTBEAT_PATROL_LOCK_PATH": str(base / "heartbeat.lock"),
            }
            module = self._load_script_module("heartbeat_patrol_script_sync_failure")
            stdout = io.StringIO()
            with (
                patch.dict(os.environ, env, clear=False),
                patch.object(module, "build_default_runner", return_value=FinishedRunner()),
                patch.object(module, "sync_events_to_feishu", side_effect=RuntimeError("mirror offline")),
                patch.object(sys, "argv", ["heartbeat-patrol"]),
                redirect_stdout(stdout),
            ):
                return_code = module.main()

            self.assertEqual(return_code, 1)
            result = json.loads(stdout.getvalue())
            self.assertIn("Feishu sync failed: mirror offline", result["errors"])
            with sqlite3.connect(state_path) as conn:
                status, errors = conn.execute(
                    "SELECT status, errors FROM patrol_runs WHERE patrol_id = ?", (patrol_id,)
                ).fetchone()
            self.assertEqual(status, "failed")
            self.assertIn("Feishu sync failed: mirror offline", errors)
            summary = json.loads((completion_dir / "latest.json").read_text())
            self.assertEqual(summary["status"], "failed")
            self.assertIn("Feishu sync failed: mirror offline", summary["errors"])


if __name__ == "__main__":
    unittest.main()
