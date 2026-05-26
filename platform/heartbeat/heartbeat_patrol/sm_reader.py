from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any


MAX_RECENT_RUNS = 50
MAX_TEXT_CHARS = 4000
CROSS_SESSION_LIMIT = 10
TEXT_FIELDS = {"prompt", "final_message", "error_message", "result_preview"}


def dict_rows(conn: sqlite3.Connection) -> None:
    conn.row_factory = sqlite3.Row


class SuperMatrixReader:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True)
        dict_rows(conn)
        return conn

    def list_enabled_sessions(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT s.id, s.name, s.scope, s.backend, s.model, s.effort, s.workdir,
                       s.status, s.purpose, s.heartbeat_enabled, b.group_id
                FROM sessions s
                LEFT JOIN bindings b ON b.session_id = s.id
                WHERE s.heartbeat_enabled = 1
                  AND s.status != 'deleted'
                  AND s.scope != 'child'
                  AND s.name != 'heartbeat'
                ORDER BY s.updated_at ASC, s.name ASC
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def get_session_by_name(self, name: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT s.id, s.name, s.scope, s.backend, s.model, s.effort, s.workdir,
                       s.status, s.purpose, s.heartbeat_enabled, b.group_id
                FROM sessions s
                LEFT JOIN bindings b ON b.session_id = s.id
                WHERE s.name = ?
                  AND s.status != 'deleted'
                  AND s.scope != 'child'
                LIMIT 1
                """,
                (name,),
            ).fetchone()
        return dict(row) if row is not None else None

    def build_packet(self, session: dict[str, Any], *, max_recent_runs: int = 12) -> dict[str, Any]:
        if type(max_recent_runs) is not int or max_recent_runs < 1:
            raise ValueError("max_recent_runs must be an integer >= 1")
        run_limit = min(max_recent_runs, MAX_RECENT_RUNS)
        with self._connect() as conn:
            runs = conn.execute(
                """
                SELECT id, prompt, started_at, finished_at, status, final_message, error_message
                FROM message_runs
                WHERE session_id = ?
                ORDER BY started_at DESC
                LIMIT ?
                """,
                (session["id"], run_limit),
            ).fetchall()
            comms = conn.execute(
                """
                SELECT kind, prompt, child_model, status, result_preview, error_message, created_at, finished_at
                FROM cross_session_log
                WHERE from_session_id = ? OR to_session_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (session["id"], session["id"], CROSS_SESSION_LIMIT),
            ).fetchall()
        return {
            "session": session,
            "recent_runs": [_bounded_row(row) for row in runs],
            "recent_cross_session": [_bounded_row(row) for row in comms],
        }


def _bounded_row(row: sqlite3.Row) -> dict[str, Any]:
    bounded = dict(row)
    for field in TEXT_FIELDS:
        value = bounded.get(field)
        if isinstance(value, str) and len(value) > MAX_TEXT_CHARS:
            bounded[field] = value[:MAX_TEXT_CHARS]
    return bounded
