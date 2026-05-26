from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from threading import BoundedSemaphore
import re
import time
from typing import Any

from .api import HeartbeatApi
from .config import Config
from .decision import DecisionError, DecisionItem, build_controller_prompt, parse_decision
from .prefilter import provider_limit_pause_reason, should_check_with_model
from .sm_reader import SuperMatrixReader
from .state import HeartbeatState


USER_RESUME_TARGET_PERSPECTIVE_RE = re.compile(
    r"(?:修正版|结果|文件|方案).{0,12}(?:已经|已).{0,20}(?:交付|提交|发到群里|发出|完成)"
    r"|(?:我|我们|这边)?(?:已经|已).{0,30}(?:交付|提交|发到群里|发出|完成|修正|处理)"
    r"|(?:已经|已).{0,20}按要求.{0,20}(?:修正|处理|完成)"
    r"|我继续跟进"
)
RECOVERY_TODO_TYPES = {
    "async_handoff_recovery",
    "child_recovery",
    "child_result_delivery",
    "handoff_ack",
    "spawn_closure",
    "status_reconcile",
}
USER_RESUME_MESSAGE_MAX_CHARS = 3000


def child_prompt(item: DecisionItem) -> str:
    return (
        f"Heartbeat follow-up for `{item.logical_key}`.\n"
        f"Reason: {item.reason}\n\n"
        f"{item.prompt}\n\n"
        "No-cascade constraint: Do not spawn other sessions unless heartbeat explicitly asked you to.\n"
        "Return this structure: evidence found, action taken, remaining blocker, human attention needed."
    )


