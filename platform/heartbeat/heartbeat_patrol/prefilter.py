from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from typing import Any
from zoneinfo import ZoneInfo


RUN_CANDIDATE_STATUSES = {"failed", "timeout", "error", "cancelled"}
CROSS_CANDIDATE_STATUSES = {"failed", "timeout", "error", "cancelled"}
ACTIVE_SESSION_STATUSES = {"error"}
COMPLETED_RUN_STATUSES = {"completed", "success", "succeeded", "done"}
DEFAULT_CANDIDATE_MAX_AGE_MINUTES = 24 * 60
NO_LOCAL_CANDIDATE_SIGNAL = "no local candidate signal"
USER_CANCELLED_RE = re.compile(
    r"(?:cancelled\s+by\s+user|用户(?:主动)?取消|用户中断|❌\s*cancelled)",
    re.IGNORECASE,
)
USER_CONFIRMATION_CUE_RE = re.compile(
    r"(?:如果确认|请确认|确认|是否|要不要|可以吗|能否|是否可以|approve|confirm)",
    re.IGNORECASE,
)
USER_APPROVAL_ACTION_RE = re.compile(
    r"(?:对外分享|外发|公开|发布|正式下载链接|下载链接|分享链接|share-file|public|publish|"
    r"授权|审批|权限|删除|delete|付费|花钱)",
    re.IGNORECASE,
)
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
PROVIDER_LIMIT_SIGNAL_PATTERN = (
    r"(?:"
    r"you(?:['’]ve|\s+have)?\s+(?:hit|reached|exceeded)\s+your\s+"
    r"[^\n.!?]{0,100}(?:limit|quota)|"
    r"(?:your\s+)?(?:weekly|session|usage|account|provider|organization|"
    r"org(?:anization)?['’]?s?)\s+(?:monthly\s+)?(?:usage\s+)?(?:limit|quota)"
    r"(?:\s+(?:has\s+been\s+)?(?:reached|exceeded|exhausted))?|"
    r"quota\s+(?:reached|exceeded|exhausted)|insufficient\s+quota|resource\s+exhausted|"
    r"server\s+is\s+temporarily\s+limiting\s+requests|"
    r"api\s+error:.*rate[- ]limit|rate[- ]limit(?:ed|ing|\s+exceeded)?|"
    r"too\s+many\s+requests|请求(?:过于频繁|频率.{0,12}(?:受限|限制))|"
    r"限流|(?:配额|额度).{0,20}(?:用尽|耗尽|不足|达到.{0,8}(?:上限|限制))"
    r")"
)
PROVIDER_LIMIT_RE = re.compile(PROVIDER_LIMIT_SIGNAL_PATTERN, re.IGNORECASE | re.DOTALL)
DIRECT_PROVIDER_LIMIT_RE = re.compile(
    rf"^(?:{PROVIDER_LIMIT_SIGNAL_PATTERN})",
    re.IGNORECASE | re.DOTALL,
)
MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))
RESET_CUE_RE = r"(?:resets?|will\s+reset|try\s+again|available\s+again|retry\s+after)"
RESET_TIME_RE = re.compile(
    rf"{RESET_CUE_RE}(?:\s+(?:on|at|after))?\s+"
    rf"(?:(?P<month>{MONTH_RE})\s+(?P<day>\d{{1,2}})(?:st|nd|rd|th)?"
    rf"(?:,?\s*(?P<year>\d{{4}}))?\s+)?"
    r"(?:at\s+)?(?P<time>\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}:\d{2})",
    re.IGNORECASE,
)
CHINESE_RESET_TIME_RE = re.compile(
    r"(?:reset|resets|重置|恢复)[^\n。；;]{0,40}?"
    r"(?:(?P<month>\d{1,2})\s*月\s*(?P<day>\d{1,2})\s*(?:日|号)?[^\d]{0,12})?"
    r"(?P<hour>\d{1,2})(?:[:：点](?P<minute>\d{1,2}))?\s*(?P<meridiem>上午|下午|晚上|am|pm)?",
    re.IGNORECASE,
)
DEFAULT_PROVIDER_LIMIT_PAUSE_MINUTES = 60
PROVIDER_LIMIT_RESET_BUFFER_SECONDS = 5 * 60


