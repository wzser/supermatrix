#!/usr/bin/env python3
"""Periodic skill-usage evaluation (every ~3 days).

What it does, in order:
  1. Aggregate metrics/call-log.jsonl → per-skill counts (total, 3d window, top sessions).
  2. Enqueue an idempotent upsert batch to Feishu SkillCallCounts.
  3. Fan out through a rolling gate: prioritize recent skill users, then ask a
     bounded rotation of sibling sessions. Parse replies.
  4. Append issues to metrics/issues.jsonl + upsert to Feishu SkillIssues.
  5. Write a review report to metrics/reviews/<utc-date>.md.

Usage:
  evaluate-skills.py                      # aggregate + fanout + write review
  evaluate-skills.py --no-fanout          # aggregate + write review only
  evaluate-skills.py --sessions foo,bar   # fan out only to these sessions
  evaluate-skills.py --all-sessions       # bypass rolling gate for a manual full sweep
"""
import argparse
import ast
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

from feishu_enqueue import enqueue_bitable_rows

ROOT = Path(__file__).resolve().parent.parent
SESSION_CATALOG = ROOT / "session-catalog.json"
LOG = ROOT / "metrics" / "call-log.jsonl"
ISSUES_LOG = ROOT / "metrics" / "issues.jsonl"
ISSUE_LIFECYCLE = ROOT / "metrics" / "issue-lifecycle.jsonl"
ISSUE_LIFECYCLE_EVENTS = ROOT / "metrics" / "issue-lifecycle-events.jsonl"
PRODUCTION_ISSUE_LIFECYCLE_EVENTS = ISSUE_LIFECYCLE_EVENTS
ISSUE_FOLLOWUPS = ROOT / "metrics" / "issue-followups.jsonl"
OWNER_RESOLUTION_ESCALATIONS = ROOT / "metrics" / "owner-resolution-escalations.jsonl"
OWNER_RESOLUTION_DECISIONS = ROOT / "metrics" / "owner-resolution-decisions.jsonl"
OWNER_RESOLUTION_DECISION_TABLE = ROOT / "metrics" / "owner-resolution-decisions.md"
ISSUE_BACKLOG_TREND = ROOT / "metrics" / "issue-backlog-trend.jsonl"
REVIEWS_DIR = ROOT / "metrics" / "reviews"
LAST_RUN = ROOT / "metrics" / "last-run.txt"
FANOUT_STATE = ROOT / "metrics" / "eval-fanout-state.json"
INDEX = ROOT / "skills" / "INDEX.md"

APP_TOKEN = "F9F9bncWwaVzlRsZYs8csffQnB3"
ISSUES_TID = "tblREDACTEDTABLEID"
COUNTS_ASSET = "skill-master.metrics.Skill调用计数"
ISSUES_ASSET = "skill-master.issue.Skill问题池"

SPAWN_URL = "http://localhost:3501/api/spawn2.0"
SELF = "skill-master"
WINDOW_HOURS = 72
SPAWN_TIMEOUT_S = 45
FANOUT_PARALLEL = 12
FANOUT_BUDGET = 8
FANOUT_CYCLE_DAYS = 14
RECENT_USAGE_PRIORITY_LIMIT = 4
OWNER_ACK_OVERDUE_DAYS = 3
FOLLOWUP_BATCH_LIMIT = 20
RESOLUTION_ESCALATION_BATCH_LIMIT = 20
USER_DECISION_DEADLINE_HOURS = 24
ISSUE_SYNC_BATCH_LIMIT = 20
OWNER_HANDOFF_BATCH_LIMIT = 8
RESOLUTION_ACCOUNTING_VERSION = 2

LIFECYCLE_EVENTS = {
    "triaged",
    "owner_ack",
    "owner_rejected",
    "fix_submitted",
    "recheck_failed",
    "recheck_passed",
    "resolved",
    "closed",
    "downgraded",
    "deadline_expired",
}
EVENT_TO_LIFECYCLE = {
    "triaged": ("owner_ack_pending", "owner_ack"),
    "owner_ack": ("owner_acknowledged", "fix_submitted"),
    "owner_rejected": ("owner_ack_pending", "owner_ack"),
    "fix_submitted": ("fix_submitted", "recheck"),
    "recheck_failed": ("recheck_failed", "fix_update"),
    "recheck_passed": ("recheck_passed", "resolved"),
    "resolved": ("resolved", "none"),
    "closed": ("closed", "none"),
    "downgraded": ("downgraded", "none"),
    "deadline_expired": ("timed_out_default_unresolved", "owner_fix_or_explicit_decision"),
}
LIFECYCLE_PROGRESS_WEIGHTS = {
    "owner_ack_pending": 0,
    "owner_acknowledged": 1,
    "fix_submitted": 2,
    "recheck_failed": 2,
    "recheck_passed": 3,
    "resolved": 4,
    "closed": 4,
    "downgraded": 4,
    "timed_out_default_unresolved": 0,
    "terminal_without_fix_recheck_evidence": 0,
}
TERMINAL_LIFECYCLES = {"resolved", "closed", "downgraded"}
PROGRESS_LIFECYCLE_EVENTS = {"fix_submitted", "recheck_passed", "resolved", "closed", "downgraded"}
VERIFIED_RECHECK_EVENTS = {"recheck_passed", "resolved"}

QUESTION_PROMPT = """skill-master 每 3 天一次的 skill 使用评估。

过去 3 天你是否使用 / 触发了任何 skill（不限 skill-master 维护的，原生 claude / codex skill 也算）？使用过程中遇到的任何问题 —— 触发不准确、output 不对、报错、卡死、文档缺失、跟别的 skill 冲突 —— 都请按下面格式列出。没有问题就只回 `NONE`。

格式（每行一个问题，字段用 ` | ` 分隔，共 4 段）:
```
<skill-name> | <severity: info|bug|suggestion> | <one-line title> | <detailed description>
```

示例:
```
web-access | bug | CDP 连接偶尔 timeout | 在切换 amzh10 pack 时，约 1/5 的请求 chrome 连接超时，要手动 retry。
```

严格要求:
- 不要寒暄、不要解释、不要反问。
- 没问题就只回 NONE；有问题就只回问题行（可多行），不要加任何前后缀。
"""


def lark(*args):
    result = subprocess.run(["lark-cli", *args], capture_output=True, text=True)
    for out in (result.stdout, result.stderr):
        if not out:
            continue
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            continue
    return {}


def load_session_records():
    if not SESSION_CATALOG.exists():
        return []
    try:
        data = json.loads(SESSION_CATALOG.read_text(encoding="utf-8"))
    except Exception:
        return []
    records = []
    for rec in data.get("sessions", []):
        name = rec.get("name") if isinstance(rec, dict) else None
        status = rec.get("status") if isinstance(rec, dict) else None
        if not name or name == SELF:
            continue
        if status in {"deleted", "archived"}:
            continue
        records.append(rec)
    return records


def parse_sessions():
    return [rec["name"] for rec in load_session_records()]


def aggregate_calls():
    agg = {}
    if not LOG.exists():
        return agg
    cutoff = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)
    with LOG.open() as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            skill = rec.get("skill") or ""
            if not skill:
                continue
            try:
                t = datetime.fromisoformat(rec.get("ts", "").replace("Z", "+00:00"))
            except Exception:
                t = None
            a = agg.setdefault(skill, {"total": 0, "window": 0, "last": None, "sessions": {}})
            a["total"] += 1
            if t and t >= cutoff:
                a["window"] += 1
            if t and (a["last"] is None or t > a["last"]):
                a["last"] = t
            s = rec.get("session") or "unknown"
            a["sessions"][s] = a["sessions"].get(s, 0) + 1
    return agg


def recent_usage_sessions(limit=RECENT_USAGE_PRIORITY_LIMIT):
    if not LOG.exists():
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)
    counts = {}
    with LOG.open() as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            session = rec.get("session") or ""
            if not session or session == SELF:
                continue
            try:
                t = datetime.fromisoformat(rec.get("ts", "").replace("Z", "+00:00"))
            except Exception:
                continue
            if t >= cutoff:
                counts[session] = counts.get(session, 0) + 1
    return [s for s, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]]


def load_fanout_state():
    if not FANOUT_STATE.exists():
        return {"cursor": 0, "last_polled": {}}
    try:
        data = json.loads(FANOUT_STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"cursor": 0, "last_polled": {}}
    if not isinstance(data, dict):
        return {"cursor": 0, "last_polled": {}}
    data.setdefault("cursor", 0)
    data.setdefault("last_polled", {})
    return data


def save_fanout_state(state):
    FANOUT_STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FANOUT_STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(FANOUT_STATE)


def select_due_sessions(candidates, state, budget=FANOUT_BUDGET, cycle_days=FANOUT_CYCLE_DAYS):
    """Pick a bounded rolling set.

    Recent skill users get first slots, then the persistent cursor fills the
    rest. A session asked within cycle_days is skipped to avoid repeated NONE
    probes.
    """
    candidates = list(dict.fromkeys(candidates))
    if not candidates or budget <= 0:
        return [], {
            "candidate_count": len(candidates),
            "budget": budget,
            "cycle_days": cycle_days,
            "recent_priority": [],
            "cursor_before": state.get("cursor", 0),
            "cursor_after": state.get("cursor", 0),
        }

    now_ms = int(time.time() * 1000)
    cooldown_ms = int(cycle_days * 86400 * 1000)
    last_polled = state.get("last_polled", {})
    candidate_set = set(candidates)

    def due(session):
        last = last_polled.get(session)
        return not isinstance(last, int) or now_ms - last >= cooldown_ms

    selected = []
    recent = [s for s in recent_usage_sessions() if s in candidate_set and due(s)]
    for session in recent:
        if len(selected) >= budget:
            break
        selected.append(session)

    cursor = int(state.get("cursor", 0) or 0)
    if candidates:
        cursor %= len(candidates)
    cursor_after = cursor
    for offset in range(len(candidates)):
        if len(selected) >= budget:
            break
        idx = (cursor + offset) % len(candidates)
        session = candidates[idx]
        cursor_after = (idx + 1) % len(candidates)
        if session in selected or not due(session):
            continue
        selected.append(session)

    return selected, {
        "candidate_count": len(candidates),
        "budget": budget,
        "cycle_days": cycle_days,
        "recent_priority": recent,
        "cursor_before": cursor,
        "cursor_after": cursor_after,
    }


