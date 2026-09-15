from __future__ import annotations

import json
import hashlib
import secrets
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO_ROOT / "data" / "sync-queue.sqlite"
FEISHU_TABLE_ROW_CAP = 20000
# 块大小必须 ≥ bitable._BULK_SYNC_THRESHOLD(200)，让每个分块保住整表预取+batch-create 快路径资格；
# 且不能太小——bulk 路径按块做整表预取+终局整表读回，块越多整表扫描次数线性放大
# （14288 行按 200 拆 =72 次整表扫描、按 2000 拆 =8 次）。replace 不分块：它必须携带全集，
# 因此只受 Feishu 单表行数上限约束；upsert 仍保持 2000 行分块。
UPSERT_CHUNK_ROW_LIMIT = 2000
REPLACE_ROW_LIMIT = FEISHU_TABLE_ROW_CAP
REPLACE_PAYLOAD_BYTE_LIMIT = 2_000_000
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_STALE_MINUTES = 30
DEFAULT_RETENTION_DAYS = 90
SQLITE_BUSY_TIMEOUT_SECONDS = 1.0
SQLITE_WRITE_RETRY_ATTEMPTS = 5
SQLITE_WRITE_RETRY_DELAY_SECONDS = 0.1

# 这些标记意味着原 job 已被替代、显式取消或人为隔离；重试旧 payload 会回灌已废内容。
_ARCHIVE_FAILED_MARKERS = (
    "cancelled",
    "incident freeze",
    "manual quarantine",
    "owner terminalized",
    "head-of-line quarantine",
    "terminated by wendangwang owner",
)
_RETAIN_FAILED_MARKERS = ("superseded",)
_TRANSIENT_RETRY_MARKERS = (
    "transient ",
    "rate limit",
    "quota exceeded",
    "connection reset",
)

# op 取值不再用 SQL CHECK 约束（避免每加一个 op 都要迁移），改由 enqueue/drain 在 Python 侧校验。
SYNC_JOBS_SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL,
  from_session TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','held','superseded','cancelled','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  slice_claims INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  enqueued_at TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT '',
  processed_at TEXT NOT NULL DEFAULT '',
  receipt_ref TEXT NOT NULL DEFAULT '',
  coalesce_key TEXT NOT NULL DEFAULT '',
  superseded_by_job_id INTEGER NOT NULL DEFAULT 0,
  superseded_by_job_ids TEXT NOT NULL DEFAULT '[]',
  supersede_evidence_ref TEXT NOT NULL DEFAULT '',
  cancelled_by_contract_sha256 TEXT NOT NULL DEFAULT '',
  cancel_evidence_ref TEXT NOT NULL DEFAULT '',
  -- 入队时 SuperMatrix 运行时裁定的调用方来源（JSON）：attested=运行时解析出的身份，
  -- unattested=无 token/不解析/端点不可达（合法但不是身份）。空串=本闸之前入队的存量
  -- job，未记录——不追认成任何状态。契约 SuperMatrix docs/caller-provenance-boundary.md。
  caller_provenance TEXT NOT NULL DEFAULT '',
  -- 调用方声明的 skill 路由来源；这是覆盖度遥测，不是身份或写权限。
  skill_provenance TEXT NOT NULL DEFAULT '',
  recovery_count INTEGER NOT NULL DEFAULT 0,
  recovery_origin_json TEXT NOT NULL DEFAULT '[]',
  available_after TEXT NOT NULL DEFAULT ''
);

"""

ATTACHMENT_RETRY_AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS attachment_retry_authorizations (
  authorization_id TEXT PRIMARY KEY,
  authorization_token TEXT NOT NULL UNIQUE,
  predecessor_key TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL,
  caller_session TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  expected_before_file_tokens_json TEXT NOT NULL,
  expected_before_token_set_sha256 TEXT NOT NULL,
  new_file_sha256s_json TEXT NOT NULL,
  next_generation INTEGER NOT NULL,
  next_dedupe_key TEXT NOT NULL UNIQUE,
  job_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed')),
  issued_at TEXT NOT NULL,
  consumed_at TEXT NOT NULL DEFAULT ''
);
"""

SCHEMA = SYNC_JOBS_SCHEMA + ATTACHMENT_RETRY_AUTH_SCHEMA + """
CREATE TABLE IF NOT EXISTS sync_job_keys (
  dedupe_key TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_queue_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_logical_snapshots (
  job_id INTEGER PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_job_keys_job_id ON sync_job_keys(job_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_pending_asset
  ON sync_jobs(asset_id, id) WHERE status='pending';
"""

_JOB_COPY_COLUMNS = (
    "id, dedupe_key, asset_id, from_session, op, payload_json, status, attempts,"
    " last_error, enqueued_at, started_at, processed_at, receipt_ref"
)


def _create_sync_jobs(conn: sqlite3.Connection) -> None:
    conn.execute(SYNC_JOBS_SCHEMA.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE", 1))


def _copy_legacy_jobs(conn: sqlite3.Connection) -> None:
    legacy_columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(_sync_jobs_legacy)").fetchall()
    }
    columns = _JOB_COPY_COLUMNS
    if "coalesce_key" in legacy_columns:
        columns += ", coalesce_key"
    if "superseded_by_job_id" in legacy_columns:
        columns += ", superseded_by_job_id"
    if "superseded_by_job_ids" in legacy_columns:
        columns += ", superseded_by_job_ids"
    if "supersede_evidence_ref" in legacy_columns:
        columns += ", supersede_evidence_ref"
    if "cancelled_by_contract_sha256" in legacy_columns:
        columns += ", cancelled_by_contract_sha256"
    if "cancel_evidence_ref" in legacy_columns:
        columns += ", cancel_evidence_ref"
    if "caller_provenance" in legacy_columns:
        columns += ", caller_provenance"
    if "skill_provenance" in legacy_columns:
        columns += ", skill_provenance"
    if "recovery_count" in legacy_columns:
        columns += ", recovery_count"
    if "recovery_origin_json" in legacy_columns:
        columns += ", recovery_origin_json"
    if "slice_claims" in legacy_columns:
        columns += ", slice_claims"
    conn.execute(f"INSERT INTO sync_jobs ({columns}) SELECT {columns} FROM _sync_jobs_legacy")

LOGICAL_SNAPSHOT_OP = "bitable_rows_logical_snapshot"

