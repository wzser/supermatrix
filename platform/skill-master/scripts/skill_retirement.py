#!/usr/bin/env python3
"""Core contracts for the skill retirement tombstone lifecycle."""

from __future__ import annotations

import json
import fcntl
import hashlib
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


ALLOWED_STATES = {"tombstone", "restore_requested", "purged"}
RESOLVED_REQUEST_EVENTS = {"resolved", "rejected"}
ROOT = Path(__file__).resolve().parents[1]
REPORTER = ROOT / "scripts" / "report-retired-skill-hit.py"


class RegistryError(ValueError):
    """The versioned retirement registry is invalid."""


class LedgerError(ValueError):
    """An append-only retirement ledger cannot be trusted."""


@dataclass(frozen=True)
class RetirementEntry:
    retirement_id: str
    name: str
    owner: str
    state: str
    retired_at: datetime
    grace_days: int
    owner_acknowledged: bool
    replacement: str
    primary_tombstone_path: Path | None
    secondary_marker_paths: tuple[Path, ...]
    discovery_links: tuple[dict[str, str], ...]
    expected_sha256: dict[str, str]
    allowed_source_skill_paths: tuple[Path, ...]
    recovery: dict[str, Any]
    active_same_name: bool


def parse_time(value: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("timestamp must be a non-empty string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp must include timezone: {value}")
    return parsed.astimezone(timezone.utc)


def format_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _required_text(raw: dict[str, Any], field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise RegistryError(f"{field} must be a non-empty string")
    return value.strip()


def parse_entry(raw: dict[str, Any]) -> RetirementEntry:
    if not isinstance(raw, dict):
        raise RegistryError("retirement entry must be an object")
    retirement_id = _required_text(raw, "retirement_id")
    name = _required_text(raw, "name")
    owner = _required_text(raw, "owner")
    state = _required_text(raw, "state")
    if state not in ALLOWED_STATES:
        raise RegistryError(f"invalid state for {name}: {state}")
    grace_days = raw.get("grace_days")
    if grace_days != 30:
        raise RegistryError(f"grace_days must be exactly 30 for {name}")
    acknowledged = raw.get("owner_acknowledged")
    if not isinstance(acknowledged, bool):
        raise RegistryError(f"owner_acknowledged must be boolean for {name}")
    try:
        retired_at = parse_time(_required_text(raw, "retired_at"))
    except ValueError as exc:
        raise RegistryError(f"invalid retired_at for {name}: {exc}") from exc
    primary_raw = raw.get("primary_tombstone_path")
    if primary_raw is not None and (not isinstance(primary_raw, str) or not primary_raw):
        raise RegistryError(f"primary_tombstone_path must be a path or null for {name}")
    secondary_raw = raw.get("secondary_marker_paths", [])
    links_raw = raw.get("discovery_links", [])
    expected_raw = raw.get("expected_sha256", {})
    allowed_sources_raw = raw.get("allowed_source_skill_paths", [])
    if not isinstance(secondary_raw, list) or not all(isinstance(item, str) and item for item in secondary_raw):
        raise RegistryError(f"secondary_marker_paths must be path strings for {name}")
    if not isinstance(links_raw, list):
        raise RegistryError(f"discovery_links must be a list for {name}")
    if not isinstance(expected_raw, dict) or not all(
        isinstance(path, str) and path and isinstance(digest, str) and len(digest) == 64
        for path, digest in expected_raw.items()
    ):
        raise RegistryError(f"expected_sha256 must map paths to SHA-256 digests for {name}")
    if not isinstance(allowed_sources_raw, list) or not all(
        isinstance(item, str) and item for item in allowed_sources_raw
    ):
        raise RegistryError(f"allowed_source_skill_paths must be path strings for {name}")
    links: list[dict[str, str]] = []
    for link in links_raw:
        if not isinstance(link, dict):
            raise RegistryError(f"discovery link must be an object for {name}")
        path = link.get("path")
        target = link.get("target")
        if not isinstance(path, str) or not path or not isinstance(target, str) or not target:
            raise RegistryError(f"discovery link requires path and target for {name}")
        links.append({"path": path, "target": target})
    recovery = raw.get("recovery", {})
    if not isinstance(recovery, dict) or not isinstance(recovery.get("status"), str):
        raise RegistryError(f"recovery must include status for {name}")
    active_same_name = raw.get("active_same_name", False)
    if not isinstance(active_same_name, bool):
        raise RegistryError(f"active_same_name must be boolean for {name}")
    if active_same_name and primary_raw is not None:
        raise RegistryError(f"active same-name cleanup cannot have a primary tombstone: {name}")
    if not active_same_name and state != "purged" and primary_raw is None:
        raise RegistryError(f"primary_tombstone_path required for retired skill {name}")
    return RetirementEntry(
        retirement_id=retirement_id,
        name=name,
        owner=owner,
        state=state,
        retired_at=retired_at,
        grace_days=grace_days,
        owner_acknowledged=acknowledged,
        replacement=_required_text(raw, "replacement"),
        primary_tombstone_path=Path(primary_raw).expanduser() if primary_raw else None,
        secondary_marker_paths=tuple(Path(item).expanduser() for item in secondary_raw),
        discovery_links=tuple(links),
        expected_sha256=dict(expected_raw),
        allowed_source_skill_paths=tuple(Path(item).expanduser() for item in allowed_sources_raw),
        recovery=dict(recovery),
        active_same_name=active_same_name,
    )


def load_registry(path: Path) -> list[RetirementEntry]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RegistryError(f"cannot read retirement registry {path}: {exc}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != 2:
        raise RegistryError("retirement registry schema_version must be 2")
    raw_entries = payload.get("retirements")
    if not isinstance(raw_entries, list):
        raise RegistryError("retirements must be a list")
    entries = [parse_entry(raw) for raw in raw_entries]
    ids = [entry.retirement_id for entry in entries]
    names = [entry.name for entry in entries]
    if len(ids) != len(set(ids)):
        raise RegistryError("retirement_id values must be unique")
    if len(names) != len(set(names)):
        raise RegistryError("retirement names must be unique")
    return entries


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise LedgerError(f"cannot read ledger {path}: {exc}") from exc
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise LedgerError(f"invalid JSON at {path}:{line_number}: {exc}") from exc
        if not isinstance(record, dict):
            raise LedgerError(f"ledger record must be an object at {path}:{line_number}")
        try:
            _required_event_time(record)
        except ValueError as exc:
            raise LedgerError(f"invalid event at {path}:{line_number}: {exc}") from exc
        records.append(record)
    return records


def _required_event_time(event: dict[str, Any]) -> datetime:
    retirement_id = event.get("retirement_id")
    if not isinstance(retirement_id, str) or not retirement_id:
        raise ValueError("retirement_id is required")
    return parse_time(event.get("at"))


def _events_for(entry: RetirementEntry, events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event.get("retirement_id") == entry.retirement_id]


def unresolved_request_ids(entry: RetirementEntry, requests: Iterable[dict[str, Any]]) -> list[str]:
    latest: dict[str, tuple[datetime, str]] = {}
    for event in _events_for(entry, requests):
        request_id = event.get("request_id")
        event_name = event.get("event")
        if not isinstance(request_id, str) or not request_id:
            raise LedgerError(f"restore request missing request_id for {entry.name}")
        if not isinstance(event_name, str) or not event_name:
            raise LedgerError(f"restore request missing event for {entry.name}")
        timestamp = _required_event_time(event)
        prior = latest.get(request_id)
        if prior is None or timestamp >= prior[0]:
            latest[request_id] = (timestamp, event_name)
    return sorted(
        request_id
        for request_id, (_, event_name) in latest.items()
        if event_name not in RESOLVED_REQUEST_EVENTS
    )


def quiet_since(
    entry: RetirementEntry,
    hits: Iterable[dict[str, Any]],
    requests: Iterable[dict[str, Any]],
) -> datetime:
    candidates = [entry.retired_at]
    candidates.extend(_required_event_time(event) for event in _events_for(entry, hits))
    candidates.extend(_required_event_time(event) for event in _events_for(entry, requests))
    return max(candidates)


def evaluate_entry(
    entry: RetirementEntry,
    hits: Iterable[dict[str, Any]],
    requests: Iterable[dict[str, Any]],
    now: datetime,
) -> dict[str, Any]:
    normalized_now = now.astimezone(timezone.utc)
    hit_records = list(hits)
    request_records = list(requests)
    quiet = quiet_since(entry, hit_records, request_records)
    purge_after = quiet + timedelta(days=entry.grace_days)
    blockers: list[str] = []
    if entry.state == "purged":
        blockers.append("already_purged")
    if normalized_now < purge_after:
        blockers.append("quiet_period_not_elapsed")
    unresolved = unresolved_request_ids(entry, request_records)
    if unresolved:
        blockers.append("unresolved_restore_request")
    if not entry.owner_acknowledged:
        blockers.append("owner_ack_missing")
    if entry.active_same_name:
        blockers.append("active_same_name")
    return {
        "retirement_id": entry.retirement_id,
        "name": entry.name,
        "state": entry.state,
        "quiet_since": format_time(quiet),
        "purge_after": format_time(purge_after),
        "unresolved_request_ids": unresolved,
        "blockers": blockers,
        "purge_ready": not blockers,
    }


def render_tombstone(entry: RetirementEntry) -> str:
    if entry.primary_tombstone_path is None:
        raise RegistryError(f"primary tombstone is unavailable for {entry.name}")
    return (
        "---\n"
        f"name: {entry.name}\n"
        "description: RETIRED — do not use this skill; report legitimate demand to skill-master.\n"
        "---\n"
        f"<!-- skill-master-retirement: {entry.retirement_id} -->\n\n"
        "# Retired\n\n"
        f"Retired at: {format_time(entry.retired_at)}\n\n"
        "Quiet-period target: 30 days after the most recent hit or restore request.\n\n"
        f"Replacement: {entry.replacement}\n\n"
        "## Required action\n\n"
        "1. Report this hit before doing anything else. Replace `<current reason>` with the caller's actual need:\n\n"
        "   ```bash\n"
        f"   python3 {REPORTER} --retirement-id {entry.retirement_id} --skill {entry.name} "
        "--session \"${SM_SESSION_NAME:-unknown}\" --reason \"<current reason>\"\n"
        "   ```\n\n"
        "2. Tell the caller that this skill is retired and provide the replacement route above.\n"
        "3. Stop. Do not execute, reconstruct, or copy the retired logic.\n\n"
        "If reporting fails, tell the caller to contact `skill-master`, then stop.\n"
    )


def render_secondary_marker(entry: RetirementEntry) -> str:
    primary = str(entry.primary_tombstone_path) if entry.primary_tombstone_path else "none (active same-name skill remains canonical)"
    return (
        "# Retired Skill Copy\n\n"
        f"Retirement ID: `{entry.retirement_id}`\n\n"
        f"Skill name: `{entry.name}`\n\n"
        f"Retired at: `{format_time(entry.retired_at)}`\n\n"
        f"Replacement: {entry.replacement}\n\n"
        f"Primary tombstone: `{primary}`\n\n"
        "This location is intentionally not a `SKILL.md` and is not discoverable. "
        "Contact `skill-master` if restoration is required.\n"
    )


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def expected_hashes(entry: RetirementEntry) -> dict[str, str]:
    desired: dict[Path, str] = {}
    if entry.primary_tombstone_path is not None:
        desired[entry.primary_tombstone_path] = render_tombstone(entry)
    marker = render_secondary_marker(entry)
    desired.update({path: marker for path in entry.secondary_marker_paths})
    return {str(path): sha256_text(text) for path, text in desired.items()}


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, 0o644)
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _path_exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()


def deploy_entry(entry: RetirementEntry, *, apply: bool) -> dict[str, Any]:
    desired_files: dict[Path, str] = {}
    if entry.primary_tombstone_path is not None:
        desired_files[entry.primary_tombstone_path] = render_tombstone(entry)
    marker_text = render_secondary_marker(entry)
    desired_files.update({path: marker_text for path in entry.secondary_marker_paths})
    hashes = expected_hashes(entry)
    blockers: list[str] = []
    conflicts: list[str] = []
    if entry.expected_sha256 and entry.expected_sha256 != hashes:
        return {
            "retirement_id": entry.retirement_id,
            "name": entry.name,
            "status": "blocked",
            "blockers": ["registry_hash_mismatch"],
            "conflicts": [],
            "primary_written": False,
            "hashes": hashes,
        }
    for path, expected_text in desired_files.items():
        if not _path_exists(path):
            continue
        if path.is_file() and not path.is_symlink():
            try:
                if path.read_text(encoding="utf-8") == expected_text:
                    continue
            except (OSError, UnicodeDecodeError):
                pass
        conflicts.append(str(path))
    for link in entry.discovery_links:
        path = Path(link["path"]).expanduser()
        target = link["target"]
        if not _path_exists(path):
            continue
        if path.is_symlink() and os.readlink(path) == target:
            continue
        conflicts.append(str(path))
    if conflicts:
        blockers.append("deployment_path_conflict")
        return {
            "retirement_id": entry.retirement_id,
            "name": entry.name,
            "status": "blocked",
            "blockers": blockers,
            "conflicts": sorted(conflicts),
            "primary_written": False,
            "hashes": hashes,
        }
    if not apply:
        return {
            "retirement_id": entry.retirement_id,
            "name": entry.name,
            "status": "dry_run",
            "blockers": [],
            "conflicts": [],
            "primary_written": False,
            "hashes": hashes,
            "files": sorted(str(path) for path in desired_files),
            "links": [dict(link) for link in entry.discovery_links],
        }
    for path, text in desired_files.items():
        if not path.exists():
            _atomic_write_text(path, text)
    for link in entry.discovery_links:
        path = Path(link["path"]).expanduser()
        target = link["target"]
        if not _path_exists(path):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target, target_is_directory=True)
    return {
        "retirement_id": entry.retirement_id,
        "name": entry.name,
        "status": "deployed",
        "blockers": [],
        "conflicts": [],
        "primary_written": entry.primary_tombstone_path is not None,
        "hashes": hashes,
        "files": sorted(str(path) for path in desired_files),
        "links": [dict(link) for link in entry.discovery_links],
    }


def verify_materialized_entry(entry: RetirementEntry) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    desired_hashes = expected_hashes(entry)
    for path_text, rendered_digest in desired_hashes.items():
        path = Path(path_text)
        registered_digest = entry.expected_sha256.get(path_text)
        if registered_digest is None:
            findings.append({"code": "retirement_hash_missing", "path": path_text})
            continue
        if registered_digest != rendered_digest:
            findings.append({"code": "registry_hash_mismatch", "path": path_text})
            continue
        if not path.is_file() or path.is_symlink():
            findings.append({"code": "retirement_file_missing", "path": path_text})
            continue
        try:
            actual_digest = sha256_file(path)
        except OSError:
            findings.append({"code": "retirement_file_unreadable", "path": path_text})
            continue
        if actual_digest != registered_digest:
            findings.append({"code": "retirement_content_changed", "path": path_text})
    extra_hash_paths = set(entry.expected_sha256) - set(desired_hashes)
    for path_text in sorted(extra_hash_paths):
        findings.append({"code": "retirement_hash_unregistered_path", "path": path_text})
    for link in entry.discovery_links:
        path = Path(link["path"]).expanduser()
        if not path.is_symlink():
            code = "retirement_link_changed" if _path_exists(path) else "retirement_link_missing"
            findings.append({"code": code, "path": str(path)})
            continue
        try:
            actual_target = os.readlink(path)
        except OSError:
            findings.append({"code": "retirement_link_unreadable", "path": str(path)})
            continue
        if actual_target != link["target"]:
            findings.append({"code": "retirement_link_changed", "path": str(path)})
    return findings


def purge_entry(
    entry: RetirementEntry,
    hits: Iterable[dict[str, Any]],
    requests: Iterable[dict[str, Any]],
    now: datetime,
    *,
    apply: bool,
) -> dict[str, Any]:
    decision = evaluate_entry(entry, hits, requests, now)
    integrity_findings = verify_materialized_entry(entry)
    blockers = list(decision["blockers"])
    blockers.extend(
        finding["code"] for finding in integrity_findings if finding["code"] not in blockers
    )
    result = {
        **decision,
        "status": "blocked" if blockers else ("eligible" if not apply else "purged"),
        "blockers": blockers,
        "integrity_findings": integrity_findings,
        "removed": [],
    }
    if blockers or not apply:
        result["purge_ready"] = not blockers
        return result

    # Repeat the complete preflight immediately before the first mutation.
    second_preflight = verify_materialized_entry(entry)
    if second_preflight:
        result["status"] = "blocked"
        result["purge_ready"] = False
        result["integrity_findings"] = second_preflight
        result["blockers"] = list(dict.fromkeys(item["code"] for item in second_preflight))
        return result

    registered_paths = [Path(link["path"]).expanduser() for link in entry.discovery_links]
    if entry.primary_tombstone_path is not None:
        registered_paths.append(entry.primary_tombstone_path)
    registered_paths.extend(entry.secondary_marker_paths)
    for path in registered_paths:
        path.unlink()
        result["removed"].append(str(path))
    return result


def append_jsonl_locked(path: Path, event: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
