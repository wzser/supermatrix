from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any


ALLOWED_SEVERITIES = {"info", "warn", "error"}
ALLOWED_DECISIONS = {"skip", "alert", "spawn_collect", "spawn_execute", "escalate", "user_resume"}
ALLOWED_MODELS = {"gpt-5.4-mini", "gpt-5.5"}
FORBIDDEN_PROMPT_ACTIONS = (
    re.compile(r"\bspawn\b(?:\s+\w+){0,3}\s+(?:session|sessions|scheduler|atp)\b"),
    re.compile(r"\bcreate\b(?:\s+\w+){0,3}\s+(?:child\s+)?session\b"),
    re.compile(r"\b(?:use|call|invoke)\b(?:\s+\w+){0,2}\s+/?api/spawn\b"),
    re.compile(r"\b(?:call|contact|ask)\b(?:\s+\w+){0,2}\s+(?:scheduler|atp)\b"),
    re.compile(r"\bmodify\b\s+unrelated\s+state\b"),
    re.compile(r"\bbypass\b\s+heartbeat\b"),
    re.compile(r"\bignore\b\s+no[- ]cascade\b"),
)
PROMPT_DIRECT_NEGATIONS = ("do not ", "don't ", "must not ", "never ", "禁止", "不要", "不得")
PROMPT_USE_NEGATIONS = ("do not use ", "don't use ", "must not use ", "never use ")
PROMPT_CLAUSE_SPLIT_RE = re.compile(r"[,.;!?\n]+")

MAX_ITEMS = 12
MAX_STRING_LENGTHS = {
    "logical_key": 160,
    "severity": 16,
    "decision": 32,
    "reason": 1000,
    "target_session": 120,
    "child_model": 64,
    "prompt": 4000,
}


class DecisionError(ValueError):
    pass


@dataclass(frozen=True)
class DecisionItem:
    logical_key: str
    severity: str
    decision: str
    reason: str
    target_session: str
    child_model: str
    prompt: str


@dataclass(frozen=True)
class PatrolDecision:
    session: str
    items: list[DecisionItem]


def parse_decision(raw: str, *, expected_session: str) -> PatrolDecision:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DecisionError(f"invalid JSON: {exc.msg}") from exc

    if not isinstance(payload, dict):
        raise DecisionError("decision root must be a JSON object")

    session = _bounded_string(payload, "session", max_length=120)
    if session != expected_session:
        raise DecisionError(f"session mismatch: expected {expected_session}")

    items_raw = payload.get("items")
    if not isinstance(items_raw, list):
        raise DecisionError("items must be a list")
    if len(items_raw) > MAX_ITEMS:
        raise DecisionError(f"items must contain at most {MAX_ITEMS} entries")

    items = [_parse_item(item, expected_session=expected_session, index=index) for index, item in enumerate(items_raw)]
    return PatrolDecision(session=session, items=items)


