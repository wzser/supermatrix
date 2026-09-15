from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any


COMPLETION_SCHEMA_VERSION = "heartbeat.completion-canonical/v1"
STATE_HISTORY_SCHEMA_VERSION = "heartbeat.state-history/v1"
STATE_SEGMENT_SCHEMA_VERSION = "heartbeat.state-history-segment/v1"
COMPLETION_POINTER_SCHEMA_VERSION = "heartbeat.completion-pointer/v1"
PRODUCTION_HISTORY_MANIFEST_NAME = "production-20260820"
_RUN_FIELDS = ("completion_id", "patrol_id", "started_at", "finished_at")
_PLACEHOLDER = "__heartbeat_manifest__"
_TODO_ID_RE = re.compile(r"\btodo_id=([^;,\s]+)")
_ROTATED_TRIGGER_RE = re.compile(
    r"^(?P<session>.+)\.(?P<stamp>[0-9A-Za-z]+)\.(?P<sha256>[0-9a-f]{16})\.log(?:\.gz)?$"
)
_STATE_TABLES = {
    "patrol_runs": ("patrol_id", "COALESCE(finished_at, started_at)"),
    "heartbeat_events": ("event_id", "created_at"),
    "unrecovered_escalation_handoffs": ("handoff_id", "updated_at"),
    "session_todos": ("todo_id", "COALESCE(finished_at, injected_at, claimed_at, created_at)"),
}


class CanonicalPackWriter:
    """Append immutable objects to one segment while deduplicating exact bytes."""

    def __init__(self, *, archive_path: Path, schema_version: str, created_at: str) -> None:
        self.archive_path = archive_path.resolve()
        self.schema_version = schema_version
        self.created_at = created_at
        self.archive_path.parent.mkdir(parents=True, exist_ok=True)
        self._output = self.archive_path.open("x+b")
        self._digest = hashlib.sha256()
        self._objects: dict[str, tuple[int, int]] = {}
        self._closed = False

    def add(self, content: bytes, *, object_prefix: str) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("canonical pack is closed")
        content_sha256 = hashlib.sha256(content).hexdigest()
        existing = self._objects.get(content_sha256)
        if existing is None:
            self._output.seek(0, os.SEEK_END)
            offset = self._output.tell()
            self._output.write(content)
            self._digest.update(content)
            self._objects[content_sha256] = (offset, len(content))
        else:
            offset, length = existing
            self._output.flush()
            self._output.seek(offset)
            previous = self._output.read(length)
            if previous != content:
                raise RuntimeError("canonical pack SHA-256 collision")
            return self._locator(
                object_prefix=object_prefix,
                content_sha256=content_sha256,
                offset=offset,
                length=length,
            )
        return self._locator(
            object_prefix=object_prefix,
            content_sha256=content_sha256,
            offset=offset,
            length=len(content),
        )

    def close(self) -> dict[str, Any]:
        if self._closed:
            raise RuntimeError("canonical pack is already closed")
        self._output.flush()
        os.fsync(self._output.fileno())
        self._output.close()
        self._closed = True
        receipt = {
            "schema_version": "heartbeat.canonical-segment/v1",
            "content_schema_version": self.schema_version,
            "archive_path": str(self.archive_path),
            "sha256": self._digest.hexdigest(),
            "byte_length": self.archive_path.stat().st_size,
            "object_count": len(self._objects),
            "created_at": self.created_at,
        }
        _write_immutable(self.archive_path.with_suffix(".segment.json"), _json_bytes(receipt))
        return receipt

    def _locator(
        self,
        *,
        object_prefix: str,
        content_sha256: str,
        offset: int,
        length: int,
    ) -> dict[str, Any]:
        return {
            "canonical_object_id": f"{object_prefix}:{content_sha256}",
            "content_sha256": content_sha256,
            "archive_path": str(self.archive_path),
            "byte_offset": offset,
            "byte_length": length,
            "schema_version": self.schema_version,
            "created_at": self.created_at,
        }


def archive_completion_bytes(
    *,
    raw: bytes,
    original_path: Path,
    canonical_dir: Path,
    event_ids: list[str] | None = None,
    handoff_ids: list[str] | None = None,
    todo_ids: list[str] | None = None,
    batch_keys: list[str] | None = None,
    created_at: str,
) -> dict[str, Any]:
    receipt = json.loads(raw)
    if not isinstance(receipt, dict) or not isinstance(receipt.get("run"), dict):
        raise ValueError("completion receipt must contain a run object")
    run = receipt["run"]
    completion_id = str(run.get("completion_id") or "")
    if not completion_id:
        raise ValueError("completion receipt must contain completion_id")

    template = copy.deepcopy(receipt)
    template["status"] = _PLACEHOLDER
    for field in _RUN_FIELDS:
        template["run"][field] = _PLACEHOLDER
    template_bytes = _json_bytes(template)
    normalized_sha256 = hashlib.sha256(template_bytes).hexdigest()
    archive_path = canonical_dir / "completion" / "objects" / normalized_sha256[:2] / f"{normalized_sha256}.json"
    _write_immutable(archive_path, template_bytes)

    return {
        "completion_id": completion_id,
        "patrol_id": _optional_text(run.get("patrol_id")),
        "event_ids": sorted(set(event_ids or [])),
        "handoff_ids": sorted(set(handoff_ids or [])),
        "todo_ids": sorted(set(todo_ids or [])),
        "batch_keys": sorted(set(batch_keys or [])),
        "started_at": str(run.get("started_at") or ""),
        "finished_at": str(run.get("finished_at") or ""),
        "status": str(receipt.get("status") or ""),
        "original_sha256": hashlib.sha256(raw).hexdigest(),
        "normalized_sha256": normalized_sha256,
        "original_path": str(original_path.resolve()),
        "canonical_object_id": f"completion-template:{normalized_sha256}",
        "content_sha256": normalized_sha256,
        "archive_path": str(archive_path.resolve()),
        "byte_offset": 0,
        "byte_length": len(template_bytes),
        "schema_version": COMPLETION_SCHEMA_VERSION,
        "created_at": created_at,
    }


def reconstruct_completion_bytes(manifest: dict[str, Any]) -> bytes:
    archive_path = Path(str(manifest["archive_path"]))
    offset = int(manifest["byte_offset"])
    length = int(manifest["byte_length"])
    with archive_path.open("rb") as source:
        source.seek(offset)
        template_bytes = source.read(length)
    if hashlib.sha256(template_bytes).hexdigest() != str(manifest["content_sha256"]):
        raise ValueError("canonical completion content hash mismatch")
    if str(manifest.get("schema_version")) == "heartbeat.completion-raw/v1":
        if hashlib.sha256(template_bytes).hexdigest() != str(manifest["original_sha256"]):
            raise ValueError("raw completion hash mismatch")
        return template_bytes
    receipt = json.loads(template_bytes)
    receipt["status"] = str(manifest["status"])
    run = receipt["run"]
    for field in _RUN_FIELDS:
        run[field] = manifest.get(field)
    rebuilt = _json_bytes(receipt)
    if hashlib.sha256(rebuilt).hexdigest() != str(manifest["original_sha256"]):
        raise ValueError("reconstructed completion hash mismatch")
    return rebuilt


