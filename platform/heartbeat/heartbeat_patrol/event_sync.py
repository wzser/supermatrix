from __future__ import annotations

from datetime import datetime
import json
from typing import Any

from .state import HeartbeatState


# Registered runtime asset ids. These are local SQLite authority tables; wendangwang registry owns
# their contract metadata and currently marks them sync_direction=none.
RUNTIME_EVENTS_ASSET_ID = "heartbeat.runtime.events"
TODO_POOL_ASSET_ID = "heartbeat.runtime.todo_pool"
TODO_AGGREGATE_ASSET_ID = "heartbeat.runtime.todo_aggregate"
RUNTIME_MIRROR_SYNC_REASON = "sync_direction=none; local SQLite is authoritative"
RUNTIME_MIRROR_BOUNDED_LIMIT = 100


BITABLE_FIELDS = [
    "patrol_id",
    "triggered_at",
    "event_type",
    "target_session",
    "logical_key",
    "decision",
    "trigger_source",
    "trigger_cause",
    "trigger_location",
    "child_session_id",
    "child_model",
    "status",
    "injected_message",
    "summary",
    "error",
    "source",
]
TODO_BITABLE_FIELDS = [
    "todo_id",
    "created_at",
    "target_session",
    "logical_key",
    "batch_key",
    "source_session",
    "source_ref",
    "todo_type",
    "status",
    "message",
    "claimed_at",
    "injected_at",
    "finished_at",
    "injected_message",
    "source",
    "detail",
]
TODO_AGGREGATE_BITABLE_FIELDS = [
    "aggregate_key",
    "source_ref",
    "target_sessions",
    "source_sessions",
    "todo_types",
    "sources",
    "batch_keys",
    "item_count",
    "statuses",
    "final_status",
    "recorded_in_pool",
    "triggered",
    "triggered_count",
    "failed_count",
    "first_created_at",
    "last_claimed_at",
    "last_injected_at",
    "last_finished_at",
    "latest_todo_id",
    "latest_logical_key",
    "latest_message",
    "latest_injected_message",
    "latest_error",
]
FEISHU_SYNC_EVENT_TYPES = (
    "spawn_started",
    "alert_sent",
    "user_resume_sent",
    "todo_injected",
    "internal_child_completed",
    "heartbeat_paused",
    "heartbeat_resumed",
    "heartbeat_pause_expired",
    "unrecovered_item_escalated",
    "unrecovered_target_reconciled",
)


