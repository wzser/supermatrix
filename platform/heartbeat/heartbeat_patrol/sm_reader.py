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

    def latest_run_status(self, session_id: Any) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT status
                FROM message_runs
                WHERE session_id = ?
                ORDER BY started_at DESC
                LIMIT 1
                """,
                (session_id,),
            ).fetchone()
        if row is None or row["status"] is None:
            return None
        return str(row["status"])

    def session_run_landed_since(self, session_name: str, since_ms: int) -> bool:
        """True if a message_run in `session_name` started at/after since_ms (epoch ms).

        Used to confirm an injected todo actually landed as a run in the owner session
        (reading message_runs framework runtime metadata for observability is a sanctioned
        ops read). message_runs.started_at is stored as epoch milliseconds.
        """
        if not session_name:
            return False
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM message_runs mr
                JOIN sessions s ON mr.session_id = s.id
                WHERE s.name = ?
                  AND mr.started_at >= ?
                LIMIT 1
                """,
                (session_name, since_ms),
            ).fetchone()
        return row is not None

    def resolve_spawn_endpoints(self, comm_id: str) -> dict[str, Any] | None:
        if not isinstance(comm_id, str) or not comm_id.startswith("comm_"):
            return None
        try:
            with self._connect() as conn:
                row = conn.execute(
                    """
                    SELECT sf.name AS caller,
                           st.name AS target,
                           sc.name AS child
                    FROM cross_session_log c
                    LEFT JOIN sessions sf ON c.from_session_id = sf.id
                    LEFT JOIN sessions st ON c.to_session_id = st.id
                    LEFT JOIN sessions sc ON c.child_session_id = sc.id
                    WHERE c.id = ?
                    LIMIT 1
                    """,
                    (comm_id,),
                ).fetchone()
        except sqlite3.OperationalError:
            return None
        if row is None:
            return None
        return {
            "caller": row["caller"],
            "target": row["target"],
            "child": row["child"],
        }

    def completed_cross_session_logs(self, comm_ids: list[str]) -> dict[str, dict[str, Any]]:
        refs = sorted({comm_id for comm_id in comm_ids if isinstance(comm_id, str) and comm_id.startswith("comm_")})
        if not refs:
            return {}
        try:
            with self._connect() as conn:
                columns = {row["name"] for row in conn.execute("PRAGMA table_info(cross_session_log)").fetchall()}
                if "id" not in columns:
                    return {}
                placeholders = ",".join("?" for _ in refs)
                rows = conn.execute(
                    f"""
                    SELECT id, status, finished_at, result_preview, final_message, error_message
                    FROM cross_session_log
                    WHERE id IN ({placeholders})
                      AND status = 'completed'
                    """,
                    tuple(refs),
                ).fetchall()
        except sqlite3.OperationalError:
            return {}
        return {str(row["id"]): _bounded_row(row) for row in rows}

    def completed_heartbeat_child_results(
        self, candidates: list[dict[str, Any]]
    ) -> dict[tuple[str, str], dict[str, Any]]:
        """Return materialized target results that explicitly name a heartbeat logical key.

        A timeout can occur after spawn2.0 has registered its cross-session row.  We only accept a
        late result when the authoritative row is from heartbeat to the target, completed with a
        non-empty result, and contains the exact standalone marker line emitted by ``child_prompt``.
        The framework may prepend a delivery-rule line, so the marker need not be prompt line one.
        This is an identity link, not a target/topic or nearest-timestamp heuristic.
        """
        normalized: list[tuple[str, str, int]] = []
        seen: set[tuple[str, str, int]] = set()
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            target_session = str(candidate.get("target_session") or "").strip()
            logical_key = str(candidate.get("logical_key") or "").strip()
            after_ms = candidate.get("after_ms")
            if not target_session or not logical_key or type(after_ms) is not int or after_ms < 0:
                continue
            key = (target_session, logical_key, after_ms)
            if key not in seen:
                seen.add(key)
                normalized.append(key)
        if not normalized:
            return {}

        results: dict[tuple[str, str], dict[str, Any]] = {}
        try:
            with self._connect() as conn:
                for target_session, logical_key, after_ms in normalized:
                    marker = f"Heartbeat follow-up for `{logical_key}`.\n"
                    row = conn.execute(
                        """
                        SELECT c.id, c.finished_at, c.result_preview, c.final_message
                        FROM cross_session_log c
                        JOIN sessions sf ON sf.id = c.from_session_id
                        JOIN sessions st ON st.id = c.to_session_id
                        WHERE sf.name = 'heartbeat'
                          AND st.name = ?
                          AND c.status = 'completed'
                          AND c.finished_at IS NOT NULL
                          AND c.finished_at >= ?
                          AND instr(
                            char(10) || replace(COALESCE(c.prompt, ''), char(13) || char(10), char(10)),
                            char(10) || ?
                          ) > 0
                          AND (
                            TRIM(COALESCE(c.result_preview, '')) != ''
                            OR TRIM(COALESCE(c.final_message, '')) != ''
                          )
                        ORDER BY c.finished_at ASC, c.id ASC
                        LIMIT 1
                        """,
                        (target_session, after_ms, marker),
                    ).fetchone()
                    if row is None:
                        continue
                    results[(target_session, logical_key)] = {
                        "comm_id": str(row["id"]),
                        "finished_at": int(row["finished_at"]),
                        "result_preview": str(row["result_preview"] or "")[:MAX_TEXT_CHARS],
                        "final_message": str(row["final_message"] or "")[:MAX_TEXT_CHARS],
                    }
        except sqlite3.OperationalError:
            return {}
        return results

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
