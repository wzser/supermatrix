from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
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
    source_session: str
    source_ref: str
    todo_type: str
    created_at: str


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

    @classmethod
    def open_existing(cls, path: Path) -> HeartbeatState:
        """Open an initialized state DB without rerunning schema migrations."""
        if not path.is_file():
            raise FileNotFoundError(path)
        state = cls.__new__(cls)
        state.path = path
        return state

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0)
        conn.execute("PRAGMA busy_timeout = 30000")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            try:
                conn.execute("PRAGMA journal_mode = WAL")
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
                      async_ref TEXT NOT NULL DEFAULT '',
                      spawn_comm_id TEXT NOT NULL DEFAULT '',
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
                    CREATE TABLE IF NOT EXISTS action_failures (
                      action_type TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      logical_key TEXT NOT NULL,
                      failure_count INTEGER NOT NULL DEFAULT 0,
                      last_failed_at TEXT NOT NULL,
                      cooldown_until TEXT,
                      last_error TEXT NOT NULL DEFAULT '',
                      PRIMARY KEY (action_type, target_session, logical_key)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS unrecovered_targets (
                      action_type TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      last_logical_key TEXT NOT NULL DEFAULT '',
                      failure_count INTEGER NOT NULL DEFAULT 0,
                      window_started_at TEXT NOT NULL,
                      last_failed_at TEXT NOT NULL,
                      last_error TEXT NOT NULL DEFAULT '',
                      last_escalated_at TEXT,
                      PRIMARY KEY (action_type, target_session)
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS unrecovered_escalation_handoffs (
                      handoff_id TEXT PRIMARY KEY,
                      escalation_event_id TEXT NOT NULL UNIQUE,
                      patrol_id TEXT,
                      owner_session TEXT NOT NULL DEFAULT 'heartbeat',
                      ledger_ref TEXT NOT NULL DEFAULT '',
                      action_type TEXT NOT NULL,
                      target_session TEXT NOT NULL,
                      logical_key TEXT NOT NULL,
                      failure_count INTEGER NOT NULL,
                      window_started_at TEXT NOT NULL,
                      error TEXT NOT NULL DEFAULT '',
                      created_at TEXT NOT NULL,
                      notify_status TEXT NOT NULL DEFAULT 'pending',
                      notify_message_id TEXT NOT NULL DEFAULT '',
                      notify_detail TEXT NOT NULL DEFAULT '',
                      notify_attempted_at TEXT,
                      status TEXT NOT NULL DEFAULT 'awaiting_delivery',
                      recovery_event_id TEXT NOT NULL DEFAULT '',
                      recovery_event_type TEXT NOT NULL DEFAULT '',
                      recovery_summary TEXT NOT NULL DEFAULT '',
                      recovery_at TEXT,
                      updated_at TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_unrecovered_handoffs_target_status
                      ON unrecovered_escalation_handoffs(action_type, target_session, status, updated_at)
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
                      feishu_synced_at TEXT,
                      feishu_ref TEXT,
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
                      source TEXT NOT NULL DEFAULT 'heartbeat',
                      provider_scope_key TEXT NOT NULL DEFAULT ''
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS provider_limit_pauses (
                      scope_key TEXT PRIMARY KEY,
                      status TEXT NOT NULL,
                      created_at TEXT NOT NULL,
                      updated_at TEXT NOT NULL,
                      expires_at TEXT NOT NULL,
                      reason TEXT NOT NULL DEFAULT '',
                      source TEXT NOT NULL DEFAULT 'heartbeat'
                    )
                    """
                )
                conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_provider_limit_pauses_status
                      ON provider_limit_pauses(status, expires_at)
                    """
                )
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS todo_aggregate_sync (
                      aggregate_key TEXT PRIMARY KEY,
                      row_hash TEXT NOT NULL DEFAULT '',
                      feishu_synced_at TEXT,
                      feishu_ref TEXT
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
                      trigger_source TEXT NOT NULL DEFAULT '',
                      trigger_cause TEXT NOT NULL DEFAULT '',
                      trigger_location TEXT NOT NULL DEFAULT '',
                      injected_message TEXT NOT NULL DEFAULT '',
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
                self._ensure_column(conn, "session_todos", "feishu_synced_at", "TEXT")
                self._ensure_column(conn, "session_todos", "feishu_ref", "TEXT")
                self._ensure_column(conn, "child_spawns", "async_ref", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "child_spawns", "spawn_comm_id", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "heartbeat_events", "trigger_source", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "heartbeat_events", "trigger_cause", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "heartbeat_events", "trigger_location", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "heartbeat_events", "injected_message", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(conn, "heartbeat_pauses", "provider_scope_key", "TEXT NOT NULL DEFAULT ''")
                self._ensure_column(
                    conn,
                    "unrecovered_escalation_handoffs",
                    "owner_session",
                    "TEXT NOT NULL DEFAULT 'heartbeat'",
                )
                self._ensure_column(
                    conn,
                    "unrecovered_escalation_handoffs",
                    "ledger_ref",
                    "TEXT NOT NULL DEFAULT ''",
                )
                self._ensure_column(
                    conn,
                    "unrecovered_targets",
                    "last_logical_key",
                    "TEXT NOT NULL DEFAULT ''",
                )
                conn.execute(
                    """
                    UPDATE unrecovered_escalation_handoffs
                    SET ledger_ref = 'unrecovered_escalation_handoffs/' || handoff_id
                    WHERE ledger_ref = ''
                    """
                )
                self._backfill_legacy_unrecovered_target_logical_keys(conn)
                self._backfill_legacy_unrecovered_handoffs(conn)
                self._backfill_legacy_handoff_recoveries(conn)
                self._migrate_cross_session_result_recoveries_to_accepted(conn)
                self._backfill_provider_pause_scope_keys(conn)
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

    def _ensure_column(self, conn: sqlite3.Connection, table_name: str, column_name: str, column_def: str) -> None:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        if any(str(row[1]) == column_name for row in rows):
            return
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")

    def _backfill_provider_pause_scope_keys(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            """
            SELECT session_name, reason, expires_at
            FROM heartbeat_pauses
            WHERE source = 'provider_limit_auto_pause' AND provider_scope_key = ''
            """
        ).fetchall()
        provider_rows = conn.execute(
            "SELECT scope_key, reason, expires_at FROM provider_limit_pauses"
        ).fetchall()
        provider_by_run: dict[tuple[str, str], str] = {}
        for scope_key, reason, expires_at in provider_rows:
            match = re.search(r"latest run ([^;\s]+)", str(reason or ""))
            if match:
                provider_by_run[(match.group(1), str(expires_at or ""))] = str(scope_key)
        for session_name, reason, expires_at in rows:
            reason_text = str(reason or "")
            scope_match = re.search(r"scope_key=([^;\s]+)", reason_text)
            scope_key = scope_match.group(1) if scope_match else ""
            if not scope_key:
                run_match = re.search(r"latest run ([^;\s]+)", reason_text)
                if run_match:
                    scope_key = provider_by_run.get((run_match.group(1), str(expires_at or "")), "")
            if scope_key:
                conn.execute(
                    "UPDATE heartbeat_pauses SET provider_scope_key = ? WHERE session_name = ?",
                    (scope_key, session_name),
                )

    def _backfill_legacy_unrecovered_handoffs(self, conn: sqlite3.Connection) -> None:
        """Expose pre-ledger escalations without fabricating a transport receipt for them."""
        rows = conn.execute(
            """
            SELECT event_id, patrol_id, target_session, logical_key, decision, summary, error, created_at
            FROM heartbeat_events
            WHERE event_type = 'unrecovered_item_escalated'
            ORDER BY created_at ASC, event_id ASC
            """
        ).fetchall()
        for row in rows:
            event_id = str(row[0])
            created_at = str(row[7])
            handoff_id = f"ueh_legacy_{event_id}"
            conn.execute(
                """
                INSERT OR IGNORE INTO unrecovered_escalation_handoffs (
                  handoff_id, escalation_event_id, patrol_id, owner_session, ledger_ref,
                  action_type, target_session, logical_key,
                  failure_count, window_started_at, error, created_at, notify_status, notify_detail,
                  status, recovery_summary, updated_at
                )
                VALUES (?, ?, ?, 'heartbeat', ?, ?, ?, ?, 0, ?, ?, ?, 'unverifiable',
                        'created before durable notification receipts', 'legacy_unverifiable', ?, ?)
                """,
                (
                    handoff_id,
                    event_id,
                    row[1],
                    f"unrecovered_escalation_handoffs/{handoff_id}",
                    str(row[4] or "legacy"),
                    str(row[2] or ""),
                    str(row[3] or ""),
                    created_at,
                    str(row[6] or ""),
                    created_at,
                    str(row[5] or ""),
                    created_at,
                ),
            )

    def _backfill_legacy_unrecovered_target_logical_keys(self, conn: sqlite3.Connection) -> None:
        """Attach a legacy aggregate only when its latest failed key is unambiguous.

        ``unrecovered_targets`` predates the per-aggregate logical-key field.  Its existing
        ``action_failures`` rows are the authoritative in-process evidence for a direct backfill;
        when they do not yield exactly one key, the row intentionally stays unlinked rather than
        guessing from a similar target, topic, or timestamp.
        """
        rows = conn.execute(
            """
            SELECT action_type, target_session, last_failed_at
            FROM unrecovered_targets
            WHERE last_logical_key = ''
            ORDER BY last_failed_at ASC, action_type ASC, target_session ASC
            """
        ).fetchall()
        for action_type, target_session, last_failed_at in rows:
            keys = conn.execute(
                """
                SELECT DISTINCT logical_key
                FROM action_failures
                WHERE action_type = ?
                  AND target_session = ?
                  AND last_failed_at = ?
                  AND logical_key != ''
                ORDER BY logical_key ASC
                """,
                (str(action_type), str(target_session), str(last_failed_at)),
            ).fetchall()
            if len(keys) != 1:
                continue
            conn.execute(
                """
                UPDATE unrecovered_targets
                SET last_logical_key = ?
                WHERE action_type = ?
                  AND target_session = ?
                  AND last_failed_at = ?
                  AND last_logical_key = ''
                """,
                (str(keys[0][0]), str(action_type), str(target_session), str(last_failed_at)),
            )

    def _backfill_legacy_handoff_recoveries(self, conn: sqlite3.Connection) -> None:
        """Attach independently verified target landing evidence to pre-ledger escalations.

        Old Console calls discarded their response bodies, so their transport can never be
        upgraded to delivered. A later verified owner run is separate recovery evidence.
        """
        rows = conn.execute(
            """
            SELECT handoff_id, target_session, logical_key, created_at
            FROM unrecovered_escalation_handoffs
            WHERE notify_status = 'unverifiable' AND status = 'legacy_unverifiable'
            ORDER BY created_at ASC, handoff_id ASC
            """
        ).fetchall()
        for handoff_id, target_session, logical_key, created_at in rows:
            recovery = conn.execute(
                """
                SELECT event_id, created_at, event_type, summary
                FROM heartbeat_events
                WHERE target_session = ?
                  AND logical_key = ?
                  AND created_at > ?
                  AND event_type = 'todo_landing_verified'
                ORDER BY created_at ASC, event_id ASC
                LIMIT 1
                """,
                (target_session, logical_key, created_at),
            ).fetchone()
            if recovery is None:
                continue
            conn.execute(
                """
                UPDATE unrecovered_escalation_handoffs
                SET status = 'recovered', recovery_event_id = ?, recovery_event_type = ?,
                    recovery_summary = ?, recovery_at = ?, updated_at = ?
                WHERE handoff_id = ?
                  AND notify_status = 'unverifiable'
                  AND status = 'legacy_unverifiable'
                """,
                (
                    str(recovery[0]),
                    str(recovery[2]),
                    str(recovery[3])[:4000],
                    str(recovery[1]),
                    now_iso(),
                    str(handoff_id),
                ),
            )

    def _migrate_cross_session_result_recoveries_to_accepted(self, conn: sqlite3.Connection) -> None:
        """Correct the short-lived legacy interpretation of a child result as business recovery.

        An exact, non-empty cross-session result proves that the target accepted and returned work,
        but its prose is not a machine-readable business-completion contract.  Keep the delivery
        receipt and result reference while representing that boundary as ``accepted``.
        """
        now = now_iso()
        suffix = "; accepted only, business recovery is not inferred"
        conn.execute(
            """
            UPDATE unrecovered_escalation_handoffs
            SET status = 'accepted',
                recovery_summary = CASE
                  WHEN instr(recovery_summary, 'accepted only') > 0 THEN recovery_summary
                  ELSE recovery_summary || ?
                END,
                updated_at = ?
            WHERE status = 'recovered'
              AND recovery_event_type = 'cross_session_result_linked'
            """,
            (suffix, now),
        )
        conn.execute(
            """
            UPDATE heartbeat_events
            SET status = 'accepted',
                summary = CASE
                  WHEN instr(summary, 'accepted only') > 0 THEN summary
                  ELSE summary || ?
                END
            WHERE status = 'completed'
              AND (
                (
                  trigger_source = 'cross_session_log'
                  AND event_type IN ('unrecovered_target_result_linked', 'unrecovered_handoff_result_linked')
                )
                OR (
                  event_type = 'unrecovered_target_reconciled'
                  AND trigger_cause = 'exact_cross_session_result'
                )
              )
            """,
            (suffix,),
        )

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
              async_ref TEXT NOT NULL DEFAULT '',
              spawn_comm_id TEXT NOT NULL DEFAULT '',
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

    def get_patrol_run(self, patrol_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT patrol_id, started_at, finished_at, status, sessions_scanned, items_detected,
                       alerts_sent, spawns_started, spawns_skipped_duplicate, errors
                FROM patrol_runs
                WHERE patrol_id = ?
                """,
                (patrol_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"patrol run not found: {patrol_id}")
        return dict(row)

    def completion_snapshot(self, *, landing_deadline_seconds: int) -> dict[str, Any]:
        """Return the compact, current health counts included in a patrol completion receipt."""
        if landing_deadline_seconds < 0:
            raise ValueError("landing_deadline_seconds must be non-negative")
        cutoff = _iso_seconds_before(now_iso(), landing_deadline_seconds)
        with self._connect() as conn:
            todo_rows = conn.execute(
                "SELECT status, COUNT(*) FROM session_todos GROUP BY status"
            ).fetchall()
            overdue_landing = conn.execute(
                """
                SELECT COUNT(*)
                FROM session_todos
                WHERE status = 'injected'
                  AND injected_at IS NOT NULL
                  AND injected_at <= ?
                """,
                (cutoff,),
            ).fetchone()[0]
            unrecovered = conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(failure_count), 0) FROM unrecovered_targets"
            ).fetchone()
            handoff_counts = conn.execute(
                """
                SELECT
                  COALESCE(SUM(CASE WHEN status = 'awaiting_acceptance' THEN 1 ELSE 0 END), 0),
                  COALESCE(SUM(CASE WHEN status = 'notify_failed' THEN 1 ELSE 0 END), 0),
                  COALESCE(SUM(CASE WHEN notify_status = 'unverifiable' THEN 1 ELSE 0 END), 0)
                FROM unrecovered_escalation_handoffs
                """
            ).fetchone()
            conn.row_factory = sqlite3.Row
            active_unrecovered = conn.execute(
                """
                SELECT action_type, target_session, last_logical_key, failure_count, last_failed_at, last_error
                FROM unrecovered_targets
                ORDER BY last_failed_at DESC, action_type ASC, target_session ASC
                LIMIT 20
                """
            ).fetchall()
            handoffs = conn.execute(
                """
                SELECT handoff_id, target_session, action_type, logical_key, error, created_at,
                       owner_session, ledger_ref,
                       notify_status, notify_message_id, notify_detail,
                       status, recovery_event_id, recovery_event_type, recovery_summary, recovery_at
                FROM unrecovered_escalation_handoffs
                ORDER BY updated_at DESC, handoff_id DESC
                LIMIT 20
                """
            ).fetchall()

        by_status = {str(status): int(count) for status, count in todo_rows}
        live = sum(by_status.get(status, 0) for status in ("pending", "claimed", "injected"))
        terminal = sum(
            by_status.get(status, 0)
            for status in ("completed", "failed", "cleared", "legacy_ignored", "cancelled")
        )
        return {
            "todos": {
                "live": live,
                "terminal": terminal,
                "over_sla_landing": int(overdue_landing),
            },
            "unrecovered": {
                "targets": int(unrecovered[0]),
                "failures": int(unrecovered[1]),
                "active": [
                    {
                        "action_type": str(row["action_type"]),
                        "target_session": str(row["target_session"]),
                        "last_logical_key": str(row["last_logical_key"]),
                        "failure_count": int(row["failure_count"]),
                        "last_failed_at": str(row["last_failed_at"]),
                        "last_error": str(row["last_error"]),
                        "reconciliation_condition": (
                            "awaiting_exact_target_result"
                            if str(row["last_logical_key"])
                            else "needs_unambiguous_logical_key_before_recovery"
                        ),
                    }
                    for row in active_unrecovered
                ],
            },
            "escalation_handoffs": {
                "awaiting_acceptance": int(handoff_counts[0]),
                "notify_failed": int(handoff_counts[1]),
                "legacy_unverifiable": int(handoff_counts[2]),
                "recent": [_handoff_receipt(dict(row)) for row in handoffs],
            },
        }

    def append_patrol_error(self, patrol_id: str, error: str) -> None:
        """Mark a terminal patrol failed when a required completion artifact fails afterward."""
        detail = str(error).strip()
        if not detail:
            raise ValueError("patrol completion error must be non-empty")
        with self._connect() as conn:
            row = conn.execute(
                "SELECT errors FROM patrol_runs WHERE patrol_id = ?",
                (patrol_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"patrol run not found: {patrol_id}")
            existing = str(row[0] or "")
            errors = existing if detail in existing.splitlines() else "\n".join(part for part in (existing, detail) if part)
            cursor = conn.execute(
                """
                UPDATE patrol_runs
                SET status = 'failed', errors = ?
                WHERE patrol_id = ? AND status IN ('completed', 'failed')
                """,
                (errors, patrol_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError(f"patrol run is not terminal: {patrol_id}")

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
        trigger_source: str = "",
        trigger_cause: str = "",
        trigger_location: str = "",
        injected_message: str = "",
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
                trigger_source=trigger_source,
                trigger_cause=trigger_cause,
                trigger_location=trigger_location,
                injected_message=injected_message,
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

    def list_unsynced_todos(self, *, limit: int) -> list[dict[str, Any]]:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT *
                FROM session_todos
                WHERE feishu_synced_at IS NULL
                ORDER BY created_at, todo_id
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_todos_synced(self, todo_ids: list[str], *, sync_ref: str) -> None:
        if not todo_ids:
            return
        with self._connect() as conn:
            conn.executemany(
                """
                UPDATE session_todos
                SET feishu_synced_at = ?, feishu_ref = COALESCE(NULLIF(feishu_ref, ''), ?)
                WHERE todo_id = ?
                """,
                [(now_iso(), sync_ref, todo_id) for todo_id in todo_ids],
            )

    def mark_todo_feishu_ref(self, *, todo_id: str, sync_ref: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE session_todos
                SET feishu_ref = ?
                WHERE todo_id = ?
                """,
                (sync_ref, todo_id),
            )

    def list_unsynced_todo_aggregates(self, *, limit: int) -> list[dict[str, Any]]:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        rows = self.list_todo_aggregates()
        unsynced: list[dict[str, Any]] = []
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            for row in rows:
                sync = conn.execute(
                    """
                    SELECT row_hash, feishu_ref
                    FROM todo_aggregate_sync
                    WHERE aggregate_key = ?
                    """,
                    (row["aggregate_key"],),
                ).fetchone()
                row["feishu_ref"] = str(sync["feishu_ref"] or "") if sync else ""
                if sync is None or str(sync["row_hash"] or "") != row["row_hash"]:
                    unsynced.append(row)
                if len(unsynced) >= limit:
                    break
        return unsynced

    def list_todo_aggregates(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT *
                FROM session_todos
                ORDER BY created_at, logical_key, todo_id
                """
            ).fetchall()
        groups: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            item = dict(row)
            aggregate_key = str(item.get("source_ref") or item.get("logical_key") or item.get("todo_id"))
            groups.setdefault(aggregate_key, []).append(item)
        return [_todo_aggregate_from_items(key, items) for key, items in sorted(groups.items())]

    def mark_todo_aggregates_synced(self, aggregates: list[dict[str, Any]], *, sync_ref: str) -> None:
        if not aggregates:
            return
        now = now_iso()
        with self._connect() as conn:
            conn.executemany(
                """
                INSERT INTO todo_aggregate_sync (aggregate_key, row_hash, feishu_synced_at, feishu_ref)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(aggregate_key) DO UPDATE SET
                  row_hash = excluded.row_hash,
                  feishu_synced_at = excluded.feishu_synced_at,
                  feishu_ref = COALESCE(NULLIF(todo_aggregate_sync.feishu_ref, ''), excluded.feishu_ref)
                """,
                [
                    (
                        str(row["aggregate_key"]),
                        str(row["row_hash"]),
                        now,
                        sync_ref,
                    )
                    for row in aggregates
                ],
            )

    def mark_todo_aggregate_feishu_ref(self, *, aggregate_key: str, sync_ref: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO todo_aggregate_sync (aggregate_key, feishu_ref)
                VALUES (?, ?)
                ON CONFLICT(aggregate_key) DO UPDATE SET feishu_ref = excluded.feishu_ref
                """,
                (aggregate_key, sync_ref),
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

    def reconcile_stale_action_claims(self, *, max_age_minutes: int) -> list[dict[str, Any]]:
        """Mark crash-orphaned synchronous action claims failed so claimed rows do not live forever."""
        if max_age_minutes <= 0:
            return []
        now = now_iso()
        cutoff = _iso_seconds_before(now, max_age_minutes * 60)
        detail = f"auto-reconciled: claimed action exceeded {max_age_minutes}m SLA"
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT action_type, target_session, logical_key, created_at
                FROM action_claims
                WHERE status = 'claimed' AND created_at < ?
                ORDER BY created_at ASC
                """,
                (cutoff,),
            ).fetchall()
            if rows:
                conn.execute(
                    """
                    UPDATE action_claims
                    SET status = 'failed', finished_at = ?, detail = ?
                    WHERE status = 'claimed' AND created_at < ?
                    """,
                    (now, detail, cutoff),
                )
        return [dict(row) for row in rows]

    def list_action_claims_for_cross_session_reconcile(self, *, limit: int = 500) -> list[dict[str, Any]]:
        """Action claims whose logical key may point at a completed cross-session comm.

        Includes already-failed rows so a prior POST timeout that later completed in
        cross_session_log can be corrected instead of remaining false-negative evidence.
        """
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT action_type, target_session, logical_key, status, created_at
                FROM action_claims
                WHERE status IN ('claimed', 'failed')
                  AND logical_key LIKE '%comm_%'
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (max(1, limit),),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_action_claims_completed_from_cross_session(
        self, *, claims: list[dict[str, Any]], detail_by_logical_key: dict[str, str]
    ) -> list[dict[str, Any]]:
        if not claims:
            return []
        finished_at = now_iso()
        completed: list[dict[str, Any]] = []
        with self._connect() as conn:
            for claim in claims:
                logical_key = str(claim.get("logical_key") or "")
                detail = detail_by_logical_key.get(logical_key)
                if not detail:
                    continue
                cursor = conn.execute(
                    """
                    UPDATE action_claims
                    SET status = 'completed',
                        finished_at = ?,
                        detail = ?
                    WHERE action_type = ?
                      AND target_session = ?
                      AND logical_key = ?
                      AND status IN ('claimed', 'failed')
                    """,
                    (
                        finished_at,
                        detail[:4000],
                        str(claim.get("action_type") or ""),
                        str(claim.get("target_session") or ""),
                        logical_key,
                    ),
                )
                if cursor.rowcount:
                    completed.append(dict(claim))
        return completed

    def purge_old_events(self, *, retention_days: int) -> int:
        """Delete heartbeat_events older than the retention window. 0 disables purging."""
        if retention_days <= 0:
            return 0
        cutoff = _iso_seconds_before(now_iso(), retention_days * 86400)
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM heartbeat_events WHERE created_at < ?", (cutoff,))
        return cursor.rowcount

    def record_action_failure(
        self,
        *,
        action_type: str,
        target_session: str,
        logical_key: str,
        error: str = "",
        threshold: int,
        cooldown_minutes: int,
    ) -> dict[str, Any]:
        """Count consecutive failures; at threshold, open a cooldown window (poison-pill)."""
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO action_failures
                  (action_type, target_session, logical_key, failure_count, last_failed_at, last_error)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(action_type, target_session, logical_key) DO UPDATE SET
                  failure_count = failure_count + 1,
                  last_failed_at = excluded.last_failed_at,
                  last_error = excluded.last_error
                """,
                (action_type, target_session, logical_key, now, error[:1000]),
            )
            row = conn.execute(
                """
                SELECT failure_count FROM action_failures
                WHERE action_type = ? AND target_session = ? AND logical_key = ?
                """,
                (action_type, target_session, logical_key),
            ).fetchone()
            failure_count = int(row[0])
            cooldown_until = None
            if cooldown_minutes > 0 and failure_count >= threshold:
                cooldown_until = _iso_seconds_after(now, cooldown_minutes * 60)
                conn.execute(
                    """
                    UPDATE action_failures
                    SET cooldown_until = ?
                    WHERE action_type = ? AND target_session = ? AND logical_key = ?
                    """,
                    (cooldown_until, action_type, target_session, logical_key),
                )
        return {"failure_count": failure_count, "cooldown_until": cooldown_until}

    def clear_action_failures(self, *, action_type: str, target_session: str, logical_key: str) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                DELETE FROM action_failures
                WHERE action_type = ? AND target_session = ? AND logical_key = ?
                """,
                (action_type, target_session, logical_key),
            )

    def record_unrecovered_target(
        self,
        *,
        action_type: str,
        target_session: str,
        logical_key: str,
        error: str = "",
        threshold: int,
        window_minutes: int,
        reescalate_minutes: int,
    ) -> dict[str, Any]:
        """Aggregate action failures per (action_type, target_session) across churning logical_keys.

        The per-logical_key poison-pill (``record_action_failure``) never trips when the controller
        mints a fresh ``logical_key`` each patrol for the same stuck target, so a genuinely stuck
        session keeps failing the same way while every failure counts as 1 and no cooldown/escalation
        ever fires. This target-scoped counter closes that gap: it counts distinct failed attempts
        inside a rolling ``window_minutes`` window and signals an escalation once the target reaches
        ``threshold``, rate-limited to at most once per ``reescalate_minutes``.

        ``logical_key`` is the latest failed attempt's exact identity.  The aggregate may only be
        reconciled by a receipt that carries this same key; target/session resemblance is not a
        recovery proof.

        Returns ``{failure_count, escalate, window_started_at, logical_key}``. ``escalate`` is True
        on exactly the recorded failure that crosses the threshold within an allowed re-escalation
        window.
        """
        if not isinstance(logical_key, str) or not logical_key.strip():
            raise ValueError("logical_key must be non-empty")
        now = now_iso()
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT failure_count, window_started_at, last_escalated_at
                FROM unrecovered_targets
                WHERE action_type = ? AND target_session = ?
                """,
                (action_type, target_session),
            ).fetchone()
            if row is None:
                failure_count = 1
                window_started_at = now
                last_escalated_at = None
            else:
                window_started_at = str(row[1])
                last_escalated_at = row[2]
                window_expired = window_minutes > 0 and now >= _iso_seconds_after(
                    window_started_at, window_minutes * 60
                )
                if window_expired:
                    failure_count = 1
                    window_started_at = now
                else:
                    failure_count = int(row[0]) + 1

            escalate = False
            if threshold > 0 and failure_count >= threshold:
                if (
                    last_escalated_at is None
                    or reescalate_minutes <= 0
                    or now >= _iso_seconds_after(str(last_escalated_at), reescalate_minutes * 60)
                ):
                    escalate = True
                    last_escalated_at = now

            conn.execute(
                """
                INSERT INTO unrecovered_targets
                  (action_type, target_session, last_logical_key, failure_count, window_started_at,
                   last_failed_at, last_error, last_escalated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(action_type, target_session) DO UPDATE SET
                  last_logical_key = excluded.last_logical_key,
                  failure_count = excluded.failure_count,
                  window_started_at = excluded.window_started_at,
                  last_failed_at = excluded.last_failed_at,
                  last_error = excluded.last_error,
                  last_escalated_at = excluded.last_escalated_at
                """,
                (
                    action_type,
                    target_session,
                    logical_key.strip(),
                    failure_count,
                    window_started_at,
                    now,
                    error[:1000],
                    last_escalated_at,
                ),
            )
        return {
            "failure_count": failure_count,
            "escalate": escalate,
            "window_started_at": window_started_at,
            "logical_key": logical_key.strip(),
        }

    def claim_unrecovered_targets_due_for_age_escalation(
        self,
        *,
        max_unreconciled_hours: int,
        reescalate_minutes: int,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Atomically claim unresolved episodes that outlived the age fallback.

        This path intentionally does not call :meth:`record_unrecovered_target`: a sparse or stopped
        failure stream must retain its original ``failure_count`` and ``last_failed_at``.  Claiming
        only advances ``last_escalated_at`` so normal exact-key reconciliation remains authoritative.
        """
        if max_unreconciled_hours <= 0:
            return []
        now = now_iso()
        age_cutoff = _iso_seconds_before(now, max_unreconciled_hours * 60 * 60)
        reescalate_cutoff = _iso_seconds_before(now, max(0, reescalate_minutes) * 60)
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT action_type, target_session, last_logical_key AS logical_key, failure_count,
                       window_started_at, last_failed_at, last_error, last_escalated_at
                FROM unrecovered_targets
                WHERE window_started_at <= ?
                  AND (
                    last_escalated_at IS NULL
                    OR ? <= 0
                    OR last_escalated_at <= ?
                  )
                ORDER BY window_started_at ASC, target_session ASC, action_type ASC
                LIMIT ?
                """,
                (age_cutoff, reescalate_minutes, reescalate_cutoff, max(1, limit)),
            ).fetchall()
            claimed: list[dict[str, Any]] = []
            for row in rows:
                cursor = conn.execute(
                    """
                    UPDATE unrecovered_targets
                    SET last_escalated_at = ?
                    WHERE action_type = ?
                      AND target_session = ?
                      AND window_started_at = ?
                      AND last_logical_key = ?
                      AND (
                        last_escalated_at IS NULL
                        OR ? <= 0
                        OR last_escalated_at <= ?
                      )
                    """,
                    (
                        now,
                        str(row["action_type"]),
                        str(row["target_session"]),
                        str(row["window_started_at"]),
                        str(row["logical_key"]),
                        reescalate_minutes,
                        reescalate_cutoff,
                    ),
                )
                if cursor.rowcount != 1:
                    continue
                outcome = dict(row)
                outcome["escalate"] = True
                outcome["escalation_reason"] = "max_age"
                outcome["max_unreconciled_hours"] = max_unreconciled_hours
                outcome["last_escalated_at"] = now
                claimed.append(outcome)
        return claimed

    def record_unrecovered_escalation_handoff(
        self,
        *,
        escalation_event_id: str,
        patrol_id: str,
        action_type: str,
        target_session: str,
        logical_key: str,
        failure_count: int,
        window_started_at: str,
        error: str,
    ) -> str:
        """Open one durable handoff record for one escalation event before notification starts."""
        required = {
            "escalation_event_id": escalation_event_id,
            "action_type": action_type,
            "target_session": target_session,
            "logical_key": logical_key,
            "window_started_at": window_started_at,
        }
        for name, value in required.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{name} must be non-empty")
        if failure_count < 1:
            raise ValueError("failure_count must be >= 1")
        now = now_iso()
        handoff_id = f"ueh_{uuid.uuid4().hex[:16]}"
        ledger_ref = f"unrecovered_escalation_handoffs/{handoff_id}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO unrecovered_escalation_handoffs (
                  handoff_id, escalation_event_id, patrol_id, owner_session, ledger_ref,
                  action_type, target_session, logical_key,
                  failure_count, window_started_at, error, created_at, updated_at
                )
                VALUES (?, ?, ?, 'heartbeat', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(escalation_event_id) DO NOTHING
                """,
                (
                    handoff_id,
                    escalation_event_id,
                    patrol_id or None,
                    ledger_ref,
                    action_type,
                    target_session,
                    logical_key,
                    failure_count,
                    window_started_at,
                    error[:4000],
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT handoff_id FROM unrecovered_escalation_handoffs WHERE escalation_event_id = ?",
                (escalation_event_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"escalation handoff was not recorded: {escalation_event_id}")
        return str(row[0])

    def record_unrecovered_handoff_transport(
        self,
        *,
        handoff_id: str,
        status: str,
        message_id: str,
        detail: str,
    ) -> None:
        if status not in {"delivered", "degraded", "failed"}:
            raise ValueError("handoff transport status must be delivered, degraded, or failed")
        if status in {"delivered", "degraded"} and not message_id:
            raise ValueError("successful handoff transport requires message_id")
        now = now_iso()
        next_status = "awaiting_acceptance" if status in {"delivered", "degraded"} else "notify_failed"
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE unrecovered_escalation_handoffs
                SET notify_status = ?, notify_message_id = ?, notify_detail = ?, notify_attempted_at = ?,
                    status = ?, updated_at = ?
                WHERE handoff_id = ? AND status = 'awaiting_delivery' AND notify_status = 'pending'
                """,
                (status, message_id[:500], detail[:4000], now, next_status, now, handoff_id),
            )
        if cursor.rowcount != 1:
            raise RuntimeError(f"handoff transport is not pending: {handoff_id}")

    def resolve_unrecovered_target(
        self,
        *,
        action_type: str,
        target_session: str,
        logical_key: str,
        recovery_status: str,
        recovery_event_id: str,
        recovery_event_type: str,
        recovery_summary: str,
    ) -> dict[str, Any]:
        """Record an exact-key recovery receipt and transition only its matching state.

        A target may accumulate unrelated failures under changing controller keys.  The compare on
        ``last_logical_key`` is therefore part of the state transition, not just diagnostic data:
        a result for another key cannot delete the current aggregate or mark its handoff accepted.
        """
        if recovery_status not in {"accepted", "recovered"}:
            raise ValueError("recovery_status must be accepted or recovered")
        if not recovery_event_id or not recovery_event_type or not logical_key:
            raise ValueError("logical_key and recovery event id/type must be non-empty")
        now = now_iso()
        with self._connect() as conn:
            aggregate_cursor = conn.execute(
                """
                DELETE FROM unrecovered_targets
                WHERE action_type = ?
                  AND target_session = ?
                  AND last_logical_key = ?
                """,
                (action_type, target_session, logical_key),
            )
            rows = conn.execute(
                """
                SELECT handoff_id
                FROM unrecovered_escalation_handoffs
                WHERE target_session = ?
                  AND logical_key = ?
                  AND status IN ('awaiting_delivery', 'awaiting_acceptance', 'notify_failed', 'legacy_unverifiable')
                """,
                (target_session, logical_key),
            ).fetchall()
            handoff_ids = [str(row[0]) for row in rows]
            if handoff_ids:
                placeholders = ",".join("?" for _ in handoff_ids)
                conn.execute(
                    f"""
                    UPDATE unrecovered_escalation_handoffs
                    SET status = ?, recovery_event_id = ?, recovery_event_type = ?,
                        recovery_summary = ?, recovery_at = ?, updated_at = ?
                    WHERE handoff_id IN ({placeholders})
                      AND status IN ('awaiting_delivery', 'awaiting_acceptance', 'notify_failed', 'legacy_unverifiable')
                    """,
                    (
                        recovery_status,
                        recovery_event_id,
                        recovery_event_type,
                        recovery_summary[:4000],
                        now,
                        now,
                        *handoff_ids,
                    ),
                )
        return {
            "aggregate_resolved": aggregate_cursor.rowcount == 1,
            "handoff_ids": handoff_ids,
        }

    def clear_unrecovered_target(self, *, action_type: str, target_session: str) -> None:
        """Reset the target-scoped failure aggregate after a genuine advancement for this target."""
        with self._connect() as conn:
            conn.execute(
                """
                DELETE FROM unrecovered_targets
                WHERE action_type = ? AND target_session = ?
                """,
                (action_type, target_session),
            )

    def list_unrecovered_targets_for_result_reconcile(self, *, limit: int = 500) -> list[dict[str, Any]]:
        """Return active spawn aggregates that have an exact key to verify against target output."""
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT action_type, target_session, last_logical_key AS logical_key, last_failed_at
                FROM unrecovered_targets
                WHERE action_type = 'spawn'
                  AND last_logical_key != ''
                ORDER BY last_failed_at ASC, target_session ASC
                LIMIT ?
                """,
                (max(1, limit),),
            ).fetchall()
        return [dict(row) for row in rows]

    def list_legacy_handoffs_for_result_reconcile(self, *, limit: int = 500) -> list[dict[str, Any]]:
        """Return old handoffs whose transport is unknowable but whose exact result can still recover them."""
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT handoff_id, action_type, target_session, logical_key, created_at
                FROM unrecovered_escalation_handoffs
                WHERE notify_status = 'unverifiable'
                  AND status = 'legacy_unverifiable'
                  AND logical_key != ''
                ORDER BY created_at ASC, handoff_id ASC
                LIMIT ?
                """,
                (max(1, limit),),
            ).fetchall()
        return [dict(row) for row in rows]

    def reconcile_unrecovered_targets_from_later_events(
        self,
        *,
        limit: int = 500,
    ) -> list[dict[str, Any]]:
        """Clear stale target aggregates when later heartbeat action evidence shows advancement.

        This is deliberately event- and key-based: it only clears a row with a concrete recovery
        action after the failed action *and* the recovery carries the aggregate's exact
        ``last_logical_key``.  A controller ``session_decision`` (including ``items=0``), a
        similarly named task, or an expired counting window is observation only, never recovery
        evidence.
        """
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            targets = conn.execute(
                """
                SELECT action_type, target_session, last_logical_key, failure_count, window_started_at, last_failed_at
                FROM unrecovered_targets
                ORDER BY last_failed_at ASC
                LIMIT ?
                """,
                (max(1, limit),),
            ).fetchall()
            reconciled: list[dict[str, Any]] = []
            for target in targets:
                logical_key = str(target["last_logical_key"] or "")
                if not logical_key:
                    continue
                recovery = conn.execute(
                    """
                    SELECT event_id, created_at, event_type, status, summary
                    FROM heartbeat_events
                    WHERE target_session = ?
                      AND logical_key = ?
                      AND created_at > ?
                      AND (
                        event_type = 'todo_landing_verified'
                        OR (
                          ? = 'user_resume'
                          AND event_type = 'user_resume_sent'
                        )
                        OR (
                          ? = 'spawn'
                          AND event_type = 'spawn_started'
                          AND COALESCE(status, '') NOT IN ('failed', 'cancelled', 'timeout')
                        )
                      )
                    ORDER BY created_at ASC
                    LIMIT 1
                    """,
                    (
                        str(target["target_session"]),
                        logical_key,
                        str(target["last_failed_at"]),
                        str(target["action_type"]),
                        str(target["action_type"]),
                    ),
                ).fetchone()
                if recovery is not None:
                    recovery_event_id = str(recovery["event_id"])
                    recovery_created_at = recovery["created_at"]
                    recovery_event_type = recovery["event_type"]
                    recovery_status = "recovered" if recovery_event_type == "todo_landing_verified" else "accepted"
                    recovery_summary = recovery["summary"]
                else:
                    continue
                cursor = conn.execute(
                    """
                    DELETE FROM unrecovered_targets
                    WHERE action_type = ?
                      AND target_session = ?
                      AND last_logical_key = ?
                      AND last_failed_at = ?
                    """,
                    (
                        str(target["action_type"]),
                        str(target["target_session"]),
                        logical_key,
                        str(target["last_failed_at"]),
                    ),
                )
                if cursor.rowcount:
                    handoff_ids: list[str] = []
                    handoff_rows = conn.execute(
                        """
                        SELECT handoff_id
                        FROM unrecovered_escalation_handoffs
                        WHERE target_session = ?
                          AND logical_key = ?
                          AND status IN ('awaiting_delivery', 'awaiting_acceptance', 'notify_failed', 'legacy_unverifiable')
                        """,
                        (str(target["target_session"]), logical_key),
                    ).fetchall()
                    handoff_ids = [str(handoff[0]) for handoff in handoff_rows]
                    if handoff_ids:
                        placeholders = ",".join("?" for _ in handoff_ids)
                        now = now_iso()
                        conn.execute(
                            f"""
                            UPDATE unrecovered_escalation_handoffs
                            SET status = ?, recovery_event_id = ?, recovery_event_type = ?,
                                recovery_summary = ?, recovery_at = ?, updated_at = ?
                            WHERE handoff_id IN ({placeholders})
                              AND status IN ('awaiting_delivery', 'awaiting_acceptance', 'notify_failed', 'legacy_unverifiable')
                            """,
                            (
                                recovery_status,
                                recovery_event_id,
                                recovery_event_type,
                                str(recovery_summary)[:4000],
                                now,
                                now,
                                *handoff_ids,
                            ),
                        )
                    row = dict(target)
                    row["logical_key"] = logical_key
                    row["recovery_event_id"] = recovery_event_id
                    row["recovery_created_at"] = recovery_created_at
                    row["recovery_event_type"] = recovery_event_type
                    row["recovery_status"] = recovery_status
                    row["recovery_summary"] = recovery_summary
                    row["handoff_ids"] = handoff_ids
                    reconciled.append(row)
        return reconciled

    def action_in_cooldown(self, *, action_type: str, target_session: str, logical_key: str) -> str | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT cooldown_until FROM action_failures
                WHERE action_type = ? AND target_session = ? AND logical_key = ?
                """,
                (action_type, target_session, logical_key),
            ).fetchone()
        if row is None or not row[0]:
            return None
        cooldown_until = str(row[0])
        if now_iso() >= cooldown_until:
            return None
        return cooldown_until

    def try_claim_todo_watch(self, *, target_session: str, stale_after_seconds: int) -> bool:
        """Claim the per-session todo watch singleton; stale claims are taken over."""
        now = now_iso()
        cutoff = _iso_seconds_before(now, stale_after_seconds)
        with self._connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO action_claims (action_type, target_session, logical_key, status, created_at)
                    VALUES ('todo_watch', ?, 'watch', 'claimed', ?)
                    """,
                    (target_session, now),
                )
                return True
            except sqlite3.IntegrityError:
                cursor = conn.execute(
                    """
                    UPDATE action_claims
                    SET status = 'claimed', created_at = ?, finished_at = NULL, detail = ''
                    WHERE action_type = 'todo_watch' AND target_session = ? AND logical_key = 'watch'
                      AND created_at < ?
                    """,
                    (now, target_session, cutoff),
                )
                return cursor.rowcount == 1

    def todo_watch_claim_active(self, target_session: str, *, stale_after_seconds: int) -> bool:
        cutoff = _iso_seconds_before(now_iso(), stale_after_seconds)
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT 1
                FROM action_claims
                WHERE action_type = 'todo_watch' AND target_session = ? AND logical_key = 'watch'
                  AND created_at >= ?
                """,
                (target_session, cutoff),
            ).fetchone()
        return row is not None

    def release_todo_watch(self, target_session: str) -> None:
        self.release_action_claim(
            action_type="todo_watch", target_session=target_session, logical_key="watch"
        )

    def record_self_spawn_closure(
        self,
        *,
        heartbeat_session: str,
        logical_key: str,
        message: str,
        source: str = "heartbeat",
        source_session: str = "",
    ) -> dict[str, Any]:
        """Record a late child result addressed to heartbeat itself instead of rejecting it.

        heartbeat 自己 spawn 的 child（composer/controller/bounded follow-up）超出同步窗口后，
        框架会把结果按 spawn_closure 投回 target=heartbeat；heartbeat 不在心跳覆盖范围内，
        以前一律拒绝导致结果丢失 + 框架无限复读。现在按 comm id 匹配 child_spawns 收口，
        匹配不到（composer/controller child 不进 child_spawns）也接受落事件，返回终态止住复读。
        """
        logical_key = logical_key.strip()
        if not logical_key:
            raise ValueError("logical_key must be non-empty")
        if not self.try_claim_action(
            action_type="self_spawn_closure",
            target_session=heartbeat_session,
            logical_key=logical_key,
        ):
            return {"status": "duplicate"}
        matched_target = ""
        matched_logical_key = ""
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT target_session, logical_key, status FROM child_spawns WHERE spawn_comm_id = ?",
                (logical_key,),
            ).fetchone()
            if row is not None and str(row["status"]) == "running":
                cursor = conn.execute(
                    """
                    UPDATE child_spawns
                    SET status = 'completed', last_polled_at = ?, final_summary = ?
                    WHERE spawn_comm_id = ? AND status = 'running'
                    """,
                    (now_iso(), message[:4000], logical_key),
                )
                if cursor.rowcount == 1:
                    matched_target = str(row["target_session"])
                    matched_logical_key = str(row["logical_key"])
        matched = bool(matched_target)
        summary_parts = [f"source={source or ''}", f"source_session={source_session or ''}"]
        if matched:
            summary_parts.append(f"closed_spawn={matched_target}:{matched_logical_key}")
        else:
            summary_parts.append("no matching child_spawns row (composer/controller child or already closed)")
        summary_parts.append(f"message_head={message[:200]}")
        self.log_event(
            event_type="self_spawn_closure_recorded",
            target_session=heartbeat_session,
            logical_key=logical_key,
            status="completed" if matched else "unmatched",
            summary="; ".join(summary_parts),
            trigger_source="todo_pool",
            trigger_cause="spawn_closure",
            trigger_location=heartbeat_session,
            source=source,
        )
        result: dict[str, Any] = {"status": "recorded", "matched": matched}
        if matched:
            result["closed_target_session"] = matched_target
            result["closed_logical_key"] = matched_logical_key
        return result

    def has_claimable_todo(
        self,
        target_session: str,
        *,
        todo_types: set[str] | None = None,
        target_idle: bool = False,
    ) -> bool:
        """Read-only twin of claim_next_todo_batch: would a claim succeed right now?

        ``target_idle=True`` 让调用方表达「我已经把 target 验证成 idle，不要再让 settle/max_wait
        阻塞 batch 投递」——只跳过时间窗 gate，显式 ``expected_count`` 仍需满足。
        """
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            if (
                self._find_ready_batch(
                    conn,
                    target_session=target_session,
                    now=now,
                    todo_types=todo_types,
                    target_idle=target_idle,
                )
                is not None
            ):
                return True
            single_where = ["target_session = ?", "status = 'pending'", "batch_key IS NULL"]
            single_params: list[Any] = [target_session]
            if todo_types:
                placeholders = ",".join("?" for _ in todo_types)
                single_where.append(f"todo_type IN ({placeholders})")
                single_params.extend(sorted(todo_types))
            row = conn.execute(
                "SELECT 1 FROM session_todos WHERE {where} LIMIT 1".format(where=" AND ".join(single_where)),
                tuple(single_params),
            ).fetchone()
        return row is not None

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
                    trigger_source="todo_pool",
                    trigger_cause=todo_type,
                    trigger_location=target_session,
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
                    trigger_source="todo_pool",
                    trigger_cause=todo_type,
                    trigger_location=target_session,
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
                trigger_source="todo_pool",
                trigger_cause=todo_type,
                trigger_location=target_session,
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

    def pending_batch_waits_for_session(
        self,
        target_session: str,
        *,
        todo_types: set[str] | None = None,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        if limit < 1:
            raise ValueError("limit must be >= 1")
        now = now_iso()
        where = [
            "target_session = ?",
            "status = 'open'",
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
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT batch_key, target_session, source_session, source_ref, todo_type,
                       created_at, last_item_at, settle_after_seconds, max_wait_seconds,
                       expected_count, item_count
                FROM todo_batches
                WHERE {where}
                ORDER BY created_at, batch_key
                LIMIT ?
                """.format(where=" AND ".join(where)),
                (*params, limit),
            ).fetchall()
        waits: list[dict[str, Any]] = []
        for row in rows:
            item_count = int(row["item_count"])
            expected_count = row["expected_count"]
            settle_after_seconds = int(row["settle_after_seconds"])
            max_wait_seconds = int(row["max_wait_seconds"])
            since_last_item_seconds = int(_seconds_between(str(row["last_item_at"]), now))
            since_created_seconds = int(_seconds_between(str(row["created_at"]), now))
            expected_remaining = None
            if expected_count is not None:
                expected_remaining = max(0, int(expected_count) - item_count)
            waits.append(
                {
                    "batch_key": str(row["batch_key"]),
                    "target_session": str(row["target_session"]),
                    "source_session": str(row["source_session"] or ""),
                    "source_ref": str(row["source_ref"] or ""),
                    "todo_type": str(row["todo_type"] or ""),
                    "created_at": str(row["created_at"]),
                    "last_item_at": str(row["last_item_at"]),
                    "item_count": item_count,
                    "expected_count": int(expected_count) if expected_count is not None else None,
                    "expected_remaining": expected_remaining,
                    "settle_after_seconds": settle_after_seconds,
                    "max_wait_seconds": max_wait_seconds,
                    "seconds_until_settle": max(0, settle_after_seconds - since_last_item_seconds),
                    "seconds_until_max_wait": max(0, max_wait_seconds - since_created_seconds),
                }
            )
        return waits

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
        self,
        *,
        target_session: str,
        todo_types: set[str] | None = None,
        target_idle: bool = False,
    ) -> TodoBatchClaim | None:
        claimed_at = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            batch = self._find_ready_batch(
                conn,
                target_session=target_session,
                now=claimed_at,
                todo_types=todo_types,
                target_idle=target_idle,
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
                    SET status = 'claimed', claimed_at = ?, feishu_synced_at = NULL
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
                SET status = 'claimed', claimed_at = ?, feishu_synced_at = NULL
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
        target_idle: bool = False,
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
            if _seconds_between(str(row["created_at"]), now) >= int(row["max_wait_seconds"]):
                return row
            # target_idle=True 表示调用方已经验过 target idle：没必要再让 settle 拖住投递。
            # 但 expected_count 是显式同步意图，没到位仍按上面的 max_wait backstop 处理。
            if target_idle and expected_count is None:
                return row
            if _seconds_between(str(row["last_item_at"]), now) >= int(row["settle_after_seconds"]):
                return row
        return None

    def mark_todos_injected(self, *, todo_ids: list[str], detail: str) -> None:
        self._mark_todos_finished(todo_ids=todo_ids, status="injected", detail=detail, injected=True)

    def mark_todos_failed(self, *, todo_ids: list[str], detail: str) -> None:
        self._mark_todos_finished(todo_ids=todo_ids, status="failed", detail=detail, injected=False)

    def mark_todos_cleared(self, *, todo_ids: list[str], detail: str) -> None:
        self._mark_todos_finished(todo_ids=todo_ids, status="cleared", detail=detail, injected=False)

    def list_injected_todos_for_landing_check(
        self, *, min_age_seconds: int, max_age_seconds: int, limit: int = 200
    ) -> list[dict[str, Any]]:
        """Injected todos whose landing has not yet been confirmed.

        `injected` means heartbeat successfully called send_user_message — proof we
        *triggered* delivery, not proof a run *landed* in the owner session. Returns
        todos injected between (now - max_age) and (now - min_age): old enough for a run
        to have appeared, young enough that message_runs history still covers them.
        """
        now = now_iso()
        newest = _iso_seconds_before(now, max(0, min_age_seconds))
        oldest = _iso_seconds_before(now, max(0, max_age_seconds))
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT todo_id, target_session, logical_key, injected_at
                FROM session_todos
                WHERE status = 'injected'
                  AND injected_at IS NOT NULL
                  AND injected_at <= ?
                  AND injected_at >= ?
                ORDER BY injected_at ASC
                LIMIT ?
                """,
                (newest, oldest, max(1, limit)),
            ).fetchall()
        return [dict(row) for row in rows]

    def mark_todos_landing_verified(self, *, todo_ids: list[str], detail: str) -> int:
        """Promote confirmed-landed injected todos to `completed`. Race-safe on status."""
        return self._transition_injected_todos(todo_ids=todo_ids, status="completed", detail=detail)

    def mark_todos_landing_unconfirmed(self, *, todo_ids: list[str], detail: str) -> int:
        """Mark injected todos with no observed landing run as `failed` (queryable, not silently lost)."""
        return self._transition_injected_todos(todo_ids=todo_ids, status="failed", detail=detail)

    def archive_legacy_injected_todos(self, *, before: str, limit: int = 5000) -> list[dict[str, Any]]:
        """Move pre-verifier injected todos to a terminal legacy bucket.

        These rows predate message_run landing verification, so heartbeat cannot
        mechanically prove whether they landed. Keeping them as `injected` makes
        current health checks indistinguishable from live unverified delivery.
        """
        finished_at = now_iso()
        detail = f"legacy_ignored: injected before {before}; landing cannot be mechanically proven"
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT todo_id, target_session, logical_key, injected_at
                FROM session_todos
                WHERE status = 'injected'
                  AND injected_at IS NOT NULL
                  AND injected_at < ?
                ORDER BY injected_at ASC
                LIMIT ?
                """,
                (before, max(1, limit)),
            ).fetchall()
            if rows:
                todo_ids = [str(row["todo_id"]) for row in rows]
                placeholders = ",".join("?" for _ in todo_ids)
                conn.execute(
                    f"""
                    UPDATE session_todos
                    SET status = 'legacy_ignored',
                        finished_at = ?,
                        detail = ?,
                        feishu_synced_at = NULL
                    WHERE status = 'injected'
                      AND todo_id IN ({placeholders})
                    """,
                    (finished_at, detail, *todo_ids),
                )
        return [dict(row) for row in rows]

    def _transition_injected_todos(self, *, todo_ids: list[str], status: str, detail: str) -> int:
        if not todo_ids:
            return 0
        finished_at = now_iso()
        placeholders = ",".join("?" for _ in todo_ids)
        with self._connect() as conn:
            cursor = conn.execute(
                f"""
                UPDATE session_todos
                SET status = ?, finished_at = ?, detail = ?, feishu_synced_at = NULL
                WHERE status = 'injected' AND todo_id IN ({placeholders})
                """,
                (status, finished_at, detail[:4000], *todo_ids),
            )
            return cursor.rowcount

    def release_todo_claim(self, *, todo_ids: list[str], detail: str = "") -> None:
        if not todo_ids:
            raise ValueError("todo_ids must be non-empty")
        placeholders = ",".join("?" for _ in todo_ids)
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                f"SELECT todo_id, batch_key FROM session_todos WHERE todo_id IN ({placeholders}) AND status = 'claimed'",
                tuple(todo_ids),
            ).fetchall()
            if len(rows) != len(todo_ids):
                raise KeyError("claimed todo count mismatch")
            conn.execute(
                f"""
                UPDATE session_todos
                SET status = 'pending',
                    claimed_at = NULL,
                    detail = ?,
                    feishu_synced_at = NULL
                WHERE todo_id IN ({placeholders}) AND status = 'claimed'
                """,
                (detail[:4000], *todo_ids),
            )
            batch_keys = sorted({str(row["batch_key"]) for row in rows if row["batch_key"]})
            for batch_key in batch_keys:
                conn.execute(
                    """
                    UPDATE todo_batches
                    SET status = 'open', detail = ?
                    WHERE batch_key = ? AND status = 'claimed'
                    """,
                    (detail[:4000], batch_key),
                )

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
                INSERT INTO heartbeat_pauses (
                  session_name, status, created_at, updated_at, expires_at, reason, source, provider_scope_key
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, '')
                ON CONFLICT(session_name) DO UPDATE SET
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at,
                  reason = excluded.reason,
                  source = excluded.source,
                  provider_scope_key = ''
                """,
                (session_name, status, now, now, expires_at, reason, source),
            )
            self._insert_event(
                conn,
                event_type="heartbeat_paused",
                target_session=session_name,
                status=status,
                summary=summary,
                trigger_source="pause_control",
                trigger_cause=source,
                trigger_location=session_name,
                source=source,
            )
        return {"session_name": session_name, "status": status, "expires_at": expires_at}

    def pause_session_until(
        self,
        *,
        session_name: str,
        expires_at: datetime,
        reason: str = "",
        source: str = "heartbeat_command",
        provider_scope_key: str = "",
    ) -> dict[str, Any]:
        session_name = session_name.strip()
        reason = reason.strip()
        source = (source or "heartbeat_command").strip()
        provider_scope_key = provider_scope_key.strip()
        if not session_name:
            raise ValueError("session_name must be non-empty")
        if expires_at.tzinfo is None:
            raise ValueError("expires_at must be timezone-aware")
        expires_at_text = expires_at.astimezone(timezone.utc).isoformat(timespec="seconds")
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO heartbeat_pauses (
                  session_name, status, created_at, updated_at, expires_at, reason, source, provider_scope_key
                )
                VALUES (?, 'paused', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_name) DO UPDATE SET
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at,
                  reason = excluded.reason,
                  source = excluded.source,
                  provider_scope_key = excluded.provider_scope_key
                """,
                (session_name, now, now, expires_at_text, reason, source, provider_scope_key),
            )
            self._insert_event(
                conn,
                event_type="heartbeat_paused",
                target_session=session_name,
                status="paused",
                summary=reason or f"heartbeat paused until {expires_at_text}",
                trigger_source="pause_control",
                trigger_cause=source,
                trigger_location=session_name,
                source=source,
            )
        return {
            "session_name": session_name,
            "status": "paused",
            "expires_at": expires_at_text,
            "provider_scope_key": provider_scope_key,
        }

    def pause_provider_limit(
        self,
        *,
        scope_key: str,
        expires_at: datetime,
        reason: str = "",
        source: str = "heartbeat",
    ) -> dict[str, Any]:
        scope_key = scope_key.strip()
        reason = reason.strip()
        source = (source or "heartbeat").strip()
        if not scope_key:
            raise ValueError("scope_key must be non-empty")
        if expires_at.tzinfo is None:
            raise ValueError("expires_at must be timezone-aware")
        expires_at_text = expires_at.astimezone(timezone.utc).isoformat(timespec="seconds")
        now = now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO provider_limit_pauses (scope_key, status, created_at, updated_at, expires_at, reason, source)
                VALUES (?, 'paused', ?, ?, ?, ?, ?)
                ON CONFLICT(scope_key) DO UPDATE SET
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at,
                  reason = excluded.reason,
                  source = excluded.source
                """,
                (scope_key, now, now, expires_at_text, reason, source),
            )
            self._insert_event(
                conn,
                event_type="provider_limit_paused",
                target_session=scope_key,
                status="paused",
                summary=reason or f"provider limit paused until {expires_at_text}",
                trigger_source="provider_limit",
                trigger_cause=source,
                trigger_location=scope_key,
                source=source,
            )
        return {"scope_key": scope_key, "status": "paused", "expires_at": expires_at_text}

    def pause_session_for_active_provider_limit(
        self,
        *,
        scope_key: str,
        session_name: str,
        reason: str = "",
    ) -> dict[str, Any] | None:
        """Materialize a target pause only while the shared provider pause is still active."""
        scope_key = scope_key.strip()
        session_name = session_name.strip()
        if not scope_key or not session_name:
            raise ValueError("scope_key and session_name must be non-empty")
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            provider_pause = conn.execute(
                """
                SELECT expires_at, reason, source
                FROM provider_limit_pauses
                WHERE scope_key = ? AND status = 'paused' AND expires_at > ?
                LIMIT 1
                """,
                (scope_key, now),
            ).fetchone()
            if provider_pause is None:
                conn.execute("ROLLBACK")
                return None
            pause_reason = reason.strip() or (
                f"shared provider limit pause; scope_key={scope_key}; "
                f"reason={provider_pause['reason'] or ''}"
            )
            conn.execute(
                """
                INSERT INTO heartbeat_pauses (
                  session_name, status, created_at, updated_at, expires_at, reason, source, provider_scope_key
                )
                VALUES (?, 'paused', ?, ?, ?, ?, 'provider_limit_auto_pause', ?)
                ON CONFLICT(session_name) DO UPDATE SET
                  status = excluded.status,
                  updated_at = excluded.updated_at,
                  expires_at = excluded.expires_at,
                  reason = excluded.reason,
                  source = excluded.source,
                  provider_scope_key = excluded.provider_scope_key
                """,
                (
                    session_name,
                    now,
                    now,
                    str(provider_pause["expires_at"]),
                    pause_reason,
                    scope_key,
                ),
            )
            self._insert_event(
                conn,
                event_type="heartbeat_paused",
                target_session=session_name,
                status="paused",
                summary=pause_reason,
                trigger_source="pause_control",
                trigger_cause="provider_limit_auto_pause",
                trigger_location=session_name,
                source="provider_limit_auto_pause",
            )
            conn.execute("COMMIT")
        return {
            "session_name": session_name,
            "status": "paused",
            "expires_at": str(provider_pause["expires_at"]),
            "provider_scope_key": scope_key,
        }

    def active_provider_limit_pause(self, scope_key: str) -> dict[str, Any] | None:
        scope_key = scope_key.strip()
        if not scope_key:
            return None
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT scope_key, status, created_at, updated_at, expires_at, reason, source
                FROM provider_limit_pauses
                WHERE scope_key = ?
                  AND status = 'paused'
                  AND expires_at > ?
                LIMIT 1
                """,
                (scope_key, now),
            ).fetchone()
        return dict(row) if row is not None else None

    def expire_provider_limit_pause(self, scope_key: str) -> dict[str, Any] | None:
        scope_key = scope_key.strip()
        if not scope_key:
            return None
        now = now_iso()
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                """
                SELECT scope_key, status, expires_at, reason, source
                FROM provider_limit_pauses
                WHERE scope_key = ?
                  AND status = 'paused'
                  AND expires_at <= ?
                LIMIT 1
                """,
                (scope_key, now),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE provider_limit_pauses
                SET status = 'expired', updated_at = ?
                WHERE scope_key = ? AND status = 'paused'
                """,
                (now, scope_key),
            )
            self._insert_event(
                conn,
                event_type="provider_limit_pause_expired",
                target_session=scope_key,
                status="expired",
                summary=f"expired_at={row['expires_at']}",
                trigger_source="provider_limit",
                trigger_cause="pause_expired",
                trigger_location=scope_key,
                source=str(row["source"] or "heartbeat"),
            )
        return dict(row)

    def recover_provider_limit_pause(
        self,
        *,
        scope_key: str,
        evidence_run_id: str,
        evidence_at: datetime,
    ) -> dict[str, Any] | None:
        """Clear a shared pause and every derived session pause after newer success evidence."""
        scope_key = scope_key.strip()
        evidence_run_id = evidence_run_id.strip()
        if not scope_key or not evidence_run_id:
            raise ValueError("scope_key and evidence_run_id must be non-empty")
        if evidence_at.tzinfo is None:
            raise ValueError("evidence_at must be timezone-aware")
        now = now_iso()
        evidence_at_text = evidence_at.astimezone(timezone.utc).isoformat(timespec="seconds")
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            provider_pause = conn.execute(
                """
                SELECT scope_key, status, expires_at, reason, source
                FROM provider_limit_pauses
                WHERE scope_key = ? AND status = 'paused'
                LIMIT 1
                """,
                (scope_key,),
            ).fetchone()
            if provider_pause is None:
                conn.execute("ROLLBACK")
                return None
            linked_rows = conn.execute(
                """
                SELECT session_name
                FROM heartbeat_pauses
                WHERE status IN ('paused', 'permanent')
                  AND source = 'provider_limit_auto_pause'
                  AND provider_scope_key = ?
                ORDER BY session_name
                """,
                (scope_key,),
            ).fetchall()
            cursor = conn.execute(
                """
                UPDATE provider_limit_pauses
                SET status = 'recovered', updated_at = ?
                WHERE scope_key = ? AND status = 'paused'
                """,
                (now, scope_key),
            )
            if cursor.rowcount != 1:
                conn.execute("ROLLBACK")
                return None
            conn.execute(
                """
                UPDATE heartbeat_pauses
                SET status = 'resumed', updated_at = ?
                WHERE source = 'provider_limit_auto_pause'
                  AND provider_scope_key = ?
                  AND status IN ('paused', 'permanent')
                """,
                (now, scope_key),
            )
            summary = (
                f"scope_key={scope_key}; evidence_run={evidence_run_id}; "
                f"evidence_at={evidence_at_text}; prior_expires_at={provider_pause['expires_at']}"
            )
            self._insert_event(
                conn,
                event_type="provider_limit_pause_recovered",
                target_session=scope_key,
                status="recovered",
                summary=summary,
                trigger_source="provider_limit",
                trigger_cause="newer_successful_run",
                trigger_location=scope_key,
                source=str(provider_pause["source"] or "heartbeat"),
            )
            for linked_row in linked_rows:
                self._insert_event(
                    conn,
                    event_type="heartbeat_resumed",
                    target_session=str(linked_row["session_name"]),
                    status="resumed",
                    summary=summary,
                    trigger_source="pause_control",
                    trigger_cause="provider_limit_recovered",
                    trigger_location=scope_key,
                    source="provider_limit_auto_pause",
                )
            conn.execute("COMMIT")
        return {
            "scope_key": scope_key,
            "status": "recovered",
            "linked_sessions": [str(row["session_name"]) for row in linked_rows],
            "evidence_run_id": evidence_run_id,
            "evidence_at": evidence_at_text,
        }

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
                trigger_source="pause_control",
                trigger_cause=source,
                trigger_location=session_name,
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
                SELECT session_name, status, created_at, updated_at, expires_at, reason, source,
                       provider_scope_key
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
                trigger_source="pause_control",
                trigger_cause="pause_expired",
                trigger_location=session_name,
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
                    SET status = ?, injected_at = ?, finished_at = NULL, detail = ?, feishu_synced_at = NULL
                    WHERE todo_id IN ({placeholders}) AND status = 'claimed'
                    """,
                    (status, finished_at, detail[:4000], *todo_ids),
                )
            else:
                conn.execute(
                    f"""
                    UPDATE session_todos
                    SET status = ?, finished_at = ?, detail = ?, feishu_synced_at = NULL
                    WHERE todo_id IN ({placeholders}) AND status = 'claimed'
                    """,
                    (status, finished_at, detail[:4000], *todo_ids),
                )
            batch_keys = sorted({str(row["batch_key"]) for row in rows if row["batch_key"]})
            for batch_key in batch_keys:
                still_claimed = conn.execute(
                    "SELECT 1 FROM session_todos WHERE batch_key = ? AND status = 'claimed' LIMIT 1",
                    (batch_key,),
                ).fetchone()
                if still_claimed is not None:
                    continue
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
        trigger_source: str = "",
        trigger_cause: str = "",
        trigger_location: str = "",
        injected_message: str = "",
        source: str = "heartbeat",
    ) -> str:
        event_id = f"hev_{uuid.uuid4().hex[:12]}"
        conn.execute(
            """
            INSERT INTO heartbeat_events (
              event_id, created_at, patrol_id, event_type, target_session, logical_key,
              decision, child_session_id, child_model, status, summary, error,
              trigger_source, trigger_cause, trigger_location, injected_message, source
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                trigger_source[:500],
                trigger_cause[:500],
                trigger_location[:500],
                injected_message[:4000],
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
        # 幂等只允许未完成的终态重新领取：failed/cancelled/timeout 代表恢复链路没闭环，
        # 需要允许后续同 key 重试；completed 是 closure 已落地的证据，必须继续挡住
        # 同 (target_session, logical_key) 的重复 spawn，避免完成巡检掩盖反复触发。
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO child_spawns
                  (logical_key, target_session, child_model, status, created_at)
                VALUES (?, ?, ?, 'claimed', ?)
                ON CONFLICT(target_session, logical_key) DO UPDATE SET
                    child_model = excluded.child_model,
                    status = 'claimed',
                    created_at = excluded.created_at,
                    child_session_id = NULL,
                    last_polled_at = NULL,
                    final_summary = '',
                    async_ref = '',
                    spawn_comm_id = ''
                WHERE child_spawns.status IN ('failed', 'cancelled', 'timeout')
                """,
                (logical_key, target_session, child_model, now_iso()),
            )
            return cursor.rowcount > 0

    def reconcile_stale_running_spawns(self, *, sla_minutes: int) -> list[dict[str, Any]]:
        """Reap `running` child spawns whose age exceeds the SLA into `timeout`.

        Async spawns that never receive a closure delivery (empty spawn_comm_id, or the
        delivery link silently dropped) otherwise sit in `running` forever with no poller.
        Returns the reaped rows so the caller can emit audit events. 0/negative sla disables.
        """
        if sla_minutes <= 0:
            return []
        now = now_iso()
        cutoff = _iso_seconds_before(now, sla_minutes * 60)
        with self._connect() as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                """
                SELECT target_session, logical_key, created_at, child_session_id, spawn_comm_id
                FROM child_spawns
                WHERE status = 'running' AND created_at < ?
                ORDER BY created_at ASC
                """,
                (cutoff,),
            ).fetchall()
            if rows:
                conn.execute(
                    """
                    UPDATE child_spawns
                    SET status = 'timeout',
                        last_polled_at = ?,
                        final_summary = CASE
                            WHEN final_summary = '' THEN ?
                            ELSE final_summary
                        END
                    WHERE status = 'running' AND created_at < ?
                    """,
                    (
                        now,
                        f"auto-reconciled: running exceeded {sla_minutes}m SLA with no closure",
                        cutoff,
                    ),
                )
        return [dict(row) for row in rows]

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

    def mark_spawn_started(
        self,
        *,
        target_session: str,
        logical_key: str,
        child_session_id: str | None = None,
        async_ref: str | None = None,
        spawn_comm_id: str | None = None,
    ) -> None:
        if not child_session_id and not async_ref:
            raise ValueError("child_session_id or async_ref must be non-empty")
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE child_spawns
                SET child_session_id = ?,
                    async_ref = ?,
                    spawn_comm_id = ?,
                    status = 'running'
                WHERE target_session = ? AND logical_key = ?
                """,
                (child_session_id, async_ref or "", spawn_comm_id or "", target_session, logical_key),
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
        source_session=str(row["source_session"]),
        source_ref=str(row["source_ref"]),
        todo_type=str(row["todo_type"]),
        created_at=str(row["created_at"]),
    )


def _handoff_receipt(row: dict[str, Any]) -> dict[str, Any]:
    receipt: dict[str, Any] = {
        "handoff_id": str(row["handoff_id"]),
        "target_session": str(row["target_session"]),
        "action_type": str(row["action_type"]),
        "logical_key": str(row["logical_key"]),
        "error": str(row["error"]),
        "created_at": str(row["created_at"]),
        "notify": {
            "status": str(row["notify_status"]),
            "message_id": str(row["notify_message_id"]),
            "detail": str(row["notify_detail"]),
        },
        "handoff": {
            "owner_session": str(row["owner_session"]),
            "ledger_ref": str(row["ledger_ref"]),
            "acceptance_status": str(row["status"]),
        },
        "recovery": {"status": str(row["status"])},
    }
    if row["recovery_event_type"]:
        receipt["recovery"].update(
            {
                "event_type": str(row["recovery_event_type"]),
                "event_id": str(row["recovery_event_id"]),
                "detail": str(row["recovery_summary"]),
                "at": str(row["recovery_at"]),
            }
        )
    return receipt


def _todo_aggregate_from_items(aggregate_key: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    statuses = sorted({str(item.get("status") or "") for item in items if item.get("status")})
    latest = max(items, key=lambda item: str(item.get("finished_at") or item.get("injected_at") or item.get("claimed_at") or item.get("created_at") or ""))
    final_status = _aggregate_status(statuses)
    injected_items = [item for item in items if item.get("injected_at")]
    failed_items = [item for item in items if str(item.get("status") or "") == "failed"]
    detail = str(latest.get("detail") or "")
    row = {
        "aggregate_key": aggregate_key,
        "source_ref": _first_non_empty(items, "source_ref") or aggregate_key,
        "target_sessions": ",".join(_distinct_values(items, "target_session")),
        "source_sessions": ",".join(_distinct_values(items, "source_session")),
        "todo_types": ",".join(_distinct_values(items, "todo_type")),
        "sources": ",".join(_distinct_values(items, "source")),
        "batch_keys": ",".join(_distinct_values(items, "batch_key")),
        "item_count": len(items),
        "statuses": ",".join(statuses),
        "final_status": final_status,
        "recorded_in_pool": "yes",
        "triggered": "yes" if injected_items else "no",
        "triggered_count": len(injected_items),
        "failed_count": len(failed_items),
        "first_created_at": min(str(item.get("created_at") or "") for item in items),
        "last_claimed_at": _max_non_empty(items, "claimed_at"),
        "last_injected_at": _max_non_empty(items, "injected_at"),
        "last_finished_at": _max_non_empty(items, "finished_at"),
        "latest_todo_id": str(latest.get("todo_id") or ""),
        "latest_logical_key": str(latest.get("logical_key") or ""),
        "latest_message": str(latest.get("message") or ""),
        "latest_injected_message": detail if injected_items else "",
        "latest_error": detail if final_status == "failed" else "",
    }
    stable = {key: value for key, value in row.items() if key != "row_hash"}
    row["row_hash"] = _short_hash(json.dumps(stable, ensure_ascii=False, sort_keys=True))
    return row


def _aggregate_status(statuses: list[str]) -> str:
    if "injected" in statuses:
        return "injected"
    if "claimed" in statuses:
        return "claimed"
    if "pending" in statuses:
        return "pending"
    if "failed" in statuses:
        return "failed"
    return statuses[-1] if statuses else ""


def _distinct_values(items: list[dict[str, Any]], key: str) -> list[str]:
    return sorted({str(item.get(key) or "") for item in items if item.get(key)})


def _first_non_empty(items: list[dict[str, Any]], key: str) -> str:
    for item in items:
        value = str(item.get(key) or "")
        if value:
            return value
    return ""


def _max_non_empty(items: list[dict[str, Any]], key: str) -> str:
    values = [str(item.get(key) or "") for item in items if item.get(key)]
    return max(values) if values else ""


def _short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def _compact_time(value: str) -> str:
    return value.replace("-", "").replace(":", "").replace("+00:00", "Z")


def _seconds_between(start: str, end: str) -> float:
    start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
    end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    return max(0.0, (end_dt - start_dt).total_seconds())


def _iso_seconds_before(now: str, seconds: int) -> str:
    base = datetime.fromisoformat(now.replace("Z", "+00:00"))
    return (base - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _iso_seconds_after(now: str, seconds: int) -> str:
    base = datetime.fromisoformat(now.replace("Z", "+00:00"))
    return (base + timedelta(seconds=seconds)).isoformat(timespec="seconds")