SUPPORTED_OPS = (
    "bitable_rows_upsert",
    "bitable_rows_create_if_absent",
    "bitable_rows_update_existing",
    "bitable_rows_replace",
    LOGICAL_SNAPSHOT_OP,
    "bitable_attachment_upload",
    "bitable_attachment_replace_if_current",
    "bitable_attachment_dedupe",
    "bitable_record_delete_if_current",
    "bitable_record_update_if_current",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class QueueWriteUnavailable(RuntimeError):
    """The queue ledger stayed busy after bounded write retries."""


def _is_sqlite_busy(exc: sqlite3.OperationalError) -> bool:
    return "database is locked" in str(exc).lower() or "database table is locked" in str(exc).lower()


def _retry_sqlite_write(
    conn: sqlite3.Connection,
    operation: Any,
    *,
    operation_name: str,
) -> Any:
    """Retry a whole atomic queue mutation, never a partial transaction."""
    for attempt in range(SQLITE_WRITE_RETRY_ATTEMPTS):
        try:
            return operation()
        except sqlite3.OperationalError as exc:
            if not _is_sqlite_busy(exc):
                raise
            conn.rollback()
            if attempt + 1 == SQLITE_WRITE_RETRY_ATTEMPTS:
                raise QueueWriteUnavailable(
                    f"queue {operation_name} not confirmed after "
                    f"{SQLITE_WRITE_RETRY_ATTEMPTS} busy retries: {exc}"
                ) from exc
            time.sleep(SQLITE_WRITE_RETRY_DELAY_SECONDS)
    raise AssertionError("unreachable")


def _public_attachment_retry_authorization(row: Any) -> dict[str, Any]:
    return {
        "authorization_id": row["authorization_id"],
        "token": row["authorization_token"],
        "predecessor_key": row["predecessor_key"],
        "asset_id": row["asset_id"],
        "caller_session": row["caller_session"],
        "record_id": row["record_id"],
        "field_id": row["field_id"],
        "expected_before_file_tokens": json.loads(
            row["expected_before_file_tokens_json"]
        ),
        "expected_before_token_set_sha256": row[
            "expected_before_token_set_sha256"
        ],
        "new_file_sha256s": json.loads(row["new_file_sha256s_json"]),
        "next_generation": int(row["next_generation"]),
        "next_dedupe_key": row["next_dedupe_key"],
    }


def attachment_retry_authorization_for_job(
    conn: sqlite3.Connection, job_id: int, *, pending_only: bool = True
) -> dict[str, Any] | None:
    status_clause = " AND status='pending'" if pending_only else ""
    row = conn.execute(
        "SELECT * FROM attachment_retry_authorizations WHERE job_id=?" + status_clause,
        (job_id,),
    ).fetchone()
    return _public_attachment_retry_authorization(row) if row is not None else None


def _revoke_pending_attachment_retry_authorizations(
    conn: sqlite3.Connection, job_id: int
) -> int:
    cur = conn.execute(
        "DELETE FROM attachment_retry_authorizations "
        "WHERE job_id=? AND status='pending'",
        (job_id,),
    )
    return cur.rowcount


def _issue_attachment_retry_authorization(
    conn: sqlite3.Connection, job: Any, payload: dict[str, Any]
) -> dict[str, Any]:
    from .attachment_replace import (
        attachment_retry_generation,
        make_attachment_replace_dedupe_key,
        validate_attachment_replace_payload,
    )

    generation = attachment_retry_generation(payload)
    current_key = make_attachment_replace_dedupe_key(job["asset_id"], payload)
    if current_key != job["dedupe_key"]:
        raise ValueError("attachment retry authorization predecessor key is not canonical")
    file_hashes = validate_attachment_replace_payload(payload)
    next_payload = dict(payload)
    next_payload.pop("retry_authorization", None)
    next_payload["retry_generation"] = generation + 1
    next_key = make_attachment_replace_dedupe_key(job["asset_id"], next_payload)
    existing = conn.execute(
        "SELECT * FROM attachment_retry_authorizations WHERE predecessor_key=?",
        (job["dedupe_key"],),
    ).fetchone()
    if existing is not None:
        if existing["job_id"] != job["id"]:
            if existing["status"] == "pending":
                _revoke_pending_attachment_retry_authorizations(conn, int(existing["job_id"]))
                existing = None
            else:
                raise ValueError(
                    "attachment retry authorization predecessor is already resolved"
                )
    if existing is not None:
        if (
            existing["status"] == "pending"
            and existing["asset_id"] == job["asset_id"]
            and existing["caller_session"] == job["from_session"]
            and existing["next_generation"] == generation + 1
            and existing["next_dedupe_key"] == next_key
        ):
            return _public_attachment_retry_authorization(existing)
        raise ValueError("attachment retry authorization predecessor is already resolved")
    authorization = {
        "authorization_id": "ara_" + secrets.token_urlsafe(18),
        "authorization_token": secrets.token_urlsafe(32),
    }
    conn.execute(
        "INSERT INTO attachment_retry_authorizations ("
        "authorization_id, authorization_token, predecessor_key, asset_id, caller_session,"
        "record_id, field_id, expected_before_file_tokens_json,"
        "expected_before_token_set_sha256, new_file_sha256s_json, next_generation,"
        "next_dedupe_key, job_id, issued_at"
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            authorization["authorization_id"], authorization["authorization_token"],
            job["dedupe_key"], job["asset_id"], job["from_session"],
            payload["record_id"], payload["field_id"],
            json.dumps(sorted(payload["expected_before_file_tokens"]), separators=(",", ":")),
            payload["expected_before_token_set_sha256"],
            json.dumps(file_hashes, separators=(",", ":")), generation + 1,
            next_key, job["id"], _now(),
        ),
    )
    row = conn.execute(
        "SELECT * FROM attachment_retry_authorizations WHERE authorization_id=?",
        (authorization["authorization_id"],),
    ).fetchone()
    return _public_attachment_retry_authorization(row)


def _migrate(conn: sqlite3.Connection) -> None:
    """一次性迁移：拆掉旧的 op 值 CHECK 约束（rebuild 表，保留全部数据）。"""
    legacy_exists = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_sync_jobs_legacy'"
    ).fetchone() is not None
    if legacy_exists:
        conn.execute("BEGIN IMMEDIATE")
        try:
            unexpected = int(conn.execute(
                "SELECT COUNT(*) FROM sync_jobs j"
                " LEFT JOIN _sync_jobs_legacy l"
                " ON l.id=j.id AND l.dedupe_key=j.dedupe_key"
                " WHERE l.id IS NULL"
            ).fetchone()[0])
            if unexpected:
                raise RuntimeError(
                    "sync queue migration manual recovery required:"
                    f" sync_jobs has {unexpected} rows absent from _sync_jobs_legacy"
                )
            conn.execute("DROP TABLE sync_jobs")
            _create_sync_jobs(conn)
            _copy_legacy_jobs(conn)
            conn.execute("DROP TABLE _sync_jobs_legacy")
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sync_jobs'"
    ).fetchone()
    if row is not None and (
        "CHECK (op IN" in row[0]
        or "'held'" not in row[0]
        or "'superseded'" not in row[0]
        or "'cancelled'" not in row[0]
    ):
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("ALTER TABLE sync_jobs RENAME TO _sync_jobs_legacy")
            _create_sync_jobs(conn)
            _copy_legacy_jobs(conn)
            conn.execute("DROP TABLE _sync_jobs_legacy")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    columns = {
        str(item["name"])
        for item in conn.execute("PRAGMA table_info(sync_jobs)").fetchall()
    }
    if "coalesce_key" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN coalesce_key TEXT NOT NULL DEFAULT ''"
        )
    if "superseded_by_job_id" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN superseded_by_job_id INTEGER NOT NULL DEFAULT 0"
        )
    if "superseded_by_job_ids" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN superseded_by_job_ids TEXT NOT NULL DEFAULT '[]'"
        )
    if "supersede_evidence_ref" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN supersede_evidence_ref TEXT NOT NULL DEFAULT ''"
        )
    if "cancelled_by_contract_sha256" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN cancelled_by_contract_sha256"
            " TEXT NOT NULL DEFAULT ''"
        )
    if "cancel_evidence_ref" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN cancel_evidence_ref TEXT NOT NULL DEFAULT ''"
        )
    if "caller_provenance" not in columns:
        # 存量 job 留空串（=未记录），不回填成 unattested：本闸之前根本没做过这个判定。
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN caller_provenance TEXT NOT NULL DEFAULT ''"
        )
    if "skill_provenance" not in columns:
        # 存量 job 没有 skill 声明，保持空串；不能倒推为未激活或已激活。
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN skill_provenance TEXT NOT NULL DEFAULT ''"
        )
    if "recovery_count" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0"
        )
    if "recovery_origin_json" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN recovery_origin_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "available_after" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN available_after TEXT NOT NULL DEFAULT ''"
        )
    if "slice_claims" not in columns:
        conn.execute(
            "ALTER TABLE sync_jobs ADD COLUMN slice_claims INTEGER NOT NULL DEFAULT 0"
        )
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS sync_job_keys ("
        " dedupe_key TEXT PRIMARY KEY, job_id INTEGER NOT NULL, created_at TEXT NOT NULL);"
        "CREATE INDEX IF NOT EXISTS idx_sync_jobs_pending_coalesce"
        " ON sync_jobs(coalesce_key, id)"
        " WHERE status='pending' AND coalesce_key != '';"
        "CREATE INDEX IF NOT EXISTS idx_sync_job_keys_job_id ON sync_job_keys(job_id);"
        "CREATE INDEX IF NOT EXISTS idx_sync_jobs_pending_asset"
        " ON sync_jobs(asset_id, id) WHERE status='pending';"
        "CREATE TABLE IF NOT EXISTS sync_queue_meta ("
        " key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS sync_logical_snapshots ("
        " job_id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);"
    )
    seeded = conn.execute(
        "SELECT value FROM sync_queue_meta WHERE key='aliases_seeded_v1'"
    ).fetchone()
    if seeded is None:
        conn.execute(
            "INSERT OR IGNORE INTO sync_job_keys (dedupe_key, job_id, created_at)"
            " SELECT dedupe_key, id, enqueued_at FROM sync_jobs"
        )
        conn.execute(
            "INSERT INTO sync_queue_meta (key, value) VALUES ('aliases_seeded_v1', ?)",
            (_now(),),
        )
    conn.commit()


