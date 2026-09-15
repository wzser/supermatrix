from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
from typing import Any
import uuid

from .state import HeartbeatState


RECEIPT_FORMAT = "heartbeat-temporary-snapshot-v1"
SNAPSHOT_PREFIX = "heartbeat-temporary-"
RECEIPT_SUFFIX = ".receipt.json"


class UnsafeReceiptError(ValueError):
    """A receipt tried to authorize a path outside the managed snapshot directory."""


def temporary_snapshot_dir(state_db_path: Path) -> Path:
    """Keep managed temporary copies separate from legacy data/backups files."""
    return state_db_path.parent / "temporary-snapshots"


def create_temporary_snapshot(
    *,
    state: HeartbeatState,
    snapshot_dir: Path,
    owner: str,
    reason: str,
    expires_at: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create one consistent, receipt-backed temporary state snapshot."""
    owner = owner.strip()
    reason = reason.strip()
    if not owner:
        raise ValueError("temporary snapshot owner is required")
    if not reason:
        raise ValueError("temporary snapshot reason is required")

    current = _utc_now(now)
    expiry = _parse_timestamp(expires_at, field="expires_at")
    if expiry <= current:
        raise ValueError("temporary snapshot expiry must be in the future")

    snapshot_dir = snapshot_dir.resolve()
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    cleanup_before_create = cleanup_expired_temporary_snapshots(
        state=state,
        snapshot_dir=snapshot_dir,
        now=current,
    )

    created_at = _format_timestamp(current)
    snapshot_id = f"{SNAPSHOT_PREFIX}{current.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:12]}"
    snapshot_path = snapshot_dir / f"{snapshot_id}.sqlite"
    receipt_path = _receipt_path(snapshot_path)
    try:
        _backup_sqlite(source=state.path, destination=snapshot_path)
        _quick_check(snapshot_path)
        snapshot_bytes = snapshot_path.stat().st_size
    except Exception:
        _remove_new_snapshot_artifacts(snapshot_path)
        raise

    receipt = {
        "format": RECEIPT_FORMAT,
        "snapshot_id": snapshot_id,
        "status": "active",
        "owner": owner,
        "reason": reason,
        "created_at": created_at,
        "expires_at": _format_timestamp(expiry),
        "source_db": str(state.path.resolve()),
        "snapshot_path": str(snapshot_path),
        "receipt_path": str(receipt_path),
        "snapshot_bytes": snapshot_bytes,
        "integrity_check": "ok",
        "cleanup_mode": "full_patrol",
    }
    _write_receipt(receipt_path, receipt)
    state.log_event(
        event_type="temporary_snapshot_created",
        status="active",
        logical_key=snapshot_id,
        summary=(
            f"owner={owner}; reason={reason}; expires_at={receipt['expires_at']}; "
            f"receipt={receipt_path}"
        ),
        trigger_source="temporary_snapshot",
        trigger_cause="explicit_create",
        trigger_location="heartbeat",
    )
    return {
        "snapshot_id": snapshot_id,
        "snapshot_path": str(snapshot_path),
        "receipt_path": str(receipt_path),
        "snapshot_bytes": snapshot_bytes,
        "expires_at": receipt["expires_at"],
        "integrity_check": "ok",
        "cleaned_before_create": cleanup_before_create["cleaned"],
    }


def cleanup_expired_temporary_snapshots(
    *,
    state: HeartbeatState,
    snapshot_dir: Path,
    now: datetime | None = None,
    patrol_id: str | None = None,
) -> dict[str, list[Any]]:
    """Remove only expired snapshot files named and authorized by a managed receipt."""
    current = _utc_now(now)
    snapshot_dir = snapshot_dir.resolve()
    result: dict[str, list[Any]] = {"cleaned": [], "missing": [], "skipped_unsafe": [], "skipped_invalid": []}
    if not snapshot_dir.is_dir():
        return result

    for receipt_path in sorted(snapshot_dir.glob(f"{SNAPSHOT_PREFIX}*{RECEIPT_SUFFIX}")):
        if receipt_path.is_symlink():
            result["skipped_unsafe"].append(str(receipt_path))
            continue
        try:
            receipt = json.loads(receipt_path.read_text())
            if not isinstance(receipt, dict) or receipt.get("format") != RECEIPT_FORMAT:
                raise ValueError("unrecognized receipt format")
            if receipt.get("status") != "active":
                continue
            expiry = _parse_timestamp(str(receipt.get("expires_at") or ""), field="expires_at")
            if expiry > current:
                continue
            snapshot_path = _managed_snapshot_path(snapshot_dir, receipt_path, receipt)
        except UnsafeReceiptError:
            result["skipped_unsafe"].append(str(receipt_path))
            continue
        except (OSError, ValueError, json.JSONDecodeError):
            result["skipped_invalid"].append(str(receipt_path))
            continue

        if not snapshot_path.exists():
            receipt["status"] = "missing"
            receipt["missing_at"] = _format_timestamp(current)
            receipt["released_bytes"] = 0
            _write_receipt(receipt_path, receipt)
            state.log_event(
                patrol_id=patrol_id,
                event_type="temporary_snapshot_missing",
                status="missing",
                logical_key=str(receipt.get("snapshot_id") or ""),
                summary=f"expired temporary snapshot was already absent; receipt={receipt_path}",
                trigger_source="temporary_snapshot",
                trigger_cause="expiry_cleanup",
                trigger_location="heartbeat",
            )
            result["missing"].append(str(receipt_path))
            continue

        files = [snapshot_path, Path(f"{snapshot_path}-wal"), Path(f"{snapshot_path}-shm")]
        if any(path.is_symlink() for path in files if path.exists()):
            result["skipped_unsafe"].append(str(receipt_path))
            continue
        released_bytes = sum(path.stat().st_size for path in files if path.exists())
        for path in files:
            if path.exists():
                path.unlink()
        receipt["status"] = "cleaned"
        receipt["cleaned_at"] = _format_timestamp(current)
        receipt["released_bytes"] = released_bytes
        _write_receipt(receipt_path, receipt)
        state.log_event(
            patrol_id=patrol_id,
            event_type="temporary_snapshot_cleaned",
            status="cleaned",
            logical_key=str(receipt.get("snapshot_id") or ""),
            summary=(
                f"expired temporary snapshot removed; released_bytes={released_bytes}; "
                f"receipt={receipt_path}"
            ),
            trigger_source="temporary_snapshot",
            trigger_cause="expiry_cleanup",
            trigger_location="heartbeat",
        )
        result["cleaned"].append(
            {"snapshot_path": str(snapshot_path), "receipt_path": str(receipt_path), "released_bytes": released_bytes}
        )
    return result


def _backup_sqlite(*, source: Path, destination: Path) -> None:
    source_path = source.resolve()
    if not source_path.is_file():
        raise ValueError(f"heartbeat state database does not exist: {source_path}")
    source_uri = f"{source_path.as_uri()}?mode=ro"
    source_conn = sqlite3.connect(source_uri, uri=True)
    destination_conn = sqlite3.connect(destination)
    try:
        source_conn.backup(destination_conn)
    finally:
        destination_conn.close()
        source_conn.close()


def _quick_check(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        result = conn.execute("PRAGMA quick_check(1)").fetchone()
    if result is None or result[0] != "ok":
        raise RuntimeError(f"temporary snapshot quick_check failed: {path}: {result}")


def _remove_new_snapshot_artifacts(snapshot_path: Path) -> None:
    """Best-effort rollback for a just-created copy that never received a receipt."""
    for path in (snapshot_path, Path(f"{snapshot_path}-wal"), Path(f"{snapshot_path}-shm")):
        if path.exists() and not path.is_symlink():
            path.unlink()


def _managed_snapshot_path(snapshot_dir: Path, receipt_path: Path, receipt: dict[str, Any]) -> Path:
    raw_path = str(receipt.get("snapshot_path") or "")
    if not raw_path:
        raise ValueError("receipt has no snapshot_path")
    snapshot_path = Path(raw_path)
    if not snapshot_path.is_absolute():
        raise ValueError("receipt snapshot_path must be absolute")
    if snapshot_path.is_symlink():
        raise UnsafeReceiptError("receipt snapshot_path is a symlink")
    if snapshot_path.parent.resolve() != snapshot_dir:
        raise UnsafeReceiptError("receipt snapshot_path is outside managed directory")
    if not snapshot_path.name.startswith(SNAPSHOT_PREFIX) or snapshot_path.suffix != ".sqlite":
        raise UnsafeReceiptError("receipt snapshot_path is not a managed snapshot name")
    if _receipt_path(snapshot_path) != receipt_path:
        raise UnsafeReceiptError("receipt path does not match snapshot path")
    return snapshot_path


def _receipt_path(snapshot_path: Path) -> Path:
    return snapshot_path.with_suffix(RECEIPT_SUFFIX)


def _write_receipt(path: Path, receipt: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def _parse_timestamp(raw: str, *, field: str) -> datetime:
    value = raw.strip()
    if value.endswith("Z"):
        value = f"{value[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} must be an ISO-8601 timestamp with timezone") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc).replace(microsecond=0)


def _format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _utc_now(value: datetime | None) -> datetime:
    current = value or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("now must include a timezone")
    return current.astimezone(timezone.utc).replace(microsecond=0)
