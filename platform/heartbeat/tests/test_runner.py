import json
import os
import re
import sqlite3
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.api import ApiError, HeartbeatApi, strip_minimax_thinking
from heartbeat_patrol.decision import DecisionItem
from heartbeat_patrol.state import HeartbeatState


class FakeReader:
    def __init__(
        self,
        sessions=None,
        *,
        packet_overrides=None,
        spawn_endpoints=None,
        landed_sessions=None,
        completed_cross_session=None,
        completed_heartbeat_child_results=None,
    ):
        self.sessions = sessions or [
            {
                "id": "s1",
                "name": "alpha",
                "group_id": "oc_alpha",
            }
        ]
        self.packet_overrides = packet_overrides or {}
        self.spawn_endpoints = spawn_endpoints or {}
        self.landed_sessions = set(landed_sessions or [])
        self.completed_cross_session = completed_cross_session or {}
        self._completed_heartbeat_child_results = completed_heartbeat_child_results or {}
        self.session = self.sessions[0]
        self.packets_built = 0
        self.built_session_names = []

    def list_enabled_sessions(self):
        return self.sessions

    def get_session_by_name(self, name):
        for session in self.sessions:
            if session["name"] == name:
                return session
        return None

    def build_packet(self, session, *, max_recent_runs):
        self.packets_built += 1
        self.built_session_names.append(session["name"])
        packet = {"session": session, "recent_runs": [], "recent_cross_session": []}
        packet.update(self.packet_overrides)
        return packet

    def resolve_spawn_endpoints(self, comm_id):
        return self.spawn_endpoints.get(comm_id)

    def session_run_landed_since(self, session_name, since_ms):
        return session_name in self.landed_sessions

    def completed_cross_session_logs(self, comm_ids):
        return {
            comm_id: self.completed_cross_session[comm_id]
            for comm_id in comm_ids
            if comm_id in self.completed_cross_session
        }

    def completed_heartbeat_child_results(self, candidates):
        return {
            (str(candidate["target_session"]), str(candidate["logical_key"])): self._completed_heartbeat_child_results[
                (str(candidate["target_session"]), str(candidate["logical_key"]))
            ]
            for candidate in candidates
            if (str(candidate["target_session"]), str(candidate["logical_key"]))
            in self._completed_heartbeat_child_results
        }


class FailingListReader:
    def list_enabled_sessions(self):
        raise RuntimeError("reader exploded")


