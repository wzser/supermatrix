import json
import os
import re
import sqlite3
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from heartbeat_patrol.api import HeartbeatApi, strip_minimax_thinking
from heartbeat_patrol.decision import DecisionItem
from heartbeat_patrol.state import HeartbeatState


class FakeReader:
    def __init__(self, sessions=None, *, packet_overrides=None):
        self.sessions = sessions or [
            {
                "id": "s1",
                "name": "alpha",
                "group_id": "oc_alpha",
            }
        ]
        self.packet_overrides = packet_overrides or {}
        self.session = self.sessions[0]
        self.packets_built = 0
        self.built_session_names = []

    def list_enabled_sessions(self):
        return self.sessions

    def build_packet(self, session, *, max_recent_runs):
        self.packets_built += 1
        self.built_session_names.append(session["name"])
        packet = {"session": session, "recent_runs": [], "recent_cross_session": []}
        packet.update(self.packet_overrides)
        return packet


class FailingListReader:
    def list_enabled_sessions(self):
        raise RuntimeError("reader exploded")


class FakeApi:
    def __init__(self, controller_responses, *, spawn_failures=None):
        self.controller_responses = list(controller_responses)
        self.spawn_failures = list(spawn_failures or [])
        self.controller_calls = []
        self.active_controller_calls = 0
        self.max_active_controller_calls = 0
        self.spawn_calls = []
        self.alerts = []
        self.resume_compose_calls = []
        self.user_messages = []

    def run_controller_decision(self, prompt, model):
        self.active_controller_calls += 1
        self.max_active_controller_calls = max(self.max_active_controller_calls, self.active_controller_calls)
        self.controller_calls.append((prompt, model))
        try:
            if not self.controller_responses:
                raise AssertionError("unexpected controller call")
            response = self.controller_responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return response
        finally:
            self.active_controller_calls -= 1

    def spawn_child(self, target, prompt, model):
        self.spawn_calls.append((target, prompt, model))
        if self.spawn_failures:
            failure = self.spawn_failures.pop(0)
            if failure is not None:
                raise failure
        return {"ok": True, "childSessionId": f"child-{len(self.spawn_calls)}"}

    def send_alert(self, chat_id, text):
        self.alerts.append((chat_id, text))

    def compose_user_resume_message(self, *, item, target_session, model):
        self.resume_compose_calls.append((item, target_session, model))
        return "继续推进刚才没做完的部分，完成后直接回报结果。"

    def send_user_message(self, chat_id, text):
        self.user_messages.append((chat_id, text))


def decision_json(*items, session="alpha"):
    return json.dumps({"session": session, "items": list(items)})


def spawn_item(logical_key="alpha:issue-1"):
    return {
        "logical_key": logical_key,
        "severity": "warn",
        "decision": "spawn_collect",
        "reason": "needs evidence",
        "target_session": "alpha",
        "child_model": "gpt-5.4-mini",
        "prompt": "Collect evidence and report status.",
    }


def skip_item(logical_key="alpha:skip-1"):
    item = spawn_item(logical_key)
    item["decision"] = "skip"
    return item


def user_resume_item(logical_key="alpha:resume-1"):
    item = spawn_item(logical_key)
    item["decision"] = "user_resume"
    item["reason"] = "latest run stopped at a continuation checkpoint"
    item["prompt"] = "Compose a natural user reply that asks alpha to continue the unfinished steps."
    return item


class BlockingApi(FakeApi):
    def __init__(self, controller_responses, release_after):
        super().__init__(controller_responses)
        import threading

        self.release_after = release_after
        self.condition = threading.Condition()

    def run_controller_decision(self, prompt, model):
        with self.condition:
            self.active_controller_calls += 1
            self.max_active_controller_calls = max(self.max_active_controller_calls, self.active_controller_calls)
            self.controller_calls.append((prompt, model))
            self.condition.notify_all()
            while self.max_active_controller_calls < self.release_after:
                self.condition.wait(timeout=1)
            match = re.search(r'"name":"([^"]+)"', prompt)
            if not match:
                raise AssertionError("prompt missing compact session name")
            response = decision_json(session=match.group(1))
            self.active_controller_calls -= 1
            self.condition.notify_all()
            return response


class RateLimitThenSlowEscalationApi(FakeApi):
    def __init__(self):
        super().__init__([])
        self.active_by_model = {}
        self.max_active_by_model = {}

    def run_controller_decision(self, prompt, model):
        self.controller_calls.append((prompt, model))
        if model == "gpt-5.4-mini":
            from heartbeat_patrol.api import ApiError

            raise ApiError("MiniMax chat failed with HTTP 429: too many requests")

        self.active_by_model[model] = self.active_by_model.get(model, 0) + 1
        self.max_active_by_model[model] = max(
            self.max_active_by_model.get(model, 0),
            self.active_by_model[model],
        )
        try:
            time.sleep(0.03)
            match = re.search(r'"name":"([^"]+)"', prompt)
            if not match:
                raise AssertionError("prompt missing compact session name")
            return decision_json(session=match.group(1))
        finally:
            self.active_by_model[model] -= 1


