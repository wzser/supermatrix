import sqlite3
import tempfile
import unittest
from pathlib import Path

from heartbeat_patrol.state import HeartbeatState


class HeartbeatStateTest(unittest.TestCase):
    def new_state(self, d: str) -> HeartbeatState:
        return HeartbeatState(Path(d) / "heartbeat.sqlite")

    def pk_columns(self, db_path: Path) -> list[str]:
        with sqlite3.connect(db_path) as conn:
            rows = conn.execute("PRAGMA table_info(child_spawns)").fetchall()
        return [name for _, name in sorted((row[5], row[1]) for row in rows if row[5])]

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

    def test_mark_todos_injected_sets_terminal_fields(self) -> None:
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
            self.assertEqual(row, ("injected", 1, 1, "sent message"))

    def test_mark_todos_failed_records_error(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            state = self.new_state(d)
            state.enqueue_todo(target_session="alpha", logical_key="alpha:task-1", message="第一条", batch_mode="single")
            claim = state.claim_next_todo_batch(target_session="alpha")

            state.mark_todos_failed(todo_ids=[claim.todos[0].todo_id], detail="send failed")

            with sqlite3.connect(state.path) as conn:
                row = conn.execute("SELECT status, finished_at IS NOT NULL, detail FROM session_todos WHERE todo_id = ?", (claim.todos[0].todo_id,)).fetchone()
            self.assertEqual(row, ("failed", 1, "send failed"))


if __name__ == "__main__":
    unittest.main()
