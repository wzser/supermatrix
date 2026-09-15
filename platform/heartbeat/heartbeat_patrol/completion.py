from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .state import HeartbeatState


def landing_deadline_seconds_from_env() -> int:
    return max(0, int(os.environ.get("HEARTBEAT_INJECTED_LANDING_DEADLINE_SECONDS", str(6 * 3600))))


def build_completion_summary(
    *,
    state: HeartbeatState | None,
    completion_id: str,
    patrol_id: str | None,
    status: str,
    started_at: str,
    finished_at: str,
    stats: dict[str, Any],
    errors: list[str],
    feishu_sync: dict[str, Any],
    landing_deadline_seconds: int,
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if status not in {"completed", "failed", "skipped"}:
        raise ValueError(f"unsupported completion status: {status}")
    if not completion_id:
        raise ValueError("completion_id must be non-empty")
    if snapshot is None:
        if state is None:
            raise ValueError("state is required when no completion snapshot is supplied")
        snapshot = state.completion_snapshot(landing_deadline_seconds=landing_deadline_seconds)
    return {
        "status": status,
        "run": {
            "completion_id": completion_id,
            "patrol_id": patrol_id,
            "started_at": started_at,
            "finished_at": finished_at,
        },
        "coverage": _coverage_summary(status=status, stats=stats, errors=errors),
        "todos": snapshot["todos"],
        "unrecovered": snapshot["unrecovered"],
        "escalation_handoffs": snapshot["escalation_handoffs"],
        "actions": {
            "escalated": int(stats.get("unrecovered_targets_escalated", 0)),
            "reconciled": int(stats.get("unrecovered_targets_reconciled", 0)),
            "spawn_timeouts_reconciled": int(stats.get("spawns_reconciled_timeout", 0)),
            "todo_landings_verified": int(stats.get("todos_landing_verified", 0)),
            "todo_landings_unconfirmed": int(stats.get("todos_landing_unconfirmed", 0)),
        },
        "feishu_mirror": _compact_feishu_sync(feishu_sync),
        "errors": [str(error) for error in errors if str(error)],
    }


def _coverage_summary(*, status: str, stats: dict[str, Any], errors: list[str]) -> dict[str, Any]:
    scope = str(stats.get("coverage_scope") or ("lock_skipped" if status == "skipped" else "unknown"))
    eligible_value = stats.get("eligible_sessions")
    eligible_sessions = int(eligible_value) if eligible_value is not None else None
    sessions_scanned = int(stats.get("sessions_scanned", 0))
    items_detected = int(stats.get("items_detected", 0))
    return {
        "scope": scope,
        "eligible_sessions": eligible_sessions,
        "sessions_scanned": sessions_scanned,
        "items_detected": items_detected,
        "coverage_complete": (
            status == "completed"
            and not errors
            and scope == "full"
            and eligible_sessions is not None
            and eligible_sessions == sessions_scanned
        ),
    }


def write_completion_summary(
    *,
    summary: dict[str, Any],
    directory: Path,
    state: HeartbeatState | None = None,
    canonical_directory: Path | None = None,
    manifest_directory: Path | None = None,
    history_created_at: str | None = None,
) -> dict[str, Any] | None:
    run = summary.get("run")
    completion_id = str(run.get("completion_id") or "") if isinstance(run, dict) else ""
    if not completion_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in completion_id):
        raise ValueError("completion summary has an unsafe completion_id")
    directory.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    receipt_path = directory / f"{completion_id}.json"
    _atomic_write(receipt_path, encoded)
    _atomic_write(directory / "latest.json", encoded)
    if canonical_directory is None and manifest_directory is None:
        return None
    if canonical_directory is None or manifest_directory is None:
        raise ValueError("canonical_directory and manifest_directory must be supplied together")
    from .history import archive_live_completion, completion_pointer

    manifest = archive_live_completion(
        raw=encoded.encode("utf-8"),
        original_path=receipt_path,
        state_db_path=state.path if state is not None else None,
        canonical_dir=canonical_directory,
        manifest_dir=manifest_directory,
        created_at=history_created_at,
    )
    pointer = json.dumps(
        completion_pointer(manifest),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ) + "\n"
    _atomic_write(receipt_path, pointer)
    return manifest


def _compact_feishu_sync(sync: dict[str, Any]) -> dict[str, dict[str, Any]]:
    compact: dict[str, dict[str, Any]] = {}
    for name in ("events", "todos", "todo_aggregates"):
        value = sync.get(name)
        if not isinstance(value, dict):
            compact[name] = {"status": "not_run"}
            continue
        item: dict[str, Any] = {"status": str(value.get("status") or "unknown")}
        if value.get("mode"):
            item["mode"] = str(value["mode"])
        if value.get("synced") is not None:
            item["synced"] = int(value["synced"])
        if value.get("reason"):
            item["reason"] = str(value["reason"])
        if value.get("error"):
            item["error"] = str(value["error"])
        compact[name] = item
    return compact


def _atomic_write(path: Path, content: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(content)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