@dataclass(frozen=True)
class ProviderLimitPause:
    reason: str
    limit_kind: str
    scope: str
    reset_at: datetime | None

    def expires_at(self, *, buffer_seconds: int = PROVIDER_LIMIT_RESET_BUFFER_SECONDS) -> datetime | None:
        if self.reset_at is None:
            return None
        return self.reset_at + timedelta(seconds=max(0, buffer_seconds))


@dataclass(frozen=True)
class ProviderLimitRecovery:
    run_id: str
    observed_at: datetime


def should_check_with_model(
    packet: dict[str, Any],
    *,
    now_ms: int,
    stale_running_minutes: int,
    child_sla_minutes: int,
    candidate_max_age_minutes: int = DEFAULT_CANDIDATE_MAX_AGE_MINUTES,
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    session = packet.get("session")
    if isinstance(session, dict) and str(session.get("status", "")).lower() in ACTIVE_SESSION_STATUSES:
        reasons.append(f"active session status {session.get('status')}")

    runs = [run for run in packet.get("recent_runs") or [] if isinstance(run, dict)]
    latest_run = runs[0] if runs else None
    if (
        isinstance(latest_run, dict)
        and _within_candidate_window(_run_reference_time(latest_run), now_ms, candidate_max_age_minutes)
        and _is_user_cancelled_run(latest_run)
    ):
        return False, [f"latest run {latest_run.get('id') or 'unknown'} cancelled by user"]

    for run in runs:
        if not isinstance(run, dict):
            continue
        if not _within_candidate_window(_run_reference_time(run), now_ms, candidate_max_age_minutes):
            continue
        status = str(run.get("status", "")).lower()
        run_id = str(run.get("id") or "unknown")
        if status == "running" and _age_minutes(run.get("started_at"), now_ms) >= stale_running_minutes:
            reasons.append(f"stale running run {run_id}")
    if (
        isinstance(latest_run, dict)
        and _within_candidate_window(_run_reference_time(latest_run), now_ms, candidate_max_age_minutes)
    ):
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
        if not _within_candidate_window(_cross_reference_time(item), now_ms, candidate_max_age_minutes):
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
    return False, [NO_LOCAL_CANDIDATE_SIGNAL]


def provider_limit_pause_reason(
    packet: dict[str, Any],
    *,
    now_ms: int,
    candidate_max_age_minutes: int = DEFAULT_CANDIDATE_MAX_AGE_MINUTES,
) -> str | None:
    pause = provider_limit_pause(
        packet,
        now_ms=now_ms,
        candidate_max_age_minutes=candidate_max_age_minutes,
    )
    return pause.reason if pause else None


def provider_limit_pause(
    packet: dict[str, Any],
    *,
    now_ms: int,
    candidate_max_age_minutes: int = DEFAULT_CANDIDATE_MAX_AGE_MINUTES,
) -> ProviderLimitPause | None:
    runs = [run for run in packet.get("recent_runs") or [] if isinstance(run, dict)]
    latest_run = runs[0] if runs else None
    if not isinstance(latest_run, dict):
        return None
    if not _within_candidate_window(_run_reference_time(latest_run), now_ms, candidate_max_age_minutes):
        return None
    latest_status = str(latest_run.get("status", "")).lower()
    if latest_status not in COMPLETED_RUN_STATUSES | RUN_CANDIDATE_STATUSES:
        return None
    text = _provider_limit_text(latest_run)
    if not text or not PROVIDER_LIMIT_RE.search(text):
        return None
    run_reference_ms = _timestamp_ms(_run_reference_time(latest_run))
    reference_ms = run_reference_ms or now_ms
    reset_at = _safe_provider_limit_reset_at(
        text,
        reference_ms=reference_ms,
        roll_time_only_to_next_day=run_reference_ms is not None,
    )
    if reset_at is not None and datetime.fromtimestamp(now_ms / 1000, timezone.utc) >= reset_at:
        return None
    run_id = latest_run.get("id") or "unknown"
    kind = _provider_limit_kind(text)
    reason = f"provider limit in latest run {run_id}; kind={kind}"
    if reset_at is not None:
        reason = f"{reason}; reset_at={reset_at.isoformat(timespec='seconds')}"
    return ProviderLimitPause(
        reason=reason,
        limit_kind=kind,
        scope="backend_model" if kind in {"weekly", "session", "usage", "model"} else "session",
        reset_at=reset_at,
    )


def provider_limit_recovery(
    packet: dict[str, Any], *, pause_updated_at: str
) -> ProviderLimitRecovery | None:
    """Return authoritative success evidence newer than a shared provider pause."""
    runs = [run for run in packet.get("recent_runs") or [] if isinstance(run, dict)]
    latest_run = runs[0] if runs else None
    if not isinstance(latest_run, dict):
        return None
    if str(latest_run.get("status") or "").lower() not in COMPLETED_RUN_STATUSES:
        return None
    if str(latest_run.get("error_message") or "").strip():
        return None
    final_message = str(latest_run.get("final_message") or "").strip()
    if not final_message or _provider_limit_text(latest_run):
        return None
    run_timestamp_ms = _timestamp_ms(_run_reference_time(latest_run))
    pause_timestamp_ms = _timestamp_ms(pause_updated_at)
    if run_timestamp_ms is None or pause_timestamp_ms is None or run_timestamp_ms <= pause_timestamp_ms:
        return None
    return ProviderLimitRecovery(
        run_id=str(latest_run.get("id") or "unknown"),
        observed_at=datetime.fromtimestamp(run_timestamp_ms / 1000, timezone.utc),
    )


def trim_packet_to_candidate_window(
    packet: dict[str, Any],
    *,
    now_ms: int,
    candidate_max_age_minutes: int = DEFAULT_CANDIDATE_MAX_AGE_MINUTES,
) -> dict[str, Any]:
    trimmed = dict(packet)
    trimmed["recent_runs"] = [
        run
        for run in packet.get("recent_runs") or []
        if isinstance(run, dict)
        and _within_candidate_window(_run_reference_time(run), now_ms, candidate_max_age_minutes)
    ]
    trimmed["recent_cross_session"] = [
        item
        for item in packet.get("recent_cross_session") or []
        if isinstance(item, dict)
        and _within_candidate_window(_cross_reference_time(item), now_ms, candidate_max_age_minutes)
    ]
    return trimmed


def _has_mechanical_continuation_checkpoint(run: dict[str, Any]) -> bool:
    final_message = run.get("final_message")
    if not isinstance(final_message, str) or not final_message.strip():
        return False
    if has_user_confirmation_gate(final_message):
        return False
    prompt = run.get("prompt")
    prompt_text = prompt if isinstance(prompt, str) else ""
    return bool(CONTINUATION_QUESTION_RE.search(final_message)) and bool(
        CONTINUATION_STEP_RE.search(final_message)
        or CONTINUATION_NUMBER_SEQUENCE_RE.search(final_message)
        or STEP_PLAN_RE.search(final_message)
        or STEP_PLAN_RE.search(prompt_text)
    )


def _is_user_cancelled_run(run: dict[str, Any]) -> bool:
    if str(run.get("status", "")).lower() != "cancelled":
        return False
    text = "\n".join(
        value
        for value in (run.get("final_message"), run.get("error_message"))
        if isinstance(value, str) and value.strip()
    )
    return bool(USER_CANCELLED_RE.search(text))


def has_user_confirmation_gate(text: str) -> bool:
    return bool(USER_CONFIRMATION_CUE_RE.search(text)) and bool(USER_APPROVAL_ACTION_RE.search(text))


def _has_provider_limit_checkpoint(run: dict[str, Any], now_ms: int) -> bool:
    text = _provider_limit_text(run)
    if not text or not PROVIDER_LIMIT_RE.search(text):
        return False
    run_reference_ms = _timestamp_ms(_run_reference_time(run))
    reference_ms = run_reference_ms or now_ms
    return _provider_limit_reset_has_passed(
        text,
        now_ms,
        reference_ms=reference_ms,
        roll_time_only_to_next_day=run_reference_ms is not None,
    )


def _provider_limit_text(run: dict[str, Any]) -> str:
    error_message = run.get("error_message")
    error_text = error_message.strip() if isinstance(error_message, str) else ""
    final_message = run.get("final_message")
    final_text = final_message.strip() if isinstance(final_message, str) else ""
    if error_text and PROVIDER_LIMIT_RE.search(error_text):
        if final_text and _standalone_provider_limit_message(final_text):
            return f"{error_text}\n{final_text}"
        return error_text
    if final_text and _standalone_provider_limit_message(final_text):
        return final_text
    return ""


def _standalone_provider_limit_message(text: str) -> bool:
    # final_message is also used for normal assistant reports. Only accept a provider error
    # when it is the payload itself, not a limit phrase quoted later in a diagnosis/report.
    candidate = re.sub(r"^[^A-Za-z0-9\u4e00-\u9fff]+", "", text.strip())
    candidate = re.sub(
        r"^(?:error|provider\s+error|request\s+failed|错误|请求失败)\s*[:：-]\s*",
        "",
        candidate,
        flags=re.IGNORECASE,
    )
    return DIRECT_PROVIDER_LIMIT_RE.match(candidate) is not None


def _provider_limit_reset_has_passed(
    text: str,
    now_ms: int,
    *,
    reference_ms: int | None = None,
    roll_time_only_to_next_day: bool = False,
) -> bool:
    reset_at = _safe_provider_limit_reset_at(
        text,
        reference_ms=reference_ms or now_ms,
        roll_time_only_to_next_day=roll_time_only_to_next_day,
    )
    if reset_at is None:
        return True
    return datetime.fromtimestamp(now_ms / 1000, timezone.utc) >= reset_at


def _provider_limit_kind(text: str) -> str:
    lowered = text.lower()
    if "weekly" in lowered:
        return "weekly"
    if "session" in lowered:
        return "session"
    named_limit = re.search(
        r"you(?:['’]ve|\s+have)?\s+(?:hit|reached|exceeded)\s+your\s+"
        r"(?P<name>[^\n.!?]{1,80}?)\s+(?:limit|quota)",
        lowered,
    )
    if named_limit:
        limit_name = named_limit.group("name").strip()
        if limit_name in {"usage", "account", "monthly", "organization", "org's", "org’s"}:
            return "usage"
        if limit_name not in {"weekly", "session", "provider"}:
            return "model"
    if any(token in lowered for token in ("usage", "account", "monthly", "organization", "org's", "org’s")):
        return "usage"
    if "switch model" in lowered:
        return "model"
    if "rate" in lowered or "too many" in lowered or "429" in lowered or "限流" in text:
        return "rate"
    return "generic"


def _safe_provider_limit_reset_at(
    text: str, *, reference_ms: int, roll_time_only_to_next_day: bool = True
) -> datetime | None:
    try:
        return _provider_limit_reset_at(
            text,
            reference_ms=reference_ms,
            roll_time_only_to_next_day=roll_time_only_to_next_day,
        )
    except (OverflowError, ValueError):
        return None


def _provider_limit_reset_at(
    text: str, *, reference_ms: int, roll_time_only_to_next_day: bool = True
) -> datetime | None:
    tz = _provider_limit_timezone(text)
    reference_local = datetime.fromtimestamp(reference_ms / 1000, tz)
    match = RESET_TIME_RE.search(text)
    if match:
        hour, minute = _parse_reset_time(match.group("time"))
        month_name = match.group("month")
        day_text = match.group("day")
        year_text = match.group("year")
        if month_name and day_text:
            year = int(year_text) if year_text else reference_local.year
            reset_local = reference_local.replace(
                year=year,
                month=MONTHS[month_name.lower()],
                day=int(day_text),
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if not year_text and reset_local < reference_local - timedelta(minutes=1):
                reset_local = reset_local.replace(year=reset_local.year + 1)
        else:
            reset_local = reference_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if roll_time_only_to_next_day and reset_local <= reference_local:
                reset_local += timedelta(days=1)
        return reset_local.astimezone(timezone.utc)

    zh_match = CHINESE_RESET_TIME_RE.search(text)
    if not zh_match:
        return None
    hour = int(zh_match.group("hour"))
    minute = int(zh_match.group("minute") or "0")
    meridiem = (zh_match.group("meridiem") or "").lower()
    if meridiem in {"pm", "下午", "晚上"} and hour < 12:
        hour += 12
    if meridiem in {"am", "上午"} and hour == 12:
        hour = 0
    month_text = zh_match.group("month")
    day_text = zh_match.group("day")
    if month_text and day_text:
        reset_local = reference_local.replace(
            month=int(month_text),
            day=int(day_text),
            hour=hour,
            minute=minute,
            second=0,
            microsecond=0,
        )
        if reset_local < reference_local - timedelta(minutes=1):
            reset_local = reset_local.replace(year=reset_local.year + 1)
    else:
        reset_local = reference_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if roll_time_only_to_next_day and reset_local <= reference_local:
            reset_local += timedelta(days=1)
    return reset_local.astimezone(timezone.utc)


def _parse_reset_time(text: str) -> tuple[int, int]:
    cleaned = text.strip().lower().replace(" ", "")
    meridiem = ""
    if cleaned.endswith("am") or cleaned.endswith("pm"):
        meridiem = cleaned[-2:]
        cleaned = cleaned[:-2]
    if ":" in cleaned:
        hour_text, minute_text = cleaned.split(":", 1)
        hour = int(hour_text)
        minute = int(minute_text)
    else:
        hour = int(cleaned)
        minute = 0
    if meridiem == "am":
        hour = 0 if hour == 12 else hour
    elif meridiem == "pm":
        hour = 12 if hour == 12 else hour + 12
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"invalid reset time: {text}")
    return hour, minute


def _provider_limit_timezone(text: str) -> ZoneInfo:
    match = re.search(r"\(([^)]+)\)", text)
    if match:
        zone_name = match.group(1).strip()
        try:
            return ZoneInfo(zone_name)
        except Exception:
            pass
    return ZoneInfo("Asia/Shanghai")


def _age_minutes(value: Any, now_ms: int) -> float:
    timestamp_ms = _timestamp_ms(value)
    if timestamp_ms is None:
        return 0
    return max(0, now_ms - timestamp_ms) / 60_000


def _within_candidate_window(value: Any, now_ms: int, candidate_max_age_minutes: int) -> bool:
    if candidate_max_age_minutes <= 0:
        return True
    timestamp_ms = _timestamp_ms(value)
    if timestamp_ms is None:
        return True
    return max(0, now_ms - timestamp_ms) <= candidate_max_age_minutes * 60_000


def _run_reference_time(run: dict[str, Any]) -> Any:
    return run.get("finished_at") or run.get("started_at")


def _cross_reference_time(item: dict[str, Any]) -> Any:
    return item.get("finished_at") or item.get("created_at")


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