@dataclass
class PatrolRunner:
    state: HeartbeatState
    reader: Any
    api: Any
    controller_model: str
    escalation_model: str
    max_recent_runs: int
    stale_running_minutes: int
    child_sla_minutes: int
    max_sessions_per_patrol: int
    max_controller_concurrency: int
    max_escalation_concurrency: int
    model_prefilter_enabled: bool

    def __post_init__(self) -> None:
        self._escalation_semaphore = BoundedSemaphore(max(1, self.max_escalation_concurrency))

    def run_once(self) -> dict[str, Any]:
        patrol_id = self.state.start_patrol(self.controller_model)
        stats = {
            "sessions_scanned": 0,
            "items_detected": 0,
            "alerts_sent": 0,
            "alerts_skipped_duplicate": 0,
            "spawns_started": 0,
            "spawns_skipped_duplicate": 0,
            "sessions_prefilter_skipped": 0,
            "user_resumes_sent": 0,
            "user_resumes_skipped_duplicate": 0,
            "user_resumes_skipped_session_cap": 0,
            "todos_injected": 0,
        }
        errors: list[str] = []

        try:
            try:
                sessions = self.reader.list_enabled_sessions()
                sessions = self._session_batch(sessions)
            except Exception as exc:
                errors.append(f"list enabled sessions failed: {exc}")
                sessions = []

            session_names = [str(session.get("name", "")) for session in sessions]
            for result in self._process_sessions(sessions, patrol_id=patrol_id):
                for key, value in result["stats"].items():
                    stats[key] += value
                errors.extend(result["errors"])
            if session_names:
                self.state.set_value("last_scanned_session", session_names[-1])
        finally:
            self.state.finish_patrol(
                patrol_id,
                sessions_scanned=stats["sessions_scanned"],
                items_detected=stats["items_detected"],
                alerts_sent=stats["alerts_sent"],
                spawns_started=stats["spawns_started"],
                spawns_skipped_duplicate=stats["spawns_skipped_duplicate"],
                errors=errors,
            )

        return {"stats": stats, "errors": errors}

    def _process_sessions(self, sessions: list[dict[str, Any]], *, patrol_id: str) -> list[dict[str, Any]]:
        if not sessions:
            return []
        worker_count = self._worker_count(len(sessions))
        if worker_count == 1:
            return [self._process_session(session, patrol_id=patrol_id) for session in sessions]

        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(self._process_session, session, patrol_id=patrol_id): str(session.get("name", ""))
                for session in sessions
            }
            for future in as_completed(futures):
                session_name = futures[future]
                try:
                    results.append(future.result())
                except Exception as exc:
                    results.append(
                        {
                            "stats": self._empty_stats(sessions_scanned=1),
                            "errors": [f"{session_name}: controller decision failed: {exc}"],
                        }
                    )
        return results

    def _process_session(self, session: dict[str, Any], *, patrol_id: str) -> dict[str, Any]:
        stats = self._empty_stats(sessions_scanned=1)
        errors: list[str] = []
        session_name = str(session.get("name", ""))
        try:
            self.state.expire_pause_if_needed(session_name)
            pause = self.state.active_pause_for_session(session_name)
            if pause is not None:
                return {"stats": stats, "errors": errors}
            packet = self.reader.build_packet(session, max_recent_runs=self.max_recent_runs)
            packet["pending_todos"] = self.state.pending_todos_for_session(session_name)
            packet["heartbeat_policy"] = {
                "now_ms": int(time.time() * 1000),
                "stale_running_minutes": self.stale_running_minutes,
                "child_sla_minutes": self.child_sla_minutes,
            }
            limit_reason = provider_limit_pause_reason(packet, now_ms=packet["heartbeat_policy"]["now_ms"])
            if limit_reason:
                self.state.pause_session(
                    session_name=session_name,
                    minutes=60,
                    reason=f"auto stop 60 after {limit_reason}",
                    source="provider_limit_auto_pause",
                )
                return {"stats": stats, "errors": errors}
            should_check, prefilter_reasons = should_check_with_model(
                packet,
                now_ms=packet["heartbeat_policy"]["now_ms"],
                stale_running_minutes=self.stale_running_minutes,
                child_sla_minutes=self.child_sla_minutes,
            )
            if self.model_prefilter_enabled and not should_check:
                stats["sessions_prefilter_skipped"] += 1
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="session_prefilter_skip",
                    target_session=session_name,
                    decision="skip",
                    status="skipped",
                    summary="; ".join(prefilter_reasons),
                )
                return {"stats": stats, "errors": errors}
            prompt = build_controller_prompt(
                packet,
                controller_model=self.controller_model,
                escalation_model=self.escalation_model,
            )
            decision = self._controller_decision(prompt, session_name)
        except Exception as exc:
            errors.append(f"{session_name}: controller decision failed: {exc}")
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="session_error",
                target_session=session_name,
                status="failed",
                summary="controller decision failed",
                error=str(exc),
            )
            return {"stats": stats, "errors": errors}

        non_skip_items = [item for item in decision.items if item.decision != "skip"]
        decision_names = sorted({item.decision for item in non_skip_items}) or ["skip"]
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="session_decision",
            target_session=session_name,
            decision=",".join(decision_names),
            status="completed",
            summary=f"items={len(decision.items)}; non_skip={len(non_skip_items)}",
        )
        stats["items_detected"] += len(non_skip_items)
        if self._should_prioritize_recovery_todo(non_skip_items):
            try:
                if self._drain_todo_if_idle(
                    packet,
                    session=session,
                    stats=stats,
                    patrol_id=patrol_id,
                    todo_types=RECOVERY_TODO_TYPES,
                ):
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="historical_items_skipped_for_recovery_todo",
                        target_session=session_name,
                        status="skipped",
                        summary=f"items={len(non_skip_items)}",
                    )
                    return {"stats": stats, "errors": errors}
            except Exception as exc:
                errors.append(f"{session_name}: recovery todo drain failed: {exc}")
                if _has_pending_todo_type(packet, {"spawn_closure"}):
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="historical_items_skipped_after_recovery_todo_failure",
                        target_session=session_name,
                        status="skipped",
                        summary=f"items={len(non_skip_items)}; pending_todo_type=spawn_closure",
                    )
                    return {"stats": stats, "errors": errors}
            if _has_pending_todo_type(packet, {"spawn_closure"}):
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="historical_items_skipped_for_pending_spawn_closure_todo",
                    target_session=session_name,
                    status="skipped",
                    summary=f"items={len(non_skip_items)}",
                )
                return {"stats": stats, "errors": errors}

        user_resume_sent_this_session = False
        for item in decision.items:
            try:
                if item.decision == "user_resume" and user_resume_sent_this_session:
                    stats["user_resumes_skipped_session_cap"] += 1
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="user_resume_skipped_session_cap",
                        target_session=item.target_session,
                        logical_key=item.logical_key,
                        decision=item.decision,
                        child_model=item.child_model,
                        status="skipped",
                        summary=item.reason,
                    )
                    continue
                sent_before = stats["user_resumes_sent"]
                self._handle_item(item, session=session, stats=stats, patrol_id=patrol_id)
                if item.decision == "user_resume" and stats["user_resumes_sent"] > sent_before:
                    user_resume_sent_this_session = True
            except Exception as exc:
                errors.append(f"{item.target_session}:{item.logical_key}: {exc}")
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="item_error",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                    decision=item.decision,
                    child_model=item.child_model,
                    status="failed",
                    summary="item handling failed",
                    error=str(exc),
                )
        if not non_skip_items:
            try:
                self._drain_todo_if_idle(packet, session=session, stats=stats, patrol_id=patrol_id)
            except Exception as exc:
                errors.append(f"{session_name}: todo drain failed: {exc}")
        return {"stats": stats, "errors": errors}

    def _empty_stats(self, *, sessions_scanned: int = 0) -> dict[str, int]:
        return {
            "sessions_scanned": sessions_scanned,
            "items_detected": 0,
            "alerts_sent": 0,
            "alerts_skipped_duplicate": 0,
            "spawns_started": 0,
            "spawns_skipped_duplicate": 0,
            "sessions_prefilter_skipped": 0,
            "user_resumes_sent": 0,
            "user_resumes_skipped_duplicate": 0,
            "user_resumes_skipped_session_cap": 0,
            "todos_injected": 0,
        }

    def _session_batch(self, sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not sessions:
            return []
        limit = self.max_sessions_per_patrol
        if limit < 1 or limit >= len(sessions):
            return sessions

        last_scanned = self.state.get_value("last_scanned_session")
        names = [str(session.get("name", "")) for session in sessions]
        start = 0
        if last_scanned in names:
            start = (names.index(last_scanned) + 1) % len(sessions)

        rotated = sessions[start:] + sessions[:start]
        return rotated[:limit]

    def _worker_count(self, session_count: int) -> int:
        limit = self.max_controller_concurrency
        if limit < 1 or limit >= session_count:
            return session_count
        return limit

    def _controller_decision(self, prompt: str, session_name: str):
        raw = self._run_controller_with_retry(prompt)
        try:
            return parse_decision(raw, expected_session=session_name)
        except DecisionError as exc:
            first_error_text = str(exc)
            repair_prompt = (
                "The previous response was invalid for heartbeat's JSON contract. "
                "Return corrected JSON only for the same packet and do not add markdown.\n\n"
                f"Previous response:\n{raw}\n\nOriginal prompt:\n{prompt}"
            )

        raw = self._run_controller_with_retry(repair_prompt)
        try:
            return parse_decision(raw, expected_session=session_name)
        except DecisionError as exc:
            second_error_text = str(exc)
            escalation_prompt = (
                "The previous response was invalid for heartbeat's JSON contract. "
                "Return corrected JSON only for the same packet and do not add markdown.\n\n"
                f"Previous response:\n{raw}\n\nOriginal prompt:\n{prompt}"
            )

        raw = self.api.run_controller_decision(escalation_prompt, self.escalation_model)
        try:
            return parse_decision(raw, expected_session=session_name)
        except DecisionError as third_error:
            raise DecisionError(
                f"invalid controller JSON after repair/escalation: {first_error_text}; {second_error_text}; {third_error}"
            ) from third_error

    def _run_controller_with_retry(self, prompt: str) -> str:
        try:
            return self.api.run_controller_decision(prompt, self.controller_model)
        except DecisionError:
            raise
        except Exception as exc:
            if self._is_controller_rate_limit(exc):
                return self._run_escalation_decision(prompt)
        try:
            return self.api.run_controller_decision(prompt, self.controller_model)
        except Exception as exc:
            if self._is_controller_rate_limit(exc):
                return self._run_escalation_decision(prompt)
            raise

    def _run_escalation_decision(self, prompt: str) -> str:
        with self._escalation_semaphore:
            return self.api.run_controller_decision(prompt, self.escalation_model)

    def _is_controller_rate_limit(self, exc: Exception) -> bool:
        text = str(exc).lower()
        return "http 429" in text or "rate_limit" in text or "too many requests" in text

    def _handle_item(
        self,
        item: DecisionItem,
        *,
        session: dict[str, Any],
        stats: dict[str, int],
        patrol_id: str,
    ) -> None:
        if item.decision == "skip":
            return
        if item.decision == "alert":
            chat_id = session.get("group_id")
            if not isinstance(chat_id, str) or not chat_id:
                raise RuntimeError("alert requested but target session has no group_id")
            claimed = self.state.try_claim_action(
                action_type="alert",
                target_session=item.target_session,
                logical_key=item.logical_key,
            )
            if not claimed:
                stats["alerts_skipped_duplicate"] += 1
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="alert_skipped_duplicate",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                    decision=item.decision,
                    child_model=item.child_model,
                    status="skipped",
                    summary=item.reason,
                )
                return
            user_message = _alert_user_message(item)
            try:
                self.api.send_alert(chat_id, item.prompt)
                self.api.send_user_message(chat_id, user_message)
            except Exception:
                self.state.release_action_claim(
                    action_type="alert",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                )
                raise
            self.state.finish_action(
                action_type="alert",
                target_session=item.target_session,
                logical_key=item.logical_key,
                status="sent",
                detail=f"alert={item.prompt}; user_message={user_message}",
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="alert_sent",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="sent",
                summary=f"{item.reason}; alert_message={item.prompt}; user_message={user_message}",
            )
            stats["alerts_sent"] += 1
            return
        if item.decision in {"spawn_collect", "spawn_execute", "escalate"}:
            self._spawn_for_item(item, stats=stats, patrol_id=patrol_id)
            return
        if item.decision == "user_resume":
            self._send_user_resume_for_item(item, session=session, stats=stats, patrol_id=patrol_id)
            return
        raise RuntimeError(f"unsupported decision: {item.decision}")

    def _send_user_resume_for_item(
        self,
        item: DecisionItem,
        *,
        session: dict[str, Any],
        stats: dict[str, int],
        patrol_id: str,
    ) -> None:
        chat_id = session.get("group_id")
        if not isinstance(chat_id, str) or not chat_id:
            raise RuntimeError("user_resume requested but target session has no group_id")
        claimed = self.state.try_claim_action(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
        )
        if not claimed:
            stats["user_resumes_skipped_duplicate"] += 1
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="user_resume_skipped_duplicate",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="skipped",
                summary=item.reason,
            )
            return

        try:
            message = _normalize_user_resume_message(
                self.api.compose_user_resume_message(item=item, target_session=session, model=item.child_model)
            )
            self.api.send_user_message(chat_id, message)
        except Exception:
            self.state.release_action_claim(
                action_type="user_resume",
                target_session=item.target_session,
                logical_key=item.logical_key,
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="user_resume_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="failed",
                summary=item.reason,
                error="user resume failed",
            )
            raise

        self.state.finish_action(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
            status="sent",
            detail=message,
        )
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="user_resume_sent",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_model=item.child_model,
            status="sent",
            summary=f"{item.reason}; user_message={message}",
        )
        stats["user_resumes_sent"] += 1

    def _drain_todo_if_idle(
        self,
        packet: dict[str, Any],
        *,
        session: dict[str, Any],
        stats: dict[str, int],
        patrol_id: str,
        todo_types: set[str] | None = None,
    ) -> bool:
        session_name = str(session.get("name", ""))
        if not self._session_idle_for_todo(packet, session):
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="todo_skipped_session_busy",
                target_session=session_name,
                status="skipped",
                summary="session is not idle",
            )
            return False
        claim = self.state.claim_next_todo_batch(target_session=session_name, todo_types=todo_types)
        if claim is None:
            return False
        todo_ids = [todo.todo_id for todo in claim.todos]
        chat_id = session.get("group_id")
        if not isinstance(chat_id, str) or not chat_id:
            self.state.mark_todos_failed(todo_ids=todo_ids, detail="target session has no group_id")
            raise RuntimeError("todo injection requested but target session has no group_id")
        try:
            message = _normalize_todo_injection_message(_todo_claim_message(claim))
            self.api.send_user_message(chat_id, message)
        except Exception as exc:
            self.state.mark_todos_failed(todo_ids=todo_ids, detail=str(exc))
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="todo_injection_failed",
                target_session=session_name,
                logical_key=",".join(todo.logical_key for todo in claim.todos),
                status="failed",
                summary=_todo_summary(claim, ""),
                error=str(exc),
            )
            raise
        self.state.mark_todos_injected(todo_ids=todo_ids, detail=message)
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="todo_injected",
            target_session=session_name,
            logical_key=",".join(todo.logical_key for todo in claim.todos),
            status="sent",
            summary=_todo_summary(claim, message),
        )
        stats["todos_injected"] += 1
        return True

    def _session_idle_for_todo(self, packet: dict[str, Any], session: dict[str, Any]) -> bool:
        if str(session.get("status", "")).lower() != "idle":
            return False
        latest_run = (packet.get("recent_runs") or [None])[0]
        if isinstance(latest_run, dict) and str(latest_run.get("status", "")).lower() == "running":
            return False
        return True

    def _should_prioritize_recovery_todo(self, items: list[DecisionItem]) -> bool:
        if not items:
            return False
        if any(item.decision in {"alert", "escalate", "spawn_execute"} for item in items):
            return False
        if any(item.decision not in {"user_resume", "spawn_collect", "skip"} for item in items):
            return False
        return True

    def _spawn_for_item(self, item: DecisionItem, *, stats: dict[str, int], patrol_id: str) -> None:
        claimed = self.state.try_claim_spawn(
            target_session=item.target_session,
            logical_key=item.logical_key,
            child_model=item.child_model,
        )
        if not claimed:
            stats["spawns_skipped_duplicate"] += 1
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="spawn_skipped_duplicate",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="skipped",
                summary=item.reason,
            )
            return

        try:
            response = self.api.spawn_child(item.target_session, child_prompt(item), item.child_model)
        except Exception:
            self.state.release_spawn_claim(target_session=item.target_session, logical_key=item.logical_key)
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="spawn_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="failed",
                summary=item.reason,
                error="spawn_child failed",
            )
            raise

        child_session_id = response.get("childSessionId")
        if not isinstance(child_session_id, str) or not child_session_id:
            self.state.release_spawn_claim(target_session=item.target_session, logical_key=item.logical_key)
            raise RuntimeError("spawn response missing childSessionId")
        self.state.mark_spawn_started(
            target_session=item.target_session,
            logical_key=item.logical_key,
            child_session_id=child_session_id,
        )
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="spawn_started",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_session_id=child_session_id,
            child_model=item.child_model,
            status="running",
            summary=item.reason,
        )
        stats["spawns_started"] += 1