def completion_pointer(manifest: dict[str, Any]) -> dict[str, Any]:
    """Return the bounded online receipt; canonical+manifest hold the full body."""
    return {
        "schema": COMPLETION_POINTER_SCHEMA_VERSION,
        "status": str(manifest.get("status") or ""),
        "run": {field: manifest.get(field) for field in _RUN_FIELDS},
        "original_sha256": str(manifest["original_sha256"]),
        "canonical_object_id": str(manifest["canonical_object_id"]),
        "content_sha256": str(manifest["content_sha256"]),
        "archive_path": str(manifest["archive_path"]),
        "byte_offset": int(manifest["byte_offset"]),
        "byte_length": int(manifest["byte_length"]),
        "schema_version": str(manifest["schema_version"]),
        "created_at": str(manifest["created_at"]),
        "manifest": {
            key: value
            for key, value in manifest.items()
            if not key.startswith("manifest_")
        },
        "manifest_path": str(manifest["manifest_path"]),
        "manifest_byte_offset": int(manifest["manifest_byte_offset"]),
        "manifest_byte_length": int(manifest["manifest_byte_length"]),
    }


def reconstruct_completion_pointer_bytes(pointer: dict[str, Any]) -> bytes:
    if str(pointer.get("schema") or "") != COMPLETION_POINTER_SCHEMA_VERSION:
        raise ValueError("unsupported completion pointer schema")
    manifest = pointer.get("manifest")
    if not isinstance(manifest, dict):
        raise ValueError("completion pointer is missing its reconstruction manifest")
    rebuilt = reconstruct_completion_bytes(manifest)
    if hashlib.sha256(rebuilt).hexdigest() != str(pointer.get("original_sha256") or ""):
        raise ValueError("completion pointer original hash mismatch")
    return rebuilt


def is_never_sweep_history_path(path: Path, *, data_root: Path) -> bool:
    """Hard gate for R26's sole manifest and every canonical body it can reference."""
    candidate = path.resolve()
    protected_roots = (
        (data_root / "history-manifests" / PRODUCTION_HISTORY_MANIFEST_NAME).resolve(),
        (data_root / "history-canonical" / "completion" / "objects").resolve(),
        (data_root / "history-canonical" / "completion" / "raw").resolve(),
    )
    return any(candidate == root or root in candidate.parents for root in protected_roots)


def compact_closed_live_manifests(
    *,
    manifest_root: Path,
    before_day: str,
    apply: bool,
    data_root: Path,
) -> dict[str, Any]:
    """Gzip closed daily indexes after byte-exact decompression verification."""
    candidates: list[str] = []
    compacted = 0
    for path in sorted((manifest_root / "completion").glob("*/*.jsonl")):
        match = re.fullmatch(r"completion-(\d{4}-\d{2}-\d{2})\.jsonl", path.name)
        if match is None or match.group(1) >= before_day:
            continue
        if is_never_sweep_history_path(path, data_root=data_root):
            continue
        candidates.append(str(path.resolve()))
        if not apply:
            continue
        with path.with_suffix(".lock").open("a") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            if not path.exists():
                continue
            source_mtime = path.stat().st_mtime
            raw = path.read_bytes()
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            compressed_path = path.with_suffix(".jsonl.gz")
            _write_immutable(compressed_path, compressed)
            if gzip.decompress(compressed_path.read_bytes()) != raw:
                raise RuntimeError(f"compressed manifest readback mismatch: {path}")
            receipt = {
                "schema_version": "heartbeat.compressed-index-segment/v1",
                "archive_path": str(compressed_path.resolve()),
                "source_path": str(path.resolve()),
                "uncompressed_sha256": hashlib.sha256(raw).hexdigest(),
                "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                "uncompressed_bytes": len(raw),
                "compressed_bytes": len(compressed),
                "created_at": datetime.fromtimestamp(source_mtime, timezone.utc).isoformat(timespec="seconds"),
            }
            _write_immutable(compressed_path.with_suffix(".gz.segment.json"), _json_bytes(receipt))
            unlink_history_path(path, data_root=data_root)
            compacted += 1
    return {"candidates": candidates, "compacted": compacted, "production_files_deleted": compacted}


def prepare_enqueue_log(
    log_path: Path,
    *,
    max_bytes: int,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Rotate an active detached-output log before opening its next writer."""
    if max_bytes <= 0:
        raise ValueError("enqueue log max_bytes must be positive")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = log_path.parent / ".rotation.lock"
    with lock_path.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with _open_enqueue_writer_lease(log_path.parent, log_path.stem) as lease:
            try:
                fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"status": "active_writer_present", "log_path": str(log_path.resolve())}
            return _prepare_enqueue_log_locked(log_path, max_bytes=max_bytes, created_at=created_at)


def _prepare_enqueue_log_locked(
    log_path: Path,
    *,
    max_bytes: int,
    created_at: str | None,
) -> dict[str, Any]:
    if not log_path.exists() or log_path.stat().st_size < max_bytes:
        return {"status": "active", "log_path": str(log_path.resolve())}
    raw_sha256 = _file_sha256(log_path)
    stamp = _path_time(created_at or datetime.now(timezone.utc).isoformat(timespec="seconds"))
    rotated = log_path.with_name(f"{log_path.stem}.{stamp}.{raw_sha256[:16]}.log")
    if rotated.exists():
        if _file_sha256(rotated) != raw_sha256:
            raise RuntimeError(f"rotated enqueue log collision: {rotated}")
        unlink_history_path(log_path, data_root=log_path.parent.parent)
    else:
        os.replace(log_path, rotated)
    return {
        "status": "rotated",
        "log_path": str(log_path.resolve()),
        "rotated_path": str(rotated.resolve()),
        "bytes": rotated.stat().st_size,
        "sha256": raw_sha256,
    }


def rotate_enqueue_log_in_place(
    log_path: Path,
    *,
    max_bytes: int,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Archive and truncate an active log without changing its inode.

    localwatch opens these logs with shell ``>>`` redirection and may keep the
    descriptor open while the watcher runs.  Copy-truncate lets that writer
    continue using the same descriptor; rename-based rotation would strand its
    future output in an unlinked/closed segment.
    """
    if max_bytes <= 0:
        raise ValueError("enqueue log max_bytes must be positive")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = log_path.parent / ".rotation.lock"
    with lock_path.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with _open_enqueue_writer_lease(log_path.parent, log_path.stem) as lease:
            try:
                fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"status": "active_writer_present", "log_path": str(log_path.resolve())}
            return _rotate_enqueue_log_in_place_locked(
                log_path,
                max_bytes=max_bytes,
                created_at=created_at,
            )


def _rotate_enqueue_log_in_place_locked(
    log_path: Path,
    *,
    max_bytes: int,
    created_at: str | None,
) -> dict[str, Any]:
    if not log_path.exists() or log_path.stat().st_size < max_bytes:
        return {"status": "active", "log_path": str(log_path.resolve())}
    raw = log_path.read_bytes()
    if len(raw) < max_bytes:
        return {"status": "active", "log_path": str(log_path.resolve())}
    raw_sha256 = hashlib.sha256(raw).hexdigest()
    stamp = _path_time(created_at or datetime.now(timezone.utc).isoformat(timespec="seconds"))
    rotated = log_path.with_name(f"{log_path.stem}.{stamp}.{raw_sha256[:16]}.log")
    _write_immutable(rotated, raw)
    if rotated.read_bytes() != raw:
        raise RuntimeError(f"rotated enqueue log readback mismatch: {rotated}")
    with log_path.open("r+b") as active:
        active.truncate(0)
        active.flush()
        os.fsync(active.fileno())
    return {
        "status": "rotated",
        "log_path": str(log_path.resolve()),
        "rotated_path": str(rotated.resolve()),
        "bytes": len(raw),
        "sha256": raw_sha256,
        "mode": "copytruncate",
    }