class PatrolRunnerTest(unittest.TestCase):
    def make_runner(
        self,
        api,
        *,
        reader=None,
        state_path=None,
        max_sessions_per_patrol=8,
        max_controller_concurrency=1,
        max_escalation_concurrency=3,
        model_prefilter_enabled=False,
    ):
        from heartbeat_patrol.runner import PatrolRunner

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = HeartbeatState(state_path or Path(tmp.name) / "heartbeat.sqlite")
        return PatrolRunner(
            state=state,
            reader=reader or FakeReader(),
            api=api,
            controller_model="gpt-5.4-mini",
            escalation_model="gpt-5.5",
            max_recent_runs=3,
            stale_running_minutes=90,
            child_sla_minutes=180,
            max_sessions_per_patrol=max_sessions_per_patrol,
            max_controller_concurrency=max_controller_concurrency,
            max_escalation_concurrency=max_escalation_concurrency,
            model_prefilter_enabled=model_prefilter_enabled,
        )

    def test_patrol_spawns_once_for_logical_key_and_skips_duplicate_second_run(self):
        api = FakeApi([decision_json(spawn_item()), decision_json(spawn_item())])
        runner = self.make_runner(api)

        first = runner.run_once()
        second = runner.run_once()

        self.assertEqual(first["stats"]["spawns_started"], 1)
        self.assertEqual(second["stats"]["spawns_started"], 0)
        self.assertEqual(second["stats"]["spawns_skipped_duplicate"], 1)
        self.assertEqual(len(api.spawn_calls), 1)

    def test_patrol_writes_authoritative_events_for_decisions_and_spawns(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FakeApi([decision_json(spawn_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        with sqlite3.connect(state_path) as conn:
            rows = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, child_session_id, child_model, status
                FROM heartbeat_events
                WHERE event_type IN ('session_decision', 'spawn_started')
                ORDER BY rowid
                """
            ).fetchall()

        self.assertEqual(
            rows,
            [
                ("session_decision", "alpha", None, "spawn_collect", None, None, "completed"),
                ("spawn_started", "alpha", "alpha:issue-1", "spawn_collect", "child-1", "gpt-5.4-mini", "running"),
            ],
        )

    def test_spawn_failure_after_claim_releases_claim_so_later_run_can_retry(self):
        api = FakeApi(
            [decision_json(spawn_item()), decision_json(spawn_item())],
            spawn_failures=[RuntimeError("boom"), None],
        )
        runner = self.make_runner(api)

        first = runner.run_once()
        second = runner.run_once()

        self.assertEqual(first["stats"]["spawns_started"], 0)
        self.assertEqual(len(first["errors"]), 1)
        self.assertIn("boom", first["errors"][0])
        self.assertEqual(second["stats"]["spawns_started"], 1)
        self.assertEqual(len(api.spawn_calls), 2)

    def test_alert_decision_sends_to_group_id(self):
        item = spawn_item()
        item["decision"] = "alert"
        item["reason"] = "human should inspect"
        item["prompt"] = "缺少目标国家参数。"
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["stats"]["alerts_sent"], 1)
        self.assertEqual(api.alerts, [("oc_alpha", "缺少目标国家参数。")])
        self.assertEqual(len(api.user_messages), 1)
        self.assertEqual(api.user_messages[0][0], "oc_alpha")
        self.assertIn("缺少目标国家参数", api.user_messages[0][1])
        self.assertIn("先不要替我决定", api.user_messages[0][1])

    def test_alert_decision_dedupes_user_prompt(self):
        item = spawn_item()
        item["decision"] = "alert"
        item["reason"] = "missing parameter"
        item["prompt"] = "请选择国家。"
        api = FakeApi([decision_json(item), decision_json(item)])
        runner = self.make_runner(api)

        first = runner.run_once()
        second = runner.run_once()

        self.assertEqual(first["stats"]["alerts_sent"], 1)
        self.assertEqual(second["stats"]["alerts_skipped_duplicate"], 1)
        self.assertEqual(len(api.alerts), 1)
        self.assertEqual(len(api.user_messages), 1)

    def test_user_resume_decision_composes_and_sends_user_message_to_original_group(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        item = user_resume_item()
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["items_detected"], 1)
        self.assertEqual(len(api.resume_compose_calls), 1)
        self.assertEqual(api.resume_compose_calls[0][1]["name"], "alpha")
        self.assertEqual(api.resume_compose_calls[0][2], "gpt-5.4-mini")
        self.assertEqual(api.user_messages, [("oc_alpha", "继续推进刚才没做完的部分，完成后直接回报结果。")])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, status, summary
                FROM heartbeat_events
                WHERE event_type = 'user_resume_sent'
                """
            ).fetchone()
        self.assertEqual(row[0:5], ("user_resume_sent", "alpha", "alpha:resume-1", "user_resume", "sent"))
        self.assertIn(item["reason"], row[5])
        self.assertIn("继续推进刚才没做完的部分，完成后直接回报结果。", row[5])

    def test_user_resume_decision_dedupes_same_logical_key(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        item = user_resume_item()
        api = FakeApi([decision_json(item), decision_json(item)])
        runner = self.make_runner(api, state_path=state_path)

        first = runner.run_once()
        second = runner.run_once()

        self.assertEqual(first["errors"], [])
        self.assertEqual(second["errors"], [])
        self.assertEqual(len(api.resume_compose_calls), 1)
        self.assertEqual(len(api.user_messages), 1)
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, status
                FROM heartbeat_events
                WHERE event_type = 'user_resume_skipped_duplicate'
                """
            ).fetchone()
        self.assertEqual(row, ("user_resume_skipped_duplicate", "alpha", "alpha:resume-1", "user_resume", "skipped"))

    def test_user_resume_sends_at_most_one_message_per_session_per_patrol(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        first = user_resume_item("alpha:resume-1")
        second = user_resume_item("alpha:resume-2")
        api = FakeApi([decision_json(first, second)])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(len(api.resume_compose_calls), 1)
        self.assertEqual(len(api.user_messages), 1)
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, status
                FROM heartbeat_events
                WHERE event_type = 'user_resume_skipped_session_cap'
                """
            ).fetchone()
        self.assertEqual(row, ("user_resume_skipped_session_cap", "alpha", "alpha:resume-2", "user_resume", "skipped"))

    def test_patrol_injects_single_todo_when_no_historical_action_and_session_idle(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-1",
            message="请处理待办 1。",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [("oc_alpha", "请处理待办 1。")])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute("SELECT status FROM session_todos WHERE logical_key = 'alpha:todo-1'").fetchone()
            event = conn.execute(
                "SELECT event_type, status, summary FROM heartbeat_events WHERE event_type = 'todo_injected'"
            ).fetchone()
        self.assertEqual(row[0], "injected")
        self.assertEqual(event[0:2], ("todo_injected", "sent"))
        self.assertIn("请处理待办 1。", event[2])

    def test_patrol_skips_temporarily_paused_session(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.pause_session(session_name="alpha", minutes=60)
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        self.assertEqual(result["stats"]["items_detected"], 0)

    def test_patrol_auto_pauses_session_for_latest_provider_limit(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        packet_overrides = {
            "recent_runs": [
                {
                    "id": "mr_limited",
                    "status": "failed",
                    "error_message": "API Error: Server is temporarily limiting requests · Rate limited",
                }
            ]
        }
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}],
            packet_overrides=packet_overrides,
        )
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.controller_calls, [])
        self.assertEqual(result["stats"]["items_detected"], 0)
        state = HeartbeatState(state_path)
        pause = state.active_pause_for_session("alpha")
        self.assertIsNotNone(pause)
        self.assertEqual(pause["status"], "paused")
        self.assertEqual(pause["source"], "provider_limit_auto_pause")
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                """
                SELECT event_type, target_session, status, source, summary
                FROM heartbeat_events
                WHERE event_type = 'heartbeat_paused'
                """
            ).fetchone()
        self.assertEqual(event[0:4], ("heartbeat_paused", "alpha", "paused", "provider_limit_auto_pause"))
        self.assertIn("auto stop 60 after provider limit in latest run mr_limited", event[4])

    def test_todo_single_message_5000_chars_is_not_truncated(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        long_message = "x" * 4991 + "TAIL_5000"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-long",
            message=long_message,
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        self.assertIn("TAIL_5000", sent)
        self.assertEqual(sent, long_message)

    def test_patrol_injects_ready_batch_as_one_user_message(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        first = state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-1",
            message="方向 1",
            source_ref="parent-1",
            expected_count=2,
        )
        second = state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-2",
            message="方向 2",
            source_ref="parent-1",
            expected_count=2,
        )
        self.assertEqual(first["batch_key"], second["batch_key"])
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(len(api.user_messages), 1)
        self.assertIn("以下是同一批待办", api.user_messages[0][1])
        self.assertIn("方向 1", api.user_messages[0][1])
        self.assertIn("方向 2", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            statuses = conn.execute("SELECT status FROM session_todos ORDER BY logical_key").fetchall()
            batch_status = conn.execute("SELECT status FROM todo_batches WHERE batch_key = ?", (first["batch_key"],)).fetchone()[0]
        self.assertEqual(statuses, [("injected",), ("injected",)])
        self.assertEqual(batch_status, "injected")

    def test_patrol_does_not_consume_todo_when_historical_action_exists(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(target_session="alpha", logical_key="alpha:todo-1", message="请处理待办 1。", batch_mode="single")
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(spawn_item())])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["stats"]["spawns_started"], 1)
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute("SELECT status FROM session_todos WHERE logical_key = 'alpha:todo-1'").fetchone()
        self.assertEqual(row[0], "pending")

    def test_recovery_todo_preempts_soft_historical_action(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:recovery-comm-1",
            message="ATP 报告已经回来，请贴出报告并继续 task 2。",
            todo_type="async_handoff_recovery",
            batch_mode="single",
        )
        item = user_resume_item("alpha:atp-timeout")
        item["reason"] = "timeout while waiting for comm_123 final_message and ATP report"
        item["prompt"] = "Continue from the external report checkpoint."
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages, [("oc_alpha", "ATP 报告已经回来，请贴出报告并继续 task 2。")])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:recovery-comm-1'"
            ).fetchone()[0]
            skipped = conn.execute(
                "SELECT event_type FROM heartbeat_events WHERE event_type = 'historical_items_skipped_for_recovery_todo'"
            ).fetchone()[0]
        self.assertEqual(todo_status, "injected")
        self.assertEqual(skipped, "historical_items_skipped_for_recovery_todo")

    def test_spawn_closure_todo_preempts_soft_historical_action(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="spawn-closure:comm-1",
            message="spawn 闭环已转异步，请继续重推目标 session。",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(spawn_item("alpha:soft-evidence"))])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(result["stats"]["spawns_started"], 0)
        self.assertEqual(api.spawn_calls, [])
        self.assertEqual(api.user_messages, [("oc_alpha", "spawn 闭环已转异步，请继续重推目标 session。")])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'spawn-closure:comm-1'"
            ).fetchone()[0]
            skipped = conn.execute(
                "SELECT event_type FROM heartbeat_events WHERE event_type = 'historical_items_skipped_for_recovery_todo'"
            ).fetchone()[0]
        self.assertEqual(todo_status, "injected")
        self.assertEqual(skipped, "historical_items_skipped_for_recovery_todo")

    def test_spawn_closure_pending_in_failed_batch_injects_real_result_not_user_resume(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        first = state.enqueue_todo(
            target_session="alpha",
            logical_key="comm_d5d00280_1779192346654:0",
            message="old duplicate result",
            source_session="supermatrix-root",
            source_ref="comm_d5d00280_1779192346654",
            todo_type="spawn_closure",
            expected_count=1,
        )
        claim = state.claim_next_todo_batch(target_session="alpha", todo_types={"spawn_closure"})
        state.mark_todos_failed(todo_ids=[claim.todos[0].todo_id], detail="user resume message uses target session perspective")
        real_result = (
            "这是你请求〔comm_d5d00280_1779192346654〕的结果,框架兜底送回。\n"
            "late result is now present; deliver it to caller\n\n"
            "Situation: 旧逻辑主要按旧键同步数量。\n"
            "Goal: 兼容新的多行模型。\n"
            "我做了什么: 已检查并修改 preprocess.py / routing.py。\n"
            "验证通过：7 passed"
        )
        second = state.enqueue_todo(
            target_session="alpha",
            logical_key="comm_d5d00280_1779192346654:1",
            message=real_result,
            source_session="supermatrix-root",
            source_ref="comm_d5d00280_1779192346654",
            todo_type="spawn_closure",
            expected_count=1,
        )
        self.assertEqual(first["batch_key"], second["batch_key"])
        item = user_resume_item("alpha:spawn_closure_comm_d5d00280_1779192346654")
        item["reason"] = "pending_todos has spawn_closure comm_d5d00280_1779192346654 but recent runs mention unrelated script regeneration"
        item["prompt"] = "Compose a confirmation that the unrelated script regeneration can close."
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(result["stats"]["user_resumes_sent"], 0)
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages, [("oc_alpha", real_result)])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'comm_d5d00280_1779192346654:1'"
            ).fetchone()[0]
            batch_status = conn.execute(
                "SELECT status FROM todo_batches WHERE batch_key = ?", (second["batch_key"],)
            ).fetchone()[0]
        self.assertEqual(todo_status, "injected")
        self.assertEqual(batch_status, "injected")

    def test_alert_blocks_recovery_todo_until_user_parameters_are_requested(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:recovery-comm-1",
            message="已经有报告，继续处理。",
            todo_type="async_handoff_recovery",
            batch_mode="single",
        )
        item = spawn_item("alpha:missing-country")
        item["decision"] = "alert"
        item["reason"] = "missing required country parameter"
        item["prompt"] = "请选择目标国家。"
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["alerts_sent"], 1)
        self.assertEqual(result["stats"]["todos_injected"], 0)
        self.assertEqual(len(api.user_messages), 1)
        self.assertIn("请选择目标国家", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:recovery-comm-1'"
            ).fetchone()[0]
        self.assertEqual(todo_status, "pending")

    def test_patrol_does_not_consume_todo_when_session_status_busy(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(target_session="alpha", logical_key="alpha:todo-1", message="请处理待办 1。", batch_mode="single")
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "busy"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute("SELECT status FROM session_todos WHERE logical_key = 'alpha:todo-1'").fetchone()
        self.assertEqual(row[0], "pending")

    def test_todo_send_failure_marks_failed(self):
        class FailingUserMessageApi(FakeApi):
            def send_user_message(self, chat_id, text):
                raise RuntimeError("send failed")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(target_session="alpha", logical_key="alpha:todo-1", message="请处理待办 1。", batch_mode="single")
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FailingUserMessageApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(len(result["errors"]), 1)
        with sqlite3.connect(state_path) as conn:
            row = conn.execute("SELECT status, detail FROM session_todos WHERE logical_key = 'alpha:todo-1'").fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("send failed", row[1])

    def test_todo_batch_message_2500_chars_is_not_truncated(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        long_message = "x" * 2480 + "TAIL_2500"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-1",
            message="第一条",
            source_ref="batch-1",
            expected_count=2,
        )
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-2",
            message=long_message,
            source_ref="batch-1",
            expected_count=2,
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        self.assertIn("TAIL_2500", sent)
        self.assertGreater(len(sent), 2500)

    def test_todo_batch_message_3500_chars_is_not_truncated(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        long_message = "y" * 3491 + "TAIL_3500"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-1",
            message="第一条",
            source_ref="batch-1",
            expected_count=2,
        )
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-2",
            message=long_message,
            source_ref="batch-1",
            expected_count=2,
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        self.assertIn("TAIL_3500", sent)
        self.assertGreater(len(sent), 3500)

    def test_reader_list_failure_records_failed_patrol_and_returns_error(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        runner = self.make_runner(FakeApi([]), reader=FailingListReader(), state_path=state_path)

        result = runner.run_once()

        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("reader exploded", result["errors"][0])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute("SELECT status, errors FROM patrol_runs").fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("reader exploded", row[1])

    def test_first_controller_api_failure_retries_once_and_succeeds(self):
        api = FakeApi([RuntimeError("temporary controller failure"), decision_json(spawn_item())])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["spawns_started"], 1)
        self.assertEqual(len(api.controller_calls), 2)

    def test_minimax_rate_limit_falls_back_to_escalation_model(self):
        from heartbeat_patrol.api import ApiError

        api = FakeApi([ApiError("MiniMax chat failed with HTTP 429: too many requests"), decision_json(spawn_item())])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["spawns_started"], 1)
        self.assertEqual([model for _, model in api.controller_calls], ["gpt-5.4-mini", "gpt-5.5"])

    def test_rate_limit_during_json_repair_falls_back_to_escalation_model(self):
        from heartbeat_patrol.api import ApiError

        api = FakeApi(
            [
                "not json",
                ApiError("MiniMax chat failed with HTTP 429: too many requests"),
                decision_json(spawn_item()),
            ]
        )
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["spawns_started"], 1)
        self.assertEqual([model for _, model in api.controller_calls], ["gpt-5.4-mini", "gpt-5.4-mini", "gpt-5.5"])

    def test_rate_limit_fallback_is_separately_throttled(self):
        reader = FakeReader(
            [
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha"},
                {"id": "s2", "name": "beta", "group_id": "oc_beta"},
                {"id": "s3", "name": "gamma", "group_id": "oc_gamma"},
                {"id": "s4", "name": "delta", "group_id": "oc_delta"},
            ]
        )
        api = RateLimitThenSlowEscalationApi()
        runner = self.make_runner(
            api,
            reader=reader,
            max_sessions_per_patrol=0,
            max_controller_concurrency=0,
            max_escalation_concurrency=2,
        )

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["sessions_scanned"], 4)
        self.assertLessEqual(api.max_active_by_model["gpt-5.5"], 2)

    def test_skip_only_decision_does_not_count_as_detected_item(self):
        api = FakeApi([decision_json(skip_item())])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["stats"]["items_detected"], 0)
        self.assertEqual(result["stats"]["spawns_started"], 0)
        self.assertEqual(result["stats"]["alerts_sent"], 0)

    def test_prefilter_skip_avoids_controller_call_for_empty_packet(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FakeApi([])
        runner = self.make_runner(api, state_path=state_path, model_prefilter_enabled=True)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["sessions_scanned"], 1)
        self.assertEqual(result["stats"]["sessions_prefilter_skipped"], 1)
        self.assertEqual(api.controller_calls, [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, target_session, status, summary
                FROM heartbeat_events
                WHERE event_type = 'session_prefilter_skip'
                """
            ).fetchone()
        self.assertEqual(row[0:3], ("session_prefilter_skip", "alpha", "skipped"))
        self.assertIn("no local candidate signal", row[3])

    def test_prefilter_candidate_still_calls_controller(self):
        reader = FakeReader(packet_overrides={"recent_runs": [{"id": "mr_1", "status": "running", "started_at": 0}]})
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, model_prefilter_enabled=True)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["sessions_prefilter_skipped"], 0)
        self.assertEqual(len(api.controller_calls), 1)

    def test_prefilter_allows_pending_spawn_closure_todo_to_reach_drain(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="spawn-closure:comm-1",
            message="spawn 闭环已转异步，请继续重推目标 session。",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path, model_prefilter_enabled=True)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["sessions_prefilter_skipped"], 0)
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(api.user_messages, [("oc_alpha", "spawn 闭环已转异步，请继续重推目标 session。")])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'spawn-closure:comm-1'"
            ).fetchone()
        self.assertEqual(row[0], "injected")

    def test_patrol_limits_session_batch_and_rotates_next_run(self):
        reader = FakeReader(
            [
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha"},
                {"id": "s2", "name": "beta", "group_id": "oc_beta"},
                {"id": "s3", "name": "gamma", "group_id": "oc_gamma"},
            ]
        )
        api = FakeApi(
            [
                decision_json(session="alpha"),
                decision_json(session="beta"),
                decision_json(session="gamma"),
                decision_json(session="alpha"),
            ]
        )
        runner = self.make_runner(api, reader=reader, max_sessions_per_patrol=2)

        first = runner.run_once()
        second = runner.run_once()

        self.assertEqual(first["stats"]["sessions_scanned"], 2)
        self.assertEqual(second["stats"]["sessions_scanned"], 2)
        self.assertEqual(reader.built_session_names, ["alpha", "beta", "gamma", "alpha"])

    def test_zero_session_limit_scans_all_sessions(self):
        reader = FakeReader(
            [
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha"},
                {"id": "s2", "name": "beta", "group_id": "oc_beta"},
                {"id": "s3", "name": "gamma", "group_id": "oc_gamma"},
            ]
        )
        api = FakeApi(
            [
                decision_json(session="alpha"),
                decision_json(session="beta"),
                decision_json(session="gamma"),
            ]
        )
        runner = self.make_runner(api, reader=reader, max_sessions_per_patrol=0)

        result = runner.run_once()

        self.assertEqual(result["stats"]["sessions_scanned"], 3)
        self.assertEqual(reader.built_session_names, ["alpha", "beta", "gamma"])

    def test_zero_controller_concurrency_runs_batch_in_parallel(self):
        reader = FakeReader(
            [
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha"},
                {"id": "s2", "name": "beta", "group_id": "oc_beta"},
                {"id": "s3", "name": "gamma", "group_id": "oc_gamma"},
            ]
        )
        api = BlockingApi(
            [
                decision_json(session="alpha"),
                decision_json(session="beta"),
                decision_json(session="gamma"),
            ],
            release_after=3,
        )
        runner = self.make_runner(
            api,
            reader=reader,
            max_sessions_per_patrol=0,
            max_controller_concurrency=0,
        )

        result = runner.run_once()

        self.assertEqual(result["stats"]["sessions_scanned"], 3)
        self.assertEqual(api.max_active_controller_calls, 3)

    def test_invalid_controller_json_repairs_then_escalates_and_records_error(self):
        api = FakeApi(["not json", "also not json", "still not json"])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["stats"]["items_detected"], 0)
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("alpha", result["errors"][0])
        self.assertIn("invalid JSON", result["errors"][0])
        self.assertNotIn("cannot access local variable", result["errors"][0])
        self.assertEqual([model for _, model in api.controller_calls], ["gpt-5.4-mini", "gpt-5.4-mini", "gpt-5.5"])
        self.assertIn("previous response was invalid", api.controller_calls[1][0])

    def test_child_prompt_contains_no_cascade_and_output_shape_text(self):
        from heartbeat_patrol.runner import child_prompt

        prompt = child_prompt(
            DecisionItem(
                logical_key="alpha:issue-1",
                severity="warn",
                decision="spawn_collect",
                reason="needs evidence",
                target_session="alpha",
                child_model="gpt-5.4-mini",
                prompt="Original child task.",
            )
        )

        self.assertIn("alpha:issue-1", prompt)
        self.assertIn("needs evidence", prompt)
        self.assertIn("Original child task.", prompt)
        self.assertIn("No-cascade constraint", prompt)
        self.assertIn("Return this structure: evidence found, action taken, remaining blocker, human attention needed.", prompt)

    def test_user_resume_message_rejects_target_session_completion_perspective(self):
        from heartbeat_patrol.runner import _normalize_user_resume_message

        with self.assertRaisesRegex(RuntimeError, "target session perspective"):
            _normalize_user_resume_message(
                "修正版已经交付到群里了，双层结构和配件比例都已经按要求修正；如果还要再调，我继续跟进。"
            )


class RecordingApi(HeartbeatApi):
    def __init__(self):
        super().__init__(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
        self.posts = []

    def _post_json(self, path, payload):
        self.posts.append((path, payload))
        if payload["target"] == self.heartbeat_session:
            token = payload["verification_predicate"]["contains_all"][0]
            return {"ok": True, "finalMessage": f'{{"verification_token":"{token}"}}'}
        return {"ok": True, "childSessionId": "child-1"}


class RecordingMiniMaxApi(HeartbeatApi):
    def __init__(self):
        super().__init__(
            api_base="http://example.invalid",
            lark_cli="lark-cli",
            heartbeat_session="hb-custom",
            controller_provider="minimax",
            minimax_api_key="test-key",
            minimax_base_url="https://api.minimaxi.com/v1",
            minimax_model="MiniMax-M2.7",
        )
        self.requests = []
        self.posts = []

    def _post_minimax_chat(self, prompt, model):
        self.requests.append((prompt, model))
        return '{"session":"alpha","items":[]}'

    def _post_json(self, path, payload):
        self.posts.append((path, payload))
        token = payload["verification_predicate"]["contains_all"][0]
        return {"ok": True, "finalMessage": f'{{"verification_token":"{token}"}}'}


class HeartbeatApiTest(unittest.TestCase):
    def test_spawn_payloads_use_configured_heartbeat_session(self):
        api = RecordingApi()

        api.run_controller_decision("controller prompt", "gpt-5.4-mini")
        api.spawn_child("alpha", "child prompt", "gpt-5.4-mini")

        self.assertEqual(api.posts[0][1]["target"], "hb-custom")
        self.assertEqual(api.posts[0][1]["from"], "hb-custom")
        self.assertEqual(api.posts[1][1]["target"], "alpha")
        self.assertEqual(api.posts[1][1]["from"], "hb-custom")

    def test_spawn_payloads_include_verification_predicates(self):
        api = RecordingApi()

        api.run_controller_decision("controller prompt", "gpt-5.4-mini")
        api.spawn_child("alpha", "child prompt", "gpt-5.4-mini")

        controller_payload = api.posts[0][1]
        controller_predicate = controller_payload["verification_predicate"]
        controller_token = controller_predicate["contains_all"][0]
        self.assertEqual(
            controller_predicate,
            {
                "type": "inbox-message",
                "session_name": "hb-custom",
                "field": "final_message",
                "contains_all": [controller_token],
                "expected_window_sec": 600,
            },
        )
        self.assertIn(controller_token, controller_payload["prompt"])

        child_payload = api.posts[1][1]
        child_predicate = child_payload["verification_predicate"]
        child_token = child_predicate["contains_all"][0]
        self.assertEqual(
            child_predicate,
            {
                "type": "inbox-message",
                "session_name": "alpha",
                "field": "final_message",
                "contains_all": [child_token],
                "expected_window_sec": 10800,
            },
        )
        self.assertIn(child_token, child_payload["prompt"])

    def test_spawn_payloads_do_not_send_mode(self):
        class RecordingComposeApi(HeartbeatApi):
            def __init__(self):
                super().__init__(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
                self.posts = []

            def _post_json(self, path, payload):
                self.posts.append((path, payload))
                token = payload["verification_predicate"]["contains_all"][0]
                return {
                    "ok": True,
                    "finalMessage": json.dumps(
                        {"message": "继续推进刚才没做完的部分。", "verification_token": token},
                        ensure_ascii=False,
                    ),
                }

        api = RecordingApi()
        api.run_controller_decision("controller prompt", "gpt-5.4-mini")
        api.spawn_child("alpha", "child prompt", "gpt-5.4-mini")
        compose_api = RecordingComposeApi()
        compose_api.compose_user_resume_message(
            item=DecisionItem(
                logical_key="drawing:resume-1",
                severity="warn",
                decision="user_resume",
                reason="target needs a continuation nudge",
                target_session="drawing",
                child_model="gpt-5.4-mini",
                prompt="Ask drawing to continue the unfinished revision.",
            ),
            target_session={"name": "drawing"},
            model="gpt-5.4-mini",
        )

        for _path, payload in api.posts + compose_api.posts:
            self.assertNotIn("mode", payload)

    def test_minimax_controller_uses_direct_chat_and_keeps_spawn_for_escalation_models(self):
        api = RecordingMiniMaxApi()

        direct = api.run_controller_decision("controller prompt", "MiniMax-M2.7")
        fallback = api.run_controller_decision("repair prompt", "gpt-5.5")

        self.assertEqual(direct, '{"session":"alpha","items":[]}')
        self.assertEqual(api.requests, [("controller prompt", "MiniMax-M2.7")])
        self.assertEqual(api.posts[0][1]["backend"], "codex")
        self.assertEqual(api.posts[0][1]["model"], "gpt-5.5")
        self.assertIn('"verification_token"', fallback)

    def test_user_resume_composer_uses_json_envelope_for_verification_token(self):
        class RecordingComposeApi(HeartbeatApi):
            def __init__(self):
                super().__init__(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
                self.payload = None

            def _post_json(self, path, payload):
                self.payload = payload
                token = payload["verification_predicate"]["contains_all"][0]
                return {
                    "ok": True,
                    "finalMessage": json.dumps(
                        {"message": "继续推进刚才没做完的部分。", "verification_token": token},
                        ensure_ascii=False,
                    ),
                }

        api = RecordingComposeApi()
        message = api.compose_user_resume_message(
            item=DecisionItem(
                logical_key="drawing:resume-1",
                severity="warn",
                decision="user_resume",
                reason="target needs a continuation nudge",
                target_session="drawing",
                child_model="gpt-5.4-mini",
                prompt="Ask drawing to continue the unfinished revision.",
            ),
            target_session={"name": "drawing"},
            model="gpt-5.4-mini",
        )

        self.assertEqual(message, "继续推进刚才没做完的部分。")
        predicate = api.payload["verification_predicate"]
        token = predicate["contains_all"][0]
        self.assertEqual(predicate["type"], "inbox-message")
        self.assertEqual(predicate["session_name"], "hb-custom")
        self.assertEqual(predicate["field"], "final_message")
        self.assertEqual(predicate["expected_window_sec"], 600)
        self.assertIn(token, api.payload["prompt"])

    def test_user_resume_compose_prompt_requires_user_to_target_perspective(self):
        from heartbeat_patrol.api import build_user_resume_compose_prompt

        prompt = build_user_resume_compose_prompt(
            item=DecisionItem(
                logical_key="drawing:resume-1",
                severity="warn",
                decision="user_resume",
                reason="target needs a continuation nudge",
                target_session="drawing",
                child_model="gpt-5.4-mini",
                prompt="Ask drawing to continue the unfinished revision.",
            ),
            target_session={"name": "drawing"},
        )

        self.assertIn("sent as the human user", prompt)
        self.assertIn("Do not speak as the target session", prompt)
        self.assertIn("Do not claim that work has been completed", prompt)

    def test_strip_minimax_thinking_returns_final_content(self):
        content = "<think>reasoning that should not enter the JSON parser</think>\n{\"session\":\"alpha\",\"items\":[]}"

        self.assertEqual(strip_minimax_thinking(content), '{"session":"alpha","items":[]}')


class HeartbeatPatrolScriptTest(unittest.TestCase):
    def test_executable_imports_package_when_run_from_scripts_directory(self):
        repo_root = Path(__file__).resolve().parents[1]
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = os.environ.copy()
        env.pop("PYTHONPATH", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["HEARTBEAT_STATE_DB"] = str(Path(tmp.name) / "heartbeat.sqlite")
        env["SM_DB_PATH"] = str(Path(tmp.name) / "missing-supermatrix.db")

        completed = subprocess.run(
            ["./heartbeat-patrol"],
            cwd=repo_root / "scripts",
            env=env,
            text=True,
            capture_output=True,
            timeout=10,
        )

        self.assertEqual(completed.returncode, 1)
        self.assertNotIn("ModuleNotFoundError", completed.stderr)
        self.assertIn("errors", completed.stdout)


if __name__ == "__main__":
    unittest.main()