def build_controller_prompt(packet: dict[str, Any], *, controller_model: str, escalation_model: str) -> str:
    compact_packet = json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return "\n".join(
        [
            "Return JSON only. Do not include markdown, commentary, or code fences.",
            "You are the heartbeat patrol controller.",
            f"Controller model: {controller_model}. Escalation model: {escalation_model}.",
            "Default to skip. Only produce a non-skip item when the packet contains concrete evidence of unfinished work that the target session can safely continue.",
            "Use only decisions: skip, alert, spawn_collect, spawn_execute, escalate, user_resume.",
            "Allowed child_model values are gpt-5.4-mini and gpt-5.5.",
            "Use gpt-5.5 for every escalate decision; use gpt-5.4-mini for bounded collection or execution.",
            "Must skip when the latest relevant work is completed with no explicit remaining work, purely exploratory discussion, a real user choice gate requiring new product/business/parameter approval, a user pause/cancel such as '先不管' or '等下次', or a completed answer that only mentions future possibilities.",
            "Must skip a non-stale running run. A run that is still running and has not exceeded stale_running_minutes is already being handled by its own session; do not alert, spawn, escalate, or user_resume it.",
            "Must skip cancelled user interruptions unless a later message explicitly asks to continue the same work.",
            "Do not treat a mechanical continuation checkpoint as a real user choice gate when an already-approved multi-step plan completed early steps and asks whether to continue explicit remaining steps.",
            "May use alert only when human input, missing parameters, or a real decision gate is required and the packet shows the session forgot to ask or report it. Alert is an active blocker: the runner sends a bot notification and a controlled user message that tells the original session to ask the human for the missing parameters; do not use alert for work that can continue without a human answer.",
            "May use spawn_collect only for bounded evidence gathering inside the target session: stale running runs, timeout/failure with a final message saying it will wait/continue/report later, cross-session child work beyond SLA, or status/final-message contradictions.",
            "Stale means heartbeat_policy.now_ms minus the run started_at or cross-session created_at exceeds heartbeat_policy.stale_running_minutes or heartbeat_policy.child_sla_minutes. Never infer stale merely because similar rows finished faster.",
            "Must skip stale cross-session child rows when the packet shows a newer completed run after that child was created; treat the old child row as stale bookkeeping unless there is newer evidence that the same work is still unfinished.",
            "May use spawn_execute only when the next step is explicit, reversible, target-owned, and does not require a human decision or any cross-session handoff; this includes mechanical continuation checkpoints with explicit remaining steps from an already-approved plan.",
            "May use user_resume when the original session should continue inside its own conversation: stale evidence collection, explicit reversible next step, or a mechanical continuation checkpoint. The runner will ask a separate child composer for a natural user reply and then send it to the target session chat as user.",
            "If a timeout/failure is only waiting on an async handoff, child result, comm_* final_message, ATP report, or stale bookkeeping reconciliation, prefer a stable logical_key that matches the external result source. Ready recovery todos with types async_handoff_recovery, child_recovery, child_result_delivery, handoff_ack, or status_reconcile may preempt this soft historical action; hard alerts/escalations still block todo draining.",
            "At most one user_resume item is allowed per target session per patrol. If multiple stale rows point at the same topic, merge them into one stable logical_key or skip the lower-value duplicates.",
            "Should use user_resume for a latest failed/timeout run, or a completed run whose final_message/error_message is only a temporary provider or API rate limit / provider account limit notice, when the original prompt contains unfinished work and no real user choice gate.",
            "Use escalate only for high-impact platform, data, or user-visible delivery risk; escalation must still target only the packet session.",
            "Reasons must cite the specific packet evidence: run status, timestamp, phrase, child status, or contradiction.",
            "Apply the no-cascade clause: child prompts must not spawn any session, call ATP or scheduler, or modify unrelated state.",
            "Do not repeat no-cascade wording inside item.prompt; the runner appends that guard automatically.",
            "Avoid these words in item.prompt: spawn, /api/spawn, scheduler, ATP, unrelated state.",
            "For skip, prefer omitting the item entirely. If you include a skip item, set prompt exactly to 'No action.'.",
            "Top-level session must exactly equal Packet.session.name. Never use Packet.session.id as the session value.",
            "Each item must target only the packet session name, and logical_key must start with '<session-name>:'.",
            "Use stable logical_key values derived from the session and underlying run/child/task identifier so retries dedupe the same issue.",
            "For user_resume, item.prompt is composer guidance, not the literal outgoing message: describe what the natural user reply should achieve, cite the relevant packet evidence, and avoid adding new requirements.",
            "Schema: {\"session\":\"<session>\",\"items\":[{\"logical_key\":\"<session>:<stable-key>\",\"severity\":\"info|warn|error\",\"decision\":\"skip|alert|spawn_collect|spawn_execute|escalate|user_resume\",\"reason\":\"<bounded reason>\",\"target_session\":\"<session>\",\"child_model\":\"gpt-5.4-mini|gpt-5.5\",\"prompt\":\"<bounded child prompt or user-reply composer guidance>\"}]}",
            f"Packet: {compact_packet}",
        ]
    )


def _parse_item(item: Any, *, expected_session: str, index: int) -> DecisionItem:
    if not isinstance(item, dict):
        raise DecisionError(f"items[{index}] must be an object")

    values = {
        key: _bounded_string(item, key, max_length=MAX_STRING_LENGTHS[key])
        for key in (
            "logical_key",
            "severity",
            "decision",
            "reason",
            "target_session",
            "child_model",
            "prompt",
        )
    }

    if values["severity"] not in ALLOWED_SEVERITIES:
        raise DecisionError(f"items[{index}].severity is not allowed")
    if values["decision"] not in ALLOWED_DECISIONS:
        raise DecisionError(f"items[{index}].decision is not allowed")
    if values["child_model"] not in ALLOWED_MODELS:
        raise DecisionError(f"items[{index}].child_model is not allowed")
    if values["target_session"] != expected_session:
        raise DecisionError(f"items[{index}].target_session must equal expected session")
    if not values["logical_key"].startswith(f"{expected_session}:"):
        raise DecisionError(f"items[{index}].logical_key must start with '{expected_session}:'")
    if values["decision"] == "escalate" and values["child_model"] != "gpt-5.5":
        raise DecisionError(f"items[{index}].escalate must use gpt-5.5")
    _validate_prompt_safety(values["prompt"], index=index)

    return DecisionItem(**values)


def _bounded_string(payload: dict[str, Any], key: str, *, max_length: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        raise DecisionError(f"{key} must be a string")
    value = value.strip()
    if not value:
        raise DecisionError(f"{key} must be non-empty")
    if len(value) > max_length:
        raise DecisionError(f"{key} exceeds maximum length {max_length}")
    return value


def _validate_prompt_safety(prompt: str, *, index: int) -> None:
    for clause in PROMPT_CLAUSE_SPLIT_RE.split(prompt.lower()):
        clause = clause.strip()
        if not clause:
            continue
        for pattern in FORBIDDEN_PROMPT_ACTIONS:
            match = pattern.search(clause)
            if match and not _is_directly_negated(clause[: match.start()], api_spawn="/api/spawn" in match.group(0)):
                raise DecisionError(f"items[{index}].prompt contains unsafe instruction: {clause}")


def _is_directly_negated(prefix: str, *, api_spawn: bool) -> bool:
    prefix = prefix.rstrip()
    if api_spawn:
        if any(prefix.endswith(negation.rstrip()) for negation in PROMPT_USE_NEGATIONS):
            return True
    return any(prefix.endswith(negation.rstrip()) for negation in PROMPT_DIRECT_NEGATIONS)
