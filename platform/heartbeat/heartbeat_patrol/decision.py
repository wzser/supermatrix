from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any


ALLOWED_SEVERITIES = {"info", "warn", "error"}
ALLOWED_DECISIONS = {"skip", "alert", "spawn_collect", "spawn_execute", "escalate", "user_resume"}
ALLOWED_MODELS = {"gpt-5.4-mini", "gpt-5.5"}
RUNTIME_CONFIG_OBJECT_RE = (
    r"(?:backend(?:_session_id)?|model|effort|session_runtime_settings|"
    r"child_session_defaults|child\s+session\s+defaults|runtime\s+(?:settings|config|configuration|db|database)|"
    r"session\s+(?:settings|defaults)|SuperMatrix\s+(?:runtime\s+)?(?:DB|database)|"
    r"supermatrix\.db|后端|模型|运行配置|会话配置|主库|运行库)"
)
RUNTIME_CONFIG_MUTATION_VERB_RE = (
    r"(?:switch|change|set|update|modify|rewrite|alter|override|reroute|migrate|flip|patch|edit|write|mutate)"
)
FORBIDDEN_PROMPT_ACTIONS = (
    re.compile(r"\bspawn\b(?:\s+\w+){0,3}\s+(?:session|sessions|scheduler|atp)\b"),
    re.compile(r"\bcreate\b(?:\s+\w+){0,3}\s+(?:child\s+)?session\b"),
    re.compile(r"\b(?:use|call|invoke)\b(?:\s+\w+){0,2}\s+/?api/spawn\b"),
    re.compile(r"\b(?:call|contact|ask)\b(?:\s+\w+){0,2}\s+(?:scheduler|atp)\b"),
    re.compile(r"\bmodify\b\s+unrelated\s+state\b"),
    re.compile(r"\bbypass\b\s+heartbeat\b"),
    re.compile(r"\bignore\b\s+no[- ]cascade\b"),
    re.compile(r"\b(?:ignore|override|bypass|disable)\b(?:\s+\w+){0,4}\s+(?:read[- ]only|no[- ]mutation|runtime[- ]config[- ]no[- ]mutation)\b"),
)
FORBIDDEN_RUNTIME_CONFIG_MUTATIONS = (
    re.compile(rf"\b{RUNTIME_CONFIG_MUTATION_VERB_RE}\b(?:\s+\w+){{0,8}}\s+{RUNTIME_CONFIG_OBJECT_RE}\b", re.IGNORECASE),
    re.compile(rf"\b{RUNTIME_CONFIG_MUTATION_VERB_RE}\b[\s\S]{{0,200}}\bsupermatrix\.db\b", re.IGNORECASE),
    re.compile(r"\b(?:change|reroute|switch|move|migrate)\b(?:\s+\S+){0,8}\s+from\s+\S+\s+to\s+\S+", re.IGNORECASE),
    re.compile(rf"\b{RUNTIME_CONFIG_OBJECT_RE}\b(?:\s+\w+){{0,6}}\s+(?:to|=|into|as)\b", re.IGNORECASE),
    re.compile(r"\b(?:update|insert\s+into|delete\s+from|replace\s+into|alter\s+table|drop\s+table)\s+(?:sessions|session_runtime_settings|child_session_defaults)\b", re.IGNORECASE),
    re.compile(r"\b(?:direct\s+sql|sqlite3)\b.*\b(?:supermatrix\.db|sessions|session_runtime_settings|child_session_defaults)\b", re.IGNORECASE),
    re.compile(r"(?:切换|改成|修改|更新|写入|直写|改写|重写|覆盖|迁移|设置|变更|换成).{0,40}(?:backend|model|effort|后端|模型|backend_session_id|session_runtime_settings|child_session_defaults|运行配置|会话配置|主库|运行库|supermatrix\.db)", re.IGNORECASE),
    re.compile(r"(?:backend|model|effort|后端|模型|backend_session_id|session_runtime_settings|child_session_defaults|运行配置|会话配置|主库|运行库|supermatrix\.db).{0,40}(?:切换|改成|修改|更新|写入|直写|改写|重写|覆盖|迁移|设置|变更|换成)", re.IGNORECASE),
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
    payload = _normalize_skip_payload(payload, expected_session=expected_session)

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


def _normalize_skip_payload(payload: Any, *, expected_session: str) -> Any:
    if payload == []:
        return {"session": expected_session, "items": []}
    if isinstance(payload, dict):
        items = payload.get("items")
        if items == [] and not isinstance(payload.get("session"), str):
            normalized = dict(payload)
            normalized["session"] = expected_session
            return normalized
        if isinstance(items, list):
            normalized_items = [item for item in items if not _is_noop_skip_item(item)]
            if len(normalized_items) != len(items):
                normalized = dict(payload)
                normalized["items"] = normalized_items
                return normalized
    return payload


def _is_noop_skip_item(item: Any) -> bool:
    if not isinstance(item, dict):
        return False
    decision = item.get("decision")
    prompt = item.get("prompt")
    return isinstance(decision, str) and decision == "skip" and isinstance(prompt, str) and prompt.strip() == "No action."


def build_controller_prompt(packet: dict[str, Any], *, controller_model: str, escalation_model: str) -> str:
    compact_packet = json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    session = packet.get("session")
    session_name = session.get("name") if isinstance(session, dict) else None
    empty_decision = json.dumps(
        {"session": session_name if isinstance(session_name, str) and session_name else "<session-name>", "items": []},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "\n".join(
        [
            "Return JSON only. Do not include markdown, commentary, or code fences.",
            "The response root must always be a JSON object, never a bare array or string.",
            f"If no action is needed, return exactly this empty decision object: {empty_decision}",
            "Do not return skip items. A skip means items must be an empty array.",
            "Never use null for child_model; every emitted item must use an allowed child_model value.",
            "You are the heartbeat patrol controller.",
            f"Controller model: {controller_model}. Escalation model: {escalation_model}.",
            "Default to skip. Only produce a non-skip item when the packet contains concrete evidence of unfinished work that the target session can safely continue.",
            "Use only decisions: skip, alert, spawn_collect, spawn_execute, escalate, user_resume.",
            "Set child_model to gpt-5.5 on every emitted item; user_resume does not spawn a child.",
            "Runtime config is outside heartbeat's automatic authority. Never change or ask a child to change backend, model, effort, backend_session_id, session_runtime_settings, child_session_defaults, or the SuperMatrix runtime DB. If that seems necessary, emit alert only and say explicit user approval plus the framework owner /backend path is required.",
            "Must skip when the latest relevant work is completed with no explicit remaining work, purely exploratory discussion, a real user choice gate requiring new product/business/parameter approval, external file sharing, public link creation, publishing, deletion, spending, permission authorization, a user pause/cancel such as '先不管' or '等下次', or a completed answer that only mentions future possibilities.",
            "Must skip a non-stale running run. A run that is still running and has not exceeded stale_running_minutes is already being handled by its own session; do not alert, spawn, escalate, or user_resume it.",
            "Must skip cancelled user interruptions unless a later message explicitly asks to continue the same work.",
            "Must skip run or cross-session evidence older than heartbeat_policy.candidate_max_age_hours; the deterministic prefilter should already remove it, so do not infer unfinished work from old context that remains only as background.",
            "Do not treat a mechanical continuation checkpoint as a real user choice gate when an already-approved multi-step plan completed early steps and asks whether to continue explicit remaining steps.",
            "May use alert only when human input, missing parameters, or a real decision gate is required and the packet shows the session forgot to ask or report it. If the target session already asked the human for the confirmation or approval, skip instead of alerting or user_resume. Alert is an active blocker: the runner sends a bot notification; it only adds a controlled user message when the target session is idle and has no latest running run, so do not rely on alert to interrupt active work. Do not use alert for work that can continue without a human answer.",
            "An alert or escalate means this patrol cannot close the issue in the current run. The runner will register one stable-key agent todo with todomaster for heartbeat to follow up. Write reason as a short human-language problem statement (what is wrong and why leaving it matters), and write prompt as executable numbered steps with branches; do not put search traces or raw evidence in that todo text.",
            "Todo registration is a hard dedupe contract: derive one stable problem type by removing only a per-round instance suffix from logical_key; in each patrol run register at most one Todo per problem type. Before registering, read the complete 'PRODUCT_REDACTED / todolist' table without any status filter. If any row of that problem type exists, including completed or other terminal status, do not create a new row; follow up on the existing row only when an existing-row update contract explicitly applies. If the full-table read fails, fail closed and do not create a new Todo.",
            "May use spawn_collect only for bounded evidence gathering inside the target session: stale running runs, timeout/failure with a final message saying it will wait/continue/report later, cross-session child work beyond SLA, or status/final-message contradictions.",
            "Stale means heartbeat_policy.now_ms minus the run started_at or cross-session created_at exceeds heartbeat_policy.stale_running_minutes or heartbeat_policy.child_sla_minutes. Never infer stale merely because similar rows finished faster.",
            "Must skip stale cross-session child rows when the packet shows a newer completed run after that child was created; treat the old child row as stale bookkeeping unless there is newer evidence that the same work is still unfinished.",
            "May use spawn_execute only when the next step is explicit, reversible, target-owned, and does not require a human decision or any cross-session handoff; this includes mechanical continuation checkpoints with explicit remaining steps from an already-approved plan.",
            "May use user_resume when the original session should continue inside its own conversation: stale evidence collection, explicit reversible next step, or a mechanical continuation checkpoint. The runner sends a fixed pre-audited language template to the target session chat as user only if the target is currently idle and the latest run is not running; controller reason and prompt never become the outgoing message.",
            "If a timeout/failure is only waiting on an async handoff, child result, comm_* final_message, ATP report, or stale bookkeeping reconciliation, prefer a stable logical_key that matches the external result source. Ready recovery todos with types async_handoff_recovery, child_recovery, child_result_delivery, handoff_ack, or status_reconcile may preempt this soft historical action; hard alerts/escalations still block todo draining.",
            "At most one user_resume item is allowed per target session per patrol. If multiple stale rows point at the same topic, merge them into one stable logical_key or skip the lower-value duplicates.",
            "Should use user_resume for a latest failed/timeout run, or a completed run whose final_message/error_message is only a temporary provider or API rate limit / provider account limit notice, when the original prompt contains unfinished work and no real user choice gate.",
            "For provider.filtered empty completion, empty completion, or empty content failures, use a stable logical_key derived from target session plus failure class/backend/model/effort. If the same class repeats or prior heartbeat follow-up already reported human attention needed, use alert only; do not spawn another investigation under a fresh logical_key.",
            "Use escalate only for high-impact platform, data, or user-visible delivery risk; escalation must still target only the packet session. When the blocker is a missing human answer, parameter, approval, or authorization, use alert instead of escalate; never use escalate as a fallback for uncertainty about what the human wants.",
            "Reasons must identify the specific issue in human language; keep detailed run status, timestamps, phrases, child status, and contradictions in heartbeat's local event ledger rather than in the shared todo body.",
            "Apply the no-cascade clause: child prompts must not spawn any session, call ATP or scheduler, or modify unrelated state.",
            "Do not repeat no-cascade wording inside item.prompt; the runner appends that guard automatically.",
            "Avoid these words in item.prompt: spawn, /api/spawn, scheduler, ATP, unrelated state.",
            "For skip, prefer omitting the item entirely. If you include a skip item, set prompt exactly to 'No action.'.",
            "Top-level session must exactly equal Packet.session.name. Never use Packet.session.id as the session value.",
            "Each item must target only the packet session name, and logical_key must start with '<session-name>:'.",
            "Use stable logical_key values derived from the session and underlying run/child/task identifier so retries dedupe the same issue.",
            "Keep any per-round instance marker only as a trailing :run-<id>, :attempt-<id>, :instance-<id>, :round-<id>, :patrol-<id>, :event-<id>, :item-<id>, or :cycle-<id> suffix; the runner strips that suffix for Todo problem-type dedupe.",
            "For user_resume, item.prompt is a bounded evidence note for audit only, not the literal outgoing message: cite the relevant packet evidence and avoid adding new requirements.",
            "Schema: {\"session\":\"<session>\",\"items\":[{\"logical_key\":\"<session>:<stable-key>\",\"severity\":\"info|warn|error\",\"decision\":\"skip|alert|spawn_collect|spawn_execute|escalate|user_resume\",\"reason\":\"<bounded reason>\",\"target_session\":\"<session>\",\"child_model\":\"gpt-5.5\",\"prompt\":\"<bounded child prompt or user_resume evidence note>\"}]}",
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
    normalized_prompt = _normalize_prompt_text(prompt)
    if contains_runtime_config_mutation_intent(normalized_prompt):
        raise DecisionError(f"items[{index}].prompt contains runtime config mutation: {prompt.strip()}")
    for clause in PROMPT_CLAUSE_SPLIT_RE.split(normalized_prompt):
        clause = clause.strip()
        if not clause:
            continue
        for pattern in FORBIDDEN_PROMPT_ACTIONS:
            match = pattern.search(clause)
            if match and not _is_directly_negated(clause[: match.start()], api_spawn="/api/spawn" in match.group(0)):
                raise DecisionError(f"items[{index}].prompt contains unsafe instruction: {clause}")


def contains_runtime_config_mutation_intent(text: str) -> bool:
    if not isinstance(text, str) or not text.strip():
        return False
    normalized_text = _normalize_prompt_text(text)
    for pattern in FORBIDDEN_RUNTIME_CONFIG_MUTATIONS:
        for match in pattern.finditer(normalized_text):
            if not _is_runtime_config_match_negated(normalized_text, match.start()):
                return True
    for clause in PROMPT_CLAUSE_SPLIT_RE.split(normalized_text):
        clause = clause.strip()
        if not clause:
            continue
        for pattern in FORBIDDEN_RUNTIME_CONFIG_MUTATIONS:
            for match in pattern.finditer(clause):
                if not _is_runtime_config_match_negated(clause, match.start()):
                    return True
    return False


def _normalize_prompt_text(text: str) -> str:
    return text.lower().replace("`", "")


def _is_runtime_config_match_negated(text: str, start: int) -> bool:
    prefix = text[:start].rstrip()
    if _is_directly_negated(prefix, api_spawn=False):
        return True
    clause_prefix = PROMPT_CLAUSE_SPLIT_RE.split(prefix)[-1].strip()
    if not clause_prefix:
        return False
    return bool(
        re.search(
            rf"(?:do not|don't|must not|never|禁止|不要|不得)\s+(?:directly\s+)?"
            rf"{RUNTIME_CONFIG_MUTATION_VERB_RE}(?:\s+\S+){{0,8}}$",
            clause_prefix,
            re.IGNORECASE,
        )
    )


def _is_directly_negated(prefix: str, *, api_spawn: bool) -> bool:
    prefix = prefix.rstrip()
    if api_spawn:
        if any(prefix.endswith(negation.rstrip()) for negation in PROMPT_USE_NEGATIONS):
            return True
    return any(prefix.endswith(negation.rstrip()) for negation in PROMPT_DIRECT_NEGATIONS)