def mark_polled(state, sessions, results):
    now_ms = int(time.time() * 1000)
    state.setdefault("last_polled", {})
    state.setdefault("last_result", {})
    result_by_session = {session: status for session, status, _ in results}
    for session in sessions:
        state["last_polled"][session] = now_ms
        state["last_result"][session] = result_by_session.get(session, "selected")


def top_sessions_str(sessions, n=3):
    items = sorted(sessions.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return ", ".join(f"{k}({v})" for k, v in items)


def upsert(table_id, fields, record_id=None):
    args = [
        "base", "+record-upsert",
        "--base-token", APP_TOKEN,
        "--table-id", table_id,
        "--as", "user",
        "--json", json.dumps(fields, ensure_ascii=False),
    ]
    if record_id:
        args += ["--record-id", record_id]
    return lark(*args)


def push_call_counts(agg):
    now_ms = int(time.time() * 1000)
    rows = []
    for skill, a in agg.items():
        payload = {
            "Name": skill,
            "Calls": a["total"],
            "Calls_3d": a["window"],
            "TopSessions": top_sessions_str(a["sessions"]),
            "Updated": now_ms,
        }
        if a["last"]:
            payload["LastCalled"] = int(a["last"].timestamp() * 1000)
        rows.append(payload)
    return enqueue_bitable_rows(COUNTS_ASSET, rows, key_suffix="evaluate-skills-call-counts")


def load_backends():
    """Map session name -> backend (claude/codex) from session-catalog.json."""
    if not SESSION_CATALOG.exists():
        return {}
    try:
        data = json.loads(SESSION_CATALOG.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {s.get("name"): s.get("backend") for s in data.get("sessions", []) if s.get("name")}


def build_client_request_id(target, today):
    # Stable per (UTC date, target). Retries within the same day reuse it.
    return f"{today}:skill-master:eval-fanout:{target}"


def spawn(session, prompt, backend, today, timeout_s=SPAWN_TIMEOUT_S):
    payload = {
        "from": SELF,
        "target": session,
        "prompt": prompt,
        "client_request_id": build_client_request_id(session, today),
        "execution": {"backend": backend},
        "closure": {"kind": "message", "target": {"type": "inline"}},
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(SPAWN_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
            if not data.get("ok", True):
                return None, data.get("error") or "spawn not ok"
            return data.get("finalMessage") or "", None
    except Exception as e:
        return None, str(e)


ISSUE_LINE = re.compile(r"^\s*([^|]+?)\s*\|\s*(info|bug|suggestion)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$")
INDEX_ROW = re.compile(r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$")


def parse_issues(session, text):
    out = []
    if not text:
        return out
    stripped = text.strip()
    if stripped.upper().startswith("NONE"):
        return out
    for line in stripped.splitlines():
        line = line.strip().strip("`").strip()
        if not line or line.startswith("#"):
            continue
        m = ISSUE_LINE.match(line)
        if not m:
            continue
        skill, sev, title, desc = m.group(1), m.group(2), m.group(3), m.group(4)
        out.append({
            "Skill": skill[:80],
            "Session": session,
            "Severity": sev,
            "Title": title[:200],
            "Description": desc[:2000],
            "Status": "open",
            "ReportedAt": int(time.time() * 1000),
        })
    return out


def push_issues(issues):
    if not issues:
        return 0
    ISSUES_LOG.parent.mkdir(parents=True, exist_ok=True)
    pushed = 0
    with ISSUES_LOG.open("a") as f:
        for issue in issues:
            if upsert(ISSUES_TID, issue).get("ok"):
                pushed += 1
            f.write(json.dumps(issue, ensure_ascii=False) + "\n")
    return pushed


def normalize_key_part(value):
    return re.sub(r"\s+", " ", (value or "").strip().lower())


def issue_key(issue):
    raw = "|".join([
        normalize_key_part(issue.get("Skill")),
        normalize_key_part(issue.get("Session")),
        normalize_key_part(issue.get("Title")),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def group_key(issue):
    raw = "|".join([
        normalize_key_part(issue.get("Skill")),
        normalize_key_part(issue.get("Title")),
    ])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def load_index_owners():
    owners = {}
    if not INDEX.exists():
        return owners
    in_skills = False
    for line in INDEX.read_text(encoding="utf-8").splitlines():
        if line.strip() == "## Skills":
            in_skills = True
            continue
        if not in_skills or not line.startswith("|"):
            continue
        if line.startswith("|------") or " Name " in line:
            continue
        m = INDEX_ROW.match(line)
        if not m:
            continue
        name = m.group(1).strip(" `")
        owner = m.group(4).strip(" `")
        if name and owner:
            owners[name] = owner
    return owners


def load_retired_skills():
    retired = set()
    if not INDEX.exists():
        return retired
    in_skills = False
    for line in INDEX.read_text(encoding="utf-8").splitlines():
        if line.strip() == "## Skills":
            in_skills = True
            continue
        if not in_skills or not line.startswith("|"):
            continue
        if line.startswith("|------") or " Name " in line:
            continue
        match = INDEX_ROW.match(line)
        if not match:
            continue
        name = match.group(1).strip(" `")
        purpose = match.group(5).strip()
        if name and "RETIRED-TOMBSTONE" in purpose.upper():
            retired.add(name)
    return retired


def load_all_issues():
    issues = []
    if not ISSUES_LOG.exists():
        return issues
    with ISSUES_LOG.open(encoding="utf-8") as f:
        for line in f:
            try:
                issue = json.loads(line)
            except Exception:
                continue
            if issue.get("Status", "open") == "open":
                issues.append(issue)
    return issues


def load_lifecycle_events():
    events = {}
    if not ISSUE_LIFECYCLE_EVENTS.exists():
        return events
    with ISSUE_LIFECYCLE_EVENTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                event = json.loads(line)
            except Exception:
                continue
            key = event.get("IssueKey")
            kind = event.get("Event")
            if not key or kind not in LIFECYCLE_EVENTS:
                continue
            events.setdefault(key, []).append(event)
    for records in events.values():
        records.sort(key=lambda item: item.get("At") or 0)
    return events


def pytest_node_id_exists(node_id):
    parts = [part.strip() for part in str(node_id or "").split("::")]
    if len(parts) < 2 or not all(parts):
        return False
    test_path = Path(parts[0])
    if test_path.is_absolute():
        return False
    test_path = (ROOT / test_path).resolve()
    try:
        test_path.relative_to(ROOT.resolve())
    except ValueError:
        return False
    if test_path.suffix != ".py" or not test_path.is_file():
        return False
    try:
        nodes = ast.parse(test_path.read_text(encoding="utf-8")).body
    except (OSError, SyntaxError, UnicodeError):
        return False
    selectors = [part.split("[", 1)[0] for part in parts[1:]]
    for index, selector in enumerate(selectors):
        if index == len(selectors) - 1:
            return selector.startswith("test_") and any(
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == selector
                for node in nodes
            )
        matching_class = next(
            (node for node in nodes if isinstance(node, ast.ClassDef) and node.name == selector),
            None,
        )
        if matching_class is None:
            return False
        nodes = matching_class.body
    return False


def reproducible_command_exists(command):
    command = str(command or "").strip()
    if not command or "\n" in command or "\r" in command:
        return False
    try:
        argv = shlex.split(command)
    except ValueError:
        return False
    if not argv:
        return False
    executable = argv[0]
    if "/" not in executable:
        return shutil.which(executable) is not None
    executable_path = Path(executable)
    if not executable_path.is_absolute():
        executable_path = ROOT / executable_path
    return executable_path.is_file()


def validate_recheck_evidence(event):
    if (event or {}).get("Event") not in VERIFIED_RECHECK_EVENTS:
        return
    evidence = str((event or {}).get("Evidence") or "").strip()
    proof_results = []
    for item in evidence.split(";"):
        item = item.strip()
        if item.startswith("pytest:"):
            proof_results.append(pytest_node_id_exists(item.removeprefix("pytest:")))
        elif item.startswith("command:"):
            proof_results.append(reproducible_command_exists(item.removeprefix("command:")))
    if not proof_results or not all(proof_results):
        raise ValueError(
            "recheck_passed/resolved evidence must name a real pytest node id "
            "(pytest:path.py::test_name) or a reproducible single command "
            "(command:argv, executed from the repository root)"
        )


def guard_lifecycle_sink_from_pytest():
    if not os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if ISSUE_LIFECYCLE_EVENTS.resolve() == PRODUCTION_ISSUE_LIFECYCLE_EVENTS.resolve():
        raise RuntimeError(
            "pytest attempted to write the production lifecycle sink; "
            "set ISSUE_LIFECYCLE_EVENTS to a tmp_path fixture"
        )


def append_lifecycle_events(events):
    if not events:
        return
    guard_lifecycle_sink_from_pytest()
    for event in events:
        validate_recheck_evidence(event)
    ISSUE_LIFECYCLE_EVENTS.parent.mkdir(parents=True, exist_ok=True)
    with ISSUE_LIFECYCLE_EVENTS.open("a", encoding="utf-8") as f:
        for event in events:
            f.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")


def append_followups(records):
    if not records:
        return
    ISSUE_FOLLOWUPS.parent.mkdir(parents=True, exist_ok=True)
    with ISSUE_FOLLOWUPS.open("a", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def append_owner_resolution_escalations(records):
    if not records:
        return
    OWNER_RESOLUTION_ESCALATIONS.parent.mkdir(parents=True, exist_ok=True)
    with OWNER_RESOLUTION_ESCALATIONS.open("a", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def append_owner_resolution_decisions(records):
    if not records:
        return
    OWNER_RESOLUTION_DECISIONS.parent.mkdir(parents=True, exist_ok=True)
    with OWNER_RESOLUTION_DECISIONS.open("a", encoding="utf-8") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def load_latest_owner_resolution_decisions():
    latest = {}
    if not OWNER_RESOLUTION_DECISIONS.exists():
        return latest
    with OWNER_RESOLUTION_DECISIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            key = record.get("IssueKey")
            if not key:
                continue
            previous = latest.get(key)
            if previous is None or record.get("At", 0) >= previous.get("At", 0):
                latest[key] = record
    return latest


def load_active_owner_resolution_decision_issue_keys():
    latest = load_latest_owner_resolution_decisions()
    return {
        key for key, record in latest.items()
        if record.get("Status") == "pending_user_decision" and record.get("CommId")
    }


def escape_md_cell(value):
    return str(value or "—").replace("|", "\\|").replace("\n", " ")


def load_current_open_issue_keys():
    if not ISSUE_LIFECYCLE.exists():
        return None
    keys = set()
    with ISSUE_LIFECYCLE.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("IssueKey") and record.get("Status") not in TERMINAL_LIFECYCLES:
                keys.add(record["IssueKey"])
    return keys


def write_owner_resolution_decision_table():
    latest = load_latest_owner_resolution_decisions()
    open_issue_keys = load_current_open_issue_keys()
    pending = [
        record for record in latest.values()
        if record.get("Status") == "pending_user_decision"
        and record.get("CommId")
        and (open_issue_keys is None or record.get("IssueKey") in open_issue_keys)
    ]
    pending.sort(key=lambda rec: (
        rec.get("DueAt") or 0,
        rec.get("Severity") or "",
        rec.get("Skill") or "",
        rec.get("IssueKey") or "",
    ))
    OWNER_RESOLUTION_DECISION_TABLE.parent.mkdir(parents=True, exist_ok=True)
    generated = datetime.now(timezone.utc).isoformat()
    lines = [
        "# Owner resolution decision queue",
        "",
        f"Generated: `{generated}`",
        "",
        "Only items that still need explicit user/business decision are listed here. "
        "A deadline on a live skill records an unresolved timeout; it never closes or downgrades the issue.",
        "",
        "| IssueKey | Skill | Reporter | Owner | Severity | Title | Recommended decision | Reason | Evidence | DueAt |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for rec in pending:
        lines.append(
            "| "
            + " | ".join([
                escape_md_cell(rec.get("IssueKey")),
                escape_md_cell(rec.get("Skill")),
                escape_md_cell(rec.get("ReporterSession")),
                escape_md_cell(rec.get("Owner")),
                escape_md_cell(rec.get("Severity")),
                escape_md_cell(rec.get("Title")),
                escape_md_cell(rec.get("RecommendedDecision")),
                escape_md_cell(rec.get("DecisionReason")),
                escape_md_cell(rec.get("Evidence")),
                escape_md_cell(rec.get("DueAt")),
            ])
            + " |"
        )
    OWNER_RESOLUTION_DECISION_TABLE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def latest_lifecycle_event(events):
    if not events:
        return "triaged", None
    last = events[-1]
    return last.get("Event", "triaged"), last


def record_lifecycle_event(issue_key_value, event_name, actor, evidence, note, route_to=None):
    if event_name not in LIFECYCLE_EVENTS or event_name == "triaged":
        raise SystemExit(f"invalid lifecycle event: {event_name}")
    if not issue_key_value:
        raise SystemExit("--issue-key is required")
    if not actor:
        raise SystemExit("--actor is required")
    if not evidence:
        raise SystemExit("--evidence is required")
    if event_name == "owner_rejected" and not route_to:
        raise SystemExit("--route-to is required for owner_rejected")
    issue = None
    for candidate in load_all_issues():
        if issue_key(candidate) == issue_key_value:
            issue = candidate
            break
    if issue is None:
        raise SystemExit(f"issue key not found in {ISSUES_LOG}: {issue_key_value}")
    now_ms = int(time.time() * 1000)
    event = {
        "At": now_ms,
        "IssueKey": issue_key_value,
        "GroupKey": group_key(issue),
        "Skill": issue.get("Skill") or "",
        "Session": issue.get("Session") or "",
        "Title": issue.get("Title") or "",
        "Event": event_name,
        "Actor": actor,
        "Evidence": evidence,
        "Note": note or "",
    }
    if event_name == "owner_rejected":
        event["RejectedOwner"] = actor
        event["RouteTo"] = route_to
    append_lifecycle_events([event])


def next_review_at(last_event_at, cadence_days):
    base = last_event_at if isinstance(last_event_at, int) and last_event_at > 0 else int(time.time() * 1000)
    return base + int(cadence_days * 86400 * 1000)


def evidence_path(path):
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def extract_comm_id(resp):
    if not isinstance(resp, dict):
        return None
    existing = resp.get("existing") if isinstance(resp.get("existing"), dict) else {}
    return (
        resp.get("commId")
        or resp.get("comm_id")
        or resp.get("spawnCommId")
        or resp.get("communicationId")
        or existing.get("commId")
    )


def load_recent_followup_keys(window_hours=72):
    if not ISSUE_FOLLOWUPS.exists():
        return set()
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    keys = set()
    with ISSUE_FOLLOWUPS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("At", 0) >= cutoff and record.get("Action") == "owner_ack_followup_due":
                keys.add(record.get("IssueKey"))
    return {key for key in keys if key}


def load_recent_handoff_keys(window_hours=72):
    if not ISSUE_FOLLOWUPS.exists():
        return set()
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    keys = set()
    with ISSUE_FOLLOWUPS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") in {"owner_ack_handoff_sent", "owner_ack_self_recorded"}:
                for key in record.get("IssueKeys") or []:
                    keys.add(key)
                if record.get("IssueKey"):
                    keys.add(record["IssueKey"])
    return {key for key in keys if key}


def load_recent_handoff_pairs(window_hours=72):
    if not ISSUE_FOLLOWUPS.exists():
        return set()
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    pairs = set()
    with ISSUE_FOLLOWUPS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") not in {"owner_ack_handoff_sent", "owner_ack_self_recorded", "owner_ack_external_recorded"}:
                continue
            owner = record.get("Owner")
            if not owner:
                continue
            for key in record.get("IssueKeys") or []:
                pairs.add((key, owner))
            if record.get("IssueKey"):
                pairs.add((record["IssueKey"], owner))
    return pairs


def load_recent_resolution_escalation_pairs(window_hours=72):
    if not OWNER_RESOLUTION_ESCALATIONS.exists():
        return set()
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    pairs = set()
    with OWNER_RESOLUTION_ESCALATIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") != "owner_resolution_escalation_sent":
                continue
            reporter = record.get("ReporterSession")
            owner = record.get("Owner")
            if not reporter or not owner:
                continue
            for key in record.get("IssueKeys") or []:
                pairs.add((key, reporter, owner))
            if record.get("IssueKey"):
                pairs.add((record["IssueKey"], reporter, owner))
    return pairs


def load_recent_resolution_escalation_issue_keys(window_hours=72):
    if not OWNER_RESOLUTION_ESCALATIONS.exists():
        return set()
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    keys = set()
    with OWNER_RESOLUTION_ESCALATIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") != "owner_resolution_escalation_sent":
                continue
            if not record.get("CommId"):
                continue
            keys.update(record.get("IssueKeys") or [])
            if record.get("IssueKey"):
                keys.add(record["IssueKey"])
    return keys


def latest_escalation_records_by_issue():
    latest = {}
    if not OWNER_RESOLUTION_ESCALATIONS.exists():
        return latest
    with OWNER_RESOLUTION_ESCALATIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except Exception:
                continue
            if record.get("Action") not in {
                "owner_resolution_escalation_sent",
                "owner_resolution_user_decision_requested",
                "owner_resolution_continue_recommended",
                "owner_resolution_user_decision_recorded",
            }:
                continue
            for key in record.get("IssueKeys") or []:
                previous = latest.get(key)
                if previous is None or record.get("At", 0) >= previous.get("At", 0):
                    latest[key] = record
    return latest


def append_default_user_decision_events(unique_issues, events_by_issue):
    now_ms = int(time.time() * 1000)
    deadline_ms = USER_DECISION_DEADLINE_HOURS * 3600 * 1000
    escalations_by_issue = latest_escalation_records_by_issue()
    issue_by_key = {issue_key(issue): issue for issue in unique_issues}
    retired_skills = load_retired_skills()
    lifecycle_events = []
    decision_records = []
    for key, escalation in escalations_by_issue.items():
        if (
            escalation.get("Action") == "owner_resolution_user_decision_recorded"
            and normalize_key_part(escalation.get("Decision")).startswith("continue")
        ):
            continue
        if now_ms - int(escalation.get("At") or 0) < deadline_ms:
            continue
        existing_events = events_by_issue.get(key, [])
        if any(event.get("At", 0) > escalation.get("At", 0) for event in existing_events):
            continue
        issue = issue_by_key.get(key)
        if not issue:
            continue
        retired = (issue.get("Skill") or "") in retired_skills
        event_name = "closed" if retired else "deadline_expired"
        status = "retired_skill_cleanup" if retired else "timed_out_default_unresolved"
        lifecycle_events.append({
            "At": now_ms,
            "IssueKey": key,
            "GroupKey": group_key(issue),
            "Skill": issue.get("Skill") or "",
            "Session": issue.get("Session") or "",
            "Title": issue.get("Title") or "",
            "Event": event_name,
            "Actor": SELF,
            "Evidence": escalation.get("Evidence") or evidence_path(OWNER_RESOLUTION_ESCALATIONS),
            "Note": (
                f"user decision deadline exceeded after {USER_DECISION_DEADLINE_HOURS}h; "
                f"default action={event_name}; resolution_status={status}; "
                f"source_action={escalation.get('Action')}; "
                f"source_comm={escalation.get('CommId') or 'none'}"
            ),
        })
        decision_records.append({
            "At": now_ms,
            "Action": "owner_resolution_deadline_applied",
            "Status": status,
            "Decision": event_name,
            "IssueKey": key,
            "GroupKey": group_key(issue),
            "Skill": issue.get("Skill") or "",
            "ReporterSession": issue.get("Session") or "",
            "Owner": escalation.get("Owner") or "",
            "Severity": issue.get("Severity") or "",
            "Title": issue.get("Title") or "",
            "DueAt": int(escalation.get("At") or 0) + deadline_ms,
            "Evidence": escalation.get("Evidence") or evidence_path(OWNER_RESOLUTION_ESCALATIONS),
            "CommId": escalation.get("CommId"),
            "RecommendedDecision": "retired_skill_cleanup" if retired else "continue_owner_evidence",
            "DecisionReason": (
                "retired skill cleanup is allowed to leave the repair backlog"
                if retired else
                "live skill deadline expired without fix and remains in the repair backlog"
            ),
            "Actor": SELF,
        })
    append_lifecycle_events(lifecycle_events)
    append_owner_resolution_decisions(decision_records)
    if decision_records:
        write_owner_resolution_decision_table()
    return len(lifecycle_events)


def build_owner_handoff_prompt(owner, issues):
    lines = [
        "[skill-master issue owner handoff]",
        "",
        "你是以下 skill 使用问题的 Owner。请不要只回收到；需要在你的 session 内 ACK，并安排修复或给出不修的理由。",
        "",
        "ACK 回执格式（任选其一）：",
        f"- 如果接受：OWNER_ACK owner={owner} issue_keys=<逗号分隔> next=<fix plan or recheck plan>",
        f"- 如果不归你：OWNER_REJECT owner={owner} issue_keys=<逗号分隔> route_to=<正确 owner> reason=<原因>",
        "",
        "skill-master 后续只根据 lifecycle event / ACK 回执 / fix / recheck evidence 关闭这些问题；本条 handoff 不会被当成 resolved。",
        "",
        "| IssueKey | Skill | Reporter session | Severity | Title | Evidence |",
        "|---|---|---|---|---|---|",
    ]
    for rec in issues:
        lines.append(
            f"| {rec['IssueKey']} | {rec['Skill']} | {rec['Session']} | "
            f"{rec['Severity']} | {rec['Title']} | metrics/issue-lifecycle.jsonl |"
        )
    return "\n".join(lines)


def build_owner_resolution_escalation_prompt(reporter, issues):
    deadline_hours = USER_DECISION_DEADLINE_HOURS
    lines = [
        "[skill-master issue resolution escalation]",
        "",
        "以下由你 session 报告的 skill 使用问题已经被 owner ACK，但超过一个 recheck 周期仍没有 fix_submitted / recheck_passed / resolved 证据。",
        "本次不再重复 ACK 催办；请把这条升级呈现给本 session user 决策：继续要求 owner 给带 evidence 的 resolved transition，或明确关闭/降级该问题。",
        "",
        f"硬截止：{deadline_hours} 小时内没有明确 user 决策或 lifecycle transition 时，LIVE skill 只会记为 timed_out_default_unresolved，仍留在未修复 backlog；只有 RETIRED-TOMBSTONE skill 可默认清理。",
        "闭环判据：LIVE skill 必须出现带 evidence 的 `fix_submitted` → `recheck_passed`/`resolved` 序列；单独 closed/downgraded 或超时默认不计真修复，health gate 继续红。",
        "",
        "| IssueKey | Owner | Skill | Severity | Title | Last evidence |",
        "|---|---|---|---|---|---|",
    ]
    for rec in issues:
        lines.append(
            f"| {rec['IssueKey']} | {rec['Owner']} | {rec['Skill']} | "
            f"{rec['Severity']} | {rec['Title']} | {rec.get('LastLifecycleEvidence') or '—'} |"
        )
    return "\n".join(lines)


def spawn_owner_handoff(owner, issues, timeout_s=20):
    today = datetime.now(timezone.utc).date().isoformat()
    key_hash = hashlib.sha1(",".join(sorted(rec["IssueKey"] for rec in issues)).encode("utf-8")).hexdigest()[:10]
    payload = {
        "from": SELF,
        "target": owner,
        "prompt": build_owner_handoff_prompt(owner, issues),
        "client_request_id": f"{today}:skill-master:issue-owner-ack:{owner}:{key_hash}",
        "closure": {"kind": "message", "target": {"type": "todo_pool"}},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SPAWN_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            data["_client_request_id"] = payload["client_request_id"]
        return data, None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except Exception:
            data = {"error": raw or str(exc)}
        data["_client_request_id"] = payload["client_request_id"]
        if exc.code == 409 and data.get("duplicate"):
            data["_duplicate_handoff"] = True
            return data, None
        return data, f"HTTP {exc.code}: {data.get('error') or raw or exc.reason}"
    except Exception as exc:
        return None, str(exc)


def spawn_owner_resolution_escalation(reporter, issues, timeout_s=SPAWN_TIMEOUT_S):
    today = datetime.now(timezone.utc).date().isoformat()
    key_hash = hashlib.sha1(",".join(sorted(rec["IssueKey"] for rec in issues)).encode("utf-8")).hexdigest()[:10]
    payload = {
        "from": SELF,
        "target": reporter,
        "prompt": build_owner_resolution_escalation_prompt(reporter, issues),
        "client_request_id": f"{today}:skill-master:owner-resolution-escalation:{reporter}:{key_hash}",
        "closure": {"kind": "message", "target": {"type": "todo_pool"}},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(SPAWN_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            data["_client_request_id"] = payload["client_request_id"]
        return data, None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except Exception:
            data = {"error": raw or str(exc)}
        data["_client_request_id"] = payload["client_request_id"]
        if exc.code == 409 and data.get("duplicate"):
            data["_duplicate_escalation"] = True
            return data, None
        return data, f"HTTP {exc.code}: {data.get('error') or raw or exc.reason}"
    except Exception as exc:
        return None, str(exc)


CHILD_SESSION_RE = re.compile(r"^child_(?P<parent>.+)_[0-9a-f]{6,}$")


def resolve_reporter_session(reporter, routable_reporters):
    if reporter in routable_reporters:
        return reporter
    match = CHILD_SESSION_RE.match(reporter or "")
    if match:
        parent = match.group("parent")
        if parent in routable_reporters:
            return parent
    return None


def resolve_resolution_escalation_target(reporter, reporter_records, routable_reporters):
    target = resolve_reporter_session(reporter, routable_reporters)
    if target:
        return target
    owner_candidates = []
    for rec in reporter_records:
        owner_candidates.extend(part.strip() for part in str(rec.get("Owner") or "").split(","))
    for owner in owner_candidates:
        target = resolve_reporter_session(owner, routable_reporters)
        if target and target != SELF:
            return target
    return None


def group_due_owner_ack_records(records, limit=FOLLOWUP_BATCH_LIMIT):
    now_ms = int(time.time() * 1000)
    recent_followups = load_recent_followup_keys()
    recent_handoffs = load_recent_handoff_pairs()
    due = [
        rec for rec in records
        if rec["Status"] not in TERMINAL_LIFECYCLES
        and rec["Lifecycle"] == "owner_ack_pending"
        and rec["NextReviewAt"] <= now_ms
        and rec["IssueKey"] not in recent_followups
        and (rec["IssueKey"], rec["Owner"]) not in recent_handoffs
    ]
    due.sort(key=lambda rec: (rec["NextReviewAt"], rec["Owner"], rec["IssueKey"]))
    selected = []
    emitted_keys = set()
    for rec in due:
        if len(selected) >= limit:
            break
        if rec["IssueKey"] in emitted_keys:
            continue
        emitted_keys.add(rec["IssueKey"])
        selected.append(rec)
    by_owner = {}
    for rec in selected:
        by_owner.setdefault(rec["Owner"], []).append(rec)
    return due, by_owner


def group_due_owner_resolution_records(records, limit=RESOLUTION_ESCALATION_BATCH_LIMIT):
    now_ms = int(time.time() * 1000)
    recent_escalations = load_recent_resolution_escalation_pairs()
    recent_escalation_issue_keys = load_recent_resolution_escalation_issue_keys()
    active_decision_issue_keys = load_active_owner_resolution_decision_issue_keys()
    due = [
        rec for rec in records
        if rec["Status"] not in TERMINAL_LIFECYCLES
        and rec["Lifecycle"] in {
            "owner_acknowledged",
            "timed_out_default_unresolved",
            "terminal_without_fix_recheck_evidence",
        }
        and rec["NextReviewAt"] <= now_ms
        and rec["IssueKey"] not in active_decision_issue_keys
        and rec["IssueKey"] not in recent_escalation_issue_keys
        and (rec["IssueKey"], rec["Session"], rec["Owner"]) not in recent_escalations
    ]
    due.sort(key=lambda rec: (rec["NextReviewAt"], rec["Session"], rec["Owner"], rec["IssueKey"]))
    selected = []
    emitted_keys = set()
    for rec in due:
        if len(selected) >= limit:
            break
        if rec["IssueKey"] in emitted_keys:
            continue
        emitted_keys.add(rec["IssueKey"])
        selected.append(rec)
    by_reporter = {}
    for rec in selected:
        by_reporter.setdefault(rec["Session"], []).append(rec)
    return due, by_reporter


def event_has_evidence(event):
    return bool(str((event or {}).get("Evidence") or "").strip())


def has_evidence_backed_fix_recheck(events):
    fix_at = None
    for candidate in sorted(events, key=lambda item: item.get("At") or 0):
        if candidate.get("Event") == "fix_submitted" and event_has_evidence(candidate):
            fix_at = candidate.get("At") or 0
            continue
        if (
            fix_at is not None
            and candidate.get("Event") in {"recheck_passed", "resolved"}
            and event_has_evidence(candidate)
            and (candidate.get("At") or 0) >= fix_at
        ):
            return True
    return False


def is_default_timeout_event(event_name, event):
    if event_name == "deadline_expired":
        return True
    note = str((event or {}).get("Note") or "").lower()
    return (
        event_name in {"closed", "downgraded"}
        and "user decision deadline exceeded" in note
        and "default action=" in note
    )


def resolution_bucket(skill, event_name, event, issue_events, retired_skills):
    if event_name == "recheck_failed":
        return "unresolved"
    if has_evidence_backed_fix_recheck(issue_events) or (
        event_name == "resolved" and event_has_evidence(event)
    ):
        return "real_resolved"
    if skill in retired_skills and event_name in TERMINAL_LIFECYCLES and event_has_evidence(event):
        return "retired_skill_cleanup"
    if is_default_timeout_event(event_name, event):
        return "timed_out_default_unresolved"
    if event_name in TERMINAL_LIFECYCLES:
        return "terminal_without_fix_recheck_evidence"
    return "unresolved"


def build_lifecycle_records(unique_issues, grouped, owners, events_by_issue):
    retired_skills = load_retired_skills()
    records = []
    for issue in unique_issues:
        skill = issue.get("Skill") or ""
        base_owner = owners.get(skill) or ("skill-master" if skill.startswith("skill-master") else issue.get("Session") or "skill-master")
        gkey = group_key(issue)
        key = issue_key(issue)
        issue_events = events_by_issue.get(key, [])
        event_name, event = latest_lifecycle_event(issue_events)
        lifecycle, next_action = EVENT_TO_LIFECYCLE.get(event_name, EVENT_TO_LIFECYCLE["triaged"])
        bucket = resolution_bucket(skill, event_name, event, issue_events, retired_skills)
        if bucket == "real_resolved":
            lifecycle = "resolved"
            next_action = "none"
            status = "resolved"
        elif bucket == "retired_skill_cleanup":
            status = lifecycle
        elif bucket in {"timed_out_default_unresolved", "terminal_without_fix_recheck_evidence"}:
            lifecycle = bucket
            next_action = "owner_fix_or_explicit_decision"
            status = "open"
        else:
            status = lifecycle if lifecycle in TERMINAL_LIFECYCLES else issue.get("Status", "open")
        owner = base_owner
        route_event = None
        for candidate in issue_events:
            if candidate.get("RouteTo"):
                route_event = candidate
        if route_event:
            owner = route_event["RouteTo"]
        last_event_at = event.get("At") if event else issue.get("ReportedAt")
        cadence_days = 0 if event_name == "owner_rejected" else 3
        review_at = None if status in TERMINAL_LIFECYCLES else next_review_at(last_event_at, cadence_days)
        records.append({
            "IssueKey": key,
            "GroupKey": gkey,
            "Skill": skill,
            "Session": issue.get("Session") or "",
            "Severity": issue.get("Severity") or "",
            "Title": issue.get("Title") or "",
            "Status": status,
            "Lifecycle": lifecycle,
            "ResolutionBucket": bucket,
            "Owner": owner,
            "NextAction": next_action,
            "NextReviewAt": review_at,
            "RecheckCadenceDays": cadence_days,
            "DuplicateCount": len(grouped.get(gkey, [])),
            "ReportedAt": issue.get("ReportedAt"),
            "LastLifecycleEvent": event_name,
            "LastLifecycleAt": event.get("At") if event else issue.get("ReportedAt"),
            "LastLifecycleActor": event.get("Actor") if event else "skill-master",
            "LastLifecycleEvidence": event.get("Evidence") if event else str(ISSUES_LOG.relative_to(ROOT)),
            "RejectedOwner": route_event.get("RejectedOwner") if route_event else None,
            "RouteTo": route_event.get("RouteTo") if route_event else None,
        })
    return records


def write_lifecycle_snapshot(records):
    ISSUE_LIFECYCLE.parent.mkdir(parents=True, exist_ok=True)
    tmp = ISSUE_LIFECYCLE.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for rec in sorted(records, key=lambda r: (r["Owner"], r["Skill"], r["Title"], r["Session"])):
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    tmp.replace(ISSUE_LIFECYCLE)


def summarize_lifecycle_records(records):
    by_owner = {}
    by_lifecycle = {}
    for rec in records:
        if rec["Status"] in TERMINAL_LIFECYCLES:
            continue
        by_owner[rec["Owner"]] = by_owner.get(rec["Owner"], 0) + 1
        by_lifecycle[rec["Lifecycle"]] = by_lifecycle.get(rec["Lifecycle"], 0) + 1
    return by_owner, by_lifecycle


def load_latest_backlog_trend_snapshot():
    if not ISSUE_BACKLOG_TREND.exists():
        return None
    latest = None
    with ISSUE_BACKLOG_TREND.open(encoding="utf-8") as f:
        for line in f:
            try:
                latest = json.loads(line)
            except json.JSONDecodeError:
                continue
    return latest


def build_backlog_trend_snapshot(records, by_lifecycle, followup_summary, previous_snapshot=None):
    lifecycles = dict(sorted(by_lifecycle.items()))
    bucket_counts = {
        "real_resolved": 0,
        "retired_skill_cleanup": 0,
        "timed_out_default_unresolved": 0,
        "terminal_without_fix_recheck_evidence": 0,
    }
    for rec in records:
        bucket = rec.get("ResolutionBucket")
        if bucket in bucket_counts:
            bucket_counts[bucket] += 1
    resolved = bucket_counts["real_resolved"] + bucket_counts["retired_skill_cleanup"]
    open_count = len(records) - resolved
    progress_score = 0
    advanced_issue_count = 0
    for rec in records:
        lifecycle = rec["Lifecycle"] if rec["Status"] in TERMINAL_LIFECYCLES else rec["Lifecycle"]
        progress_score += LIFECYCLE_PROGRESS_WEIGHTS.get(lifecycle, 0)
        if LIFECYCLE_PROGRESS_WEIGHTS.get(lifecycle, 0) > 0:
            advanced_issue_count += 1
    snapshot = {
        "At": int(time.time() * 1000),
        "resolution_accounting_version": RESOLUTION_ACCOUNTING_VERSION,
        "open": open_count,
        "resolved": resolved,
        **bucket_counts,
        "lifecycles": lifecycles,
        "lifecycle_progress_score": progress_score,
        "advanced_issue_count": advanced_issue_count,
        "followups_due": followup_summary.get("due_total", 0),
        "followups_emitted": followup_summary.get("emitted", 0),
        "handoff_failed": followup_summary.get("handoff_failed", 0),
        "resolution_escalations_due": followup_summary.get("resolution_escalations_due", 0),
        "resolution_escalations_emitted": followup_summary.get("resolution_escalations_emitted", 0),
        "resolution_escalations_failed": followup_summary.get("resolution_escalations_failed", 0),
        "source_snapshot_present": bool(previous_snapshot),
        "file": str(ISSUE_BACKLOG_TREND.relative_to(ROOT)),
    }
    comparable_previous = bool(
        previous_snapshot
        and previous_snapshot.get("resolution_accounting_version") == RESOLUTION_ACCOUNTING_VERSION
    )
    snapshot["previous_snapshot"] = comparable_previous
    snapshot["accounting_rebaseline"] = bool(previous_snapshot) and not comparable_previous
    if comparable_previous:
        snapshot.update({
            "open_delta": open_count - int(previous_snapshot.get("open", 0)),
            "resolved_delta": resolved - int(previous_snapshot.get("resolved", 0)),
            "lifecycle_progress_score_delta": progress_score - int(previous_snapshot.get("lifecycle_progress_score", 0)),
            "advanced_issue_count_delta": advanced_issue_count - int(previous_snapshot.get("advanced_issue_count", 0)),
            "real_resolved_delta": bucket_counts["real_resolved"] - int(previous_snapshot.get("real_resolved", 0)),
            "retired_skill_cleanup_delta": bucket_counts["retired_skill_cleanup"] - int(previous_snapshot.get("retired_skill_cleanup", 0)),
            "timed_out_default_unresolved_delta": bucket_counts["timed_out_default_unresolved"] - int(previous_snapshot.get("timed_out_default_unresolved", 0)),
            "terminal_without_fix_recheck_evidence_delta": bucket_counts["terminal_without_fix_recheck_evidence"] - int(previous_snapshot.get("terminal_without_fix_recheck_evidence", 0)),
        })
    else:
        snapshot.update({
            "open_delta": None,
            "resolved_delta": None,
            "lifecycle_progress_score_delta": None,
            "advanced_issue_count_delta": None,
            "real_resolved_delta": None,
            "retired_skill_cleanup_delta": None,
            "timed_out_default_unresolved_delta": None,
            "terminal_without_fix_recheck_evidence_delta": None,
        })
    return snapshot


def append_backlog_trend_snapshot(snapshot):
    ISSUE_BACKLOG_TREND.parent.mkdir(parents=True, exist_ok=True)
    with ISSUE_BACKLOG_TREND.open("a", encoding="utf-8") as f:
        f.write(json.dumps(snapshot, ensure_ascii=False, sort_keys=True) + "\n")


def backlog_trend_is_decreasing(snapshot):
    if not snapshot or not snapshot.get("previous_snapshot"):
        return False
    return (
        (snapshot.get("open_delta") is not None and snapshot["open_delta"] < 0)
        or (snapshot.get("resolved_delta") is not None and snapshot["resolved_delta"] > 0)
    )


def backlog_has_active_progress(backlog_trend=None, followup_summary=None, resolution_escalation_summary=None):
    followup_summary = followup_summary or {}
    return (
        backlog_trend_is_decreasing(backlog_trend)
        or followup_summary.get("emitted", 0) > 0
    )


def build_health_gate(records, by_lifecycle, followup_summary, backlog_trend=None, resolution_escalation_summary=None):
    resolution_escalation_summary = resolution_escalation_summary or {}
    open_count = len([rec for rec in records if rec["Status"] not in TERMINAL_LIFECYCLES])
    ack_waiting_count = by_lifecycle.get("owner_acknowledged", 0)
    active_progress = backlog_has_active_progress(backlog_trend, followup_summary, resolution_escalation_summary)
    blockers = []
    if open_count:
        blockers.append(f"open_backlog={open_count}")
    timed_out_default = int((backlog_trend or {}).get("timed_out_default_unresolved", 0))
    if timed_out_default:
        blockers.append(f"timed_out_default_unresolved={timed_out_default}")
    if by_lifecycle.get("owner_ack_pending", 0):
        blockers.append(f"owner_ack_pending={by_lifecycle['owner_ack_pending']}")
    if ack_waiting_count and not active_progress:
        blockers.append(f"owner_ack_without_fix_recheck_or_resolution={ack_waiting_count}")
    if followup_summary.get("due_total", 0):
        blockers.append(f"owner_ack_followups_due={followup_summary['due_total']}")
    if followup_summary.get("handoff_failed", 0):
        blockers.append(f"owner_handoff_failed={followup_summary['handoff_failed']}")
    if resolution_escalation_summary.get("due_total", 0) and not resolution_escalation_summary.get("emitted", 0):
        blockers.append(f"owner_resolution_escalations_due={resolution_escalation_summary['due_total']}")
    if resolution_escalation_summary.get("failed", 0):
        blockers.append(f"owner_resolution_escalation_failed={resolution_escalation_summary['failed']}")
    if resolution_escalation_summary.get("unroutable", 0):
        blockers.append(f"owner_resolution_escalation_unroutable={resolution_escalation_summary['unroutable']}")
    if open_count and not backlog_trend:
        blockers.append("backlog_trend_receipt_missing")
    elif open_count and not backlog_trend.get("previous_snapshot"):
        blockers.append("backlog_trend_baseline_only")
    elif open_count and not active_progress:
        blockers.append("backlog_lifecycle_not_decreasing")

    return {
        "purpose_met": "met" if not blockers else "not_met",
        "mechanism_effective": "healthy" if not blockers else "degraded",
        "requires": (
            "full fanout evidence for discovery claims; owner_ack/fix_submitted/"
            "recheck_passed/resolved transitions for backlog; OWNER_REJECT must reroute via RouteTo"
        ),
        "blockers": blockers,
        "backlog_trend": backlog_trend or {},
    }


def build_owner_ack_followups(records, limit=FOLLOWUP_BATCH_LIMIT):
    """Push overdue owner_ack_pending issues toward their owner."""
    now_ms = int(time.time() * 1000)
    due, by_owner = group_due_owner_ack_records(records, limit=limit)
    out = []
    self_ack_events = []
    external_ack_events = []
    handoff_owners = 0
    handoff_sent = 0
    handoff_failed = 0
    external_ack = 0
    routable_owners = set(parse_sessions()) | {SELF}

    for owner, owner_records in sorted(by_owner.items(), key=lambda kv: (kv[0] != SELF, kv[0])):
        if owner == SELF:
            for rec in owner_records:
                self_ack_events.append({
                    "At": now_ms,
                    "IssueKey": rec["IssueKey"],
                    "GroupKey": rec["GroupKey"],
                    "Skill": rec["Skill"],
                    "Session": rec["Session"],
                    "Title": rec["Title"],
                    "Event": "owner_ack",
                    "Actor": SELF,
                    "Evidence": str(ISSUE_LIFECYCLE.relative_to(ROOT)),
                    "Note": "skill-master owner ACK recorded by evaluation health guided-fix; awaiting fix_submitted/recheck/resolved evidence",
                })
            out.append({
                "At": now_ms,
                "Action": "owner_ack_self_recorded",
                "Owner": SELF,
                "IssueKeys": [rec["IssueKey"] for rec in owner_records],
                "IssueCount": len(owner_records),
                "Evidence": str(ISSUE_LIFECYCLE_EVENTS.relative_to(ROOT)),
                "Note": "self-owned overdue issues moved to owner_ack lifecycle; not resolved",
            })
            continue

        if owner not in routable_owners:
            external_ack += 1
            for rec in owner_records:
                external_ack_events.append({
                    "At": now_ms,
                    "IssueKey": rec["IssueKey"],
                    "GroupKey": rec["GroupKey"],
                    "Skill": rec["Skill"],
                    "Session": rec["Session"],
                    "Title": rec["Title"],
                    "Event": "owner_ack",
                    "Actor": SELF,
                    "Evidence": str(INDEX.relative_to(ROOT)),
                    "Note": f"non-session owner {owner} cannot receive spawn2.0 handoff; skill-master recorded registry/builtin ACK and will track fix/recheck evidence",
                })
            out.append({
                "At": now_ms,
                "Action": "owner_ack_external_recorded",
                "Owner": owner,
                "IssueKeys": [rec["IssueKey"] for rec in owner_records],
                "IssueCount": len(owner_records),
                "Evidence": str(INDEX.relative_to(ROOT)),
                "Note": "owner is not a routable session; skill-master recorded ACK for external/builtin inventory tracking, not resolved",
            })
            continue

        if handoff_owners >= OWNER_HANDOFF_BATCH_LIMIT:
            break
        handoff_owners += 1
        resp, err = spawn_owner_handoff(owner, owner_records)
        duplicate_ok = isinstance(resp, dict) and resp.get("_duplicate_handoff") is True
        ok = err is None and (duplicate_ok or not isinstance(resp, dict) or resp.get("ok", True) is not False)
        if ok:
            handoff_sent += 1
        else:
            handoff_failed += 1
        out.append({
            "At": now_ms,
            "Action": "owner_ack_handoff_sent" if ok else "owner_ack_handoff_failed",
            "Owner": owner,
            "IssueKeys": [rec["IssueKey"] for rec in owner_records],
            "IssueCount": len(owner_records),
            "Lifecycle": "owner_ack_pending",
            "NextAction": "owner_ack",
            "Evidence": str(ISSUE_LIFECYCLE.relative_to(ROOT)),
            "ClientRequestId": (
                resp.get("_client_request_id")
                or resp.get("client_request_id")
                or resp.get("clientRequestId")
                or resp.get("requestId")
                if isinstance(resp, dict) else None
            ),
            "CommId": (
                extract_comm_id(resp)
            ),
            "Duplicate": bool(resp.get("_duplicate_handoff")) if isinstance(resp, dict) else False,
            "SpawnOk": ok,
            "SpawnError": err or (resp.get("error") if isinstance(resp, dict) else None),
            "Note": "owner handoff pushed via spawn2.0; issue remains owner_ack_pending until owner ACK lifecycle evidence exists",
        })
    append_lifecycle_events(self_ack_events + external_ack_events)
    append_followups(out)
    return {
        "due_total": len(due),
        "emitted": len(out),
        "self_ack_events": len(self_ack_events),
        "external_ack_events": len(external_ack_events),
        "external_owner_batches": external_ack,
        "handoff_owner_batches": handoff_owners,
        "handoff_sent": handoff_sent,
        "handoff_failed": handoff_failed,
        "limit": limit,
        "file": str(ISSUE_FOLLOWUPS.relative_to(ROOT)),
    }


def build_owner_resolution_escalations(records, limit=RESOLUTION_ESCALATION_BATCH_LIMIT):
    """Escalate stale issues and persist a deadline ledger only after delivery."""
    now_ms = int(time.time() * 1000)
    due, by_reporter = group_due_owner_resolution_records(records, limit=limit)
    escalation_records = []
    decision_records = []
    sent = 0
    failed = 0
    unroutable = 0
    queued = 0
    routable_reporters = set(parse_sessions()) | {SELF}

    for reporter, reporter_records in sorted(by_reporter.items(), key=lambda kv: (kv[0] != SELF, kv[0])):
        action = "owner_resolution_escalation_sent"
        resp = None
        err = None
        ok = False
        target_reporter = resolve_resolution_escalation_target(reporter, reporter_records, routable_reporters)
        if target_reporter is None:
            action = "owner_resolution_escalation_unroutable"
            unroutable += 1
            err = "reporter session is not routable"
        else:
            resp, err = spawn_owner_resolution_escalation(target_reporter, reporter_records)
            duplicate_ok = isinstance(resp, dict) and resp.get("_duplicate_escalation") is True
            comm_id = extract_comm_id(resp)
            ok = (
                isinstance(resp, dict)
                and bool(comm_id)
                and (
                    duplicate_ok
                    or (err is None and resp.get("ok", True) is not False)
                )
            )
            if ok:
                sent += 1
                for rec in reporter_records:
                    queued += 1
                    decision_records.append({
                        "At": now_ms,
                        "Action": "owner_resolution_decision_queued",
                        "Status": "pending_user_decision",
                        "Decision": None,
                        "IssueKey": rec["IssueKey"],
                        "GroupKey": rec["GroupKey"],
                        "Skill": rec["Skill"],
                        "ReporterSession": reporter,
                        "Owner": rec["Owner"],
                        "Severity": rec["Severity"],
                        "Title": rec["Title"],
                        "Lifecycle": rec["Lifecycle"],
                        "DueAt": now_ms + USER_DECISION_DEADLINE_HOURS * 3600 * 1000,
                        "Evidence": comm_id,
                        "CommId": comm_id,
                        "RecommendedDecision": "continue_owner_evidence",
                        "DecisionReason": "delivered escalation awaits evidence-backed fix/recheck or explicit decision",
                        "Options": ["continue_owner_evidence", "downgrade", "close"],
                        "Actor": SELF,
                    })
            else:
                action = "owner_resolution_escalation_failed"
                failed += 1
                if err is None and duplicate_ok and not comm_id:
                    err = "duplicate response missing existing commId"
                elif err is None and isinstance(resp, dict) and not comm_id:
                    err = "spawn response missing commId"

        escalation_records.append({
            "At": now_ms,
            "Action": action,
            "ReporterSession": reporter,
            "TargetReporterSession": target_reporter,
            "Owner": ",".join(sorted({rec["Owner"] for rec in reporter_records})),
            "IssueKeys": [rec["IssueKey"] for rec in reporter_records],
            "IssueCount": len(reporter_records),
            "Lifecycle": "owner_acknowledged",
            "NextAction": "fix_submitted_or_recheck_or_resolved",
            "Evidence": evidence_path(ISSUE_LIFECYCLE),
            "ClientRequestId": (
                resp.get("_client_request_id")
                or resp.get("client_request_id")
                or resp.get("clientRequestId")
                or resp.get("requestId")
                if isinstance(resp, dict) else None
            ),
            "CommId": extract_comm_id(resp),
            "Duplicate": bool(resp.get("_duplicate_escalation")) if isinstance(resp, dict) else False,
            "SpawnOk": ok,
            "SpawnError": None if ok else (err or (resp.get("error") if isinstance(resp, dict) else None)),
            "Note": "owner ACK exceeded recheck cadence; escalation was attempted and no local terminal transition was fabricated",
        })

    append_owner_resolution_decisions(decision_records)
    append_owner_resolution_escalations(escalation_records)
    if decision_records:
        write_owner_resolution_decision_table()
    return {
        "due_total": len(due),
        "emitted": len(escalation_records),
        "sent": sent,
        "failed": failed,
        "unroutable": unroutable,
        "queued": queued,
        "auto_decided": 0,
        "limit": limit,
        "file": evidence_path(OWNER_RESOLUTION_ESCALATIONS),
        "decision_file": evidence_path(OWNER_RESOLUTION_DECISIONS),
        "decision_table": evidence_path(OWNER_RESOLUTION_DECISION_TABLE),
    }


def rebuild_issue_lifecycle():
    """Write current issue state derived from append-only lifecycle events."""
    owners = load_index_owners()
    issues = load_all_issues()
    issues_by_key = {}
    for issue in issues:
        key = issue_key(issue)
        existing = issues_by_key.get(key)
        if existing is None or (issue.get("ReportedAt") or 0) >= (existing.get("ReportedAt") or 0):
            issues_by_key[key] = issue
    unique_issues = list(issues_by_key.values())
    events_by_issue = load_lifecycle_events()
    grouped = {}
    for issue in issues:
        grouped.setdefault(group_key(issue), []).append(issue)

    now = datetime.now(timezone.utc)
    known_event_keys = set(events_by_issue)
    scheduled_triage_keys = set()
    new_triage_events = []
    for issue in unique_issues:
        key = issue_key(issue)
        if key in known_event_keys or key in scheduled_triage_keys:
            continue
        scheduled_triage_keys.add(key)
        new_triage_events.append({
            "At": issue.get("ReportedAt") or int(now.timestamp() * 1000),
            "IssueKey": key,
            "GroupKey": group_key(issue),
            "Skill": issue.get("Skill") or "",
            "Session": issue.get("Session") or "",
            "Title": issue.get("Title") or "",
            "Event": "triaged",
            "Actor": "skill-master",
            "Evidence": str(ISSUES_LOG.relative_to(ROOT)),
            "Note": "auto triaged from metrics/issues.jsonl",
        })
    append_lifecycle_events(new_triage_events)
    if new_triage_events:
        events_by_issue = load_lifecycle_events()
    default_decision_events = append_default_user_decision_events(unique_issues, events_by_issue)
    if default_decision_events:
        events_by_issue = load_lifecycle_events()

    records = build_lifecycle_records(unique_issues, grouped, owners, events_by_issue)
    write_lifecycle_snapshot(records)
    _, pre_followup_lifecycle = summarize_lifecycle_records(records)
    previous_backlog_trend = load_latest_backlog_trend_snapshot()
    if previous_backlog_trend is None:
        previous_backlog_trend = build_backlog_trend_snapshot(
            records,
            pre_followup_lifecycle,
            {"due_total": 0, "emitted": 0, "handoff_failed": 0},
            None,
        )
        previous_backlog_trend["baseline_source"] = "current_run_before_followups"
    followup_summary = build_owner_ack_followups(records)
    resolution_escalation_summary = build_owner_resolution_escalations(records)
    if followup_summary.get("self_ack_events", 0):
        events_by_issue = load_lifecycle_events()
        records = build_lifecycle_records(unique_issues, grouped, owners, events_by_issue)
        write_lifecycle_snapshot(records)
    by_owner, by_lifecycle = summarize_lifecycle_records(records)
    trend_followup_summary = dict(followup_summary)
    trend_followup_summary["resolution_escalations_due"] = resolution_escalation_summary.get("due_total", 0)
    trend_followup_summary["resolution_escalations_emitted"] = resolution_escalation_summary.get("emitted", 0)
    trend_followup_summary["resolution_escalations_failed"] = resolution_escalation_summary.get("failed", 0)
    backlog_trend = build_backlog_trend_snapshot(records, by_lifecycle, trend_followup_summary, previous_backlog_trend)
    append_backlog_trend_snapshot(backlog_trend)
    health_gate = build_health_gate(records, by_lifecycle, followup_summary, backlog_trend, resolution_escalation_summary)
    return {
        "open": len([rec for rec in records if rec["Status"] not in TERMINAL_LIFECYCLES]),
        "resolved": len([rec for rec in records if rec["Status"] in TERMINAL_LIFECYCLES]),
        "groups": len(grouped),
        "owners": by_owner,
        "lifecycles": by_lifecycle,
        "new_triage_events": len(new_triage_events),
        "default_decision_events": default_decision_events,
        "events_file": str(ISSUE_LIFECYCLE_EVENTS.relative_to(ROOT)),
        "followups": followup_summary,
        "resolution_escalations": resolution_escalation_summary,
        "backlog_trend": backlog_trend,
        "health_gate": health_gate,
    }


def sync_issue_lifecycle(lifecycle_summary):
    """Sync current issue state to Feishu SkillIssues through the owner queue."""
    issue_by_key = {issue_key(issue): issue for issue in load_all_issues()}
    rows = []
    if ISSUE_LIFECYCLE.exists():
        with ISSUE_LIFECYCLE.open(encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                key = rec.get("IssueKey")
                source = issue_by_key.get(key, {})
                row = {
                    "IssueKey": key,
                    "Skill": rec.get("Skill") or "",
                    "Session": rec.get("Session") or "",
                    "Severity": rec.get("Severity") or "",
                    "Title": rec.get("Title") or "",
                    "Description": source.get("Description") or "",
                    "Status": rec.get("Status") or "open",
                    "ReportedAt": rec.get("ReportedAt"),
                }
                if row["IssueKey"]:
                    rows.append(row)
    if not rows:
        return {"ok": True, "asset_id": ISSUES_ASSET, "rows": 0, "skipped": "no lifecycle rows"}
    total_rows = len(rows)
    rows = rows[:ISSUE_SYNC_BATCH_LIMIT]
    try:
        receipt = enqueue_bitable_rows(
            ISSUES_ASSET,
            rows,
            key_suffix="evaluate-skills-issue-lifecycle",
            wait_for_readback_seconds=30,
        )
        receipt["total_lifecycle_rows"] = total_rows
        receipt["batch_limit"] = ISSUE_SYNC_BATCH_LIMIT
        return receipt
    except Exception as exc:
        return {
            "ok": False,
            "asset_id": ISSUES_ASSET,
            "rows": len(rows),
            "total_lifecycle_rows": total_rows,
            "batch_limit": ISSUE_SYNC_BATCH_LIMIT,
            "read_back_verified": False,
            "skipped": "issue-sync-failed",
            "error": str(exc),
        }


def write_review(agg, session_results, issues, lifecycle_summary, fanout_meta=None, sync_receipts=None):
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    path = REVIEWS_DIR / f"{today}.md"
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [f"# Skill usage review — {now_iso}", ""]

    lines.append("## Call counts")
    lines.append("")
    lines.append("| Skill | Calls (3d) | Calls (total) | Last called | Top sessions |")
    lines.append("|---|---:|---:|---|---|")
    rows = sorted(agg.items(), key=lambda kv: (kv[1]["window"], kv[1]["total"]), reverse=True)
    for skill, a in rows:
        last = a["last"].isoformat(timespec="seconds") if a["last"] else "—"
        lines.append(f"| {skill} | {a['window']} | {a['total']} | {last} | {top_sessions_str(a['sessions'])} |")
    if not rows:
        lines.append("| _(no ticks recorded)_ |  |  |  |  |")

    if fanout_meta:
        lines.append("")
        lines.append("## Fanout gate")
        lines.append("")
        lines.append(f"- Selected: {len(session_results)} / {fanout_meta['candidate_count']}")
        lines.append("- Coverage boundary: sampled run only; `Issues collected` applies only to the selected sessions, not all sessions.")
        lines.append(f"- Budget: {fanout_meta['budget']}")
        lines.append(f"- Cycle days: {fanout_meta['cycle_days']}")
        lines.append(f"- Cursor: {fanout_meta['cursor_before']} -> {fanout_meta['cursor_after']}")
        lines.append(f"- Recent priority: {', '.join(fanout_meta['recent_priority']) or '—'}")
    elif session_results:
        lines.append("")
        lines.append("## Fanout gate")
        lines.append("")
        lines.append("- Coverage boundary: manual/full-sweep run; see session result count for actual attempted coverage.")
    else:
        lines.append("")
        lines.append("## Fanout gate")
        lines.append("")
        lines.append("- Coverage boundary: fanout skipped; `Issues collected` is only newly parsed fanout feedback from this run, not a statement that sessions have no issues.")

    if sync_receipts:
        lines.append("")
        lines.append("## Feishu sync evidence")
        lines.append("")
        lines.append("| Asset | Rows | Job | Readback | Dedupe key | Receipt proof |")
        lines.append("|---|---:|---|---|---|---|")
        for receipt in sync_receipts:
            proof = "—"
            remote = receipt.get("wendangwang_receipts") or []
            if remote:
                proof = remote[-1].get("path", "remote receipt")
            lines.append(
                f"| {receipt.get('asset_id')} | {receipt.get('rows', 0)} | {receipt.get('job_id') or '—'} | "
                f"{receipt.get('read_back_verified')} | `{receipt.get('dedupe_key') or receipt.get('skipped') or '—'}` | {proof} |"
            )
            if receipt.get("error"):
                lines.append(f"| {receipt.get('asset_id')} error | 0 | — | False | `{receipt.get('skipped')}` | {receipt.get('error')} |")

    lines.append("")
    lines.append(f"## Sessions polled ({len(session_results)})")
    lines.append("")
    for s, status, n_issues in session_results:
        lines.append(f"- {status} **{s}** — {n_issues} issue(s)")

    lines.append("")
    lines.append(f"## Issues collected ({len(issues)})")
    lines.append("")
    if issues:
        lines.append("| Skill | Session | Severity | Title |")
        lines.append("|---|---|---|---|")
        for i in issues:
            lines.append(f"| {i['Skill']} | {i['Session']} | {i['Severity']} | {i['Title']} |")
    else:
        lines.append("_(none reported)_")

    lines.append("")
    lines.append("## Open issue lifecycle")
    lines.append("")
    lines.append(f"- Open issues not resolved: {lifecycle_summary['open']}")
    lines.append(f"- Resolved issues with lifecycle evidence: {lifecycle_summary['resolved']}")
    lines.append(f"- Issue groups: {lifecycle_summary['groups']}")
    lines.append("- Lifecycle file: `metrics/issue-lifecycle.jsonl`")
    lines.append(f"- Lifecycle event log: `{lifecycle_summary['events_file']}`")
    lines.append(f"- New triage events appended this run: {lifecycle_summary['new_triage_events']}")
    lines.append(f"- Default user-decision events appended this run: {lifecycle_summary.get('default_decision_events', 0)}")
    lines.append("- Resolution rule: backlog decreases only for an evidence-backed `resolved` event, an evidence-backed `fix_submitted` -> `recheck_passed|resolved` sequence, or an evidence-backed RETIRED-TOMBSTONE cleanup.")
    trend = lifecycle_summary.get("backlog_trend") or {}
    lines.append(f"- Backlog trend receipt: `{trend.get('file', str(ISSUE_BACKLOG_TREND.relative_to(ROOT)))}`")
    lines.append(
        "- Backlog trend delta: "
        f"open_delta={trend.get('open_delta')}; "
        f"resolved_delta={trend.get('resolved_delta')}; "
        f"lifecycle_progress_score_delta={trend.get('lifecycle_progress_score_delta')}; "
        f"advanced_issue_count_delta={trend.get('advanced_issue_count_delta')}"
    )
    lines.append(
        "- Resolution buckets: "
        f"real_resolved={trend.get('real_resolved', 0)}; "
        f"retired_skill_cleanup={trend.get('retired_skill_cleanup', 0)}; "
        f"timed_out_default_unresolved={trend.get('timed_out_default_unresolved', 0)}; "
        f"terminal_without_fix_recheck_evidence={trend.get('terminal_without_fix_recheck_evidence', 0)}"
    )
    health_gate = lifecycle_summary.get("health_gate") or {}
    lines.append(
        "- Evaluation health gate: "
        f"purpose_met={health_gate.get('purpose_met', 'unknown')}; "
        f"mechanism_effective={health_gate.get('mechanism_effective', 'unknown')}; "
        f"requires={health_gate.get('requires', 'unknown')}"
    )
    blockers = health_gate.get("blockers") or []
    lines.append(f"- Evaluation health blockers: {', '.join(blockers) if blockers else 'none'}")
    followups = lifecycle_summary.get("followups") or {}
    lines.append(f"- Owner ACK follow-up file: `{followups.get('file', str(ISSUE_FOLLOWUPS.relative_to(ROOT)))}`")
    lines.append(f"- Owner ACK follow-ups due/emitted: {followups.get('due_total', 0)} / {followups.get('emitted', 0)}")
    escalations = lifecycle_summary.get("resolution_escalations") or {}
    lines.append(f"- Owner resolution escalation file: `{escalations.get('file', str(OWNER_RESOLUTION_ESCALATIONS.relative_to(ROOT)))}`")
    lines.append(f"- Owner resolution escalations due/emitted/sent/failed: {escalations.get('due_total', 0)} / {escalations.get('emitted', 0)} / {escalations.get('sent', 0)} / {escalations.get('failed', 0)}")
    lines.append(f"- Owner resolution decision queue: `{escalations.get('decision_table', str(OWNER_RESOLUTION_DECISION_TABLE.relative_to(ROOT)))}`")
    lines.append(f"- Owner resolution decisions queued/auto-decided: {escalations.get('queued', 0)} / {escalations.get('auto_decided', 0)}")
    lines.append(f"- Self-owner ACK events recorded: {followups.get('self_ack_events', 0)}")
    lines.append(f"- External/builtin owner ACK events recorded: {followups.get('external_ack_events', 0)}")
    lines.append(
        "- Owner handoff batches sent/failed: "
        f"{followups.get('handoff_sent', 0)} / {followups.get('handoff_failed', 0)}"
    )
    if lifecycle_summary["lifecycles"]:
        lines.append("")
        lines.append("| Lifecycle | Issues |")
        lines.append("|---|---:|")
        for lifecycle, count in sorted(lifecycle_summary["lifecycles"].items(), key=lambda kv: kv[0]):
            lines.append(f"| {lifecycle} | {count} |")
    if lifecycle_summary["owners"]:
        lines.append("")
        lines.append("| Owner | Open issues |")
        lines.append("|---|---:|")
        for owner, count in sorted(lifecycle_summary["owners"].items(), key=lambda kv: kv[1], reverse=True):
            lines.append(f"| {owner} | {count} |")

    path.write_text("\n".join(lines) + "\n")
    return path


def fanout(sessions, backends, timeout_s=SPAWN_TIMEOUT_S, parallel=FANOUT_PARALLEL):
    results = []
    all_issues = []
    if not sessions:
        return results, all_issues
    today = datetime.now(timezone.utc).date().isoformat()
    with ThreadPoolExecutor(max_workers=parallel) as ex:
        futures = {}
        for s in sessions:
            backend = backends.get(s)
            if not backend:
                print(f"  ✗ {s}: backend missing in session-catalog.json", file=sys.stderr, flush=True)
                results.append((s, "✗", 0))
                continue
            futures[ex.submit(spawn, s, QUESTION_PROMPT, backend, today, timeout_s)] = s
        for fut in as_completed(futures):
            s = futures[fut]
            reply, err = fut.result()
            if err:
                print(f"  ✗ {s}: {err}", file=sys.stderr, flush=True)
                results.append((s, "✗", 0))
                continue
            issues = parse_issues(s, reply)
            print(f"  ✓ {s}: {len(issues)} issue(s)", flush=True)
            results.append((s, "✓", len(issues)))
            all_issues.extend(issues)
    return results, all_issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fanout", action="store_true", help="skip the session polling step")
    ap.add_argument("--sessions", type=str, default=None, help="comma-separated session list override")
    ap.add_argument("--all-sessions", action="store_true", help="bypass rolling gate and poll every eligible session")
    ap.add_argument("--spawn-timeout", type=int, default=SPAWN_TIMEOUT_S, help="per-session spawn timeout in seconds")
    ap.add_argument("--fanout-parallel", type=int, default=FANOUT_PARALLEL, help="fanout worker count")
    ap.add_argument("--fanout-budget", type=int, default=FANOUT_BUDGET, help="max sessions to poll per gated run")
    ap.add_argument("--fanout-cycle-days", type=int, default=FANOUT_CYCLE_DAYS, help="days before a session is due again")
    ap.add_argument("--lifecycle-event", choices=sorted(LIFECYCLE_EVENTS - {"triaged"}), default=None, help="append an owner/fix/recheck lifecycle event and exit")
    ap.add_argument("--issue-key", default=None, help="issue key for --lifecycle-event")
    ap.add_argument("--actor", default=None, help="actor/session for --lifecycle-event")
    ap.add_argument(
        "--evidence",
        default=None,
        help=(
            "evidence path/ref for --lifecycle-event; recheck_passed/resolved require "
            "pytest:path.py::test_name or command:argv"
        ),
    )
    ap.add_argument("--note", default="", help="optional note for --lifecycle-event")
    ap.add_argument("--route-to", default=None, help="new owner for --lifecycle-event owner_rejected")
    args = ap.parse_args()

    if args.lifecycle_event:
        record_lifecycle_event(args.issue_key, args.lifecycle_event, args.actor, args.evidence, args.note, args.route_to)
        lifecycle_summary = rebuild_issue_lifecycle()
        print(
            f"recorded lifecycle event {args.lifecycle_event} for {args.issue_key}; "
            f"open={lifecycle_summary['open']} resolved={lifecycle_summary['resolved']}",
            flush=True,
        )
        return

    agg = aggregate_calls()
    print(f"[1/3] aggregated {len(agg)} skills across {sum(a['total'] for a in agg.values())} calls", flush=True)

    counts_receipt = push_call_counts(agg)
    drained = counts_receipt.get("drained", {})
    print(
        "[2/3] CallCounts sync: "
        f"enqueued_rows={counts_receipt.get('rows', 0)} "
        f"job_id={counts_receipt.get('job_id')} duplicate={counts_receipt.get('duplicate')} "
        f"drained_done={drained.get('done', 0)} drained_failed={drained.get('failed', 0)} "
        f"read_back_verified={counts_receipt.get('read_back_verified')} "
        f"rows={counts_receipt.get('rows_path')} receipt={counts_receipt.get('receipt_path')}",
        flush=True,
    )

    session_results = []
    all_issues = []
    fanout_meta = None
    if not args.no_fanout:
        gate_state = None
        if args.sessions:
            sessions = [s.strip() for s in args.sessions.split(",") if s.strip()]
            print(f"[3/3] fanout manual session override: {len(sessions)} session(s)", flush=True)
        elif args.all_sessions:
            sessions = parse_sessions()
            print(f"[3/3] fanout full sweep requested: {len(sessions)} session(s)", flush=True)
        else:
            candidates = parse_sessions()
            gate_state = load_fanout_state()
            sessions, fanout_meta = select_due_sessions(
                candidates,
                gate_state,
                budget=args.fanout_budget,
                cycle_days=args.fanout_cycle_days,
            )
            gate_state["cursor"] = fanout_meta["cursor_after"]
            print(
                "[3/3] fanout gate: "
                f"selected={len(sessions)}/{fanout_meta['candidate_count']} "
                f"budget={fanout_meta['budget']} cycle_days={fanout_meta['cycle_days']} "
                f"cursor={fanout_meta['cursor_before']}->{fanout_meta['cursor_after']} "
                f"recent={','.join(fanout_meta['recent_priority']) or '-'}",
                flush=True,
            )
        backends = load_backends()
        print(
            f"[3/3] fanout to {len(sessions)} sessions "
            f"(parallel={args.fanout_parallel}, timeout={args.spawn_timeout}s)",
            flush=True,
        )
        session_results, all_issues = fanout(sessions, backends, args.spawn_timeout, args.fanout_parallel)
        if gate_state is not None:
            mark_polled(gate_state, sessions, session_results)
            save_fanout_state(gate_state)
            print(f"  fanout gate state saved: {FANOUT_STATE}", flush=True)
        n_pushed = push_issues(all_issues)
        print(f"  pushed {n_pushed}/{len(all_issues)} issues to Feishu", flush=True)
    else:
        print("[3/3] fanout skipped", flush=True)

    lifecycle_summary = rebuild_issue_lifecycle()
    print(
        "issue lifecycle: "
        f"open={lifecycle_summary['open']} groups={lifecycle_summary['groups']} "
        f"owners={len(lifecycle_summary['owners'])} "
        f"followups={lifecycle_summary.get('followups', {}).get('emitted', 0)}",
        flush=True,
    )
    issues_receipt = sync_issue_lifecycle(lifecycle_summary)

    path = write_review(
        agg,
        session_results,
        all_issues,
        lifecycle_summary,
        fanout_meta=fanout_meta,
        sync_receipts=[counts_receipt, issues_receipt],
    )
    print(f"review: {path}", flush=True)

    LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
    LAST_RUN.write_text(datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n")


if __name__ == "__main__":
    main()
