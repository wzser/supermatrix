from __future__ import annotations

from datetime import datetime
import re
from typing import Any


RUN_CANDIDATE_STATUSES = {"failed", "timeout", "error", "cancelled"}
CROSS_CANDIDATE_STATUSES = {"failed", "timeout", "error", "cancelled"}
ACTIVE_SESSION_STATUSES = {"error"}
COMPLETED_RUN_STATUSES = {"completed", "success", "succeeded", "done"}
CONTINUATION_QUESTION_RE = re.compile(
    r"(?:是否|要不要|需要我|要我|should\s+i|shall\s+i|do\s+you\s+want\s+me\s+to|would\s+you\s+like\s+me\s+to).{0,40}"
    r"(?:继续|continue|proceed)",
    re.IGNORECASE | re.DOTALL,
)
CONTINUATION_STEP_RE = re.compile(
    r"(?:继续|continue|proceed).{0,80}"
    r"(?:\bsteps?\s*\d+|步骤\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*(?:步|阶段)|remaining|next|剩余|余下|后续)",
    re.IGNORECASE | re.DOTALL,
)
CONTINUATION_NUMBER_SEQUENCE_RE = re.compile(
    r"(?:继续|continue|proceed).{0,16}(?:完成|处理|执行|推进|做|跑|with|to).{0,20}"
    r"\d+\s*(?:[-~]|、|,|，)\s*\d+",
    re.IGNORECASE | re.DOTALL,
)
STEP_PLAN_RE = re.compile(
    r"(?:\bsteps?\s*\d+\s*(?:[-~]|到|至|、|,|，|to)\s*\d+|步骤\s*\d+\s*(?:[-~]|到|至|、|,|，)\s*\d+|"
    r"(?:\bsteps?\s*\d+|步骤\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*(?:步|阶段)).{0,80}"
    r"(?:\bsteps?\s*\d+|步骤\s*\d+|第\s*[0-9一二三四五六七八九十]+\s*(?:步|阶段)))",
    re.IGNORECASE | re.DOTALL,
)
PROVIDER_LIMIT_RE = re.compile(
    r"(?:you['’]?ve hit your limit|server is temporarily limiting requests|"
    r"api error:.*rate limit|rate[- ]limited|too many requests|限流)",
    re.IGNORECASE | re.DOTALL,
)
RESET_TIME_RE = re.compile(r"resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b", re.IGNORECASE)


