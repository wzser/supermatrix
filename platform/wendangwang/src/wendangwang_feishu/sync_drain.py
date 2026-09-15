from __future__ import annotations

import fcntl
import glob as globmod
import hashlib
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .bitable import (
    AmbiguousCreateReadBackError,
    AmbiguousDeleteReadBackError,
    RemoteReadonlyUpdateResponse,
    _create_if_absent_key_lock,
    _field_types,
    _search_records_by_key,
    _write_fields_match,
    bitable_attachment_upload,
    bitable_live_sync,
    bitable_record_delete_if_current,
    bitable_record_update_if_current,
    bitable_rows_create_if_absent,
    bitable_rows_update_existing,
    bitable_rows_replace,
    bitable_upsert_plan,
    check_migration_restore_attachment,
    check_controlled_attachment_upload,
    check_controlled_rows_update_existing,
    enforce_migration_write_upsert_shape,
    migration_restore_upsert_grant,
    resolve_migration_write_exception,
    resolve_migration_write_grant,
    validate_rows_create_if_absent_payload,
    _live_select_option_names,
)
from .attachment_dedupe import bitable_attachment_dedupe
from .attachment_replace import (
    ATTACHMENT_REPLACE_OP,
    AttachmentRetryableMediaFailure,
    attachment_retry_advice,
    bitable_attachment_replace_if_current,
    check_controlled_attachment_replace,
    validate_attachment_replace_queue_entry,
)
from .logical_snapshot import (
    LogicalSnapshotReconcileError,
    LogicalSnapshotPreflightError,
    LogicalSnapshotUnknownWriteError,
    SNAPSHOT_CONTINUATION_DELAY_S,
    SNAPSHOT_OP,
    SnapshotBudgetExceeded,
    _json_sha256,
    run_logical_snapshot,
    validate_snapshot_reconcile_checkpoint,
    validate_snapshot_payload,
)
from .lark_cli import LarkCli, LarkCliError
from .notify import escalate
from .receipts import write_receipt
from .registry import load_asset_contract
from .sync_queue import (
    DEFAULT_DB,
    DEFAULT_MAX_ATTEMPTS,
    claim_failed_job_for_recovery,
    claim_pending_job_by_id,
    claim_next_excluding_busy_assets,
    claim_next_for_asset,
    connect,
    enqueue,
    mark_done,
    QueueWriteUnavailable,
    mark_failed_reconciled_done,
    mark_failed_reconciled_done_preserving_error,
    mark_retry_or_failed,
    mark_snapshot_continuation,
    attachment_retry_authorization_for_job,
    migration_exception_consumer,
    _payload_rows,
    get_logical_snapshot_state,
    set_receipt_ref,
    mark_failed_logical_snapshot_reconciled_pending,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LOCK = REPO_ROOT / "data" / "sync-queue.lock"
DEFAULT_RECEIPT_DIR = REPO_ROOT / "data" / "receipts"
DEFAULT_REGISTRY_GLOB = str(REPO_ROOT / "registry" / "assets" / "**" / "*.json")


def _lock_file_for(lock_path: Path | str | None, asset_scope: str | None) -> Path:
    """全局 drain 用全局锁；scoped drain 用 per-asset 锁文件 `<stem>.<asset>.lock`，
    使不同 asset 的 scoped drain 互不阻塞（单 asset 卡死不锁死整队列）。asset 名做文件名
    安全化（非 [A-Za-z0-9._-] 转 _，截断 80 字符）——安全化后即使撞名也只是退回共享一把锁、
    仍正确（原子 claim 兜底），不会串到全局锁。"""
    base = Path(lock_path) if lock_path else DEFAULT_LOCK
    if not asset_scope:
        return base
    # 只替换路径危险字符（/ \ : 空白 控制符），保留中文等 unicode——asset_id 常含中文表名，
    # 全转 _ 会让不同中文表撞同名锁、丢隔离（本仓 registry 文件名本就带中文，文件系统支持）。
    safe = re.sub(r"[/\\:\s\x00-\x1f]", "_", asset_scope)[:120]
    return base.parent / f"{base.stem}.{safe}{base.suffix}"

# 失败分类（倒置语义）：明确知道重试不会变好的才立即失败，其余 API 错误一律退避重试。
# 底气是幂等——所有 op 重跑安全，"多退避几次"零代价，"漏判新限流措辞直接 failed"才是真损失。
_PERMANENT_ERROR_TYPES = {"validation", "confirmation_required"}  # lark-cli 本地校验 / 高危确认
_PERMANENT_ERROR_CODES = {800010701, 91403}  # 飞书请求 schema 拒绝 / 无权限
_FEISHU_QUOTA_ERROR_CODES = {800004135}


class AuthoritativeReadBackNotVerified(RuntimeError):
    """A strict authority write lacks read-back proof and must not be replayed."""


def _parse_lark_error(exc: Exception) -> dict[str, Any]:
    text = str(exc)
    start = text.find("{")
    if start < 0:
        return {}
    try:
        payload = json.loads(text[start:])
    except (json.JSONDecodeError, ValueError):
        return {}
    return payload.get("error") or {}


def is_permanent_error(exc: Exception) -> bool:
    """重试不可能变好的错误：我们自己的校验（ValueError）、飞书 schema/权限拒绝。
    其余（未知措辞的限流/配额/瞬时故障）默认可重试——新形态永远不会被漏判成永久失败。"""
    if isinstance(exc, (
        ValueError,
        RemoteReadonlyUpdateResponse,
        AmbiguousCreateReadBackError,
        AmbiguousDeleteReadBackError,
        AuthoritativeReadBackNotVerified,
        LogicalSnapshotUnknownWriteError,
        LogicalSnapshotPreflightError,
    )):
        return True
    if not isinstance(exc, LarkCliError):
        return False
    error = _parse_lark_error(exc)
    if error.get("type") in _PERMANENT_ERROR_TYPES:
        return True
    if error.get("code") in _PERMANENT_ERROR_CODES:
        return True
    return False


def is_feishu_quota_error(exc: Exception) -> bool:
    if not isinstance(exc, LarkCliError):
        return False
    error = _parse_lark_error(exc)
    return error.get("code") in _FEISHU_QUOTA_ERROR_CODES


def _incident_metadata(exc: Exception, op: str) -> dict[str, str]:
    message = str(exc)
    if isinstance(exc, AmbiguousDeleteReadBackError):
        root_cause_code = "ambiguous_delete_read_back_not_verified"
    elif isinstance(exc, AmbiguousCreateReadBackError):
        root_cause_code = "ambiguous_create_read_back_not_verified"
    elif isinstance(exc, AuthoritativeReadBackNotVerified):
        root_cause_code = "read_back_not_verified"
    elif isinstance(exc, RemoteReadonlyUpdateResponse):
        root_cause_code = "contract_field_not_allowed"
    elif "unknown asset_id:" in message:
        root_cause_code = "unknown_asset"
    elif "sync_direction=none" in message:
        root_cause_code = "sync_disabled"
    elif "live sync not verified" in message:
        root_cause_code = "read_back_not_verified"
    elif isinstance(exc, FileNotFoundError) or (
        "No such file or directory" in message and "lark-cli" in message
    ):
        root_cause_code = "lark_cli_unavailable"
    elif isinstance(exc, LarkCliError):
        error = _parse_lark_error(exc)
        code = error.get("code")
        root_cause_code = f"feishu_{code}" if code is not None else "lark_cli_error"
    elif isinstance(exc, ValueError):
        validation_families = (
            ("state_drift/CAS conflict:", "state_drift_cas_conflict"),
            ("unsupported op:", "unsupported_op"),
            ("unsupported field type:", "unsupported_field_type"),
            ("asset has no table contract", "missing_table_contract"),
            ("caller_session ", "owner_mismatch"),
            ("missing unique key", "missing_unique_key"),
            ("duplicate input unique key", "duplicate_input_unique_key"),
            ("duplicate existing unique key", "duplicate_remote_unique_key"),
            ("fields not allowed by contract:", "contract_field_not_allowed"),
            ("fields not writable by caller:", "contract_field_not_writable"),
            ("attachment field not in contract:", "attachment_field_not_allowed"),
            ("delete_guard field not in contract:", "delete_guard_field_not_allowed"),
            ("target record not found", "target_record_not_found"),
            ("ambiguous target records", "target_record_ambiguous"),
        )
        root_cause_code = next(
            (code for marker, code in validation_families if marker in message),
            "validation_" + hashlib.sha256(message.encode("utf-8")).hexdigest()[:10],
        )
    else:
        root_cause_code = type(exc).__name__.lower()
    fingerprint = f"{root_cause_code}:{op}"
    return {
        "root_cause_code": root_cause_code,
        "incident_fingerprint": fingerprint,
    }


def _is_ambiguous_create_command(args: list[str]) -> bool:
    """A create without a stable record ID cannot be replayed after transport loss."""
    command = args[1] if len(args) > 1 else ""
    if command in {"+record-create", "+record-batch-create"}:
        return True
    return command == "+record-upsert" and "--record-id" not in args


class PacedLarkCli:
    """给底层 LarkCli 加节奏：相邻调用之间 sleep interval；非永久错误按 backoff 重试后再抛。"""

    def __init__(self, inner: Any = None, *, interval_ms: int = 250,
                 backoff_seconds: tuple[float, ...] = (1, 5, 25),
                 quota_backoff_seconds: tuple[float, ...] = (10, 60, 180),
                 sleeper: Callable[[float], None] = time.sleep) -> None:
        self.inner = inner or LarkCli()
        self.interval_ms = interval_ms
        self.backoff_seconds = backoff_seconds
        self.quota_backoff_seconds = quota_backoff_seconds
        self.sleeper = sleeper
        self._called = False

    def run_json(
        self, args: list[str], *, cwd: str | None = None, timeout: float | None = None
    ) -> dict[str, Any]:
        last: Exception | None = None
        backoffs = self.backoff_seconds
        attempt = 0
        while attempt <= len(backoffs):
            delay = 0 if attempt == 0 else backoffs[attempt - 1]
            if delay:
                self.sleeper(delay)
            elif self._called:
                self.sleeper(self.interval_ms / 1000)
            self._called = True
            try:
                return self.inner.run_json(args, cwd=cwd, timeout=timeout)
            except LarkCliError as exc:
                if _is_ambiguous_create_command(args) or is_permanent_error(exc):
                    raise
                last = exc
                if is_feishu_quota_error(exc):
                    backoffs = self.quota_backoff_seconds
            attempt += 1
        raise last  # type: ignore[misc]

    def run_json_no_retry(
        self, args: list[str], *, cwd: str | None = None, timeout: float | None = None
    ) -> dict[str, Any]:
        """Send exactly one paced request.

        A destructive request whose transport result is unknown must be
        settled by read-back, not replayed by this convenience retry wrapper.
        Read operations continue to use :meth:`run_json` and retain ordinary
        retry behaviour.
        """
        if self._called:
            self.sleeper(self.interval_ms / 1000)
        self._called = True
        return self.inner.run_json(args, cwd=cwd, timeout=timeout)


def _normalize_queue_link_record_ids(asset: Any, rows: Any) -> Any:
    if not asset.tables or not isinstance(rows, list):
        return rows
    link_fields = {
        field.name_zh
        for field in asset.tables[0].fields
        if field.type in {"link", "single_link", "duplex_link", "relation"}
    }
    if not link_fields:
        return rows

    normalized_rows = []
    changed = False
    for row in rows:
        normalized_row = row
        if isinstance(row, dict):
            for field in link_fields:
                value = row.get(field)
                if not isinstance(value, list):
                    continue
                normalized_value = [
                    {"id": item["record_id"]}
                    if isinstance(item, dict) and set(item) == {"record_id"}
                    else item
                    for item in value
                ]
                if normalized_value != value:
                    if normalized_row is row:
                        normalized_row = dict(row)
                    normalized_row[field] = normalized_value
        changed = changed or normalized_row is not row
        normalized_rows.append(normalized_row)
    return normalized_rows if changed else rows


def _dispatch_op(op: str, asset: Any, payload: Any, *, caller_session: str, cli: Any,
                 migration_grant_fields: set[str] | None = None,
                 client_key: str | None = None) -> dict[str, Any]:
    """按 op 把队列 job 派给对应 bitable 写入函数。payload 形状随 op 而定。"""
    if op == "bitable_rows_upsert":
        rows = _normalize_queue_link_record_ids(asset, payload)
        return bitable_live_sync(asset, rows, caller_session=caller_session, lark=cli,
                                 actor="user", queue_op=op,
                                 migration_grant_fields=migration_grant_fields)
    if op == "bitable_rows_create_if_absent":
        return bitable_rows_create_if_absent(
            asset, payload, caller_session=caller_session, lark=cli, actor="user",
        )
    if op == "bitable_rows_update_existing":
        rows = _normalize_queue_link_record_ids(asset, payload)
        return bitable_rows_update_existing(
            asset, rows, caller_session=caller_session, lark=cli, actor="user")
    if op == "bitable_rows_replace":
        rows = _normalize_queue_link_record_ids(asset, payload["rows"])
        return bitable_rows_replace(
            asset, rows, caller_session=caller_session,
            delete_guard=payload.get("delete_guard"), max_delete=payload["max_delete"],
            lark=cli, actor="user", migration_grant_fields=migration_grant_fields)
    if op == "bitable_attachment_upload":
        return bitable_attachment_upload(
            asset, payload["unique_key"], payload["field"], payload["files"],
            caller_session=caller_session, lark=cli, actor="user")
    if op == ATTACHMENT_REPLACE_OP:
        return bitable_attachment_replace_if_current(
            asset, payload, caller_session=caller_session, lark=cli, actor="user"
        )
    if op == "bitable_attachment_dedupe":
        return bitable_attachment_dedupe(
            asset, payload, caller_session=caller_session, lark=cli, actor="user")
    if op == "bitable_record_update_if_current":
        return bitable_record_update_if_current(
            asset, payload, caller_session=caller_session, lark=cli, actor="user",
            client_key=client_key,
        )
    if op == "bitable_record_delete_if_current":
        return bitable_record_delete_if_current(
            asset, payload, caller_session=caller_session, lark=cli, actor="user",
            client_key=client_key,
        )
    raise ValueError(f"unsupported op: {op}")


def _load_contract_index(registry_glob: str) -> dict[str, Any]:
    index: dict[str, Any] = {}
    for path in sorted(globmod.glob(registry_glob, recursive=True)):
        if "/examples/" in path:
            continue
        try:
            asset = load_asset_contract(Path(path))
        except Exception:
            continue  # 非法合同由 reconcile 上报，drain 不在这里炸
        index[asset.asset_id] = asset
    return index


_TARGETED_RECOVERY_ORIGIN = "targeted_failed_job_recovery.v1"
_TARGETED_RECOVERY_ERROR_MARKER = "select values missing from contract options"


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _payload_recovery_sha256(asset: Any, payload: Any) -> str:
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(rows, list) or not asset.tables:
        raise ValueError("targeted recovery requires a table row payload")
    table = asset.tables[0]
    if not table.unique_key:
        raise ValueError("targeted recovery requires a table unique_key")
    if not all(isinstance(row, dict) for row in rows):
        raise ValueError("targeted recovery payload rows must be objects")
    ordered = sorted(
        rows,
        key=lambda row: tuple(str(row.get(field, "")) for field in table.unique_key),
    )
    canonical = json.dumps(
        ordered, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _normalize_remote_field_type(value: Any) -> str:
    return {
        "select": "single_select",
        "multiselect": "multi_select",
        "datetime": "date_time",
        "autonumber": "auto_number",
    }.get(str(value or "").strip().lower(), str(value or "").strip())


def _schema_type_matches(field: Any, remote_type: Any) -> bool:
    live = _normalize_remote_field_type(remote_type)
    expected = _normalize_remote_field_type(field.type)
    if live == expected:
        return True
    # Existing read-only formula/system columns are represented in the registry
    # by their cell value shape (number/date_time), while field-list exposes the
    # native generated column type.
    return (
        field.authority == "readonly"
        and ((field.type == "number" and live == "formula")
             or (field.type == "date_time" and live == "created_at"))
    )


def _read_and_verify_live_schema(
    asset: Any, *, cli: Any, schema_receipt: dict[str, Any]
) -> dict[str, Any]:
    if len(asset.tables) != 1:
        raise ValueError("targeted recovery requires exactly one table contract")
    table = asset.tables[0]
    response = cli.run_json([
        "base", "+field-list", "--as", "user",
        "--base-token", asset.base_token, "--table-id", table.table_id or asset.table_id,
    ])
    data = response.get("data") if isinstance(response, dict) else None
    remote_fields = None
    if isinstance(data, dict):
        remote_fields = data.get("items") or data.get("fields")
    if not isinstance(remote_fields, list) or not remote_fields:
        raise ValueError("targeted recovery remote schema read-back was incomplete")
    by_name: dict[str, dict[str, Any]] = {}
    for raw in remote_fields:
        if not isinstance(raw, dict):
            raise ValueError("targeted recovery remote schema contained a non-object")
        name = str(raw.get("name") or raw.get("field_name") or "").strip()
        field_id = str(raw.get("id") or raw.get("field_id") or "").strip()
        if not name or not field_id or name in by_name:
            raise ValueError("targeted recovery remote schema identity is ambiguous")
        by_name[name] = raw
    declared_names = {field.name_zh for field in table.fields}
    if set(by_name) != declared_names:
        raise ValueError("targeted recovery registry/schema field names drifted")
    for field in table.fields:
        live = by_name[field.name_zh]
        expected_id = asset.field_ids.get(field.name_zh) or field.field_id
        if expected_id and live.get("id", live.get("field_id")) != expected_id:
            raise ValueError(f"targeted recovery field_id drifted: {field.name_zh}")
        if not _schema_type_matches(field, live.get("type")):
            raise ValueError(f"targeted recovery field type drifted: {field.name_zh}")
        if field.type in {"single_select", "multi_select"}:
            live_options = _live_select_option_names(
                cli, asset, table, actor="user", field=field.name_zh,
                field_id=str(live.get("id") or live.get("field_id")),
            )
            expected_options = {str(item.get("name")) for item in field.options}
            if live_options != expected_options:
                raise ValueError(f"targeted recovery schema options drifted: {field.name_zh}")
            expected_multiple = field.type == "multi_select"
            if live.get("multiple") is not None and live.get("multiple") != expected_multiple:
                raise ValueError(f"targeted recovery select multiplicity drifted: {field.name_zh}")
    changes = schema_receipt.get("changes")
    affected_field_ids = {
        str(field_id)
        for change in changes or []
        if isinstance(change, dict)
        for field_id in (change.get("affected_field_ids") or [])
        if isinstance(field_id, str) and field_id
    }
    target_field_ids = [
        asset.field_ids.get(field.name_zh) or field.field_id
        for field in table.fields
        if field.type in {"single_select", "multi_select"}
        and (asset.field_ids.get(field.name_zh) or field.field_id) in affected_field_ids
    ]
    if not isinstance(changes, list) or len(target_field_ids) != 1:
        raise ValueError("targeted recovery schema evidence does not bind the target field")
    target_field_id = target_field_ids[0]
    return {
        "read_back_verified": True,
        "base_token": asset.base_token,
        "table_id": table.table_id or asset.table_id,
        "field_id": target_field_id,
        "field_count": len(remote_fields),
    }


def _read_failure_receipt(
    path: Path, *, line_number: int, expected_sha256: str, job: Any, evidence: dict[str, Any]
) -> dict[str, Any]:
    if not path.is_absolute() or not path.is_file():
        raise ValueError("targeted recovery failure receipt must be an existing absolute file")
    if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
        raise ValueError("targeted recovery failure receipt SHA-256 is required")
    if _sha256_file(path) != expected_sha256:
        raise ValueError("targeted recovery failure receipt changed")
    if line_number <= 0:
        raise ValueError("targeted recovery failure receipt line must be positive")
    lines = path.read_text(encoding="utf-8").splitlines()
    if line_number > len(lines):
        raise ValueError("targeted recovery failure receipt line is absent")
    try:
        receipt = json.loads(lines[line_number - 1])
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError("targeted recovery failure receipt is not valid JSON") from exc
    if not isinstance(receipt, dict):
        raise ValueError("targeted recovery failure receipt is not an object")
    expected = {
        "job_id": int(job["id"]),
        "asset_id": evidence["asset_id"],
        "dedupe_key": evidence["dedupe_key"],
        "op": evidence["op"],
        "status": "failed",
        "read_back_verified": False,
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError("targeted recovery failure receipt does not bind to the job")
    if receipt.get("source") != "sync-queue-drain" or receipt.get("incident_stage") != "terminal_failed":
        raise ValueError("targeted recovery failure receipt is not a terminal queue failure")
    if receipt.get("error") != evidence["failure_error"]:
        raise ValueError("targeted recovery failure error changed")
    if _TARGETED_RECOVERY_ERROR_MARKER not in str(receipt.get("error", "")).lower():
        raise ValueError("targeted recovery only accepts repaired select contract/schema drift")
    if Path(str(job["receipt_ref"])).resolve() != path.resolve():
        raise ValueError("targeted recovery failure receipt is not the job receipt_ref")
    return receipt


def _recovery_receipt_fields(job: Any) -> dict[str, Any]:
    try:
        origins = json.loads(job["recovery_origin_json"] or "[]")
    except (KeyError, TypeError, json.JSONDecodeError):
        return {}
    if not isinstance(origins, list) or not origins:
        return {}
    return {
        "recovery_origin": origins[-1],
        "recovery_attempt": int(job["attempts"]),
        "receipt_job_verified": True,
    }


def recover_failed_job(
    *,
    job_id: int,
    evidence: dict[str, Any],
    db_path: Path | None = None,
    registry_glob: str = DEFAULT_REGISTRY_GLOB,
    lock_path: Path | None = None,
    receipt_dir: Path | None = None,
    lark: Any = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    time_budget_s: float = 300.0,
    sleeper: Callable[[float], Any] = time.sleep,
) -> dict[str, Any]:
    """Recover exactly one failed, non-final job after immutable drift proof.

    The only queue mutation is an exact-id CAS followed by the existing normal
    job processor. No queue-wide reset, triage, claim scan, or sibling drain is
    performed. The lock is held across the recovery claim and all retries so a
    normal tick cannot steal the recovered job or process a sibling here.
    """
    required = (
        "asset_id", "dedupe_key", "op", "from_session", "payload_sha256",
        "payload_rows", "failure_receipt_path", "failure_receipt_sha256",
        "failure_receipt_line", "failure_error", "contract_path",
        "contract_sha256", "schema_receipt_path", "schema_receipt_sha256",
    )
    missing = [key for key in required if key not in evidence]
    if missing:
        raise ValueError("targeted recovery evidence missing: " + ", ".join(missing))
    asset_id = str(evidence["asset_id"])
    if not asset_id or int(job_id) <= 0:
        raise ValueError("targeted recovery requires positive job_id and asset_id")
    contract_path = Path(str(evidence["contract_path"])).resolve()
    schema_path = Path(str(evidence["schema_receipt_path"])).resolve()
    failure_path = Path(str(evidence["failure_receipt_path"])).resolve()
    if not contract_path.is_absolute() or not schema_path.is_absolute() or not failure_path.is_absolute():
        raise ValueError("targeted recovery evidence paths must be absolute")
    if not contract_path.is_file() or not schema_path.is_file():
        raise ValueError("targeted recovery contract/schema evidence file is absent")
    allowed_contracts = {
        Path(path).resolve()
        for path in globmod.glob(registry_glob, recursive=True)
        if "/examples/" not in path
    }
    if contract_path not in allowed_contracts:
        raise ValueError("targeted recovery contract is outside the canonical registry glob")
    lock_file = _lock_file_for(lock_path, asset_id)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    holder = open(lock_file, "w")
    try:
        fcntl.flock(holder, fcntl.LOCK_EX)
        conn = connect(db_path)
        try:
            row = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (int(job_id),)).fetchone()
            if row is None:
                raise ValueError(f"unknown job_id: {job_id}")
            exact = {
                "asset_id": evidence["asset_id"],
                "dedupe_key": evidence["dedupe_key"],
                "op": evidence["op"],
                "from_session": evidence["from_session"],
            }
            if any(str(row[key]) != str(value) for key, value in exact.items()):
                raise ValueError("targeted recovery job identity evidence mismatch")
            if row["status"] != "failed":
                raise ValueError(f"job {job_id} is not recoverable: status={row['status']}")
            if int(row["recovery_count"] or 0) != 0:
                raise ValueError(f"job {job_id} already has a recovery attempt")
            from .sync_status import failed_job_verdict_provenance

            if failed_job_verdict_provenance(dict(row)).get("verdict_final") is True:
                raise ValueError(f"job {job_id} has a final verdict and cannot be recovered")
            payload = json.loads(row["payload_json"])
            rows = _payload_rows(payload)
            if not isinstance(rows, list):
                raise ValueError("targeted recovery payload rows are unreadable")
            if int(evidence["payload_rows"]) != len(rows):
                raise ValueError("targeted recovery payload row count mismatch")
            if str(evidence["payload_sha256"]) != _payload_recovery_sha256(
                load_asset_contract(contract_path), payload
            ):
                raise ValueError("targeted recovery payload SHA-256 mismatch")
            if Path(str(row["receipt_ref"])).resolve() != failure_path.resolve():
                raise ValueError("targeted recovery failure receipt is not current")
            failure_receipt = _read_failure_receipt(
                failure_path,
                line_number=int(evidence["failure_receipt_line"]),
                expected_sha256=str(evidence["failure_receipt_sha256"]),
                job=row,
                evidence=evidence,
            )
            contract_bytes = contract_path.read_bytes()
            if hashlib.sha256(contract_bytes).hexdigest() != str(evidence["contract_sha256"]):
                raise ValueError("targeted recovery registry contract SHA-256 mismatch")
            asset = load_asset_contract(contract_path)
            if asset.asset_id != asset_id or asset.base_token == "" or len(asset.tables) != 1:
                raise ValueError("targeted recovery registry contract identity mismatch")
            schema_bytes = schema_path.read_bytes()
            if hashlib.sha256(schema_bytes).hexdigest() != str(evidence["schema_receipt_sha256"]):
                raise ValueError("targeted recovery schema receipt changed")
            try:
                schema_receipt = json.loads(schema_bytes)
            except (json.JSONDecodeError, UnicodeError) as exc:
                raise ValueError("targeted recovery schema receipt is not valid JSON") from exc
            if not isinstance(schema_receipt, dict):
                raise ValueError("targeted recovery schema receipt is not an object")
            if (
                schema_receipt.get("asset_id") != asset.asset_id
                or schema_receipt.get("contract_sha256_after") != str(evidence["contract_sha256"])
                or schema_receipt.get("contract_path") != str(contract_path)
                or schema_receipt.get("registry_contract_validated") is not True
                or schema_receipt.get("registry_read_back_verified") is not True
                or schema_receipt.get("remote_schema_verified") is not True
                or schema_receipt.get("completion_verified") is not True
            ):
                raise ValueError("targeted recovery schema evidence is incomplete or drifted")
            cli = lark or PacedLarkCli()
            live_schema = _read_and_verify_live_schema(
                asset, cli=cli, schema_receipt=schema_receipt
            )
            origin = {
                "origin": _TARGETED_RECOVERY_ORIGIN,
                "job_id": int(job_id),
                "asset_id": asset.asset_id,
                "dedupe_key": row["dedupe_key"],
                "op": row["op"],
                "from_session": row["from_session"],
                "recovery_attempt": int(row["attempts"]) + 1,
                "payload_sha256": str(evidence["payload_sha256"]),
                "payload_rows": len(rows),
                "failure_receipt_ref": f"{failure_path}:{int(evidence['failure_receipt_line'])}",
                "failure_receipt_sha256": str(evidence["failure_receipt_sha256"]),
                "failure_receipt_id": failure_receipt.get("receipt_id", ""),
                "failure_error": str(row["last_error"]),
                "registry_contract_sha256": str(evidence["contract_sha256"]),
                "schema_receipt_ref": str(schema_path),
                "schema_receipt_sha256": str(evidence["schema_receipt_sha256"]),
                "remote_schema_read_back": live_schema,
            }
            job = claim_failed_job_for_recovery(
                conn, int(job_id), recovery_origin=origin
            )
            receipt_root = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
            receipt_root.mkdir(parents=True, exist_ok=True)
            receipt_path = receipt_root / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
            import threading

            outcome = ""
            deadline = time.monotonic() + max(0.0, time_budget_s)
            escalated_assets: set[str] = set()
            escalated_lock = threading.Lock()
            while True:
                outcome = _process_one_job(
                    job, conn, {asset.asset_id: asset}, cli,
                    receipt_path=receipt_path, max_attempts=max_attempts,
                    escalate_fn=lambda *args, **kwargs: None,
                    escalated_assets=escalated_assets,
                    escalated_lock=escalated_lock,
                    queue_lock_held=True,
                )
                if outcome != "requeued":
                    break
                if time.monotonic() >= deadline:
                    break
                job = claim_pending_job_by_id(conn, int(job_id))
                if job is None:
                    break
                sleeper(0)
            final_row = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (int(job_id),)).fetchone()
            if final_row is None:
                raise ValueError(f"job {job_id} disappeared during recovery")
            final_status = dict(final_row)
            latest_receipt = None
            if receipt_path.exists():
                for line in receipt_path.read_text(encoding="utf-8").splitlines():
                    try:
                        candidate = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if (
                        isinstance(candidate, dict)
                        and candidate.get("source") == "sync-queue-drain"
                        and candidate.get("job_id") == int(job_id)
                        and candidate.get("dedupe_key") == final_row["dedupe_key"]
                    ):
                        latest_receipt = candidate
            final_status["terminal"] = final_status["status"] in {
                "done", "failed", "superseded", "cancelled"
            }
            return {
                "ok": final_status["terminal"],
                "job_id": int(job_id),
                "outcome": outcome,
                "status": final_status["status"],
                "attempts": int(final_status["attempts"]),
                "terminal": final_status["terminal"],
                "recovery_origin": origin,
                "read_back_verified": bool(
                    latest_receipt and latest_receipt.get("read_back_verified") is True
                ),
                "receipt_job_verified": bool(
                    latest_receipt and latest_receipt.get("job_id") == int(job_id)
                    and latest_receipt.get("dedupe_key") == final_row["dedupe_key"]
                ),
                "remote_deleted": int((latest_receipt or {}).get("deleted") or 0),
                "receipt_ref": final_row["receipt_ref"],
                "last_error": final_row["last_error"],
            }
        finally:
            conn.close()
    finally:
        fcntl.flock(holder, fcntl.LOCK_UN)
        holder.close()


def _mirror_write_response_trusted(asset: Any, op: str, result: dict[str, Any]) -> bool:
    """Allow the narrow derived-mirror visibility-race settlement.

    The legacy escape hatch applies only when the write layer has no errors *and*
    no row-level read-back diagnostic.  A field/key mismatch is evidence that the
    remote value is observable but wrong, not an eventual-consistency race, and
    must remain fail-closed even for a local-to-remote derived mirror.
    """
    return (
        getattr(asset, "authority_model", "") == "derived_mirror"
        and getattr(asset, "sync_direction", "") == "local_to_remote"
        and op == "bitable_rows_upsert"
        and not result.get("failed")
        and not result.get("row_failures")
        and not result.get("row_failures_total")
        and not result.get("row_failures_omitted")
        and not result.get("batch_errors")
        and not result.get("batch_errors_total")
    )


def _has_remote_readonly_rejection(result: dict[str, Any]) -> bool:
    for field in ("row_failures", "batch_errors"):
        for item in result.get(field) or []:
            message = item.get("error", "") if isinstance(item, dict) else str(item)
            if "READONLY:" in str(message) and "update response not verified" in str(message):
                return True
    return False


def _attachment_retry_receipt_fields(
    job: Any, *, status: str, last_error: object = "",
    retry_authorization: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if job["op"] != ATTACHMENT_REPLACE_OP:
        return {}
    return {
        "attachment_retry": attachment_retry_advice(
            op=job["op"], dedupe_key=job["dedupe_key"],
            status=status, last_error=last_error,
            retry_authorization=retry_authorization,
        )
    }


def _mark_done_after_readback(
    conn: Any, job: Any, *, receipt_path: Path,
) -> str:
    """Close the ledger without turning a post-write lock into a retry."""
    try:
        if mark_done(conn, job["id"], receipt_ref=str(receipt_path)):
            return "done"
        current = conn.execute(
            "SELECT status FROM sync_jobs WHERE id=?", (job["id"],)
        ).fetchone()
        reason = "state_changed" if current is None else f"state={current['status']}"
    except (QueueWriteUnavailable, OSError) as exc:
        reason = f"ledger_write_unavailable:{exc}"
    except Exception as exc:  # noqa: BLE001 - preserve remote read-back proof
        if "database is locked" not in str(exc).lower():
            raise
        reason = f"ledger_write_unavailable:{exc}"

    write_receipt(receipt_path, {
        "asset_id": job["asset_id"],
        "job_id": job["id"],
        "dedupe_key": job["dedupe_key"],
        "op": job["op"],
        "status": "done",
        "read_back_verified": True,
        "source": "sync-queue-drain",
        "ledger_status": "pending",
        "ledger_pending_reason": reason,
    })
    return "ledger_pending"




def _process_one_job(job: Any, conn: Any, contracts: dict, cli: Any, *,
                     receipt_path: Path, max_attempts: int,
                     escalate_fn: Callable, escalated_assets: set,
                     escalated_lock: Any,
                     queue_lock_held: bool = False) -> str:
    """处理单条 job，返回 outcome ∈ {'done','failed','requeued','ledger_pending'}.
    单 worker 调用此函数；多 worker 时各自 thread 调，DB 操作走各自 conn 避免 SQLite 并发问题."""
    # 观测：not-verified 时 _dispatch_op 已算出 row_failures/batch_errors，但下面 raise 会丢掉 result；
    # 提到 diag 里让 except 把「是哪几行、什么错」写进失败 receipt（huodaiduijie 请求）。
    diag: dict[str, Any] = {}
    try:
        asset = contracts.get(job["asset_id"])
        if asset is None:
            raise ValueError(f"unknown asset_id: {job['asset_id']}")
        if asset.authority_model == "derived_projection":
            raise ValueError(
                f"asset {job['asset_id']} is a derived_projection and forbids all data-time writes"
            )
        if asset.sync_direction == "none" and job["op"] not in {
            "bitable_record_delete_if_current",
            "bitable_record_update_if_current",
            "bitable_rows_update_existing",
            "bitable_attachment_upload",
            ATTACHMENT_REPLACE_OP,
            SNAPSHOT_OP,
        }:
            raise ValueError(
                f"asset {job['asset_id']} has sync_direction=none and cannot be drained"
            )
        payload = json.loads(job["payload_json"])
        if job["op"] == "bitable_rows_update_existing":
            check_controlled_rows_update_existing(
                asset, caller_session=job["from_session"], rows=payload,
            )
        elif job["op"] == "bitable_attachment_upload" and isinstance(payload, dict):
            check_controlled_attachment_upload(
                asset, field=payload.get("field"),
                unique_key_values=payload.get("unique_key"),
                caller_session=job["from_session"],
            )
        elif job["op"] == ATTACHMENT_REPLACE_OP:
            validate_attachment_replace_queue_entry(
                job["asset_id"], payload, job["dedupe_key"]
            )
            check_controlled_attachment_replace(
                asset, field_id=payload.get("field_id"),
                caller_session=job["from_session"],
            )
        grant = resolve_migration_write_grant(
            asset, op=job["op"], caller_session=job["from_session"],
            client_key=job["dedupe_key"])
        migration_exception = resolve_migration_write_exception(
            asset, op=job["op"], caller_session=job["from_session"],
            client_key=job["dedupe_key"])
        if grant and job["op"] == "bitable_rows_upsert":
            # upsert 变体的单行精确形状闸：恰 1 行、行字段恰为 唯一键∪授予列，机械保证
            # 「一把 key 不写多行、不写非授权字段、不改非指定既有 record」。违反 raise→terminal。
            enforce_migration_write_upsert_shape(
                asset, payload, grant, exception=migration_exception,
                label="migration_write_exceptions" if migration_exception
                else "migration_write_exception",
            )
        if grant:
            # 迁移例外的消耗闸（权威、不可绕过点）：另一把 key 若已成功用掉例外，本次换 key
            # 一律拒绝，绝不给日常写入留权限。同 key 重放不受此闸（exclude_key），由队列 dedupe
            # 天然幂等。per-asset drain 锁串行化保证 A done 后 B 才可能进这里。
            exception_contract = migration_exception or asset.migration_write_exception or {}
            prefix = exception_contract.get("client_key_prefix", "")
            consumer = migration_exception_consumer(
                conn, asset_id=job["asset_id"], op=job["op"],
                from_session=job["from_session"], client_key_prefix=prefix,
                grant_fields=grant, exclude_key=job["dedupe_key"])
            if consumer is not None:
                raise ValueError(
                    f"migration_write_exception for asset {job['asset_id']} already "
                    f"consumed by job key {consumer}; refusing to grant a second key "
                    f"(this key={job['dedupe_key']}). Replay the original key idempotently, "
                    f"or route a fresh schema-time exception to jianbiao."
                )
        # 第二类恢复例外（migration_restore_exception）：campaign 多 key、无单 key 消耗，安全靠
        # 形状精确闸。upsert 命中则校验行形状并把被授 feishu 列并入 grant；attachment_upload
        # 命中则校验 field/unique_key 恰为声明形状（不匹配 raise→terminal failed）。未命中恒空、
        # 不影响日常写入与其他资产。
        restore_grant: set[str] = set()
        if job["op"] == "bitable_rows_upsert":
            restore_grant = migration_restore_upsert_grant(
                asset, payload, caller_session=job["from_session"],
                client_key=job["dedupe_key"])
        elif job["op"] == "bitable_attachment_upload" and isinstance(payload, dict):
            check_migration_restore_attachment(
                asset, field=payload.get("field"),
                unique_key_values=payload.get("unique_key"),
                caller_session=job["from_session"], client_key=job["dedupe_key"])
        if job["op"] == SNAPSHOT_OP:
            validate_snapshot_payload(
                asset, payload, caller_session=job["from_session"],
            )
            result = run_logical_snapshot(
                job_id=int(job["id"]), asset=asset, payload=payload,
                caller_session=job["from_session"], conn=conn, cli=cli,
                actor="user",
                queue_lock_held=queue_lock_held,
            )
            if result.get("continuation"):
                available_after = (
                    datetime.now(timezone.utc)
                    + timedelta(seconds=SNAPSHOT_CONTINUATION_DELAY_S)
                ).isoformat(timespec="seconds")
                if not mark_snapshot_continuation(
                    conn, int(job["id"]), available_after=available_after,
                ):
                    raise RuntimeError("logical snapshot continuation CAS lost")
                write_receipt(receipt_path, {
                    **result, "status": "continued", "job_id": job["id"],
                    "dedupe_key": job["dedupe_key"], "op": SNAPSHOT_OP,
                    "asset_id": job["asset_id"], "source": "sync-queue-drain",
                })
                return "continued"
        else:
            result = _dispatch_op(job["op"], asset, payload,
                                  caller_session=job["from_session"], cli=cli,
                                  migration_grant_fields=grant | restore_grant,
                                  client_key=job["dedupe_key"])
        if not result["read_back_verified"] or result["failed"]:
            diag = {
                "failed": result.get("failed"),
                "row_failures": result.get("row_failures"),
                "row_failures_total": result.get("row_failures_total"),
                "row_failures_omitted": result.get("row_failures_omitted"),
                "batch_errors": result.get("batch_errors"),
                "batch_errors_total": result.get("batch_errors_total"),
                "batch_errors_omitted": result.get("batch_errors_omitted"),
                "create_submission_uncertain": result.get("create_submission_uncertain"),
            }
            if _has_remote_readonly_rejection(result):
                raise ValueError(
                    "fields not allowed by contract: remote READONLY update rejection"
                )
            if result.get("create_submission_uncertain"):
                raise AmbiguousCreateReadBackError(
                    "ambiguous create read_back_not_verified; do not retry: "
                    f"failed={result['failed']}"
                )
            if _mirror_write_response_trusted(asset, job["op"], result):
                write_receipt(receipt_path, {
                    **result, "status": "done", "job_id": job["id"],
                    "dedupe_key": job["dedupe_key"],
                    "source": "sync-queue-drain",
                    "read_back_mode": "mirror_write_response_trusted",
                    **_recovery_receipt_fields(job),
                    **_attachment_retry_receipt_fields(job, status="done"),
                })
                return _mark_done_after_readback(conn, job, receipt_path=receipt_path)
            if asset.authority_model != "derived_mirror":
                raise AuthoritativeReadBackNotVerified(
                    "authoritative read_back_not_verified; do not retry: "
                    f"failed={result['failed']}"
                )
            raise RuntimeError(
                f"live sync not verified: failed={result['failed']}"
                f" read_back_verified={result['read_back_verified']}")
        write_receipt(receipt_path, {
            **result, "status": "done", "job_id": job["id"],
            "dedupe_key": job["dedupe_key"],
            "source": "sync-queue-drain",
            **_recovery_receipt_fields(job),
            **_attachment_retry_receipt_fields(job, status="done"),
        })
        return _mark_done_after_readback(conn, job, receipt_path=receipt_path)
    except SnapshotBudgetExceeded as exc:
        if job["op"] == SNAPSHOT_OP:
            available_after = (
                datetime.now(timezone.utc)
                + timedelta(seconds=SNAPSHOT_CONTINUATION_DELAY_S)
            ).isoformat(timespec="seconds")
            if mark_snapshot_continuation(
                conn, int(job["id"]), available_after=available_after,
            ):
                write_receipt(receipt_path, {
                    "asset_id": job["asset_id"], "job_id": job["id"],
                    "dedupe_key": job["dedupe_key"], "op": SNAPSHOT_OP,
                    "status": "continued", "phase": "budget_exhausted",
                    "error": str(exc), "source": "sync-queue-drain",
                })
                return "continued"
        raise
    except Exception as exc:
        if isinstance(exc, LogicalSnapshotPreflightError):
            diag = {"snapshot_option_diffs": exc.option_diffs}
        if isinstance(exc, RemoteReadonlyUpdateResponse):
            diag = {
                "failed": 1,
                "batch_errors": [{
                    "batch_start": 0,
                    "batch_rows": 1,
                    "error": str(exc)[:800],
                }],
                "batch_errors_total": 1,
                "batch_errors_omitted": 0,
            }
        outcome = mark_retry_or_failed(conn, job["id"], str(exc),
                                       max_attempts=max_attempts,
                                       permanent=is_permanent_error(exc),
                                       attachment_retry_context=(
                                           exc.retry_context
                                           if isinstance(exc, AttachmentRetryableMediaFailure)
                                           else None
                                       ))
        retry_authorization = (
            attachment_retry_authorization_for_job(conn, job["id"])
            if outcome == "failed" else None
        )
        incident = _incident_metadata(exc, job["op"])
        incident_stage = "terminal_failed" if outcome == "failed" else "execution_retrying"
        # 终态 failed 一律落 receipt；requeued 若带数据类诊断(row_failures/batch_errors)也立刻落，
        # 让 owner 首次重试就看到失败行，不用等 5 次重试耗尽（纯瞬时错误无 diag 则不落、不刷噪音）。
        has_diag = bool(diag.get("row_failures") or diag.get("batch_errors"))
        if outcome == "failed" or has_diag:
            write_receipt(receipt_path, {
                "asset_id": job["asset_id"], "job_id": job["id"],
                "dedupe_key": job["dedupe_key"], "op": job["op"],
                "status": outcome, "error": str(exc),
                "read_back_verified": False, "source": "sync-queue-drain",
                "incident_stage": incident_stage, **incident,
                **_recovery_receipt_fields(job),
                **_attachment_retry_receipt_fields(
                    job, status=outcome, last_error=str(exc),
                    retry_authorization=retry_authorization,
                ),
                **{k: v for k, v in diag.items() if v is not None},
            })
            set_receipt_ref(conn, job["id"], str(receipt_path))
        if outcome == "failed":
            with escalated_lock:
                fingerprint = incident["incident_fingerprint"]
                if fingerprint not in escalated_assets:
                    escalated_assets.add(fingerprint)
                    needs_escalate = True
                else:
                    needs_escalate = False
            if needs_escalate:
                escalate_fn(
                    "同步队列终态失败",
                    f"stage=terminal_failed root_cause_code={incident['root_cause_code']}"
                    f" incident_fingerprint={incident['incident_fingerprint']}"
                    f" job_id={job['id']} asset={job['asset_id']} key={job['dedupe_key']}"
                    f" error={exc}（同根因同 op 本轮后续失败已合并，详见 receipt）",
                    todo_key=("sync-queue-failed-"
                              + incident["incident_fingerprint"].replace(":", "-")),
                )
            return "failed"
        return "requeued"


_AMBIGUOUS_CREATE_RECOVERY_MARKER = (
    "ambiguous create read_back_not_verified; do not retry"
)


def _ambiguous_create_recovery_refusal(
    job_id: int,
    reason: str,
    *,
    asset_id: str = "",
    terminal: bool = True,
) -> dict[str, Any]:
    """Return a machine-readable no-write recovery disposition."""
    return {
        "ok": False,
        "origin_job_id": job_id,
        "asset_id": asset_id,
        "terminal": terminal,
        "retryable": False,
        "reason": reason,
        "repair_job_id": 0,
        "failed": 1,
        "read_back_verified": False,
    }


def _stable_ambiguous_create_target(
    asset: Any,
    payload: Any,
    *,
    caller_session: str,
    cli: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Prove a failed single-row create has one stable existing remote target."""
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ValueError("ambiguous-create recovery requires exactly one original row")
    plan = bitable_upsert_plan(
        asset,
        payload,
        caller_session=caller_session,
        existing_records=[],
        existing_records_complete=False,
        queue_op="bitable_rows_upsert",
    )
    if len(plan.get("rows") or []) != 1:
        raise ValueError("ambiguous-create recovery expected exactly one planned row")
    item = plan["rows"][0]
    table = asset.tables[0]

    def snapshot() -> tuple[str, str]:
        matches = _search_records_by_key(
            cli, asset, table, item["unique_key"], actor="user",
        )
        if len(matches) != 1:
            raise ValueError(
                "ambiguous-create recovery requires exactly one remote target: "
                f"got {len(matches)} for {item['unique_key']}"
            )
        record = matches[0]
        record_id = str(record.get("record_id") or "")
        if not record_id:
            raise ValueError("ambiguous-create recovery target has no record_id")
        canonical = json.dumps(
            record.get("fields", {}), ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), default=str,
        )
        return record_id, hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    first_record_id, first_digest = snapshot()
    second_record_id, second_digest = snapshot()
    if (first_record_id, first_digest) != (second_record_id, second_digest):
        raise ValueError("ambiguous-create recovery remote target changed between read-backs")
    return item, {
        "record_id": first_record_id,
        "snapshot_sha256": first_digest,
        "read_back_attempts": 2,
    }


def _stable_ambiguous_create_batch_read_only_targets(
    asset: Any,
    payload: Any,
    *,
    caller_session: str,
    cli: Any,
) -> list[dict[str, Any]]:
    """Prove every original upsert row already exists, matches, and is stable.

    This is deliberately narrower than update-only repair: it permits no remote
    mutation.  It is useful for ambiguous multi-row creates, where replaying or
    deriving one update job per row could leave a partially repaired batch.
    """
    if (
        not isinstance(payload, list)
        or len(payload) < 2
        or any(not isinstance(row, dict) for row in payload)
    ):
        raise ValueError(
            "batch_requires_at_least_two_original_rows"
        )
    plan = bitable_upsert_plan(
        asset,
        payload,
        caller_session=caller_session,
        existing_records=[],
        existing_records_complete=False,
        queue_op="bitable_rows_upsert",
    )
    items = plan.get("rows") or []
    if len(items) != len(payload):
        raise ValueError("ambiguous-create read-only reconcile did not plan every row")
    table = asset.tables[0]
    field_types = _field_types(asset, table)

    def snapshot(item: dict[str, Any]) -> dict[str, Any]:
        matches = _search_records_by_key(
            cli, asset, table, item["unique_key"], actor="user",
        )
        if len(matches) != 1:
            raise ValueError(
                "ambiguous-create read-only reconcile requires exactly one remote target: "
                f"got {len(matches)} for {item['unique_key']}"
            )
        record = matches[0]
        record_id = str(record.get("record_id") or "")
        if not record_id:
            raise ValueError("ambiguous-create read-only reconcile target has no record_id")
        if not _write_fields_match(record, item, field_types):
            raise ValueError(
                "ambiguous-create read-only reconcile field mismatch for "
                f"{item['unique_key']}"
            )
        canonical = json.dumps(
            record.get("fields", {}), ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), default=str,
        )
        return {
            "record_id": record_id,
            "snapshot_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "write_fields_match": True,
        }

    first = [snapshot(item) for item in items]
    second = [snapshot(item) for item in items]
    if any(
        first_read["record_id"] != second_read["record_id"]
        or first_read["snapshot_sha256"] != second_read["snapshot_sha256"]
        for first_read, second_read in zip(first, second)
    ):
        raise ValueError(
            "ambiguous-create read-only reconcile remote target changed between read-backs"
        )
    return [
        {
            "record_id": first_read["record_id"],
            "unique_key": item["unique_key"],
            "writable_fields": sorted(item["write_fields"]),
            "first_read": first_read,
            "second_read": second_read,
        }
        for item, first_read, second_read in zip(items, first, second)
    ]


def _stable_ambiguous_create_if_absent_target(
    asset: Any,
    payload: Any,
    *,
    caller_session: str,
    cli: Any,
) -> dict[str, Any]:
    """Prove a controlled creation-only row now has one stable remote target.

    The recovery is read-only: a missing or duplicate key is a refusal, never a
    reason to replay the original create.  The keyed lock is shared with the
    normal check-create-readback path, so a local drain cannot race the proof.
    """
    table, _rule = validate_rows_create_if_absent_payload(
        asset, payload, caller_session=caller_session,
    )
    row = payload[0]

    def snapshot() -> tuple[str, str]:
        matches = _search_records_by_key(cli, asset, table, row, actor="user")
        if len(matches) != 1:
            raise ValueError(
                "ambiguous-create-if-absent recovery requires exactly one remote target: "
                f"got {len(matches)}"
            )
        record = matches[0]
        record_id = str(record.get("record_id") or "")
        if not record_id:
            raise ValueError("ambiguous-create-if-absent recovery target has no record_id")
        canonical = json.dumps(
            record.get("fields", {}), ensure_ascii=False, sort_keys=True,
            separators=(",", ":"), default=str,
        )
        return record_id, hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    with _create_if_absent_key_lock(asset, table, row):
        first_record_id, first_digest = snapshot()
        second_record_id, second_digest = snapshot()
    if (first_record_id, first_digest) != (second_record_id, second_digest):
        raise ValueError(
            "ambiguous-create-if-absent recovery target changed between read-backs"
        )
    return {
        "record_id": first_record_id,
        "snapshot_sha256": first_digest,
        "read_back_attempts": 2,
    }


def recover_ambiguous_create(
    *,
    job_id: int,
    db_path: Path | None = None,
    lock_path: Path | None = None,
    registry_glob: str = DEFAULT_REGISTRY_GLOB,
    receipt_dir: Path | None = None,
    lark: Any = None,
) -> dict[str, Any]:
    """Finish one ambiguous create without replaying its original create.

    A local-authoritative upsert is repaired through a derived update-only job.
    A controlled ``create_if_absent`` is instead reconciled in place: two
    complete read-backs must prove one stable existing row, then the original
    failed job receives its own verification receipt.  Neither path replays a
    create.
    """
    conn = connect(db_path)
    holder = None
    try:
        origin = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (job_id,)).fetchone()
        if origin is None:
            return _ambiguous_create_recovery_refusal(job_id, "origin_job_not_found")
        asset_id = str(origin["asset_id"])
        if origin["status"] != "failed":
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_job_not_failed:{origin['status']}", asset_id=asset_id,
            )
        origin_op = str(origin["op"])
        if origin_op not in {
            "bitable_rows_upsert",
            "bitable_rows_create_if_absent",
        }:
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_op_not_recoverable:{origin_op}", asset_id=asset_id,
            )
        if _AMBIGUOUS_CREATE_RECOVERY_MARKER not in str(origin["last_error"]):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_not_ambiguous_create_terminal", asset_id=asset_id,
            )

        asset_lock = _lock_file_for(lock_path, asset_id)
        asset_lock.parent.mkdir(parents=True, exist_ok=True)
        holder = open(asset_lock, "w")
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return _ambiguous_create_recovery_refusal(
                job_id, "asset_recovery_lock_busy", asset_id=asset_id, terminal=False,
            )

        # Re-read under the same per-asset lock used by scoped queue drains.
        origin = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (job_id,)).fetchone()
        if origin is None or origin["status"] != "failed":
            state = "missing" if origin is None else str(origin["status"])
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_state_changed:{state}", asset_id=asset_id,
            )
        contracts = _load_contract_index(registry_glob)
        asset = contracts.get(asset_id)
        if asset is None:
            return _ambiguous_create_recovery_refusal(
                job_id, "canonical_contract_not_found", asset_id=asset_id,
            )
        if origin_op == "bitable_rows_upsert":
            if (
                asset.owner_session != origin["from_session"]
                or asset.authority_model != "local_authoritative"
                or asset.sync_direction != "local_to_remote"
            ):
                return _ambiguous_create_recovery_refusal(
                    job_id, "origin_or_contract_not_safe_for_update_only_repair",
                    asset_id=asset_id,
                )
        elif asset.sync_direction != "local_to_remote":
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_or_contract_not_safe_for_create_if_absent_reconcile",
                asset_id=asset_id,
            )
        try:
            payload = json.loads(origin["payload_json"])
        except (TypeError, ValueError):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_payload_not_json", asset_id=asset_id,
            )

        cli = lark if lark is not None else PacedLarkCli()
        if origin_op == "bitable_rows_create_if_absent":
            try:
                target = _stable_ambiguous_create_if_absent_target(
                    asset,
                    payload,
                    caller_session=str(origin["from_session"]),
                    cli=cli,
                )
            except (ValueError, LarkCliError) as exc:
                return _ambiguous_create_recovery_refusal(
                    job_id, f"safe_target_not_proven:{exc}", asset_id=asset_id,
                )

            receipts = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
            receipt_path = receipts / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
            origin_key = str(origin["dedupe_key"])
            receipt = write_receipt(receipt_path, {
                "source": "sync-queue-drain",
                "status": "done",
                "repair_kind": "ambiguous_create_if_absent_reconcile",
                "job_id": job_id,
                "dedupe_key": origin_key,
                "asset_id": asset_id,
                "caller_session": str(origin["from_session"]),
                "origin_root_cause_code": "ambiguous_create_read_back_not_verified",
                "record_id": target["record_id"],
                "stable_target_snapshot_sha256": target["snapshot_sha256"],
                "stable_target_read_back_attempts": target["read_back_attempts"],
                "created": 0,
                "updated": 0,
                "skipped": 1,
                "failed": 0,
                "read_back_verified": True,
            })
            if not mark_failed_reconciled_done(
                conn,
                job_id,
                str(receipt_path),
                expected_error_marker=_AMBIGUOUS_CREATE_RECOVERY_MARKER,
            ):
                current = conn.execute(
                    "SELECT status FROM sync_jobs WHERE id=?", (job_id,)
                ).fetchone()
                state = str(current["status"]) if current else "missing"
                return _ambiguous_create_recovery_refusal(
                    job_id, f"origin_state_changed:{state}", asset_id=asset_id,
                )
            return {
                "ok": True,
                "job_id": job_id,
                "origin_job_id": job_id,
                "asset_id": asset_id,
                "dedupe_key": origin_key,
                "status": "done",
                "repair_kind": "ambiguous_create_if_absent_reconcile",
                "record_id": target["record_id"],
                "failed": 0,
                "read_back_verified": True,
                "receipt_id": receipt["receipt_id"],
                "receipt_ref": str(receipt_path),
            }

        try:
            _item, target = _stable_ambiguous_create_target(
                asset,
                payload,
                caller_session=str(origin["from_session"]),
                cli=cli,
            )
        except (ValueError, LarkCliError) as exc:
            return _ambiguous_create_recovery_refusal(
                job_id, f"safe_target_not_proven:{exc}", asset_id=asset_id,
            )

        origin_key = str(origin["dedupe_key"])
        repair_key = f"{origin_key}:repair-update-existing:{target['record_id']}"
        provenance_basis = str(origin["caller_provenance"] or "")
        repair_provenance = {
            "state": "owner_queue_repair",
            "repair_owner_session": "wendangwang",
            "origin_job_id": job_id,
            "origin_dedupe_key": origin_key,
            "origin_caller_provenance_sha256": hashlib.sha256(
                provenance_basis.encode("utf-8")
            ).hexdigest(),
        }
        queued = enqueue(
            conn,
            dedupe_key=repair_key,
            asset_id=asset_id,
            from_session=str(origin["from_session"]),
            op="bitable_rows_update_existing",
            payload=payload,
            caller_provenance=json.dumps(
                repair_provenance, ensure_ascii=False, sort_keys=True,
            ),
        )
        repair_job_id = int(queued["job_id"])
        if queued.get("duplicate"):
            existing = conn.execute(
                "SELECT * FROM sync_jobs WHERE id=?", (repair_job_id,)
            ).fetchone()
            if existing is None:
                return _ambiguous_create_recovery_refusal(
                    job_id, "repair_job_disappeared", asset_id=asset_id,
                )
            if existing["status"] == "done":
                from .sync_status import job_receipt_provenance

                proof = job_receipt_provenance(dict(existing))
                return {
                    "ok": bool(proof["receipt_job_verified"]),
                    "origin_job_id": job_id,
                    "asset_id": asset_id,
                    "repair_job_id": repair_job_id,
                    "repair_dedupe_key": repair_key,
                    "repair_status": "done",
                    "already_repaired": True,
                    "record_id": target["record_id"],
                    "failed": 0 if proof["read_back_verified"] else 1,
                    "read_back_verified": bool(proof["read_back_verified"]),
                    "receipt_ref": str(existing["receipt_ref"]),
                }
            return _ambiguous_create_recovery_refusal(
                job_id,
                f"repair_job_already_terminal:{existing['status']}",
                asset_id=asset_id,
            )

        repair_job = claim_pending_job_by_id(conn, repair_job_id)
        if repair_job is None:
            return _ambiguous_create_recovery_refusal(
                job_id, "repair_job_not_claimable", asset_id=asset_id,
            )
        receipts = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
        receipt_path = receipts / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
        import threading

        outcome = _process_one_job(
            repair_job,
            conn,
            contracts,
            cli,
            receipt_path=receipt_path,
            max_attempts=1,
            # The caller requested a direct result, not a background notification.
            escalate_fn=lambda *_args, **_kwargs: None,
            escalated_assets=set(),
            escalated_lock=threading.Lock(),
        )
        if outcome != "done":
            current = conn.execute(
                "SELECT status, receipt_ref FROM sync_jobs WHERE id=?", (repair_job_id,)
            ).fetchone()
            return {
                **_ambiguous_create_recovery_refusal(
                    job_id, f"update_only_repair_{outcome}", asset_id=asset_id,
                ),
                "repair_job_id": repair_job_id,
                "repair_dedupe_key": repair_key,
                "repair_status": str(current["status"]) if current else "missing",
                "receipt_ref": str(current["receipt_ref"]) if current else "",
                "record_id": target["record_id"],
            }

        repair_receipt = write_receipt(receipt_path, {
            "source": "sync-queue-drain",
            "status": "done",
            "repair_kind": "ambiguous_create_update_existing",
            "job_id": repair_job_id,
            "dedupe_key": repair_key,
            "asset_id": asset_id,
            "caller_session": str(origin["from_session"]),
            "origin_job_id": job_id,
            "origin_dedupe_key": origin_key,
            "origin_root_cause_code": "ambiguous_create_read_back_not_verified",
            "record_id": target["record_id"],
            "stable_target_snapshot_sha256": target["snapshot_sha256"],
            "stable_target_read_back_attempts": target["read_back_attempts"],
            "created": 0,
            "failed": 0,
            "read_back_verified": True,
        })
        return {
            "ok": True,
            "origin_job_id": job_id,
            "asset_id": asset_id,
            "repair_job_id": repair_job_id,
            "repair_dedupe_key": repair_key,
            "repair_status": "done",
            "record_id": target["record_id"],
            "failed": 0,
            "read_back_verified": True,
            "receipt_id": repair_receipt["receipt_id"],
            "receipt_ref": str(receipt_path),
        }
    finally:
        if holder is not None:
            holder.close()
        conn.close()


_SNAPSHOT_CREATE_UNKNOWN_MARKER = (
    "logical snapshot create result unknown; do not replay or recover"
)


def _snapshot_reconcile_receipt(
    conn: Any,
    origin: Any,
    *,
    asset: Any | None = None,
    receipt_dir: Path | None,
    status: str,
    reason: str = "",
    evidence: dict[str, Any] | None = None,
    job_status_after: str = "failed",
    resumed: bool = False,
) -> dict[str, Any]:
    """Publish one bounded no-write snapshot reconcile result."""
    receipts = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
    receipt_path = receipts / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
    state = get_logical_snapshot_state(conn, int(origin["id"])) or {}
    plan = state.get("plan") if isinstance(state.get("plan"), dict) else {}
    try:
        payload = json.loads(origin["payload_json"])
    except (TypeError, ValueError):
        payload = {}
    base_token = str(
        getattr(asset, "base_token", "")
        or plan.get("base_token", "")
    )
    receipt = write_receipt(receipt_path, {
        "source": "sync-queue-owner-reconcile",
        "status": status,
        "repair_kind": "logical_snapshot_create_read_only_reconcile",
        "job_id": int(origin["id"]),
        "dedupe_key": str(origin["dedupe_key"]),
        "asset_id": str(origin["asset_id"]),
        "caller_session": str(origin["from_session"]),
        "origin_last_error": str(origin["last_error"] or ""),
        "origin_receipt_ref": str(origin["receipt_ref"] or ""),
        "origin_job": {
            "id": int(origin["id"]),
            "status": str(origin["status"]),
            "attempts": int(origin["attempts"] or 0),
            "slice_claims": int(origin["slice_claims"] or 0),
            "enqueued_at": str(origin["enqueued_at"] or ""),
            "processed_at": str(origin["processed_at"] or ""),
        },
        "job_status_after": job_status_after,
        "resumed_same_job": resumed,
        "remote_write_count": 0,
        "read_back_verified": bool(resumed),
        "reason": reason,
        "source_task_table_binding": {
            "dedupe_key": str(origin["dedupe_key"]),
            "payload_sha256": state.get("payload_sha256", _json_sha256(payload)),
            "contract_sha256": state.get("contract_sha256", ""),
            "asset_id": str(origin["asset_id"]),
            "base_token": base_token,
            "table_id": plan.get("table_id", ""),
            "source_row_count": len(payload.get("rows", [])) if isinstance(payload, dict) else 0,
            "input_complete": bool(
                isinstance(payload, dict)
                and isinstance(payload.get("snapshot"), dict)
                and payload["snapshot"].get("input_complete") is True
            ),
        },
        "logical_snapshot": {
            "phase": state.get("phase", ""),
            "prefetch_offset": state.get("prefetch_offset", 0),
            "prefetch_pages": state.get("prefetch_pages", 0),
            "slice_start": state.get("slice_start", 0),
            "slice_end": state.get("slice_end", 0),
            "work_row_cursor": state.get("work_row_cursor", 0),
            "work_row_total": state.get("work_row_total", 0),
            "read_checkpoint": (
                state.get("read_checkpoints", {}).get("reconcile_slice", {})
                if isinstance(state.get("read_checkpoints"), dict) else {}
            ),
            "plan": {
                key: plan.get(key)
                for key in ("add", "update", "delete", "unchanged", "table_id", "unique_key")
                if key in plan
            },
        },
        "evidence": evidence or {},
    })
    set_receipt_ref(conn, int(origin["id"]), str(receipt_path))
    return {
        "ok": status == "resumed",
        "job_id": int(origin["id"]),
        "origin_job_id": int(origin["id"]),
        "asset_id": str(origin["asset_id"]),
        "dedupe_key": str(origin["dedupe_key"]),
        "status": job_status_after,
        "repair_kind": "logical_snapshot_create_read_only_reconcile",
        "remote_write_count": 0,
        "read_back_verified": bool(resumed),
        "resumed_same_job": resumed,
        "reason": reason,
        "receipt_id": receipt["receipt_id"],
        "receipt_ref": str(receipt_path),
        "evidence": evidence or {},
    }


def _reconcile_failed_logical_snapshot_read_only(
    conn: Any,
    *,
    origin: Any,
    lock_path: Path | None,
    registry_glob: str,
    receipt_dir: Path | None,
    lark: Any,
) -> dict[str, Any]:
    """Reconcile one uncertain snapshot slice, then resume the same job only if proven."""
    asset_id = str(origin["asset_id"])
    if _SNAPSHOT_CREATE_UNKNOWN_MARKER not in str(origin["last_error"]):
        return _snapshot_reconcile_receipt(
            conn, origin, receipt_dir=receipt_dir, status="reconcile_blocked",
            reason="origin_not_ambiguous_snapshot_create_terminal",
        )
    try:
        payload = json.loads(origin["payload_json"])
    except (TypeError, ValueError):
        return _snapshot_reconcile_receipt(
            conn, origin, receipt_dir=receipt_dir, status="reconcile_blocked",
            reason="origin_payload_not_json",
        )

    asset_lock = _lock_file_for(lock_path, asset_id)
    asset_lock.parent.mkdir(parents=True, exist_ok=True)
    holder = open(asset_lock, "w")
    try:
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return _snapshot_reconcile_receipt(
                conn, origin, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="asset_recovery_lock_busy",
            )
        current = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (int(origin["id"]),)).fetchone()
        if current is None or current["status"] != "failed":
            return _snapshot_reconcile_receipt(
                conn, origin, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason=("origin_state_changed:" + (str(current["status"]) if current else "missing")),
            )
        origin = current
        contracts = _load_contract_index(registry_glob)
        asset = contracts.get(asset_id)
        if asset is None:
            return _snapshot_reconcile_receipt(
                conn, origin, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="canonical_contract_not_found",
            )
        if (
            asset.owner_session != origin["from_session"]
            or asset.authority_model != "local_authoritative"
            or asset.sync_direction != "local_to_remote"
        ):
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="origin_or_contract_not_safe_for_snapshot_reconcile",
            )
        try:
            validated = validate_snapshot_payload(
                asset, payload, caller_session=str(origin["from_session"]),
            )
        except (TypeError, ValueError) as exc:
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason=f"snapshot_payload_or_schema_drift:{exc}",
            )
        state = get_logical_snapshot_state(conn, int(origin["id"]))
        if state is None:
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="logical_snapshot_checkpoint_missing",
            )
        plan = state.get("plan") if isinstance(state.get("plan"), dict) else {}
        binding_errors = validate_snapshot_reconcile_checkpoint(state, asset, payload)
        if binding_errors:
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="snapshot_binding_drift_or_unsupported_state",
                evidence={"binding_errors": binding_errors},
            )
        slice_indexes = state["slice_row_indexes"]

        cli = lark if lark is not None else PacedLarkCli()
        try:
            proof = run_logical_snapshot(
                job_id=int(origin["id"]), asset=asset, payload=payload,
                caller_session=str(origin["from_session"]), conn=conn, cli=cli,
                actor="user", read_only_reconcile=True,
            )
        except (LogicalSnapshotReconcileError, LogicalSnapshotUnknownWriteError,
                SnapshotBudgetExceeded, LarkCliError, ValueError) as exc:
            evidence = getattr(exc, "evidence", {})
            if not evidence:
                checkpoint = get_logical_snapshot_state(conn, int(origin["id"])) or {}
                read_checkpoint = (
                    checkpoint.get("read_checkpoints", {}).get("reconcile_slice", {})
                    if isinstance(checkpoint.get("read_checkpoints"), dict) else {}
                )
                evidence = {
                    "checkpoint": {
                        "phase": checkpoint.get("phase", ""),
                        "prefetch_offset": checkpoint.get("prefetch_offset", 0),
                        "prefetch_pages": checkpoint.get("prefetch_pages", 0),
                        "slice_start": checkpoint.get("slice_start", 0),
                        "slice_end": checkpoint.get("slice_end", 0),
                        "work_row_cursor": checkpoint.get("work_row_cursor", 0),
                        "work_row_total": checkpoint.get("work_row_total", 0),
                        "read_checkpoint": read_checkpoint,
                    },
                }
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason=str(exc), evidence=evidence,
            )
        if not proof.get("reconciliation_complete"):
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_incomplete",
                reason="read-only reconcile budget exhausted; no resume",
                evidence=proof,
            )

        evidence = {
            "read_checkpoint": proof.get("read_checkpoint", {}),
            "record_verifications": proof.get("record_verifications", []),
            "record_verifications_total": len(proof.get("record_verifications", [])),
            "expected_slice_rows": len(slice_indexes),
            "remote_write_count": 0,
        }
        # The public success receipt is deliberately after the failed->pending
        # CAS.  Until then, only the local proof exists; publishing ``resumed``
        # first would expose success even when another actor wins the race.
        resumed = mark_failed_logical_snapshot_reconciled_pending(
            conn, int(origin["id"]), "",
            expected_error_marker=_SNAPSHOT_CREATE_UNKNOWN_MARKER,
        )
        if not resumed:
            return _snapshot_reconcile_receipt(
                conn, origin, asset=asset, receipt_dir=receipt_dir, status="reconcile_blocked",
                reason="origin_state_changed_before_resume",
                evidence=evidence,
            )
        receipt_result = _snapshot_reconcile_receipt(
            conn, origin, asset=asset, receipt_dir=receipt_dir, status="resumed",
            reason="all persisted create keys and writable fields proven by complete paginated read-only slice reconcile",
            evidence=evidence, job_status_after="pending", resumed=True,
        )
        return receipt_result
    finally:
        fcntl.flock(holder, fcntl.LOCK_UN)
        holder.close()


def reconcile_ambiguous_create_batch_read_only(
    *,
    job_id: int,
    db_path: Path | None = None,
    lock_path: Path | None = None,
    registry_glob: str = DEFAULT_REGISTRY_GLOB,
    receipt_dir: Path | None = None,
    lark: Any = None,
) -> dict[str, Any]:
    """Close one matching ambiguous-create batch without any remote mutation.

    This is intentionally a separate entry point from ``recover_ambiguous_create``.
    It accepts only a failed, local-authoritative, multi-row upsert and its code
    path contains no enqueue or remote write operation.  Any incomplete proof is
    a terminal no-op that leaves the original failed job untouched.
    """
    conn = connect(db_path)
    holder = None
    try:
        origin = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (job_id,)).fetchone()
        if origin is None:
            return _ambiguous_create_recovery_refusal(job_id, "origin_job_not_found")
        asset_id = str(origin["asset_id"])
        if origin["status"] != "failed":
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_job_not_failed:{origin['status']}", asset_id=asset_id,
            )
        if str(origin["op"]) == SNAPSHOT_OP:
            return _reconcile_failed_logical_snapshot_read_only(
                conn, origin=origin, lock_path=lock_path,
                registry_glob=registry_glob, receipt_dir=receipt_dir, lark=lark,
            )
        if str(origin["op"]) != "bitable_rows_upsert":
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_op_not_batch_upsert:{origin['op']}", asset_id=asset_id,
            )
        if _AMBIGUOUS_CREATE_RECOVERY_MARKER not in str(origin["last_error"]):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_not_ambiguous_create_terminal", asset_id=asset_id,
            )
        try:
            payload = json.loads(origin["payload_json"])
        except (TypeError, ValueError):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_payload_not_json", asset_id=asset_id,
            )
        if not isinstance(payload, list) or len(payload) < 2:
            return _ambiguous_create_recovery_refusal(
                job_id, "batch_requires_at_least_two_original_rows", asset_id=asset_id,
            )

        asset_lock = _lock_file_for(lock_path, asset_id)
        asset_lock.parent.mkdir(parents=True, exist_ok=True)
        holder = open(asset_lock, "w")
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return _ambiguous_create_recovery_refusal(
                job_id, "asset_recovery_lock_busy", asset_id=asset_id, terminal=False,
            )

        # Re-read the exact terminal job under the same asset lock as drain.
        origin = conn.execute("SELECT * FROM sync_jobs WHERE id=?", (job_id,)).fetchone()
        if origin is None or origin["status"] != "failed":
            state = "missing" if origin is None else str(origin["status"])
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_state_changed:{state}", asset_id=asset_id,
            )
        if (
            str(origin["op"]) != "bitable_rows_upsert"
            or _AMBIGUOUS_CREATE_RECOVERY_MARKER not in str(origin["last_error"])
        ):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_changed_after_lock", asset_id=asset_id,
            )
        contracts = _load_contract_index(registry_glob)
        asset = contracts.get(asset_id)
        if asset is None:
            return _ambiguous_create_recovery_refusal(
                job_id, "canonical_contract_not_found", asset_id=asset_id,
            )
        if (
            asset.owner_session != origin["from_session"]
            # This path never writes remotely: both local_authoritative tables and
            # local-to-remote derived_mirror tables can be closed only after every
            # original payload row has two stable, exact read-backs.
            or asset.authority_model not in {"local_authoritative", "derived_mirror"}
            or asset.sync_direction != "local_to_remote"
        ):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_or_contract_not_safe_for_batch_read_only_reconcile",
                asset_id=asset_id,
            )
        try:
            payload = json.loads(origin["payload_json"])
        except (TypeError, ValueError):
            return _ambiguous_create_recovery_refusal(
                job_id, "origin_payload_not_json", asset_id=asset_id,
            )
        if not isinstance(payload, list) or len(payload) < 2:
            return _ambiguous_create_recovery_refusal(
                job_id, "batch_requires_at_least_two_original_rows", asset_id=asset_id,
            )

        cli = lark if lark is not None else PacedLarkCli()
        try:
            record_verifications = _stable_ambiguous_create_batch_read_only_targets(
                asset,
                payload,
                caller_session=str(origin["from_session"]),
                cli=cli,
            )
        except (ValueError, LarkCliError) as exc:
            return _ambiguous_create_recovery_refusal(
                job_id, f"safe_target_not_proven:{exc}", asset_id=asset_id,
            )

        origin_key = str(origin["dedupe_key"])
        origin_error = str(origin["last_error"])
        origin_receipt_ref = str(origin["receipt_ref"] or "")
        record_ids = [entry["record_id"] for entry in record_verifications]
        receipts = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
        receipt_path = receipts / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
        receipt = write_receipt(receipt_path, {
            "source": "sync-queue-drain",
            "status": "done",
            "repair_kind": "ambiguous_create_batch_read_only_reconcile",
            "job_id": job_id,
            "dedupe_key": origin_key,
            "asset_id": asset_id,
            "caller_session": str(origin["from_session"]),
            "origin_root_cause_code": "ambiguous_create_read_back_not_verified",
            "origin_last_error": origin_error,
            "origin_receipt_ref": origin_receipt_ref,
            "origin_job": {
                "id": job_id,
                "status": "failed",
                "attempts": int(origin["attempts"]),
                "enqueued_at": str(origin["enqueued_at"] or ""),
                "processed_at": str(origin["processed_at"] or ""),
            },
            "remote_write_count": 0,
            "record_ids": record_ids,
            "record_ids_total": len(record_ids),
            "record_verifications": record_verifications,
            "record_verifications_total": len(record_verifications),
            "stable_target_read_back_attempts": 2,
            "created": 0,
            "updated": 0,
            "skipped": len(record_ids),
            "failed": 0,
            "read_back_verified": True,
        })
        if not mark_failed_reconciled_done_preserving_error(
            conn,
            job_id,
            str(receipt_path),
            expected_error_marker=_AMBIGUOUS_CREATE_RECOVERY_MARKER,
        ):
            current = conn.execute(
                "SELECT status FROM sync_jobs WHERE id=?", (job_id,)
            ).fetchone()
            state = str(current["status"]) if current else "missing"
            return _ambiguous_create_recovery_refusal(
                job_id, f"origin_state_changed:{state}", asset_id=asset_id,
            )
        return {
            "ok": True,
            "job_id": job_id,
            "origin_job_id": job_id,
            "asset_id": asset_id,
            "dedupe_key": origin_key,
            "status": "done",
            "repair_kind": "ambiguous_create_batch_read_only_reconcile",
            "remote_write_count": 0,
            "record_ids": record_ids,
            "failed": 0,
            "read_back_verified": True,
            "receipt_id": receipt["receipt_id"],
            "receipt_ref": str(receipt_path),
        }
    finally:
        if holder is not None:
            holder.close()
        conn.close()


def _worker_loop(worker_id: int, db_path: Path | None, contracts: dict, cli: Any,
                 *, receipt_path: Path, max_attempts: int, escalate_fn: Callable,
                 escalated_assets: set, escalated_lock: Any,
                 summary: dict, summary_lock: Any,
                 deadline: float | None = None) -> None:
    """单 worker 主循环：自己开 conn → claim_next_excluding_busy → 处理 → 重复直到无 job."""
    from .sync_queue import claim_next_excluding_busy_assets
    conn = connect(db_path)
    with summary_lock:
        summary["workers_started"] += 1
    try:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                with summary_lock:
                    summary["budget_exhausted"] = True
                break
            job = claim_next_excluding_busy_assets(conn)
            if job is None:
                break
            outcome = _process_one_job(
                job, conn, contracts, cli,
                receipt_path=receipt_path, max_attempts=max_attempts,
                escalate_fn=escalate_fn, escalated_assets=escalated_assets,
                escalated_lock=escalated_lock,
                queue_lock_held=False,
            )
            with summary_lock:
                summary[outcome] += 1
                summary.setdefault("by_worker", {}).setdefault(str(worker_id), 0)
                summary["by_worker"][str(worker_id)] += 1
            if outcome in {"requeued", "continued"}:
                # 同一轮空转重试无意义，本 worker 退出（其他 worker 仍可继续）
                break
    except Exception as exc:  # noqa: BLE001
        with summary_lock:
            summary["worker_errors"].append({
                "worker_id": worker_id,
                "error_type": type(exc).__name__,
                "error": str(exc),
            })
    finally:
        conn.close()
        with summary_lock:
            summary["workers_finished"] += 1


def drain(*, db_path: Path | None = None, lock_path: Path | None = None,
          registry_glob: str = DEFAULT_REGISTRY_GLOB,
          receipt_dir: Path | None = None, lark: Any = None,
          max_attempts: int = DEFAULT_MAX_ATTEMPTS,
          escalator: Callable[..., Any] | None = None,
          max_workers: int = 1,
          asset_scope: str | None = None,
          time_budget_s: float | None = None,
          lock_wait_s: float = 0.0,
          lock_retry_interval_s: float = 5.0,
          sleeper: Callable[[float], Any] = time.sleep) -> dict[str, Any]:
    """drain 队列。

    time_budget_s（仅串行路径）：best-effort 墙钟预算。设值后每领一个 job 前检查 elapsed，
    超预算立即停领、summary 记 `budget_exhausted=True`（已 claim 的 job 仍跑完）。留给
    **reconcile step-1 drain** 用——full reconcile 不该被一条积压/中毒队列（894 pending）
    卡在 drain 里耗光整轮预算、导致后续 mirror/docs/审计跑不到、闭环 receipt 落不下
    （事故出处 2026-07-04：队列 P0 停摆 894 pending，reconcile 06:30 起了却零 receipt）。
    队列真正 drain 靠 minute drain-tick 兜底，reconcile 只做有界 best-effort。None=不限（旧行为）。

    max_workers=1（默认）走原串行路径 + 持久 asset round-robin claim（兼容现有 cron）。
    max_workers>1 启动 ThreadPool 并发：各 worker 自己 claim_next_excluding_busy_assets，
    SQL 层保证同 asset 跨 worker 串行，避免 race。

    asset_scope=<asset_id>：作用域 drain（仅串行路径），只处理该 asset 的 pending job，
    不卷入其他 asset 的待办。发起方在 enqueue 后想"只把自家这批 543 行 push 出去、
    不替别人 drain"时使用；reset_stale 仍是全表语义（避免 in_progress 残留漂移）。

    锁模型：asset_scope 设置时用 **per-asset 锁文件** `sync-queue.<asset>.lock`，
    不占全局锁——这样不同 asset 的 scoped drain（含 enqueue inline drain）互不阻塞，
    单个 asset 的 drain 卡死/慢也不会锁死整条队列（2026-07-04 scheduler.mirror.v2-tasks
    enqueue 反复卡住全局锁和大量 job 堆积的事故）。
    并发正确性靠 SQL 原子 claim（claim_next[_for_asset] 都校验 rowcount==1，同 job 只被
    一个 drainer 领走）+ receipt append 独立 flock 串行化（见 receipts.write_receipt）；
    reset_stale 幂等。全局 drain（asset_scope=None）仍用全局锁不变。

    lock_wait_s>0 仅让调用方等待同一把锁释放后重试，不会绕过锁或与现有 drainer 并行。
    reconcile 用它避免恰好与 minute tick 同秒启动时，立即以 locked=true 放弃本轮队列收敛。
    """
    from .sync_queue import reset_stale
    import threading

    lock_file = _lock_file_for(lock_path, asset_scope)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    holder = open(lock_file, "w")
    lock_deadline = time.monotonic() + max(0.0, lock_wait_s)
    lock_wait_attempts = 0
    while True:
        try:
            fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            remaining = lock_deadline - time.monotonic()
            if remaining <= 0:
                holder.close()
                return {
                    "locked": True, "done": 0, "failed": 0, "requeued": 0,
                    "stale_reset": 0, "lock_wait_attempts": lock_wait_attempts,
                }
            lock_wait_attempts += 1
            sleeper(min(max(0.0, lock_retry_interval_s), remaining))
    escalate_fn = escalator or (lambda title, body, todo_key: escalate(title, body, todo_key=todo_key))
    receipts = Path(receipt_dir) if receipt_dir else DEFAULT_RECEIPT_DIR
    receipt_path = receipts / f"{datetime.now(timezone.utc).date().isoformat()}-sync-queue.ndjson"
    cli = lark if lark is not None else PacedLarkCli()
    contracts = _load_contract_index(registry_glob)
    summary: dict[str, Any] = {
        "locked": False,
        "done": 0,
        "ledger_pending": 0,
        "failed": 0,
        "requeued": 0,
        "continued": 0,
        "workers_started": 0,
        "workers_finished": 0,
        "worker_errors": [],
        "lock_wait_attempts": lock_wait_attempts,
    }
    escalated_assets: set[str] = set()
    escalated_lock = threading.Lock()
    summary_lock = threading.Lock()
    deadline = (time.monotonic() + time_budget_s
                if time_budget_s is not None else None)

    # drain 入口先 reset_stale：不依赖 reconcile 跑通就能回滚 in_progress > 30min 的 job。
    # 事故出处：2026-06-24 reconcile cron 一周挂掉，drain 没人调 reset_stale，553 卡 in_progress。
    stale_conn = connect(db_path)
    try:
        summary["stale_reset"] = reset_stale(stale_conn)
    finally:
        stale_conn.close()

    try:
        if max_workers <= 1:
            # 兼容串行路径（同 conn 循环，但沿用持久 asset round-robin claim）
            # asset_scope 设置时切到 claim_next_for_asset，只处理该 asset 的 pending。
            conn = connect(db_path)
            try:
                while True:
                    if deadline is not None and time.monotonic() >= deadline:
                        summary["budget_exhausted"] = True
                        break
                    if asset_scope:
                        job = claim_next_for_asset(conn, asset_scope)
                    else:
                        # Use the same persistent asset round-robin selector as
                        # the threaded path.  A logical-snapshot continuation
                        # yields after one slice, so the next single-worker
                        # tick must give another asset a claim opportunity.
                        job = claim_next_excluding_busy_assets(conn)
                    if job is None:
                        break
                    outcome = _process_one_job(
                        job, conn, contracts, cli,
                        receipt_path=receipt_path, max_attempts=max_attempts,
                        escalate_fn=escalate_fn, escalated_assets=escalated_assets,
                        escalated_lock=escalated_lock,
                        queue_lock_held=bool(asset_scope),
                    )
                    summary[outcome] += 1
                    if outcome in {"requeued", "continued"}:
                        break
            finally:
                conn.close()
            if asset_scope:
                summary["asset_scope"] = asset_scope
        else:
            # 并发路径：N 个 worker 各自跑 _worker_loop（独立 conn + 同 asset SQL 排他）
            threads = []
            for i in range(max_workers):
                t = threading.Thread(
                    target=_worker_loop,
                    args=(i, db_path, contracts, cli),
                    kwargs=dict(
                        receipt_path=receipt_path, max_attempts=max_attempts,
                        escalate_fn=escalate_fn, escalated_assets=escalated_assets,
                        escalated_lock=escalated_lock,
                        summary=summary, summary_lock=summary_lock,
                        deadline=deadline,
                    ),
                    name=f"sync-drain-worker-{i}",
                )
                t.start()
                threads.append(t)
            for t in threads:
                t.join()
            summary["max_workers"] = max_workers
            summary["fatal_error"] = bool(summary["worker_errors"])
    finally:
        holder.close()
    return summary