def _normalize_user_resume_message(value: Any) -> str:
    return _normalize_outgoing_user_message(
        value,
        max_chars=USER_RESUME_MESSAGE_MAX_CHARS,
        reject_target_perspective=True,
    )


def _normalize_todo_injection_message(value: Any) -> str:
    return _normalize_outgoing_user_message(value, max_chars=None, reject_target_perspective=False)


def _normalize_outgoing_user_message(
    value: Any,
    *,
    max_chars: int | None,
    reject_target_perspective: bool,
) -> str:
    if not isinstance(value, str):
        raise RuntimeError("user resume composer returned a non-string message")
    text = value.strip()
    if text.startswith("```") and text.endswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3:
            text = "\n".join(lines[1:-1]).strip()
    if not text:
        raise RuntimeError("user resume composer returned an empty message")
    if reject_target_perspective and USER_RESUME_TARGET_PERSPECTIVE_RE.search(text):
        raise RuntimeError("user resume message uses target session perspective")
    if max_chars is not None:
        return text[:max_chars]
    return text


def _has_pending_todo_type(packet: dict[str, Any], todo_types: set[str]) -> bool:
    for todo in packet.get("pending_todos") or []:
        if not isinstance(todo, dict):
            continue
        if str(todo.get("status", "")).lower() != "pending":
            continue
        if str(todo.get("todo_type") or "general") in todo_types:
            return True
    return False