def should_check_with_model(
    packet: dict[str, Any],
    *,
    now_ms: int,
    stale_running_minutes: int,
    child_sla_minutes: int,
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    session = packet.get("session")
    if isinstance(session, dict) and str(session.get("status", "")).lower() in ACTIVE_SESSION_STATUSES:
        reasons.append(f"active session status {session.get('status')}")

    runs = [run for run in packet.get("recent_runs") or [] if isinstance(run, dict)]
    latest_run = runs[0] if runs else None
    for run in runs:
        if not isinstance(run, dict):
            continue
        status = str(run.get("status", "")).lower()
        run_id = str(run.get("id") or "unknown")
        if status == "running" and _age_minutes(run.get("started_at"), now_ms) >= stale_running_minutes:
            reasons.append(f"stale running run {run_id}")
    if isinstance(latest_run, dict):
        latest_status = str(latest_run.get("status", "")).lower()
        if latest_status in RUN_CANDIDATE_STATUSES:
            reasons.append(f"latest run {latest_run.get('id') or 'unknown'} status {latest_status}")
        if latest_status in COMPLETED_RUN_STATUSES and _has_mechanical_continuation_checkpoint(latest_run):
            reasons.append(f"continuation checkpoint in latest run {latest_run.get('id') or 'unknown'}")
        if latest_status in COMPLETED_RUN_STATUSES and _has_provider_limit_checkpoint(latest_run, now_ms):
            reasons.append(f"provider limit checkpoint in latest run {latest_run.get('id') or 'unknown'}")

    for item in packet.get("recent_cross_session") or []:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status", "")).lower()
        if (
            status in {"pending", "running"}
            and _age_minutes(item.get("created_at"), now_ms) >= child_sla_minutes
            and not _has_newer_completed_run(runs, item.get("created_at"))
        ):
            reasons.append(f"stale cross-session {status}")
        elif status in CROSS_CANDIDATE_STATUSES and not item.get("finished_at"):
            reasons.append(f"cross-session status {status}")

    for todo in packet.get("pending_todos") or []:
        if not isinstance(todo, dict):
            continue
        if str(todo.get("status", "")).lower() == "pending":
            todo_type = str(todo.get("todo_type") or "general")
            logical_key = str(todo.get("logical_key") or "unknown")
            reasons.append(f"pending session todo {todo_type} {logical_key}")

    if reasons:
        return True, reasons
    return False, ["no local candidate signal"]


def provider_limit_pause_reason(packet: dict[str, Any], *, now_ms: int) -> str | None:
    runs = [run for run in packet.get("recent_runs") or [] if isinstance(run, dict)]
    latest_run = runs[0] if runs else None
    if not isinstance(latest_run, dict):
        return None
    latest_status = str(latest_run.get("status", "")).lower()
    if latest_status not in COMPLETED_RUN_STATUSES | RUN_CANDIDATE_STATUSES:
        return None
    text = _provider_limit_text(latest_run)
    if not text or not PROVIDER_LIMIT_RE.search(text):
        return None
    reset = RESET_TIME_RE.search(text)
    if reset and _provider_limit_reset_has_passed(text, now_ms):
        return None
    run_id = latest_run.get("id") or "unknown"
    return f"provider limit in latest run {run_id}"


def _has_mechanical_continuation_checkpoint(run: dict[str, Any]) -> bool:
    final_message = run.get("final_message")
    if not isinstance(final_message, str) or not final_message.strip():
        return False
    prompt = run.get("prompt")
    prompt_text = prompt if isinstance(prompt, str) else ""
    return bool(CONTINUATION_QUESTION_RE.search(final_message)) and bool(
        CONTINUATION_STEP_RE.search(final_message)
        or CONTINUATION_NUMBER_SEQUENCE_RE.search(final_message)
        or STEP_PLAN_RE.search(final_message)
        or STEP_PLAN_RE.search(prompt_text)
    )


def _has_provider_limit_checkpoint(run: dict[str, Any], now_ms: int) -> bool:
    text = _provider_limit_text(run)
    if not text or not PROVIDER_LIMIT_RE.search(text):
        return False
    return _provider_limit_reset_has_passed(text, now_ms)


def _provider_limit_text(run: dict[str, Any]) -> str:
    return "\n".join(
        value
        for value in (run.get("final_message"), run.get("error_message"))
        if isinstance(value, str) and value.strip()
    )


def _provider_limit_reset_has_passed(text: str, now_ms: int) -> bool:
    match = RESET_TIME_RE.search(text)
    if not match:
        return True
    hour = int(match.group(1))
    minute = int(match.group(2) or "0")
    meridiem = match.group(3).lower()
    if meridiem == "am":
        hour = 0 if hour == 12 else hour
    else:
        hour = 12 if hour == 12 else hour + 12
    now_local = datetime.fromtimestamp(now_ms / 1000)
    reset_local = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return now_local >= reset_local


def _age_minutes(value: Any, now_ms: int) -> float:
    timestamp_ms = _timestamp_ms(value)
    if timestamp_ms is None:
        return 0
    return max(0, now_ms - timestamp_ms) / 60_000


def _has_newer_completed_run(runs: list[dict[str, Any]], value: Any) -> bool:
    timestamp_ms = _timestamp_ms(value)
    if timestamp_ms is None:
        return False
    for run in runs:
        status = str(run.get("status", "")).lower()
        if status not in COMPLETED_RUN_STATUSES:
            continue
        run_finished_ms = _timestamp_ms(run.get("finished_at"))
        run_started_ms = _timestamp_ms(run.get("started_at"))
        run_timestamp_ms = run_finished_ms or run_started_ms
        if run_timestamp_ms is not None and run_timestamp_ms > timestamp_ms:
            return True
    return False


def _timestamp_ms(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        text = value.replace("Z", "+00:00")
        try:
            return int(datetime.fromisoformat(text).timestamp() * 1000)
        except ValueError:
            return None
    return None