def maintain_enqueue_trigger_logs(
    *,
    log_dir: Path,
    max_bytes: int,
    sessions: list[str] | None = None,
    compact_after_seconds: int = 3600,
    retention_days: int = 14,
    max_segments_per_session: int = 8,
    minimum_keep: int = 2,
    apply: bool = True,
    now_epoch: float | None = None,
) -> dict[str, Any]:
    """Bound active trigger logs and compact closed segments in one pass."""
    if not apply:
        return {"rotated": [], "skipped_active_writers": [], "compacted": 0, "deleted": 0}
    if compact_after_seconds < 0 or retention_days < 0:
        raise ValueError("enqueue log retention intervals must be non-negative")
    log_dir.mkdir(parents=True, exist_ok=True)
    selected_sessions = set(sessions or [])
    rotated: list[dict[str, Any]] = []
    skipped_active_writers: list[str] = []
    for path in sorted(log_dir.glob("*.log")):
        if not path.is_file() or _ROTATED_TRIGGER_RE.fullmatch(path.name):
            continue
        if selected_sessions and path.stem not in selected_sessions:
            continue
        result = rotate_enqueue_log_in_place(path, max_bytes=max_bytes)
        if result.get("status") == "rotated":
            rotated.append(result)
        elif result.get("status") == "active_writer_present":
            skipped_active_writers.append(str(path.resolve()))

    current_epoch = datetime.now(timezone.utc).timestamp() if now_epoch is None else now_epoch
    compacted = compact_rotated_enqueue_logs(
        log_dir=log_dir,
        sessions=sessions,
        compact_before_epoch=current_epoch - compact_after_seconds,
        retention_before_epoch=current_epoch - retention_days * 86400,
        max_segments_per_session=max_segments_per_session,
        minimum_keep=minimum_keep,
        apply=True,
    )
    return {
        "rotated": rotated,
        "skipped_active_writers": skipped_active_writers,
        **compacted,
    }


