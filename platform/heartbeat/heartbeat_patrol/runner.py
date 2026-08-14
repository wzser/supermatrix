from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from threading import BoundedSemaphore
import re
import time
from typing import Any

from .api import ApiError, HeartbeatApi
from .config import Config
from .decision import DecisionError, DecisionItem, build_controller_prompt, parse_decision
from .prefilter import (
    NO_LOCAL_CANDIDATE_SIGNAL,
    DEFAULT_PROVIDER_LIMIT_PAUSE_MINUTES,
    PROVIDER_LIMIT_RE,
    has_user_confirmation_gate,
    provider_limit_pause,
    provider_limit_recovery,
    should_check_with_model,
    trim_packet_to_candidate_window,
)
from .sm_reader import SuperMatrixReader
from .state import HeartbeatState
from .todo_watch import ensure_todo_watch, watch_settings_from_config


USER_RESUME_TARGET_PERSPECTIVE_RE = re.compile(
    r"(?:修正版|结果|文件|方案).{0,12}(?:已经|已).{0,20}(?:交付|提交|发到群里|发出|完成)"
    r"|(?:我|我们|这边)?(?:已经|已).{0,30}(?:交付|提交|发到群里|发出|修正|处理)"
    r"|(?:我|我们|这边)?(?:已经|已).{0,30}完成(?=\s*(?:了|。|，|；|、|!|！|$))"
    r"|(?:已经|已).{0,20}按要求.{0,20}(?:修正|处理|完成)"
    r"|我继续跟进"
)
# user_resume 文案不得替用户断言故障原因 / 业务结论（prompt 层之外的第二层保险）。
USER_RESUME_CAUSE_ATTRIBUTION_RE = re.compile(
    r"(?:是|由|因为|由于)[^，。；,;]{0,16}(?:引起|导致|造成)的?"
    r"|不是[^，。；,;]{0,12}(?:问题|失败|故障|错误)"
    r"|原因是|根因|根本原因|归因于"
    r"|(?:was|is|were)\s+caused\s+by|root\s+cause|the\s+reason\s+(?:is|was)",
    re.IGNORECASE,
)
# 注入落地校验窗口（send_user_message 只证"触发"，不证 owner session 真起了 run）。
# min_age：注入后先等 run 有机会出现再查；deadline：超过仍无 run 才判 unconfirmed；
# lookback：只回看近段注入（更早的 message_runs 可能已过 TTL，回查无意义）。
INJECTED_LANDING_MIN_AGE_SECONDS = int(os.environ.get("HEARTBEAT_INJECTED_LANDING_MIN_AGE_SECONDS", "180"))
INJECTED_LANDING_DEADLINE_SECONDS = int(
    os.environ.get("HEARTBEAT_INJECTED_LANDING_DEADLINE_SECONDS", str(6 * 3600))
)
INJECTED_LANDING_LOOKBACK_SECONDS = int(
    os.environ.get("HEARTBEAT_INJECTED_LANDING_LOOKBACK_SECONDS", str(24 * 3600))
)
INJECTED_LANDING_BATCH_LIMIT = int(os.environ.get("HEARTBEAT_INJECTED_LANDING_BATCH_LIMIT", "200"))
LEGACY_INJECTED_TODO_CUTOFF = "2026-07-01T00:00:00+00:00"
LEGACY_INJECTED_TODO_ARCHIVE_LIMIT = 5000
COMM_ID_RE = re.compile(r"comm_[A-Za-z0-9]+(?:_[0-9]+)?")
CLOSURE_NO_ACTION_RE = re.compile(r"(?im)^\s*SM_CLOSURE_ACTION\s*:\s*no_action\s*$")
RECOVERY_TODO_TYPES = {
    "async_handoff_recovery",
    "child_recovery",
    "child_result_delivery",
    "handoff_ack",
    "spawn_closure",
    "status_reconcile",
}
USER_RESUME_MESSAGE_MAX_CHARS = 3000
USER_RESUME_PROVIDER_LIMIT_FALLBACK_MESSAGE = (
    "请基于当前上下文继续处理仍未完成的事项，避免重复已完成的工作，并在完成后直接回报结果。"
)
USER_RESUME_PROVIDER_LIMIT_FALLBACK_MESSAGE_EN = (
    "Please continue from the current context, handle any unfinished work, avoid duplicating completed work, and report the result."
)
TODO_BATCH_INLINE_MAX_CHARS = 8000
TODO_BATCH_ITEM_PREVIEW_CHARS = 700
RETIRED_BOUNDED_CHILD_MODEL = "gpt-5.4-mini"
SUPPORTED_BOUNDED_CHILD_MODEL = "gpt-5.5"
TODO_BATCH_PAYLOAD_DIR = Path(
    os.environ.get(
        "HEARTBEAT_TODO_BATCH_PAYLOAD_DIR",
        str(Path(__file__).resolve().parents[1] / "data" / "todo-batch-payloads"),
    )
)
SESSION_CATALOG_PATH = Path(__file__).resolve().parents[1] / "session-catalog.json"
_SESSION_ALIAS_CACHE: dict[str, str] | None = None


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
    candidate_max_age_hours: int
    max_sessions_per_patrol: int
    max_controller_concurrency: int
    max_escalation_concurrency: int
    model_prefilter_enabled: bool
    # drain miss（busy / batch 未 ready）且仍有 pending todo 时，请求一个 busy->idle watcher。
    todo_watch_launcher: Any = None
    # poison-pill：同 logical_key 连续失败达到阈值后进入冷却，期间跳过重试。
    action_failure_threshold: int = 3
    action_cooldown_minutes: int = 360
    # target-scoped 升级：controller 每轮换 logical_key 时 per-key 冷却测不到「同一 target 反复推不动」，
    # 这里按 (action_type, target_session) 在滚动窗口内累计失败，越阈值就落一条人可见的升级证据。
    unrecovered_escalation_threshold: int = 3
    unrecovered_window_minutes: int = 360
    # Sparse or stopped failures never cross the rolling count threshold, so age out unresolved
    # episodes into the same durable handoff path. Set to 0 only to explicitly disable this backstop.
    unrecovered_max_unreconciled_hours: int = 24
    unrecovered_reescalate_minutes: int = 720

    def __post_init__(self) -> None:
        self._escalation_semaphore = BoundedSemaphore(max(1, self.max_escalation_concurrency))

    def _effective_child_model(self, requested_model: str) -> str:
        """Keep old persisted controller decisions executable after the gpt-5.4 retirement."""
        if requested_model == RETIRED_BOUNDED_CHILD_MODEL:
            return SUPPORTED_BOUNDED_CHILD_MODEL
        return requested_model

    def run_once(self, *, session_names: list[str] | None = None) -> dict[str, Any]:
        patrol_id = self.state.start_patrol(self.controller_model)
        targeted = bool(session_names)
        stats = {
            "eligible_sessions": 0,
            "coverage_scope": "targeted" if targeted else "full",
            "sessions_scanned": 0,
            "items_detected": 0,
            "alerts_sent": 0,
            "alerts_skipped_duplicate": 0,
            "spawns_started": 0,
            "spawns_skipped_duplicate": 0,
            "sessions_prefilter_skipped": 0,
            "user_resumes_sent": 0,
            "user_resume_composer_fallbacks": 0,
            "user_resumes_blocked_confirmation_gate": 0,
            "user_resumes_skipped_duplicate": 0,
            "user_resumes_skipped_session_cap": 0,
            "user_resumes_skipped_session_busy": 0,
            "user_resumes_skipped_backoff": 0,
            "spawns_skipped_backoff": 0,
            "todos_injected": 0,
            "todos_cleared": 0,
            "spawns_reconciled_timeout": 0,
            "todos_landing_verified": 0,
            "todos_landing_unconfirmed": 0,
            "unrecovered_targets_escalated": 0,
            "unrecovered_targets_reconciled": 0,
            "action_claims_reconciled_completed": 0,
            "action_claims_reconciled_failed": 0,
            "legacy_injected_todos_archived": 0,
        }
        errors: list[str] = []

        try:
            try:
                if session_names:
                    sessions = self._sessions_by_name(session_names)
                    stats["eligible_sessions"] = len(sessions)
                else:
                    eligible_sessions = self.reader.list_enabled_sessions()
                    stats["eligible_sessions"] = len(eligible_sessions)
                    sessions = self._session_batch(eligible_sessions)
                    if len(sessions) < len(eligible_sessions):
                        stats["coverage_scope"] = "batched"
            except Exception as exc:
                errors.append(f"list enabled sessions failed: {exc}")
                sessions = []

            session_names = [str(session.get("name", "")) for session in sessions]
            for result in self._process_sessions(sessions, patrol_id=patrol_id, targeted=targeted):
                for key, value in result["stats"].items():
                    stats[key] += value
                errors.extend(result["errors"])
            if session_names and not targeted:
                self.state.set_value("last_scanned_session", session_names[-1])
            # 全量巡检末尾做一次有界维护：回收超 SLA 的孤儿 running spawn，并校验注入是否真落地。
            # 定向巡检 / watcher 点火不做（避免频繁全表维护，与事件 TTL 清理同策略）。
            if not targeted:
                try:
                    self._run_maintenance(patrol_id=patrol_id, stats=stats)
                except Exception as exc:
                    errors.append(f"patrol maintenance failed: {exc}")
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

        return {"patrol_id": patrol_id, "stats": stats, "errors": errors}

    def _run_maintenance(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        self._reconcile_stale_spawns(patrol_id=patrol_id, stats=stats)
        self._reconcile_completed_action_claims(patrol_id=patrol_id, stats=stats)
        self._reconcile_stale_action_claims(patrol_id=patrol_id, stats=stats)
        self._verify_injected_landings(patrol_id=patrol_id, stats=stats)
        self._archive_legacy_injected_todos(patrol_id=patrol_id, stats=stats)
        self._reconcile_unrecovered_targets(patrol_id=patrol_id, stats=stats)

    def _reconcile_stale_spawns(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        reaped = self.state.reconcile_stale_running_spawns(sla_minutes=self.child_sla_minutes)
        for row in reaped:
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="spawn_reconciled_timeout",
                target_session=str(row.get("target_session") or ""),
                logical_key=str(row.get("logical_key") or ""),
                status="timeout",
                summary=(
                    f"running spawn exceeded {self.child_sla_minutes}m SLA with no closure; "
                    f"reaped to timeout (created_at={row.get('created_at')})"
                ),
                trigger_source="spawn_reconcile",
                trigger_cause="stale_running_no_closure",
                trigger_location=str(row.get("target_session") or ""),
            )
        stats["spawns_reconciled_timeout"] += len(reaped)

    def _reconcile_completed_action_claims(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        candidates = self.state.list_action_claims_for_cross_session_reconcile()
        if not candidates:
            return
        refs_by_key: dict[str, str] = {}
        for row in candidates:
            logical_key = str(row.get("logical_key") or "")
            comm_id = _extract_comm_id(logical_key)
            if comm_id:
                refs_by_key[logical_key] = comm_id
        if not refs_by_key:
            return
        resolver = getattr(self.reader, "completed_cross_session_logs", None)
        if not callable(resolver):
            return
        try:
            completed_refs = resolver(list(refs_by_key.values()))
        except Exception:
            return
        if not completed_refs:
            return
        detail_by_key = {
            logical_key: (
                f"cross_session_log {comm_id} completed; "
                f"finished_at={completed_refs[comm_id].get('finished_at')}"
            )
            for logical_key, comm_id in refs_by_key.items()
            if comm_id in completed_refs
        }
        completed = self.state.mark_action_claims_completed_from_cross_session(
            claims=candidates,
            detail_by_logical_key=detail_by_key,
        )
        for row in completed:
            logical_key = str(row.get("logical_key") or "")
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="action_claim_reconciled_completed",
                target_session=str(row.get("target_session") or ""),
                logical_key=logical_key,
                decision=str(row.get("action_type") or ""),
                status="completed",
                summary=detail_by_key.get(logical_key, "cross_session_log completed"),
                trigger_source="action_claim_reconcile",
                trigger_cause="cross_session_completed",
                trigger_location=str(row.get("target_session") or ""),
            )
        stats["action_claims_reconciled_completed"] += len(completed)

    def _reconcile_stale_action_claims(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        reaped = self.state.reconcile_stale_action_claims(max_age_minutes=self.action_cooldown_minutes)
        for row in reaped:
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="action_claim_reconciled_failed",
                target_session=str(row.get("target_session") or ""),
                logical_key=str(row.get("logical_key") or ""),
                decision=str(row.get("action_type") or ""),
                status="failed",
                summary=(
                    f"claimed action exceeded {self.action_cooldown_minutes}m SLA; "
                    f"created_at={row.get('created_at')}"
                ),
                trigger_source="action_claim_reconcile",
                trigger_cause="stale_claimed_no_finish",
                trigger_location=str(row.get("target_session") or ""),
            )
        stats["action_claims_reconciled_failed"] += len(reaped)

    def _verify_injected_landings(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        checker = getattr(self.reader, "session_run_landed_since", None)
        if not callable(checker):
            return
        todos = self.state.list_injected_todos_for_landing_check(
            min_age_seconds=INJECTED_LANDING_MIN_AGE_SECONDS,
            max_age_seconds=INJECTED_LANDING_LOOKBACK_SECONDS,
            limit=INJECTED_LANDING_BATCH_LIMIT,
        )
        if not todos:
            return
        now_ms = int(time.time() * 1000)
        for todo in todos:
            target_session = str(todo.get("target_session") or "")
            todo_id = str(todo.get("todo_id") or "")
            logical_key = str(todo.get("logical_key") or "")
            injected_ms = _iso_to_ms(todo.get("injected_at"))
            if injected_ms is None:
                continue
            landed = False
            try:
                landed = bool(checker(target_session, injected_ms))
            except Exception:
                # 读 message_runs 失败不阻断维护；下轮再校验。
                continue
            if landed:
                if self.state.mark_todos_landing_verified(
                    todo_ids=[todo_id],
                    detail="landing confirmed: message_run observed in target session after injection",
                ):
                    stats["todos_landing_verified"] += 1
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="todo_landing_verified",
                        target_session=target_session,
                        logical_key=logical_key,
                        status="completed",
                        summary="injected todo landed as a run in the target session",
                        trigger_source="todo_pool",
                        trigger_cause="landing_confirmed",
                        trigger_location=target_session,
                    )
            elif now_ms - injected_ms >= INJECTED_LANDING_DEADLINE_SECONDS * 1000:
                if self.state.mark_todos_landing_unconfirmed(
                    todo_ids=[todo_id],
                    detail=(
                        f"no message_run observed in target session within "
                        f"{INJECTED_LANDING_DEADLINE_SECONDS // 3600}h of injection"
                    ),
                ):
                    stats["todos_landing_unconfirmed"] += 1
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="todo_landing_unconfirmed",
                        target_session=target_session,
                        logical_key=logical_key,
                        status="failed",
                        summary="injected todo showed no landing run before deadline",
                        trigger_source="todo_pool",
                        trigger_cause="landing_missing",
                        trigger_location=target_session,
                    )

    def _archive_legacy_injected_todos(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        archived = self.state.archive_legacy_injected_todos(
            before=LEGACY_INJECTED_TODO_CUTOFF,
            limit=LEGACY_INJECTED_TODO_ARCHIVE_LIMIT,
        )
        if not archived:
            return
        stats["legacy_injected_todos_archived"] += len(archived)
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="legacy_injected_todos_archived",
            status="legacy_ignored",
            summary=(
                f"archived {len(archived)} injected todos before {LEGACY_INJECTED_TODO_CUTOFF}; "
                "landing cannot be mechanically proven for pre-verifier rows"
            ),
            trigger_source="todo_landing_verifier",
            trigger_cause="legacy_pre_verifier_cutoff",
            trigger_location="heartbeat",
        )

    def _reconcile_unrecovered_targets(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        self._reconcile_unrecovered_target_result_receipts(patrol_id=patrol_id, stats=stats)
        reconciled = self.state.reconcile_unrecovered_targets_from_later_events()
        for row in reconciled:
            target_session = str(row.get("target_session") or "")
            logical_key = str(row.get("logical_key") or "")
            recovery_event = str(row.get("recovery_event_type") or "")
            recovery_at = str(row.get("recovery_created_at") or "")
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="unrecovered_target_reconciled",
                target_session=target_session,
                logical_key=logical_key,
                decision=str(row.get("action_type") or ""),
                status="completed",
                summary=(
                    f"cleared failure_count={row.get('failure_count')} from last_failed_at="
                    f"{row.get('last_failed_at')}; exact logical_key={logical_key}; "
                    f"later {recovery_event} at {recovery_at}"
                ),
                trigger_source="unrecovered_target",
                trigger_cause="exact_key_recovery_evidence",
                trigger_location=target_session,
            )
        stats["unrecovered_targets_reconciled"] += len(reconciled)
        self._escalate_overdue_unrecovered_targets(patrol_id=patrol_id, stats=stats)

    def _escalate_overdue_unrecovered_targets(self, *, patrol_id: str, stats: dict[str, int]) -> None:
        """Escalate old active aggregates even when no fresh failure invokes the threshold path."""
        overdue = self.state.claim_unrecovered_targets_due_for_age_escalation(
            max_unreconciled_hours=self.unrecovered_max_unreconciled_hours,
            reescalate_minutes=self.unrecovered_reescalate_minutes,
        )
        for outcome in overdue:
            target_session = str(outcome["target_session"])
            action_type = str(outcome["action_type"])
            item = DecisionItem(
                logical_key=str(outcome["logical_key"]),
                severity="error",
                decision="escalate",
                reason=(
                    f"同一 logical_key 尚无精确 recovery evidence，且自 {outcome['window_started_at']} "
                    f"起已超过 {outcome['max_unreconciled_hours']}h 未 reconcile"
                ),
                target_session=target_session,
                child_model=self.escalation_model,
                prompt="No action.",
            )
            self._emit_unrecovered_escalation(
                action_type=action_type,
                item=item,
                outcome=outcome,
                error=str(outcome.get("last_error") or ""),
                stats=stats,
                patrol_id=patrol_id,
                trigger_cause="unrecovered_max_age",
            )

    def _reconcile_unrecovered_target_result_receipts(
        self, *, patrol_id: str, stats: dict[str, int]
    ) -> None:
        """Link a materialized target result to the exact failed logical key before any transition."""
        resolver = getattr(self.reader, "completed_heartbeat_child_results", None)
        if not callable(resolver):
            return
        active = self.state.list_unrecovered_targets_for_result_reconcile()
        active_pairs = {
            (str(row.get("target_session") or ""), str(row.get("logical_key") or "")) for row in active
        }
        legacy = [
            row
            for row in self.state.list_legacy_handoffs_for_result_reconcile()
            if (str(row.get("target_session") or ""), str(row.get("logical_key") or "")) not in active_pairs
        ]
        candidates: list[dict[str, Any]] = []
        for source, rows, boundary_field in (
            ("aggregate", active, "last_failed_at"),
            ("legacy_handoff", legacy, "created_at"),
        ):
            for row in rows:
                target_session = str(row.get("target_session") or "").strip()
                logical_key = str(row.get("logical_key") or "").strip()
                after_ms = _iso_to_ms(row.get(boundary_field))
                if not target_session or not logical_key or after_ms is None:
                    continue
                candidates.append(
                    {
                        "source": source,
                        "action_type": str(row.get("action_type") or ""),
                        "target_session": target_session,
                        "logical_key": logical_key,
                        "after_ms": after_ms,
                    }
                )
        if not candidates:
            return
        try:
            receipts = resolver(candidates)
        except Exception:
            return
        if not isinstance(receipts, dict):
            return
        for candidate in candidates:
            target_session = candidate["target_session"]
            logical_key = candidate["logical_key"]
            receipt = receipts.get((target_session, logical_key))
            if not isinstance(receipt, dict):
                continue
            comm_id = str(receipt.get("comm_id") or "").strip()
            finished_at = receipt.get("finished_at")
            output = str(receipt.get("final_message") or receipt.get("result_preview") or "").strip()
            if (
                not comm_id
                or type(finished_at) is not int
                or finished_at < int(candidate["after_ms"])
                or not output
            ):
                continue
            if _spawn_final_message_has_terminal_blocker(output):
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type=(
                        "unrecovered_target_result_linked"
                        if candidate["source"] == "aggregate"
                        else "unrecovered_handoff_result_linked"
                    ),
                    target_session=target_session,
                    logical_key=logical_key,
                    decision=str(candidate["action_type"]),
                    status="partial",
                    summary=(
                        f"cross_session_log {comm_id} completed; exact logical_key marker={logical_key}; "
                        "target result reports a terminal blocker, so active recovery is retained"
                    ),
                    trigger_source="cross_session_log",
                    trigger_cause="exact_logical_key_terminal_blocker",
                    trigger_location=target_session,
                )
                continue
            summary = (
                f"cross_session_log {comm_id} completed; exact logical_key marker={logical_key}; "
                f"finished_at={finished_at}; target result is non-empty; "
                "accepted only, business recovery is not inferred"
            )
            event_id = self.state.log_event(
                patrol_id=patrol_id,
                event_type=(
                    "unrecovered_target_result_linked"
                    if candidate["source"] == "aggregate"
                    else "unrecovered_handoff_result_linked"
                ),
                target_session=target_session,
                logical_key=logical_key,
                decision=str(candidate["action_type"]),
                status="accepted",
                summary=summary,
                trigger_source="cross_session_log",
                trigger_cause="exact_logical_key_target_result",
                trigger_location=target_session,
            )
            outcome = self.state.resolve_unrecovered_target(
                action_type=str(candidate["action_type"]),
                target_session=target_session,
                logical_key=logical_key,
                recovery_status="accepted",
                recovery_event_id=event_id,
                recovery_event_type="cross_session_result_linked",
                recovery_summary=summary,
            )
            if not outcome.get("aggregate_resolved"):
                continue
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="unrecovered_target_reconciled",
                target_session=target_session,
                logical_key=logical_key,
                decision=str(candidate["action_type"]),
                status="accepted",
                summary=(
                    f"cleared exact logical_key={logical_key}; {summary}; "
                    f"handoffs_updated={len(outcome.get('handoff_ids') or [])}"
                ),
                trigger_source="unrecovered_target",
                trigger_cause="exact_cross_session_result_accepted",
                trigger_location=target_session,
            )
            stats["unrecovered_targets_reconciled"] += 1

    def _sessions_by_name(self, session_names: list[str]) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        seen: set[str] = set()
        for name in session_names:
            session_name = str(name).strip()
            if not session_name or session_name in seen:
                continue
            seen.add(session_name)
            session = self.reader.get_session_by_name(session_name)
            if session is None:
                self.state.log_event(
                    event_type="targeted_session_not_found",
                    target_session=session_name,
                    status="skipped",
                    summary="targeted heartbeat patrol session not found",
                )
                continue
            if str(session.get("name") or "") == "heartbeat":
                self.state.log_event(
                    event_type="targeted_session_heartbeat_self_skipped",
                    target_session=session_name,
                    status="skipped",
                    summary="targeted heartbeat patrol skipped heartbeat session itself",
                )
                continue
            if session.get("heartbeat_enabled") != 1:
                self.state.log_event(
                    event_type="targeted_session_heartbeat_disabled",
                    target_session=session_name,
                    status="skipped",
                    summary="targeted heartbeat patrol skipped because heartbeat is disabled",
                )
                continue
            sessions.append(session)
        return sessions

    def _process_sessions(
        self, sessions: list[dict[str, Any]], *, patrol_id: str, targeted: bool = False
    ) -> list[dict[str, Any]]:
        if not sessions:
            return []
        worker_count = self._worker_count(len(sessions))
        if worker_count == 1:
            return [
                self._process_session(session, patrol_id=patrol_id, targeted=targeted)
                for session in sessions
            ]

        results: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = {
                executor.submit(
                    self._process_session, session, patrol_id=patrol_id, targeted=targeted
                ): str(session.get("name", ""))
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

    def _process_session(
        self, session: dict[str, Any], *, patrol_id: str, targeted: bool = False
    ) -> dict[str, Any]:
        stats = self._empty_stats(sessions_scanned=1)
        errors: list[str] = []
        session_name = str(session.get("name", ""))
        try:
            provider_scope_key = _provider_limit_scope_key(session)
            provider_pause = None
            packet: dict[str, Any] | None = None
            if provider_scope_key:
                self.state.expire_provider_limit_pause(provider_scope_key)
                provider_pause = self.state.active_provider_limit_pause(provider_scope_key)
                if provider_pause is not None:
                    packet = self.reader.build_packet(session, max_recent_runs=self.max_recent_runs)
                    recovery = provider_limit_recovery(
                        packet,
                        pause_updated_at=str(provider_pause.get("updated_at") or ""),
                    )
                    if recovery is not None:
                        self.state.recover_provider_limit_pause(
                            scope_key=provider_scope_key,
                            evidence_run_id=recovery.run_id,
                            evidence_at=recovery.observed_at,
                        )
                        provider_pause = None

            expired_pause = self.state.expire_pause_if_needed(session_name)
            pause = self.state.active_pause_for_session(session_name)
            if pause is not None:
                pending_todos = self.state.pending_todos_for_session(session_name, limit=1)
                if pending_todos:
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="todo_deferred_heartbeat_paused",
                        target_session=session_name,
                        logical_key=str(pending_todos[0].get("logical_key") or ""),
                        status=str(pause.get("status") or "paused"),
                        summary=_heartbeat_pause_summary(pause, pending_todos[0]),
                        trigger_source="todo_pool",
                        trigger_cause="heartbeat_paused",
                        trigger_location=session_name,
                    )
                return {"stats": stats, "errors": errors}
            pending_todos_after_expired_provider_pause = self.state.pending_todos_for_session(
                session_name, limit=1
            )
            if (
                expired_pause is not None
                and str(expired_pause.get("source") or "") == "provider_limit_auto_pause"
                and pending_todos_after_expired_provider_pause
            ):
                now_ms = int(time.time() * 1000)
                packet = self.reader.build_packet(session, max_recent_runs=self.max_recent_runs)
                packet["pending_todos"] = self.state.pending_todos_for_session(session_name)
                packet["heartbeat_policy"] = {
                    "now_ms": now_ms,
                    "stale_running_minutes": self.stale_running_minutes,
                    "child_sla_minutes": self.child_sla_minutes,
                    "candidate_max_age_hours": self.candidate_max_age_hours,
                }
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="todo_retry_after_provider_limit_pause_expired",
                    target_session=session_name,
                    logical_key=str(pending_todos_after_expired_provider_pause[0].get("logical_key") or ""),
                    status="retrying",
                    summary=(
                        f"expired_at={expired_pause.get('expires_at')}; "
                        f"pending_todo={pending_todos_after_expired_provider_pause[0].get('logical_key')}"
                    ),
                    trigger_source="todo_pool",
                    trigger_cause="provider_limit_pause_expired",
                    trigger_location=session_name,
                )
                try:
                    self._drain_todo_if_idle(packet, session=session, stats=stats, patrol_id=patrol_id)
                except Exception as exc:
                    errors.append(f"{session_name}: todo drain after provider limit pause failed: {exc}")
                return {"stats": stats, "errors": errors}
            if provider_pause is not None and provider_scope_key:
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="provider_limit_pause_active",
                    target_session=session_name,
                    status=str(provider_pause.get("status") or "paused"),
                    summary=(
                        f"scope_key={provider_scope_key}; "
                        f"expires_at={provider_pause.get('expires_at')}; "
                        f"reason={provider_pause.get('reason') or ''}"
                    ),
                    trigger_source="provider_limit",
                    trigger_cause="provider_limit_paused",
                    trigger_location=provider_scope_key,
                )
                pending_todos = self.state.pending_todos_for_session(session_name, limit=1)
                if pending_todos:
                    materialized_pause = self.state.pause_session_for_active_provider_limit(
                        scope_key=provider_scope_key,
                        session_name=session_name,
                    )
                    if materialized_pause is not None:
                        self.state.log_event(
                            patrol_id=patrol_id,
                            event_type="todo_deferred_provider_limit_paused",
                            target_session=session_name,
                            logical_key=str(pending_todos[0].get("logical_key") or ""),
                            status="paused",
                            summary=(
                                f"scope_key={provider_scope_key}; "
                                f"expires_at={provider_pause.get('expires_at')}; "
                                f"pending_todo={pending_todos[0].get('logical_key')}"
                            ),
                            trigger_source="todo_pool",
                            trigger_cause="provider_limit_paused",
                            trigger_location=provider_scope_key,
                        )
                        return {"stats": stats, "errors": errors}
                    provider_pause = None
                else:
                    return {"stats": stats, "errors": errors}
            now_ms = int(time.time() * 1000)
            candidate_max_age_minutes = max(0, self.candidate_max_age_hours) * 60
            if packet is None:
                packet = self.reader.build_packet(session, max_recent_runs=self.max_recent_runs)
            packet = trim_packet_to_candidate_window(
                packet,
                now_ms=now_ms,
                candidate_max_age_minutes=candidate_max_age_minutes,
            )
            packet["pending_todos"] = self.state.pending_todos_for_session(session_name)
            packet["heartbeat_policy"] = {
                "now_ms": now_ms,
                "stale_running_minutes": self.stale_running_minutes,
                "child_sla_minutes": self.child_sla_minutes,
                "candidate_max_age_hours": self.candidate_max_age_hours,
            }
            limit_pause = provider_limit_pause(
                packet,
                now_ms=packet["heartbeat_policy"]["now_ms"],
                candidate_max_age_minutes=candidate_max_age_minutes,
            )
            if limit_pause:
                expires_at = limit_pause.expires_at()
                if expires_at is not None:
                    if limit_pause.scope == "backend_model" and provider_scope_key:
                        self.state.pause_provider_limit(
                            scope_key=provider_scope_key,
                            expires_at=expires_at,
                            reason=f"{limit_pause.reason}; scope={limit_pause.scope}",
                            source="provider_limit_auto_pause",
                        )
                        self.state.pause_session_for_active_provider_limit(
                            scope_key=provider_scope_key,
                            session_name=session_name,
                            reason=(
                                f"auto stop until reset after {limit_pause.reason}; "
                                f"scope={limit_pause.scope}; scope_key={provider_scope_key}"
                            ),
                        )
                    else:
                        self.state.pause_session_until(
                            session_name=session_name,
                            expires_at=expires_at,
                            reason=f"auto stop until reset after {limit_pause.reason}; scope={limit_pause.scope}",
                            source="provider_limit_auto_pause",
                        )
                else:
                    fallback_expires_at = datetime.now(timezone.utc) + timedelta(
                        minutes=DEFAULT_PROVIDER_LIMIT_PAUSE_MINUTES
                    )
                    if limit_pause.scope == "backend_model" and provider_scope_key:
                        self.state.pause_provider_limit(
                            scope_key=provider_scope_key,
                            expires_at=fallback_expires_at,
                            reason=f"{limit_pause.reason}; scope={limit_pause.scope}; reset unknown",
                            source="provider_limit_auto_pause",
                        )
                        self.state.pause_session_for_active_provider_limit(
                            scope_key=provider_scope_key,
                            session_name=session_name,
                        )
                    else:
                        self.state.pause_session(
                            session_name=session_name,
                            minutes=DEFAULT_PROVIDER_LIMIT_PAUSE_MINUTES,
                            reason=(
                                f"auto stop {DEFAULT_PROVIDER_LIMIT_PAUSE_MINUTES} after "
                                f"{limit_pause.reason}; scope={limit_pause.scope}"
                            ),
                            source="provider_limit_auto_pause",
                        )
                return {"stats": stats, "errors": errors}
            should_check, prefilter_reasons = should_check_with_model(
                packet,
                now_ms=packet["heartbeat_policy"]["now_ms"],
                stale_running_minutes=self.stale_running_minutes,
                child_sla_minutes=self.child_sla_minutes,
                candidate_max_age_minutes=candidate_max_age_minutes,
            )
            if self.model_prefilter_enabled and not should_check:
                stats["sessions_prefilter_skipped"] += 1
                # 全量巡检里"无信号"的 skip 不再逐条落事件（每天上万条纯噪音，聚合数在
                # patrol stats 里）；定向巡检或有真实预筛原因（如用户取消）时保留，便于排查。
                if targeted or prefilter_reasons != [NO_LOCAL_CANDIDATE_SIGNAL]:
                    self.state.log_event(
                        patrol_id=patrol_id,
                        event_type="session_prefilter_skip",
                        target_session=session_name,
                        decision="skip",
                        status="skipped",
                        summary="; ".join(prefilter_reasons),
                    )
                # prefilter skip 与 todo drain 是两件事：prefilter 决定"controller 要不要看"，
                # drain 决定"现成的明确待办要不要送回去"。早期 cancelled-by-user 的 early
                # return 会顺带把后者也吞掉（2026-06-17 after-sales 实测 4 条 spawn_closure
                # 待办挂数小时），这里在 skip 路径上独立做一次 drain。
                try:
                    self._drain_todo_if_idle(packet, session=session, stats=stats, patrol_id=patrol_id)
                except Exception as exc:
                    errors.append(f"{session_name}: todo drain failed: {exc}")
                return {"stats": stats, "errors": errors}
            prompt = build_controller_prompt(
                packet,
                controller_model=self.controller_model,
                escalation_model=self.escalation_model,
            )
            decision = self._controller_decision(prompt, session_name, patrol_id=patrol_id)
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
                self._handle_item(
                    item,
                    packet=packet,
                    session=session,
                    stats=stats,
                    errors=errors,
                    patrol_id=patrol_id,
                )
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
            "user_resume_composer_fallbacks": 0,
            "user_resumes_blocked_confirmation_gate": 0,
            "user_resumes_skipped_duplicate": 0,
            "user_resumes_skipped_session_cap": 0,
            "user_resumes_skipped_session_busy": 0,
            "user_resumes_skipped_backoff": 0,
            "spawns_skipped_backoff": 0,
            "todos_injected": 0,
            "todos_cleared": 0,
            "spawns_reconciled_timeout": 0,
            "todos_landing_verified": 0,
            "todos_landing_unconfirmed": 0,
            "unrecovered_targets_escalated": 0,
            "action_claims_reconciled_completed": 0,
            "action_claims_reconciled_failed": 0,
            "legacy_injected_todos_archived": 0,
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

    def _controller_decision(self, prompt: str, session_name: str, *, patrol_id: str):
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
            decision = parse_decision(raw, expected_session=session_name)
            self._log_internal_child_completed(
                patrol_id=patrol_id,
                purpose="controller_json_repair",
                target_session=session_name,
                logical_key=f"{session_name}:controller-json-repair",
                decision="controller_repair",
                child_model=self.escalation_model,
                response=getattr(self.api, "last_controller_response", None),
                summary_extra="controller JSON repair returned a parseable decision",
            )
            return decision
        except DecisionError as exc:
            second_error_text = str(exc)
            escalation_prompt = (
                "The previous response was invalid for heartbeat's JSON contract. "
                "Return corrected JSON only for the same packet and do not add markdown.\n\n"
                f"Previous response:\n{raw}\n\nOriginal prompt:\n{prompt}"
            )

        raw = self.api.run_controller_decision(escalation_prompt, self.escalation_model)
        try:
            decision = parse_decision(raw, expected_session=session_name)
            self._log_internal_child_completed(
                patrol_id=patrol_id,
                purpose="controller_json_escalation",
                target_session=session_name,
                logical_key=f"{session_name}:controller-json-escalation",
                decision="controller_repair",
                child_model=self.escalation_model,
                response=getattr(self.api, "last_controller_response", None),
                summary_extra="controller JSON escalation returned a parseable decision",
            )
            return decision
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
        packet: dict[str, Any],
        session: dict[str, Any],
        stats: dict[str, int],
        errors: list[str],
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
            send_user_message = self._session_accepts_user_message(packet, session)
            try:
                self.api.send_alert(chat_id, item.prompt)
                if send_user_message:
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
                detail=_alert_action_detail(item.prompt, user_message if send_user_message else ""),
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="alert_sent",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="sent",
                summary=_alert_event_summary(item.reason, item.prompt, user_message if send_user_message else ""),
                trigger_source="historical_stall",
                trigger_cause=_trigger_cause_from_item(item),
                trigger_location=item.target_session,
                injected_message=user_message if send_user_message else "",
            )
            stats["alerts_sent"] += 1
            return
        if item.decision in {"spawn_collect", "spawn_execute", "escalate"}:
            self._spawn_for_item(item, stats=stats, errors=errors, patrol_id=patrol_id)
            return
        if item.decision == "user_resume":
            if not self._session_accepts_user_message(packet, session):
                stats["user_resumes_skipped_session_busy"] += 1
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="user_resume_skipped_session_busy",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                    decision=item.decision,
                    child_model=item.child_model,
                    status="skipped",
                    summary=item.reason,
                    trigger_source="historical_stall",
                    trigger_cause=_trigger_cause_from_item(item),
                    trigger_location=item.target_session,
                )
                return
            self._send_user_resume_for_item(
                item,
                session=session,
                stats=stats,
                errors=errors,
                patrol_id=patrol_id,
            )
            return
        raise RuntimeError(f"unsupported decision: {item.decision}")

    def _escalate_unrecovered_target(
        self,
        *,
        action_type: str,
        item: DecisionItem,
        error: str,
        stats: dict[str, int],
        patrol_id: str,
    ) -> str | None:
        """Aggregate this failure at the (action_type, target_session) level and, when a target has
        stayed un-advanced past the escalation threshold within the rolling window, land a durable,
        human-visible ``unrecovered_item_escalated`` event so a ``completed`` patrol can no longer
        mask it. Per-key cooldown misses this because the controller mints a fresh logical_key each
        patrol for the same stuck target."""
        outcome = self.state.record_unrecovered_target(
            action_type=action_type,
            target_session=item.target_session,
            logical_key=item.logical_key,
            error=error,
            threshold=self.unrecovered_escalation_threshold,
            window_minutes=self.unrecovered_window_minutes,
            reescalate_minutes=self.unrecovered_reescalate_minutes,
        )
        if not outcome["escalate"]:
            return None
        return self._emit_unrecovered_escalation(
            action_type=action_type,
            item=item,
            outcome=outcome,
            error=error,
            stats=stats,
            patrol_id=patrol_id,
            trigger_cause=_trigger_cause_from_item(item),
        )

    def _emit_unrecovered_escalation(
        self,
        *,
        action_type: str,
        item: DecisionItem,
        outcome: dict[str, Any],
        error: str,
        stats: dict[str, int],
        patrol_id: str,
        trigger_cause: str,
    ) -> str | None:
        stats["unrecovered_targets_escalated"] = stats.get("unrecovered_targets_escalated", 0) + 1
        child_model = self._effective_child_model(item.child_model)
        if outcome.get("escalation_reason") == "max_age":
            summary = (
                f"{item.target_session} {action_type} unrecovered for at least "
                f"{outcome['max_unreconciled_hours']}h since {outcome['window_started_at']}; "
                f"recorded failed attempts={outcome['failure_count']}; "
                f"last_failed_at={outcome['last_failed_at']}; needs human attention. {item.reason}"
            )
        else:
            summary = (
                f"{item.target_session} {action_type} unrecovered: "
                f"{outcome['failure_count']} failed attempts since {outcome['window_started_at']} "
                f"across changing logical_keys; needs human attention. {item.reason}"
            )
        escalation_event_id = self.state.log_event(
            patrol_id=patrol_id,
            event_type="unrecovered_item_escalated",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_model=child_model,
            status="escalated",
            summary=summary,
            error=error,
            trigger_source="unrecovered_target",
            trigger_cause=trigger_cause,
            trigger_location=item.target_session,
        )
        handoff_id = self.state.record_unrecovered_escalation_handoff(
            escalation_event_id=escalation_event_id,
            patrol_id=patrol_id,
            action_type=action_type,
            target_session=item.target_session,
            logical_key=item.logical_key,
            failure_count=int(outcome["failure_count"]),
            window_started_at=str(outcome["window_started_at"]),
            error=error,
        )
        return self._notify_unrecovered_escalation(
            action_type=action_type,
            item=item,
            outcome=outcome,
            error=error,
            patrol_id=patrol_id,
            handoff_id=handoff_id,
        )

    def _notify_unrecovered_escalation(
        self,
        *,
        action_type: str,
        item: DecisionItem,
        outcome: dict[str, Any],
        error: str,
        patrol_id: str,
        handoff_id: str,
    ) -> str | None:
        """Persist the Console transport result so escalation never self-certifies delivery."""
        notify = getattr(self.api, "notify_console", None)
        if not callable(notify):
            detail = "api.notify_console is unavailable"
            self.state.record_unrecovered_handoff_transport(
                handoff_id=handoff_id, status="failed", message_id="", detail=detail
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="unrecovered_handoff_notify_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=self._effective_child_model(item.child_model),
                status="failed",
                summary=f"handoff_id={handoff_id}; transport=failed",
                error=detail,
                trigger_source="unrecovered_target",
                trigger_cause="notify_transport_failed",
                trigger_location=item.target_session,
            )
            return f"unrecovered escalation notify failed: {detail}"
        try:
            if outcome.get("escalation_reason") == "max_age":
                escalation_detail = (
                    f"自 {outcome['window_started_at']} 起已超过 "
                    f"{outcome['max_unreconciled_hours']}h 未取得同一 logical_key 的恢复证据；"
                    f"当前记录失败 {outcome['failure_count']} 次，last_failed_at={outcome['last_failed_at']}。"
                )
            else:
                escalation_detail = (
                    f"在滚动窗口内已失败 {outcome['failure_count']} 次"
                    "（logical_key 每轮在变，per-key 冷却测不到）。"
                )
            transport = _normalize_notify_transport_receipt(
                notify(
                    title=f"heartbeat 推不动: {item.target_session}",
                    body=(
                        f"{item.target_session} 的 {action_type}{escalation_detail}"
                        "heartbeat 无法自动恢复，需要人工介入。"
                        f"台账=unrecovered_escalation_handoffs/{handoff_id}；"
                        f"账本 owner=heartbeat，承接状态=awaiting_acceptance。最近错误: {error[:200]}"
                    ),
                    level="error",
                )
            )
        except Exception as exc:
            detail = str(exc)
            self.state.record_unrecovered_handoff_transport(
                handoff_id=handoff_id, status="failed", message_id="", detail=detail
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="unrecovered_handoff_notify_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=self._effective_child_model(item.child_model),
                status="failed",
                summary=f"handoff_id={handoff_id}; transport=failed",
                error=detail,
                trigger_source="unrecovered_target",
                trigger_cause="notify_transport_failed",
                trigger_location=item.target_session,
            )
            return f"unrecovered escalation notify failed: {detail}"
        self.state.record_unrecovered_handoff_transport(
            handoff_id=handoff_id,
            status=transport["status"],
            message_id=transport["message_id"],
            detail=transport["detail"],
        )
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="unrecovered_handoff_delivered",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_model=self._effective_child_model(item.child_model),
            status=transport["status"],
            summary=(
                f"handoff_id={handoff_id}; transport={transport['status']}; "
                f"message_id={transport['message_id']}"
            ),
            error=transport["detail"] if transport["status"] == "degraded" else "",
            trigger_source="unrecovered_target",
            trigger_cause="notify_transport_delivered",
            trigger_location=item.target_session,
        )
        return None

    def _send_user_resume_for_item(
        self,
        item: DecisionItem,
        *,
        session: dict[str, Any],
        stats: dict[str, int],
        errors: list[str],
        patrol_id: str,
    ) -> None:
        chat_id = session.get("group_id")
        if not isinstance(chat_id, str) or not chat_id:
            raise RuntimeError("user_resume requested but target session has no group_id")
        child_model = self._effective_child_model(item.child_model)
        cooldown_until = self.state.action_in_cooldown(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
        )
        if cooldown_until:
            stats["user_resumes_skipped_backoff"] += 1
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="user_resume_skipped_backoff",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="skipped",
                summary=f"{item.reason}; cooldown_until={cooldown_until}",
            )
            return
        if _is_user_resume_confirmation_gate(item):
            _log_user_resume_blocked_confirmation_gate(self.state, item, patrol_id=patrol_id)
            stats["user_resumes_blocked_confirmation_gate"] += 1
            return
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

        composer_fallback_error = ""
        try:
            try:
                raw_message = self.api.compose_user_resume_message(
                    item=item,
                    target_session=session,
                    model=child_model,
                )
            except ApiError as exc:
                if not PROVIDER_LIMIT_RE.search(str(exc)):
                    raise
                composer_fallback_error = str(exc)
                self._log_internal_child_completed(
                    patrol_id=patrol_id,
                    purpose="resume_composer",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                    decision=item.decision,
                    child_model=child_model,
                    response=getattr(self.api, "last_resume_response", None),
                    status="failed",
                    event_type="internal_child_failed",
                    error=composer_fallback_error,
                    summary_extra="provider-limited; using deterministic user_resume fallback",
                )
                raw_message = _provider_limit_resume_fallback_message(item)
            else:
                self._log_internal_child_completed(
                    patrol_id=patrol_id,
                    purpose="resume_composer",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                    decision=item.decision,
                    child_model=child_model,
                    response=getattr(self.api, "last_resume_response", None),
                    injected_message=raw_message.strip() if isinstance(raw_message, str) else "",
                    summary_extra="generated user_resume message",
                )
            message = _normalize_user_resume_message(raw_message)
            if has_user_confirmation_gate(message):
                self.state.release_action_claim(
                    action_type="user_resume",
                    target_session=item.target_session,
                    logical_key=item.logical_key,
                )
                _log_user_resume_blocked_confirmation_gate(
                    self.state,
                    item,
                    patrol_id=patrol_id,
                    injected_message=message,
                )
                stats["user_resumes_blocked_confirmation_gate"] += 1
                return
            self.api.send_user_message(chat_id, message)
        except Exception as exc:
            self.state.release_action_claim(
                action_type="user_resume",
                target_session=item.target_session,
                logical_key=item.logical_key,
            )
            backoff = self.state.record_action_failure(
                action_type="user_resume",
                target_session=item.target_session,
                logical_key=item.logical_key,
                error=str(exc),
                threshold=self.action_failure_threshold,
                cooldown_minutes=self.action_cooldown_minutes,
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="user_resume_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=child_model,
                status="failed",
                summary=(
                    f"{item.reason}; failure_count={backoff['failure_count']}; "
                    f"cooldown_until={backoff['cooldown_until'] or 'none'}"
                ),
                error=f"user resume failed: {exc}",
                trigger_source="historical_stall",
                trigger_cause=_trigger_cause_from_item(item),
                trigger_location=item.target_session,
            )
            notify_error = self._escalate_unrecovered_target(
                action_type="user_resume",
                item=item,
                error=f"user resume failed: {exc}",
                stats=stats,
                patrol_id=patrol_id,
            )
            if notify_error:
                errors.append(f"{item.target_session}:{item.logical_key}: {notify_error}")
            raise

        self.state.finish_action(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
            status="sent",
            detail=message,
        )
        self.state.clear_action_failures(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
        )
        if composer_fallback_error:
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="user_resume_composer_fallback",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=child_model,
                status="sent",
                summary="provider-limited composer; deterministic fallback sent",
                error=composer_fallback_error,
                trigger_source="internal_helper",
                trigger_cause="resume_composer_provider_limit",
                trigger_location=item.target_session,
                injected_message=message,
            )
            stats["user_resume_composer_fallbacks"] += 1
        recovery_event_id = self.state.log_event(
            patrol_id=patrol_id,
            event_type="user_resume_sent",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_model=child_model,
            status="sent",
            summary=f"{item.reason}; user_message={message}",
            trigger_source="historical_stall",
            trigger_cause=_trigger_cause_from_item(item),
            trigger_location=item.target_session,
            injected_message=message,
        )
        self.state.resolve_unrecovered_target(
            action_type="user_resume",
            target_session=item.target_session,
            logical_key=item.logical_key,
            recovery_status="accepted",
            recovery_event_id=recovery_event_id,
            recovery_event_type="user_resume_sent",
            recovery_summary=f"user resume transport accepted; logical_key={item.logical_key}",
        )
        stats["user_resumes_sent"] += 1

    def _resolve_spawn_endpoints(self, source_ref: str) -> dict[str, Any] | None:
        resolver = getattr(self.reader, "resolve_spawn_endpoints", None)
        if not callable(resolver):
            return None
        try:
            return resolver(source_ref)
        except Exception:
            return None

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
            self._request_todo_watch(session_name)
            return False
        # 已经验过 idle，告诉 claim 跳过 settle/max_wait 时间窗 gate；expected_count 仍兜底。
        claim = self.state.claim_next_todo_batch(
            target_session=session_name, todo_types=todo_types, target_idle=True
        )
        if claim is None:
            waits = self.state.pending_batch_waits_for_session(
                session_name,
                todo_types=todo_types,
                limit=3,
            )
            if waits:
                self.state.log_event(
                    patrol_id=patrol_id,
                    event_type="todo_deferred_batch_not_ready",
                    target_session=session_name,
                    status="pending",
                    summary=_todo_batch_wait_summary(waits),
                    trigger_source="todo_pool",
                    trigger_cause="batch_waiting",
                    trigger_location=session_name,
                )
                self._request_todo_watch(session_name)
            return False
        claim = self._clear_caller_consumed_spawn_closure_todos(
            claim,
            patrol_id=patrol_id,
            stats=stats,
        )
        if not claim.todos:
            # Duplicate suppression did not deliver a todo. Let unrelated
            # controller recovery actions continue in this patrol; refresh
            # the packet snapshot so their pending-todo gate sees the clear.
            packet["pending_todos"] = self.state.pending_todos_for_session(session_name)
            return False
        todo_ids = [todo.todo_id for todo in claim.todos]
        if _todo_claim_declares_no_action(claim):
            detail = "auto-cleared: child declared SM_CLOSURE_ACTION: no_action"
            self.state.mark_todos_cleared(todo_ids=todo_ids, detail=detail)
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="todo_auto_cleared_no_action",
                target_session=session_name,
                logical_key=",".join(todo.logical_key for todo in claim.todos),
                status="cleared",
                summary=_todo_summary(claim, detail),
                trigger_source="todo_pool",
                trigger_cause="spawn_closure_no_action",
                trigger_location=session_name,
            )
            stats["todos_cleared"] += len(todo_ids)
            return True
        chat_id = session.get("group_id")
        if not isinstance(chat_id, str) or not chat_id:
            self.state.mark_todos_failed(todo_ids=todo_ids, detail="target session has no group_id")
            raise RuntimeError("todo injection requested but target session has no group_id")
        try:
            message = _normalize_todo_injection_message(
                _todo_claim_message(claim, resolve_endpoints=self._resolve_spawn_endpoints)
            )
            self.api.send_user_message(chat_id, message)
        except Exception as exc:
            self.state.release_todo_claim(todo_ids=todo_ids, detail=f"send failed; will retry: {exc}")
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="todo_injection_send_failed_requeued",
                target_session=session_name,
                logical_key=",".join(todo.logical_key for todo in claim.todos),
                status="pending",
                summary=_todo_summary(claim, ""),
                error=str(exc),
                trigger_source="todo_pool",
                trigger_cause=_todo_trigger_cause(claim),
                trigger_location=session_name,
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
            trigger_source="todo_pool",
            trigger_cause=_todo_trigger_cause(claim),
            trigger_location=session_name,
            injected_message=message,
        )
        stats["todos_injected"] += 1
        return True

    def _clear_caller_consumed_spawn_closure_todos(
        self,
        claim: Any,
        *,
        patrol_id: str,
        stats: dict[str, int],
    ) -> Any:
        remaining_todos = []
        cleared_todos = []
        for todo in claim.todos:
            comm_id = _spawn_closure_comm_id(todo)
            if comm_id is None:
                remaining_todos.append(todo)
                continue
            try:
                async_item = self.api.get_spawn_async_item_by_comm(comm_id)
            except Exception:
                # The ledger is an optional duplicate-suppression check. An
                # unavailable or old platform API must never block delivery.
                remaining_todos.append(todo)
                continue
            if not isinstance(async_item, dict) or async_item.get("verdict") != "caller_consumed":
                remaining_todos.append(todo)
                continue
            detail = f"auto-cleared: platform verdict=caller_consumed for comm_id={comm_id}"
            self.state.mark_todos_cleared(todo_ids=[todo.todo_id], detail=detail)
            cleared_todos.append(todo)

        if not cleared_todos:
            return claim
        cleared_claim = replace(claim, todos=cleared_todos)
        detail = "auto-cleared: platform verdict=caller_consumed"
        self.state.log_event(
            patrol_id=patrol_id,
            event_type="todo_auto_cleared_caller_consumed",
            target_session=claim.target_session,
            logical_key=",".join(todo.logical_key for todo in cleared_todos),
            status="cleared",
            summary=_todo_summary(cleared_claim, detail),
            trigger_source="todo_pool",
            trigger_cause="spawn_closure_caller_consumed",
            trigger_location=claim.target_session,
        )
        stats["todos_cleared"] += len(cleared_todos)
        return replace(claim, todos=remaining_todos)

    def _request_todo_watch(self, session_name: str) -> None:
        if self.todo_watch_launcher is None:
            return
        try:
            if not self.state.pending_todos_for_session(session_name, limit=1):
                return
            self.todo_watch_launcher(session_name)
        except Exception:
            # re-arm 失败不阻断巡检；watcher 启动失败自身会落 todo_watch_launch_failed 事件
            return

    def _session_idle_for_todo(self, packet: dict[str, Any], session: dict[str, Any]) -> bool:
        if str(session.get("status", "")).lower() != "idle":
            return False
        latest_run = (packet.get("recent_runs") or [None])[0]
        if isinstance(latest_run, dict) and str(latest_run.get("status", "")).lower() == "running":
            return False
        return True

    def _session_accepts_user_message(self, packet: dict[str, Any], session: dict[str, Any]) -> bool:
        session_status = str(session.get("status", "")).lower()
        if session_status and session_status != "idle":
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

    def _spawn_for_item(
        self, item: DecisionItem, *, stats: dict[str, int], errors: list[str], patrol_id: str
    ) -> None:
        child_model = self._effective_child_model(item.child_model)
        cooldown_until = self.state.action_in_cooldown(
            action_type="spawn",
            target_session=item.target_session,
            logical_key=item.logical_key,
        )
        if cooldown_until:
            stats["spawns_skipped_backoff"] += 1
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="spawn_skipped_backoff",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=item.child_model,
                status="skipped",
                summary=f"{item.reason}; cooldown_until={cooldown_until}",
            )
            return
        claimed = self.state.try_claim_spawn(
            target_session=item.target_session,
            logical_key=item.logical_key,
            child_model=child_model,
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
            response = self.api.spawn_child(item.target_session, child_prompt(item), child_model)
        except Exception as exc:
            self.state.release_spawn_claim(target_session=item.target_session, logical_key=item.logical_key)
            backoff = self.state.record_action_failure(
                action_type="spawn",
                target_session=item.target_session,
                logical_key=item.logical_key,
                error=str(exc),
                threshold=self.action_failure_threshold,
                cooldown_minutes=self.action_cooldown_minutes,
            )
            self.state.log_event(
                patrol_id=patrol_id,
                event_type="spawn_failed",
                target_session=item.target_session,
                logical_key=item.logical_key,
                decision=item.decision,
                child_model=child_model,
                status="failed",
                summary=(
                    f"{item.reason}; failure_count={backoff['failure_count']}; "
                    f"cooldown_until={backoff['cooldown_until'] or 'none'}"
                ),
                error=f"spawn_child failed: {exc}",
            )
            notify_error = self._escalate_unrecovered_target(
                action_type="spawn",
                item=item,
                error=f"spawn_child failed: {exc}",
                stats=stats,
                patrol_id=patrol_id,
            )
            if notify_error:
                errors.append(f"{item.target_session}:{item.logical_key}: {notify_error}")
            raise

        child_session_id = _optional_response_string(response, "childSessionId")
        async_ref = _first_response_string(response, ("ref", "async_ref"))
        spawn_comm_id = _first_response_string(response, ("comm_id", "spawnCommId"))
        final_message = _optional_response_string(response, "finalMessage")
        if not child_session_id and not async_ref:
            self.state.release_spawn_claim(target_session=item.target_session, logical_key=item.logical_key)
            raise RuntimeError("spawn response missing childSessionId or async ref")
        self.state.mark_spawn_started(
            target_session=item.target_session,
            logical_key=item.logical_key,
            child_session_id=child_session_id,
            async_ref=async_ref,
            spawn_comm_id=spawn_comm_id,
        )
        terminal_blocker = bool(final_message and _spawn_final_message_has_terminal_blocker(final_message))
        if final_message:
            self.state.mark_spawn_finished(
                target_session=item.target_session,
                logical_key=item.logical_key,
                status="failed" if terminal_blocker else "completed",
                final_summary=final_message,
            )
        if terminal_blocker:
            backoff = self.state.record_action_failure(
                action_type="spawn",
                target_session=item.target_session,
                logical_key=item.logical_key,
                error=f"spawn completed but blocker remained terminal: {final_message}",
                threshold=self.action_failure_threshold,
                cooldown_minutes=self.action_cooldown_minutes,
            )
            notify_error = self._escalate_unrecovered_target(
                action_type="spawn",
                item=item,
                error=(
                    "spawn completed but child reported a terminal unrecovered blocker; "
                    f"failure_count={backoff['failure_count']}; "
                    f"cooldown_until={backoff['cooldown_until'] or 'none'}; "
                    f"final_message={final_message}"
                ),
                stats=stats,
                patrol_id=patrol_id,
            )
            if notify_error:
                errors.append(f"{item.target_session}:{item.logical_key}: {notify_error}")
        else:
            self.state.clear_action_failures(
                action_type="spawn",
                target_session=item.target_session,
                logical_key=item.logical_key,
            )
        recovery_event_id = self.state.log_event(
            patrol_id=patrol_id,
            event_type="spawn_started",
            target_session=item.target_session,
            logical_key=item.logical_key,
            decision=item.decision,
            child_session_id=child_session_id,
            child_model=child_model,
            status="failed" if terminal_blocker else "running",
            summary=item.reason,
            trigger_source="historical_stall",
            trigger_cause=_trigger_cause_from_item(item),
            trigger_location=item.target_session,
        )
        if not terminal_blocker:
            self.state.resolve_unrecovered_target(
                action_type="spawn",
                target_session=item.target_session,
                logical_key=item.logical_key,
                recovery_status="accepted",
                recovery_event_id=recovery_event_id,
                recovery_event_type="spawn_started",
                recovery_summary=(
                    f"spawn transport accepted; child_session_id={child_session_id or ''}; "
                    f"async_ref={async_ref or ''}; logical_key={item.logical_key}"
                ),
            )
        stats["spawns_started"] += 1

    def _log_internal_child_completed(
        self,
        *,
        patrol_id: str,
        purpose: str,
        target_session: str,
        logical_key: str,
        decision: str,
        child_model: str,
        response: Any,
        injected_message: str = "",
        summary_extra: str = "",
        event_type: str = "internal_child_completed",
        status: str = "completed",
        error: str = "",
    ) -> None:
        if not isinstance(response, dict):
            return
        child_session_id = _first_response_string(response, ("childSessionId", "child_session_id"))
        child_session_name = _first_response_string(response, ("childSessionName", "child_session_name", "childName"))
        comm_id = _first_response_string(response, ("comm_id", "spawnCommId", "commId"))
        message_run_id = _first_response_string(response, ("messageRunId", "message_run_id", "run_id"))
        if not any((child_session_id, child_session_name, comm_id, message_run_id)):
            return
        summary_parts = [
            f"purpose={purpose}",
            f"target_session={target_session}",
            f"logical_key={logical_key}",
        ]
        if comm_id:
            summary_parts.append(f"comm_id={comm_id}")
        if child_session_name:
            summary_parts.append(f"child_session={child_session_name}")
        if message_run_id:
            summary_parts.append(f"message_run_id={message_run_id}")
        if summary_extra:
            summary_parts.append(summary_extra)
        self.state.log_event(
            patrol_id=patrol_id,
            event_type=event_type,
            target_session=target_session,
            logical_key=logical_key,
            decision=decision,
            child_session_id=child_session_id or child_session_name,
            child_model=child_model,
            status=status,
            summary="; ".join(summary_parts),
            error=error,
            trigger_source="internal_helper",
            trigger_cause=purpose,
            trigger_location=target_session,
            injected_message=injected_message,
        )


def _optional_response_string(response: dict[str, Any], key: str) -> str | None:
    value = response.get(key)
    if isinstance(value, str) and value:
        return value
    return None


def _provider_limit_resume_fallback_message(item: DecisionItem) -> str:
    context = "\n".join((item.reason, item.prompt))
    return (
        USER_RESUME_PROVIDER_LIMIT_FALLBACK_MESSAGE
        if re.search(r"[\u4e00-\u9fff]", context)
        else USER_RESUME_PROVIDER_LIMIT_FALLBACK_MESSAGE_EN
    )


def _normalize_notify_transport_receipt(value: Any) -> dict[str, str]:
    """Require a durable Console receipt instead of treating a 2xx as delivery proof."""
    if not isinstance(value, dict):
        raise RuntimeError("notify_console returned no transport receipt")
    raw_status = value.get("status")
    if raw_status is None:
        raw_status = "degraded" if value.get("degraded") is True else "delivered"
    status = str(raw_status).strip().lower()
    if status not in {"delivered", "degraded"}:
        raise RuntimeError(f"notify_console returned unsupported transport status: {raw_status!r}")
    raw_message_id = value.get("message_id") or value.get("messageId")
    if not isinstance(raw_message_id, str) or not raw_message_id.strip():
        raise RuntimeError("notify_console returned no message_id")
    raw_detail = value.get("detail") or value.get("code") or value.get("error") or ""
    return {
        "status": status,
        "message_id": raw_message_id.strip(),
        "detail": str(raw_detail).strip(),
    }


def _first_response_string(response: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = _optional_response_string(response, key)
        if value:
            return value
    return None


def _spawn_final_message_has_terminal_blocker(message: str) -> bool:
    normalized = message.lower()
    terminal_markers = (
        "unrecoverable",
        "not recoverable",
        "cannot be recovered",
        "can't be recovered",
        "permanently missing",
        "permanent missing",
        "terminal blocker",
        "终态不可修",
        "不可修",
        "不可恢复",
        "无法恢复",
        "永久缺失",
        "永久丢失",
    )
    blocker_markers = (
        "remaining blocker",
        "blocker",
        "human attention needed",
        "needs human attention",
        "needs human",
        "人工",
        "阻塞",
        "缺失",
        "丢失",
    )
    return any(marker in normalized for marker in terminal_markers) and any(
        marker in normalized for marker in blocker_markers
    )


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
    if reject_target_perspective and USER_RESUME_CAUSE_ATTRIBUTION_RE.search(text):
        raise RuntimeError("user resume message asserts failure cause attribution")
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


def _extract_comm_id(value: str) -> str | None:
    match = COMM_ID_RE.search(value)
    return match.group(0) if match else None


def _trigger_cause_from_item(item: DecisionItem) -> str:
    text = " ".join(
        str(value or "").lower()
        for value in (item.logical_key, item.reason, item.prompt, item.decision)
    )
    if has_user_confirmation_gate(text):
        return "user_confirmation_gate"
    if "rate limit" in text or "provider limit" in text or "hit limit" in text:
        return "provider_limit"
    if "timeout" in text:
        return "timeout"
    if "failed" in text or "error" in text:
        return "failed_run"
    if "running" in text or "stale" in text:
        return "stale_running"
    if "continuation" in text or "继续" in text:
        return "continuation_checkpoint"
    if "spawn_closure" in text or "child completed" in text or "子 session" in text:
        return "spawn_closure"
    if item.decision == "alert":
        return "requires_user_input"
    return item.decision


def _is_user_resume_confirmation_gate(item: DecisionItem) -> bool:
    text = "\n".join(str(value or "") for value in (item.logical_key, item.reason, item.prompt))
    return has_user_confirmation_gate(text)


def _log_user_resume_blocked_confirmation_gate(
    state: HeartbeatState,
    item: DecisionItem,
    *,
    patrol_id: str,
    injected_message: str = "",
) -> None:
    state.log_event(
        patrol_id=patrol_id,
        event_type="user_resume_blocked_confirmation_gate",
        target_session=item.target_session,
        logical_key=item.logical_key,
        decision=item.decision,
        child_model=item.child_model,
        status="skipped",
        summary=item.reason,
        trigger_source="historical_stall",
        trigger_cause="user_confirmation_gate",
        trigger_location=item.target_session,
        injected_message=injected_message,
    )


def _todo_trigger_cause(claim: Any) -> str:
    causes = sorted(
        {
            str(getattr(todo, "todo_type", "") or "general")
            for todo in getattr(claim, "todos", []) or []
        }
    )
    return ",".join(causes) if causes else "todo_pool"


def _todo_claim_declares_no_action(claim: Any) -> bool:
    todos = list(getattr(claim, "todos", []) or [])
    return bool(todos) and all(_todo_declares_no_action(todo) for todo in todos)


def _todo_declares_no_action(todo: Any) -> bool:
    if str(getattr(todo, "todo_type", "") or "") != "spawn_closure":
        return False
    message = _todo_message(todo)
    result_text = _spawn_closure_result_text(message)
    return bool(CLOSURE_NO_ACTION_RE.search(result_text))


def _spawn_closure_comm_id(todo: Any) -> str | None:
    if str(getattr(todo, "todo_type", "") or "") != "spawn_closure":
        return None
    source_ref = str(getattr(todo, "source_ref", "") or "").strip()
    if source_ref:
        return source_ref
    for value in (
        str(getattr(todo, "logical_key", "") or ""),
        str(getattr(todo, "message", "") or ""),
    ):
        match = COMM_ID_RE.search(value)
        if match:
            return match.group(0)
    return None


def _heartbeat_pause_summary(pause: dict[str, Any], todo: dict[str, Any]) -> str:
    expires_at = str(pause.get("expires_at") or "")
    expires_text = expires_at if expires_at else "never"
    reason = str(pause.get("reason") or "")
    source = str(pause.get("source") or "")
    return (
        f"heartbeat pause active; status={pause.get('status')}; expires_at={expires_text}; "
        f"reason={reason}; source={source}; pending_todo={todo.get('logical_key')}; "
        f"batch_key={todo.get('batch_key') or ''}; todo_type={todo.get('todo_type') or ''}"
    )


def _provider_limit_scope_key(session: dict[str, Any]) -> str | None:
    backend = str(session.get("backend") or "").strip()
    model = str(session.get("model") or "").strip()
    if backend and model:
        return f"backend_model:{backend}:{model}"
    if backend:
        return f"backend:{backend}"
    return None


def _todo_batch_wait_summary(waits: list[dict[str, Any]]) -> str:
    parts = []
    for wait in waits:
        expected = wait.get("expected_count")
        expected_text = "none" if expected is None else str(expected)
        remaining = wait.get("expected_remaining")
        remaining_text = "none" if remaining is None else str(remaining)
        parts.append(
            "batch={batch_key}; type={todo_type}; items={item_count}; expected={expected}; "
            "remaining={remaining}; settle_in={settle}s; max_wait_in={max_wait}s; last_item_at={last_item_at}".format(
                batch_key=wait.get("batch_key", ""),
                todo_type=wait.get("todo_type", ""),
                item_count=wait.get("item_count", 0),
                expected=expected_text,
                remaining=remaining_text,
                settle=wait.get("seconds_until_settle", 0),
                max_wait=wait.get("seconds_until_max_wait", 0),
                last_item_at=wait.get("last_item_at", ""),
            )
        )
    return "waiting for todo batch readiness: " + " | ".join(parts)


def _todo_claim_message(claim: Any, *, resolve_endpoints: Any = None) -> str:
    todos = list(getattr(claim, "todos", []) or [])
    if len(todos) == 1:
        message = _todo_message(todos[0], resolve_endpoints=resolve_endpoints)
        if len(message) <= TODO_BATCH_INLINE_MAX_CHARS:
            return message
        return _todo_single_summary_message(todos[0], message, resolve_endpoints=resolve_endpoints)
    lines = ["以下是同一批待办，请一次性处理并汇总：", ""]
    batch_key = getattr(claim, "batch_key", None)
    if batch_key:
        lines.append(f"批次：{batch_key}")
    for index, todo in enumerate(todos, start=1):
        lines.append(f"{index}. {_todo_message(todo, resolve_endpoints=resolve_endpoints)}")
    lines.extend(["", "请按这些输入统一处理，完成后给出汇总结论。"])
    full_message = "\n".join(lines)
    if len(full_message) <= TODO_BATCH_INLINE_MAX_CHARS:
        return full_message
    return _todo_claim_summary_message(claim, full_message, resolve_endpoints=resolve_endpoints)


def _todo_single_summary_message(todo: Any, full_message: str, *, resolve_endpoints: Any = None) -> str:
    source_ref = str(getattr(todo, "source_ref", "") or getattr(todo, "logical_key", "") or "todo")
    payload_path = _write_todo_batch_payload(batch_key=f"single:{source_ref}", full_message=full_message)
    return "\n".join(
        [
            "这条待办内容较长，完整内容已写入本机文件：",
            payload_path,
            "",
            "请先读取完整文件，再继续处理；下面只放预览。",
            "",
            _todo_preview(todo, resolve_endpoints=resolve_endpoints),
        ]
    )


def _todo_claim_summary_message(claim: Any, full_message: str, *, resolve_endpoints: Any = None) -> str:
    todos = list(getattr(claim, "todos", []) or [])
    batch_key = str(getattr(claim, "batch_key", "") or "todo-batch")
    payload_path = _write_todo_batch_payload(batch_key=batch_key, full_message=full_message)
    lines = [
        "以下是同一批待办，请一次性处理并汇总：",
        "",
        f"批次：{batch_key}",
        f"共 {len(todos)} 条；完整内容已写入本机文件：{payload_path}",
        "请先读取完整文件，再完成汇总结论；下面只放每条预览，避免飞书消息过长。",
        "",
    ]
    for index, todo in enumerate(todos, start=1):
        lines.append(f"{index}. {_todo_preview(todo, resolve_endpoints=resolve_endpoints)}")
    lines.extend(["", "请按完整文件里的输入统一处理，完成后给出汇总结论。"])
    return "\n".join(lines)


def _write_todo_batch_payload(*, batch_key: str, full_message: str) -> str:
    TODO_BATCH_PAYLOAD_DIR.mkdir(parents=True, exist_ok=True)
    path = TODO_BATCH_PAYLOAD_DIR / f"{_safe_payload_filename(batch_key)}.md"
    path.write_text(full_message, encoding="utf-8")
    return str(path)


def _safe_payload_filename(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-")
    return safe[:160] or "todo-batch"


def _todo_preview(todo: Any, *, resolve_endpoints: Any = None) -> str:
    created_at = _format_beijing_time(str(getattr(todo, "created_at", "") or "unknown"))
    source_ref = str(getattr(todo, "source_ref", "") or getattr(todo, "logical_key", "") or "unknown")
    message = str(getattr(todo, "message", "") or "")
    _, executor_display, child_label = _spawn_closure_endpoint_labels(todo, message, resolve_endpoints)
    result = _spawn_closure_result_text(message).replace("\n", " ").strip()
    if len(result) > TODO_BATCH_ITEM_PREVIEW_CHARS:
        result = result[:TODO_BATCH_ITEM_PREVIEW_CHARS].rstrip() + "..."
    return f"{created_at} | {executor_display}{child_label} | {source_ref}\n{result}"


def _todo_message(todo: Any, *, resolve_endpoints: Any = None) -> str:
    message = str(getattr(todo, "message", "")).strip()
    if str(getattr(todo, "todo_type", "") or "") != "spawn_closure":
        return message
    created_at = _format_beijing_time(str(getattr(todo, "created_at", "") or "unknown"))
    source_ref = str(getattr(todo, "source_ref", "") or getattr(todo, "logical_key", "") or "unknown")
    requester, executor_display, child_label = _spawn_closure_endpoint_labels(todo, message, resolve_endpoints)
    result = _spawn_closure_result_text(message)
    return "\n".join(
        [
            "请处理下面这条子 session 完成结果：",
            "",
            f"1. 时间：{created_at}",
            f"2. 发起方：{requester}",
            f"3. 执行子 session：{executor_display}{child_label}",
            "4. 状态：已执行完成",
            "5. 现在动作：把完成内容返回给你继续处理",
            f"关联 ID：{source_ref}",
            "",
            "内容如下：",
            result,
        ]
    )


def _iso_to_ms(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _format_beijing_time(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    beijing = parsed.astimezone(timezone(timedelta(hours=8)))
    return f"{beijing.strftime('%Y-%m-%d %H:%M:%S')} 北京时间"


def _spawn_closure_result_text(message: str) -> str:
    match = re.search(r"<result>\s*(.*?)\s*</result>", message, flags=re.DOTALL)
    if match:
        return match.group(1).strip()

    lines = []
    for line in message.splitlines():
        stripped = line.strip()
        if not stripped:
            lines.append(line)
            continue
        if re.match(r"这是你请求〔[^〕]+〕的结果,?框架兜底送回。?", stripped):
            continue
        if stripped == "child completed after caller stopped waiting; deliver full result to caller":
            continue
        if stripped == "late result is now present; deliver it to caller":
            continue
        if re.match(r"comm_id:\s*comm_", stripped):
            continue
        if stripped.startswith("<sm-child-completed ") or stripped == "</sm-child-completed>":
            continue
        lines.append(line)
    cleaned = "\n".join(lines).strip()
    return cleaned or message


def _extract_child_name(message: str) -> str:
    match = re.search(r'child_name="([^"]+)"', message)
    return match.group(1) if match else ""


def _child_owner_from_name(child_name: str) -> str:
    match = re.match(r"child_(.+)_[^_]+$", child_name)
    return match.group(1) if match else "unknown"


def _spawn_closure_endpoint_labels(todo: Any, message: str, resolve_endpoints: Any) -> tuple[str, str, str]:
    # 三元组：发起方显示名 / 执行子 session owner 显示名 / 「（child_name）」尾缀（空串则无尾缀）。
    # 权威来源是 cross_session_log（按 source_ref=comm_id JOIN sessions），失败回退 message 文本 grep，
    # 最后回退 source_session / "unknown"。注入目标 target_session 永远不是「发起方」。
    endpoints: dict[str, Any] | None = None
    source_ref = str(getattr(todo, "source_ref", "") or "")
    if callable(resolve_endpoints) and source_ref:
        try:
            endpoints = resolve_endpoints(source_ref)
        except Exception:
            endpoints = None

    caller_name = (endpoints or {}).get("caller") if endpoints else None
    target_name = (endpoints or {}).get("target") if endpoints else None
    child_name_db = (endpoints or {}).get("child") if endpoints else None

    if isinstance(caller_name, str) and caller_name:
        requester = _session_display_name(caller_name)
    else:
        fallback_caller = str(getattr(todo, "source_session", "") or "").strip()
        requester = _session_display_name(fallback_caller) if fallback_caller else "unknown"

    child_name = child_name_db if isinstance(child_name_db, str) and child_name_db else _extract_child_name(message)
    if isinstance(target_name, str) and target_name:
        executor_display = _session_display_name(target_name)
    else:
        executor_display = _session_display_name(_child_owner_from_name(child_name))

    child_label = f"（{child_name}）" if child_name else ""
    return requester, executor_display, child_label


def _session_display_name(session_name: str) -> str:
    alias = _session_aliases().get(session_name)
    if alias and alias != session_name:
        return f"{alias}（{session_name}）"
    return session_name


def _session_aliases() -> dict[str, str]:
    global _SESSION_ALIAS_CACHE
    if _SESSION_ALIAS_CACHE is not None:
        return _SESSION_ALIAS_CACHE
    try:
        raw = json.loads(SESSION_CATALOG_PATH.read_text())
    except Exception:
        _SESSION_ALIAS_CACHE = {}
        return _SESSION_ALIAS_CACHE
    sessions = raw.get("sessions") if isinstance(raw, dict) else raw
    aliases: dict[str, str] = {}
    if isinstance(sessions, list):
        for item in sessions:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            alias = str(item.get("alias") or "")
            if name and alias:
                aliases[name] = alias
    _SESSION_ALIAS_CACHE = aliases
    return aliases


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


def _alert_action_detail(alert_message: str, user_message: str) -> str:
    parts = [f"alert={alert_message}"]
    if user_message:
        parts.append(f"user_message={user_message}")
    else:
        parts.append("user_message_skipped=session_busy")
    return "; ".join(parts)


def _alert_event_summary(reason: str, alert_message: str, user_message: str) -> str:
    parts = [str(reason), f"alert_message={alert_message}"]
    if user_message:
        parts.append(f"user_message={user_message}")
    else:
        parts.append("user_message_skipped=session_busy")
    return "; ".join(parts)


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


def build_default_runner(cfg: Config, *, state: HeartbeatState | None = None) -> PatrolRunner:
    state = state or HeartbeatState(cfg.state_db_path)
    todo_watch_launcher = None
    if cfg.todo_watch_enabled:
        settings = watch_settings_from_config(cfg)

        def todo_watch_launcher(session_name: str) -> dict[str, Any]:
            return ensure_todo_watch(
                state=state,
                target_session=session_name,
                cause="drain_miss",
                settings=settings,
            )

    return PatrolRunner(
        state=state,
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
        candidate_max_age_hours=cfg.candidate_max_age_hours,
        max_sessions_per_patrol=cfg.max_sessions_per_patrol,
        max_controller_concurrency=cfg.max_controller_concurrency,
        max_escalation_concurrency=cfg.max_escalation_concurrency,
        model_prefilter_enabled=cfg.model_prefilter_enabled,
        todo_watch_launcher=todo_watch_launcher,
        action_failure_threshold=cfg.action_failure_threshold,
        action_cooldown_minutes=cfg.action_cooldown_minutes,
        unrecovered_escalation_threshold=cfg.unrecovered_escalation_threshold,
        unrecovered_window_minutes=cfg.unrecovered_window_minutes,
        unrecovered_max_unreconciled_hours=cfg.unrecovered_max_unreconciled_hours,
        unrecovered_reescalate_minutes=cfg.unrecovered_reescalate_minutes,
    )
