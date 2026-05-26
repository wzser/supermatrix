from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import sqlite3
import uuid
from typing import Any


FINISHED_SPAWN_STATUSES = {"completed", "failed", "cancelled", "timeout"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class SpawnRecord:
    logical_key: str
    target_session: str
    child_session_id: str | None
    child_model: str
    status: str


@dataclass(frozen=True)
class TodoRecord:
    todo_id: str
    target_session: str
    logical_key: str
    batch_key: str | None
    status: str
    message: str
    source: str


@dataclass(frozen=True)
class TodoBatchClaim:
    batch_key: str | None
    target_session: str
    todos: list[TodoRecord]


class HeartbeatState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            try:
                conn.execute("BEGIN")
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS patrol_runs (
                      patrol_id TEXT PRIMARY KEY,
                      started_at TEXT NOT NULL,
                      finished_at TEXT,
                      model TEXT NOT NULL,
                      status TEXT NOT NULL,
                      sessions_scanned INTEGER NOT NULL DEFAULT 0,
                      items_detected INTEGER NOT NULL DEFAULT 0,
                      alerts_sent INTEGER NOT NULL DEFAULT 0,
                      spawns_started INTEGER NOT NULL DEFAULT 0,
                      spawns_skipped_duplicate INTEGER NOT NULL DEFAULT 0,
                      errors TEXT NOT NULL DEFAULT ''
                    )
                    """
                )

                if self._table_exists(conn, "child_spawns"):
                    child_spawns_pk = self._child_spawns_pk_columns(conn)
                    if child_spawns_pk == ["logical_key"]:
                        self._migrate_child_spawns_to_composite_key(conn)
                    elif child_spawns_pk != ["target_session", "logical_key"]:
                        raise RuntimeError(f"unsupported child_spawns primary key: {child_spawns_pk}")

                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS child_spawns (
                      logical_key TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      child_session_id TEXT,
                      child_model TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      last_polled_at TEXT,
                      final_summary TEXT NOT NULL DEFAULT '',
                      PRIMARY KEY (target_session, logical_key)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_child_spawns_status
                      ON child_spawns(status, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS patrol_state (
                      key TEXT PRIMARY KEY,
                      value TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS action_claims (
                      action_type TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      logical_key TEXT NOT NULL,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      finished_at TEXT,
                      detail TEXT NOT NULL DEFAULT '',
                      PRIMARY KEY (action_type, target_session, logical_key)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_action_claims_status
                      ON action_claims(action_type, status, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS todo_batches (
                      batch_key TEXT PRIMARY KEY,
                      target_session TEXT NOT NULL,
                      source_session TEXT NOT NULL DEFAULT '',
                      source_ref TEXT NOT NULL DEFAULT '',
                      todo_type TEXT NOT NULL DEFAULT 'general',
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      last_item_at TEXT NOT NULL,
                      settle_after_seconds INTEGER NOT NULL DEFAULT 600,
                      max_wait_seconds INTEGER NOT NULL DEFAULT 1800,
                      expected_count INTEGER,
                      item_count INTEGER NOT NULL DEFAULT 0,
                      detail TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_todo_batches_target_status
                      ON todo_batches(target_session, status, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS session_todos (
                      todo_id TEXT PRIMARY KEY,
                      target_session TEXT NOT NULL,
                      logical_key TEXT NOT NULL,
                      batch_key TEXT,
                      source_session TEXT NOT NULL DEFAULT '',
                      source_ref TEXT NOT NULL DEFAULT '',
                      todo_type TEXT NOT NULL DEFAULT 'general',
                      status TEXT NOT NULL,
                      message TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      claimed_at TEXT,
                      injected_at TEXT,
                      finished_at TEXT,
                      source TEXT NOT NULL DEFAULT 'heartbeat',
                      detail TEXT NOT NULL DEFAULT '',
                      UNIQUE (target_session, logical_key)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_session_todos_pending
                      ON session_todos(target_session, status, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_session_todos_batch
                      ON session_todos(batch_key, status, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS heartbeat_pauses (
                      session_name TEXT PRIMARY KEY,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      expires_at TEXT,
                      reason TEXT NOT NULL DEFAULT '',
                      source TEXT NOT NULL DEFAULT 'heartbeat'
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_heartbeat_pauses_status
                      ON heartbeat_pauses(status, expires_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS heartbeat_events (
                      event_id TEXT PRIMARY KEY,
                      created_at TEXT NOT NULL,
                      patrol_id TEXT,
                      event_type TEXT NOT NULL,
                      target_session TEXT,
                      logical_key TEXT,
                      decision TEXT,
                      child_session_id TEXT,
                      child_model TEXT,
                      status TEXT NOT NULL,
                      summary TEXT NOT NULL DEFAULT '',
                      error TEXT NOT NULL DEFAULT '',
                      source TEXT NOT NULL DEFAULT 'heartbeat',
                      feishu_synced_at TEXT,
                      feishu_ref TEXT
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_heartbeat_events_unsynced
                      ON heartbeat_events(feishu_synced_at, created_at)
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_heartbeat_events_patrol
                      ON heartbeat_events(patrol_id, created_at)
                    """
                )
                conn.execute("COMMIT")
            except Exception:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise

    def _table_exists(self, conn: sqlite3.Connection, table_name: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        return row is not None

    def _child_spawns_pk_columns(self, conn: sqlite3.Connection) -> list[str]:
        rows = conn.execute("PRAGMA table_info(child_spawns)").fetchall()
        pk_columns = [(row[5], row[1]) for row in rows if row[5]]
        return [name for _, name in sorted(pk_columns)]

    def _migrate_child_spawns_to_composite_key(self, conn: sqlite3.Connection) -> None:
        conn.execute("ALTER TABLE child_spawns RENAME TO child_spawns_old_logical_key_pk")
        conn.execute(
            """
            CREATE TABLE child_spawns (
              logical_key TEXT NOT NULL,
              target_session TEXT NOT NULL,
              child_session_id TEXT,
              child_model TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_polled_at TEXT,
              final_summary TEXT NOT NULL DEFAULT '',
              PRIMARY KEY (target_session, logical_key)
            )
            """
        )
        conn.execute(
            """
            INSERT INTO child_spawns
              (logical_key, target_session, child_session_id, child_model, status, created_at, last_polled_at, final_summary)
            SELECT logical_key, target_session, child_session_id, child_model, status, created_at, last_polled_at, final_summary
            FROM child_spawns_old_logical_key_pk
            """
        )
        conn.execute("DROP TABLE child_spawns_old_logical_key_pk")

    def start_patrol(self, model: str) -> str:
        patrol_id = f"patrol-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO patrol_runs (patrol_id, started_at, model, status) VALUES (?, ?, ?, 'running')",
                (patrol_id, now_iso(), model),
            )
            self._insert_event(
                conn,
                patrol_id=patrol_id,
                event_type="patrol_started",
                status="running",
                summary=f"model={model}",
            )
        return patrol_id

    def log_event(
        self,
        *,
        event_type: str,
        status: str,
        patrol_id: str | None = None,
        target_session: str | None = None,
        logical_key: str | None = None,
        decision: str | None = None,
        child_session_id: str | None = None,
        child_model: str | None = None,
        summary: str = "",
        error: str = "",
        source: str = "heartbeat",
    ) -> str:
        with self._connect() as conn:
            return self._insert_event(
                conn,
                patrol_id=patrol_id,
                event_type=event_type,
                target_session=target_session,
                logical_key=logical_key,
                decision=decision,
                child_session_id=child_session_id,
                child_model=child_model,
                status=status,
                summary=summary,
                error=error,
                source=source,
            )

    def list_unsynced_events(
        self,
        *,
        limit: int,
        exclude_noop: bool = False,
        include_event_types: tuple[str, ...] | None = None,
    ) -> list[dict[str, Any]]:
        where = ["feishu_synced_at IS NULL"]
        params: list[Any] = []
        if include_event_types:
            placeholders = ",".join("?" for _ in include_event_types)
            where.append(f"event_type IN ({placeholders})")
            params.extend(include_event_types)
        if exclude_noop:
            where.extend(
                [
                    "event_type != 'session_prefilter_skip'",
                    "COALESCE(status, '') != 'skipped'",
                    "NOT (event_type = 'session_decision' AND COALESCE(decision, '') = 'skip')",
                ]
            )
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"""
                SELECT *
                FROM heartbeat_events
                WHERE {" AND ".join(where)}
                ORDER BY created_at, event_id
                LIMIT ?
                """,
                (*params, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_events(self, *, limit: int) -> list[dict[str, Any]]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT *
                FROM heartbeat_events
                ORDER BY created_at DESC, event_id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_events_synced(self, event_ids: list[str], *, sync_ref: str) -> None:
        if not event_ids:
            return
        with self._connect() as conn:
            conn.executemany(
                """
                UPDATE heartbeat_events
                SET feishu_synced_at = ?, feishu_ref = ?
                WHERE event_id = ?
                """,
                [(now_iso(), sync_ref, event_id) for event_id in event_ids],
            )

    def try_claim_action(self, *, action_type: str, target_session: str, logical_key: str) -> bool:
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO action_claims (action_type, target_session, logical_key, status, created_at)
                    VALUES (?, ?, ?, 'claimed', ?)
                    """,
                    (action_type, target_session, logical_key, now_iso()),
                )
        except sqlite3.IntegrityError:
            return False
        return True

    def finish_action(self, *, action_type: str, target_session: str, logical_key: str, status: str, detail: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE action_claims
                SET status = ?, finished_at = ?, detail = ?
                WHERE action_type = ? AND target_session = ? AND logical_key = ?
                """,
                (status, now_iso(), detail[:4000], action_type, target_session, logical_key),
            )

    def release_action_claim(self, *, action_type: str, target_session: str, logical_key: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                DELETE FROM action_claims
                WHERE action_type = ? AND target_session = ? AND logical_key = ?
                """,
                (action_type, target_session, logical_key),
            )

    def enqueue_todo(
        self,
        *,
        target_session: str,
        logical_key: str,
        message: str,
        source: str = "heartbeat",
        source_session: str = "",
        source_ref: str = "",
        todo_type: str = "general",
        target_heartbeat_enabled: bool = True,
        batch_key: str = "",
        batch_mode: str = "auto",
        expected_count: int | None = None,
        settle_after_seconds: int = 600,
        max_wait_seconds: int = 1800,
    ) -> dict[str, Any]:
        target_session = target_session.strip()
        logical_key = logical_key.strip()
        message = message.strip()
        source = (source or "heartbeat").strip()
        source_session = (source_session or source).strip()
        source_ref = source_ref.strip()
        todo_type = (todo_type or "general").strip()
        batch_key = batch_key.strip()
        batch_mode = batch_mode.strip() or "auto"
        if batch_mode not in {"auto", "single"}:
            raise ValueError("batch_mode must be 'auto' or 'single'")
        for name, value in {
            "target_session": target_session,
            "logical_key": logical_key,
            "message": message,
            "source": source,
            "source_session": source_session,
            "todo_type": todo_type,
        }.items():
            if not value:
                raise ValueError(f"{name} must be non-empty")
        if expected_count is not None and expected_count < 1:
            raise ValueError("expected_count must be >= 1")
        if settle_after_seconds < 1 or max_wait_seconds < 1:
            raise ValueError("settle_after_seconds and max_wait_seconds must be >= 1")
        if not target_heartbeat_enabled:
            with self._connect() as conn:
                self._insert_event(
                    conn,
                    event_type="todo_enqueue_target_not_heartbeat_enabled",
                    target_session=target_session,
                    logical_key=logical_key,
                    status="skipped",
                    summary=message,
                    source=source,
                )
            return {"status": "target_not_heartbeat_enabled", "target_session": target_session}

        todo_id = f"todo_{uuid.uuid4().hex[:12]}"
        created_at = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            existing = conn.execute(
                """
                SELECT todo_id, status, batch_key
                FROM session_todos
                WHERE target_session = ? AND logical_key = ?
                """,
                (target_session, logical_key),
            ).fetchone()
            if existing is not None:
                self._insert_event(
                    conn,
                    event_type="todo_enqueue_duplicate",
                    target_session=target_session,
                    logical_key=logical_key,
                    status="skipped",
                    summary=message,
                    source=source,
                )
                return {
                    "status": "duplicate",
                    "todo_id": str(existing["todo_id"]),
                    "todo_status": str(existing["status"]),
                    "batch_key": existing["batch_key"],
                }

            resolved_batch_key = None
            if batch_mode == "auto":
                resolved_batch_key = self._resolve_batch_key(
                    conn,
                    target_session=target_session,
                    source_session=source_session,
                    source_ref=source_ref,
                    todo_type=todo_type,
                    explicit_batch_key=batch_key,
                    message=message,
                    now=created_at,
                    expected_count=expected_count,
                    settle_after_seconds=settle_after_seconds,
                    max_wait_seconds=max_wait_seconds,
                )

            conn.execute(
                """
                INSERT INTO session_todos (
                  todo_id, target_session, logical_key, batch_key, source_session, source_ref,
                  todo_type, status, message, created_at, source
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (
                    todo_id,
                    target_session,
                    logical_key,
                    resolved_batch_key,
                    source_session,
                    source_ref,
                    todo_type,
                    message,
                    created_at,
                    source,
                ),
            )
            if resolved_batch_key:
                conn.execute(
                    """
                    UPDATE todo_batches
                    SET item_count = item_count + 1,
                        last_item_at = ?,
                        expected_count = COALESCE(expected_count, ?)
                    WHERE batch_key = ?
                    """,
                    (created_at, expected_count, resolved_batch_key),
                )
            self._insert_event(
                conn,
                event_type="todo_enqueued",
                target_session=target_session,
                logical_key=logical_key,
                status="pending",
                summary=message,
                source=source,
            )
        return {"status": "inserted", "todo_id": todo_id, "batch_key": resolved_batch_key}

    def pending_todos_for_session(self, target_session: str, *, limit: int = 10) -> list[dict[str, Any]]:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT todo_id, target_session, logical_key, batch_key, source_session, source_ref,
                       todo_type, status, created_at, source
                FROM session_todos
                WHERE target_session = ? AND status = 'pending'
                ORDER BY created_at, logical_key, todo_id
                LIMIT ?
                """,
                (target_session, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def _resolve_batch_key(
        self,
        conn: sqlite3.Connection,
        *,
        target_session: str,
        source_session: str,
        source_ref: str,
        todo_type: str,
        explicit_batch_key: str,
        message: str,
        now: str,
        expected_count: int | None,
        settle_after_seconds: int,
        max_wait_seconds: int,
    ) -> str:
        if explicit_batch_key:
            batch_key = explicit_batch_key
        elif source_ref:
            batch_key = f"auto:{target_session}:{source_session}:{todo_type}:{_short_hash(source_ref)}"
        else:
            batch_key = self._find_recent_open_batch_key(
                conn,
                target_session=target_session,
                source_session=source_session,
                todo_type=todo_type,
                now=now,
            )
            if batch_key:
                return batch_key
            batch_key = f"auto:{target_session}:{source_session}:{todo_type}:window:{_compact_time(now)}:{_short_hash(message)}"

        conn.execute(
            """
            INSERT INTO todo_batches (
              batch_key, target_session, source_session, source_ref, todo_type, status,
              created_at, last_item_at, settle_after_seconds, max_wait_seconds, expected_count
            )
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
            ON CONFLICT(batch_key) DO UPDATE SET
              expected_count = COALESCE(todo_batches.expected_count, excluded.expected_count),
              settle_after_seconds = excluded.settle_after_seconds,
              max_wait_seconds = excluded.max_wait_seconds
            """,
            (
                batch_key,
                target_session,
                source_session,
                source_ref,
                todo_type,
                now,
                now,
                settle_after_seconds,
                max_wait_seconds,
                expected_count,
            ),
        )
        return batch_key

    def _find_recent_open_batch_key(
        self,
        conn: sqlite3.Connection,
        *,
        target_session: str,
        source_session: str,
        todo_type: str,
        now: str,
    ) -> str | None:
        rows = conn.execute(
            """
            SELECT batch_key, last_item_at, settle_after_seconds
            FROM todo_batches
            WHERE target_session = ?
              AND source_session = ?
              AND todo_type = ?
              AND status = 'open'
              AND source_ref = ''
            ORDER BY last_item_at DESC
            LIMIT 5
            """,
            (target_session, source_session, todo_type),
        ).fetchall()
        for row in rows:
            if _seconds_between(str(row["last_item_at"]), now) <= int(row["settle_after_seconds"]):
                return str(row["batch_key"])
        return None

    def claim_next_todo_batch(
        self, *, target_session: str, todo_types: set[str] | None = None
    ) -> TodoBatchClaim | None:
        claimed_at = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            batch = self._find_ready_batch(
                conn,
                target_session=target_session,
                now=claimed_at,
                todo_types=todo_types,
            )
            single_where = ["target_session = ?", "status = 'pending'", "batch_key IS NULL"]
            single_params: list[Any] = [target_session]
            if todo_types:
                placeholders = ",".join("?" for _ in todo_types)
                single_where.append(f"todo_type IN ({placeholders})")
                single_params.extend(sorted(todo_types))
            single = conn.execute(
                """
                SELECT *
                FROM session_todos
                WHERE {where}
                ORDER BY created_at, logical_key, todo_id
                LIMIT 1
                """.format(where=" AND ".join(single_where)),
                tuple(single_params),
            ).fetchone()
            if batch is None and single is None:
                return None
            use_batch = batch is not None and (
                single is None or str(batch["created_at"]) <= str(single["created_at"])
            )
            if use_batch:
                cursor = conn.execute(
                    """
                    UPDATE todo_batches
                    SET status = 'claimed'
                    WHERE batch_key = ? AND status != 'claimed'
                    """,
                    (batch["batch_key"],),
                )
                if cursor.rowcount == 0:
                    return None
                conn.execute(
                    """
                    UPDATE session_todos
                    SET status = 'claimed', claimed_at = ?
                    WHERE batch_key = ? AND status = 'pending'
                    """,
                    (claimed_at, batch["batch_key"]),
                )
                rows = conn.execute(
                    """
                    SELECT *
                    FROM session_todos
                    WHERE batch_key = ? AND status = 'claimed'
                    ORDER BY created_at, logical_key, todo_id
                    """,
                    (batch["batch_key"],),
                ).fetchall()
                return TodoBatchClaim(
                    batch_key=str(batch["batch_key"]),
                    target_session=target_session,
                    todos=[_todo_from_row(row) for row in rows],
                )

            cursor = conn.execute(
                """
                UPDATE session_todos
                SET status = 'claimed', claimed_at = ?
                WHERE todo_id = ? AND status = 'pending'
                """,
                (claimed_at, single["todo_id"]),
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute("SELECT * FROM session_todos WHERE todo_id = ?", (single["todo_id"],)).fetchone()
            return TodoBatchClaim(batch_key=None, target_session=target_session, todos=[_todo_from_row(row)])

    def _find_ready_batch(
        self,
        conn: sqlite3.Connection,
        *,
        target_session: str,
        now: str,
        todo_types: set[str] | None = None,
    ) -> sqlite3.Row | None:
        where = [
            "target_session = ?",
            "status != 'claimed'",
            "item_count > 0",
            """
            EXISTS (
              SELECT 1
              FROM session_todos st
              WHERE st.batch_key = todo_batches.batch_key
                AND st.status = 'pending'
            )
            """,
        ]
        params: list[Any] = [target_session]
        if todo_types:
            placeholders = ",".join("?" for _ in todo_types)
            where.append(f"todo_type IN ({placeholders})")
            params.extend(sorted(todo_types))
        rows = conn.execute(
            """
            SELECT *
            FROM todo_batches
            WHERE {where}
            ORDER BY created_at, batch_key
            """.format(where=" AND ".join(where)),
            tuple(params),
        ).fetchall()
        for row in rows:
            expected_count = row["expected_count"]
            item_count = int(row["item_count"])
            if expected_count is not None and item_count >= int(expected_count):
                return row
            if _seconds_between(str(row["last_item_at"]), now) >= int(row["settle_after_seconds"]):
                return row
            if _seconds_between(str(row["created_at"]), now) >= int(row["max_wait_seconds"]):
                return row
        return None

    def mark_todos_injected(self, *, todo_ids: list[str], detail: str) -> None:
        self._mark_todos_finished(todo_ids=todo_ids, status="injected", detail=detail, injected=True)

    def mark_todos_failed(self, *, todo_ids: list[str], detail: str) -> None:
        self._mark_todos_finished(todo_ids=todo_ids, status="failed", detail=detail, injected=False)

    def pause_session(
        self,
        *,
        session_name: str,
        minutes: int | None,
        permanent: bool = False,
        reason: str = "",
        source: str = "heartbeat_command",
    ) -> dict[str, Any]:
        session_name = session_name.strip()
        reason = reason.strip()
        source = (source or "heartbeat_command").strip()
        if not session_name:
            raise ValueError("session_name must be non-empty")
        if permanent:
            expires_at = None
            status = "permanent"
            summary = reason or "heartbeat permanently stopped"
        else:
            if minutes is None or minutes < 1:
                raise ValueError("minutes must be >= 1 for temporary pause")
            expires_at = (datetime.now(timezone.utc) + timedelta(minutes=minutes)).isoformat(timespec="seconds")
            status = "paused"
            summary = reason or f"heartbeat paused for {minutes} minutes"
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO heartbeat_pauses (session_name, status, created_at, updated_at, expires_at, reason, source)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_name) DO UPDATE SET
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at,
                  reason = excluded.reason,
                  source = excluded.source
                """,
                (session_name, status, now, now, expires_at, reason, source),
            )
            self._insert_event(
                conn,
                event_type="heartbeat_paused",
                target_session=session_name,
                status=status,
                summary=summary,
                source=source,
            )
        return {"session_name": session_name, "status": status, "expires_at": expires_at}

    def resume_session(
        self,
        *,
        session_name: str,
        reason: str = "",
        source: str = "heartbeat_command",
    ) -> dict[str, Any]:
        session_name = session_name.strip()
        reason = reason.strip()
        source = (source or "heartbeat_command").strip()
        if not session_name:
            raise ValueError("session_name must be non-empty")
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT status, expires_at FROM heartbeat_pauses WHERE session_name = ?",
                (session_name,),
            ).fetchone()
            conn.execute("DELETE FROM heartbeat_pauses WHERE session_name = ?", (session_name,))
            self._insert_event(
                conn,
                event_type="heartbeat_resumed",
                target_session=session_name,
                status="resumed",
                summary=reason or "heartbeat resumed",
                source=source,
            )
        return {
            "session_name": session_name,
            "status": "resumed",
            "previous_status": str(existing[0]) if existing else "",
            "previous_expires_at": str(existing[1]) if existing and existing[1] else "",
        }

    def active_pause_for_session(self, session_name: str) -> dict[str, Any] | None:
        session_name = session_name.strip()
        if not session_name:
            return None
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT session_name, status, created_at, updated_at, expires_at, reason, source
                FROM heartbeat_pauses
                WHERE session_name = ?
                  AND status IN ('paused', 'permanent')
                  AND (expires_at IS NULL OR expires_at > ?)
                LIMIT 1
                """,
                (session_name, now),
            ).fetchone()
        return dict(row) if row is not None else None

    def expire_pause_if_needed(self, session_name: str) -> dict[str, Any] | None:
        session_name = session_name.strip()
        if not session_name:
            return None
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT session_name, status, expires_at, reason, source
                FROM heartbeat_pauses
                WHERE session_name = ?
                  AND status = 'paused'
                  AND expires_at IS NOT NULL
                  AND expires_at <= ?
                LIMIT 1
                """,
                (session_name, now),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE heartbeat_pauses
                SET status = 'expired', updated_at = ?
                WHERE session_name = ? AND status = 'paused'
                """,
                (now, session_name),
            )
            self._insert_event(
                conn,
                event_type="heartbeat_pause_expired",
                target_session=session_name,
                status="expired",
                summary=f"expired_at={row['expires_at']}",
                source=str(row["source"] or "heartbeat"),
            )
        return dict(row)

    def _mark_todos_finished(self, *, todo_ids: list[str], status: str, detail: str, injected: bool) -> None:
        if not todo_ids:
            raise ValueError("todo_ids must be non-empty")
        finished_at = now_iso()
        placeholders = ",".join("?" for _ in todo_ids)
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT todo_id, batch_key FROM session_todos WHERE todo_id IN ({placeholders}) AND status = 'claimed'",
                tuple(todo_ids),
            ).fetchall()
            if len(rows) != len(todo_ids):
                raise KeyError("claimed todo count mismatch")
            if injected:
                conn.execute(
                    f"""
                    UPDATE session_todos
                    SET status = ?, injected_at = ?, finished_at = ?, detail = ?
                    WHERE todo_id IN ({placeholders}) AND status = 'claimed'
                    """,
                    (status, finished_at, finished_at, detail[:4000], *todo_ids),
                )
            else:
                conn.execute(
                    f"""
                    UPDATE session_todos
                    SET status = ?, finished_at = ?, detail = ?
                    WHERE todo_id IN ({placeholders}) AND status = 'claimed'
                    """,
                    (status, finished_at, detail[:4000], *todo_ids),
                )
            batch_keys = sorted({str(row["batch_key"]) for row in rows if row["batch_key"]})
            for batch_key in batch_keys:
                conn.execute(
                    """
                    UPDATE todo_batches
                    SET status = ?, detail = ?
                    WHERE batch_key = ? AND status = 'claimed'
                    """,
                    (status, detail[:4000], batch_key),
                )

    def _insert_event(
        self,
        conn: sqlite3.Connection,
        *,
        event_type: str,
        status: str,
        patrol_id: str | None = None,
        target_session: str | None = None,
        logical_key: str | None = None,
        decision: str | None = None,
        child_session_id: str | None = None,
        child_model: str | None = None,
        summary: str = "",
        error: str = "",
        source: str = "heartbeat",
    ) -> str:
        event_id = f"hev_{uuid.uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO heartbeat_events (
              event_id, created_at, patrol_id, event_type, target_session, logical_key,
              decision, child_session_id, child_model, status, summary, error, source
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                now_iso(),
                patrol_id,
                event_type,
                target_session,
                logical_key,
                decision,
                child_session_id,
                child_model,
                status,
                summary[:4000],
                error[:4000],
                source,
            ),
        )
        return event_id

    def get_value(self, key: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM patrol_state WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return str(row[0])

    def set_value(self, key: str, value: str) -> None:
        if not key or not value:
            raise ValueError("patrol state key and value must be non-empty")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO patrol_state (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (key, value),
            )

    def finish_patrol(
        self,
        patrol_id: str,
        *,
        sessions_scanned: int,
        items_detected: int,
        alerts_sent: int,
        spawns_started: int,
        spawns_skipped_duplicate: int,
        errors: list[str],
    ) -> None:
        status = "completed" if not errors else "failed"
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE patrol_runs
                SET finished_at = ?, status = ?, sessions_scanned = ?, items_detected = ?,
                    alerts_sent = ?, spawns_started = ?, spawns_skipped_duplicate = ?, errors = ?
                WHERE patrol_id = ?
                """,
                (
                    now_iso(),
                    status,
                    sessions_scanned,
                    items_detected,
                    alerts_sent,
                    spawns_started,
                    spawns_skipped_duplicate,
                    "\n".join(errors),
                    patrol_id,
                ),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"patrol run not found: {patrol_id}")
            self._insert_event(
                conn,
                patrol_id=patrol_id,
                event_type="patrol_finished",
                status=status,
                summary=(
                    f"sessions_scanned={sessions_scanned}; items_detected={items_detected}; "
                    f"alerts_sent={alerts_sent}; spawns_started={spawns_started}; "
                    f"spawns_skipped_duplicate={spawns_skipped_duplicate}"
                ),
                error="\n".join(errors),
            )

    def try_claim_spawn(self, *, logical_key: str, target_session: str, child_model: str) -> bool:
        self._validate_spawn_claim(logical_key=logical_key, target_session=target_session, child_model=child_model)
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO child_spawns
                      (logical_key, target_session, child_model, status, created_at)
                    VALUES (?, ?, ?, 'claimed', ?)
                    """,
                    (logical_key, target_session, child_model, now_iso()),
                )
            return True
        except sqlite3.IntegrityError:
            return False

    def release_spawn_claim(self, *, target_session: str, logical_key: str) -> None:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                DELETE FROM child_spawns
                WHERE target_session = ?
                  AND logical_key = ?
                  AND status = 'claimed'
                  AND child_session_id IS NULL
                """,
                (target_session, logical_key),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"unstarted spawn claim not found: {target_session}:{logical_key}")

    def mark_spawn_started(self, *, target_session: str, logical_key: str, child_session_id: str) -> None:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE child_spawns
                SET child_session_id = ?, status = 'running'
                WHERE target_session = ? AND logical_key = ?
                """,
                (child_session_id, target_session, logical_key),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"spawn claim not found: {target_session}:{logical_key}")

    def mark_spawn_finished(self, *, target_session: str, logical_key: str, status: str, final_summary: str) -> None:
        if status not in FINISHED_SPAWN_STATUSES:
            allowed = ", ".join(sorted(FINISHED_SPAWN_STATUSES))
            raise ValueError(f"invalid spawn finish status: {status}; expected one of {allowed}")

        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE child_spawns
                SET status = ?, last_polled_at = ?, final_summary = ?
                WHERE target_session = ? AND logical_key = ?
                """,
                (status, now_iso(), final_summary[:4000], target_session, logical_key),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"spawn claim not found: {target_session}:{logical_key}")

    def _validate_spawn_claim(self, *, logical_key: str, target_session: str, child_model: str) -> None:
        values = {
            "logical_key": logical_key,
            "target_session": target_session,
            "child_model": child_model,
        }
        for name, value in values.items():
            if not isinstance(value, str) or not value:
                raise ValueError(f"{name} must be a non-empty string")


def _todo_from_row(row: sqlite3.Row) -> TodoRecord:
    return TodoRecord(
        todo_id=str(row["todo_id"]),
        target_session=str(row["target_session"]),
        logical_key=str(row["logical_key"]),
        batch_key=str(row["batch_key"]) if row["batch_key"] else None,
        status=str(row["status"]),
        message=str(row["message"]),
        source=str(row["source"]),
    )


def _short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def _compact_time(value: str) -> str:
    return value.replace("-", "").replace(":", "").replace("+00:00", "Z")


def _seconds_between(start: str, end: str) -> float:
    start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    return max(0.0, (end_dt - start_dt).total_seconds())