def open_enqueue_log_for_child(log_path: Path) -> tuple[Any, Any, dict[str, Any]]:
    """Open stdout plus an inherited shared lease that proves the writer is alive."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if os.environ.get("HEARTBEAT_STORAGE_RETENTION_APPLY", "0") == "1":
        current_epoch = datetime.now(timezone.utc).timestamp()
        compact_rotated_enqueue_logs(
            log_dir=log_path.parent,
            compact_before_epoch=current_epoch
            - int(os.environ.get("HEARTBEAT_ENQUEUE_LOG_COMPACT_AFTER_SECONDS", "3600")),
            retention_before_epoch=current_epoch
            - int(os.environ.get("HEARTBEAT_ENQUEUE_LOG_RETENTION_DAYS", "14")) * 86400,
            max_segments_per_session=int(os.environ.get("HEARTBEAT_ENQUEUE_LOG_MAX_SEGMENTS", "8")),
            minimum_keep=int(os.environ.get("HEARTBEAT_ENQUEUE_LOG_MINIMUM_KEEP", "2")),
            apply=True,
        )
    rotation_lock = log_path.parent / ".rotation.lock"
    with rotation_lock.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        lease = _open_enqueue_writer_lease(log_path.parent, log_path.stem)
        try:
            try:
                fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                exclusive = True
            except BlockingIOError:
                exclusive = False
            rotation = {"status": "active_writer_present", "log_path": str(log_path.resolve())}
            if exclusive and os.environ.get("HEARTBEAT_STORAGE_RETENTION_APPLY", "0") == "1":
                rotation = _prepare_enqueue_log_locked(
                    log_path,
                    max_bytes=int(os.environ.get("HEARTBEAT_ENQUEUE_LOG_MAX_BYTES", str(8 * 1024 * 1024))),
                    created_at=None,
                )
            fcntl.flock(lease.fileno(), fcntl.LOCK_SH)
            output = log_path.open("ab")
        except Exception:
            lease.close()
            raise
    return output, lease, rotation


def _open_enqueue_writer_lease(log_dir: Path, session: str):
    return (log_dir / f".{session}.writer.lock").open("a")


def compact_rotated_enqueue_logs(
    *,
    log_dir: Path,
    sessions: list[str] | None = None,
    compact_before_epoch: float,
    retention_before_epoch: float,
    max_segments_per_session: int,
    minimum_keep: int,
    apply: bool,
) -> dict[str, Any]:
    log_dir.mkdir(parents=True, exist_ok=True)
    with (log_dir / ".rotation.lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _compact_rotated_enqueue_logs_locked(
            log_dir=log_dir,
            sessions=sessions,
            compact_before_epoch=compact_before_epoch,
            retention_before_epoch=retention_before_epoch,
            max_segments_per_session=max_segments_per_session,
            minimum_keep=minimum_keep,
            apply=apply,
        )


def _compact_rotated_enqueue_logs_locked(
    *,
    log_dir: Path,
    sessions: list[str] | None,
    compact_before_epoch: float,
    retention_before_epoch: float,
    max_segments_per_session: int,
    minimum_keep: int,
    apply: bool,
) -> dict[str, Any]:
    """Compress closed trigger segments and bound retained compressed generations."""
    if minimum_keep < 0 or max_segments_per_session < minimum_keep:
        raise ValueError("invalid enqueue log segment limits")
    compacted = 0
    deleted = 0
    selected_sessions = set(sessions or [])
    for path in sorted(log_dir.glob("*.log")):
        match = _ROTATED_TRIGGER_RE.fullmatch(path.name)
        if (
            match is None
            or (selected_sessions and match.group("session") not in selected_sessions)
            or path.stat().st_mtime >= compact_before_epoch
        ):
            continue
        if not apply:
            continue
        with _open_enqueue_writer_lease(log_dir, match.group("session")) as lease:
            try:
                fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            source_mtime = path.stat().st_mtime
            raw = path.read_bytes()
            compressed_path = Path(str(path) + ".gz")
            compressed = gzip.compress(raw, compresslevel=9, mtime=0)
            _write_immutable(compressed_path, compressed)
            if gzip.decompress(compressed_path.read_bytes()) != raw:
                raise RuntimeError(f"compressed enqueue log readback mismatch: {path}")
            _write_immutable(
                Path(str(compressed_path) + ".segment.json"),
                _json_bytes(
                    {
                        "schema_version": "heartbeat.enqueue-log-segment/v1",
                        "archive_path": str(compressed_path.resolve()),
                        "source_path": str(path.resolve()),
                        "uncompressed_sha256": hashlib.sha256(raw).hexdigest(),
                        "compressed_sha256": hashlib.sha256(compressed).hexdigest(),
                        "uncompressed_bytes": len(raw),
                        "compressed_bytes": len(compressed),
                        "created_at": datetime.fromtimestamp(source_mtime, timezone.utc).isoformat(timespec="seconds"),
                    }
                ),
            )
            unlink_history_path(path, data_root=log_dir.parent)
            compacted += 1

    grouped: dict[str, list[Path]] = {}
    for path in log_dir.glob("*.log.gz"):
        match = _ROTATED_TRIGGER_RE.fullmatch(path.name)
        if match is not None and (not selected_sessions or match.group("session") in selected_sessions):
            grouped.setdefault(match.group("session"), []).append(path)
    for paths in grouped.values():
        paths.sort(key=lambda item: (item.stat().st_mtime, item.name), reverse=True)
        for index, path in enumerate(paths):
            expired = path.stat().st_mtime < retention_before_epoch
            over_cap = index >= max_segments_per_session
            if index < minimum_keep or not (expired or over_cap) or not apply:
                continue
            match = _ROTATED_TRIGGER_RE.fullmatch(path.name)
            assert match is not None
            with _open_enqueue_writer_lease(log_dir, match.group("session")) as lease:
                try:
                    fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                sidecar = Path(str(path) + ".segment.json")
                unlink_history_path(path, data_root=log_dir.parent)
                if sidecar.exists():
                    unlink_history_path(sidecar, data_root=log_dir.parent)
                deleted += 1
    return {"compacted": compacted, "deleted": deleted}


def unlink_history_path(path: Path, *, data_root: Path) -> None:
    if is_never_sweep_history_path(path, data_root=data_root):
        raise PermissionError(f"protected heartbeat history path is never sweepable: {path.resolve()}")
    path.unlink()


def archive_raw_completion_bytes(
    *,
    raw: bytes,
    original_path: Path,
    canonical_dir: Path,
    created_at: str,
) -> dict[str, Any]:
    content_sha256 = hashlib.sha256(raw).hexdigest()
    archive_path = canonical_dir / "completion" / "raw" / content_sha256[:2] / f"{content_sha256}.bin"
    _write_immutable(archive_path, raw)
    return {
        "completion_id": original_path.stem,
        "patrol_id": None,
        "event_ids": [],
        "handoff_ids": [],
        "todo_ids": [],
        "batch_keys": [],
        "started_at": "",
        "finished_at": "",
        "status": "unparseable",
        "original_sha256": content_sha256,
        "normalized_sha256": content_sha256,
        "original_path": str(original_path.resolve()),
        "canonical_object_id": f"completion-raw:{content_sha256}",
        "content_sha256": content_sha256,
        "archive_path": str(archive_path.resolve()),
        "byte_offset": 0,
        "byte_length": len(raw),
        "schema_version": "heartbeat.completion-raw/v1",
        "created_at": created_at,
    }


def archive_live_completion(
    *,
    raw: bytes,
    original_path: Path,
    state_db_path: Path | None,
    canonical_dir: Path,
    manifest_dir: Path,
    created_at: str | None = None,
) -> dict[str, Any]:
    archive_created_at = created_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    receipt = json.loads(raw)
    direct_handoffs = _receipt_handoff_ids(receipt)
    manifest = archive_completion_bytes(
        raw=raw,
        original_path=original_path,
        canonical_dir=canonical_dir,
        handoff_ids=direct_handoffs,
        created_at=archive_created_at,
    )
    if state_db_path is not None and manifest.get("patrol_id"):
        connection = sqlite3.connect(f"file:{state_db_path.resolve()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            associations = _completion_associations(
                connection=connection,
                patrol_ids={str(manifest["patrol_id"])},
            ).get(str(manifest["patrol_id"])) or {}
        finally:
            connection.close()
        manifest["event_ids"] = associations.get("event_ids", [])
        manifest["handoff_ids"] = sorted(
            set(manifest["handoff_ids"]) | set(associations.get("handoff_ids") or [])
        )
        manifest["todo_ids"] = associations.get("todo_ids", [])
        manifest["batch_keys"] = associations.get("batch_keys", [])
    reconstruct_completion_bytes(manifest)
    finished_at = str(manifest.get("finished_at") or archive_created_at)
    day = archive_created_at[:10]
    if manifest_dir.name != "live" and len(finished_at) >= 10:
        day = finished_at[:10]
    manifest_path = manifest_dir / "completion" / day[:7] / f"completion-{day}.jsonl"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = manifest_path.with_suffix(".lock")
    line = _json_bytes(manifest)
    with lock_path.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        with manifest_path.open("ab") as output:
            offset = output.tell()
            output.write(line)
            output.flush()
            os.fsync(output.fileno())
    result = {
        **manifest,
        "manifest_path": str(manifest_path.resolve()),
        "manifest_byte_offset": offset,
        "manifest_byte_length": len(line),
    }
    if manifest_dir.name == "live" and os.environ.get("HEARTBEAT_STORAGE_RETENTION_APPLY", "0") == "1":
        cutoff = (datetime.fromisoformat(archive_created_at) - timedelta(days=2)).date().isoformat()
        compact_closed_live_manifests(
            manifest_root=manifest_dir,
            before_day=cutoff,
            apply=True,
            data_root=manifest_dir.parents[1],
        )
    return result


def export_state_history(
    *,
    state_db_path: Path,
    canonical_dir: Path,
    created_at: str | None = None,
) -> dict[str, Any]:
    """Append immutable incremental snapshots for the four TTL-sensitive owner tables."""
    exported_at = created_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    state_dir = canonical_dir / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "export.lock"
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("state history export already running") from exc
        index_path = state_dir / "history-index.json"
        index = _load_history_index(index_path)
        table_receipts: dict[str, dict[str, Any]] = {}
        next_watermarks = dict(index.get("watermarks") or {})
        connection = sqlite3.connect(f"file:{state_db_path.resolve()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            for table, (primary_key, timestamp_expression) in _STATE_TABLES.items():
                previous = next_watermarks.get(table) or {}
                receipt, watermark = _export_table_segment(
                    connection=connection,
                    state_dir=state_dir,
                    table=table,
                    primary_key=primary_key,
                    timestamp_expression=timestamp_expression,
                    previous_timestamp=str(previous.get("timestamp") or ""),
                    previous_primary_key=str(previous.get("primary_key") or ""),
                    exported_at=exported_at,
                )
                table_receipts[table] = receipt
                if watermark is not None:
                    next_watermarks[table] = watermark
        finally:
            connection.close()

        next_index = {
            "schema_version": STATE_HISTORY_SCHEMA_VERSION,
            "updated_at": exported_at,
            "watermarks": next_watermarks,
        }
        _atomic_write(index_path, _json_bytes(next_index))
    return {
        "schema_version": STATE_HISTORY_SCHEMA_VERSION,
        "created_at": exported_at,
        "tables": table_receipts,
        "index_path": str(index_path.resolve()),
    }


def index_trigger_log(
    *,
    log_path: Path,
    valid_patrol_ids: set[str],
    pack: CanonicalPackWriter,
    created_at: str,
):
    log_sha256 = _file_sha256(log_path)
    offset = 0
    with log_path.open("rb") as source:
        for line_number, raw_line in enumerate(source, start=1):
            content_sha256 = hashlib.sha256(raw_line).hexdigest()
            base = {
                "path": str(log_path.resolve()),
                "line_number": line_number,
                "original_byte_offset": offset,
                "original_byte_length": len(raw_line),
                "original_sha256": content_sha256,
                "log_sha256": log_sha256,
                "created_at": created_at,
            }
            offset += len(raw_line)
            try:
                payload = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                yield {**base, "disposition": "retained_raw_non_json", "patrol_id": None}
                continue
            patrol_id = _trigger_patrol_id(payload)
            if not patrol_id or patrol_id not in valid_patrol_ids:
                yield {**base, "disposition": "retained_raw_unassociated", "patrol_id": patrol_id}
                continue
            yield {
                **base,
                "disposition": "pointerized",
                "patrol_id": patrol_id,
                **pack.add(raw_line, object_prefix="trigger-json"),
            }


def pointerize_trigger_payload(
    *,
    payload: dict[str, Any],
    state_db_path: Path,
    canonical_dir: Path,
    original_log_path: Path,
    created_at: str | None = None,
) -> dict[str, Any]:
    patrol_id = _trigger_patrol_id(payload)
    if not patrol_id:
        return payload
    with sqlite3.connect(f"file:{state_db_path.resolve()}?mode=ro", uri=True) as connection:
        exists = connection.execute("SELECT 1 FROM patrol_runs WHERE patrol_id = ?", (patrol_id,)).fetchone()
    if exists is None:
        return payload
    pointer_created_at = created_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    raw = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    content_sha256 = hashlib.sha256(raw).hexdigest()
    archive_path = canonical_dir / "trigger" / "objects" / content_sha256[:2] / f"{content_sha256}.json"
    _write_immutable(archive_path, raw)
    return {
        "schema": "heartbeat.trigger-pointer/v1",
        "disposition": "pointerized",
        "source_log_path": str(original_log_path.resolve()),
        "patrol_id": patrol_id,
        "canonical_object_id": f"trigger-json:{content_sha256}",
        "content_sha256": content_sha256,
        "archive_path": str(archive_path.resolve()),
        "byte_offset": 0,
        "byte_length": len(raw),
        "schema_version": "heartbeat.trigger-canonical/v1",
        "created_at": pointer_created_at,
    }


def emit_trigger_result(payload: dict[str, Any]) -> None:
    output_payload = payload
    degradation: dict[str, Any] | None = None
    if os.environ.get("HEARTBEAT_TRIGGER_POINTER_MODE") == "1":
        workspace = Path(__file__).resolve().parents[1]
        state_db_path = Path(os.environ.get("HEARTBEAT_STATE_DB", str(workspace / "data" / "heartbeat.sqlite")))
        canonical_dir = Path(
            os.environ.get("HEARTBEAT_HISTORY_CANONICAL_DIR", str(workspace / "data" / "history-canonical"))
        )
        source_log = Path(
            os.environ.get("HEARTBEAT_TRIGGER_ORIGINAL_LOG_PATH", str(workspace / "data" / "enqueue-triggers" / "unknown.log"))
        )
        try:
            output_payload = pointerize_trigger_payload(
                payload=payload,
                state_db_path=state_db_path,
                canonical_dir=canonical_dir,
                original_log_path=source_log,
            )
        except Exception as exc:
            # Canonical archiving is optional; the raw trigger line is the audit record.
            output_payload = payload
            degradation = {
                "schema": "heartbeat.trigger-pointer-degraded/v1",
                "event": "trigger_pointerize_failed",
                "disposition": "retained_raw_pointerize_failed",
                "patrol_id": payload.get("patrol_id") if isinstance(payload, dict) else None,
                "source_log_path": str(source_log),
                "error_type": type(exc).__name__,
                "error": str(exc),
                "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
    print(json.dumps(output_payload, ensure_ascii=False, sort_keys=True))
    if degradation is not None:
        print(json.dumps(degradation, ensure_ascii=False, sort_keys=True), file=sys.stderr, flush=True)


def run_dry_run_migration(
    *,
    state_db_path: Path,
    completion_dir: Path,
    trigger_dir: Path,
    canonical_dir: Path,
    manifest_dir: Path,
    samples_path: Path,
    report_path: Path,
    created_at: str | None = None,
) -> dict[str, Any]:
    migration_created_at = created_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    canonical_dir.mkdir(parents=True, exist_ok=True)
    manifest_dir.mkdir(parents=True, exist_ok=True)
    quick_check = _sqlite_quick_check(state_db_path)
    if quick_check != "ok":
        raise RuntimeError(f"heartbeat.sqlite quick_check failed: {quick_check}")

    state_export = export_state_history(
        state_db_path=state_db_path,
        canonical_dir=canonical_dir,
        created_at=migration_created_at,
    )
    ttl_safe_export = all(
        receipt.get("coverage_complete") is True and _verify_segment_receipt(receipt)
        for receipt in state_export["tables"].values()
    )
    if not ttl_safe_export:
        raise RuntimeError("immutable state history export did not cover every source table")

    completion_result = _migrate_completion_receipts(
        state_db_path=state_db_path,
        completion_dir=completion_dir,
        canonical_dir=canonical_dir,
        manifest_dir=manifest_dir,
        samples_path=samples_path,
        created_at=migration_created_at,
    )
    trigger_result = _migrate_trigger_logs(
        state_db_path=state_db_path,
        trigger_dir=trigger_dir,
        canonical_dir=canonical_dir,
        manifest_dir=manifest_dir,
        created_at=migration_created_at,
    )
    report = {
        "schema_version": "heartbeat.history-dry-run/v1",
        "created_at": migration_created_at,
        "state_db_path": str(state_db_path.resolve()),
        "sqlite_quick_check": quick_check,
        "ttl_safe_export": ttl_safe_export,
        "state_export": state_export,
        "completion": completion_result,
        "trigger": trigger_result,
        "production_files_deleted": 0,
        "canonical_dir": str(canonical_dir.resolve()),
        "manifest_dir": str(manifest_dir.resolve()),
        "samples_path": str(samples_path.resolve()),
    }
    _atomic_write(report_path, _json_bytes(report))
    return report


def verify_dry_run_artifacts(*, manifest_dir: Path, trigger_sample_count: int = 200) -> dict[str, Any]:
    """Fail closed unless the dry-run indexes and their source/canonical bytes rebuild."""
    if trigger_sample_count <= 0:
        raise ValueError("trigger_sample_count must be positive")
    completion_path = manifest_dir / "completion-manifest.jsonl"
    completion_segment = json.loads((manifest_dir / "completion-manifest.segment.json").read_text())
    completion_digest = hashlib.sha256()
    completion_rows = 0
    completion_source_exact = 0
    completion_canonical_exact = 0
    with completion_path.open("rb") as source:
        for line in source:
            completion_digest.update(line)
            completion_rows += 1
            manifest = json.loads(line)
            original_path = Path(str(manifest["original_path"]))
            if original_path.is_file() and _file_sha256(original_path) == str(manifest["original_sha256"]):
                completion_source_exact += 1
            rebuilt = reconstruct_completion_bytes(manifest)
            if hashlib.sha256(rebuilt).hexdigest() == str(manifest["original_sha256"]):
                completion_canonical_exact += 1

    trigger_path = manifest_dir / "trigger-manifest.jsonl"
    trigger_segment = json.loads((manifest_dir / "trigger-manifest.segment.json").read_text())
    trigger_rows_expected = int(trigger_segment["row_count"])
    sample_total = min(trigger_sample_count, trigger_rows_expected)
    sample_indexes = set(_even_sample_indexes(trigger_rows_expected, sample_total)) if sample_total else set()
    trigger_digest = hashlib.sha256()
    trigger_rows = 0
    trigger_source_exact = 0
    trigger_pointer_samples = 0
    trigger_pointer_exact = 0
    trigger_sample_passed = 0
    with trigger_path.open("rb") as source:
        for index, line in enumerate(source):
            trigger_digest.update(line)
            trigger_rows += 1
            if index not in sample_indexes:
                continue
            manifest = json.loads(line)
            original_exact = False
            original_path = Path(str(manifest["path"]))
            if original_path.is_file():
                with original_path.open("rb") as original:
                    original.seek(int(manifest["original_byte_offset"]))
                    raw = original.read(int(manifest["original_byte_length"]))
                original_exact = hashlib.sha256(raw).hexdigest() == str(manifest["original_sha256"])
                trigger_source_exact += int(original_exact)
            canonical_exact = False
            if str(manifest.get("disposition")) == "pointerized":
                trigger_pointer_samples += 1
                archive_path = Path(str(manifest["archive_path"]))
                if archive_path.is_file():
                    with archive_path.open("rb") as archive:
                        archive.seek(int(manifest["byte_offset"]))
                        raw = archive.read(int(manifest["byte_length"]))
                    canonical_exact = (
                        hashlib.sha256(raw).hexdigest()
                        == str(manifest["content_sha256"])
                        == str(manifest["original_sha256"])
                    )
                    trigger_pointer_exact += int(canonical_exact)
            trigger_sample_passed += int(original_exact or canonical_exact)

    completion_hash_match = (
        completion_rows == int(completion_segment["row_count"])
        and completion_digest.hexdigest() == str(completion_segment["sha256"])
    )
    trigger_hash_match = (
        trigger_rows == trigger_rows_expected
        and trigger_digest.hexdigest() == str(trigger_segment["sha256"])
    )
    approved = (
        completion_hash_match
        and completion_canonical_exact == completion_rows
        and completion_source_exact == completion_rows
        and trigger_hash_match
        and trigger_sample_passed == sample_total
        and trigger_pointer_exact == trigger_pointer_samples
    )
    return {
        "schema": "heartbeat.dry-run-artifact-verification/v1",
        "approved": approved,
        "completion_manifest_hash_match": completion_hash_match,
        "completion_rows": completion_rows,
        "completion_source_exact": completion_source_exact,
        "completion_canonical_exact": completion_canonical_exact,
        "trigger_manifest_hash_match": trigger_hash_match,
        "trigger_rows": trigger_rows,
        "trigger_samples": sample_total,
        "trigger_source_exact": trigger_source_exact,
        "trigger_pointer_samples": trigger_pointer_samples,
        "trigger_pointer_exact": trigger_pointer_exact,
        "trigger_sample_passed": trigger_sample_passed,
    }


def _migrate_completion_receipts(
    *,
    state_db_path: Path,
    completion_dir: Path,
    canonical_dir: Path,
    manifest_dir: Path,
    samples_path: Path,
    created_at: str,
) -> dict[str, Any]:
    manifest_path = manifest_dir / "completion-manifest.jsonl"
    if manifest_path.exists():
        raise FileExistsError(manifest_path)
    candidates: list[tuple[str, int, int]] = []
    batch: list[dict[str, Any]] = []
    files_scanned = 0
    bytes_scanned = 0
    raw_fallbacks = 0
    unique_canonical_objects: set[str] = set()
    connection = sqlite3.connect(f"file:{state_db_path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    manifest_digest = hashlib.sha256()
    with manifest_path.open("xb") as output:
        try:
            for entry in os.scandir(completion_dir):
                if not entry.is_file(follow_symlinks=False) or not entry.name.endswith(".json") or entry.name == "latest.json":
                    continue
                path = Path(entry.path)
                raw = path.read_bytes()
                files_scanned += 1
                bytes_scanned += len(raw)
                try:
                    receipt = json.loads(raw)
                    direct_handoffs = _receipt_handoff_ids(receipt)
                    manifest = archive_completion_bytes(
                        raw=raw,
                        original_path=path,
                        canonical_dir=canonical_dir,
                        handoff_ids=direct_handoffs,
                        created_at=created_at,
                    )
                    reconstruct_completion_bytes(manifest)
                except (ValueError, KeyError, TypeError, json.JSONDecodeError):
                    manifest = archive_raw_completion_bytes(
                        raw=raw,
                        original_path=path,
                        canonical_dir=canonical_dir,
                        created_at=created_at,
                    )
                    raw_fallbacks += 1
                unique_canonical_objects.add(str(manifest["canonical_object_id"]))
                batch.append(manifest)
                if len(batch) >= 500:
                    _flush_completion_manifest_batch(
                        connection=connection,
                        batch=batch,
                        output=output,
                        digest=manifest_digest,
                        candidates=candidates,
                    )
                    batch.clear()
            if batch:
                _flush_completion_manifest_batch(
                    connection=connection,
                    batch=batch,
                    output=output,
                    digest=manifest_digest,
                    candidates=candidates,
                )
            output.flush()
            os.fsync(output.fileno())
        finally:
            connection.close()
    manifest_segment = _write_segment_receipt(
        path=manifest_path,
        sha256=manifest_digest.hexdigest(),
        row_count=files_scanned,
        content_schema_version="heartbeat.completion-manifest/v1",
        created_at=created_at,
    )
    sample_result = _write_reconstruction_samples(
        manifest_path=manifest_path,
        candidates=candidates,
        samples_path=samples_path,
        created_at=created_at,
    )
    return {
        "files_scanned": files_scanned,
        "bytes_scanned": bytes_scanned,
        "manifests_written": files_scanned,
        "raw_fallbacks": raw_fallbacks,
        "unique_canonical_objects": len(unique_canonical_objects),
        "manifest_path": str(manifest_path.resolve()),
        "manifest_segment": manifest_segment,
        **sample_result,
    }


def _flush_completion_manifest_batch(
    *,
    connection: sqlite3.Connection,
    batch: list[dict[str, Any]],
    output,
    digest: Any,
    candidates: list[tuple[str, int, int]],
) -> None:
    associations = _completion_associations(
        connection=connection,
        patrol_ids={str(item["patrol_id"]) for item in batch if item.get("patrol_id")},
    )
    for manifest in batch:
        patrol_id = str(manifest.get("patrol_id") or "")
        association = associations.get(patrol_id) or {}
        manifest["event_ids"] = association.get("event_ids", [])
        manifest["handoff_ids"] = sorted(
            set(manifest.get("handoff_ids") or []) | set(association.get("handoff_ids") or [])
        )
        manifest["todo_ids"] = association.get("todo_ids", [])
        manifest["batch_keys"] = association.get("batch_keys", [])
        line = _json_bytes(manifest)
        offset = output.tell()
        output.write(line)
        digest.update(line)
        candidates.append((str(manifest.get("finished_at") or ""), offset, len(line)))


def _completion_associations(
    *,
    connection: sqlite3.Connection,
    patrol_ids: set[str],
) -> dict[str, dict[str, list[str]]]:
    result: dict[str, dict[str, list[str]]] = {
        patrol_id: {"event_ids": [], "handoff_ids": [], "todo_ids": [], "batch_keys": []}
        for patrol_id in patrol_ids
    }
    explicit_todos: dict[str, set[str]] = {patrol_id: set() for patrol_id in patrol_ids}
    for patrol_chunk in _chunks(sorted(patrol_ids), 400):
        placeholders = ",".join("?" for _ in patrol_chunk)
        for row in connection.execute(
            f"SELECT event_id, patrol_id, summary, error, injected_message FROM heartbeat_events WHERE patrol_id IN ({placeholders})",
            patrol_chunk,
        ):
            patrol_id = str(row["patrol_id"])
            result[patrol_id]["event_ids"].append(str(row["event_id"]))
            for field in ("summary", "error", "injected_message"):
                explicit_todos[patrol_id].update(_TODO_ID_RE.findall(str(row[field] or "")))
        for row in connection.execute(
            f"SELECT handoff_id, patrol_id FROM unrecovered_escalation_handoffs WHERE patrol_id IN ({placeholders})",
            patrol_chunk,
        ):
            result[str(row["patrol_id"])]["handoff_ids"].append(str(row["handoff_id"]))

    requested_todos = sorted({todo_id for todo_ids in explicit_todos.values() for todo_id in todo_ids})
    todo_batch_by_id: dict[str, str | None] = {}
    valid_todo_ids: set[str] = set()
    for todo_chunk in _chunks(requested_todos, 400):
        placeholders = ",".join("?" for _ in todo_chunk)
        for row in connection.execute(
            f"SELECT todo_id, batch_key FROM session_todos WHERE todo_id IN ({placeholders})",
            todo_chunk,
        ):
            todo_id = str(row["todo_id"])
            valid_todo_ids.add(todo_id)
            todo_batch_by_id[todo_id] = str(row["batch_key"]) if row["batch_key"] else None
    for patrol_id, todo_ids in explicit_todos.items():
        linked = sorted(todo_ids & valid_todo_ids)
        result[patrol_id]["todo_ids"] = linked
        result[patrol_id]["batch_keys"] = sorted(
            {str(todo_batch_by_id[todo_id]) for todo_id in linked if todo_batch_by_id.get(todo_id)}
        )
    for association in result.values():
        association["event_ids"].sort()
        association["handoff_ids"].sort()
    return result


def _write_reconstruction_samples(
    *,
    manifest_path: Path,
    candidates: list[tuple[str, int, int]],
    samples_path: Path,
    created_at: str,
) -> dict[str, Any]:
    if len(candidates) < 60:
        raise RuntimeError(f"at least 60 completion manifests are required, found {len(candidates)}")
    candidates.sort(key=lambda item: (item[0], item[1]))
    third = len(candidates) // 3
    bands = {
        "early": candidates[:third],
        "middle": candidates[third : 2 * third],
        "late": candidates[2 * third :],
    }
    selected: list[tuple[str, tuple[str, int, int]]] = []
    for band, rows in bands.items():
        indexes = _even_sample_indexes(len(rows), 20)
        selected.extend((band, rows[index]) for index in indexes)
    samples: list[dict[str, Any]] = []
    with manifest_path.open("rb") as source:
        for band, (_, offset, length) in selected:
            source.seek(offset)
            manifest = json.loads(source.read(length))
            rebuilt = reconstruct_completion_bytes(manifest)
            rebuilt_sha256 = hashlib.sha256(rebuilt).hexdigest()
            samples.append(
                {
                    "band": band,
                    "completion_id": manifest["completion_id"],
                    "patrol_id": manifest.get("patrol_id"),
                    "finished_at": manifest.get("finished_at"),
                    "original_path": manifest["original_path"],
                    "canonical_object_id": manifest["canonical_object_id"],
                    "content_sha256": manifest["content_sha256"],
                    "archive_path": manifest["archive_path"],
                    "byte_offset": manifest["byte_offset"],
                    "byte_length": manifest["byte_length"],
                    "schema_version": manifest["schema_version"],
                    "original_sha256": manifest["original_sha256"],
                    "reconstructed_sha256": rebuilt_sha256,
                    "hash_match": rebuilt_sha256 == manifest["original_sha256"],
                }
            )
    payload = {
        "schema": "heartbeat.reconstruction-samples/v1",
        "created_at": created_at,
        "sample_rule": "sort by completion finished_at; 20 evenly spaced from each early/middle/late third",
        "sample_total": len(samples),
        "hash_matches": sum(1 for sample in samples if sample["hash_match"]),
        "samples": samples,
    }
    _atomic_write(samples_path, _json_bytes(payload))
    if payload["hash_matches"] != payload["sample_total"]:
        raise RuntimeError("completion reconstruction sample hash mismatch")
    return {
        "reconstruction_sample_total": payload["sample_total"],
        "reconstruction_hash_matches": payload["hash_matches"],
    }


def _migrate_trigger_logs(
    *,
    state_db_path: Path,
    trigger_dir: Path,
    canonical_dir: Path,
    manifest_dir: Path,
    created_at: str,
) -> dict[str, Any]:
    with sqlite3.connect(f"file:{state_db_path.resolve()}?mode=ro", uri=True) as connection:
        valid_patrol_ids = {str(row[0]) for row in connection.execute("SELECT patrol_id FROM patrol_runs")}
    manifest_path = manifest_dir / "trigger-manifest.jsonl"
    segment_name = f"segment-{_path_time(created_at)}-{hashlib.sha256(created_at.encode()).hexdigest()[:12]}.jsonl"
    pack = CanonicalPackWriter(
        archive_path=canonical_dir / "trigger" / "segments" / segment_name,
        schema_version="heartbeat.trigger-canonical/v1",
        created_at=created_at,
    )
    logs_scanned = 0
    lines_scanned = 0
    pointerized = 0
    retained_non_json = 0
    retained_unassociated = 0
    fully_pointerized_logs: list[str] = []
    manifest_digest = hashlib.sha256()
    with manifest_path.open("xb") as output:
        for entry in os.scandir(trigger_dir):
            if not entry.is_file(follow_symlinks=False) or not entry.name.endswith(".log"):
                continue
            logs_scanned += 1
            log_total = 0
            log_pointerized = 0
            for manifest in index_trigger_log(
                log_path=Path(entry.path),
                valid_patrol_ids=valid_patrol_ids,
                pack=pack,
                created_at=created_at,
            ):
                log_total += 1
                lines_scanned += 1
                disposition = manifest["disposition"]
                if disposition == "pointerized":
                    pointerized += 1
                    log_pointerized += 1
                elif disposition == "retained_raw_non_json":
                    retained_non_json += 1
                else:
                    retained_unassociated += 1
                line = _json_bytes(manifest)
                output.write(line)
                manifest_digest.update(line)
            if log_total and log_total == log_pointerized:
                fully_pointerized_logs.append(str(Path(entry.path).resolve()))
        output.flush()
        os.fsync(output.fileno())
    canonical_segment = pack.close()
    manifest_segment = _write_segment_receipt(
        path=manifest_path,
        sha256=manifest_digest.hexdigest(),
        row_count=lines_scanned,
        content_schema_version="heartbeat.trigger-manifest/v1",
        created_at=created_at,
    )
    policy = {
        "schema": "heartbeat.trigger-rotation-policy/v1",
        "created_at": created_at,
        "dry_run": True,
        "compressible_source_segments": fully_pointerized_logs,
        "compression_gate": (
            "A closed source log is compressible only when every line is pointerized, the canonical segment SHA-256 "
            "and every content_sha256 verify, and no non-JSON or unassociated line remains. Mixed logs stay raw."
        ),
        "compressed_readback": (
            "Offsets are defined on the uncompressed byte stream. A compressed segment must be decompressed and "
            "then sliced at byte_offset for byte_length; content_sha256 and canonical_object_id are verified before use."
        ),
        "live_segment_rule": "The current append target is never compressed; rotate it closed before compression.",
    }
    policy_path = manifest_dir / "trigger-rotation-policy.json"
    _atomic_write(policy_path, _json_bytes(policy))
    return {
        "logs_scanned": logs_scanned,
        "lines_scanned": lines_scanned,
        "pointerized": pointerized,
        "retained_raw_non_json": retained_non_json,
        "retained_raw_unassociated": retained_unassociated,
        "fully_pointerized_logs": len(fully_pointerized_logs),
        "manifest_path": str(manifest_path.resolve()),
        "manifest_segment": manifest_segment,
        "canonical_segment": canonical_segment,
        "rotation_policy": str(policy_path.resolve()),
    }


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def _export_table_segment(
    *,
    connection: sqlite3.Connection,
    state_dir: Path,
    table: str,
    primary_key: str,
    timestamp_expression: str,
    previous_timestamp: str,
    previous_primary_key: str,
    exported_at: str,
) -> tuple[dict[str, Any], dict[str, str] | None]:
    table_dir = state_dir / table / exported_at[:7]
    table_dir.mkdir(parents=True, exist_ok=True)
    temporary = table_dir / f".segment-{os.getpid()}.tmp"
    digest = hashlib.sha256()
    row_count = 0
    first_timestamp = ""
    last_timestamp = previous_timestamp
    last_primary_key = previous_primary_key
    query = f"""
        SELECT *, {timestamp_expression} AS __history_timestamp
        FROM {table}
        WHERE ({timestamp_expression} > ?)
           OR ({timestamp_expression} = ? AND {primary_key} > ?)
        ORDER BY {timestamp_expression} ASC, {primary_key} ASC
    """
    source_row_count = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    try:
        with temporary.open("xb") as output:
            for sqlite_row in connection.execute(query, (previous_timestamp, previous_timestamp, previous_primary_key)):
                row = dict(sqlite_row)
                row_timestamp = str(row.pop("__history_timestamp") or "")
                row_primary_key = str(row[primary_key])
                row_bytes = _canonical_json(row)
                row_sha256 = hashlib.sha256(row_bytes).hexdigest()
                record = {
                    "canonical_object_id": f"{table}:{row_primary_key}:{row_sha256}",
                    "content_sha256": row_sha256,
                    "created_at": exported_at,
                    "primary_key": row_primary_key,
                    "recorded_at": row_timestamp,
                    "row": row,
                    "schema_version": STATE_HISTORY_SCHEMA_VERSION,
                    "table": table,
                }
                line = _json_bytes(record)
                output.write(line)
                digest.update(line)
                row_count += 1
                first_timestamp = first_timestamp or row_timestamp
                last_timestamp = row_timestamp
                last_primary_key = row_primary_key
            output.flush()
            os.fsync(output.fileno())
        if row_count == 0:
            temporary.unlink()
            return (
                {
                    "schema_version": STATE_SEGMENT_SCHEMA_VERSION,
                    "table": table,
                    "row_count": 0,
                    "period_start": previous_timestamp or None,
                    "period_end": previous_timestamp or None,
                    "sha256": None,
                    "archive_path": None,
                    "source_row_count": source_row_count,
                    "coverage_complete": bool(previous_timestamp) or source_row_count == 0,
                },
                None,
            )
        segment_sha256 = digest.hexdigest()
        segment_path = table_dir / f"segment-{_path_time(first_timestamp)}-{_path_time(last_timestamp)}-{segment_sha256[:16]}.jsonl"
        try:
            if segment_path.exists():
                if _file_sha256(segment_path) != segment_sha256:
                    raise RuntimeError(f"immutable state segment collision: {segment_path}")
                temporary.unlink()
            else:
                os.replace(temporary, segment_path)
        except OSError:
            if temporary.exists():
                temporary.unlink()
            raise
        segment_receipt = {
            "schema_version": STATE_SEGMENT_SCHEMA_VERSION,
            "table": table,
            "row_count": row_count,
            "period_start": first_timestamp,
            "period_end": last_timestamp,
            "sha256": segment_sha256,
            "archive_path": str(segment_path.resolve()),
            "byte_length": segment_path.stat().st_size,
            "created_at": exported_at,
            "source_row_count": source_row_count,
            "coverage_complete": bool(previous_timestamp) or row_count == source_row_count,
        }
        receipt_path = segment_path.with_suffix(".segment.json")
        _write_immutable(receipt_path, _json_bytes(segment_receipt))
        return segment_receipt, {"timestamp": last_timestamp, "primary_key": last_primary_key}
    finally:
        if temporary.exists():
            temporary.unlink()


def _load_history_index(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": STATE_HISTORY_SCHEMA_VERSION, "watermarks": {}}
    value = json.loads(path.read_text())
    if value.get("schema_version") != STATE_HISTORY_SCHEMA_VERSION:
        raise ValueError(f"unsupported state history index schema: {value.get('schema_version')}")
    return value


def _trigger_patrol_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    patrol_id = payload.get("patrol_id")
    if patrol_id:
        return str(patrol_id)
    completion = payload.get("completion")
    if not isinstance(completion, dict) or not completion.get("path"):
        return None
    try:
        receipt = json.loads(Path(str(completion["path"])).read_text())
    except (OSError, json.JSONDecodeError):
        return None
    run = receipt.get("run") if isinstance(receipt, dict) else None
    if not isinstance(run, dict) or not run.get("patrol_id"):
        return None
    return str(run["patrol_id"])


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _receipt_handoff_ids(receipt: Any) -> list[str]:
    if not isinstance(receipt, dict):
        return []
    handoffs = receipt.get("escalation_handoffs")
    recent = handoffs.get("recent") if isinstance(handoffs, dict) else None
    if not isinstance(recent, list):
        return []
    return sorted(
        {
            str(item["handoff_id"])
            for item in recent
            if isinstance(item, dict) and item.get("handoff_id")
        }
    )


def _chunks(values: list[str], size: int):
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _even_sample_indexes(length: int, count: int) -> list[int]:
    if length < count:
        raise ValueError(f"cannot sample {count} unique rows from {length}")
    if count == 1:
        return [length // 2]
    return [(index * (length - 1)) // (count - 1) for index in range(count)]


def _write_segment_receipt(
    *,
    path: Path,
    sha256: str,
    row_count: int,
    content_schema_version: str,
    created_at: str,
) -> dict[str, Any]:
    actual_sha256 = _file_sha256(path)
    if actual_sha256 != sha256:
        raise RuntimeError(f"segment hash mismatch: {path}")
    receipt = {
        "schema_version": "heartbeat.canonical-segment/v1",
        "content_schema_version": content_schema_version,
        "archive_path": str(path.resolve()),
        "sha256": sha256,
        "byte_length": path.stat().st_size,
        "row_count": row_count,
        "created_at": created_at,
    }
    _write_immutable(path.with_suffix(".segment.json"), _json_bytes(receipt))
    return receipt


def _verify_segment_receipt(receipt: dict[str, Any]) -> bool:
    path_value = receipt.get("archive_path")
    if not path_value:
        return int(receipt.get("row_count") or 0) == 0 and receipt.get("coverage_complete") is True
    path = Path(str(path_value))
    return path.is_file() and _file_sha256(path) == str(receipt.get("sha256") or "")


def _sqlite_quick_check(path: Path) -> str:
    with sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True) as connection:
        row = connection.execute("PRAGMA quick_check").fetchone()
    return str(row[0]) if row else "missing"


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Export immutable heartbeat history without deleting production files.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    migrate = subparsers.add_parser("migrate-dry-run")
    migrate.add_argument("--state-db", type=Path, required=True)
    migrate.add_argument("--completion-dir", type=Path, required=True)
    migrate.add_argument("--trigger-dir", type=Path, required=True)
    migrate.add_argument("--canonical-dir", type=Path, required=True)
    migrate.add_argument("--manifest-dir", type=Path, required=True)
    migrate.add_argument("--samples-path", type=Path, required=True)
    migrate.add_argument("--report-path", type=Path, required=True)
    verify = subparsers.add_parser("verify-dry-run")
    verify.add_argument("--manifest-dir", type=Path, required=True)
    verify.add_argument("--trigger-samples", type=int, default=200)
    args = parser.parse_args(argv)
    if args.command == "migrate-dry-run":
        report = run_dry_run_migration(
            state_db_path=args.state_db,
            completion_dir=args.completion_dir,
            trigger_dir=args.trigger_dir,
            canonical_dir=args.canonical_dir,
            manifest_dir=args.manifest_dir,
            samples_path=args.samples_path,
            report_path=args.report_path,
        )
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0
    if args.command == "verify-dry-run":
        report = verify_dry_run_artifacts(
            manifest_dir=args.manifest_dir,
            trigger_sample_count=args.trigger_samples,
        )
        print(json.dumps(report, ensure_ascii=False, sort_keys=True))
        return 0 if report["approved"] else 1
    raise AssertionError(args.command)


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _path_time(value: str) -> str:
    return "".join(character for character in value if character.isalnum())[:20] or "unknown"


def _optional_text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _write_immutable(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    except FileExistsError:
        if path.read_bytes() != content:
            raise RuntimeError(f"immutable canonical object collision: {path}")


def _atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == "__main__":
    sys.exit(_main())