def connect(db_path: Path | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else DEFAULT_DB
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=SQLITE_BUSY_TIMEOUT_SECONDS)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout={int(SQLITE_BUSY_TIMEOUT_SECONDS * 1000)}")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


def get_logical_snapshot_state(
    conn: sqlite3.Connection, job_id: int
) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT state_json FROM sync_logical_snapshots WHERE job_id=?", (int(job_id),)
    ).fetchone()
    if row is None:
        return None
    value = json.loads(str(row["state_json"]))
    if not isinstance(value, dict):
        raise ValueError(f"logical snapshot state for job {job_id} is not an object")
    return value


def save_logical_snapshot_state(
    conn: sqlite3.Connection, job_id: int, state: dict[str, Any]
) -> None:
    if not isinstance(state, dict):
        raise ValueError("logical snapshot state must be an object")
    conn.execute(
        "INSERT INTO sync_logical_snapshots(job_id,state_json,updated_at) VALUES(?,?,?)"
        " ON CONFLICT(job_id) DO UPDATE SET state_json=excluded.state_json,"
        " updated_at=excluded.updated_at",
        (int(job_id), json.dumps(state, ensure_ascii=False, sort_keys=True), _now()),
    )
    conn.commit()


def delete_logical_snapshot_state(conn: sqlite3.Connection, job_id: int) -> None:
    conn.execute("DELETE FROM sync_logical_snapshots WHERE job_id=?", (int(job_id),))
    conn.commit()


def _payload_rows(payload: Any) -> list | None:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("rows"), list):
        return payload["rows"]
    return None


def _load_registered_asset_for_snapshot(asset_id: str) -> Any:
    """Load the one canonical contract needed by direct snapshot admission."""
    from .registry import load_asset_contract

    paths = sorted(
        path for path in REPO_ROOT.glob("registry/assets/**/*.json")
        if "/examples/" not in str(path)
    )
    matches = []
    for path in paths:
        try:
            asset = load_asset_contract(path)
        except Exception:
            continue
        if asset.asset_id == asset_id:
            matches.append(asset)
    if not matches:
        raise ValueError(
            f"enqueue rejected: logical snapshot asset contract not found: {asset_id}"
        )
    if len(matches) != 1:
        raise ValueError(
            f"enqueue rejected: logical snapshot asset contract is ambiguous: {asset_id}"
        )
    return matches[0]


def _replace_payload_too_large_error(row_count: int, payload_bytes: int) -> ValueError:
    return ValueError(
        "enqueue rejected: replace payload 超限 "
        f"rows={row_count}/{REPLACE_ROW_LIMIT}, bytes={payload_bytes}/{REPLACE_PAYLOAD_BYTE_LIMIT}; "
        "replace 必须保持单一全集 payload，未入队；请缩小 payload 后复用原 key 重试"
    )


def _chunk_payload(payload: Any, rows: list, start: int, end: int) -> Any:
    chunk_rows = rows[start:end]
    if isinstance(payload, list):
        return chunk_rows
    chunk = dict(payload)
    chunk["rows"] = chunk_rows
    return chunk


