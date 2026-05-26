from __future__ import annotations

from datetime import datetime
import json
import subprocess
from typing import Any

from .state import HeartbeatState, now_iso


BITABLE_FIELDS = [
    "patrol_id",
    "triggered_at",
    "event_type",
    "target_session",
    "logical_key",
    "decision",
    "child_session_id",
    "child_model",
    "status",
    "summary",
    "error",
    "source",
]
FEISHU_SYNC_EVENT_TYPES = (
    "spawn_started",
    "alert_sent",
    "user_resume_sent",
    "todo_enqueued",
    "todo_injected",
    "todo_injection_failed",
    "heartbeat_paused",
    "heartbeat_resumed",
    "heartbeat_pause_expired",
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
    unsynced = state.list_unsynced_events(limit=limit, include_event_types=FEISHU_SYNC_EVENT_TYPES)
    if not unsynced:
        return {"synced": 0, "base_token": base_token, "table_id": table_id, "status": "empty"}

    payload = {
        "fields": BITABLE_FIELDS,
        "rows": build_bitable_rows(unsynced),
    }
    completed = subprocess.run(
        [
            lark_cli,
            "base",
            "+record-batch-create",
            "--as",
            identity,
            "--base-token",
            base_token,
            "--table-id",
            table_id,
            "--json",
            json.dumps(payload, ensure_ascii=False),
        ],
        text=True,
        capture_output=True,
        check=False,
        timeout=180,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"lark-cli base record batch create failed with exit {completed.returncode}: {detail}")

    state.mark_events_synced([event["event_id"] for event in unsynced], sync_ref=f"base:{base_token}:{table_id}")
    return {"synced": len(unsynced), "base_token": base_token, "table_id": table_id, "identity": identity, "status": "ok"}


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
                event.get("child_session_id") or "",
                event.get("child_model") or "",
                str(event.get("status") or "").lower(),
                event.get("summary") or "",
                event.get("error") or "",
                event.get("source") or "heartbeat",
            ]
        )
    return rows


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