def render_events_markdown(
    events: list[dict[str, Any]],
    *,
    generated_at: str,
    local_db_path: str,
) -> str:
    lines = [
        "# Heartbeat Trigger Log",
        "",
        f"Generated at: `{generated_at}`",
        f"Local authority: `{local_db_path}`",
        "",
        "Feishu is a mirror. If this page conflicts with the local SQLite DB, trust the local DB.",
        "",
        "| Created At | Event | Status | Target | Logical Key | Decision | Child | Summary | Error |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for event in events:
        child = " ".join(
            part
            for part in (
                str(event.get("child_session_id") or ""),
                str(event.get("child_model") or ""),
            )
            if part
        )
        lines.append(
            "| "
            + " | ".join(
                _cell(event.get(key))
                for key in (
                    "created_at",
                    "event_type",
                    "status",
                    "target_session",
                    "logical_key",
                    "decision",
                )
            )
            + f" | {_cell(child)} | {_cell(event.get('summary'))} | {_cell(event.get('error'))} |"
        )
    return "\n".join(lines) + "\n"


def sync_events_to_feishu(
    *,
    state: HeartbeatState,
    base_token: str,
    table_id: str,
    lark_cli: str,
    identity: str = "bot",
    limit: int = 500,
) -> dict[str, Any]:
    return _runtime_mirror_sync_disabled(
        asset_id=RUNTIME_EVENTS_ASSET_ID,
        base_token=base_token,
        table_id=table_id,
    )


def sync_todos_to_feishu(
    *,
    state: HeartbeatState,
    base_token: str,
    table_id: str,
    lark_cli: str,
    identity: str = "bot",
    limit: int = 500,
) -> dict[str, Any]:
    return _runtime_mirror_sync_disabled(
        asset_id=TODO_POOL_ASSET_ID,
        base_token=base_token,
        table_id=table_id,
    )


def sync_todo_aggregates_to_feishu(
    *,
    state: HeartbeatState,
    base_token: str,
    table_id: str,
    lark_cli: str,
    identity: str = "bot",
    limit: int = 500,
) -> dict[str, Any]:
    return _runtime_mirror_sync_disabled(
        asset_id=TODO_AGGREGATE_ASSET_ID,
        base_token=base_token,
        table_id=table_id,
    )


def build_bitable_rows(events: list[dict[str, Any]]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for event in events:
        rows.append(
            [
                event.get("patrol_id") or event.get("event_id") or "",
                _timestamp_ms(event.get("created_at")),
                event.get("event_type") or "",
                event.get("target_session") or "",
                event.get("logical_key") or "",
                event.get("decision") or "",
                event.get("trigger_source") or "",
                event.get("trigger_cause") or "",
                event.get("trigger_location") or event.get("target_session") or "",
                event.get("child_session_id") or "",
                event.get("child_model") or "",
                str(event.get("status") or "").lower(),
                event.get("injected_message") or "",
                event.get("summary") or "",
                event.get("error") or "",
                event.get("source") or "heartbeat",
            ]
        )
    return rows


def _runtime_mirror_sync_disabled(*, asset_id: str, base_token: str, table_id: str) -> dict[str, Any]:
    return {
        "synced": 0,
        "asset_id": asset_id,
        "base_token": base_token,
        "table_id": table_id,
        "status": "disabled",
        "reason": RUNTIME_MIRROR_SYNC_REASON,
        "mode": "none",
        "bounded_limit": RUNTIME_MIRROR_BOUNDED_LIMIT,
    }


def build_todo_bitable_row(todo: dict[str, Any]) -> dict[str, Any]:
    return {
        "todo_id": todo.get("todo_id") or "",
        "created_at": _timestamp_ms(todo.get("created_at")),
        "target_session": todo.get("target_session") or "",
        "logical_key": todo.get("logical_key") or "",
        "batch_key": todo.get("batch_key") or "",
        "source_session": todo.get("source_session") or "",
        "source_ref": todo.get("source_ref") or "",
        "todo_type": todo.get("todo_type") or "general",
        "status": str(todo.get("status") or "").lower(),
        "message": todo.get("message") or "",
        "claimed_at": _optional_timestamp_ms(todo.get("claimed_at")),
        "injected_at": _optional_timestamp_ms(todo.get("injected_at")),
        "finished_at": _optional_timestamp_ms(todo.get("finished_at")),
        "injected_message": todo.get("detail") or "",
        "source": todo.get("source") or "heartbeat",
        "detail": todo.get("detail") or "",
    }


def build_todo_aggregate_bitable_row(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "aggregate_key": row.get("aggregate_key") or "",
        "source_ref": row.get("source_ref") or "",
        "target_sessions": row.get("target_sessions") or "",
        "source_sessions": row.get("source_sessions") or "",
        "todo_types": row.get("todo_types") or "",
        "sources": row.get("sources") or "",
        "batch_keys": row.get("batch_keys") or "",
        "item_count": row.get("item_count") or 0,
        "statuses": row.get("statuses") or "",
        "final_status": row.get("final_status") or "",
        "recorded_in_pool": row.get("recorded_in_pool") or "yes",
        "triggered": row.get("triggered") or "no",
        "triggered_count": row.get("triggered_count") or 0,
        "failed_count": row.get("failed_count") or 0,
        "first_created_at": _optional_timestamp_ms(row.get("first_created_at")),
        "last_claimed_at": _optional_timestamp_ms(row.get("last_claimed_at")),
        "last_injected_at": _optional_timestamp_ms(row.get("last_injected_at")),
        "last_finished_at": _optional_timestamp_ms(row.get("last_finished_at")),
        "latest_todo_id": row.get("latest_todo_id") or "",
        "latest_logical_key": row.get("latest_logical_key") or "",
        "latest_message": row.get("latest_message") or "",
        "latest_injected_message": row.get("latest_injected_message") or "",
        "latest_error": row.get("latest_error") or "",
    }


def _cell(value: Any) -> str:
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", "<br>").strip()


def _timestamp_ms(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def _optional_timestamp_ms(value: Any) -> int | None:
    timestamp = _timestamp_ms(value)
    return timestamp if timestamp else None