def make_coalesce_key(
    asset_id: str, op: str, payload: Any, unique_key_fields: list[str]
) -> str:
    """Return a stable identity for an upsert's complete business-key set.

    The row order and non-key values do not participate. A changed key set gets a
    different identity, so only stable mirror partitions can replace one another.
    """
    rows = _payload_rows(payload)
    if op != "bitable_rows_upsert" or not isinstance(rows, list) or not rows:
        return ""
    if not unique_key_fields:
        return ""
    key_rows: list[list[list[Any]]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            return ""
        values = []
        for field in unique_key_fields:
            value = row.get(field)
            if value is None or (isinstance(value, str) and not value.strip()):
                return ""
            values.append([field, value])
        encoded = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        if encoded in seen:
            return ""
        seen.add(encoded)
        key_rows.append(values)
    key_rows.sort(
        key=lambda values: json.dumps(
            values, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    )
    if len(key_rows) == 1:
        # Keep the deployed v1 identity for existing one-row pending aliases.
        raw = json.dumps(
            [asset_id, op, key_rows[0]],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return "v1:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()
    raw = json.dumps(
        [asset_id, op, key_rows], ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return "v2:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _enqueue_one(conn: sqlite3.Connection, *, dedupe_key: str, asset_id: str,
                 from_session: str, op: str, payload: Any, commit: bool,
                 coalesce_key: str = "", caller_provenance: str = "",
                 skill_provenance: str = "") -> dict[str, Any]:
    if commit:
        conn.execute("BEGIN IMMEDIATE")
    existing = conn.execute(
        "SELECT j.id, j.status, j.payload_json FROM sync_job_keys k"
        " JOIN sync_jobs j ON j.id=k.job_id WHERE k.dedupe_key=?",
        (dedupe_key,),
    ).fetchone()
    if existing is not None:
        # A dedupe key is an immutable terminal identity: callers must not turn
        # failed work back into runnable work by re-submitting the same key.
        if op == "bitable_attachment_replace_if_current":
            stored_payload = json.loads(existing["payload_json"])
            if payload.get("retry_authorization") != stored_payload.get(
                "retry_authorization"
            ):
                if commit:
                    conn.rollback()
                raise ValueError(
                    "attachment replace retry_authorization does not match the existing generation"
                )
        if commit:
            conn.commit()
        return {"job_id": existing["id"], "status": existing["status"], "duplicate": True, "retried": False}
    if op == "bitable_attachment_replace_if_current":
        from .attachment_replace import validate_attachment_replace_retry_generation

        try:
            validate_attachment_replace_retry_generation(
                conn,
                asset_id=asset_id,
                from_session=from_session,
                payload=payload,
            )
        except Exception:
            if commit:
                conn.rollback()
            raise
    if coalesce_key:
        pending = conn.execute(
            "SELECT id FROM sync_jobs WHERE status='pending' AND coalesce_key=?"
            " ORDER BY enqueued_at DESC, id DESC LIMIT 1",
            (coalesce_key,),
        ).fetchone()
        if pending is not None:
            now = _now()
            # A coalesced logical snapshot is a new immutable input episode;
            # retaining its old checkpoint could resume a prior payload/plan.
            conn.execute(
                "DELETE FROM sync_logical_snapshots WHERE job_id=?",
                (pending["id"],),
            )
            conn.execute(
                # caller_provenance 必须跟着 from_session 一起改写：合并后这行代表的是**本次**
                # 调用方，留着上一次的来源就是把新调用方渲染成旧调用方（misattribution）。
                "UPDATE sync_jobs SET from_session=?, payload_json=?, attempts=0, slice_claims=0, last_error='',"
                " enqueued_at=?, started_at='', processed_at='', receipt_ref='',"
                " caller_provenance=?, skill_provenance=?"
                " WHERE id=? AND status='pending'",
                (from_session, json.dumps(payload, ensure_ascii=False, sort_keys=True),
                 now, caller_provenance, skill_provenance, pending["id"]),
            )
            conn.execute(
                "INSERT INTO sync_job_keys (dedupe_key, job_id, created_at) VALUES (?,?,?)",
                (dedupe_key, pending["id"], now),
            )
            if commit:
                conn.commit()
            return {
                "job_id": pending["id"], "status": "pending", "duplicate": False,
                "retried": False, "coalesced": True,
            }
    now = _now()
    cur = conn.execute(
        "INSERT INTO sync_jobs"
        " (dedupe_key, asset_id, from_session, op, payload_json, enqueued_at, coalesce_key,"
        " caller_provenance, skill_provenance)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        (dedupe_key, asset_id, from_session, op,
         json.dumps(payload, ensure_ascii=False, sort_keys=True), now, coalesce_key,
         caller_provenance, skill_provenance),
    )
    conn.execute(
        "INSERT INTO sync_job_keys (dedupe_key, job_id, created_at) VALUES (?,?,?)",
        (dedupe_key, cur.lastrowid, now),
    )
    if commit:
        conn.commit()
    return {"job_id": cur.lastrowid, "status": "pending", "duplicate": False, "retried": False}


def enqueue(conn: sqlite3.Connection, *, dedupe_key: str, asset_id: str,
            from_session: str, op: str, payload: Any,
            coalesce_key: str = "",
            coalesce_unique_fields: list[str] | None = None,
            caller_provenance: str = "",
            skill_provenance: str = "") -> dict[str, Any]:
    return _retry_sqlite_write(
        conn,
        lambda: _enqueue_impl(
            conn,
            dedupe_key=dedupe_key,
            asset_id=asset_id,
            from_session=from_session,
            op=op,
            payload=payload,
            coalesce_key=coalesce_key,
            coalesce_unique_fields=coalesce_unique_fields,
            caller_provenance=caller_provenance,
            skill_provenance=skill_provenance,
        ),
        operation_name="enqueue",
    )


def _enqueue_impl(conn: sqlite3.Connection, *, dedupe_key: str, asset_id: str,
                  from_session: str, op: str, payload: Any,
                  coalesce_key: str = "",
                  coalesce_unique_fields: list[str] | None = None,
                  caller_provenance: str = "",
                  skill_provenance: str = "") -> dict[str, Any]:
    if op == LOGICAL_SNAPSHOT_OP:
        # enqueue() is itself an admission boundary.  Keep direct callers on
        # the same canonical contract validator as CLI and drain; otherwise a
        # malformed snapshot could be persisted and only rejected later.
        from .logical_snapshot import validate_snapshot_payload

        asset = _load_registered_asset_for_snapshot(asset_id)
        validate_snapshot_payload(asset, payload, caller_session=from_session)
    if op == "bitable_attachment_replace_if_current":
        from .attachment_replace import validate_attachment_replace_queue_entry

        validate_attachment_replace_queue_entry(asset_id, payload, dedupe_key)
    rows = _payload_rows(payload)
    if isinstance(rows, list) and len(rows) > FEISHU_TABLE_ROW_CAP:
        raise ValueError(
            f"enqueue rejected: {op} payload {len(rows)} rows > Feishu table cap "
            f"{FEISHU_TABLE_ROW_CAP}; 飞书单表上限 20000 行，超限写入不入队（避免 head-of-line "
            f"锁死队列，2026-07-04 事故）。owner 应改 bounded/增量同步或只保留最近 N 行。"
        )
    payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    payload_bytes = len(payload_json.encode("utf-8"))
    if op == "bitable_rows_replace" and isinstance(rows, list):
        if len(rows) > REPLACE_ROW_LIMIT or payload_bytes > REPLACE_PAYLOAD_BYTE_LIMIT:
            raise _replace_payload_too_large_error(len(rows), payload_bytes)
    if op == "bitable_rows_logical_snapshot" and isinstance(rows, list):
        if len(rows) > FEISHU_TABLE_ROW_CAP:
            raise ValueError(
                f"enqueue rejected: logical snapshot payload {len(rows)} rows > "
                f"Feishu table cap {FEISHU_TABLE_ROW_CAP}"
            )
        if payload_bytes > 20_000_000:
            raise ValueError(
                "enqueue rejected: logical snapshot payload exceeds 20000000 bytes; "
                "input was not queued"
            )
    if op == "bitable_rows_upsert" and isinstance(rows, list) and len(rows) > UPSERT_CHUNK_ROW_LIMIT:
        results = []
        conn.execute("BEGIN IMMEDIATE")
        try:
            for idx, start in enumerate(range(0, len(rows), UPSERT_CHUNK_ROW_LIMIT), start=1):
                chunk = _chunk_payload(payload, rows, start, start + UPSERT_CHUNK_ROW_LIMIT)
                chunk_coalesce_key = (
                    make_coalesce_key(asset_id, op, chunk, coalesce_unique_fields)
                    if coalesce_unique_fields else ""
                )
                results.append(_enqueue_one(
                    conn,
                    dedupe_key=f"{dedupe_key}#c{idx:03d}",
                    asset_id=asset_id,
                    from_session=from_session,
                    op=op,
                    payload=chunk,
                    commit=False,
                    coalesce_key=chunk_coalesce_key,
                    caller_provenance=caller_provenance,
                    skill_provenance=skill_provenance,
                ))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {
            "chunked": True,
            "chunks": len(results),
            "job_ids": [result["job_id"] for result in results],
            "status": "pending",
            "duplicate": all(result["duplicate"] for result in results),
            "results": results,
        }
    effective_coalesce_key = coalesce_key
    if not effective_coalesce_key and coalesce_unique_fields:
        effective_coalesce_key = make_coalesce_key(
            asset_id, op, payload, coalesce_unique_fields
        )
    return _enqueue_one(conn, dedupe_key=dedupe_key, asset_id=asset_id,
                        from_session=from_session, op=op, payload=payload, commit=True,
                        coalesce_key=effective_coalesce_key,
                        caller_provenance=caller_provenance,
                        skill_provenance=skill_provenance)


def _payload_uses_fields(payload: Any, fields: set[str]) -> bool:
    """payload 是否真的写了 fields 里的某个字段（upsert 是行列表、replace 是 {rows:[…]}）。"""
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return False
    return any(isinstance(row, dict) and (set(row) & fields) for row in rows)


def migration_exception_consumer(
    conn: sqlite3.Connection,
    *,
    asset_id: str,
    op: str,
    from_session: str,
    client_key_prefix: str,
    grant_fields: set[str],
    exclude_key: str,
) -> str | None:
    """返回一个已把本迁移例外用掉的 job 的 dedupe_key，若无则 None。

    判据：同 asset/op/from_session、status='done'、dedupe_key 命中 client_key_prefix、
    payload 真带过被授字段、且 dedupe_key != exclude_key。命中即代表例外已被『别的 key』
    消耗——调用方据此拒绝再授新 key。同一把 key（exclude_key）不计入：同 key 重放由队列
    dedupe 天然幂等，不是二次授予。"""
    rows = conn.execute(
        "SELECT dedupe_key, payload_json FROM sync_jobs "
        "WHERE asset_id=? AND op=? AND from_session=? AND status='done'",
        (asset_id, op, from_session),
    ).fetchall()
    for row in rows:
        key = str(row["dedupe_key"])
        if key == exclude_key or not key.startswith(client_key_prefix):
            continue
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            continue
        if _payload_uses_fields(payload, grant_fields):
            return key
    return None


def collapse_pending_latest(
    conn: sqlite3.Connection, *, policies: dict[str, list[str]], dry_run: bool = False
) -> dict[str, Any]:
    """Collapse eligible pending upserts with identical business-key sets only."""
    if not dry_run:
        conn.execute("BEGIN IMMEDIATE")
    groups: dict[str, list[sqlite3.Row]] = {}
    try:
        for row in conn.execute(
            "SELECT * FROM sync_jobs WHERE status='pending' ORDER BY enqueued_at, id"
        ).fetchall():
            unique_fields = policies.get(str(row["asset_id"]))
            if not unique_fields:
                continue
            try:
                payload = json.loads(str(row["payload_json"]))
            except json.JSONDecodeError:
                continue
            key = make_coalesce_key(
                str(row["asset_id"]), str(row["op"]), payload, unique_fields
            )
            if key:
                groups.setdefault(key, []).append(row)

        duplicate_groups = {key: rows for key, rows in groups.items() if len(rows) > 1}
        removed = sum(len(rows) - 1 for rows in duplicate_groups.values())
        per_asset: dict[str, dict[str, int]] = {}
        for rows in groups.values():
            asset_id = str(rows[0]["asset_id"])
            stats = per_asset.setdefault(
                asset_id, {"eligible_groups": 0, "duplicate_groups": 0, "removed_pending": 0}
            )
            stats["eligible_groups"] += 1
            if len(rows) > 1:
                stats["duplicate_groups"] += 1
                stats["removed_pending"] += len(rows) - 1
        result = {
            "dry_run": dry_run,
            "eligible_groups": len(groups),
            "duplicate_groups": len(duplicate_groups),
            "removed_pending": removed,
            "per_asset": per_asset,
            "survivor_job_ids": [],
        }
        if dry_run:
            return result
        for key, rows in duplicate_groups.items():
            survivor = max(rows, key=lambda item: (str(item["enqueued_at"]), int(item["id"])))
            removed_ids = [int(item["id"]) for item in rows if item["id"] != survivor["id"]]
            placeholders = ",".join("?" for _ in removed_ids)
            conn.execute(
                "UPDATE sync_jobs SET coalesce_key=? WHERE id=? AND status='pending'",
                (key, survivor["id"]),
            )
            conn.execute(
                f"UPDATE sync_job_keys SET job_id=? WHERE job_id IN ({placeholders})",
                [survivor["id"], *removed_ids],
            )
            conn.execute(
                f"DELETE FROM sync_jobs WHERE status='pending' AND id IN ({placeholders})",
                removed_ids,
            )
            result["survivor_job_ids"].append(int(survivor["id"]))
        conn.commit()
        return result
    except Exception:
        if not dry_run:
            conn.rollback()
        raise


def claim_next(conn: sqlite3.Connection) -> sqlite3.Row | None:
    """串行 drain 入口：拿最早 pending（不区分 asset_id）。保留作单 worker 兼容。"""
    row = conn.execute(
        "SELECT id FROM sync_jobs WHERE status='pending'"
        " AND (available_after='' OR available_after<=?) ORDER BY id LIMIT 1",
        (_now(),)
    ).fetchone()
    if row is None:
        return None
    cur = conn.execute(
        "UPDATE sync_jobs SET status='in_progress', started_at=?,"
        " attempts=attempts+CASE WHEN op=? THEN 0 ELSE 1 END,"
        " slice_claims=slice_claims+CASE WHEN op=? THEN 1 ELSE 0 END,"
        " last_error='', processed_at='', receipt_ref='', available_after=''"
        " WHERE id=? AND status='pending'",
        (_now(), LOGICAL_SNAPSHOT_OP, LOGICAL_SNAPSHOT_OP, row["id"]),
    )
    conn.commit()
    if cur.rowcount != 1:
        return None
    return conn.execute("SELECT * FROM sync_jobs WHERE id=?", (row["id"],)).fetchone()


def claim_next_for_asset(conn: sqlite3.Connection, asset_id: str) -> sqlite3.Row | None:
    """作用域 drain 入口：只拿指定 asset_id 的最早 pending job。

    用于发起方只想推进自家表的 job 而不卷入其他 asset 的 pending（场景：ad-adjust
    CPC controller 一次性提交一张表的 543 行批 patch，不愿意让 enqueue 后的 drain
    顺手处理别人队列里没收口的 pending）。SQL 层用 UPDATE…WHERE status='pending'
    防并发抢同一行（与 claim_next 同模式）。
    """
    row = conn.execute(
        "SELECT id FROM sync_jobs WHERE status='pending' AND asset_id=?"
        " AND (available_after='' OR available_after<=?) ORDER BY id LIMIT 1",
        (asset_id, _now()),
    ).fetchone()
    if row is None:
        return None
    cur = conn.execute(
        "UPDATE sync_jobs SET status='in_progress', started_at=?,"
        " attempts=attempts+CASE WHEN op=? THEN 0 ELSE 1 END,"
        " slice_claims=slice_claims+CASE WHEN op=? THEN 1 ELSE 0 END,"
        " last_error='', processed_at='', receipt_ref='', available_after=''"
        " WHERE id=? AND status='pending'",
        (_now(), LOGICAL_SNAPSHOT_OP, LOGICAL_SNAPSHOT_OP, row["id"]),
    )
    conn.commit()
    if cur.rowcount != 1:
        return None
    return conn.execute("SELECT * FROM sync_jobs WHERE id=?", (row["id"],)).fetchone()


def claim_pending_job_by_id(conn: sqlite3.Connection, job_id: int) -> sqlite3.Row | None:
    """Atomically claim one known pending job without draining sibling work."""
    cur = conn.execute(
        "UPDATE sync_jobs SET status='in_progress', started_at=?,"
        " attempts=attempts+CASE WHEN op=? THEN 0 ELSE 1 END,"
        " slice_claims=slice_claims+CASE WHEN op=? THEN 1 ELSE 0 END,"
        " last_error='', processed_at='', receipt_ref='', available_after=''"
        " WHERE id=? AND status='pending'",
        (_now(), LOGICAL_SNAPSHOT_OP, LOGICAL_SNAPSHOT_OP, job_id),
    )
    conn.commit()
    if cur.rowcount != 1:
        return None
    return conn.execute("SELECT * FROM sync_jobs WHERE id=?", (job_id,)).fetchone()


def claim_failed_job_for_recovery(
    conn: sqlite3.Connection, job_id: int, *, recovery_origin: dict[str, Any]
) -> sqlite3.Row:
    """Atomically claim exactly one non-final failed job for controlled recovery.

    All semantic preflight (receipt, contract, schema and payload evidence) is
    performed by the recovery owner before this narrow ledger mutation. This
    function only performs the final exact-id CAS and records the immutable
    recovery origin. A job can be recovered at most once, so a failed second
    attempt remains a dead letter instead of becoming an unbounded redrive loop.
    """
    if int(job_id) <= 0 or not isinstance(recovery_origin, dict):
        raise ValueError("positive job_id and recovery_origin object are required")
    if recovery_origin.get("origin") != "targeted_failed_job_recovery.v1":
        raise ValueError("recovery_origin.origin is required")
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT * FROM sync_jobs WHERE id=?", (int(job_id),)
        ).fetchone()
        if row is None:
            raise ValueError(f"unknown job_id: {job_id}")
        if row["status"] != "failed":
            raise ValueError(
                f"job {job_id} is not recoverable: status={row['status']}"
            )
        if int(row["recovery_count"] or 0) != 0:
            raise ValueError(f"job {job_id} already has a recovery attempt")
        origins = json.loads(row["recovery_origin_json"] or "[]")
        if not isinstance(origins, list) or origins:
            raise ValueError(f"job {job_id} has invalid recovery history")
        cur = conn.execute(
            "UPDATE sync_jobs SET status='in_progress', attempts=attempts+1,"
            " last_error='', started_at=?, processed_at='', receipt_ref='',"
            " recovery_count=1, recovery_origin_json=?"
            " WHERE id=? AND status='failed' AND recovery_count=0",
            (
                _now(),
                json.dumps([recovery_origin], ensure_ascii=False, sort_keys=True),
                int(job_id),
            ),
        )
        if cur.rowcount != 1:
            raise ValueError(f"job {job_id} changed before recovery claim")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return conn.execute("SELECT * FROM sync_jobs WHERE id=?", (int(job_id),)).fetchone()


def claim_next_excluding_busy_assets(conn: sqlite3.Connection) -> sqlite3.Row | None:
    """并行 drain 入口：按 asset round-robin 领取可运行的 pending job。

    `dispatch_cursor_v1` 持久化在队列 DB 中，因此一个热点 asset 不会因为一直有
    更早的 pending 行而吃掉所有空闲 worker；另一个长 job 占一个槽时，剩余槽仍会
    在各资产之间轮转。仍保证同 asset 跨 worker 串行，避免 2 个 worker 同时
    replace/upsert 同一张表导致 race / 重复写。整张表的 SELECT+UPDATE 用
    BEGIN IMMEDIATE 锁定，避免 N 个 worker 并发时撞同一行。
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        candidates = conn.execute(
            "SELECT asset_id FROM sync_jobs"
            " WHERE status='pending'"
            " AND (available_after='' OR available_after<=?)"
            " AND asset_id NOT IN ("
            "   SELECT DISTINCT asset_id FROM sync_jobs WHERE status='in_progress'"
            " )"
            " GROUP BY asset_id ORDER BY asset_id"
        , (_now(),)).fetchall()
        if not candidates:
            conn.execute("COMMIT")
            return None
        cursor = conn.execute(
            "SELECT value FROM sync_queue_meta WHERE key='dispatch_cursor_v1'"
        ).fetchone()
        cursor_asset = str(cursor["value"]) if cursor is not None else ""
        asset_ids = [str(candidate["asset_id"]) for candidate in candidates]
        selected_asset = next(
            (asset_id for asset_id in asset_ids if asset_id > cursor_asset),
            asset_ids[0],
        )
        row = conn.execute(
            "SELECT id FROM sync_jobs WHERE status='pending' AND asset_id=?"
            " AND (available_after='' OR available_after<=?) ORDER BY id LIMIT 1",
            (selected_asset, _now()),
        ).fetchone()
        if row is None:  # defensive: candidates are selected under the same write lock
            conn.execute("ROLLBACK")
            return None
        cur = conn.execute(
            "UPDATE sync_jobs SET status='in_progress', started_at=?,"
            " attempts=attempts+CASE WHEN op=? THEN 0 ELSE 1 END,"
            " slice_claims=slice_claims+CASE WHEN op=? THEN 1 ELSE 0 END,"
            " last_error='', processed_at='', receipt_ref='', available_after=''"
            " WHERE id=? AND status='pending'",
            (_now(), LOGICAL_SNAPSHOT_OP, LOGICAL_SNAPSHOT_OP, row["id"]),
        )
        if cur.rowcount != 1:
            conn.execute("ROLLBACK")
            return None
        conn.execute(
            "INSERT INTO sync_queue_meta (key, value) VALUES ('dispatch_cursor_v1', ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (selected_asset,),
        )
        conn.execute("COMMIT")
        return conn.execute("SELECT * FROM sync_jobs WHERE id=?", (row["id"],)).fetchone()
    except Exception:
        conn.execute("ROLLBACK")
        raise


def mark_done(conn: sqlite3.Connection, job_id: int, receipt_ref: str = "") -> bool:
    def update() -> bool:
        cur = conn.execute(
            "UPDATE sync_jobs SET status='done', processed_at=?, receipt_ref=?, last_error=''"
            " WHERE id=? AND status='in_progress'",
            (_now(), receipt_ref, job_id),
        )
        conn.commit()
        return cur.rowcount == 1

    return bool(_retry_sqlite_write(conn, update, operation_name=f"mark_done job={job_id}"))


def mark_readback_verified_done(
    conn: sqlite3.Connection, job_id: int, receipt_ref: str,
) -> bool:
    """Close a pending or in-progress job only after a read-back receipt exists.

    This is the no-remote-write reconcile path for work that landed before the
    queue ledger could commit.  It is intentionally a narrow CAS: it cannot
    reopen terminal jobs or create a replacement identity.
    """
    if not receipt_ref:
        raise ValueError("read-back reconciliation requires a receipt_ref")

    def update() -> bool:
        cur = conn.execute(
            "UPDATE sync_jobs SET status='done', processed_at=?, receipt_ref=?, last_error=''"
            " WHERE id=? AND status IN ('pending','in_progress')",
            (_now(), receipt_ref, job_id),
        )
        conn.commit()
        return cur.rowcount == 1

    return bool(_retry_sqlite_write(
        conn, update, operation_name=f"mark_readback_verified_done job={job_id}"
    ))


def mark_failed_reconciled_done(
    conn: sqlite3.Connection,
    job_id: int,
    receipt_ref: str,
    *,
    expected_error_marker: str,
) -> bool:
    """Close one failed job only after an owner reconcile receipt proves delivery.

    This deliberately cannot reopen arbitrary dead letters: the caller must
    provide the original terminal marker and the row must still be failed when
    the compare-and-set executes.
    """
    cur = conn.execute(
        "UPDATE sync_jobs SET status='done', processed_at=?, receipt_ref=?, last_error=''"
        " WHERE id=? AND status='failed' AND instr(last_error, ?) > 0",
        (_now(), receipt_ref, job_id, expected_error_marker),
    )
    conn.commit()
    return cur.rowcount == 1


def mark_failed_reconciled_done_preserving_error(
    conn: sqlite3.Connection,
    job_id: int,
    receipt_ref: str,
    *,
    expected_error_marker: str,
) -> bool:
    """Close one failed job while retaining its original terminal error evidence.

    Read-only recovery receipts supersede the job's receipt pointer but must not
    erase the reason the original write became ambiguous.  The same failed-state
    CAS and marker guard prevent this from reopening unrelated dead letters.
    """
    cur = conn.execute(
        "UPDATE sync_jobs SET status='done', processed_at=?, receipt_ref=?"
        " WHERE id=? AND status='failed' AND instr(last_error, ?) > 0",
        (_now(), receipt_ref, job_id, expected_error_marker),
    )
    conn.commit()
    return cur.rowcount == 1


def mark_failed_logical_snapshot_reconciled_pending(
    conn: sqlite3.Connection,
    job_id: int,
    receipt_ref: str,
    *,
    expected_error_marker: str,
) -> bool:
    """Resume one failed snapshot after a no-write in-flight proof.

    The original error remains visible until the normal snapshot claim clears it.
    This CAS is narrower than generic failed-job recovery: it cannot change an
    arbitrary failed job or create a second job, and it only returns the durable
    checkpoint to the existing pending worker path.
    """
    cur = conn.execute(
        "UPDATE sync_jobs SET status='pending', processed_at=?, receipt_ref=?"
        " WHERE id=? AND status='failed' AND op=? AND instr(last_error, ?) > 0",
        (
            _now(), receipt_ref, job_id,
            LOGICAL_SNAPSHOT_OP, expected_error_marker,
        ),
    )
    conn.commit()
    return cur.rowcount == 1


def mark_retry_or_failed(conn: sqlite3.Connection, job_id: int, error: str,
                         *, max_attempts: int = DEFAULT_MAX_ATTEMPTS,
                         permanent: bool = False,
                         attachment_retry_context: dict[str, Any] | None = None) -> str:
    """permanent=True：确定性失败（业务校验/字段配置），直接 failed 不再重试。"""
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT * FROM sync_jobs WHERE id=?", (job_id,)
        ).fetchone()
        if row is None:
            conn.commit()
            return ""
        failure_attempts = int(row["attempts"] or 0)
        if row["op"] == LOGICAL_SNAPSHOT_OP:
            # Snapshot claims count slices, not failures.  Only an actual
            # failed execution consumes the ordinary retry budget.
            failure_attempts += 1
        target = "failed" if (permanent or failure_attempts >= max_attempts) else "pending"
        cur = conn.execute(
            "UPDATE sync_jobs SET status=?, attempts=?, last_error=?, processed_at=?, available_after=''"
            " WHERE id=? AND status='in_progress'",
            (target, failure_attempts, str(error)[:2000], _now(), job_id),
        )
        if cur.rowcount != 1:
            conn.commit()
            return ""
        if target == "failed" and attachment_retry_context is not None:
            payload = json.loads(row["payload_json"])
            _issue_attachment_retry_authorization(conn, row, payload)
        conn.commit()
        return target
    except Exception:
        conn.rollback()
        raise


def mark_snapshot_continuation(
    conn: sqlite3.Connection,
    job_id: int,
    *,
    available_after: str,
) -> bool:
    """Return one bounded logical-snapshot slice to the pending queue.

    The continuation CAS is deliberately separate from ordinary retry: the slice
    already has a durable checkpoint, so the worker is released without consuming
    the retry budget or pretending that a remote write failed.
    """
    cur = conn.execute(
        "UPDATE sync_jobs SET status='pending', processed_at=?, last_error='',"
        " started_at='', receipt_ref='', available_after=?"
        " WHERE id=? AND status='in_progress'",
        (_now(), available_after, job_id),
    )
    conn.commit()
    return cur.rowcount == 1


def set_receipt_ref(conn: sqlite3.Connection, job_id: int, receipt_ref: str) -> bool:
    """终态 job 落 receipt 后回填 receipt_ref（失败路径用：成功路径已在 mark_done 一并写入）。"""
    cur = conn.execute(
        "UPDATE sync_jobs SET receipt_ref=? WHERE id=?", (receipt_ref, job_id))
    conn.commit()
    return cur.rowcount == 1


def triage_failed_jobs(
    conn: sqlite3.Connection, *, disabled_asset_ids: set[str] | None = None,
    apply: bool = True,
) -> dict[str, Any]:
    """分类 failed 死信并只执行可机械证明安全的动作。

    apply=False 时只生成动作计划，供调用方先把原始诊断写入 receipt；apply=True 才执行。
    已废/取消的原 payload 删除其 job 与 alias；明确 transient 的失败重置回 pending；其余
    exhausted 或 deterministic failure 保留 failed，由业务 owner 修复后以新 payload/new dedupe key
    接管。所有状态变更均以 status='failed' 作为并发闸，不能覆盖已经被其他流程转换的 job。
    """
    disabled = disabled_asset_ids or set()
    rows = conn.execute(
        "SELECT id, asset_id, dedupe_key, attempts, last_error FROM sync_jobs "
        "WHERE status='failed' ORDER BY id"
    ).fetchall()
    result: dict[str, Any] = {
        "scanned": len(rows),
        "archived_pruned": 0,
        "requeued": 0,
        "requires_owner": 0,
        "archived_jobs": [],
        "requeued_jobs": [],
        "requires_owner_jobs": [],
    }
    now = _now()
    if apply:
        conn.execute("BEGIN IMMEDIATE")
    try:
        for row in rows:
            job_id = int(row["id"])
            asset_id = str(row["asset_id"])
            error = str(row["last_error"])
            normalized = error.lower()
            record = {
                "job_id": job_id,
                "asset_id": asset_id,
                "dedupe_key": str(row["dedupe_key"]),
                "attempts": int(row["attempts"]),
                "last_error": error[:500],
            }
            retain_evidence = any(
                marker in normalized for marker in _RETAIN_FAILED_MARKERS
            )
            archive = not retain_evidence and (asset_id in disabled or any(
                marker in normalized for marker in _ARCHIVE_FAILED_MARKERS
            ))
            retryable = (
                not archive
                and "do not retry" not in normalized
                and any(marker in normalized for marker in _TRANSIENT_RETRY_MARKERS)
            )
            if archive:
                if not apply:
                    result["archived_pruned"] += 1
                    result["archived_jobs"].append(record)
                    continue
                conn.execute("DELETE FROM sync_job_keys WHERE job_id=?", (job_id,))
                deleted = conn.execute(
                    "DELETE FROM sync_jobs WHERE id=? AND status='failed'", (job_id,)
                )
                if deleted.rowcount == 1:
                    _revoke_pending_attachment_retry_authorizations(conn, job_id)
                    result["archived_pruned"] += 1
                    result["archived_jobs"].append(record)
                continue
            if retryable:
                if not apply:
                    result["requeued"] += 1
                    result["requeued_jobs"].append(record)
                    continue
                updated = conn.execute(
                    "UPDATE sync_jobs SET status='pending', attempts=0, last_error='', "
                    "enqueued_at=?, started_at='', processed_at='', receipt_ref='' "
                    "WHERE id=? AND status='failed'",
                    (now, job_id),
                )
                if updated.rowcount == 1:
                    result["requeued"] += 1
                    result["requeued_jobs"].append(record)
                continue
            result["requires_owner"] += 1
            result["requires_owner_jobs"].append(record)
        if apply:
            conn.commit()
    except Exception:
        if apply:
            conn.rollback()
        raise
    return result


def hold_pending_for_asset(
    conn: sqlite3.Connection, asset_id: str, *, reason: str
) -> int:
    asset = str(asset_id or "").strip()
    message = str(reason or "").strip()
    if not asset or not message:
        raise ValueError("asset_id and hold reason are required")
    cur = conn.execute(
        "UPDATE sync_jobs SET status='held', last_error=?"
        " WHERE asset_id=? AND status='pending'",
        (message[:2000], asset),
    )
    conn.commit()
    return cur.rowcount


def release_held_for_asset(conn: sqlite3.Connection, asset_id: str) -> int:
    asset = str(asset_id or "").strip()
    if not asset:
        raise ValueError("asset_id is required")
    cur = conn.execute(
        "UPDATE sync_jobs SET status='pending', last_error='',"
        " started_at='', processed_at='', receipt_ref=''"
        " WHERE asset_id=? AND status='held'",
        (asset,),
    )
    conn.commit()
    return cur.rowcount


def release_held_job(
    conn: sqlite3.Connection, job_id: int, *, asset_id: str
) -> int:
    asset = str(asset_id or "").strip()
    if int(job_id) <= 0 or not asset:
        raise ValueError("positive job_id and asset_id are required")
    cur = conn.execute(
        "UPDATE sync_jobs SET status='pending', last_error='',"
        " started_at='', processed_at='', receipt_ref=''"
        " WHERE id=? AND asset_id=? AND status='held'",
        (int(job_id), asset),
    )
    conn.commit()
    return cur.rowcount


def supersede_held_for_asset(
    conn: sqlite3.Connection,
    asset_id: str,
    *,
    replacement_job_ids: list[int],
    unique_key_fields: list[str],
    evidence_ref: str,
) -> int:
    """Close held work only when a same-asset replacement has verified owner receipt proof."""
    from .sync_status import job_receipt_provenance

    asset = str(asset_id or "").strip()
    evidence = str(evidence_ref or "").strip()
    replacement_ids = sorted({int(item) for item in replacement_job_ids})
    fields = [str(item).strip() for item in unique_key_fields if str(item).strip()]
    if (
        not asset
        or not replacement_ids
        or any(item <= 0 for item in replacement_ids)
        or not fields
        or not evidence
    ):
        raise ValueError(
            "asset_id, positive replacement_job_ids, unique_key_fields and evidence_ref are required"
        )
    conn.execute("BEGIN IMMEDIATE")
    try:
        held_rows = conn.execute(
            "SELECT id, op, payload_json FROM sync_jobs"
            " WHERE asset_id=? AND status='held' ORDER BY id",
            (asset,),
        ).fetchall()
        if not held_rows:
            conn.commit()
            return 0
        held_ids = [int(row["id"]) for row in held_rows]

        def payload_keys(row: sqlite3.Row) -> set[str]:
            if str(row["op"]) != "bitable_rows_upsert":
                raise ValueError(
                    "held supersede only supports bitable_rows_upsert mirrors"
                )
            try:
                payload = json.loads(str(row["payload_json"]))
            except json.JSONDecodeError as exc:
                raise ValueError("replacement coverage payload is invalid JSON") from exc
            rows = _payload_rows(payload)
            if not isinstance(rows, list) or not rows:
                raise ValueError("replacement coverage requires non-empty row payloads")
            keys: set[str] = set()
            for item in rows:
                if not isinstance(item, dict):
                    raise ValueError("replacement coverage row must be an object")
                values: list[list[Any]] = []
                for field in fields:
                    value = item.get(field)
                    empty_container = isinstance(value, (list, dict)) and not value
                    if (
                        value is None
                        or (isinstance(value, str) and not value.strip())
                        or empty_container
                    ):
                        raise ValueError(
                            f"replacement coverage row missing unique key field {field}"
                        )
                    values.append([field, value])
                encoded = json.dumps(
                    values, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                if encoded in keys:
                    raise ValueError(
                        "replacement coverage contains duplicate business key"
                    )
                keys.add(encoded)
            return keys

        replacement_keys: set[str] = set()
        for replacement_id in replacement_ids:
            replacement = conn.execute(
                "SELECT * FROM sync_jobs WHERE id=?", (replacement_id,)
            ).fetchone()
            if replacement is None or str(replacement["asset_id"]) != asset:
                raise ValueError(
                    "verified_done replacements must belong to the same asset"
                )
            replacement_payload = dict(replacement)
            provenance = job_receipt_provenance(replacement_payload)
            if (
                replacement_payload.get("status") != "done"
                or provenance.get("receipt_job_verified") is not True
                or provenance.get("read_back_verified") is not True
            ):
                raise ValueError(
                    "verified_done replacement with owner receipt is required"
                )
            current_keys = payload_keys(replacement)
            if replacement_keys.intersection(current_keys):
                raise ValueError(
                    "replacement coverage contains duplicate business key"
                )
            replacement_keys.update(current_keys)

        held_keys: set[str] = set()
        for held_row in held_rows:
            held_keys.update(payload_keys(held_row))
        missing_keys = held_keys - replacement_keys
        if missing_keys:
            raise ValueError(
                "verified_done replacements do not cover held business keys: "
                f"missing={len(missing_keys)}"
            )
        placeholders = ",".join("?" for _ in held_ids)
        cur = conn.execute(
            "UPDATE sync_jobs SET status='superseded', processed_at=?,"
            " superseded_by_job_id=?, superseded_by_job_ids=?,"
            " supersede_evidence_ref=?, last_error=?"
            f" WHERE asset_id=? AND status='held' AND id IN ({placeholders})",
            (
                _now(),
                replacement_ids[0],
                json.dumps(replacement_ids, separators=(",", ":")),
                evidence[:2000],
                "superseded by verified replacement jobs "
                + ",".join(str(item) for item in replacement_ids),
                asset,
                *held_ids,
            ),
        )
        if cur.rowcount != len(held_ids):
            raise RuntimeError("held supersede snapshot changed before conditional update")
        conn.commit()
        return cur.rowcount
    except Exception:
        conn.rollback()
        raise


def _cancel_held_for_disabled_asset(
    conn: sqlite3.Connection,
    asset_id: str,
    *,
    contract_sha256: str,
    evidence_ref: str,
) -> int:
    """Internal state convergence after the canonical contract forbids writes."""
    asset = str(asset_id or "").strip()
    contract_hash = str(contract_sha256 or "").strip()
    evidence = str(evidence_ref or "").strip()
    valid = (
        asset
        and len(contract_hash) == 64
        and all(ch in "0123456789abcdef" for ch in contract_hash.lower())
        and evidence
    )
    if not valid:
        raise ValueError("held cancellation requires canonical contract evidence")

    conn.execute("BEGIN IMMEDIATE")
    try:
        held_ids = [
            int(row["id"])
            for row in conn.execute(
                "SELECT id FROM sync_jobs"
                " WHERE asset_id=? AND status='held' ORDER BY id",
                (asset,),
            ).fetchall()
        ]
        if not held_ids:
            conn.commit()
            return 0
        placeholders = ",".join("?" for _ in held_ids)
        cur = conn.execute(
            "UPDATE sync_jobs SET status='cancelled', processed_at=?,"
            " cancelled_by_contract_sha256=?, cancel_evidence_ref=?,"
            " last_error=?"
            f" WHERE asset_id=? AND status='held' AND id IN ({placeholders})",
            (
                _now(),
                contract_hash,
                evidence[:2000],
                "cancelled because the authoritative contract forbids target writes",
                asset,
                *held_ids,
            ),
        )
        if cur.rowcount != len(held_ids):
            raise RuntimeError(
                "held cancellation snapshot changed before conditional update"
            )
        conn.commit()
        return cur.rowcount
    except Exception:
        conn.rollback()
        raise


def reset_stale(conn: sqlite3.Connection, *, stale_minutes: int = DEFAULT_STALE_MINUTES) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=stale_minutes)).isoformat(timespec="seconds")
    cur = conn.execute(
        "UPDATE sync_jobs SET status='pending' WHERE status='in_progress' AND started_at < ?",
        (cutoff,),
    )
    conn.commit()
    return cur.rowcount


def prune_done_payloads(
    conn: sqlite3.Connection, *, older_than_days: int = 7, now: str | None = None
) -> int:
    """done job 的 payload N 天后置空（行、终态、receipt_ref、键别名全保留）。

    Why：done payload 永久留存曾把队列库堆到 1.2GB（2026-07 盘点）；failed 不清，
    payload 是排障证据。幂等：已置空的行不再计数。"""
    reference = now or datetime.now(timezone.utc).isoformat(timespec="seconds")
    cutoff = (
        datetime.fromisoformat(reference.replace("Z", "+00:00"))
        - timedelta(days=older_than_days)
    ).isoformat(timespec="seconds")
    cur = conn.execute(
        "UPDATE sync_jobs SET payload_json='[]' WHERE status='done'"
        " AND payload_json != '[]' AND processed_at != '' AND processed_at < ?",
        (cutoff,),
    )
    conn.commit()
    return cur.rowcount


def prune(conn: sqlite3.Connection, *, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat(timespec="seconds")
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            "SELECT id FROM sync_jobs WHERE status IN ('done','failed')"
            " AND processed_at != '' AND processed_at < ?",
            (cutoff,),
        ).fetchall()
        job_ids = [int(row["id"]) for row in rows]
        if job_ids:
            placeholders = ",".join("?" for _ in job_ids)
            for job_id in job_ids:
                _revoke_pending_attachment_retry_authorizations(conn, job_id)
            conn.execute(
                f"DELETE FROM sync_job_keys WHERE job_id IN ({placeholders})", job_ids
            )
            conn.execute(
                f"DELETE FROM sync_logical_snapshots WHERE job_id IN ({placeholders})", job_ids
            )
            conn.execute(
                f"DELETE FROM sync_jobs WHERE id IN ({placeholders})", job_ids
            )
        conn.commit()
        return len(job_ids)
    except Exception:
        conn.rollback()
        raise


def status_counts(conn: sqlite3.Connection) -> dict[str, Any]:
    """Public queue health: current counts plus event windows, never snapshot-only."""
    counts: dict[str, Any] = {
        "pending": 0, "in_progress": 0, "held": 0, "superseded": 0,
        "cancelled": 0,
        "done": 0, "failed": 0
    }
    rows = conn.execute(
        "SELECT status, COUNT(*) AS n, MIN(enqueued_at) AS oldest_enqueued_at"
        " FROM sync_jobs GROUP BY status"
    ).fetchall()
    now = datetime.now(timezone.utc)
    for row in rows:
        status = str(row["status"])
        counts[status] = int(row["n"])
        if status == "pending" and row["oldest_enqueued_at"]:
            oldest = datetime.fromisoformat(str(row["oldest_enqueued_at"]))
            if oldest.tzinfo is None:
                oldest = oldest.replace(tzinfo=timezone.utc)
            age_seconds = int((now - oldest.astimezone(timezone.utc)).total_seconds())
            if age_seconds >= 0:
                counts["pending_oldest_age_seconds"] = age_seconds
    for minutes in (15, 60):
        cutoff = (now - timedelta(minutes=minutes)).isoformat(timespec="seconds")
        submissions = int(conn.execute(
            "SELECT COUNT(*) FROM sync_job_keys WHERE created_at>=?", (cutoff,)
        ).fetchone()[0])
        terminal_rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM sync_jobs"
            " WHERE status IN ('done','failed','superseded','cancelled')"
            " AND processed_at>=? GROUP BY status",
            (cutoff,),
        ).fetchall()
        terminal_by_status = {str(item["status"]): int(item["n"]) for item in terminal_rows}
        terminal = sum(terminal_by_status.values())
        started = int(conn.execute(
            "SELECT COUNT(*) FROM sync_jobs WHERE started_at>=?", (cutoff,)
        ).fetchone()[0])
        if terminal > submissions:
            trend = "draining"
        elif submissions > terminal:
            trend = "growing"
        elif terminal:
            trend = "balanced"
        else:
            trend = "stalled"
        counts[f"window_{minutes}m"] = {
            "minutes": minutes,
            "submissions": submissions,
            "started": started,
            "terminal": terminal,
            "done": terminal_by_status.get("done", 0),
            "failed": terminal_by_status.get("failed", 0),
            "superseded": terminal_by_status.get("superseded", 0),
            "cancelled": terminal_by_status.get("cancelled", 0),
            "arrival_minus_terminal": submissions - terminal,
            "trend": trend,
        }
    counts["top_pending_assets"] = [
        {"asset_id": str(item["asset_id"]), "pending": int(item["n"])}
        for item in conn.execute(
            "SELECT asset_id, COUNT(*) AS n FROM sync_jobs WHERE status='pending'"
            " GROUP BY asset_id ORDER BY n DESC, asset_id LIMIT 10"
        ).fetchall()
    ]
    counts["top_held_assets"] = [
        {"asset_id": str(item["asset_id"]), "held": int(item["n"])}
        for item in conn.execute(
            "SELECT asset_id, COUNT(*) AS n FROM sync_jobs WHERE status='held'"
            " GROUP BY asset_id ORDER BY n DESC, asset_id LIMIT 10"
        ).fetchall()
    ]
    return counts
