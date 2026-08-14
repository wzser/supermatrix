import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.state import HeartbeatState


class HeartbeatStateTest(unittest.TestCase):
    def new_state(self, d: str) -> HeartbeatState:
        return HeartbeatState(Path(d) / "heartbeat.sqlite")

    def pk_columns(self, db_path: Path) -> list[str]:
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute("PRAGMA table_info(child_spawns)").fetchall()
        return [name for _, name in sorted((row[5], row[1]) for row in rows if row[5])]

    def test_open_existing_releases_watch_claim_without_rerunning_schema_init(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))

            with patch.object(HeartbeatState, "_init_schema", side_effect=AssertionError("schema init called")):
                existing = HeartbeatState.open_existing(state.path)
                existing.release_todo_watch("alpha")

            self.assertFalse(state.todo_watch_claim_active("alpha", stale_after_seconds=3000))

    def test_purge_old_events_respects_retention_window(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.log_event(event_type="session_prefilter_skip", status="skipped", target_session="alpha")
            state.log_event(event_type="todo_injected", status="sent", target_session="alpha")
            old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE heartbeat_events SET created_at = ? WHERE event_type = 'session_prefilter_skip'",
                    (old,),
                )

            purged = state.purge_old_events(retention_days=30)

            self.assertEqual(purged, 1)
            with sqlite3.connect(state.path) as conn:
                remaining = [
                    row[0]
                    for row in conn.execute("SELECT event_type FROM heartbeat_events").fetchall()
                ]
            self.assertEqual(remaining, ["todo_injected"])
            self.assertEqual(state.purge_old_events(retention_days=0), 0)

    def test_action_failures_enter_cooldown_after_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            key = {"action_type": "user_resume", "target_session": "alpha", "logical_key": "alpha:resume-1"}

            first = state.record_action_failure(**key, error="timeout 1", threshold=3, cooldown_minutes=360)
            second = state.record_action_failure(**key, error="timeout 2", threshold=3, cooldown_minutes=360)
            self.assertEqual(first["failure_count"], 1)
            self.assertEqual(second["failure_count"], 2)
            self.assertIsNone(first["cooldown_until"])
            self.assertIsNone(second["cooldown_until"])
            self.assertIsNone(state.action_in_cooldown(**key))

            third = state.record_action_failure(**key, error="timeout 3", threshold=3, cooldown_minutes=360)
            self.assertEqual(third["failure_count"], 3)
            self.assertIsNotNone(third["cooldown_until"])
            self.assertEqual(state.action_in_cooldown(**key), third["cooldown_until"])

            state.clear_action_failures(**key)
            self.assertIsNone(state.action_in_cooldown(**key))
            after_clear = state.record_action_failure(**key, error="timeout 4", threshold=3, cooldown_minutes=360)
            self.assertEqual(after_clear["failure_count"], 1)

    def test_unrecovered_target_escalates_across_changing_logical_keys(self) -> None:
        # The controller mints a fresh logical_key each patrol for the same stuck target, so the
        # per-logical_key cooldown never trips. The target-scoped aggregate must still escalate.
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            knobs = {"threshold": 3, "window_minutes": 360, "reescalate_minutes": 720}

            for n in range(2):
                # Distinct logical_keys still bump the same (action_type, target_session) aggregate.
                state.record_action_failure(
                    action_type="user_resume",
                    target_session="ad-adjust",
                    logical_key=f"ad-adjust:resume-{n}",
                    error="perspective",
                    threshold=3,
                    cooldown_minutes=360,
                )
                out = state.record_unrecovered_target(
                    action_type="user_resume",
                    target_session="ad-adjust",
                    logical_key=f"ad-adjust:resume-{n}",
                    error="perspective",
                    **knobs,
                )
                self.assertFalse(out["escalate"])
            # Per-logical_key cooldown never fired because every key is unique.
            self.assertIsNone(
                state.action_in_cooldown(
                    action_type="user_resume", target_session="ad-adjust", logical_key="ad-adjust:resume-0"
                )
            )

            third = state.record_unrecovered_target(
                action_type="user_resume",
                target_session="ad-adjust",
                logical_key="ad-adjust:resume-2",
                error="perspective",
                **knobs,
            )
            self.assertEqual(third["failure_count"], 3)
            self.assertTrue(third["escalate"])

            # Re-escalation is rate-limited: a 4th failure inside the interval does not re-fire.
            fourth = state.record_unrecovered_target(
                action_type="user_resume",
                target_session="ad-adjust",
                logical_key="ad-adjust:resume-3",
                error="perspective",
                **knobs,
            )
            self.assertEqual(fourth["failure_count"], 4)
            self.assertFalse(fourth["escalate"])

            # A genuine advancement clears the aggregate; counting restarts from scratch.
            state.clear_unrecovered_target(action_type="user_resume", target_session="ad-adjust")
            restarted = state.record_unrecovered_target(
                action_type="user_resume",
                target_session="ad-adjust",
                logical_key="ad-adjust:resume-restarted",
                error="perspective",
                **knobs,
            )
            self.assertEqual(restarted["failure_count"], 1)
            self.assertFalse(restarted["escalate"])

    def test_unrecovered_target_window_resets_stale_episode(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            knobs = {"threshold": 3, "window_minutes": 360, "reescalate_minutes": 720}
            for n in range(2):
                state.record_unrecovered_target(
                    action_type="spawn",
                    target_session="fp",
                    logical_key=f"fp:timeout-{n}",
                    error=f"timeout {n}",
                    **knobs,
                )
            # Age the counting window past its horizon so the next failure starts a fresh episode.
            stale = (datetime.now(timezone.utc) - timedelta(hours=12)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE unrecovered_targets SET window_started_at = ?", (stale,))
            reset = state.record_unrecovered_target(
                action_type="spawn",
                target_session="fp",
                logical_key="fp:timeout-reset",
                error="timeout",
                **knobs,
            )
            self.assertEqual(reset["failure_count"], 1)
            self.assertFalse(reset["escalate"])

    def test_legacy_aggregate_backfill_requires_one_exact_failed_logical_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            failed_at = "2026-07-22T09:56:36+00:00"
            with sqlite3.connect(state.path) as conn:
                conn.executemany(
                    """
                    INSERT INTO unrecovered_targets (
                      action_type, target_session, last_logical_key, failure_count, window_started_at,
                      last_failed_at, last_error
                    ) VALUES ('spawn', ?, '', 1, ?, ?, 'timeout')
                    """,
                    [
                        ("alpha", failed_at, failed_at),
                        ("beta", failed_at, failed_at),
                    ],
                )
                conn.executemany(
                    """
                    INSERT INTO action_failures (
                      action_type, target_session, logical_key, failure_count, last_failed_at, last_error
                    ) VALUES ('spawn', ?, ?, 1, ?, 'timeout')
                    """,
                    [
                        ("alpha", "alpha:only-key", failed_at),
                        ("beta", "beta:first-key", failed_at),
                        ("beta", "beta:second-key", failed_at),
                    ],
                )

            HeartbeatState(state.path)

            with sqlite3.connect(state.path) as conn:
                rows = conn.execute(
                    "SELECT target_session, last_logical_key FROM unrecovered_targets ORDER BY target_session"
                ).fetchall()
            self.assertEqual(rows, [("alpha", "alpha:only-key"), ("beta", "")])

    def test_unrecovered_target_does_not_reconcile_from_single_later_clean_decision(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:spawn-timeout",
                error="spawn timeout",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )
            state.log_event(
                event_type="session_decision",
                target_session="alpha",
                status="completed",
                summary="items=0; non_skip=0",
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_unrecovered_target_reconciles_only_from_a_receipt_with_its_exact_logical_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:failed-child",
                error="spawn timeout",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )
            state.log_event(
                event_type="spawn_started",
                target_session="alpha",
                logical_key="alpha:other-child",
                status="running",
                summary="unrelated child accepted",
            )

            self.assertEqual(state.reconcile_unrecovered_targets_from_later_events(), [])
            state.log_event(
                event_type="spawn_started",
                target_session="alpha",
                logical_key="alpha:failed-child",
                status="running",
                summary="the failed child was accepted",
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(len(reconciled), 1)
            self.assertEqual(reconciled[0]["recovery_event_type"], "spawn_started")
            self.assertEqual(reconciled[0]["logical_key"], "alpha:failed-child")
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 0)

    def test_unrecovered_target_does_not_reconcile_from_terminal_spawn_event(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:terminal-blocker",
                error="terminal child blocker",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )
            state.log_event(
                event_type="spawn_started",
                target_session="alpha",
                logical_key="alpha:terminal-blocker",
                status="failed",
                summary="child completed with a terminal blocker",
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_spawn_unrecovered_target_does_not_reconcile_from_user_resume_transport(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-failure",
                error="gpt-5.4-mini is unavailable",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )
            state.log_event(
                event_type="user_resume_sent",
                target_session="ad-adjust",
                logical_key="ad-adjust:unrelated-resume",
                status="sent",
                summary="user message accepted",
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_spawn_unrecovered_target_does_not_reconcile_from_escalation_event(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-3",
                error="gpt-5.4-mini is unavailable",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )
            state.log_event(
                event_type="unrecovered_item_escalated",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-3",
                decision="spawn_collect",
                status="escalated",
                summary="three failures reported",
                error="gpt-5.4-mini is unavailable",
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_unrecovered_handoff_persists_owner_and_ledger_reference(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            escalation_event_id = state.log_event(
                event_type="unrecovered_item_escalated",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-3",
                decision="spawn_collect",
                status="escalated",
                summary="three spawn failures",
                error="gpt-5.4-mini is unavailable",
            )
            handoff_id = state.record_unrecovered_escalation_handoff(
                escalation_event_id=escalation_event_id,
                patrol_id="patrol-test",
                action_type="spawn",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-3",
                failure_count=3,
                window_started_at="2026-07-23T00:00:00+00:00",
                error="gpt-5.4-mini is unavailable",
            )

            with sqlite3.connect(state.path) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(unrecovered_escalation_handoffs)")}
                self.assertTrue({"owner_session", "ledger_ref"}.issubset(columns))
                row = conn.execute(
                    "SELECT owner_session, ledger_ref FROM unrecovered_escalation_handoffs WHERE handoff_id = ?",
                    (handoff_id,),
                ).fetchone()
            self.assertEqual(row, ("heartbeat", f"unrecovered_escalation_handoffs/{handoff_id}"))

    def test_legacy_handoff_backfill_does_not_link_an_unmatched_target_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            escalation_event_id = state.log_event(
                event_type="unrecovered_item_escalated",
                target_session="ad-adjust",
                logical_key="ad-adjust:spawn-3",
                decision="spawn_execute",
                status="escalated",
                summary="three spawn failures",
                error="gpt-5.4-mini is unavailable",
            )
            recovery_event_id = state.log_event(
                event_type="todo_landing_verified",
                target_session="ad-adjust",
                logical_key="comm_ad_adjust_recovery",
                status="completed",
                summary="target run landed",
            )
            earlier = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
            later = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE heartbeat_events SET created_at = ? WHERE event_id = ?", (earlier, escalation_event_id))
                conn.execute("UPDATE heartbeat_events SET created_at = ? WHERE event_id = ?", (later, recovery_event_id))

            HeartbeatState(state.path)

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT notify_status, status, recovery_event_type, recovery_event_id "
                    "FROM unrecovered_escalation_handoffs WHERE escalation_event_id = ?",
                    (escalation_event_id,),
                ).fetchone()
            self.assertEqual(row, ("unverifiable", "legacy_unverifiable", "", ""))

    def test_existing_handoff_ledger_migrates_owner_and_ledger_reference(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            with sqlite3.connect(state.path) as conn:
                conn.execute("DROP TABLE unrecovered_escalation_handoffs")
                conn.execute(
                    """
                    CREATE TABLE unrecovered_escalation_handoffs (
                      handoff_id TEXT PRIMARY KEY,
                      escalation_event_id TEXT NOT NULL UNIQUE,
                      patrol_id TEXT,
                      action_type TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      logical_key TEXT NOT NULL,
                      failure_count INTEGER NOT NULL,
                      window_started_at TEXT NOT NULL,
                      error TEXT NOT NULL DEFAULT '',
                      created_at TEXT NOT NULL,
                      notify_status TEXT NOT NULL DEFAULT 'pending',
                      notify_message_id TEXT NOT NULL DEFAULT '',
                      notify_detail TEXT NOT NULL DEFAULT '',
                      notify_attempted_at TEXT,
                      status TEXT NOT NULL DEFAULT 'awaiting_delivery',
                      recovery_event_id TEXT NOT NULL DEFAULT '',
                      recovery_event_type TEXT NOT NULL DEFAULT '',
                      recovery_summary TEXT NOT NULL DEFAULT '',
                      recovery_at TEXT,
                      updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO unrecovered_escalation_handoffs (
                      handoff_id, escalation_event_id, action_type, target_session, logical_key,
                      failure_count, window_started_at, error, created_at, notify_status,
                      notify_message_id, status, updated_at
                    ) VALUES (?, ?, 'spawn', 'ad-adjust', 'ad-adjust:spawn-3', 3, ?, ?, ?,
                              'delivered', 'om_old_1', 'awaiting_acceptance', ?)
                    """,
                    (
                        "ueh_old_1",
                        "hev_old_1",
                        "2026-07-23T00:00:00+00:00",
                        "gpt-5.4-mini is unavailable",
                        "2026-07-23T00:00:00+00:00",
                        "2026-07-23T00:00:00+00:00",
                    ),
                )

            HeartbeatState(state.path)

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT owner_session, ledger_ref, notify_message_id, status "
                    "FROM unrecovered_escalation_handoffs WHERE handoff_id = 'ueh_old_1'"
                ).fetchone()
            self.assertEqual(
                row,
                (
                    "heartbeat",
                    "unrecovered_escalation_handoffs/ueh_old_1",
                    "om_old_1",
                    "awaiting_acceptance",
                ),
            )

    def test_existing_cross_session_result_recovery_is_downgraded_to_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            escalation_event_id = state.log_event(
                event_type="unrecovered_item_escalated",
                target_session="alpha",
                logical_key="alpha:late-child",
                decision="spawn_execute",
                status="escalated",
                summary="late child timed out",
                error="timeout",
            )
            handoff_id = state.record_unrecovered_escalation_handoff(
                escalation_event_id=escalation_event_id,
                patrol_id="patrol-old",
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:late-child",
                failure_count=3,
                window_started_at="2026-07-25T00:00:00+00:00",
                error="timeout",
            )
            state.record_unrecovered_handoff_transport(
                handoff_id=handoff_id,
                status="delivered",
                message_id="om_old",
                detail="",
            )
            result_event_id = state.log_event(
                event_type="unrecovered_target_result_linked",
                target_session="alpha",
                logical_key="alpha:late-child",
                status="completed",
                summary="cross_session_log comm_old completed; target result is non-empty",
                trigger_source="cross_session_log",
            )
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    """
                    UPDATE unrecovered_escalation_handoffs
                    SET status = 'recovered', recovery_event_id = ?,
                        recovery_event_type = 'cross_session_result_linked',
                        recovery_summary = 'cross_session_log comm_old completed', recovery_at = ?, updated_at = ?
                    WHERE handoff_id = ?
                    """,
                    (
                        result_event_id,
                        "2026-07-25T00:10:00+00:00",
                        "2026-07-25T00:10:00+00:00",
                        handoff_id,
                    ),
                )

            HeartbeatState(state.path)

            with sqlite3.connect(state.path) as conn:
                handoff = conn.execute(
                    "SELECT notify_status, status, recovery_event_type, recovery_summary "
                    "FROM unrecovered_escalation_handoffs WHERE handoff_id = ?",
                    (handoff_id,),
                ).fetchone()
                event_status = conn.execute(
                    "SELECT status FROM heartbeat_events WHERE event_id = ?",
                    (result_event_id,),
                ).fetchone()[0]
            self.assertEqual(handoff[:3], ("delivered", "accepted", "cross_session_result_linked"))
            self.assertIn("accepted only", handoff[3])
            self.assertEqual(event_status, "accepted")

    def test_unrecovered_target_without_later_recovery_evidence_remains(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.log_event(
                event_type="session_decision",
                target_session="alpha",
                status="completed",
                summary="items=0; non_skip=0",
            )
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:spawn-timeout",
                error="spawn timeout",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_unrecovered_target_does_not_clear_only_because_its_window_expired(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.record_unrecovered_target(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:expired-but-unlinked",
                error="spawn timeout",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
            old = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                    (old, old),
                )

            reconciled = state.reconcile_unrecovered_targets_from_later_events()

            self.assertEqual(reconciled, [])
            with sqlite3.connect(state.path) as conn:
                remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            self.assertEqual(remaining, 1)

    def test_expired_action_cooldown_is_not_reported(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            key = {"action_type": "spawn", "target_session": "alpha", "logical_key": "alpha:issue-1"}
            for n in range(3):
                state.record_action_failure(**key, error=f"boom {n}", threshold=3, cooldown_minutes=360)
            self.assertIsNotNone(state.action_in_cooldown(**key))
            expired = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE action_failures SET cooldown_until = ?", (expired,))
            self.assertIsNone(state.action_in_cooldown(**key))

    def test_patrol_run_and_spawn_dedupe(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            db_path = state.path
            patrol_id = state.start_patrol(model="gpt-5.4-mini")
            self.assertTrue(patrol_id.startswith("patrol-"))

            first = state.try_claim_spawn(
                logical_key="scheduler:check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )
            second = state.try_claim_spawn(
                logical_key="scheduler:check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )
            self.assertTrue(first)
            self.assertFalse(second)

            state.mark_spawn_started(
                target_session="scheduler",
                logical_key="scheduler:check-0217",
                child_session_id="child-123",
            )
            state.finish_patrol(
                patrol_id,
                sessions_scanned=1,
                items_detected=1,
                alerts_sent=0,
                spawns_started=1,
                spawns_skipped_duplicate=1,
                errors=[],
            )

            with sqlite3.connect(db_path) as conn:
                run = conn.execute(
                    "SELECT status, spawns_started FROM patrol_runs WHERE patrol_id = ?",
                    (patrol_id,),
                ).fetchone()
                spawn = conn.execute(
                    """
                    SELECT status, child_session_id
                    FROM child_spawns
                    WHERE target_session = ? AND logical_key = ?
                    """,
                    ("scheduler", "scheduler:check-0217"),
                ).fetchone()
            self.assertEqual(run, ("completed", 1))
            self.assertEqual(spawn, ("running", "child-123"))

    def _spawn_status(self, state, target_session: str, logical_key: str):
        with sqlite3.connect(state.path) as conn:
            row = conn.execute(
                "SELECT status FROM child_spawns WHERE target_session = ? AND logical_key = ?",
                (target_session, logical_key),
            ).fetchone()
        return row[0] if row else None

    def test_try_claim_spawn_reclaims_failed_timeout_cancelled_but_blocks_completed_and_inflight(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            key = {"target_session": "alpha", "logical_key": "alpha:issue-1", "child_model": "m"}

            self.assertTrue(state.try_claim_spawn(**key))  # fresh claim
            state.mark_spawn_started(target_session="alpha", logical_key="alpha:issue-1", child_session_id="c1")
            self.assertFalse(state.try_claim_spawn(**key))  # in-flight running blocks

            state.mark_spawn_finished(
                target_session="alpha",
                logical_key="alpha:issue-1",
                status="completed",
                final_summary="child closure completed the evidence collection",
            )
            self.assertFalse(state.try_claim_spawn(**key))  # completed closure blocks duplicate same-key spawn

            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE child_spawns SET status = 'running' WHERE target_session = ? AND logical_key = ?",
                    ("alpha", "alpha:issue-1"),
                )

            for terminal in ("timeout", "failed", "cancelled"):
                state.mark_spawn_finished(
                    target_session="alpha", logical_key="alpha:issue-1", status=terminal, final_summary="old"
                )
                self.assertTrue(state.try_claim_spawn(**key), f"{terminal} row should be reclaimable")
                self.assertEqual(self._spawn_status(state, "alpha", "alpha:issue-1"), "claimed")
                # reclaim resets the in-flight bookkeeping so the fresh child starts clean
                with sqlite3.connect(state.path) as conn:
                    row = conn.execute(
                        "SELECT child_session_id, final_summary, async_ref, spawn_comm_id FROM child_spawns "
                        "WHERE target_session = ? AND logical_key = ?",
                        ("alpha", "alpha:issue-1"),
                    ).fetchone()
                self.assertEqual(row, (None, "", "", ""))
                state.mark_spawn_started(
                    target_session="alpha", logical_key="alpha:issue-1", child_session_id="c-next"
                )

    def test_reconcile_stale_running_spawns_reaps_past_sla(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.try_claim_spawn(target_session="a", logical_key="a:i1", child_model="m")
            state.mark_spawn_started(target_session="a", logical_key="a:i1", child_session_id="c1")
            state.try_claim_spawn(target_session="b", logical_key="b:i2", child_model="m")
            state.mark_spawn_started(target_session="b", logical_key="b:i2", child_session_id="c2")
            old = (datetime.now(timezone.utc) - timedelta(minutes=200)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE child_spawns SET created_at = ? WHERE target_session = 'a'", (old,))

            reaped = state.reconcile_stale_running_spawns(sla_minutes=180)

            self.assertEqual([(r["target_session"], r["logical_key"]) for r in reaped], [("a", "a:i1")])
            self.assertEqual(self._spawn_status(state, "a", "a:i1"), "timeout")
            self.assertEqual(self._spawn_status(state, "b", "b:i2"), "running")  # fresh running untouched
            self.assertEqual(state.reconcile_stale_running_spawns(sla_minutes=0), [])  # disabled
            self.assertEqual(state.reconcile_stale_running_spawns(sla_minutes=180), [])  # idempotent

    def _inject_todo(self, state, *, target_session: str, logical_key: str, injected_minutes_ago: int) -> str:
        record = state.enqueue_todo(
            target_session=target_session,
            logical_key=logical_key,
            message="do X",
            source_session="producer",
            source_ref=f"comm_{logical_key}",
            todo_type="spawn_closure",
        )
        todo_id = record["todo_id"]
        injected_at = (
            datetime.now(timezone.utc) - timedelta(minutes=injected_minutes_ago)
        ).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                "UPDATE session_todos SET status='injected', injected_at=?, finished_at=? WHERE todo_id=?",
                (injected_at, injected_at, todo_id),
            )
        return todo_id

    def test_injected_landing_check_window_and_transitions(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            fresh = self._inject_todo(state, target_session="alpha", logical_key="k-fresh", injected_minutes_ago=1)
            ripe = self._inject_todo(state, target_session="alpha", logical_key="k-ripe", injected_minutes_ago=10)

            due = state.list_injected_todos_for_landing_check(
                min_age_seconds=180, max_age_seconds=86400, limit=50
            )
            due_ids = {row["todo_id"] for row in due}
            self.assertIn(ripe, due_ids)
            self.assertNotIn(fresh, due_ids)  # younger than min_age

            self.assertEqual(state.mark_todos_landing_verified(todo_ids=[ripe], detail="landed"), 1)
            with sqlite3.connect(state.path) as conn:
                status = conn.execute(
                    "SELECT status FROM session_todos WHERE todo_id = ?", (ripe,)
                ).fetchone()[0]
            self.assertEqual(status, "completed")
            # guarded on status='injected' → re-transition is a no-op (idempotent, race-safe)
            self.assertEqual(state.mark_todos_landing_verified(todo_ids=[ripe], detail="again"), 0)
            self.assertEqual(state.mark_todos_landing_unconfirmed(todo_ids=[ripe], detail="x"), 0)

            other = self._inject_todo(state, target_session="beta", logical_key="k-miss", injected_minutes_ago=500)
            self.assertEqual(state.mark_todos_landing_unconfirmed(todo_ids=[other], detail="no run"), 1)
            with sqlite3.connect(state.path) as conn:
                status = conn.execute(
                    "SELECT status FROM session_todos WHERE todo_id = ?", (other,)
                ).fetchone()[0]
            self.assertEqual(status, "failed")

    def test_patrol_lifecycle_writes_authoritative_events(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            patrol_id = state.start_patrol(model="MiniMax-M2.7")
            state.finish_patrol(
                patrol_id,
                sessions_scanned=2,
                items_detected=1,
                alerts_sent=0,
                spawns_started=1,
                spawns_skipped_duplicate=0,
                errors=[],
            )

            with sqlite3.connect(state.path) as conn:
                rows = conn.execute(
                    """
                    SELECT event_type, patrol_id, status, summary
                    FROM heartbeat_events
                    ORDER BY rowid
                    """
                ).fetchall()

            self.assertEqual(rows[0][0:3], ("patrol_started", patrol_id, "running"))
            self.assertIn("MiniMax-M2.7", rows[0][3])
            self.assertEqual(rows[1][0:3], ("patrol_finished", patrol_id, "completed"))
            self.assertIn("sessions_scanned=2", rows[1][3])

    def test_event_sync_markers_are_local_authoritative_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            event_id = state.log_event(
                event_type="session_decision",
                patrol_id="patrol-1",
                target_session="alpha",
                logical_key="alpha:issue",
                decision="spawn_collect",
                child_model="gpt-5.4-mini",
                status="completed",
                summary="needs follow-up",
                source="unit-test",
            )

            unsynced = state.list_unsynced_events(limit=10)
            state.mark_events_synced([event_id], sync_ref="doc:test")
            synced = state.list_unsynced_events(limit=10)

            self.assertEqual([row["event_id"] for row in unsynced], [event_id])
            self.assertEqual(synced, [])

    def test_heartbeat_events_store_trigger_metadata_and_injected_message(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.log_event(
                event_type="user_resume_sent",
                target_session="alpha",
                logical_key="alpha:resume",
                decision="user_resume",
                status="sent",
                summary="sent",
                trigger_source="historical_stall",
                trigger_cause="continuation_checkpoint",
                trigger_location="alpha",
                injected_message="继续完成剩余步骤。",
            )

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    """
                    SELECT trigger_source, trigger_cause, trigger_location, injected_message
                    FROM heartbeat_events
                    WHERE event_type = 'user_resume_sent'
                    """
                ).fetchone()

            self.assertEqual(
                row,
                ("historical_stall", "continuation_checkpoint", "alpha", "继续完成剩余步骤。"),
            )

    def test_todo_sync_marker_is_reset_when_status_changes(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            inserted = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:todo-1",
                message="请处理待办 1。",
                batch_mode="single",
            )
            todo_id = inserted["todo_id"]
            state.mark_todos_synced([todo_id], sync_ref="base:base:todo_table:record:rec123")
            self.assertEqual(state.list_unsynced_todos(limit=10), [])

            claim = state.claim_next_todo_batch(target_session="alpha")
            state.mark_todos_injected(todo_ids=[claim.todos[0].todo_id], detail="实际注入内容")

            unsynced = state.list_unsynced_todos(limit=10)
            self.assertEqual([row["todo_id"] for row in unsynced], [todo_id])
            self.assertEqual(unsynced[0]["status"], "injected")
            self.assertEqual(unsynced[0]["detail"], "实际注入内容")

    def test_todo_aggregates_group_by_source_ref_and_track_triggered(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="comm_1:0",
                message="first result",
                source_session="supermatrix-root",
                source_ref="comm_1",
                todo_type="spawn_closure",
                expected_count=2,
            )
            state.enqueue_todo(
                target_session="alpha",
                logical_key="comm_1:1",
                message="second result",
                source_session="supermatrix-root",
                source_ref="comm_1",
                todo_type="spawn_closure",
                expected_count=2,
            )
            claim = state.claim_next_todo_batch(target_session="alpha")
            state.mark_todos_injected(
                todo_ids=[todo.todo_id for todo in claim.todos],
                detail="批量注入内容",
            )

            aggregates = state.list_unsynced_todo_aggregates(limit=10)

            self.assertEqual(len(aggregates), 1)
            self.assertEqual(aggregates[0]["aggregate_key"], "comm_1")
            self.assertEqual(aggregates[0]["item_count"], 2)
            self.assertEqual(aggregates[0]["final_status"], "injected")
            self.assertEqual(aggregates[0]["triggered"], "yes")
            self.assertEqual(aggregates[0]["latest_injected_message"], "批量注入内容")
            state.mark_todo_aggregates_synced(aggregates, sync_ref="base:base:agg")
            self.assertEqual(state.list_unsynced_todo_aggregates(limit=10), [])

    def test_unsynced_event_listing_can_include_only_successful_trigger_events(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            prefilter_skip = state.log_event(
                event_type="session_prefilter_skip",
                target_session="alpha",
                decision="skip",
                status="skipped",
                summary="no local candidate signal",
            )
            decision_skip = state.log_event(
                event_type="session_decision",
                target_session="beta",
                decision="skip",
                status="completed",
                summary="items=0; non_skip=0",
            )
            duplicate_skip = state.log_event(
                event_type="spawn_skipped_duplicate",
                target_session="gamma",
                logical_key="gamma:issue",
                decision="spawn_collect",
                status="skipped",
                summary="duplicate",
            )
            spawn_started = state.log_event(
                event_type="spawn_started",
                target_session="delta",
                logical_key="delta:issue",
                decision="spawn_collect",
                status="running",
                summary="started",
            )
            user_resume_sent = state.log_event(
                event_type="user_resume_sent",
                target_session="epsilon",
                logical_key="epsilon:issue",
                decision="user_resume",
                status="sent",
                summary="sent",
            )
            alert_sent = state.log_event(
                event_type="alert_sent",
                target_session="zeta",
                logical_key="zeta:issue",
                decision="alert",
                status="sent",
                summary="sent",
            )
            todo_enqueued = state.log_event(
                event_type="todo_enqueued",
                target_session="theta",
                logical_key="theta:todo",
                status="completed",
                summary="queued",
            )
            todo_injected = state.log_event(
                event_type="todo_injected",
                target_session="iota",
                logical_key="iota:todo",
                status="sent",
                summary="injected",
            )
            todo_skipped = state.log_event(
                event_type="todo_skipped_session_busy",
                target_session="kappa",
                logical_key="kappa:todo",
                status="skipped",
                summary="busy",
            )
            spawn_failed = state.log_event(
                event_type="spawn_failed",
                target_session="eta",
                logical_key="eta:issue",
                decision="spawn_collect",
                status="failed",
                summary="failed",
            )

            filtered = state.list_unsynced_events(
                limit=10,
                include_event_types=(
                    "spawn_started",
                    "alert_sent",
                    "user_resume_sent",
                    "todo_enqueued",
                    "todo_injected",
                    "todo_injection_failed",
                ),
            )
            all_unsynced = state.list_unsynced_events(limit=10)

            self.assertEqual(
                set(row["event_id"] for row in filtered),
                {spawn_started, user_resume_sent, alert_sent, todo_enqueued, todo_injected},
            )
            self.assertEqual(
                set(row["event_id"] for row in all_unsynced),
                {
                    prefilter_skip,
                    decision_skip,
                    duplicate_skip,
                    spawn_started,
                    user_resume_sent,
                    alert_sent,
                    todo_enqueued,
                    todo_injected,
                    todo_skipped,
                    spawn_failed,
                },
            )

    def test_patrol_state_values_are_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            self.assertIsNone(state.get_value("last_scanned_session"))
            state.set_value("last_scanned_session", "alpha")
            state.set_value("last_scanned_session", "beta")

            self.assertEqual(state.get_value("last_scanned_session"), "beta")

    def test_same_logical_key_can_be_claimed_for_different_targets(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            first = state.try_claim_spawn(
                logical_key="check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )
            second_target = state.try_claim_spawn(
                logical_key="check-0217",
                target_session="watchdog",
                child_model="gpt-5.4-mini",
            )
            duplicate_first_target = state.try_claim_spawn(
                logical_key="check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )

            self.assertTrue(first)
            self.assertTrue(second_target)
            self.assertFalse(duplicate_first_target)

    def test_old_child_spawns_schema_is_migrated_to_target_scoped_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "heartbeat.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.executescript(
                    """
                    CREATE TABLE child_spawns (
                      logical_key TEXT PRIMARY KEY,
                      target_session TEXT NOT NULL,
                      child_session_id TEXT,
                      child_model TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      last_polled_at TEXT,
                      final_summary TEXT NOT NULL DEFAULT ''
                    );
                    """
                )
                conn.execute(
                    """
                    INSERT INTO child_spawns
                      (logical_key, target_session, child_session_id, child_model, status, created_at, last_polled_at, final_summary)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        "same",
                        "scheduler",
                        "child-123",
                        "gpt-5.4-mini",
                        "running",
                        "2026-05-06T00:00:00+00:00",
                        "2026-05-06T00:10:00+00:00",
                        "still working",
                    ),
                )

            state = HeartbeatState(db_path)

            self.assertTrue(
                state.try_claim_spawn(
                    logical_key="same",
                    target_session="watchdog",
                    child_model="gpt-5.4-mini",
                )
            )
            with sqlite3.connect(db_path) as conn:
                rows = conn.execute(
                    """
                    SELECT target_session, logical_key, child_session_id, child_model, status,
                           created_at, last_polled_at, final_summary
                    FROM child_spawns
                    WHERE logical_key = ?
                    ORDER BY target_session
                    """,
                    ("same",),
                ).fetchall()
            self.assertEqual(
                rows,
                [
                    (
                        "scheduler",
                        "same",
                        "child-123",
                        "gpt-5.4-mini",
                        "running",
                        "2026-05-06T00:00:00+00:00",
                        "2026-05-06T00:10:00+00:00",
                        "still working",
                    ),
                    (
                        "watchdog",
                        "same",
                        None,
                        "gpt-5.4-mini",
                        "claimed",
                        rows[1][5],
                        None,
                        "",
                    ),
                ],
            )
            self.assertEqual(self.pk_columns(db_path), ["target_session", "logical_key"])

    def test_unsupported_child_spawns_schema_without_pk_raises(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "heartbeat.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.executescript(
                    """
                    CREATE TABLE child_spawns (
                      logical_key TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      child_session_id TEXT,
                      child_model TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      last_polled_at TEXT,
                      final_summary TEXT NOT NULL DEFAULT ''
                    );
                    """
                )

            with self.assertRaises(RuntimeError):
                HeartbeatState(db_path)

    def test_failed_old_schema_migration_rolls_back_original_table(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            db_path = Path(d) / "heartbeat.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.executescript(
                    """
                    CREATE TABLE child_spawns (
                      logical_key TEXT PRIMARY KEY,
                      target_session TEXT NOT NULL,
                      child_session_id TEXT,
                      child_model TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      last_polled_at TEXT
                    );
                    """
                )
                conn.execute(
                    """
                    INSERT INTO child_spawns
                      (logical_key, target_session, child_model, status, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    ("same", "scheduler", "gpt-5.4-mini", "claimed", "2026-05-06T00:00:00+00:00"),
                )

            with self.assertRaises(sqlite3.OperationalError):
                HeartbeatState(db_path)

            with sqlite3.connect(db_path) as conn:
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
                row = conn.execute(
                    """
                    SELECT logical_key, target_session, child_model, status, created_at
                    FROM child_spawns
                    """
                ).fetchone()

            self.assertIn("child_spawns", tables)
            self.assertNotIn("patrol_runs", tables)
            self.assertNotIn("child_spawns_old_logical_key_pk", tables)
            self.assertEqual(
                row,
                ("same", "scheduler", "gpt-5.4-mini", "claimed", "2026-05-06T00:00:00+00:00"),
            )

    def test_unstarted_spawn_claim_can_be_released_and_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            self.assertTrue(
                state.try_claim_spawn(
                    logical_key="scheduler:check-0217",
                    target_session="scheduler",
                    child_model="gpt-5.4-mini",
                )
            )
            state.release_spawn_claim(
                target_session="scheduler",
                logical_key="scheduler:check-0217",
            )

            self.assertTrue(
                state.try_claim_spawn(
                    logical_key="scheduler:check-0217",
                    target_session="scheduler",
                    child_model="gpt-5.4-mini",
                )
            )

    def test_started_spawn_claim_cannot_be_released(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.try_claim_spawn(
                logical_key="scheduler:check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )
            state.mark_spawn_started(
                target_session="scheduler",
                logical_key="scheduler:check-0217",
                child_session_id="child-123",
            )

            with self.assertRaises(KeyError):
                state.release_spawn_claim(
                    target_session="scheduler",
                    logical_key="scheduler:check-0217",
                )

    def test_spawn_claim_can_record_async_ref_without_child_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.try_claim_spawn(
                logical_key="scheduler:check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )

            state.mark_spawn_started(
                target_session="scheduler",
                logical_key="scheduler:check-0217",
                async_ref="async-1",
                spawn_comm_id="comm-1",
            )

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    """
                    SELECT status, child_session_id, async_ref, spawn_comm_id
                    FROM child_spawns
                    WHERE target_session = ? AND logical_key = ?
                    """,
                    ("scheduler", "scheduler:check-0217"),
                ).fetchone()
            self.assertEqual(row, ("running", None, "async-1", "comm-1"))

            with self.assertRaises(KeyError):
                state.release_spawn_claim(
                    target_session="scheduler",
                    logical_key="scheduler:check-0217",
                )

    def test_release_start_and_finish_are_scoped_to_target_session(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            for target in ("scheduler", "watchdog"):
                self.assertTrue(
                    state.try_claim_spawn(
                        logical_key="check-0217",
                        target_session=target,
                        child_model="gpt-5.4-mini",
                    )
                )

            state.release_spawn_claim(
                target_session="scheduler",
                logical_key="check-0217",
            )
            self.assertFalse(
                state.try_claim_spawn(
                    logical_key="check-0217",
                    target_session="watchdog",
                    child_model="gpt-5.4-mini",
                )
            )
            self.assertTrue(
                state.try_claim_spawn(
                    logical_key="check-0217",
                    target_session="scheduler",
                    child_model="gpt-5.4-mini",
                )
            )
            state.mark_spawn_started(
                target_session="watchdog",
                logical_key="check-0217",
                child_session_id="child-watchdog",
            )
            state.mark_spawn_finished(
                target_session="watchdog",
                logical_key="check-0217",
                status="completed",
                final_summary="done",
            )

            with sqlite3.connect(state.path) as conn:
                rows = conn.execute(
                    """
                    SELECT target_session, status, child_session_id
                    FROM child_spawns
                    WHERE logical_key = ?
                    ORDER BY target_session
                    """,
                    ("check-0217",),
                ).fetchall()
            self.assertEqual(
                rows,
                [
                    ("scheduler", "claimed", None),
                    ("watchdog", "completed", "child-watchdog"),
                ],
            )

    def test_missing_updates_raise_key_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            with self.assertRaises(KeyError):
                state.finish_patrol(
                    "patrol-missing",
                    sessions_scanned=0,
                    items_detected=0,
                    alerts_sent=0,
                    spawns_started=0,
                    spawns_skipped_duplicate=0,
                    errors=[],
                )
            with self.assertRaises(KeyError):
                state.mark_spawn_started(
                    target_session="scheduler",
                    logical_key="scheduler:missing",
                    child_session_id="child-123",
                )
            with self.assertRaises(KeyError):
                state.mark_spawn_finished(
                    target_session="scheduler",
                    logical_key="scheduler:missing",
                    status="completed",
                    final_summary="done",
                )
            with self.assertRaises(KeyError):
                state.release_spawn_claim(
                    target_session="scheduler",
                    logical_key="scheduler:missing",
                )

    def test_invalid_finished_status_raises_value_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.try_claim_spawn(
                logical_key="scheduler:check-0217",
                target_session="scheduler",
                child_model="gpt-5.4-mini",
            )
            state.mark_spawn_started(
                target_session="scheduler",
                logical_key="scheduler:check-0217",
                child_session_id="child-123",
            )

            with self.assertRaises(ValueError):
                state.mark_spawn_finished(
                    target_session="scheduler",
                    logical_key="scheduler:check-0217",
                    status="running",
                    final_summary="not terminal",
                )

    def test_allowed_finished_statuses_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            for status in ("completed", "failed", "cancelled", "timeout"):
                logical_key = f"scheduler:{status}"
                with self.subTest(status=status):
                    state.try_claim_spawn(
                        logical_key=logical_key,
                        target_session="scheduler",
                        child_model="gpt-5.4-mini",
                    )
                    state.mark_spawn_started(
                        target_session="scheduler",
                        logical_key=logical_key,
                        child_session_id=f"child-{status}",
                    )
                    state.mark_spawn_finished(
                        target_session="scheduler",
                        logical_key=logical_key,
                        status=status,
                        final_summary=f"{status} summary",
                    )

            with sqlite3.connect(state.path) as conn:
                statuses = [
                    row[0]
                    for row in conn.execute(
                        """
                        SELECT status
                        FROM child_spawns
                        WHERE target_session = ?
                        ORDER BY logical_key
                        """,
                        ("scheduler",),
                    ).fetchall()
                ]
            self.assertEqual(statuses, ["cancelled", "completed", "failed", "timeout"])

    def test_empty_spawn_claim_fields_raise_value_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            cases = [
                {"logical_key": "", "target_session": "scheduler", "child_model": "gpt-5.4-mini"},
                {"logical_key": "check-0217", "target_session": "", "child_model": "gpt-5.4-mini"},
                {"logical_key": "check-0217", "target_session": "scheduler", "child_model": ""},
            ]
            for kwargs in cases:
                with self.subTest(kwargs=kwargs):
                    with self.assertRaises(ValueError):
                        state.try_claim_spawn(**kwargs)

    def test_enqueue_todo_inserts_pending_row_with_auto_batch(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            result = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-1",
                message="请处理第一个待办。",
                source="test",
                source_session="source-a",
                source_ref="parent-run-1",
                todo_type="research",
                expected_count=2,
            )

            self.assertEqual(result["status"], "inserted")
            self.assertTrue(result["batch_key"].startswith("auto:alpha:source-a:research:"))
            with sqlite3.connect(state.path) as conn:
                todo = conn.execute(
                    """
                    SELECT target_session, logical_key, batch_key, status, message, source_session, source_ref, todo_type, source
                    FROM session_todos
                    """
                ).fetchone()
                event = conn.execute(
                    """
                    SELECT event_type, status, summary
                    FROM heartbeat_events
                    WHERE event_type = 'todo_enqueued'
                    """
                ).fetchone()
                batch = conn.execute(
                    """
                    SELECT batch_key, target_session, source_session, source_ref, todo_type, status, expected_count, item_count
                    FROM todo_batches
                    """
                ).fetchone()
            self.assertEqual(
                todo,
                (
                    "alpha",
                    "alpha:task-1",
                    result["batch_key"],
                    "pending",
                    "请处理第一个待办。",
                    "source-a",
                    "parent-run-1",
                    "research",
                    "test",
                ),
            )
            self.assertEqual(event, ("todo_enqueued", "pending", "请处理第一个待办。"))
            self.assertEqual(batch, (result["batch_key"], "alpha", "source-a", "parent-run-1", "research", "open", 2, 1))

    def test_enqueue_todo_is_idempotent_by_target_and_logical_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            first = state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="请处理第一个待办。")
            second = state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="请处理第一个待办。")

            self.assertEqual(first["status"], "inserted")
            self.assertEqual(second["status"], "duplicate")
            self.assertEqual(first["todo_id"], second["todo_id"])
            with sqlite3.connect(state.path) as conn:
                count = conn.execute("SELECT COUNT(*) FROM session_todos").fetchone()[0]
            self.assertEqual(count, 1)

    def test_enqueue_todo_rejects_target_without_heartbeat_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            result = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-1",
                message="请处理第一个待办。",
                target_heartbeat_enabled=False,
            )

            self.assertEqual(
                result,
                {
                    "status": "target_not_heartbeat_enabled",
                    "target_session": "alpha",
                },
            )
            with sqlite3.connect(state.path) as conn:
                count = conn.execute("SELECT COUNT(*) FROM session_todos").fetchone()[0]
            self.assertEqual(count, 0)

    def test_pause_session_records_active_pause_and_event(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            result = state.pause_session(session_name="alpha", minutes=100, reason="manual pause")

            self.assertEqual(result["status"], "paused")
            self.assertIsNotNone(state.active_pause_for_session("alpha"))
            with sqlite3.connect(state.path) as conn:
                event = conn.execute(
                    """
                    SELECT event_type, target_session, status, summary
                    FROM heartbeat_events
                    WHERE event_type = 'heartbeat_paused'
                    """
            ).fetchone()
        self.assertEqual(event, ("heartbeat_paused", "alpha", "paused", "manual pause"))

    def test_pause_session_until_records_exact_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            expires_at = datetime(2099, 12, 31, 8, 5, tzinfo=timezone.utc)

            result = state.pause_session_until(
                session_name="alpha",
                expires_at=expires_at,
                reason="provider limit reset",
                source="provider_limit_auto_pause",
            )

            self.assertEqual(result["status"], "paused")
            self.assertEqual(result["expires_at"], "2099-12-31T08:05:00+00:00")
            pause = state.active_pause_for_session("alpha")
            self.assertIsNotNone(pause)
            self.assertEqual(pause["expires_at"], "2099-12-31T08:05:00+00:00")

    def test_provider_limit_pause_records_exact_expiry_by_scope_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            expires_at = datetime(2099, 12, 31, 8, 5, tzinfo=timezone.utc)

            result = state.pause_provider_limit(
                scope_key="backend_model:claude:claude-opus-4-8",
                expires_at=expires_at,
                reason="weekly limit reset",
                source="provider_limit_auto_pause",
            )

            self.assertEqual(result["status"], "paused")
            pause = state.active_provider_limit_pause("backend_model:claude:claude-opus-4-8")
            self.assertIsNotNone(pause)
            self.assertEqual(pause["expires_at"], "2099-12-31T08:05:00+00:00")
            self.assertEqual(pause["reason"], "weekly limit reset")

    def test_provider_recovery_only_resumes_auto_pauses_linked_to_that_scope(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            expires_at = datetime(2099, 12, 31, 8, 5, tzinfo=timezone.utc)
            recovered_scope = "backend_model:codex:gpt-5.6-terra"
            other_scope = "backend_model:claude:claude-fable-5"
            state.pause_provider_limit(scope_key=recovered_scope, expires_at=expires_at)
            state.pause_session_for_active_provider_limit(
                scope_key=recovered_scope,
                session_name="alpha",
            )
            state.pause_session(session_name="manual", minutes=60, reason="user pause")
            state.pause_provider_limit(scope_key=other_scope, expires_at=expires_at)
            state.pause_session_for_active_provider_limit(
                scope_key=other_scope,
                session_name="other-model",
            )

            result = state.recover_provider_limit_pause(
                scope_key=recovered_scope,
                evidence_run_id="mr_success",
                evidence_at=datetime.now(timezone.utc),
            )

            self.assertEqual(result["linked_sessions"], ["alpha"])
            self.assertIsNone(state.active_pause_for_session("alpha"))
            self.assertIsNotNone(state.active_pause_for_session("manual"))
            self.assertIsNotNone(state.active_pause_for_session("other-model"))
            self.assertIsNotNone(state.active_provider_limit_pause(other_scope))
            self.assertIsNone(
                state.pause_session_for_active_provider_limit(
                    scope_key=recovered_scope,
                    session_name="late-peer",
                )
            )
            self.assertIsNone(state.active_pause_for_session("late-peer"))

    def test_resume_session_clears_pause_and_records_event(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.pause_session(session_name="alpha", minutes=60)

            result = state.resume_session(session_name="alpha", reason="manual resume")

            self.assertEqual(result["previous_status"], "paused")
            self.assertIsNone(state.active_pause_for_session("alpha"))
            with sqlite3.connect(state.path) as conn:
                event = conn.execute(
                    """
                    SELECT event_type, target_session, status, summary
                    FROM heartbeat_events
                    WHERE event_type = 'heartbeat_resumed'
                    """
                ).fetchone()
            self.assertEqual(event, ("heartbeat_resumed", "alpha", "resumed", "manual resume"))

    def test_source_ref_reuses_auto_batch_key(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            first = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-1",
                message="方向一",
                source_session="source-a",
                source_ref="parent-run-1",
                todo_type="research",
                expected_count=2,
            )
            second = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-2",
                message="方向二",
                source_session="source-a",
                source_ref="parent-run-1",
                todo_type="research",
                expected_count=2,
            )

            self.assertEqual(first["batch_key"], second["batch_key"])
            with sqlite3.connect(state.path) as conn:
                item_count = conn.execute("SELECT item_count FROM todo_batches WHERE batch_key = ?", (first["batch_key"],)).fetchone()[0]
            self.assertEqual(item_count, 2)

    def test_explicit_batch_key_groups_different_source_refs(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)

            first = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-1",
                message="第一条子 session 结果",
                source_session="socail-king",
                source_ref="comm_1",
                todo_type="spawn_closure",
                batch_key="mr_parent_run_1",
                expected_count=2,
            )
            second = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-2",
                message="第二条子 session 结果",
                source_session="socail-king",
                source_ref="comm_2",
                todo_type="spawn_closure",
                batch_key="mr_parent_run_1",
                expected_count=2,
            )

            self.assertEqual(first["batch_key"], "mr_parent_run_1")
            self.assertEqual(second["batch_key"], "mr_parent_run_1")
            with sqlite3.connect(state.path) as conn:
                batch = conn.execute(
                    """
                    SELECT batch_key, source_ref, item_count, expected_count
                    FROM todo_batches
                    WHERE batch_key = ?
                    """,
                    ("mr_parent_run_1",),
                ).fetchone()
                todo_refs = conn.execute(
                    """
                    SELECT source_ref
                    FROM session_todos
                    WHERE batch_key = ?
                    ORDER BY logical_key
                    """,
                    ("mr_parent_run_1",),
                ).fetchall()

            self.assertEqual(batch, ("mr_parent_run_1", "comm_1", 2, 2))
            self.assertEqual(todo_refs, [("comm_1",), ("comm_2",)])

    def test_pending_batch_waits_for_session_explains_unready_batch(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            result = state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-1",
                message="第一条子 session 结果",
                source_session="socail-king",
                source_ref="comm-parent",
                todo_type="spawn_closure",
                expected_count=2,
                settle_after_seconds=600,
                max_wait_seconds=1800,
            )

            waits = state.pending_batch_waits_for_session("alpha")

            self.assertEqual(len(waits), 1)
            self.assertEqual(waits[0]["batch_key"], result["batch_key"])
            self.assertEqual(waits[0]["item_count"], 1)
            self.assertEqual(waits[0]["expected_count"], 2)
            self.assertEqual(waits[0]["expected_remaining"], 1)
            self.assertGreater(waits[0]["seconds_until_settle"], 0)
            self.assertGreater(waits[0]["seconds_until_max_wait"], 0)

    def test_claim_ready_batch_by_expected_count_marks_all_todos_claimed(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-1",
                message="方向一",
                source_ref="parent-run-1",
                expected_count=2,
            )
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-2",
                message="方向二",
                source_ref="parent-run-1",
                expected_count=2,
            )

            claim = state.claim_next_todo_batch(target_session="alpha")

            self.assertIsNotNone(claim)
            self.assertEqual(len(claim.todos), 2)
            self.assertEqual([todo.message for todo in claim.todos], ["方向一", "方向二"])
            with sqlite3.connect(state.path) as conn:
                statuses = conn.execute("SELECT status FROM session_todos ORDER BY logical_key").fetchall()
                batch_status = conn.execute("SELECT status FROM todo_batches WHERE batch_key = ?", (claim.batch_key,)).fetchone()[0]
            self.assertEqual(statuses, [("claimed",), ("claimed",)])
            self.assertEqual(batch_status, "claimed")

    def test_single_mode_claims_oldest_unbatched_todo(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="第一条", batch_mode="single")
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-2", message="第二条", batch_mode="single")

            claim = state.claim_next_todo_batch(target_session="alpha")

            self.assertIsNotNone(claim)
            self.assertIsNone(claim.batch_key)
            self.assertEqual([todo.logical_key for todo in claim.todos], ["alpha:task-1"])

    def test_claim_keeps_old_spawn_closure_todo_until_explicitly_resolved(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="spawn-closure:comm-1",
                message="旧兜底结果",
                todo_type="spawn_closure",
                batch_mode="single",
            )
            old_created_at = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute(
                    "UPDATE session_todos SET created_at = ? WHERE logical_key = 'spawn-closure:comm-1'",
                    (old_created_at,),
                )

            claim = state.claim_next_todo_batch(target_session="alpha", todo_types={"spawn_closure"})

            self.assertIsNotNone(claim)
            self.assertEqual([todo.logical_key for todo in claim.todos], ["spawn-closure:comm-1"])
            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT status, finished_at IS NOT NULL, detail FROM session_todos WHERE logical_key = 'spawn-closure:comm-1'"
                ).fetchone()
            self.assertEqual(row, ("claimed", 0, ""))

    def test_mark_todos_injected_keeps_todo_nonterminal_until_landing(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="第一条", batch_mode="single")
            claim = state.claim_next_todo_batch(target_session="alpha")

            state.mark_todos_injected(todo_ids=[claim.todos[0].todo_id], detail="sent message")

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT status, injected_at IS NOT NULL, finished_at IS NOT NULL, detail FROM session_todos WHERE todo_id = ?",
                    (claim.todos[0].todo_id,),
                ).fetchone()
            self.assertEqual(row, ("injected", 1, 0, "sent message"))

    def test_reconcile_stale_action_claims_marks_claimed_rows_failed(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            self.assertTrue(
                state.try_claim_action(
                    action_type="user_resume",
                    target_session="alpha",
                    logical_key="alpha:resume-1",
                )
            )
            old = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE action_claims SET created_at = ?", (old,))

            rows = state.reconcile_stale_action_claims(max_age_minutes=360)

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["target_session"], "alpha")
            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT status, finished_at IS NOT NULL, detail FROM action_claims"
                ).fetchone()
            self.assertEqual(row, ("failed", 1, "auto-reconciled: claimed action exceeded 360m SLA"))

    def test_mark_todos_failed_records_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="第一条", batch_mode="single")
            claim = state.claim_next_todo_batch(target_session="alpha")

            state.mark_todos_failed(todo_ids=[claim.todos[0].todo_id], detail="send failed")

            with sqlite3.connect(state.path) as conn:
                row = conn.execute("SELECT status, finished_at IS NOT NULL, detail FROM session_todos WHERE todo_id = ?", (claim.todos[0].todo_id,)).fetchone()
            self.assertEqual(row, ("failed", 1, "send failed"))

    def test_mark_todos_cleared_records_terminal_fields(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="第一条", batch_mode="single")
            claim = state.claim_next_todo_batch(target_session="alpha")

            state.mark_todos_cleared(todo_ids=[claim.todos[0].todo_id], detail="no action needed")

            with sqlite3.connect(state.path) as conn:
                row = conn.execute(
                    "SELECT status, injected_at IS NULL, finished_at IS NOT NULL, detail FROM session_todos WHERE todo_id = ?",
                    (claim.todos[0].todo_id,),
                ).fetchone()
            self.assertEqual(row, ("cleared", 1, 1, "no action needed"))

    def test_release_todo_claim_returns_todo_and_batch_to_pending(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:task-1",
                message="第一条",
                source_ref="parent-1",
                expected_count=1,
            )
            claim = state.claim_next_todo_batch(target_session="alpha")

            state.release_todo_claim(todo_ids=[claim.todos[0].todo_id], detail="send failed; will retry")

            with sqlite3.connect(state.path) as conn:
                todo = conn.execute(
                    "SELECT status, claimed_at IS NULL, finished_at IS NULL, detail FROM session_todos WHERE todo_id = ?",
                    (claim.todos[0].todo_id,),
                ).fetchone()
                batch = conn.execute(
                    "SELECT status, detail FROM todo_batches WHERE batch_key = ?",
                    (claim.batch_key,),
                ).fetchone()
            self.assertEqual(todo, ("pending", 1, 1, "send failed; will retry"))
            self.assertEqual(batch, ("open", "send failed; will retry"))

    def test_target_idle_bypasses_settle_for_has_claimable_and_claim(self) -> None:
        # 目标 session 已经 idle 时，settle window 还没到期不应该再卡住注入：
        # has_claimable_todo / claim_next_todo_batch 收到 target_idle=True 直接放行。
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-1",
                message="请处理子结果。",
                source_session="child-a",
                source_ref="comm-1",
                todo_type="spawn_closure",
                settle_after_seconds=600,
                max_wait_seconds=1800,
            )

            # 默认路径仍受 settle 限制（保留向后兼容）。
            self.assertFalse(state.has_claimable_todo("alpha"))
            self.assertIsNone(state.claim_next_todo_batch(target_session="alpha"))

            # target_idle=True 直接放行未 settle 的 batch。
            self.assertTrue(state.has_claimable_todo("alpha", target_idle=True))
            claim = state.claim_next_todo_batch(target_session="alpha", target_idle=True)
            self.assertIsNotNone(claim)
            self.assertEqual(len(claim.todos), 1)
            self.assertEqual(claim.todos[0].logical_key, "alpha:comm-1")

    def test_target_idle_still_respects_unmet_expected_count(self) -> None:
        # expected_count 是显式同步意图，target_idle bypass 仍要让 batch 继续等齐。
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-1",
                message="第一条子结果。",
                source_session="child-a",
                source_ref="parent-run",
                todo_type="spawn_closure",
                expected_count=2,
                settle_after_seconds=600,
                max_wait_seconds=1800,
            )
            self.assertFalse(state.has_claimable_todo("alpha", target_idle=True))
            self.assertIsNone(state.claim_next_todo_batch(target_session="alpha", target_idle=True))

    def test_target_idle_fires_when_max_wait_passed_even_under_expected_count(self) -> None:
        # max_wait_seconds 仍是 expected_count 的 backstop：到点之后即使期望数没满，target_idle 也该投递。
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(
                target_session="alpha",
                logical_key="alpha:comm-1",
                message="第一条子结果。",
                source_session="child-a",
                source_ref="parent-run",
                todo_type="spawn_closure",
                expected_count=2,
                settle_after_seconds=600,
                max_wait_seconds=1800,
            )
            backdated = (datetime.now(timezone.utc) - timedelta(seconds=2000)).isoformat(timespec="seconds")
            with sqlite3.connect(state.path) as conn:
                conn.execute("UPDATE todo_batches SET created_at = ?", (backdated,))
            self.assertTrue(state.has_claimable_todo("alpha", target_idle=True))
            claim = state.claim_next_todo_batch(target_session="alpha", target_idle=True)
            self.assertIsNotNone(claim)


if __name__ == "__main__":
    unittest.main()
