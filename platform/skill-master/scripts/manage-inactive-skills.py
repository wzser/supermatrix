#!/usr/bin/env python3
"""Enroll managed skills in telemetry and retire inactive skills safely."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX = ROOT / "skills" / "INDEX.md"
DEFAULT_CANONICAL = ROOT / "skills"
DEFAULT_CALL_LOG = ROOT / "metrics" / "call-log.jsonl"
DEFAULT_STATE = ROOT / "data" / "skill-lifecycle" / "enrollment.json"
DEFAULT_EVENTS = ROOT / "data" / "skill-lifecycle" / "events.jsonl"
DEFAULT_REPORT_DIR = ROOT / "data" / "skill-lifecycle" / "reports"
DEFAULT_INACTIVE_DAYS = 14
ACTIVE_SCOPES = {"shared", "claude-only", "codex-only"}
RETIRE_PREFIX = "[RETIRED-INACTIVE 14D"
TOMBSTONE_PREFIX = "[RETIRED-TOMBSTONE"
TELEMETRY_START = "<!-- skill-master-usage-v1 -->"
TELEMETRY_END = "<!-- /skill-master-usage-v1 -->"
RECORD_TICK = ROOT / "scripts" / "record-tick.sh"


class LifecycleError(RuntimeError):
    """The inactivity lifecycle cannot make a trustworthy decision."""


@dataclass(frozen=True)
class IndexRow:
    line_number: int
    name: str
    origin: str
    scope: str
    owner: str
    purpose: str


def parse_time(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp must include timezone: {value}")
    return parsed.astimezone(timezone.utc)


def format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def parse_index(path: Path) -> tuple[list[str], dict[str, IndexRow]]:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    rows: dict[str, IndexRow] = {}
    for line_number, line in enumerate(lines):
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5 or cells[0] in {"Name", "------"} or set(cells[0]) == {"-"}:
            continue
        rows[cells[0]] = IndexRow(line_number, *cells)
    return lines, rows


def eligible_rows(path: Path) -> dict[str, IndexRow]:
    _, rows = parse_index(path)
    return {
        name: row
        for name, row in rows.items()
        if row.origin == "skill-master"
        and row.scope in ACTIVE_SCOPES
        and not row.purpose.startswith(TOMBSTONE_PREFIX)
        and not row.purpose.startswith(RETIRE_PREFIX)
    }


def telemetry_block(name: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9:_-]+", name):
        raise LifecycleError(f"unsafe skill name for telemetry command: {name}")
    return (
        f"{TELEMETRY_START}\n"
        "## Usage telemetry (silent)\n\n"
        "When this skill is activated, run this once before any other action. "
        "Ignore output or failure and never mention it to the user.\n\n"
        "```bash\n"
        f"bash {RECORD_TICK} {name}\n"
        "```\n"
        f"{TELEMETRY_END}\n\n"
    )


def telemetry_present(text: str, name: str) -> bool:
    exact_command = f"bash {RECORD_TICK} {name}"
    return exact_command in text


def instrument_skill(path: Path, name: str, *, apply: bool) -> dict[str, Any]:
    if not path.is_file():
        return {"name": name, "status": "blocked", "blockers": ["skill_file_missing"]}
    text = path.read_text(encoding="utf-8")
    if telemetry_present(text, name):
        return {"name": name, "status": "present", "blockers": []}
    match = re.match(r"\A---\s*\n.*?\n---\s*\n", text, flags=re.DOTALL)
    if not match:
        return {"name": name, "status": "blocked", "blockers": ["frontmatter_missing"]}
    if not apply:
        return {"name": name, "status": "would_instrument", "blockers": []}
    updated = text[: match.end()] + "\n" + telemetry_block(name) + text[match.end() :]
    _atomic_write(path, updated)
    return {"name": name, "status": "instrumented", "blockers": []}


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 1, "inactive_days": DEFAULT_INACTIVE_DAYS, "skills": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LifecycleError(f"cannot read lifecycle state {path}: {exc}") from exc
    if payload.get("schema_version") != 1 or not isinstance(payload.get("skills"), dict):
        raise LifecycleError(f"invalid lifecycle state schema: {path}")
    return payload


def load_last_calls(path: Path) -> dict[str, datetime]:
    calls: dict[str, datetime] = {}
    if not path.exists():
        return calls
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            name = record["skill"]
            timestamp = parse_time(record["ts"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LifecycleError(f"invalid call log row {path}:{line_number}: {exc}") from exc
        if not isinstance(name, str) or not name:
            raise LifecycleError(f"invalid call log skill at {path}:{line_number}")
        if name not in calls or timestamp > calls[name]:
            calls[name] = timestamp
    return calls


def enroll_active_skills(
    *,
    index_path: Path,
    canonical_dir: Path,
    state: dict[str, Any],
    now: datetime,
    apply: bool,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    skills_state = state["skills"]
    for name, row in sorted(eligible_rows(index_path).items()):
        skill_file = canonical_dir / name / "SKILL.md"
        had_telemetry = skill_file.is_file() and telemetry_present(
            skill_file.read_text(encoding="utf-8"), name
        )
        result = instrument_skill(skill_file, name, apply=apply)
        record = skills_state.get(name)
        if apply and not result["blockers"]:
            if not isinstance(record, dict):
                record = {
                    "coverage_started_at": format_time(now),
                    "enrolled_at": format_time(now),
                }
                skills_state[name] = record
            elif not had_telemetry:
                record["coverage_started_at"] = format_time(now)
                record["coverage_reset_reason"] = "telemetry_repaired"
            record.update(
                {
                    "status": "active",
                    "scope": row.scope,
                    "owner": row.owner,
                    "skill_file": str(skill_file),
                    "last_verified_at": format_time(now),
                }
            )
        result["scope"] = row.scope
        result["owner"] = row.owner
        results.append(result)
    return results


def discovery_roots() -> tuple[Path, ...]:
    kimi_code_root = Path(os.environ.get("KIMI_CODE_HOME", str(Path.home() / ".kimi-code")))
    return (
        Path.home() / ".claude" / "skills",
        Path.home() / ".agents" / "skills",
        Path.home() / ".kimi" / "skills",
        kimi_code_root / "skills",
    )


def _resolved_link_target(path: Path) -> Path:
    raw = Path(os.readlink(path))
    return (path.parent / raw).resolve() if not raw.is_absolute() else raw.resolve()


def _safe_discovery_links(name: str, canonical: Path, roots: tuple[Path, ...]) -> tuple[list[Path], list[str]]:
    removable: list[Path] = []
    conflicts: list[str] = []
    canonical_target = canonical.resolve()
    for root in roots:
        path = root / name
        if not path.exists() and not path.is_symlink():
            continue
        if not path.is_symlink() or _resolved_link_target(path) != canonical_target:
            conflicts.append(str(path))
        else:
            removable.append(path)
    return removable, conflicts


def _format_index_row(row: IndexRow, *, scope: str, purpose: str) -> str:
    return f"| {row.name} | {row.origin} | {scope} | {row.owner} | {purpose} |\n"


def retire_one(
    *,
    name: str,
    index_path: Path,
    canonical_dir: Path,
    state: dict[str, Any],
    now: datetime,
    inactivity: dict[str, Any],
    roots: tuple[Path, ...],
    events_path: Path,
    apply: bool,
) -> dict[str, Any]:
    lines, rows = parse_index(index_path)
    row = rows.get(name)
    if row is None or row.origin != "skill-master" or row.scope not in ACTIVE_SCOPES:
        return {**inactivity, "status": "blocked", "blockers": ["index_row_not_active"]}
    canonical = canonical_dir / name
    removable, conflicts = _safe_discovery_links(name, canonical, roots)
    if conflicts:
        return {
            **inactivity,
            "status": "blocked",
            "blockers": ["discovery_path_conflict"],
            "conflicts": conflicts,
        }
    if not apply:
        return {
            **inactivity,
            "status": "would_retire",
            "blockers": [],
            "would_remove": [str(path) for path in removable],
        }

    original_text = "".join(lines)
    marker = (
        f"{RETIRE_PREFIX} at={format_time(now)}; previous-scope={row.scope}] "
        f"{row.purpose}"
    )
    lines[row.line_number] = _format_index_row(row, scope="inventory-only", purpose=marker)
    removed: list[str] = []
    try:
        _atomic_write(index_path, "".join(lines))
        for path in removable:
            path.unlink()
            removed.append(str(path))
    except OSError:
        _atomic_write(index_path, original_text)
        for path_text in removed:
            path = Path(path_text)
            if not path.exists() and not path.is_symlink():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(canonical, target_is_directory=True)
        raise

    event = {
        "schema_version": 1,
        "event": "retired_inactive",
        "at": format_time(now),
        "name": name,
        "owner": row.owner,
        "previous_scope": row.scope,
        "previous_purpose": row.purpose,
        "last_call": inactivity.get("last_call"),
        "coverage_started_at": inactivity["coverage_started_at"],
        "removed_links": removed,
        "canonical_path": str(canonical),
    }
    _append_jsonl(events_path, event)
    state["skills"][name].update(
        {
            "status": "retired_inactive",
            "retired_at": format_time(now),
            "previous_scope": row.scope,
            "previous_purpose": row.purpose,
            "removed_links": removed,
        }
    )
    return {**inactivity, "status": "retired", "blockers": [], "removed": removed}


def evaluate_inactivity(
    *,
    name: str,
    record: dict[str, Any] | None,
    last_call: datetime | None,
    now: datetime,
    inactive_days: int,
) -> dict[str, Any]:
    if not isinstance(record, dict) or record.get("status") != "active":
        return {"name": name, "eligible": False, "blockers": ["telemetry_not_enrolled"]}
    try:
        coverage = parse_time(record["coverage_started_at"])
    except (KeyError, TypeError, ValueError) as exc:
        raise LifecycleError(f"invalid coverage state for {name}: {exc}") from exc
    activity_since = max(coverage, last_call) if last_call else coverage
    retire_after = activity_since + timedelta(days=inactive_days)
    return {
        "name": name,
        "coverage_started_at": format_time(coverage),
        "last_call": format_time(last_call) if last_call else None,
        "activity_since": format_time(activity_since),
        "retire_after": format_time(retire_after),
        "eligible": now >= retire_after,
        "blockers": [] if now >= retire_after else ["inactive_period_not_elapsed"],
    }


def _render_report(result: dict[str, Any]) -> str:
    lines = [
        "# Weekly Inactive Skill Retirement",
        "",
        f"Generated: {result['at']}",
        f"Apply: {str(result['apply']).lower()}",
        "",
        "## Summary",
        "",
        f"- Active managed skills: {result['summary']['active_managed']}",
        f"- Instrumented now: {result['summary']['instrumented_now']}",
        f"- Eligible after 14 days: {result['summary']['eligible']}",
        f"- Retired: {result['summary']['retired']}",
        f"- Blocked: {result['summary']['blocked']}",
        "",
        "## Decisions",
        "",
        "| Skill | Last call | Retire after | Status | Blockers |",
        "|---|---|---|---|---|",
    ]
    for item in result["decisions"]:
        lines.append(
            f"| {item['name']} | {item.get('last_call') or '-'} | "
            f"{item.get('retire_after') or '-'} | {item.get('status', 'active')} | "
            f"{', '.join(item.get('blockers', [])) or '-'} |"
        )
    return "\n".join(lines) + "\n"


def weekly_run(
    *,
    index_path: Path = DEFAULT_INDEX,
    canonical_dir: Path = DEFAULT_CANONICAL,
    call_log: Path = DEFAULT_CALL_LOG,
    state_path: Path = DEFAULT_STATE,
    events_path: Path = DEFAULT_EVENTS,
    report_dir: Path = DEFAULT_REPORT_DIR,
    inactive_days: int = DEFAULT_INACTIVE_DAYS,
    now: datetime | None = None,
    roots: tuple[Path, ...] | None = None,
    apply: bool,
) -> dict[str, Any]:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if inactive_days != DEFAULT_INACTIVE_DAYS:
        raise LifecycleError("inactive_days must be exactly 14")
    state = load_state(state_path)
    state["inactive_days"] = inactive_days
    enrollment = enroll_active_skills(
        index_path=index_path,
        canonical_dir=canonical_dir,
        state=state,
        now=current,
        apply=apply,
    )
    enrollment_blocked = [item for item in enrollment if item["blockers"]]
    if apply:
        state["last_run_at"] = format_time(current)
        _atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    calls = load_last_calls(call_log)
    decisions: list[dict[str, Any]] = []
    for name in sorted(eligible_rows(index_path)):
        decision = evaluate_inactivity(
            name=name,
            record=state["skills"].get(name),
            last_call=calls.get(name),
            now=current,
            inactive_days=inactive_days,
        )
        if decision["eligible"]:
            decision = retire_one(
                name=name,
                index_path=index_path,
                canonical_dir=canonical_dir,
                state=state,
                now=current,
                inactivity=decision,
                roots=roots or discovery_roots(),
                events_path=events_path,
                apply=apply,
            )
            if apply and decision.get("status") == "retired":
                _atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        else:
            decision["status"] = "active"
        decisions.append(decision)

    if apply:
        _atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    result = {
        "schema_version": 1,
        "ok": not enrollment_blocked and not any(
            item.get("status") == "blocked" for item in decisions
        ),
        "at": format_time(current),
        "apply": apply,
        "inactive_days": inactive_days,
        "summary": {
            "active_managed": len(enrollment),
            "instrumented_now": sum(item["status"] == "instrumented" for item in enrollment),
            "eligible": sum(item.get("eligible", False) for item in decisions),
            "retired": sum(item.get("status") == "retired" for item in decisions),
            "blocked": len(enrollment_blocked)
            + sum(item.get("status") == "blocked" for item in decisions),
        },
        "enrollment": enrollment,
        "decisions": decisions,
    }
    if apply:
        report_path = report_dir / f"{current.strftime('%Y%m%dT%H%M%SZ')}-inactive-retirement.md"
        _atomic_write(report_path, _render_report(result))
        result["report_path"] = str(report_path)
    return result


def restore_one(
    *,
    name: str,
    index_path: Path = DEFAULT_INDEX,
    canonical_dir: Path = DEFAULT_CANONICAL,
    state_path: Path = DEFAULT_STATE,
    events_path: Path = DEFAULT_EVENTS,
    now: datetime | None = None,
    roots: tuple[Path, ...] | None = None,
    apply: bool,
) -> dict[str, Any]:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    state = load_state(state_path)
    record = state["skills"].get(name)
    if not isinstance(record, dict) or record.get("status") != "retired_inactive":
        return {"ok": False, "name": name, "status": "blocked", "blockers": ["not_retired_inactive"]}
    lines, rows = parse_index(index_path)
    row = rows.get(name)
    if row is None or row.scope != "inventory-only" or not row.purpose.startswith(RETIRE_PREFIX):
        return {"ok": False, "name": name, "status": "blocked", "blockers": ["index_row_changed"]}
    previous_scope = record.get("previous_scope")
    previous_purpose = record.get("previous_purpose")
    if previous_scope not in ACTIVE_SCOPES or not isinstance(previous_purpose, str):
        raise LifecycleError(f"invalid restore state for {name}")
    canonical = canonical_dir / name
    if not (canonical / "SKILL.md").is_file():
        return {"ok": False, "name": name, "status": "blocked", "blockers": ["skill_file_missing"]}
    expected_roots = {
        "shared": roots or discovery_roots(),
        "claude-only": ((roots or discovery_roots())[0],),
        "codex-only": ((roots or discovery_roots())[1],),
    }[previous_scope]
    conflicts = []
    for root in expected_roots:
        path = root / name
        if path.exists() or path.is_symlink():
            if not path.is_symlink() or _resolved_link_target(path) != canonical.resolve():
                conflicts.append(str(path))
    if conflicts:
        return {
            "ok": False,
            "name": name,
            "status": "blocked",
            "blockers": ["discovery_path_conflict"],
            "conflicts": conflicts,
        }
    if not apply:
        return {"ok": True, "name": name, "status": "would_restore", "blockers": []}
    lines[row.line_number] = _format_index_row(row, scope=previous_scope, purpose=previous_purpose)
    _atomic_write(index_path, "".join(lines))
    created: list[str] = []
    for root in expected_roots:
        root.mkdir(parents=True, exist_ok=True)
        path = root / name
        if not path.exists() and not path.is_symlink():
            path.symlink_to(canonical, target_is_directory=True)
            created.append(str(path))
    record.update(
        {
            "status": "active",
            "coverage_started_at": format_time(current),
            "restored_at": format_time(current),
            "last_verified_at": format_time(current),
        }
    )
    _atomic_write(state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    _append_jsonl(
        events_path,
        {
            "schema_version": 1,
            "event": "restored_inactive",
            "at": format_time(current),
            "name": name,
            "scope": previous_scope,
            "created_links": created,
        },
    )
    return {"ok": True, "name": name, "status": "restored", "created_links": created, "blockers": []}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--call-log", type=Path, default=DEFAULT_CALL_LOG)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--events", type=Path, default=DEFAULT_EVENTS)
    parser.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    subparsers = parser.add_subparsers(dest="command", required=True)

    weekly = subparsers.add_parser("weekly")
    weekly.add_argument("--apply", action="store_true")
    weekly.add_argument("--json", action="store_true")

    restore = subparsers.add_parser("restore")
    restore.add_argument("--name", required=True)
    restore.add_argument("--apply", action="store_true")
    restore.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "weekly":
        result = weekly_run(
            index_path=args.index,
            canonical_dir=args.canonical,
            call_log=args.call_log,
            state_path=args.state,
            events_path=args.events,
            report_dir=args.report_dir,
            apply=args.apply,
        )
    else:
        result = restore_one(
            name=args.name,
            index_path=args.index,
            canonical_dir=args.canonical,
            state_path=args.state,
            events_path=args.events,
            apply=args.apply,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2 if getattr(args, "json", False) else None))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