def _todo_claim_message(claim: Any) -> str:
    todos = list(getattr(claim, "todos", []) or [])
    if len(todos) == 1:
        return str(todos[0].message)
    lines = ["以下是同一批待办，请一次性处理并汇总：", ""]
    batch_key = getattr(claim, "batch_key", None)
    if batch_key:
        lines.append(f"批次：{batch_key}")
    for index, todo in enumerate(todos, start=1):
        lines.append(f"{index}. {todo.message}")
    lines.extend(["", "请按这些输入统一处理，完成后给出汇总结论。"])
    return "\n".join(lines)


def _alert_user_message(item: DecisionItem) -> str:
    prompt = " ".join(str(item.prompt).strip().split())
    if len(prompt) > 600:
        prompt = prompt[:600].rstrip() + "..."
    if prompt:
        return (
            f"这里需要我补充参数或做确认：{prompt} "
            "请把缺少的参数、可选项和推荐默认值整理成一个简短问题问我；先不要替我决定，也不要继续执行后面的待办。"
        )
    return "这里看起来需要我补充参数或做确认。请把缺少的参数、可选项和推荐默认值整理成一个简短问题问我；先不要替我决定，也不要继续执行后面的待办。"


def _todo_summary(claim: Any, message: str) -> str:
    todo_ids = ",".join(str(todo.todo_id) for todo in getattr(claim, "todos", []) or [])
    logical_keys = ",".join(str(todo.logical_key) for todo in getattr(claim, "todos", []) or [])
    batch_key = getattr(claim, "batch_key", None) or ""
    parts = [f"todo_ids={todo_ids}", f"logical_keys={logical_keys}"]
    if batch_key:
        parts.append(f"batch_key={batch_key}")
    if message:
        parts.append(f"user_message={message}")
    return "; ".join(parts)


def build_default_runner(cfg: Config) -> PatrolRunner:
    return PatrolRunner(
        state=HeartbeatState(cfg.state_db_path),
        reader=SuperMatrixReader(cfg.sm_db_path),
        api=HeartbeatApi(
            api_base=cfg.api_base,
            lark_cli=cfg.lark_cli,
            heartbeat_session=cfg.heartbeat_session,
            controller_provider=cfg.controller_provider,
            minimax_api_key=cfg.minimax_api_key,
            minimax_base_url=cfg.minimax_base_url,
            minimax_model=cfg.minimax_model,
        ),
        controller_model=cfg.controller_model,
        escalation_model=cfg.escalation_model,
        max_recent_runs=cfg.max_recent_runs,
        stale_running_minutes=cfg.stale_running_minutes,
        child_sla_minutes=cfg.child_sla_minutes,
        max_sessions_per_patrol=cfg.max_sessions_per_patrol,
        max_controller_concurrency=cfg.max_controller_concurrency,
        max_escalation_concurrency=cfg.max_escalation_concurrency,
        model_prefilter_enabled=cfg.model_prefilter_enabled,
    )