class FakeApi:
    def __init__(
        self,
        controller_responses,
        *,
        spawn_failures=None,
        async_items_by_comm=None,
        async_item_query_error=None,
    ):
        self.controller_responses = list(controller_responses)
        self.spawn_failures = list(spawn_failures or [])
        self.async_items_by_comm = dict(async_items_by_comm or {})
        self.async_item_query_error = async_item_query_error
        self.controller_calls = []
        self.active_controller_calls = 0
        self.max_active_controller_calls = 0
        self.spawn_calls = []
        self.alerts = []
        self.notifications = []
        self.resume_compose_calls = []
        self.user_messages = []
        self.async_item_queries = []
        self.last_controller_response = None
        self.last_resume_response = None

    def run_controller_decision(self, prompt, model):
        self.last_controller_response = None
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

    def notify_console(self, *, title, body, level="info"):
        self.notifications.append((title, body, level))
        return {
            "status": "delivered",
            "message_id": f"om_notify_{len(self.notifications)}",
            "detail": "",
        }

    def compose_user_resume_message(self, *, item, target_session, model):
        self.resume_compose_calls.append((item, target_session, model))
        self.last_resume_response = {
            "ok": True,
            "comm_id": "comm_resume_1",
            "childSessionId": "sess_child_resume_1",
            "childSessionName": "child_heartbeat_resume_1",
            "messageRunId": "sess_child_run_resume_1",
        }
        return "继续推进刚才没做完的部分，完成后直接回报结果。"

    def send_user_message(self, chat_id, text):
        self.user_messages.append((chat_id, text))

    def get_spawn_async_item_by_comm(self, comm_id):
        self.async_item_queries.append(comm_id)
        if self.async_item_query_error is not None:
            raise self.async_item_query_error
        return self.async_items_by_comm.get(comm_id)


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
    TEST_SESSION_ALIASES = {
        "supermatrix-root": "test-caller",
        "deepautosearch": "test-child",
        "wendangwang": "test-source",
        "ads-master": "test-target",
    }

    def session_alias_fixture(self):
        return patch("heartbeat_patrol.runner._SESSION_ALIAS_CACHE", self.TEST_SESSION_ALIASES)

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
        todo_watch_launcher=None,
        unrecovered_max_unreconciled_hours=None,
    ):
        from heartbeat_patrol.runner import PatrolRunner

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = HeartbeatState(state_path or Path(tmp.name) / "heartbeat.sqlite")
        kwargs = {}
        if unrecovered_max_unreconciled_hours is not None:
            kwargs["unrecovered_max_unreconciled_hours"] = unrecovered_max_unreconciled_hours
        return PatrolRunner(
            state=state,
            reader=reader or FakeReader(),
            api=api,
            controller_model="gpt-5.4-mini",
            escalation_model="gpt-5.5",
            max_recent_runs=3,
            stale_running_minutes=90,
            child_sla_minutes=180,
            candidate_max_age_hours=24,
            max_sessions_per_patrol=max_sessions_per_patrol,
            max_controller_concurrency=max_controller_concurrency,
            max_escalation_concurrency=max_escalation_concurrency,
            model_prefilter_enabled=model_prefilter_enabled,
            todo_watch_launcher=todo_watch_launcher,
            **kwargs,
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

    def test_retired_bounded_child_model_is_upgraded_before_spawn(self):
        api = FakeApi([decision_json(spawn_item())])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.spawn_calls[0][2], "gpt-5.5")

    def test_targeted_patrol_scans_only_named_session(self):
        sessions = [
            {"id": "s1", "name": "alpha", "group_id": "oc_alpha", "heartbeat_enabled": 1},
            {"id": "s2", "name": "beta", "group_id": "oc_beta", "heartbeat_enabled": 1},
        ]
        reader = FakeReader(sessions=sessions)
        api = FakeApi([decision_json(session="beta")])
        runner = self.make_runner(api, reader=reader)

        result = runner.run_once(session_names=["beta"])

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["coverage_scope"], "targeted")
        self.assertEqual(result["stats"]["eligible_sessions"], 1)
        self.assertEqual(result["stats"]["sessions_scanned"], 1)
        self.assertEqual(reader.built_session_names, ["beta"])
        self.assertEqual(len(api.controller_calls), 1)

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
                ("spawn_started", "alpha", "alpha:issue-1", "spawn_collect", "child-1", "gpt-5.5", "running"),
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

    def test_spawn_child_sync_final_marks_child_spawn_completed(self):
        class SyncFinalApi(FakeApi):
            def spawn_child(self, target, prompt, model):
                self.spawn_calls.append((target, prompt, model))
                return {"ok": True, "childSessionId": "child-1", "finalMessage": "evidence complete"}

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = SyncFinalApi([decision_json(spawn_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT status, child_session_id, final_summary
                FROM child_spawns
                WHERE target_session = 'alpha' AND logical_key = 'alpha:issue-1'
                """
            ).fetchone()
        self.assertEqual(row, ("completed", "child-1", "evidence complete"))

    def test_spawn_completed_with_terminal_blocker_enters_backoff_and_escalates(self):
        class TerminalBlockerApi(FakeApi):
            def spawn_child(self, target, prompt, model):
                self.spawn_calls.append((target, prompt, model))
                return {
                    "ok": True,
                    "childSessionId": f"child-{len(self.spawn_calls)}",
                    "finalMessage": (
                        "evidence found: rollout pointer inspected. "
                        "remaining blocker: rollout file is permanently missing and unrecoverable. "
                        "human attention needed: yes."
                    ),
                }

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = TerminalBlockerApi([decision_json(spawn_item()) for _ in range(4)])
        runner = self.make_runner(api, state_path=state_path)

        escalated = 0
        for _ in range(3):
            result = runner.run_once()
            self.assertEqual(result["errors"], [])
            escalated += result["stats"]["unrecovered_targets_escalated"]

        fourth = runner.run_once()

        self.assertEqual(len(api.spawn_calls), 3)
        self.assertEqual(fourth["stats"]["spawns_skipped_backoff"], 1)
        self.assertEqual(escalated, 1)
        with sqlite3.connect(state_path) as conn:
            failure = conn.execute(
                """
                SELECT failure_count, cooldown_until
                FROM action_failures
                WHERE action_type = 'spawn'
                  AND target_session = 'alpha'
                  AND logical_key = 'alpha:issue-1'
                """
            ).fetchone()
            escalation = conn.execute(
                """
                SELECT target_session, logical_key, status
                FROM heartbeat_events
                WHERE event_type = 'unrecovered_item_escalated'
                """
            ).fetchone()
        self.assertEqual(failure[0], 3)
        self.assertIsNotNone(failure[1])
        self.assertEqual(escalation, ("alpha", "alpha:issue-1", "escalated"))

    def test_terminal_blocker_spawn_event_is_not_recorded_as_running_recovery(self):
        class TerminalBlockerApi(FakeApi):
            def spawn_child(self, target, prompt, model):
                return {
                    "ok": True,
                    "childSessionId": "child-1",
                    "finalMessage": "remaining blocker is permanently missing and unrecoverable.",
                }

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        runner = self.make_runner(TerminalBlockerApi([decision_json(spawn_item())]), state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                """
                SELECT status
                FROM heartbeat_events
                WHERE event_type = 'spawn_started'
                  AND target_session = 'alpha'
                  AND logical_key = 'alpha:issue-1'
                """
            ).fetchone()
        self.assertEqual(event, ("failed",))

    def test_spawn_child_switched_async_records_async_ref_without_child_id(self):
        class SwitchedAsyncApi(FakeApi):
            def spawn_child(self, target, prompt, model):
                self.spawn_calls.append((target, prompt, model))
                return {"ok": False, "status": "switched_async", "ref": "async-1", "comm_id": "comm-1"}

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = SwitchedAsyncApi([decision_json(spawn_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT status, child_session_id, async_ref, spawn_comm_id
                FROM child_spawns
                WHERE target_session = 'alpha' AND logical_key = 'alpha:issue-1'
                """
            ).fetchone()
        self.assertEqual(row, ("running", None, "async-1", "comm-1"))

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

    def test_alert_decision_does_not_inject_user_message_while_target_is_running(self):
        item = spawn_item()
        item["decision"] = "alert"
        item["reason"] = "human should inspect"
        item["prompt"] = "需要确认是否纳入追踪。"
        reader = FakeReader(
            sessions=[
                {
                    "id": "s1",
                    "name": "alpha",
                    "group_id": "oc_alpha",
                    "status": "busy",
                }
            ],
            packet_overrides={
                "recent_runs": [
                    {
                        "id": "mr_active",
                        "status": "running",
                        "started_at": int(time.time() * 1000) - 60_000,
                    }
                ]
            },
        )
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, reader=reader)

        result = runner.run_once()

        self.assertEqual(result["stats"]["alerts_sent"], 1)
        self.assertEqual(api.alerts, [("oc_alpha", "需要确认是否纳入追踪。")])
        self.assertEqual(api.user_messages, [])

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
        self.assertEqual(api.resume_compose_calls[0][2], "gpt-5.5")
        self.assertEqual(api.user_messages, [("oc_alpha", "继续推进刚才没做完的部分，完成后直接回报结果。")])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, status, summary,
                       trigger_source, trigger_cause, trigger_location, injected_message
                FROM heartbeat_events
                WHERE event_type = 'user_resume_sent'
                """
            ).fetchone()
            internal_row = conn.execute(
                """
                SELECT event_type, target_session, logical_key, decision, child_session_id, child_model, status,
                       trigger_source, trigger_cause, trigger_location, injected_message, summary
                FROM heartbeat_events
                WHERE event_type = 'internal_child_completed'
                """
            ).fetchone()
        self.assertEqual(row[0:5], ("user_resume_sent", "alpha", "alpha:resume-1", "user_resume", "sent"))
        self.assertIn(item["reason"], row[5])
        self.assertIn("继续推进刚才没做完的部分，完成后直接回报结果。", row[5])
        self.assertEqual(row[6:10], ("historical_stall", "continuation_checkpoint", "alpha", "继续推进刚才没做完的部分，完成后直接回报结果。"))
        self.assertEqual(
            internal_row[0:11],
            (
                "internal_child_completed",
                "alpha",
                "alpha:resume-1",
                "user_resume",
                "sess_child_resume_1",
                "gpt-5.5",
                "completed",
                "internal_helper",
                "resume_composer",
                "alpha",
                "继续推进刚才没做完的部分，完成后直接回报结果。",
            ),
        )
        self.assertIn("comm_id=comm_resume_1", internal_row[11])
        self.assertIn("child_session=child_heartbeat_resume_1", internal_row[11])

    def test_user_resume_skips_while_latest_run_is_still_running(self):
        item = user_resume_item()
        reader = FakeReader(
            packet_overrides={
                "recent_runs": [
                    {
                        "id": "mr_active",
                        "status": "running",
                        "started_at": int(time.time() * 1000) - 60_000,
                    }
                ]
            }
        )
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, reader=reader)

        result = runner.run_once()

        self.assertEqual(result["stats"]["user_resumes_sent"], 0)
        self.assertEqual(result["stats"]["user_resumes_skipped_session_busy"], 1)
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages, [])

    def test_user_resume_confirmation_gate_is_blocked_before_sending(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        item = user_resume_item("alpha:clash-zip-share-decision")
        item["reason"] = "如果确认那个 Clash zip 可以对外分享，我再生成正式下载链接; Session idle, no stale rows."
        item["prompt"] = "Compose a user reply asking alpha to confirm whether the Clash zip can be shared externally."
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["user_resumes_sent"], 0)
        self.assertEqual(result["stats"]["user_resumes_blocked_confirmation_gate"], 1)
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, status, trigger_source, trigger_cause, trigger_location, injected_message
                FROM heartbeat_events
                WHERE event_type = 'user_resume_blocked_confirmation_gate'
                """
            ).fetchone()
        self.assertEqual(
            row,
            (
                "user_resume_blocked_confirmation_gate",
                "skipped",
                "historical_stall",
                "user_confirmation_gate",
                "alpha",
                "",
            ),
        )

    def test_user_resume_composer_internal_child_is_logged_before_perspective_gate_failure(self):
        class BadComposerApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                self.last_resume_response = {
                    "ok": True,
                    "comm_id": "comm_bad_resume",
                    "childSessionId": "sess_child_bad_resume",
                    "childSessionName": "child_heartbeat_bad_resume",
                }
                return "修正版已经交付到群里了，如果还要再调，我继续跟进。"

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        item = user_resume_item()
        api = BadComposerApi([decision_json(item)])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["stats"]["user_resumes_sent"], 0)
        self.assertEqual(len(result["errors"]), 1)
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                """
                SELECT event_type, status, child_session_id, summary, injected_message
                FROM heartbeat_events
                WHERE event_type = 'internal_child_completed'
                """
            ).fetchone()
        self.assertEqual(row[0:3], ("internal_child_completed", "completed", "sess_child_bad_resume"))
        self.assertIn("comm_id=comm_bad_resume", row[3])
        self.assertIn("child_session=child_heartbeat_bad_resume", row[3])
        self.assertIn("修正版已经交付到群里了", row[4])

    def test_user_resume_uses_safe_fallback_when_composer_hits_provider_limit(self):
        class ProviderLimitedComposerApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                self.last_resume_response = {
                    "ok": False,
                    "status": "switched_async",
                    "spawnCommId": "comm_resume_limited",
                }
                raise ApiError(
                    "user resume composer provider limit: You've hit your usage limit. "
                    "Try again at Aug 8th, 2026 11:34 AM."
                )

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        item = user_resume_item()
        item["reason"] = "需要继续处理上轮未完成的结果。"
        api = ProviderLimitedComposerApi([decision_json(item)])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["user_resumes_sent"], 1)
        self.assertEqual(result["stats"]["user_resume_composer_fallbacks"], 1)
        self.assertEqual(
            api.user_messages,
            [("oc_alpha", "请基于当前上下文继续处理仍未完成的事项，避免重复已完成的工作，并在完成后直接回报结果。")],
        )
        with sqlite3.connect(state_path) as conn:
            internal = conn.execute(
                "SELECT event_type, status, child_session_id, summary, error FROM heartbeat_events "
                "WHERE event_type = 'internal_child_failed'"
            ).fetchone()
            fallback = conn.execute(
                "SELECT status, injected_message, error FROM heartbeat_events "
                "WHERE event_type = 'user_resume_composer_fallback'"
            ).fetchone()
            remaining_failures = conn.execute(
                "SELECT COUNT(*) FROM action_failures WHERE action_type = 'user_resume'"
            ).fetchone()[0]
        self.assertEqual(internal[0:3], ("internal_child_failed", "failed", None))
        self.assertIn("comm_id=comm_resume_limited", internal[3])
        self.assertIn("usage limit", internal[4])
        self.assertEqual(fallback[0:2], ("sent", api.user_messages[0][1]))
        self.assertIn("usage limit", fallback[2])
        self.assertEqual(remaining_failures, 0)

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
                """
                SELECT event_type, status, summary, trigger_source, trigger_cause,
                       trigger_location, injected_message
                FROM heartbeat_events
                WHERE event_type = 'todo_injected'
                """
            ).fetchone()
        self.assertEqual(row[0], "injected")
        self.assertEqual(event[0:2], ("todo_injected", "sent"))
        self.assertIn("请处理待办 1。", event[2])
        self.assertEqual(event[3:7], ("todo_pool", "general", "alpha", "请处理待办 1。"))

    def test_patrol_injects_unsettled_spawn_closure_batch_when_target_idle(self):
        # 之前的逻辑：spawn_closure 默认 settle 600s，target 即使 idle 也得等 settle 才注入。
        # 新行为：_drain_todo_if_idle 已经验过 idle，下游 claim 拿到 target_idle=True 应直接放行。
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
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
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(len(api.user_messages), 1)
        self.assertEqual(api.user_messages[0][0], "oc_alpha")
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:comm-1'"
            ).fetchone()[0]
            event_types = {
                row[0]
                for row in conn.execute(
                    "SELECT event_type FROM heartbeat_events WHERE target_session = 'alpha'"
                ).fetchall()
            }
        self.assertEqual(todo_status, "injected")
        self.assertIn("todo_injected", event_types)
        # 不要再写 todo_deferred_batch_not_ready：idle 路径不应该再延后。
        self.assertNotIn("todo_deferred_batch_not_ready", event_types)

    def test_patrol_logs_batch_wait_when_pending_todo_is_not_ready(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
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
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:comm-1'"
            ).fetchone()[0]
            event = conn.execute(
                """
                SELECT event_type, status, summary, trigger_source, trigger_cause, trigger_location
                FROM heartbeat_events
                WHERE event_type = 'todo_deferred_batch_not_ready'
                """
            ).fetchone()
        self.assertEqual(todo_status, "pending")
        self.assertEqual(event[0:2], ("todo_deferred_batch_not_ready", "pending"))
        self.assertIn("expected=2", event[2])
        self.assertIn("remaining=1", event[2])
        self.assertEqual(event[3:6], ("todo_pool", "batch_waiting", "alpha"))

    def test_no_signal_prefilter_skip_is_not_logged_per_session_in_full_patrol(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "heartbeat_enabled": 1}]
        )
        api = FakeApi([])  # controller must not be called at all
        runner = self.make_runner(api, reader=reader, state_path=state_path, model_prefilter_enabled=True)

        full = runner.run_once()
        self.assertEqual(full["errors"], [])
        self.assertEqual(full["stats"]["sessions_prefilter_skipped"], 1)
        with sqlite3.connect(state_path) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM heartbeat_events WHERE event_type = 'session_prefilter_skip'"
            ).fetchone()[0]
        self.assertEqual(count, 0)

        targeted = runner.run_once(session_names=["alpha"])
        self.assertEqual(targeted["errors"], [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT summary FROM heartbeat_events WHERE event_type = 'session_prefilter_skip'"
            ).fetchone()
        self.assertEqual(row[0], "no local candidate signal")

    def test_informative_prefilter_skip_is_still_logged_in_full_patrol(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        started = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
        finished = (datetime.now(timezone.utc) - timedelta(minutes=55)).isoformat(timespec="seconds")
        cancelled_run = {
            "id": "mr_1",
            "status": "cancelled",
            "started_at": started,
            "finished_at": finished,
            "final_message": "❌ cancelled by user",
            "error_message": "",
            "prompt": "x",
        }
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "heartbeat_enabled": 1}],
            packet_overrides={"recent_runs": [cancelled_run]},
        )
        api = FakeApi([])
        runner = self.make_runner(api, reader=reader, state_path=state_path, model_prefilter_enabled=True)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT summary FROM heartbeat_events WHERE event_type = 'session_prefilter_skip'"
            ).fetchone()
        self.assertIn("cancelled by user", row[0])

    def test_prefilter_skip_still_drains_pending_todo_when_session_idle(self):
        """Regression: prefilter early-return on cancelled-by-user used to swallow todo drain.

        在 after-sales 2026-06-17 实测里，watcher fired 后定向巡检碰到 latest run
        cancelled by user 就 return，4 条 spawn_closure 待办白白挂着。修复后 prefilter
        skip 仍要走 _drain_todo_if_idle，让独立的待办照常注入。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:closure-1",
            message="请处理子 session 完成结果。",
            batch_mode="single",
        )
        started = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
        finished = (datetime.now(timezone.utc) - timedelta(minutes=55)).isoformat(timespec="seconds")
        cancelled_run = {
            "id": "mr_cancelled",
            "status": "cancelled",
            "started_at": started,
            "finished_at": finished,
            "final_message": "❌ cancelled by user",
            "error_message": "",
            "prompt": "x",
        }
        reader = FakeReader(
            sessions=[
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle", "heartbeat_enabled": 1}
            ],
            packet_overrides={"recent_runs": [cancelled_run]},
        )
        api = FakeApi([])  # controller must NOT be called (prefilter still skips it)
        runner = self.make_runner(api, reader=reader, state_path=state_path, model_prefilter_enabled=True)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.controller_calls, [])  # prefilter skip preserved
        self.assertEqual(api.user_messages, [("oc_alpha", "请处理子 session 完成结果。")])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:closure-1'"
            ).fetchone()[0]
            prefilter_event = conn.execute(
                "SELECT summary FROM heartbeat_events WHERE event_type = 'session_prefilter_skip'"
            ).fetchone()
            inject_event = conn.execute(
                "SELECT status FROM heartbeat_events WHERE event_type = 'todo_injected'"
            ).fetchone()
        self.assertEqual(todo_status, "injected")
        self.assertIsNotNone(prefilter_event)
        self.assertIn("cancelled by user", prefilter_event[0])
        self.assertEqual(inject_event, ("sent",))

    def test_prefilter_skip_with_busy_session_still_requests_watcher(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:closure-1",
            message="请处理子 session 完成结果。",
            batch_mode="single",
        )
        started = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(timespec="seconds")
        finished = (datetime.now(timezone.utc) - timedelta(minutes=55)).isoformat(timespec="seconds")
        cancelled_run = {
            "id": "mr_cancelled",
            "status": "cancelled",
            "started_at": started,
            "finished_at": finished,
            "final_message": "❌ cancelled by user",
            "error_message": "",
            "prompt": "x",
        }
        reader = FakeReader(
            sessions=[
                {"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "busy", "heartbeat_enabled": 1}
            ],
            packet_overrides={"recent_runs": [cancelled_run]},
        )
        api = FakeApi([])
        launched: list[str] = []
        runner = self.make_runner(
            api,
            reader=reader,
            state_path=state_path,
            model_prefilter_enabled=True,
            todo_watch_launcher=launched.append,
        )

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])  # busy → not injected this round
        self.assertEqual(launched, ["alpha"])  # drain-miss re-arm still fires

    def test_user_resume_skipped_while_in_cooldown(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        for n in range(3):
            state.record_action_failure(
                action_type="user_resume",
                target_session="alpha",
                logical_key="alpha:resume-1",
                error=f"composer timeout {n}",
                threshold=3,
                cooldown_minutes=360,
            )
        api = FakeApi([decision_json(user_resume_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                "SELECT event_type, status FROM heartbeat_events WHERE event_type = 'user_resume_skipped_backoff'"
            ).fetchone()
        self.assertEqual(event, ("user_resume_skipped_backoff", "skipped"))

    def test_repeated_user_resume_failures_enter_cooldown(self):
        class FailingComposeApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                raise RuntimeError("composer kaput")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FailingComposeApi([decision_json(user_resume_item()) for _ in range(4)])
        runner = self.make_runner(api, state_path=state_path)

        for _ in range(3):
            result = runner.run_once()
            self.assertTrue(result["errors"])
        self.assertEqual(len(api.resume_compose_calls), 3)

        fourth = runner.run_once()

        self.assertEqual(fourth["errors"], [])
        self.assertEqual(len(api.resume_compose_calls), 3)  # cooldown blocks a 4th attempt
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT failure_count, cooldown_until FROM action_failures WHERE action_type = 'user_resume'"
            ).fetchone()
        self.assertEqual(row[0], 3)
        self.assertIsNotNone(row[1])

    def test_unrecovered_target_escalates_when_logical_key_churns(self):
        # Reproduces the audit gap: the controller mints a fresh logical_key each patrol for the same
        # stuck target, so the per-key cooldown never trips and a `completed` patrol masks the fact
        # that nothing advanced. The target-scoped escalation must surface it.
        class FailingComposeApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                raise RuntimeError("user resume message uses target session perspective")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FailingComposeApi([decision_json(user_resume_item(f"alpha:resume-{n}")) for n in range(3)])
        runner = self.make_runner(api, state_path=state_path)

        escalated = 0
        for _ in range(3):
            result = runner.run_once()
            self.assertTrue(result["errors"])  # each attempt fails, never masked as clean
            escalated += result["stats"]["unrecovered_targets_escalated"]

        # Every attempt was actually made (no per-key cooldown blocked a retry) ...
        self.assertEqual(len(api.resume_compose_calls), 3)
        # ... yet the churning keys left every action_failures row at count 1, so cooldown stayed empty.
        with sqlite3.connect(state_path) as conn:
            counts = [r[0] for r in conn.execute("SELECT failure_count FROM action_failures")]
            cooldowns = [r[0] for r in conn.execute("SELECT cooldown_until FROM action_failures")]
            escalation_events = conn.execute(
                "SELECT target_session, status FROM heartbeat_events "
                "WHERE event_type = 'unrecovered_item_escalated'"
            ).fetchall()
        self.assertEqual(counts, [1, 1, 1])
        self.assertTrue(all(c is None for c in cooldowns))
        # The target-scoped aggregate escalated exactly once at the threshold crossing.
        self.assertEqual(escalated, 1)
        self.assertEqual(escalation_events, [("alpha", "escalated")])

    def test_unrecovered_target_escalates_after_max_age_without_a_new_failure(self):
        """A sparse failure must not remain invisible just because its rolling counter reset."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.record_unrecovered_target(
            action_type="user_resume",
            target_session="alpha",
            logical_key="alpha:sparse-failure",
            error="composer timed out",
            threshold=3,
            window_minutes=360,
            reescalate_minutes=720,
        )
        old_window = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            original_last_failed_at = conn.execute(
                "SELECT last_failed_at FROM unrecovered_targets"
            ).fetchone()[0]
            conn.execute(
                "UPDATE unrecovered_targets SET window_started_at = ?",
                (old_window,),
            )

        api = FakeApi([])
        runner = self.make_runner(
            api,
            state_path=state_path,
            unrecovered_max_unreconciled_hours=24,
        )
        stats = {"unrecovered_targets_reconciled": 0, "unrecovered_targets_escalated": 0}

        runner._reconcile_unrecovered_targets(patrol_id="patrol-age-fallback", stats=stats)

        self.assertEqual(stats["unrecovered_targets_escalated"], 1)
        self.assertEqual(len(api.notifications), 1)
        self.assertIn("24h", api.notifications[0][1])
        with sqlite3.connect(state_path) as conn:
            aggregate = conn.execute(
                """
                SELECT failure_count, last_failed_at, window_started_at, last_escalated_at
                FROM unrecovered_targets
                """
            ).fetchone()
            handoffs = conn.execute(
                """
                SELECT logical_key, failure_count, window_started_at, notify_status, status
                FROM unrecovered_escalation_handoffs
                """
            ).fetchall()
            event = conn.execute(
                """
                SELECT trigger_cause, status
                FROM heartbeat_events
                WHERE event_type = 'unrecovered_item_escalated'
                """
            ).fetchone()
        self.assertEqual(aggregate[:3], (1, original_last_failed_at, old_window))
        self.assertIsNotNone(aggregate[3])
        self.assertEqual(
            handoffs,
            [("alpha:sparse-failure", 1, old_window, "delivered", "awaiting_acceptance")],
        )
        self.assertEqual(event, ("unrecovered_max_age", "escalated"))

        second_stats = {"unrecovered_targets_reconciled": 0, "unrecovered_targets_escalated": 0}
        runner._reconcile_unrecovered_targets(patrol_id="patrol-age-rate-limit", stats=second_stats)
        self.assertEqual(second_stats["unrecovered_targets_escalated"], 0)
        with sqlite3.connect(state_path) as conn:
            self.assertEqual(
                conn.execute("SELECT COUNT(*) FROM unrecovered_escalation_handoffs").fetchone()[0],
                1,
            )

    def test_escalation_persists_delivery_and_verified_recovery_receipts(self):
        class FailingComposeApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                raise RuntimeError("composer stopped")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FailingComposeApi([decision_json(user_resume_item(f"alpha:resume-{n}")) for n in range(3)])
        runner = self.make_runner(api, state_path=state_path)

        for _ in range(3):
            runner.run_once()

        self.assertEqual(len(api.notifications), 1)
        self.assertIn("unrecovered_escalation_handoffs/", api.notifications[0][1])
        earlier = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE unrecovered_targets SET last_failed_at = ? WHERE action_type = 'user_resume' "
                "AND target_session = 'alpha'",
                (earlier,),
            )
        recovery_event_id = runner.state.log_event(
            event_type="todo_landing_verified",
            target_session="alpha",
            logical_key="alpha:resume-2",
            status="completed",
            summary="injected todo landed as a target run",
        )
        stats = {"unrecovered_targets_reconciled": 0}
        runner._reconcile_unrecovered_targets(patrol_id="patrol-reconcile", stats=stats)

        self.assertEqual(stats["unrecovered_targets_reconciled"], 1)
        with sqlite3.connect(state_path) as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            handoff = conn.execute(
                "SELECT notify_status, notify_message_id, status, recovery_event_type, recovery_event_id "
                "FROM unrecovered_escalation_handoffs"
            ).fetchone()
        self.assertEqual(remaining, 0)
        self.assertEqual(
            handoff,
            ("delivered", "om_notify_1", "recovered", "todo_landing_verified", recovery_event_id),
        )

    def test_escalation_notify_failure_is_persisted_and_marks_patrol_failed(self):
        class FailingComposeApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                raise RuntimeError("composer stopped")

            def notify_console(self, *, title, body, level="info"):
                self.notifications.append((title, body, level))
                raise RuntimeError("console offline")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FailingComposeApi([decision_json(user_resume_item(f"alpha:resume-{n}")) for n in range(3)])
        runner = self.make_runner(api, state_path=state_path)

        for _ in range(2):
            runner.run_once()
        third = runner.run_once()

        self.assertIn("unrecovered escalation notify failed: console offline", "\n".join(third["errors"]))
        with sqlite3.connect(state_path) as conn:
            handoff = conn.execute(
                "SELECT notify_status, notify_message_id, status, notify_detail "
                "FROM unrecovered_escalation_handoffs"
            ).fetchone()
        self.assertEqual(handoff, ("failed", "", "notify_failed", "console offline"))

    def test_single_clean_decision_between_three_failures_does_not_clear_unrecovered_target(self):
        class FailingComposeApi(FakeApi):
            def compose_user_resume_message(self, *, item, target_session, model):
                self.resume_compose_calls.append((item, target_session, model))
                raise RuntimeError("user resume message uses target session perspective")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        api = FailingComposeApi(
            [
                decision_json(user_resume_item("alpha:resume-1")),
                decision_json(session="alpha"),
                decision_json(user_resume_item("alpha:resume-2")),
                decision_json(user_resume_item("alpha:resume-3")),
            ]
        )
        runner = self.make_runner(api, state_path=state_path)

        first = runner.run_once()
        earlier = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                """
                UPDATE unrecovered_targets
                SET last_failed_at = ?, window_started_at = ?
                WHERE action_type = 'user_resume' AND target_session = 'alpha'
                """,
                (earlier, earlier),
            )
        clean = runner.run_once()
        second = runner.run_once()
        third = runner.run_once()

        self.assertTrue(first["errors"])
        self.assertEqual(clean["errors"], [])
        self.assertTrue(second["errors"])
        self.assertTrue(third["errors"])
        self.assertEqual(third["stats"]["unrecovered_targets_escalated"], 1)
        with sqlite3.connect(state_path) as conn:
            aggregate = conn.execute(
                """
                SELECT failure_count
                FROM unrecovered_targets
                WHERE action_type = 'user_resume' AND target_session = 'alpha'
                """
            ).fetchone()
            escalation_events = conn.execute(
                """
                SELECT target_session, status
                FROM heartbeat_events
                WHERE event_type = 'unrecovered_item_escalated'
                """
            ).fetchall()
        self.assertEqual(aggregate, (3,))
        self.assertEqual(escalation_events, [("alpha", "escalated")])

    def test_successful_user_resume_clears_unrecovered_aggregate(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        for _ in range(3):
            state.record_unrecovered_target(
                action_type="user_resume",
                target_session="alpha",
                logical_key="alpha:resume-1",
                error="perspective",
                threshold=3,
                window_minutes=360,
                reescalate_minutes=720,
            )
        api = FakeApi([decision_json(user_resume_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(len(api.user_messages), 1)
        with sqlite3.connect(state_path) as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_maintenance_does_not_reconcile_spawn_aggregate_from_todo_injection(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
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
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                (old, old),
            )
        state.log_event(
            event_type="todo_injected",
            target_session="alpha",
            logical_key="comm_abc",
            status="sent",
            summary="todo_ids=todo_1; logical_keys=comm_abc",
        )
        runner = self.make_runner(FakeApi([]), state_path=state_path)
        runner.state = state
        stats = {"unrecovered_targets_reconciled": 0}

        runner._reconcile_unrecovered_targets(patrol_id="patrol-test", stats=stats)

        self.assertEqual(stats["unrecovered_targets_reconciled"], 0)
        with sqlite3.connect(state_path) as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            event = conn.execute(
                "SELECT event_type, status, target_session, summary "
                "FROM heartbeat_events WHERE event_type = 'unrecovered_target_reconciled'"
            ).fetchone()
        self.assertEqual(remaining, 1)
        self.assertIsNone(event)

    def test_maintenance_reconciles_active_aggregate_from_exact_completed_child_result(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.record_unrecovered_target(
            action_type="spawn",
            target_session="alpha",
            logical_key="alpha:late-child",
            error="POST /api/spawn2.0 timed out after 180s",
            threshold=3,
            window_minutes=360,
            reescalate_minutes=720,
        )
        old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                (old, old),
            )
        reader = FakeReader(
            completed_heartbeat_child_results={
                ("alpha", "alpha:late-child"): {
                    "comm_id": "comm_late_child",
                    "finished_at": int(time.time() * 1000),
                    "final_message": "the target completed the delayed child result",
                    "result_preview": "",
                }
            }
        )
        runner = self.make_runner(FakeApi([]), reader=reader, state_path=state_path)
        runner.state = state
        stats = {"unrecovered_targets_reconciled": 0}

        runner._reconcile_unrecovered_targets(patrol_id="patrol-result-link", stats=stats)

        self.assertEqual(stats["unrecovered_targets_reconciled"], 1)
        with sqlite3.connect(state_path) as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            event = conn.execute(
                """
                SELECT event_type, logical_key, status, summary
                FROM heartbeat_events
                WHERE event_type = 'unrecovered_target_result_linked'
                """
            ).fetchone()
        self.assertEqual(remaining, 0)
        self.assertEqual(event[:3], ("unrecovered_target_result_linked", "alpha:late-child", "accepted"))
        self.assertIn("comm_late_child", event[3])

    def test_maintenance_accepts_legacy_handoff_only_from_exact_completed_child_result(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.log_event(
            event_type="unrecovered_item_escalated",
            target_session="alpha",
            logical_key="alpha:legacy-child",
            decision="spawn_execute",
            status="escalated",
            summary="legacy escalation",
            error="timeout",
        )
        state = HeartbeatState(state_path)
        reader = FakeReader(
            completed_heartbeat_child_results={
                ("alpha", "alpha:legacy-child"): {
                    "comm_id": "comm_legacy_child",
                    "finished_at": int(time.time() * 1000),
                    "final_message": "the legacy child produced a materialized result",
                    "result_preview": "",
                }
            }
        )
        runner = self.make_runner(FakeApi([]), reader=reader, state_path=state_path)
        runner.state = state
        stats = {"unrecovered_targets_reconciled": 0}

        runner._reconcile_unrecovered_targets(patrol_id="patrol-legacy-link", stats=stats)

        self.assertEqual(stats["unrecovered_targets_reconciled"], 0)
        with sqlite3.connect(state_path) as conn:
            handoff = conn.execute(
                """
                SELECT notify_status, status, recovery_event_type, recovery_summary
                FROM unrecovered_escalation_handoffs
                """
            ).fetchone()
        self.assertEqual(handoff[:3], ("unverifiable", "accepted", "cross_session_result_linked"))
        self.assertIn("comm_legacy_child", handoff[3])

    def test_maintenance_keeps_active_when_exact_child_result_reports_a_terminal_blocker(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.record_unrecovered_target(
            action_type="spawn",
            target_session="alpha",
            logical_key="alpha:terminal-child",
            error="POST /api/spawn2.0 timed out after 180s",
            threshold=3,
            window_minutes=360,
            reescalate_minutes=720,
        )
        old = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE unrecovered_targets SET last_failed_at = ?, window_started_at = ?",
                (old, old),
            )
        reader = FakeReader(
            completed_heartbeat_child_results={
                ("alpha", "alpha:terminal-child"): {
                    "comm_id": "comm_terminal_child",
                    "finished_at": int(time.time() * 1000),
                    "final_message": (
                        "remaining blocker: required artifact is permanently missing and unrecoverable. "
                        "human attention needed: yes."
                    ),
                    "result_preview": "",
                }
            }
        )
        runner = self.make_runner(FakeApi([]), reader=reader, state_path=state_path)
        runner.state = state
        stats = {"unrecovered_targets_reconciled": 0}

        runner._reconcile_unrecovered_targets(patrol_id="patrol-terminal-link", stats=stats)

        self.assertEqual(stats["unrecovered_targets_reconciled"], 0)
        with sqlite3.connect(state_path) as conn:
            remaining = conn.execute("SELECT COUNT(*) FROM unrecovered_targets").fetchone()[0]
            event = conn.execute(
                """
                SELECT event_type, logical_key, status, summary
                FROM heartbeat_events
                WHERE event_type = 'unrecovered_target_result_linked'
                """
            ).fetchone()
        self.assertEqual(remaining, 1)
        self.assertEqual(event[:3], ("unrecovered_target_result_linked", "alpha:terminal-child", "partial"))
        self.assertIn("comm_terminal_child", event[3])

    def test_successful_user_resume_clears_failure_history(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        for n in range(2):
            state.record_action_failure(
                action_type="user_resume",
                target_session="alpha",
                logical_key="alpha:resume-1",
                error=f"composer timeout {n}",
                threshold=3,
                cooldown_minutes=360,
            )
        api = FakeApi([decision_json(user_resume_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(len(api.user_messages), 1)
        with sqlite3.connect(state_path) as conn:
            count = conn.execute("SELECT COUNT(*) FROM action_failures").fetchone()[0]
        self.assertEqual(count, 0)

    def test_spawn_skipped_while_in_cooldown(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        for n in range(3):
            state.record_action_failure(
                action_type="spawn",
                target_session="alpha",
                logical_key="alpha:issue-1",
                error=f"spawn timeout {n}",
                threshold=3,
                cooldown_minutes=360,
            )
        api = FakeApi([decision_json(spawn_item())])
        runner = self.make_runner(api, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.spawn_calls, [])
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                "SELECT event_type, status FROM heartbeat_events WHERE event_type = 'spawn_skipped_backoff'"
            ).fetchone()
        self.assertEqual(event, ("spawn_skipped_backoff", "skipped"))

    def test_busy_session_with_pending_todo_requests_todo_watch(self):
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
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "busy"}])
        api = FakeApi([decision_json(session="alpha")])
        launched = []
        runner = self.make_runner(
            api, reader=reader, state_path=state_path, todo_watch_launcher=launched.append
        )

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        self.assertEqual(launched, ["alpha"])

    def test_unready_batch_requests_todo_watch(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
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
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        launched = []
        runner = self.make_runner(
            api, reader=reader, state_path=state_path, todo_watch_launcher=launched.append
        )

        runner.run_once()

        self.assertEqual(launched, ["alpha"])

    def test_busy_session_without_pending_todo_does_not_request_todo_watch(self):
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "busy"}])
        api = FakeApi([decision_json(session="alpha")])
        launched = []
        runner = self.make_runner(api, reader=reader, todo_watch_launcher=launched.append)

        runner.run_once()

        self.assertEqual(launched, [])

    def test_todo_send_failure_requeues_claim_for_retry(self):
        class SendFailApi(FakeApi):
            def send_user_message(self, chat_id, text):
                raise RuntimeError("lark send 500")

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
        api = SendFailApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(len(result["errors"]), 1)
        with sqlite3.connect(state_path) as conn:
            todo = conn.execute(
                "SELECT status, claimed_at IS NULL, finished_at IS NULL, detail FROM session_todos WHERE logical_key = 'alpha:todo-1'"
            ).fetchone()
            event = conn.execute(
                """
                SELECT event_type, status, error
                FROM heartbeat_events
                WHERE event_type = 'todo_injection_send_failed_requeued'
                """
            ).fetchone()
        self.assertEqual(todo, ("pending", 1, 1, "send failed; will retry: lark send 500"))
        self.assertEqual(event, ("todo_injection_send_failed_requeued", "pending", "lark send 500"))

    def test_patrol_skips_temporarily_paused_session(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.pause_session(session_name="alpha", minutes=60)
        state.enqueue_todo(target_session="alpha", logical_key="alpha:todo-1", message="请处理待办 1。", batch_mode="single")
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        self.assertEqual(result["stats"]["items_detected"], 0)
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                """
                SELECT event_type, target_session, logical_key, status, trigger_source, trigger_cause, summary
                FROM heartbeat_events
                WHERE event_type = 'todo_deferred_heartbeat_paused'
                """
            ).fetchone()
        self.assertEqual(event[0:6], ("todo_deferred_heartbeat_paused", "alpha", "alpha:todo-1", "paused", "todo_pool", "heartbeat_paused"))
        self.assertIn("pending_todo=alpha:todo-1", event[6])

    def test_patrol_keeps_overdue_spawn_closure_todo_pending_while_paused(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.pause_session(session_name="alpha", minutes=60)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="spawn-closure:comm-stale",
            message="旧兜底结果",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        old_created_at = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE session_todos SET created_at = ? WHERE logical_key = 'spawn-closure:comm-stale'",
                (old_created_at,),
            )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            todo = conn.execute(
                "SELECT status, finished_at IS NOT NULL, detail FROM session_todos WHERE logical_key = 'spawn-closure:comm-stale'"
            ).fetchone()
            event = conn.execute(
                """
                SELECT event_type, status, trigger_cause, summary
                FROM heartbeat_events
                WHERE event_type = 'todo_deferred_heartbeat_paused'
                """
            ).fetchone()
        self.assertEqual(todo, ("pending", 0, ""))
        self.assertEqual(event[0:3], ("todo_deferred_heartbeat_paused", "paused", "heartbeat_paused"))
        self.assertIn("spawn-closure:comm-stale", event[3])

    def test_provider_limit_pause_expiry_drains_pending_todo_before_repausing(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.pause_session_until(
            session_name="alpha",
            expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
            reason="auto stop after provider limit",
            source="provider_limit_auto_pause",
        )
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-after-limit",
            message="请继续处理限流恢复后的待办。",
            batch_mode="single",
        )
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
        self.assertEqual(api.user_messages, [("oc_alpha", "请继续处理限流恢复后的待办。")])
        self.assertIsNone(HeartbeatState(state_path).active_pause_for_session("alpha"))
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:todo-after-limit'"
            ).fetchone()[0]
            events = conn.execute(
                """
                SELECT event_type, status
                FROM heartbeat_events
                WHERE event_type IN (
                  'heartbeat_pause_expired',
                  'todo_retry_after_provider_limit_pause_expired',
                  'todo_injected',
                  'heartbeat_paused'
                )
                """
            ).fetchall()
        self.assertEqual(todo_status, "injected")
        self.assertIn(("heartbeat_pause_expired", "expired"), events)
        self.assertIn(("todo_retry_after_provider_limit_pause_expired", "retrying"), events)
        self.assertIn(("todo_injected", "sent"), events)

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

    def test_patrol_auto_pauses_until_weekly_limit_reset_without_controller(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        packet_overrides = {
            "recent_runs": [
                {
                    "id": "mr_weekly",
                    "status": "failed",
                    "finished_at": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "error_message": "You've hit your weekly limit · resets Dec 31, 2099 at 4pm (Asia/Shanghai)",
                }
            ]
        }
        reader = FakeReader(
            sessions=[
                {
                    "id": "s1",
                    "name": "alpha",
                    "group_id": "oc_alpha",
                    "status": "idle",
                    "backend": "claude",
                    "model": "claude-opus-4-8",
                }
            ],
            packet_overrides=packet_overrides,
        )
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.controller_calls, [])
        self.assertEqual(api.user_messages, [])
        state = HeartbeatState(state_path)
        pause = state.active_pause_for_session("alpha")
        self.assertIsNotNone(pause)
        self.assertEqual(pause["source"], "provider_limit_auto_pause")
        self.assertEqual(pause["expires_at"], "2099-12-31T08:05:00+00:00")
        self.assertIn("reset_at=2099-12-31T08:00:00+00:00", pause["reason"])

    def test_backend_model_limit_pause_blocks_peer_session_without_controller(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        sessions = [
            {
                "id": "s1",
                "name": "alpha",
                "group_id": "oc_alpha",
                "status": "idle",
                "heartbeat_enabled": 1,
                "backend": "claude",
                "model": "claude-opus-4-8",
            },
            {
                "id": "s2",
                "name": "beta",
                "group_id": "oc_beta",
                "status": "idle",
                "heartbeat_enabled": 1,
                "backend": "claude",
                "model": "claude-opus-4-8",
            },
        ]
        packet_overrides = {
            "recent_runs": [
                {
                    "id": "mr_weekly",
                    "status": "failed",
                    "finished_at": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "error_message": "You've hit your weekly limit · resets Dec 31, 2099 at 4pm (Asia/Shanghai)",
                }
            ]
        }
        reader = FakeReader(sessions=sessions, packet_overrides=packet_overrides)
        api = FakeApi([decision_json(session="alpha"), decision_json(session="beta")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        first = runner.run_once(session_names=["alpha"])
        second = runner.run_once(session_names=["beta"])

        self.assertEqual(first["errors"], [])
        self.assertEqual(second["errors"], [])
        self.assertEqual(api.controller_calls, [])
        # The peer packet is read once to look for a newer successful run that would
        # invalidate the shared pause before heartbeat suppresses recovery actions.
        self.assertEqual(reader.built_session_names, ["alpha", "beta"])
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                """
                SELECT event_type, target_session, status
                FROM heartbeat_events
                WHERE event_type = 'provider_limit_pause_active'
                """
            ).fetchone()
        self.assertEqual(event, ("provider_limit_pause_active", "beta", "paused"))

    def test_successful_run_after_shared_limit_recovers_pause_and_drains_pending_todo(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        scope_key = "backend_model:codex:gpt-5.6-terra"
        state.pause_provider_limit(
            scope_key=scope_key,
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            reason="weekly provider limit",
            source="provider_limit_auto_pause",
        )
        state.pause_session_until(
            session_name="alpha",
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
            reason=f"shared provider limit pause; scope_key={scope_key}",
            source="provider_limit_auto_pause",
        )
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:pending-after-provider-recovered",
            message="请继续处理已经排队的待办。",
            batch_mode="single",
        )
        pause_started = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat(timespec="seconds")
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE provider_limit_pauses SET created_at = ?, updated_at = ? WHERE scope_key = ?",
                (pause_started, pause_started, scope_key),
            )
        success_finished_at = int(datetime.now(timezone.utc).timestamp() * 1000)
        reader = FakeReader(
            sessions=[
                {
                    "id": "s1",
                    "name": "alpha",
                    "group_id": "oc_alpha",
                    "status": "idle",
                    "heartbeat_enabled": 1,
                    "backend": "codex",
                    "model": "gpt-5.6-terra",
                }
            ],
            packet_overrides={
                "recent_runs": [
                    {
                        "id": "mr_success_after_limit",
                        "status": "completed",
                        "finished_at": success_finished_at,
                        "final_message": "待办已经正常执行完成。",
                        "error_message": "",
                    }
                ]
            },
        )
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once(session_names=["alpha"])

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages, [("oc_alpha", "请继续处理已经排队的待办。")])
        self.assertIsNone(HeartbeatState(state_path).active_provider_limit_pause(scope_key))
        self.assertIsNone(HeartbeatState(state_path).active_pause_for_session("alpha"))
        with sqlite3.connect(state_path) as conn:
            provider_status = conn.execute(
                "SELECT status FROM provider_limit_pauses WHERE scope_key = ?", (scope_key,)
            ).fetchone()[0]
            event = conn.execute(
                "SELECT event_type, status FROM heartbeat_events WHERE event_type = 'provider_limit_pause_recovered'"
            ).fetchone()
        self.assertEqual(provider_status, "recovered")
        self.assertEqual(event, ("provider_limit_pause_recovered", "recovered"))

    def test_shared_provider_pause_stops_pending_todo_watcher_from_refiring(self):
        """A shared model pause must become a target pause before a watcher retries it."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:pending-while-provider-paused",
            message="请在限流恢复后继续处理。",
            batch_mode="single",
        )
        state.pause_provider_limit(
            scope_key="backend_model:claude:claude-opus-4-8",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
            reason="weekly provider limit",
            source="provider_limit_auto_pause",
        )
        reader = FakeReader(
            sessions=[
                {
                    "id": "s1",
                    "name": "alpha",
                    "group_id": "oc_alpha",
                    "status": "idle",
                    "heartbeat_enabled": 1,
                    "backend": "claude",
                    "model": "claude-opus-4-8",
                }
            ]
        )
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once(session_names=["alpha"])

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.controller_calls, [])
        self.assertEqual(api.user_messages, [])
        pause = HeartbeatState(state_path).active_pause_for_session("alpha")
        self.assertIsNotNone(pause)
        self.assertEqual(pause["source"], "provider_limit_auto_pause")
        with sqlite3.connect(state_path) as conn:
            event = conn.execute(
                """
                SELECT event_type, target_session, status, trigger_cause
                FROM heartbeat_events
                WHERE event_type = 'todo_deferred_provider_limit_paused'
                """
            ).fetchone()
        self.assertEqual(event, ("todo_deferred_provider_limit_paused", "alpha", "paused", "provider_limit_paused"))

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
        self.assertEqual(api.user_messages[0][0], "oc_alpha")
        self.assertIn("请处理下面这条子 session 完成结果", api.user_messages[0][1])
        self.assertIn("内容如下：\nspawn 闭环已转异步，请继续重推目标 session。", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            todo_status = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'spawn-closure:comm-1'"
            ).fetchone()[0]
            skipped = conn.execute(
                "SELECT event_type FROM heartbeat_events WHERE event_type = 'historical_items_skipped_for_recovery_todo'"
            ).fetchone()[0]
        self.assertEqual(todo_status, "injected")
        self.assertEqual(skipped, "historical_items_skipped_for_recovery_todo")

    def test_spawn_closure_delivery_labels_use_cross_session_log_endpoints(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        result_message = (
            "这是你请求〔comm_598ce898_1779848108646〕的结果,框架兜底送回。\n"
            '<sm-child-completed child_id="sess_child_598ce898" child_name="child_deepautosearch_8ce898">\n'
            "<result>research result</result>"
        )
        state.enqueue_todo(
            target_session="socail-king",
            logical_key="comm_598ce898_1779848108646",
            message=result_message,
            source_session="supermatrix-root",
            source_ref="comm_598ce898_1779848108646",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        created_at = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds")
        expected_time = (
            datetime.fromisoformat(created_at)
            .astimezone(timezone(timedelta(hours=8)))
            .strftime("%Y-%m-%d %H:%M:%S 北京时间")
        )
        with sqlite3.connect(state_path) as conn:
            conn.execute(
                "UPDATE session_todos SET created_at = ? WHERE logical_key = 'comm_598ce898_1779848108646'",
                (created_at,),
            )
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "socail-king", "group_id": "oc_sk", "status": "idle"}],
            spawn_endpoints={
                "comm_598ce898_1779848108646": {
                    "caller": "supermatrix-root",
                    "target": "deepautosearch",
                    "child": "child_deepautosearch_8ce898",
                }
            },
        )
        api = FakeApi([decision_json(session="socail-king")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        with self.session_alias_fixture():
            result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.user_messages[0][0], "oc_sk")
        sent = api.user_messages[0][1]
        self.assertIn(f"1. 时间：{expected_time}", sent)
        self.assertNotIn("+00:00", sent)
        # 发起方取 cross_session_log 的 caller（supermatrix-root），不是注入目标 target_session（socail-king）。
        self.assertIn("2. 发起方：test-caller（supermatrix-root）", sent)
        self.assertNotIn("SK（socail-king）", sent)
        self.assertIn("3. 执行子 session：test-child（deepautosearch）（child_deepautosearch_8ce898）", sent)
        self.assertIn("内容如下：\nresearch result", sent)
        self.assertNotIn("这是你请求〔comm_598ce898_1779848108646〕", sent)
        self.assertNotIn("<sm-child-completed", sent)

    def test_spawn_closure_delivery_uses_db_endpoints_when_message_lacks_child_name(self):
        # SK 报告场景：comm_f899335d 的 cross_session_log 行字段齐全，但闭包消息文本里没有
        # child_name="..." 字面 token；修复前 child_name fallback 成 ""、executor fallback 成 "unknown"。
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_f899335d_1781337968605"
        result_message = (
            f"这是你请求〔{comm_id}〕的结果,框架兜底送回。\n"
            "<result>bulk update applied to ad campaign</result>"
        )
        state.enqueue_todo(
            target_session="ads-master",
            logical_key=comm_id,
            message=result_message,
            source_session="sk-watcher",
            source_ref=comm_id,
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "ads-master", "group_id": "oc_ads", "status": "idle"}],
            spawn_endpoints={
                comm_id: {
                    "caller": "wendangwang",
                    "target": "ads-master",
                    "child": "child_ads-master_99335d",
                }
            },
        )
        api = FakeApi([decision_json(session="ads-master")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        with self.session_alias_fixture():
            result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        # 修复前两个字段都是错的：发起方错误地取目标 session、执行子 session=unknown。
        self.assertIn("2. 发起方：test-source（wendangwang）", sent)
        self.assertNotIn("test-target（ads-master）", sent.split("3. 执行子 session")[0])
        self.assertIn("3. 执行子 session：test-target（ads-master）（child_ads-master_99335d）", sent)
        self.assertNotIn("unknown", sent)

    def test_spawn_closure_delivery_falls_back_when_endpoints_missing(self):
        # cross_session_log 查不到时回退到 message 文本 grep + source_session，绝不回退到 target_session。
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        result_message = (
            "这是你请求〔comm_orphan_1〕的结果,框架兜底送回。\n"
            '<sm-child-completed child_id="sess_child_orphan" child_name="child_deepautosearch_orph">\n'
            "<result>fallback result</result>"
        )
        state.enqueue_todo(
            target_session="socail-king",
            logical_key="comm_orphan_1",
            message=result_message,
            source_session="supermatrix-root",
            source_ref="comm_orphan_1",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        # spawn_endpoints 为空 → reader.resolve_spawn_endpoints 返回 None
        reader = FakeReader(
            sessions=[{"id": "s1", "name": "socail-king", "group_id": "oc_sk", "status": "idle"}],
            spawn_endpoints={},
        )
        api = FakeApi([decision_json(session="socail-king")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        with self.session_alias_fixture():
            runner.run_once()

        sent = api.user_messages[0][1]
        # caller 从 source_session 兜底（不是 target_session）；child_name 从消息正文 grep 出来。
        self.assertIn("2. 发起方：test-caller（supermatrix-root）", sent)
        self.assertNotIn("SK（socail-king）", sent)
        self.assertIn("3. 执行子 session：test-child（deepautosearch）（child_deepautosearch_orph）", sent)

    def test_spawn_closure_no_action_is_cleared_without_injection(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        result_message = (
            "这是你请求〔comm_noop〕的结果,框架兜底送回。\n"
            '<sm-child-completed child_id="sess_child_noop" child_name="child_alpha_noop">\n'
            "<result>这条回执已处理过，无需重复操作。\nSM_CLOSURE_ACTION: no_action</result>"
        )
        state.enqueue_todo(
            target_session="alpha",
            logical_key="comm_noop",
            message=result_message,
            source_session="alpha",
            source_ref="comm_noop",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_injected"], 0)
        self.assertEqual(result["stats"]["todos_cleared"], 1)
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            todo_row = conn.execute(
                "SELECT status, injected_at IS NULL, finished_at IS NOT NULL, detail FROM session_todos WHERE logical_key = 'comm_noop'"
            ).fetchone()
            event_row = conn.execute(
                """
                SELECT event_type, status, trigger_source, trigger_cause, trigger_location
                FROM heartbeat_events
                WHERE event_type = 'todo_auto_cleared_no_action'
                """
            ).fetchone()
        self.assertEqual(todo_row[0], "cleared")
        self.assertEqual(todo_row[1], 1)
        self.assertEqual(todo_row[2], 1)
        self.assertIn("SM_CLOSURE_ACTION: no_action", todo_row[3])
        self.assertEqual(
            event_row,
            ("todo_auto_cleared_no_action", "cleared", "todo_pool", "spawn_closure_no_action", "alpha"),
        )

    def test_spawn_closure_closed_without_verdict_still_injects_after_recheck(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_closed1234_1"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:closure:comm_wrong9999_9",
            message="closed verdict NULL result must still be delivered",
            source_session="sk-watcher",
            source_ref=comm_id,
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi(
            [decision_json(session="alpha")],
            async_items_by_comm={comm_id: {"status": "closed", "verdict": None, "ref": "async_closed"}},
        )
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.async_item_queries, [comm_id])
        self.assertEqual(result["stats"]["todos_cleared"], 0)
        self.assertEqual(len(api.user_messages), 1)
        self.assertIn("closed verdict NULL result", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT status FROM session_todos WHERE source_ref = ?", (comm_id,)
            ).fetchone()
        self.assertEqual(row, ("injected",))

    def test_spawn_closure_caller_consumed_is_cleared_from_logical_key_without_injection(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_consumed1234_2"
        state.enqueue_todo(
            target_session="alpha",
            logical_key=f"alpha:closure:{comm_id}",
            message="caller already took this result",
            source_session="sk-watcher",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi(
            [decision_json(session="alpha")],
            async_items_by_comm={comm_id: {"status": "closed", "verdict": "caller_consumed", "ref": "async_taken"}},
        )
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.async_item_queries, [comm_id])
        self.assertEqual(result["stats"]["todos_cleared"], 1)
        self.assertEqual(api.user_messages, [])
        with sqlite3.connect(state_path) as conn:
            todo_row = conn.execute(
                "SELECT status, detail FROM session_todos WHERE logical_key = ?", (f"alpha:closure:{comm_id}",)
            ).fetchone()
        self.assertEqual(todo_row[0], "cleared")
        self.assertIn("caller_consumed", todo_row[1])

    def test_caller_consumed_closure_does_not_preempt_user_resume(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_consumed3456_3"
        state.enqueue_todo(
            target_session="alpha",
            logical_key=f"alpha:closure:{comm_id}",
            message="caller already took this result",
            source_session="sk-watcher",
            source_ref=comm_id,
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi(
            [decision_json(user_resume_item())],
            async_items_by_comm={comm_id: {"status": "closed", "verdict": "caller_consumed", "ref": "async_taken"}},
        )
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_cleared"], 1)
        self.assertEqual(result["stats"]["todos_injected"], 0)
        self.assertEqual(len(api.resume_compose_calls), 1)
        self.assertEqual(api.user_messages, [("oc_alpha", "继续推进刚才没做完的部分，完成后直接回报结果。")])

    def test_spawn_closure_without_async_row_still_injects_from_envelope_comm_id(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_missing1234_3"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:closure-without-comm-id",
            message=f"这是你请求〔{comm_id}〕的结果，框架兜底送回。\n<result>keep delivering</result>",
            source_session="sk-watcher",
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.async_item_queries, [comm_id])
        self.assertEqual(result["stats"]["todos_cleared"], 0)
        self.assertEqual(len(api.user_messages), 1)
        self.assertIn("keep delivering", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT status FROM session_todos WHERE logical_key = 'alpha:closure-without-comm-id'"
            ).fetchone()
        self.assertEqual(row, ("injected",))

    def test_spawn_closure_mixed_batch_clears_only_caller_consumed_todo(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        consumed_comm_id = "comm_consumed2345_4"
        deliver_comm_id = "comm_deliver2345_5"
        first = state.enqueue_todo(
            target_session="alpha",
            logical_key=f"alpha:closure:{consumed_comm_id}",
            message="already delivered result",
            source_session="sk-watcher",
            source_ref=consumed_comm_id,
            todo_type="spawn_closure",
            batch_key="mixed-consumption",
            expected_count=2,
        )
        second = state.enqueue_todo(
            target_session="alpha",
            logical_key=f"alpha:closure:{deliver_comm_id}",
            message="still needs delivery",
            source_session="sk-watcher",
            source_ref=deliver_comm_id,
            todo_type="spawn_closure",
            batch_key="mixed-consumption",
            expected_count=2,
        )
        self.assertEqual(first["batch_key"], second["batch_key"])
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi(
            [decision_json(session="alpha")],
            async_items_by_comm={
                consumed_comm_id: {"status": "closed", "verdict": "caller_consumed", "ref": "async_taken"},
                deliver_comm_id: {"status": "closed", "verdict": None, "ref": "async_deliver"},
            },
        )
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.async_item_queries, [consumed_comm_id, deliver_comm_id])
        self.assertEqual(result["stats"]["todos_cleared"], 1)
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(len(api.user_messages), 1)
        self.assertNotIn("already delivered result", api.user_messages[0][1])
        self.assertIn("still needs delivery", api.user_messages[0][1])
        with sqlite3.connect(state_path) as conn:
            statuses = conn.execute(
                "SELECT logical_key, status FROM session_todos ORDER BY logical_key"
            ).fetchall()
            batch_status = conn.execute(
                "SELECT status FROM todo_batches WHERE batch_key = 'mixed-consumption'"
            ).fetchone()
        self.assertEqual(
            statuses,
            [
                (f"alpha:closure:{consumed_comm_id}", "cleared"),
                (f"alpha:closure:{deliver_comm_id}", "injected"),
            ],
        )
        self.assertEqual(batch_status, ("injected",))

    def test_spawn_closure_recheck_failure_fails_open_to_existing_injection(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        state = HeartbeatState(state_path)
        comm_id = "comm_unreachable1234_6"
        state.enqueue_todo(
            target_session="alpha",
            logical_key=f"alpha:closure:{comm_id}",
            message="deliver despite lookup failure",
            source_session="sk-watcher",
            source_ref=comm_id,
            todo_type="spawn_closure",
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi(
            [decision_json(session="alpha")],
            async_item_query_error=RuntimeError("SuperMatrix API unavailable"),
        )
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(api.async_item_queries, [comm_id])
        self.assertEqual(len(api.user_messages), 1)
        with sqlite3.connect(state_path) as conn:
            row = conn.execute(
                "SELECT status FROM session_todos WHERE source_ref = ?", (comm_id,)
            ).fetchone()
        self.assertEqual(row, ("injected",))

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

        with self.session_alias_fixture():
            result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["todos_injected"], 1)
        self.assertEqual(result["stats"]["user_resumes_sent"], 0)
        self.assertEqual(api.resume_compose_calls, [])
        self.assertEqual(api.user_messages[0][0], "oc_alpha")
        sent = api.user_messages[0][1]
        self.assertIn("请处理下面这条子 session 完成结果", sent)
        self.assertIn("1. 时间：", sent)
        # cross_session_log 查不到 → 发起方回退到 source_session（supermatrix-root），
        # 不回退到注入目标 target_session（alpha）。
        self.assertIn("2. 发起方：test-caller（supermatrix-root）", sent)
        self.assertNotIn("2. 发起方：alpha", sent)
        self.assertIn("3. 执行子 session：unknown", sent)
        self.assertIn("4. 状态：已执行完成", sent)
        self.assertIn("5. 现在动作：把完成内容返回给你继续处理", sent)
        self.assertIn("关联 ID：comm_d5d00280_1779192346654", sent)
        self.assertIn("内容如下：", sent)
        self.assertIn("Situation: 旧逻辑主要按旧键同步数量。", sent)
        self.assertIn("验证通过：7 passed", sent)
        self.assertNotIn("这是你请求〔comm_d5d00280_1779192346654〕", sent)
        self.assertNotIn("late result is now present; deliver it to caller", sent)
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

    def test_todo_send_failure_requeues_pending_for_retry(self):
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
        self.assertEqual(row[0], "pending")
        self.assertIn("send failed; will retry", row[1])

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

    def test_todo_batch_over_inline_limit_writes_full_payload_file(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        payload_dir = Path(tmp.name) / "payloads"
        state = HeartbeatState(state_path)
        long_message = "z" * 9000 + "TAIL_FULL_PAYLOAD"
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

        with patch("heartbeat_patrol.runner.TODO_BATCH_PAYLOAD_DIR", payload_dir):
            result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        self.assertIn("完整内容已写入本机文件", sent)
        self.assertIn(str(payload_dir), sent)
        self.assertNotIn("TAIL_FULL_PAYLOAD", sent)
        payload_files = list(payload_dir.glob("*.md"))
        self.assertEqual(len(payload_files), 1)
        self.assertIn("TAIL_FULL_PAYLOAD", payload_files[0].read_text())

    def test_single_todo_over_inline_limit_writes_full_payload_file(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state_path = Path(tmp.name) / "heartbeat.sqlite"
        payload_dir = Path(tmp.name) / "payloads"
        state = HeartbeatState(state_path)
        long_message = "s" * 9000 + "TAIL_SINGLE_PAYLOAD"
        state.enqueue_todo(
            target_session="alpha",
            logical_key="alpha:todo-long",
            message=long_message,
            batch_mode="single",
        )
        reader = FakeReader(sessions=[{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "status": "idle"}])
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader, state_path=state_path)

        with patch("heartbeat_patrol.runner.TODO_BATCH_PAYLOAD_DIR", payload_dir):
            result = runner.run_once()

        self.assertEqual(result["errors"], [])
        sent = api.user_messages[0][1]
        self.assertIn("完整内容已写入本机文件", sent)
        self.assertIn(str(payload_dir), sent)
        self.assertNotIn("TAIL_SINGLE_PAYLOAD", sent)
        payload_files = list(payload_dir.glob("*.md"))
        self.assertEqual(len(payload_files), 1)
        self.assertIn("TAIL_SINGLE_PAYLOAD", payload_files[0].read_text())

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
        # 全量巡检的"无信号"skip 只进聚合统计，不再逐条落事件（事件降噪契约）。
        with sqlite3.connect(state_path) as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM heartbeat_events WHERE event_type = 'session_prefilter_skip'"
            ).fetchone()[0]
        self.assertEqual(count, 0)

    def test_prefilter_candidate_still_calls_controller(self):
        started_at = int(time.time() * 1000) - 91 * 60 * 1000
        reader = FakeReader(
            packet_overrides={"recent_runs": [{"id": "mr_1", "status": "running", "started_at": started_at}]}
        )
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
        self.assertEqual(api.user_messages[0][0], "oc_alpha")
        self.assertIn("请处理下面这条子 session 完成结果", api.user_messages[0][1])
        self.assertIn("内容如下：\nspawn 闭环已转异步，请继续重推目标 session。", api.user_messages[0][1])
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
        self.assertEqual(first["stats"]["coverage_scope"], "batched")
        self.assertEqual(second["stats"]["coverage_scope"], "batched")
        self.assertEqual(first["stats"]["eligible_sessions"], 3)
        self.assertEqual(second["stats"]["eligible_sessions"], 3)
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

        self.assertEqual(result["stats"]["coverage_scope"], "full")
        self.assertEqual(result["stats"]["eligible_sessions"], 3)
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

    def test_bare_empty_controller_array_does_not_spawn_repair(self):
        api = FakeApi(["[]"])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["items_detected"], 0)
        self.assertEqual(len(api.controller_calls), 1)

    def test_noop_skip_item_with_null_child_model_does_not_spawn_repair(self):
        item = skip_item()
        item["child_model"] = None
        item["prompt"] = "No action."
        api = FakeApi([decision_json(item)])
        runner = self.make_runner(api)

        result = runner.run_once()

        self.assertEqual(result["errors"], [])
        self.assertEqual(result["stats"]["items_detected"], 0)
        self.assertEqual(len(api.controller_calls), 1)

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

    def test_user_resume_message_allows_prior_run_completion_reference(self):
        from heartbeat_patrol.runner import _normalize_user_resume_message

        message = (
            "继续把 NsiprjG36e5z33c84tjckvLAnUb 这条记录的评论回复链路再复测一遍，"
            "确认 response_log 变更后现在的 live comment handling 会不会对新来的 @SuperMatrix 评论给出回复；"
            "这次是 mr_a23165ed 超时中断，报错是 boot reconcile: backend orphaned by console restart，"
            "而且还没有更近的已完成 run 解决这条记录的测试，把结果直接回报我。"
        )

        self.assertEqual(_normalize_user_resume_message(message), message)

    def _seed_injected_todo(self, state, *, target_session, logical_key, injected_minutes_ago):
        record = state.enqueue_todo(
            target_session=target_session,
            logical_key=logical_key,
            message="do X",
            source_session="producer",
            source_ref=f"comm_{logical_key}",
            todo_type="spawn_closure",
        )
        injected_at = (
            datetime.now(timezone.utc) - timedelta(minutes=injected_minutes_ago)
        ).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                "UPDATE session_todos SET status='injected', injected_at=?, finished_at=? WHERE todo_id=?",
                (injected_at, injected_at, record["todo_id"]),
            )
        return record["todo_id"]

    def _todo_status(self, state, todo_id):
        with sqlite3.connect(state.path) as conn:
            return conn.execute(
                "SELECT status FROM session_todos WHERE todo_id = ?", (todo_id,)
            ).fetchone()[0]

    def test_full_patrol_verifies_injected_landing_and_reconciles_spawns(self):
        reader = FakeReader(landed_sessions={"alpha"})
        api = FakeApi([])  # prefilter skips the signal-free alpha session, no controller call
        runner = self.make_runner(api, reader=reader, model_prefilter_enabled=True)
        state = runner.state

        landed = self._seed_injected_todo(
            state, target_session="alpha", logical_key="k-landed", injected_minutes_ago=10
        )
        missing = self._seed_injected_todo(
            state, target_session="beta", logical_key="k-missing", injected_minutes_ago=10
        )
        overdue = self._seed_injected_todo(
            state, target_session="beta", logical_key="k-overdue", injected_minutes_ago=8 * 60
        )
        # a stale running spawn with no closure → should be reaped to timeout
        state.try_claim_spawn(target_session="gamma", logical_key="g:stuck", child_model="m")
        state.mark_spawn_started(target_session="gamma", logical_key="g:stuck", child_session_id="c1")
        old = (datetime.now(timezone.utc) - timedelta(minutes=200)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute("UPDATE child_spawns SET created_at = ? WHERE target_session = 'gamma'", (old,))

        result = runner.run_once()

        # landing verified → completed; unlanded-but-within-deadline stays injected; overdue → failed
        self.assertEqual(self._todo_status(state, landed), "completed")
        self.assertEqual(self._todo_status(state, missing), "injected")
        self.assertEqual(self._todo_status(state, overdue), "failed")
        self.assertEqual(result["stats"]["todos_landing_verified"], 1)
        self.assertEqual(result["stats"]["todos_landing_unconfirmed"], 1)
        # stale running spawn reconciled to timeout
        self.assertEqual(result["stats"]["spawns_reconciled_timeout"], 1)
        with sqlite3.connect(state.path) as conn:
            spawn_status = conn.execute(
                "SELECT status FROM child_spawns WHERE target_session='gamma' AND logical_key='g:stuck'"
            ).fetchone()[0]
        self.assertEqual(spawn_status, "timeout")
        with sqlite3.connect(state.path) as conn:
            event_types = {
                row[0]
                for row in conn.execute(
                    "SELECT event_type FROM heartbeat_events WHERE event_type IN "
                    "('todo_landing_verified','todo_landing_unconfirmed','spawn_reconciled_timeout')"
                ).fetchall()
            }
        self.assertEqual(
            event_types,
            {"todo_landing_verified", "todo_landing_unconfirmed", "spawn_reconciled_timeout"},
        )

    def test_full_patrol_reconciles_stale_action_claims(self):
        reader = FakeReader()
        api = FakeApi([])
        runner = self.make_runner(api, reader=reader, model_prefilter_enabled=True)
        state = runner.state
        state.try_claim_action(action_type="user_resume", target_session="alpha", logical_key="alpha:stuck")
        old = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute("UPDATE action_claims SET created_at = ?", (old,))

        result = runner.run_once()

        self.assertEqual(result["stats"]["action_claims_reconciled_failed"], 1)
        with sqlite3.connect(state.path) as conn:
            claim = conn.execute("SELECT status, finished_at IS NOT NULL FROM action_claims").fetchone()
            event = conn.execute(
                "SELECT event_type, status, logical_key FROM heartbeat_events WHERE event_type = 'action_claim_reconciled_failed'"
            ).fetchone()
        self.assertEqual(claim, ("failed", 1))
        self.assertEqual(event, ("action_claim_reconciled_failed", "failed", "alpha:stuck"))

    def test_full_patrol_reconciles_completed_cross_session_action_claim_before_failing_stale(self):
        reader = FakeReader(
            completed_cross_session={
                "comm_done_1783300059111": {
                    "id": "comm_done_1783300059111",
                    "status": "completed",
                    "finished_at": 1783300729147,
                }
            }
        )
        api = FakeApi([])
        runner = self.make_runner(api, reader=reader, model_prefilter_enabled=True)
        state = runner.state
        state.try_claim_action(
            action_type="self_spawn_closure",
            target_session="heartbeat",
            logical_key="comm_done_1783300059111",
        )
        old = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat(timespec="seconds")
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                "UPDATE action_claims SET status = 'failed', created_at = ?, finished_at = ?",
                (old, old),
            )

        result = runner.run_once()

        self.assertEqual(result["stats"]["action_claims_reconciled_completed"], 1)
        self.assertEqual(result["stats"]["action_claims_reconciled_failed"], 0)
        with sqlite3.connect(state.path) as conn:
            claim = conn.execute(
                "SELECT status, detail FROM action_claims WHERE logical_key = 'comm_done_1783300059111'"
            ).fetchone()
            event = conn.execute(
                """
                SELECT event_type, status, logical_key
                FROM heartbeat_events
                WHERE event_type = 'action_claim_reconciled_completed'
                """
            ).fetchone()
        self.assertEqual(claim[0], "completed")
        self.assertIn("cross_session_log comm_done_1783300059111 completed", claim[1])
        self.assertEqual(event, ("action_claim_reconciled_completed", "completed", "comm_done_1783300059111"))

    def test_full_patrol_archives_legacy_injected_todos_before_cutoff(self):
        reader = FakeReader()
        api = FakeApi([])
        runner = self.make_runner(api, reader=reader, model_prefilter_enabled=True)
        state = runner.state
        legacy = self._seed_injected_todo(
            state, target_session="alpha", logical_key="legacy", injected_minutes_ago=10
        )
        current = self._seed_injected_todo(
            state, target_session="beta", logical_key="current", injected_minutes_ago=10
        )
        with sqlite3.connect(state.path) as conn:
            conn.execute(
                "UPDATE session_todos SET injected_at = ? WHERE todo_id = ?",
                ("2026-06-30T13:15:15+00:00", legacy),
            )

        result = runner.run_once()

        self.assertEqual(result["stats"]["legacy_injected_todos_archived"], 1)
        self.assertEqual(self._todo_status(state, legacy), "legacy_ignored")
        self.assertEqual(self._todo_status(state, current), "injected")
        with sqlite3.connect(state.path) as conn:
            event = conn.execute(
                "SELECT event_type, status FROM heartbeat_events WHERE event_type = 'legacy_injected_todos_archived'"
            ).fetchone()
        self.assertEqual(event, ("legacy_injected_todos_archived", "legacy_ignored"))

    def test_targeted_patrol_skips_maintenance(self):
        sessions = [{"id": "s1", "name": "alpha", "group_id": "oc_alpha", "heartbeat_enabled": 1}]
        reader = FakeReader(sessions=sessions, landed_sessions={"alpha"})
        api = FakeApi([decision_json(session="alpha")])
        runner = self.make_runner(api, reader=reader)
        state = runner.state
        landed = self._seed_injected_todo(
            state, target_session="alpha", logical_key="k-landed", injected_minutes_ago=10
        )

        runner.run_once(session_names=["alpha"])

        # targeted patrol must not run end-of-patrol maintenance
        self.assertEqual(self._todo_status(state, landed), "injected")


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
    def test_notify_console_returns_delivery_receipt(self):
        class Response:
            status = 200

            def read(self):
                return b'{"messageId":"om_notify_123","degraded":true,"code":"card_fallback"}'

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        api = HeartbeatApi(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
        with patch("heartbeat_patrol.api.urllib.request.urlopen", return_value=Response()):
            receipt = api.notify_console(title="handoff", body="target needs attention", level="error")

        self.assertEqual(
            receipt,
            {"status": "degraded", "message_id": "om_notify_123", "detail": "card_fallback"},
        )

    def test_send_user_message_prefixes_framework_marker_idempotently(self):
        api = HeartbeatApi(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")

        with patch("heartbeat_patrol.api.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")

            api.send_user_message("oc_alpha", "子 session 完成结果\n关联 ID：comm_123")
            api.send_user_message("oc_alpha", "Δ子 session 完成结果\n关联 ID：comm_123")

        first_command = run.call_args_list[0].args[0]
        second_command = run.call_args_list[1].args[0]
        self.assertEqual(first_command[first_command.index("--text") + 1], "Δ子 session 完成结果\n关联 ID：comm_123")
        self.assertEqual(second_command[second_command.index("--text") + 1], "Δ子 session 完成结果\n关联 ID：comm_123")

    def test_get_spawn_async_item_by_comm_uses_read_only_lookup(self):
        class Response:
            status = 200

            def read(self):
                return b'{"ok":true,"ref":"async_lookup","status":"closed","verdict":"caller_consumed"}'

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

        api = HeartbeatApi(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
        with patch("heartbeat_patrol.api.urllib.request.urlopen", return_value=Response()) as urlopen:
            item = api.get_spawn_async_item_by_comm("comm_lookup1234_1")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://example.invalid/api/spawn_async_items/by-comm/comm_lookup1234_1")
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(item, {"ok": True, "ref": "async_lookup", "status": "closed", "verdict": "caller_consumed"})

    def test_spawn_payloads_use_configured_heartbeat_session(self):
        api = RecordingApi()

        api.run_controller_decision("controller prompt", "gpt-5.4-mini")
        api.spawn_child("alpha", "child prompt", "gpt-5.4-mini")

        self.assertEqual(api.posts[0][0], "/api/spawn2.0")
        self.assertEqual(api.posts[1][0], "/api/spawn2.0")
        self.assertEqual(api.posts[0][1]["target"], "hb-custom")
        self.assertEqual(api.posts[0][1]["from"], "hb-custom")
        self.assertEqual(api.posts[1][1]["target"], "alpha")
        self.assertEqual(api.posts[1][1]["from"], "hb-custom")

    def test_spawn_payloads_include_spawn2_closure_and_verification_predicates(self):
        api = RecordingApi()

        api.run_controller_decision("controller prompt", "gpt-5.4-mini")
        api.spawn_child("alpha", "child prompt", "gpt-5.4-mini")

        controller_payload = api.posts[0][1]
        self.assertRegex(controller_payload["client_request_id"], r"^\d{4}-\d{2}-\d{2}:heartbeat:controller:")
        self.assertEqual(controller_payload["execution"], {"backend": "codex", "model": "gpt-5.4-mini"})
        self.assertEqual(controller_payload["closure"], {"kind": "message", "target": {"type": "inline"}})
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
        self.assertRegex(child_payload["client_request_id"], r"^\d{4}-\d{2}-\d{2}:heartbeat:child:")
        self.assertEqual(child_payload["execution"], {"backend": "codex", "model": "gpt-5.4-mini"})
        self.assertEqual(child_payload["closure"], {"kind": "message", "target": {"type": "inline"}})
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
        self.assertEqual(api.posts[0][0], "/api/spawn2.0")
        self.assertEqual(api.posts[0][1]["execution"], {"backend": "codex", "model": "gpt-5.5"})
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
        self.assertEqual(api.payload["closure"], {"kind": "message", "target": {"type": "inline"}})
        self.assertRegex(api.payload["client_request_id"], r"^\d{4}-\d{2}-\d{2}:heartbeat:resume:")
        predicate = api.payload["verification_predicate"]
        token = predicate["contains_all"][0]
        self.assertEqual(predicate["type"], "inbox-message")
        self.assertEqual(predicate["session_name"], "hb-custom")
        self.assertEqual(predicate["field"], "final_message")
        self.assertEqual(predicate["expected_window_sec"], 600)
        self.assertIn(token, api.payload["prompt"])

    def test_user_resume_composer_reports_provider_error_from_switched_async_item(self):
        class DeferredComposerApi(HeartbeatApi):
            def __init__(self):
                super().__init__(api_base="http://example.invalid", lark_cli="lark-cli", heartbeat_session="hb-custom")
                self.lookup_comm_id = None

            def _post_json(self, path, payload):
                return {"ok": False, "status": "switched_async", "spawnCommId": "comm_resume_limited"}

            def get_spawn_async_item_by_comm(self, comm_id):
                self.lookup_comm_id = comm_id
                return {
                    "ok": True,
                    "status": "parked",
                    "errorMessage": "You've hit your usage limit. Try again at Aug 8th, 2026 11:34 AM.",
                }

        api = DeferredComposerApi()
        item = DecisionItem(
            logical_key="drawing:resume-1",
            severity="warn",
            decision="user_resume",
            reason="target needs a continuation nudge",
            target_session="drawing",
            child_model="gpt-5.5",
            prompt="Ask drawing to continue the unfinished revision.",
        )

        with self.assertRaisesRegex(ApiError, "provider limit: You've hit your usage limit"):
            api.compose_user_resume_message(item=item, target_session={"name": "drawing"}, model="gpt-5.5")

        self.assertEqual(api.lookup_comm_id, "comm_resume_limited")
        self.assertEqual(api.last_resume_response["status"], "switched_async")

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
        self.assertIn("Do not assert or explain why a failure", prompt)

    def test_user_resume_rejects_cause_attribution_messages(self):
        from heartbeat_patrol.runner import _normalize_user_resume_message

        bad_messages = [
            "刚才那个超时是后台重启引起的，不是业务逻辑本身失败。继续推进采购数据迁移。",
            "这次报错不是业务问题，继续跑就行。",
            "原因是配置漂移，继续处理剩下的部分。",
            "The previous timeout was caused by a backend restart. Please continue.",
        ]
        for message in bad_messages:
            with self.subTest(message=message):
                with self.assertRaises(RuntimeError):
                    _normalize_user_resume_message(message)

        good_messages = [
            "之前因为每周限额没跑完，现在继续帮我查一下剩余的部分。",
            "状态正常，继续按刚才的思路把剩下的内容往下处理，先把未完成的部分接着收尾。",
            "继续处理这次 dirty set：能安全提交的先分批提交。",
        ]
        for message in good_messages:
            with self.subTest(message=message):
                self.assertTrue(_normalize_user_resume_message(message))

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
