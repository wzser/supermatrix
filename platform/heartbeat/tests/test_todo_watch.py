import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from heartbeat_patrol.state import HeartbeatState
from heartbeat_patrol.todo_watch import WatchSettings, run_todo_watch


class FakeWatchReader:
    """Scripted reader: each list is consumed per call; the last value repeats."""

    def __init__(self, *, name="alpha", statuses=None, run_statuses=None, heartbeat_enabled=1):
        self.name = name
        self.statuses = list(statuses or ["idle"])
        self.run_statuses = list(run_statuses or ["completed"])
        self.heartbeat_enabled = heartbeat_enabled

    @staticmethod
    def _next(seq):
        if len(seq) > 1:
            return seq.pop(0)
        return seq[0]

    def get_session_by_name(self, name):
        if name != self.name:
            return None
        return {
            "id": "s1",
            "name": self.name,
            "group_id": "oc_alpha",
            "status": self._next(self.statuses),
            "heartbeat_enabled": self.heartbeat_enabled,
        }

    def latest_run_status(self, session_id):
        return self._next(self.run_statuses)


class VirtualClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class TodoWatchLoopTest(unittest.TestCase):
    def make_state(self) -> HeartbeatState:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return HeartbeatState(Path(tmp.name) / "heartbeat.sqlite")

    def enqueue_single(self, state: HeartbeatState, *, key="alpha:todo-1") -> None:
        state.enqueue_todo(
            target_session="alpha",
            logical_key=key,
            message="请处理待办 1。",
            batch_mode="single",
        )

    def settings(self, **overrides) -> WatchSettings:
        defaults = {"poll_seconds": 5.0, "idle_debounce_seconds": 8.0, "max_minutes": 45.0}
        defaults.update(overrides)
        return WatchSettings(**defaults)

    def event_types(self, state: HeartbeatState) -> list[tuple[str, str]]:
        with sqlite3.connect(state.path) as conn:
            rows = conn.execute(
                "SELECT event_type, status FROM heartbeat_events ORDER BY rowid"
            ).fetchall()
        return [(row[0], row[1]) for row in rows]

    def test_fires_after_busy_to_idle_debounce_then_exits_drained(self):
        state = self.make_state()
        self.enqueue_single(state)
        reader = FakeWatchReader(statuses=["busy", "idle", "idle"])
        vc = VirtualClock()
        fire_calls = []

        def fire():
            fire_calls.append(vc.now)
            claim = state.claim_next_todo_batch(target_session="alpha")
            state.mark_todos_injected(
                todo_ids=[todo.todo_id for todo in claim.todos], detail="injected by fake patrol"
            )

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=fire,
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "drained")
        self.assertEqual(result["fired"], 1)
        # busy poll(5s) -> idle observed -> debounce(8s) -> fire -> post-fire poll(5s) -> drained
        self.assertEqual(vc.sleeps[:2], [5.0, 8.0])
        self.assertEqual(fire_calls, [13.0])
        events = self.event_types(state)
        self.assertIn(("todo_watch_started", "started"), events)
        self.assertIn(("todo_watch_fired", "started"), events)
        self.assertIn(("todo_watch_finished", "drained"), events)
        # claim released on exit
        self.assertTrue(
            state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000)
        )

    def test_never_idle_expires_at_deadline_without_firing(self):
        state = self.make_state()
        self.enqueue_single(state)
        reader = FakeWatchReader(statuses=["busy"])
        vc = VirtualClock()
        fire_calls = []

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: fire_calls.append(vc.now),
            settings=self.settings(max_minutes=0.5),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "expired")
        self.assertEqual(result["fired"], 0)
        self.assertEqual(fire_calls, [])
        self.assertGreaterEqual(vc.now, 30.0)
        self.assertIn(("todo_watch_finished", "expired"), self.event_types(state))

    def test_idle_flipping_back_to_running_during_debounce_does_not_fire(self):
        state = self.make_state()
        self.enqueue_single(state)
        # eligibility fetch sees idle, debounce recheck sees busy, then idle/idle -> fire
        reader = FakeWatchReader(statuses=["idle", "busy", "idle", "idle"])
        vc = VirtualClock()
        fire_calls = []

        def fire():
            fire_calls.append(vc.now)
            claim = state.claim_next_todo_batch(target_session="alpha")
            state.mark_todos_injected(
                todo_ids=[todo.todo_id for todo in claim.todos], detail="injected by fake patrol"
            )

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=fire,
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["fired"], 1)
        # first debounce aborted: sleeps start with debounce(8) then debounce(8) again before fire
        self.assertEqual(fire_calls, [16.0])

    def test_running_latest_run_blocks_fire_even_when_session_status_idle(self):
        state = self.make_state()
        self.enqueue_single(state)
        reader = FakeWatchReader(statuses=["idle"], run_statuses=["running"])
        vc = VirtualClock()
        fire_calls = []

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: fire_calls.append(vc.now),
            settings=self.settings(max_minutes=0.5),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "expired")
        self.assertEqual(fire_calls, [])

    def test_second_watcher_exits_already_active(self):
        state = self.make_state()
        self.enqueue_single(state)
        self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))
        reader = FakeWatchReader(statuses=["idle"])
        vc = VirtualClock()
        fire_calls = []

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: fire_calls.append(vc.now),
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "already_active")
        self.assertEqual(fire_calls, [])
        self.assertIn(("todo_watch_already_active", "skipped"), self.event_types(state))
        # the foreign claim must survive
        self.assertFalse(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))

    def test_active_pause_aborts_watch(self):
        state = self.make_state()
        self.enqueue_single(state)
        state.pause_session(session_name="alpha", minutes=60, reason="manual pause")
        reader = FakeWatchReader(statuses=["idle"])
        vc = VirtualClock()
        fire_calls = []

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: fire_calls.append(vc.now),
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "paused")
        self.assertEqual(fire_calls, [])
        self.assertIn(("todo_watch_finished", "paused"), self.event_types(state))

    def test_ineligible_target_aborts_watch(self):
        state = self.make_state()
        self.enqueue_single(state)
        reader = FakeWatchReader(statuses=["idle"], heartbeat_enabled=0)
        vc = VirtualClock()

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: None,
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "target_ineligible")

    def test_idle_target_fires_immediately_even_with_unsettled_batch(self):
        # 之前的逻辑：watcher 在 fire 之前要等 batch settle（默认 600s），
        # target 早已 idle 也得一直空等。新行为：只要 target idle，watcher debounce 8s 即开火，
        # settle 仅是 idle 没法确认时的兜底（在 state 层只对 expected_count + 时间窗保留兜底）。
        state = self.make_state()
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
        reader = FakeWatchReader(statuses=["idle"])
        vc = VirtualClock()
        fire_calls = []

        def fire():
            fire_calls.append(vc.now)
            claim = state.claim_next_todo_batch(target_session="alpha", target_idle=True)
            self.assertIsNotNone(claim)
            state.mark_todos_injected(
                todo_ids=[todo.todo_id for todo in claim.todos], detail="injected by fake patrol"
            )

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=fire,
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        # idle 第一次观察就 debounce 8s 后开火，注入完成后 pool 排空。
        self.assertEqual(result["status"], "drained")
        self.assertEqual(result["fired"], 1)
        self.assertEqual(fire_calls, [8.0])
        self.assertIn(("todo_watch_fired", "started"), self.event_types(state))

    def test_busy_target_with_unsettled_batch_polls_at_poll_seconds(self):
        # 用户没说的等价面：target busy 时不该被 settle 间隔反弹成 30s 长睡，
        # 仍按 poll_seconds 节奏唤醒，让 busy→idle 切换能在一个 poll 内被发现。
        state = self.make_state()
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
        reader = FakeWatchReader(statuses=["busy"])
        vc = VirtualClock()
        fire_calls = []

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=lambda: fire_calls.append(vc.now),
            settings=self.settings(max_minutes=0.5),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "expired")
        self.assertEqual(fire_calls, [])
        # busy 路径只睡 poll_seconds（5s），不要再退化成 settle ETA 长睡。
        self.assertTrue(all(seconds == 5.0 for seconds in vc.sleeps), vc.sleeps)

    def test_ready_batch_fires_after_settle_backdated(self):
        state = self.make_state()
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
        backdated = (datetime.now(timezone.utc) - timedelta(seconds=700)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute("UPDATE todo_batches SET last_item_at = ?, created_at = ?", (backdated, backdated))
        reader = FakeWatchReader(statuses=["idle", "idle"])
        vc = VirtualClock()

        def fire():
            claim = state.claim_next_todo_batch(target_session="alpha")
            state.mark_todos_injected(
                todo_ids=[todo.todo_id for todo in claim.todos], detail="injected by fake patrol"
            )

        result = run_todo_watch(
            state=state,
            reader=reader,
            target_session="alpha",
            fire_patrol=fire,
            settings=self.settings(),
            sleep=vc.sleep,
            clock=vc.clock,
        )

        self.assertEqual(result["status"], "drained")
        self.assertEqual(result["fired"], 1)


class TodoWatchStateTest(unittest.TestCase):
    def make_state(self) -> HeartbeatState:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return HeartbeatState(Path(tmp.name) / "heartbeat.sqlite")

    def test_claim_is_exclusive_until_released(self):
        state = self.make_state()
        self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))
        self.assertFalse(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))
        self.assertTrue(state.todo_watch_claim_active("alpha", stale_after_seconds=3000))
        # other targets are independent
        self.assertTrue(state.try_claim_todo_watch(target_session="beta", stale_after_seconds=3000))
        state.release_todo_watch("alpha")
        self.assertFalse(state.todo_watch_claim_active("alpha", stale_after_seconds=3000))
        self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))

    def test_stale_claim_is_taken_over(self):
        state = self.make_state()
        self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))
        stale = (datetime.now(timezone.utc) - timedelta(seconds=4000)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                "UPDATE action_claims SET created_at = ? WHERE action_type = 'todo_watch'",
                (stale,),
            )
        self.assertFalse(state.todo_watch_claim_active("alpha", stale_after_seconds=3000))
        self.assertTrue(state.try_claim_todo_watch(target_session="alpha", stale_after_seconds=3000))
        self.assertTrue(state.todo_watch_claim_active("alpha", stale_after_seconds=3000))

    def test_has_claimable_todo_for_single_and_settled_batch(self):
        state = self.make_state()
        self.assertFalse(state.has_claimable_todo("alpha"))

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
        self.assertFalse(state.has_claimable_todo("alpha"))  # settle window still open

        backdated = (datetime.now(timezone.utc) - timedelta(seconds=700)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute("UPDATE todo_batches SET last_item_at = ?", (backdated,))
        self.assertTrue(state.has_claimable_todo("alpha"))

        claim = state.claim_next_todo_batch(target_session="alpha")
        self.assertIsNotNone(claim)
        self.assertFalse(state.has_claimable_todo("alpha"))  # claimed batch is no longer claimable

        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-2",
            message="请处理待办 2。",
            batch_mode="single",
        )
        self.assertTrue(state.has_claimable_todo("alpha"))  # singles are immediately claimable

    def test_has_claimable_todo_with_expected_count_met(self):
        state = self.make_state()
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:comm-1",
            message="请处理子结果。",
            source_session="child-a",
            source_ref="comm-1",
            todo_type="spawn_closure",
            expected_count=1,
            settle_after_seconds=600,
            max_wait_seconds=1800,
        )
        self.assertTrue(state.has_claimable_todo("alpha"))

    def test_has_claimable_todo_respects_todo_types_filter(self):
        state = self.make_state()
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-1",
            message="请处理待办 1。",
            todo_type="general",
            batch_mode="single",
        )
        self.assertTrue(state.has_claimable_todo("alpha"))
        self.assertFalse(state.has_claimable_todo("alpha", todo_types={"spawn_closure"}))


class TodoWatchScriptTest(unittest.TestCase):
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
            conn.execute("INSERT INTO bindings (session_id, group_id) VALUES ('s1', 'oc_alpha')")

    def test_script_exits_drained_when_pool_is_empty(self):
        repo = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as d:
            sm_db = Path(d) / "supermatrix.db"
            hb_db = Path(d) / "heartbeat.sqlite"
            self.create_sm_db(sm_db)
            HeartbeatState(hb_db)
            env = os.environ.copy()
            env["SM_DB_PATH"] = str(sm_db)
            env["HEARTBEAT_STATE_DB"] = str(hb_db)

            completed = subprocess.run(
                [str(repo / "scripts" / "heartbeat-todo-watch"), "--session", "alpha"],
                env=env,
                text=True,
                capture_output=True,
                timeout=15,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertEqual(payload["status"], "drained")
            self.assertEqual(payload["fired"], 0)
            with sqlite3.connect(hb_db) as conn:
                claims = conn.execute(
                    "SELECT COUNT(*) FROM action_claims WHERE action_type = 'todo_watch'"
                ).fetchone()[0]
            self.assertEqual(claims, 0)


if __name__ == "__main__":
    unittest.main()
