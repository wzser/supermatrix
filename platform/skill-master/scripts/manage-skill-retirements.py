#!/usr/bin/env python3
"""Manage registered skill-retirement tombstones and runtime evidence."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skill_retirement import (
    append_jsonl_locked,
    deploy_entry,
    evaluate_entry,
    format_time,
    load_jsonl,
    load_registry,
    purge_entry,
    verify_materialized_entry,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "skill-retirement-audit.json"
DEFAULT_INDEX = ROOT / "skills" / "INDEX.md"
DEFAULT_CANONICAL = ROOT / "skills"
DEFAULT_HITS = ROOT / "data" / "skill-retirements" / "hits.jsonl"
DEFAULT_REQUESTS = ROOT / "data" / "skill-retirements" / "restore-requests.jsonl"
DEFAULT_PURGE_EVENTS = ROOT / "data" / "skill-retirements" / "purge-events.jsonl"


def deploy_all(config: Path, *, apply: bool) -> dict[str, Any]:
    results = [deploy_entry(entry, apply=apply) for entry in load_registry(config)]
    return {
        "ok": all(result["status"] in {"dry_run", "deployed"} for result in results),
        "apply": apply,
        "results": results,
    }


def audit_all(config: Path, hits_path: Path, requests_path: Path) -> dict[str, Any]:
    entries = load_registry(config)
    hits = load_jsonl(hits_path)
    requests = load_jsonl(requests_path)
    now = datetime.now(timezone.utc)
    decisions = []
    for entry in entries:
        decision = evaluate_entry(entry, hits, requests, now)
        integrity = [] if entry.state == "purged" else verify_materialized_entry(entry)
        decision["integrity_findings"] = integrity
        decisions.append(decision)
    return {
        "ok": not any(decision["integrity_findings"] for decision in decisions),
        "at": format_time(now),
        "summary": {
            "entries": len(decisions),
            "purge_ready": sum(1 for decision in decisions if decision["purge_ready"]),
            "restore_blocked": sum(
                1 for decision in decisions if "unresolved_restore_request" in decision["blockers"]
            ),
        },
        "entries": decisions,
    }


def _write_text_atomic(path: Path, text: str) -> None:
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


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    _write_text_atomic(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def _index_cells(line: str) -> list[str] | None:
    if not line.startswith("|"):
        return None
    cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
    return cells if len(cells) == 5 else None


def _canonical_retirement(entry: Any, canonical_dir: Path | None) -> bool:
    if canonical_dir is None or entry.primary_tombstone_path is None:
        return False
    return entry.primary_tombstone_path == canonical_dir / entry.name / "SKILL.md"


def _valid_tombstone_index_names(index_path: Path) -> set[str]:
    valid: set[str] = set()
    for line in index_path.read_text(encoding="utf-8").splitlines():
        cells = _index_cells(line)
        if not cells:
            continue
        name, origin, scope, _, purpose = cells
        if (
            origin == "skill-master"
            and scope in {"shared", "claude-only", "codex-only"}
            and purpose.startswith("[RETIRED-TOMBSTONE until rolling quiet period completes]")
        ):
            valid.add(name)
    return valid


def _remove_tombstone_index_rows(index_path: Path, names: set[str]) -> None:
    lines = index_path.read_text(encoding="utf-8").splitlines(keepends=True)
    kept: list[str] = []
    for line in lines:
        cells = _index_cells(line)
        if cells and cells[0] in names and cells[4].startswith(
            "[RETIRED-TOMBSTONE until rolling quiet period completes]"
        ):
            continue
        kept.append(line)
    _write_text_atomic(index_path, "".join(kept))


def purge_all(
    config: Path,
    hits_path: Path,
    requests_path: Path,
    events_path: Path,
    *,
    apply: bool,
    now: datetime | None = None,
    index_path: Path | None = None,
    canonical_dir: Path | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    entries = load_registry(config)
    hits = load_jsonl(hits_path)
    requests = load_jsonl(requests_path)
    results: list[dict[str, Any]] = []
    newly_purged: set[str] = set()
    canonical_names: set[str] = set()
    valid_index_names = _valid_tombstone_index_names(index_path) if index_path else set()
    for entry in entries:
        if entry.state == "purged":
            continue
        is_canonical = _canonical_retirement(entry, canonical_dir)
        if is_canonical and entry.name not in valid_index_names:
            decision = evaluate_entry(entry, hits, requests, current)
            finding = {
                "code": "retirement_index_row_changed",
                "path": str(index_path),
            }
            result = {
                **decision,
                "status": "blocked",
                "blockers": list(dict.fromkeys(decision["blockers"] + [finding["code"]])),
                "integrity_findings": [finding],
                "removed": [],
                "purge_ready": False,
            }
        else:
            result = purge_entry(entry, hits, requests, current, apply=apply)
        results.append(result)
        event_name = "purged" if result["status"] == "purged" else "purge_evaluated"
        append_jsonl_locked(
            events_path,
            {
                "schema_version": 1,
                "event": event_name,
                "retirement_id": entry.retirement_id,
                "at": format_time(current),
                "apply": apply,
                "status": result["status"],
                "blockers": result["blockers"],
                "removed": result["removed"],
            },
        )
        if result["status"] == "purged":
            newly_purged.add(entry.retirement_id)
            if is_canonical:
                canonical_names.add(entry.name)

    if apply and newly_purged:
        if canonical_names and index_path:
            _remove_tombstone_index_rows(index_path, canonical_names)
        payload = json.loads(config.read_text(encoding="utf-8"))
        for raw in payload["retirements"]:
            if raw.get("retirement_id") in newly_purged:
                raw["state"] = "purged"
                raw["purged_at"] = format_time(current)
        _write_json_atomic(config, payload)

    integrity_failures = sum(bool(result["integrity_findings"]) for result in results)
    return {
        "ok": integrity_failures == 0,
        "apply": apply,
        "at": format_time(current),
        "summary": {
            "evaluated": len(results),
            "purged": len(newly_purged),
            "integrity_failures": integrity_failures,
        },
        "entries": results,
    }


def record_request(
    *,
    retirement_id: str,
    session: str,
    reason: str,
    requests_path: Path,
) -> dict[str, Any]:
    event = {
        "schema_version": 1,
        "event": "requested",
        "request_id": f"req_{uuid.uuid4().hex}",
        "retirement_id": retirement_id,
        "session": session,
        "reason": reason,
        "at": format_time(datetime.now(timezone.utc)),
    }
    append_jsonl_locked(requests_path, event)
    return event


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--hits", type=Path, default=DEFAULT_HITS)
    parser.add_argument("--requests", type=Path, default=DEFAULT_REQUESTS)
    parser.add_argument("--events", type=Path, default=DEFAULT_PURGE_EVENTS)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    subparsers = parser.add_subparsers(dest="command", required=True)

    deploy_parser = subparsers.add_parser("deploy")
    deploy_parser.add_argument("--apply", action="store_true")
    deploy_parser.add_argument("--json", action="store_true")

    audit_parser = subparsers.add_parser("audit")
    audit_parser.add_argument("--json", action="store_true")

    purge_parser = subparsers.add_parser("purge-due")
    purge_parser.add_argument("--apply", action="store_true")
    purge_parser.add_argument("--json", action="store_true")

    request_parser = subparsers.add_parser("record-request")
    request_parser.add_argument("--retirement-id", required=True)
    request_parser.add_argument("--session", required=True)
    request_parser.add_argument("--reason", required=True)
    request_parser.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "deploy":
        result = deploy_all(args.config, apply=args.apply)
    elif args.command == "audit":
        result = audit_all(args.config, args.hits, args.requests)
    elif args.command == "purge-due":
        result = purge_all(
            args.config,
            args.hits,
            args.requests,
            args.events,
            apply=args.apply,
            index_path=args.index,
            canonical_dir=args.canonical,
        )
    else:
        result = record_request(
            retirement_id=args.retirement_id,
            session=args.session,
            reason=args.reason,
            requests_path=args.requests,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2 if getattr(args, "json", False) else None))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
