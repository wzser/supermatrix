"""Bounded, resumable full-snapshot writes for the approved quote tables.

This module is deliberately an owner-side queue mechanism.  It does not know
anything about quote parsing or source files; the caller supplies the complete
latest row set and an explicit deletion scope.  The queue keeps the remote
prefetch, plan, in-flight slice and delete cursor durable so a worker crash can
only lead to read-only reconciliation, never to replaying an uncertain write.
"""

from __future__ import annotations

import json
import fcntl
import hashlib
import time
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .bitable import (
    _CREATE_BATCH,
    _field_types,
    _group_records_by_key,
    _lark_records_from_list,
    _live_field_ids,
    _records_get_by_ids,
    _record_key,
    _table_id,
    _wire_write_fields,
    _write_fields_match,
    _bulk_update_same_patch_records,
    _select_values_for_preflight,
    bitable_upsert_plan,
    check_controlled_rows_replace,
)
from .sync_queue import (
    get_logical_snapshot_state,
    save_logical_snapshot_state,
)


SNAPSHOT_OP = "bitable_rows_logical_snapshot"
SNAPSHOT_VERSION = 1
SNAPSHOT_PAGE_SIZE = 200
SNAPSHOT_MAX_ROWS = 20_000
SNAPSHOT_MAX_PAYLOAD_BYTES = 20_000_000
SNAPSHOT_DEFAULT_SLICE_ROWS = 200
SNAPSHOT_DEFAULT_SLICE_BUDGET_S = 30.0
SNAPSHOT_MIN_SLICE_BUDGET_S = 30.0
SNAPSHOT_MAX_SLICE_BUDGET_S = 30.0
SNAPSHOT_DEFAULT_MAX_REQUESTS = 20
SNAPSHOT_MAX_REQUESTS = 20
SNAPSHOT_CONTINUATION_DELAY_S = 1.0

SNAPSHOT_CONFIRMATION_REF = "user-supplied-confirmation-reference"
# The standalone public package has no maintainer-specific snapshot bindings.
# User-owned snapshot contracts are evaluated from their own asset contract.
SNAPSHOT_ASSET_BINDINGS: dict[str, dict[str, str]] = {}
SNAPSHOT_DELETE_GUARD_FIELD = "交货仓库"


def _json_sha256(value: Any) -> str:
    canonical = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _plan_sha256(plan: dict[str, Any]) -> str:
    """Hash the complete persisted plan, including every mutation target."""
    unsigned = {
        key: value for key, value in plan.items() if key != "plan_sha256"
    }
    return _json_sha256(unsigned)


class SnapshotBudgetExceeded(RuntimeError):
    """The current bounded slice must yield before another request."""

    snapshot_budget_exceeded = True


class LogicalSnapshotUnknownWriteError(RuntimeError):
    """A remote mutation may have landed; the job must never replay it."""


class LogicalSnapshotReconcileError(LogicalSnapshotUnknownWriteError):
    """A read-only in-flight proof found missing, duplicate, or mismatched rows."""

    def __init__(self, message: str, *, evidence: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.evidence = evidence or {}


class LogicalSnapshotPreflightError(ValueError):
    """The complete plan cannot be written without changing schema/options."""

    def __init__(self, message: str, *, option_diffs: dict[str, Any]) -> None:
        super().__init__(message)
        self.option_diffs = option_diffs


@contextmanager
def _delete_serialization_lock(asset_id: str, *, already_held: bool = False):
    """Serialize guard read/delete with the queue's per-asset drain lock."""
    if already_held:
        yield
        return
    # Direct unit callers still get the same lock; the worker path passes
    # already_held because drain owns this lock for the whole claimed job.
    from .sync_drain import DEFAULT_LOCK, _lock_file_for

    path = _lock_file_for(DEFAULT_LOCK, asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def validate_snapshot_payload(asset: Any, payload: Any, *, caller_session: str) -> dict[str, Any]:
    if asset.asset_id not in SNAPSHOT_ASSET_BINDINGS:
        raise ValueError(
            f"logical snapshot is restricted to approved quote assets; got {asset.asset_id}"
        )
    binding = SNAPSHOT_ASSET_BINDINGS[asset.asset_id]
    if asset.base_token != binding["base_token"] or _table_id(asset, asset.tables[0]) != binding["table_id"]:
        raise ValueError("logical snapshot asset identity does not match approved base/table binding")
    if asset.owner_session != "huodaiduijie":
        raise ValueError("logical snapshot approved asset owner_session is fixed to huodaiduijie")
    if (
        asset.authority_model != binding["authority_model"]
        or asset.sync_direction != binding["sync_direction"]
    ):
        raise ValueError(
            "logical snapshot asset authority/direction does not match approved binding"
        )
    if caller_session != asset.owner_session:
        raise ValueError("logical snapshot requires the registered asset owner as caller")
    if not isinstance(payload, dict):
        raise ValueError("logical snapshot payload must be an object")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("logical snapshot requires a complete rows list")
    if len(rows) > SNAPSHOT_MAX_ROWS:
        raise ValueError(f"logical snapshot rows exceed {SNAPSHOT_MAX_ROWS}")
    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict) or snapshot.get("version") != SNAPSHOT_VERSION:
        raise ValueError("snapshot.version=1 is required")
    if snapshot.get("input_complete") is not True:
        raise ValueError("snapshot.input_complete=true is required; incomplete input cannot delete")
    if snapshot.get("confirmation_ref") != SNAPSHOT_CONFIRMATION_REF:
        raise ValueError("snapshot.confirmation_ref does not match the approved repair authorization")
    source_row_count = snapshot.get("source_row_count")
    if source_row_count != len(rows):
        raise ValueError("snapshot.source_row_count must equal len(rows)")
    slice_rows = snapshot.get("slice_rows", SNAPSHOT_DEFAULT_SLICE_ROWS)
    if slice_rows != SNAPSHOT_DEFAULT_SLICE_ROWS:
        raise ValueError(
            f"snapshot.slice_rows must be exactly {SNAPSHOT_DEFAULT_SLICE_ROWS}"
        )
    slice_budget_s = snapshot.get("slice_budget_s", SNAPSHOT_DEFAULT_SLICE_BUDGET_S)
    if isinstance(slice_budget_s, bool) or not isinstance(slice_budget_s, (int, float)):
        raise ValueError("snapshot.slice_budget_s must be a number")
    if float(slice_budget_s) != SNAPSHOT_DEFAULT_SLICE_BUDGET_S:
        raise ValueError(
            f"snapshot.slice_budget_s must be exactly {SNAPSHOT_DEFAULT_SLICE_BUDGET_S} seconds"
        )
    max_requests = snapshot.get("max_requests", SNAPSHOT_DEFAULT_MAX_REQUESTS)
    if isinstance(max_requests, bool) or not isinstance(max_requests, int):
        raise ValueError("snapshot.max_requests must be an integer")
    if max_requests != SNAPSHOT_DEFAULT_MAX_REQUESTS:
        raise ValueError(
            f"snapshot.max_requests must be exactly {SNAPSHOT_DEFAULT_MAX_REQUESTS}"
        )
    max_delete = payload.get("max_delete")
    if isinstance(max_delete, bool) or not isinstance(max_delete, int) or max_delete <= 0:
        raise ValueError("logical snapshot requires a positive max_delete")
    guard = payload.get("delete_guard")
    if not isinstance(guard, dict) or not isinstance(guard.get("field"), str):
        raise ValueError("logical snapshot requires an explicit delete_guard")
    table_fields = {field.name_zh for field in asset.tables[0].fields}
    if guard["field"] not in table_fields:
        raise ValueError(f"delete_guard field not in contract: {guard['field']}")
    if guard["field"] != SNAPSHOT_DELETE_GUARD_FIELD:
        raise ValueError(
            f"logical snapshot delete_guard field must be {SNAPSHOT_DELETE_GUARD_FIELD}"
        )
    values = guard.get("values")
    if not isinstance(values, list) or not values or not all(isinstance(v, str) and v for v in values):
        raise ValueError("delete_guard.values must be a non-empty string list")
    guard_values = {str(value) for value in values}
    guard_contract_options = {
        str(option.get("name"))
        for field in asset.tables[0].fields
        if field.name_zh == SNAPSHOT_DELETE_GUARD_FIELD
        for option in field.options
        if isinstance(option, dict) and isinstance(option.get("name"), str)
    }
    snapshot_guard_values = {
        str(row.get(SNAPSHOT_DELETE_GUARD_FIELD, ""))
        for row in rows
        if isinstance(row, dict) and str(row.get(SNAPSHOT_DELETE_GUARD_FIELD, ""))
    }
    expected_guard_values = guard_contract_options | snapshot_guard_values
    if guard_values != expected_guard_values:
        raise ValueError(
            "logical snapshot delete_guard.values must equal registered options plus "
            "current snapshot values"
        )
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("logical snapshot rows must be objects")
        if str(row.get(guard["field"], "")) not in guard_values:
            raise ValueError(
                "logical snapshot row is outside delete_guard scope; no write started"
            )
    check_controlled_rows_replace(
        asset, caller_session=caller_session, rows=rows,
        delete_guard=guard, max_delete=max_delete,
    )
    # Reuse the queue's canonical row-shape/unique-key validator at admission;
    # the later full plan repeats it with live records, but must not be the first
    # point at which a malformed row is rejected.
    bitable_upsert_plan(
        asset, rows, caller_session=caller_session,
        existing_records=[], existing_records_complete=False,
        queue_op="bitable_rows_replace",
    )
    payload_bytes = len(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    if payload_bytes > SNAPSHOT_MAX_PAYLOAD_BYTES:
        raise ValueError(
            f"logical snapshot payload exceeds {SNAPSHOT_MAX_PAYLOAD_BYTES} bytes"
        )
    return {
        "rows": rows,
        "snapshot": snapshot,
        "delete_guard": guard,
        "max_delete": max_delete,
        "slice_rows": slice_rows,
        "slice_budget_s": float(slice_budget_s),
        "max_requests": max_requests,
    }


def _deadline_cli(cli: Any, deadline: float, *, max_requests: int) -> Any:
    # A snapshot slice is deliberately single-attempt.  PacedLarkCli is the
    # normal queue client and may sleep/retry after a transport error; that is
    # unsafe for an already-submitted mutation and can also exceed this slice's
    # wall-clock budget.  The queue owns the retry/terminal decision instead.
    target = getattr(cli, "inner", cli)

    class _BudgetedCli:
        request_count = 0
        record_list_requests = 0

        def run_json(self, command: list[str], **kwargs: Any) -> dict[str, Any]:
            if self.request_count >= max_requests:
                raise SnapshotBudgetExceeded(
                    f"logical snapshot request budget exhausted ({max_requests})"
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise SnapshotBudgetExceeded("logical snapshot slice wall-clock budget exhausted")
            kwargs["timeout"] = min(float(kwargs.get("timeout") or remaining), remaining)
            self.request_count += 1
            if command[:2] == ["base", "+record-list"]:
                self.record_list_requests += 1
            return target.run_json(command, **kwargs)

    return _BudgetedCli()


def _validate_live_field_ids(asset: Any, table: Any, field_ids: dict[str, str]) -> None:
    for field in table.fields:
        expected = asset.field_ids.get(field.name_zh) or field.field_id
        if expected and field_ids.get(field.name_zh) != expected:
            raise ValueError(
                f"logical snapshot field_id drifted: {field.name_zh} "
                f"expected={expected} live={field_ids.get(field.name_zh, '')}"
            )


def _refresh_plan_field_ids(
    cli: Any, asset: Any, table: Any, *, actor: str, expected: dict[str, str]
) -> None:
    live = _live_field_ids(cli, asset, table, actor=actor)
    _validate_live_field_ids(asset, table, live)
    drift = sorted(
        name for name, field_id in expected.items()
        if live.get(name) != field_id
    )
    if drift:
        raise ValueError("logical snapshot continuation field_id drifted: " + ", ".join(drift))


def validate_snapshot_reconcile_checkpoint(
    state: dict[str, Any], asset: Any, payload: dict[str, Any],
) -> list[str]:
    """Return exact persisted snapshot identity errors before read-only recovery."""
    errors: list[str] = []
    table = asset.tables[0]
    plan = state.get("plan") if isinstance(state.get("plan"), dict) else {}
    plan_rows = plan.get("rows")
    if not isinstance(plan_rows, list):
        return ["plan_rows_missing"]
    if state.get("version") != SNAPSHOT_VERSION:
        errors.append("snapshot_version_drift")
    if state.get("payload_sha256") != _json_sha256(payload):
        errors.append("payload_sha256_drift")
    if state.get("contract_sha256") != _json_sha256(asdict(asset)):
        errors.append("contract_sha256_drift")
    if plan.get("plan_sha256") != _plan_sha256(plan):
        errors.append("plan_sha256_drift")
    expected_table_id = _table_id(asset, table)
    if plan.get("asset_id") != asset.asset_id:
        errors.append("asset_id_drift")
    if plan.get("base_token") != asset.base_token:
        errors.append("base_token_drift")
    if plan.get("table_id") != expected_table_id:
        errors.append("table_id_drift")
    if plan.get("unique_key") != list(table.unique_key):
        errors.append("unique_key_drift")
    if plan.get("source_row_count") != len(payload.get("rows", [])):
        errors.append("plan_source_row_count_drift")
    plan_field_ids = plan.get("field_ids")
    if not isinstance(plan_field_ids, dict):
        errors.append("plan_field_ids_missing")
    else:
        for field in table.fields:
            expected = asset.field_ids.get(field.name_zh) or field.field_id
            if not plan_field_ids.get(field.name_zh) or (
                expected and plan_field_ids.get(field.name_zh) != expected
            ):
                errors.append("plan_field_id_drift:" + field.name_zh)

    work_indexes = state.get("work_row_indexes")
    expected_work_indexes = [
        index for index, item in enumerate(plan_rows)
        if isinstance(item, dict) and item.get("action") != "skip"
    ]
    if work_indexes != expected_work_indexes:
        errors.append("work_row_indexes_drift")
        work_indexes = []
    if not isinstance(work_indexes, list) or len(work_indexes) != len(set(work_indexes)):
        errors.append("work_row_indexes_not_unique")
        work_indexes = []
    if state.get("phase") in {"slice_in_flight", "reconcile_slice"}:
        slice_indexes = state.get("slice_row_indexes")
        work_start = state.get("slice_work_start")
        work_end = state.get("slice_work_end")
        if (
            not isinstance(slice_indexes, list)
            or not slice_indexes
            or not isinstance(work_start, int)
            or not isinstance(work_end, int)
            or work_start < 0
            or work_end < work_start
            or work_end > len(work_indexes)
            or slice_indexes != work_indexes[work_start:work_end]
            or state.get("work_row_cursor") != work_start
        ):
            errors.append("slice_indexes_range_drift")
        else:
            expected_start = min(slice_indexes)
            expected_end = max(slice_indexes) + 1
            if state.get("slice_start") != expected_start or state.get("slice_end") != expected_end:
                errors.append("slice_indexes_bounds_drift")
            for index in slice_indexes:
                if (
                    not isinstance(index, int)
                    or index < 0
                    or index >= len(plan_rows)
                    or plan_rows[index].get("action") not in {"create", "update"}
                ):
                    errors.append("slice_checkpoint_not_mutation_in_flight")
                    break
    return errors


def _read_page(
    cli: Any, asset: Any, table: Any, *, actor: str, offset: int,
    field_ids: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    projection = field_ids or _live_field_ids(cli, asset, table, actor=actor)
    ordered_field_ids = [projection.get(field.name_zh, "") for field in table.fields]
    if not all(ordered_field_ids):
        raise ValueError("logical snapshot record-list projection has an unbound contract field")
    command = [
        "base", "+record-list", "--as", actor,
        "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        "--offset", str(offset), "--limit", str(SNAPSHOT_PAGE_SIZE),
    ]
    for field_id in ordered_field_ids:
        command.extend(["--field-id", field_id])
    payload = cli.run_json(command)
    data = payload.get("data") or {}
    has_more = data.get("has_more")
    if not isinstance(has_more, bool):
        raise ValueError("logical snapshot record-list response has no boolean has_more")
    records = _lark_records_from_list(payload, _field_types(asset))
    if not records and has_more:
        raise ValueError("logical snapshot pagination made no forward progress")
    expected_fields = {field.name_zh for field in table.fields}
    projected_fields = set()
    for raw_field in data.get("fields", []):
        name = str(raw_field)
        if name not in expected_fields and name.endswith("..."):
            candidates = [field for field in expected_fields if field.startswith(name[:-3])]
            if len(candidates) == 1:
                name = candidates[0]
        projected_fields.add(name)
    missing_fields = sorted(expected_fields - projected_fields)
    if missing_fields:
        raise ValueError(
            "logical snapshot record-list projection missing contract fields: "
            + ", ".join(missing_fields)
        )
    if any(expected_fields - set(record.get("fields", {})) for record in records):
        raise ValueError(
            "logical snapshot record-list row projection missing contract fields"
        )
    return records, has_more


def _read_all(cli: Any, asset: Any, table: Any, *, actor: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen_record_ids: set[str] = set()
    field_ids = _live_field_ids(cli, asset, table, actor=actor)
    offset = 0
    while True:
        page, has_more = _read_page(
            cli, asset, table, actor=actor, offset=offset, field_ids=field_ids,
        )
        for record in page:
            record_id = str(record.get("record_id") or "")
            if not record_id or record_id in seen_record_ids:
                raise ValueError("logical snapshot pagination repeated or omitted record_id")
            seen_record_ids.add(record_id)
        records.extend(page)
        if not has_more:
            return records
        if not page:
            raise ValueError("logical snapshot pagination made no forward progress")
        offset += len(page)


def _read_phase_pages(
    conn: Any,
    job_id: int,
    state: dict[str, Any],
    phase: str,
    cli: Any,
    asset: Any,
    table: Any,
    *,
    actor: str,
    field_ids: dict[str, str],
    deadline: float,
    max_requests: int,
) -> list[dict[str, Any]] | None:
    """Continue one complete read-back phase from its own durable page cursor."""
    checkpoints = state.setdefault("read_checkpoints", {})
    checkpoint = checkpoints.setdefault(
        phase,
        {"offset": 0, "pages": 0, "records": [], "record_ids": [], "complete": False},
    )
    if checkpoint.get("complete"):
        return list(checkpoint.get("records", []))
    records = checkpoint.setdefault("records", [])
    seen_ids = set(str(record_id) for record_id in checkpoint.setdefault("record_ids", []))
    while True:
        if getattr(cli, "request_count", 0) >= max_requests or time.monotonic() >= deadline:
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            return None
        try:
            page, has_more = _read_page(
                cli, asset, table, actor=actor,
                offset=int(checkpoint.get("offset", 0)), field_ids=field_ids,
            )
        except SnapshotBudgetExceeded:
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            return None
        page_ids = [str(record.get("record_id") or "") for record in page]
        if (
            len(page_ids) != len(set(page_ids))
            or any(not record_id or record_id in seen_ids for record_id in page_ids)
        ):
            raise ValueError(
                f"logical snapshot {phase} pagination repeated or omitted record_id"
            )
        records.extend(page)
        seen_ids.update(page_ids)
        checkpoint["record_ids"] = sorted(seen_ids)
        checkpoint["pages"] = int(checkpoint.get("pages", 0)) + 1
        checkpoint["offset"] = int(checkpoint.get("offset", 0)) + len(page)
        checkpoint["has_more"] = has_more
        if not has_more:
            checkpoint["complete"] = True
            checkpoint["evidence"] = {
                "page_count": checkpoint["pages"],
                "row_count": len(records),
                "last_offset": checkpoint["offset"],
                "record_id_sha256": _json_sha256(checkpoint["record_ids"]),
            }
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            return list(records)
        if not page:
            raise ValueError(
                f"logical snapshot {phase} pagination made no forward progress"
            )
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))
        if time.monotonic() >= deadline or getattr(cli, "request_count", 0) >= max_requests:
            return None


def _clear_read_phase_records(state: dict[str, Any], phase: str) -> None:
    checkpoint = state.get("read_checkpoints", {}).get(phase)
    if isinstance(checkpoint, dict):
        checkpoint.pop("records", None)
        checkpoint.pop("record_ids", None)


def _ensure_work_row_indexes(state: dict[str, Any]) -> list[int]:
    plan_rows = state["plan"]["rows"]
    indexes = state.get("work_row_indexes")
    if not isinstance(indexes, list):
        indexes = [
            index for index, item in enumerate(plan_rows)
            if item.get("action") != "skip"
        ]
        state["work_row_indexes"] = indexes
    state["work_row_total"] = len(indexes)
    return indexes


def _option_diffs(
    asset: Any, table: Any, plan_rows: list[dict[str, Any]], *, cli: Any,
    actor: str, field_ids: dict[str, str] | None = None,
    required_values: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    fields_by_name = {field.name_zh: field for field in table.fields}
    wanted: dict[str, set[str]] = {}
    for item in plan_rows:
        if item.get("action") == "skip":
            continue
        for name, value in (item.get("write_fields") or {}).items():
            field = fields_by_name.get(name)
            if field is not None and field.type in {"single_select", "multi_select"}:
                wanted.setdefault(name, set()).update(
                    _select_values_for_preflight(value, field.type, field=name)
                )
    for name, values in (required_values or {}).items():
        field = fields_by_name.get(name)
        if field is not None and field.type in {"single_select", "multi_select"}:
            wanted.setdefault(name, set()).update(values)
    if not wanted:
        return {}
    field_ids = field_ids or _live_field_ids(cli, asset, table, actor=actor)
    result: dict[str, Any] = {}
    for name in sorted(wanted):
        field = fields_by_name[name]
        declared = {
            str(option.get("name")) for option in field.options
            if isinstance(option, dict) and isinstance(option.get("name"), str)
        }
        field_id = field_ids.get(name, "")
        if not field_id:
            live_names: set[str] = set()
        else:
            # Importing the implementation keeps the existing paginated option gate
            # and its fail-closed duplicate/total checks as the single source.
            from .bitable import _live_select_option_names
            live_names = _live_select_option_names(
                cli, asset, table, actor=actor, field=name, field_id=field_id,
            )
        requested = wanted[name]
        result[name] = {
            "field_id": field_id,
            "requested": sorted(requested),
            "contract_options": sorted(declared),
            "live_options": sorted(live_names),
            "missing_from_contract": sorted(requested - declared),
            "missing_live": sorted(requested - live_names),
            "extra_live": sorted(live_names - declared),
        }
    return result


def build_logical_snapshot_plan(
    asset: Any,
    payload: dict[str, Any],
    *,
    caller_session: str,
    existing_records: list[dict[str, Any]],
    cli: Any,
    actor: str = "user",
) -> dict[str, Any]:
    validated = validate_snapshot_payload(asset, payload, caller_session=caller_session)
    table = asset.tables[0]
    field_types = _field_types(asset, table)
    grouped = _group_records_by_key(existing_records, table.unique_key, field_types)
    primary: list[dict[str, Any]] = []
    for records in grouped.values():
        if len(records) > 1:
            duplicate_ids = [str(record.get("record_id") or "") for record in records]
            raise ValueError(
                "duplicate remote unique key; no logical snapshot write started: "
                + json.dumps(duplicate_ids, ensure_ascii=False)
            )
        if records:
            primary.append(records[0])
    planned = bitable_upsert_plan(
        asset, validated["rows"], caller_session=caller_session,
        existing_records=primary, existing_records_complete=True,
        queue_op="bitable_rows_replace",
    )
    field_ids = _live_field_ids(cli, asset, table, actor=actor)
    _validate_live_field_ids(asset, table, field_ids)
    required_field_names = set(table.unique_key) | {validated["delete_guard"]["field"]}
    required_field_names.update(
        field
        for item in planned["rows"]
        for field in (item.get("write_fields") or {})
    )
    missing_field_ids = sorted(
        field for field in required_field_names if not field_ids.get(field)
    )
    if missing_field_ids:
        raise ValueError(
            "live field ids missing for logical snapshot fields: "
            + ", ".join(missing_field_ids)
        )
    guard = validated["delete_guard"]
    guard_field = guard["field"]
    guard_values = {str(value) for value in guard["values"]}
    option_diffs = _option_diffs(
        asset, table, planned["rows"], cli=cli, actor=actor, field_ids=field_ids,
        required_values={guard_field: guard_values},
    )
    blocked = {
        name: diff for name, diff in option_diffs.items()
        if diff["missing_from_contract"] or diff["missing_live"] or not diff["field_id"]
    }
    payload_keys = {
        _record_key(row, table.unique_key, field_types) for row in validated["rows"]
    }
    delete_targets: list[str] = []
    delete_target_keys: dict[str, dict[str, Any]] = {}
    for record in existing_records:
        fields = record.get("fields", {})
        if str(fields.get(guard_field, "")) not in guard_values:
            continue
        if _record_key(fields, table.unique_key, field_types) not in payload_keys:
            record_id = str(record.get("record_id") or "")
            if record_id:
                delete_targets.append(record_id)
                delete_target_keys[record_id] = {
                    field: fields.get(field) for field in table.unique_key
                }
    delete_targets = list(dict.fromkeys(delete_targets))
    if len(delete_targets) > validated["max_delete"]:
        raise ValueError(
            f"logical snapshot would delete {len(delete_targets)} rows > max_delete "
            f"{validated['max_delete']}; no write started"
        )
    status = "blocked" if blocked else "ready"
    plan = {
        "version": SNAPSHOT_VERSION,
        "status": status,
        "asset_id": asset.asset_id,
        "base_token": asset.base_token,
        "table_id": _table_id(asset, table),
        "unique_key": list(table.unique_key),
        "source_row_count": len(validated["rows"]),
        "add": planned["created"],
        "update": planned["updated"],
        "delete": len(delete_targets),
        "unchanged": planned["skipped"],
        "duplicate_extra_ids": [],
        "delete_target_ids": delete_targets,
        "delete_target_keys": delete_target_keys,
        "rows": planned["rows"],
        "field_ids": field_ids,
        "field_options_diff": option_diffs,
        "preflight": {"status": status, "blocked_fields": blocked},
    }
    plan["plan_sha256"] = _plan_sha256(plan)
    return plan


def _write_creates(cli: Any, asset: Any, table: Any, items: list[dict[str, Any]], *, actor: str, field_ids: dict[str, str], field_types: dict[str, str]) -> None:
    columns: list[str] = []
    for item in items:
        for field in item["write_fields"]:
            if field not in columns:
                columns.append(field)
    wire_columns = [field_ids[field] for field in columns]
    for start in range(0, len(items), _CREATE_BATCH):
        chunk = items[start:start + _CREATE_BATCH]
        try:
            cli.run_json([
                "base", "+record-batch-create", "--as", actor,
                "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
                "--json", json.dumps({
                    "fields": wire_columns,
                    "rows": [[
                        _wire_write_fields(item["write_fields"], field_types, field_ids=field_ids).get(field_ids[field])
                        for field in columns
                    ] for item in chunk],
                }, ensure_ascii=False),
            ])
        except SnapshotBudgetExceeded:
            raise
        except Exception as exc:  # remote may have accepted the batch
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot create result unknown; do not replay or recover: " + str(exc)
            ) from exc


def _verify_rows(records: list[dict[str, Any]], items: list[dict[str, Any]], table: Any, field_types: dict[str, str]) -> tuple[bool, str]:
    grouped = _group_records_by_key(records, table.unique_key, field_types)
    for item in items:
        key = _record_key(item["unique_key"], table.unique_key, field_types)
        candidates = grouped.get(key, [])
        if len(candidates) != 1:
            return False, f"expected exactly one record for unique_key={item['unique_key']}, got={len(candidates)}"
        if not _write_fields_match(candidates[0], item, field_types):
            return False, f"field mismatch after read-back for unique_key={item['unique_key']}"
    return True, ""


def _verify_rows_with_evidence(
    records: list[dict[str, Any]], items: list[dict[str, Any]],
    table: Any, field_types: dict[str, str],
) -> list[dict[str, Any]]:
    """Verify an in-flight slice and retain exact key/record/field evidence."""
    grouped = _group_records_by_key(records, table.unique_key, field_types)
    evidence: list[dict[str, Any]] = []
    for item in items:
        key = _record_key(item["unique_key"], table.unique_key, field_types)
        candidates = grouped.get(key, [])
        if len(candidates) != 1:
            raise LogicalSnapshotReconcileError(
                "logical snapshot in-flight slice cannot be proven; do not replay: "
                f"expected exactly one record for unique_key={item['unique_key']}, "
                f"got={len(candidates)}",
                evidence={
                    "unique_key": item["unique_key"],
                    "candidate_record_ids": [
                        str(record.get("record_id") or "") for record in candidates
                    ],
                    "reason": "missing_or_duplicate_record",
                },
            )
        record = candidates[0]
        if not _write_fields_match(record, item, field_types):
            raise LogicalSnapshotReconcileError(
                "logical snapshot in-flight slice cannot be proven; do not replay: "
                f"field mismatch after read-back for unique_key={item['unique_key']}",
                evidence={
                    "unique_key": item["unique_key"],
                    "record_id": str(record.get("record_id") or ""),
                    "expected_fields": item["write_fields"],
                    "actual_fields": record.get("fields", {}),
                    "reason": "field_mismatch",
                },
            )
        evidence.append({
            "unique_key": item["unique_key"],
            "record_id": str(record.get("record_id") or ""),
            "expected_fields": item["write_fields"],
            "actual_fields": record.get("fields", {}),
            "field_match": True,
        })
    return evidence


def _apply_slice(
    asset: Any, plan_rows: list[dict[str, Any]], *, cli: Any,
    caller_session: str, actor: str, field_ids: dict[str, str],
) -> dict[str, int]:
    table = asset.tables[0]
    field_types = _field_types(asset, table)
    for item in plan_rows:
        missing = sorted(set(item.get("write_fields") or {}) - set(field_ids))
        if missing:
            raise ValueError("live field ids missing for writable fields: " + ", ".join(missing))
    creates = [item for item in plan_rows if item["action"] == "create"]
    updates = [item for item in plan_rows if item["action"] == "update"]
    if creates:
        _write_creates(cli, asset, table, creates, actor=actor, field_ids=field_ids, field_types=field_types)
    if updates:
        errors, error_total, unverified = _bulk_update_same_patch_records(
            cli, asset, table, updates, actor=actor, field_ids=field_ids, field_types=field_types,
        )
        if errors or error_total or unverified:
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot update result not fully verified; do not replay: "
                + json.dumps({"errors": errors[:3], "error_total": error_total, "unverified": sorted(unverified)[:10]}, ensure_ascii=False)
            )
        read_fields = list(dict.fromkeys(field_ids[field] for item in updates for field in item["write_fields"]))
        readback = _records_get_by_ids(
            cli, asset, table, [item["record_id"] for item in updates], actor=actor, field_names=read_fields,
        )
        for item in updates:
            record = readback.get(str(item["record_id"]))
            if record is None or not _write_fields_match(record, item, field_types):
                raise LogicalSnapshotUnknownWriteError(
                    "logical snapshot update read-back failed; do not replay"
                )
    return {"created": len(creates), "updated": len(updates), "skipped": sum(item["action"] == "skip" for item in plan_rows)}


def _delete_batch(cli: Any, asset: Any, table: Any, record_ids: list[str], *, actor: str) -> None:
    try:
        command = [
            "base", "+record-delete", "--as", actor, "--yes",
            "--base-token", asset.base_token, "--table-id", _table_id(asset, table),
        ]
        for record_id in record_ids:
            command.extend(["--record-id", record_id])
        cli.run_json(command)
    except SnapshotBudgetExceeded:
        raise
    except Exception as exc:
        raise LogicalSnapshotUnknownWriteError(
            "logical snapshot delete result unknown; do not replay: " + str(exc)
        ) from exc


def _verify_delete_guard_batch(
    cli: Any,
    asset: Any,
    table: Any,
    record_ids: list[str],
    *,
    actor: str,
    guard: dict[str, Any],
    guard_field_id: str,
    expected_unique_keys: dict[str, dict[str, Any]] | None = None,
    expected_field_ids: dict[str, str] | None = None,
) -> tuple[list[str], list[str]]:
    """Re-check the exact target identity immediately before deletion.

    Missing records are already converged and are not submitted again.  A
    target whose guard changed is an external race, so the snapshot fails
    closed instead of deleting a now-protected row.
    """
    field_ids = [guard_field_id]
    if expected_unique_keys:
        contract_field_ids = {
            field.name_zh: (
                (expected_field_ids or {}).get(field.name_zh)
                or asset.field_ids.get(field.name_zh)
                or field.field_id
            )
            for field in table.fields
        }
        field_ids.extend(
            contract_field_ids[field]
            for field in table.unique_key
            if contract_field_ids.get(field)
        )
    records = _records_get_by_ids(
        cli, asset, table, record_ids, actor=actor, field_names=list(dict.fromkeys(field_ids))
    )
    values = {str(value) for value in guard["values"]}
    present: list[str] = []
    absent: list[str] = []
    for record_id in record_ids:
        record = records.get(str(record_id))
        if record is None:
            absent.append(str(record_id))
            continue
        if str(record.get("fields", {}).get(guard["field"], "")) not in values:
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot delete guard changed before mutation; do not replay"
            )
        expected_key = (expected_unique_keys or {}).get(str(record_id))
        if expected_key is not None:
            actual_key = _record_key(
                record.get("fields", {}), table.unique_key, _field_types(asset, table)
            )
            if actual_key != _record_key(expected_key, table.unique_key, _field_types(asset, table)):
                raise LogicalSnapshotUnknownWriteError(
                    "logical snapshot delete unique-key identity changed before mutation; do not replay"
                )
        present.append(str(record_id))
    return present, absent


def _continuation_state(state: dict[str, Any]) -> dict[str, Any]:
    state["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return state


def run_logical_snapshot(
    *,
    job_id: int,
    asset: Any,
    payload: dict[str, Any],
    caller_session: str,
    conn: Any,
    cli: Any,
    actor: str = "user",
    queue_lock_held: bool = False,
    read_only_reconcile: bool = False,
) -> dict[str, Any]:
    validated = validate_snapshot_payload(asset, payload, caller_session=caller_session)
    table = asset.tables[0]
    payload_sha256 = _json_sha256(payload)
    contract_sha256 = _json_sha256(asdict(asset))
    state = get_logical_snapshot_state(conn, job_id)
    if state is None:
        state = {
            "version": SNAPSHOT_VERSION,
            "payload_sha256": payload_sha256,
            "contract_sha256": contract_sha256,
            "phase": "prefetch",
            "prefetch_offset": 0,
            "prefetch_pages": 0,
            "remote_records": [],
            "next_row": 0,
            "work_row_cursor": 0,
            "work_row_total": 0,
            "read_checkpoints": {},
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "deleted": 0,
        }
        save_logical_snapshot_state(conn, job_id, state)
    elif (
        state.get("version") != SNAPSHOT_VERSION
        or state.get("payload_sha256") != payload_sha256
        or state.get("contract_sha256") != contract_sha256
    ):
        raise LogicalSnapshotUnknownWriteError(
            "logical snapshot checkpoint binding changed; do not resume or replay"
        )
    if state.get("phase") not in {"prefetch", "plan"} and "plan" in state:
        plan_errors = validate_snapshot_reconcile_checkpoint(state, asset, payload)
        if plan_errors:
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot persisted plan binding changed; do not resume or replay: "
                + ", ".join(plan_errors)
            )
    budget = float(validated["slice_budget_s"])
    deadline = time.monotonic() + budget
    budgeted_cli = _deadline_cli(
        cli, deadline, max_requests=int(validated["max_requests"])
    )
    projection_field_ids = state.get("projection_field_ids")
    if not isinstance(projection_field_ids, dict) or any(
        not projection_field_ids.get(field.name_zh) for field in table.fields
    ):
        projection_field_ids = _live_field_ids(
            budgeted_cli, asset, table, actor=actor,
        )
        _validate_live_field_ids(asset, table, projection_field_ids)
        if any(not projection_field_ids.get(field.name_zh) for field in table.fields):
            raise ValueError("logical snapshot record-list projection has an unbound contract field")
        state["projection_field_ids"] = projection_field_ids
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if read_only_reconcile:
        if state.get("phase") == "slice_in_flight":
            # This is the only state transition allowed before the proof.  The
            # mutation already has an uncertain outcome; no write path is reachable.
            state["phase"] = "reconcile_slice"
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
        if state.get("phase") != "reconcile_slice":
            raise LogicalSnapshotReconcileError(
                "logical snapshot read-only reconcile requires slice_in_flight state",
                evidence={"phase": state.get("phase")},
            )
        projection_field_ids = state["plan"]["field_ids"]
        _refresh_plan_field_ids(
            budgeted_cli, asset, table, actor=actor,
            expected=projection_field_ids,
        )
        slice_indexes = state.get("slice_row_indexes")
        if not isinstance(slice_indexes, list) or not slice_indexes:
            raise LogicalSnapshotReconcileError(
                "logical snapshot read-only reconcile has no persisted slice rows",
                evidence={"reason": "slice_rows_missing"},
            )
        records = _read_phase_pages(
            conn, job_id, state, "reconcile_slice", budgeted_cli, asset, table,
            actor=actor, field_ids=projection_field_ids,
            deadline=deadline, max_requests=int(validated["max_requests"]),
        )
        if records is None:
            checkpoint = state["read_checkpoints"]["reconcile_slice"]
            return {
                "ok": False,
                "reconciliation_complete": False,
                "continuation": True,
                "phase": "reconcile_slice",
                "read_checkpoint": checkpoint.get("evidence") or {
                    "offset": checkpoint.get("offset", 0),
                    "pages": checkpoint.get("pages", 0),
                },
            }
        slice_rows = [state["plan"]["rows"][index] for index in slice_indexes]
        record_verifications = _verify_rows_with_evidence(
            records, slice_rows, table, _field_types(asset, table),
        )
        evidence = state["read_checkpoints"]["reconcile_slice"].get("evidence", {})
        # Keep the complete proof and the in-flight slice durable until the
        # caller's failed->pending CAS succeeds.  If the process dies between
        # this save and that CAS, the public reconcile entry point must still
        # have the original recovery handle and must never submit the slice.
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))
        return {
            "ok": True,
            "reconciliation_complete": True,
            "remote_write_count": 0,
            "phase": "reconcile_slice",
            "record_verifications": record_verifications,
            "read_checkpoint": evidence,
        }

    if state.get("phase") == "prefetch":
        while True:
            page, has_more = _read_page(
                budgeted_cli, asset, table, actor=actor,
                offset=int(state.get("prefetch_offset", 0)),
                field_ids=projection_field_ids,
            )
            page_ids = [str(record.get("record_id") or "") for record in page]
            seen_ids = {
                str(record.get("record_id") or "")
                for record in state["remote_records"]
            }
            if (
                len(page_ids) != len(set(page_ids))
                or any(not record_id or record_id in seen_ids for record_id in page_ids)
            ):
                raise ValueError("logical snapshot pagination repeated or omitted record_id")
            state["remote_records"].extend(page)
            state["prefetch_pages"] = int(state.get("prefetch_pages", 0)) + 1
            state["prefetch_offset"] = int(state.get("prefetch_offset", 0)) + len(page)
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            if not has_more:
                state["phase"] = "plan"
                save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                return {
                    "continuation": True, "phase": "plan",
                    "prefetch_pages": state["prefetch_pages"],
                    "next_offset": state["prefetch_offset"],
                }
            if not page:
                raise ValueError("logical snapshot pagination made no forward progress")
            if (
                time.monotonic() >= deadline
                or budgeted_cli.request_count >= int(validated["max_requests"])
            ):
                return {"continuation": True, "phase": "prefetch", "prefetch_pages": state["prefetch_pages"], "next_offset": state["prefetch_offset"]}

    if state.get("phase") == "plan":
        plan = build_logical_snapshot_plan(
            asset, payload, caller_session=caller_session,
            existing_records=state["remote_records"], cli=budgeted_cli, actor=actor,
        )
        if plan["status"] != "ready":
            raise LogicalSnapshotPreflightError(
                "logical snapshot preflight blocked; no remote write started",
                option_diffs=plan["field_options_diff"],
            )
        state["plan"] = plan
        _ensure_work_row_indexes(state)
        state["phase"] = "apply"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))
        # Planning can consume most of the read budget on a large table.  Give
        # the next slice a fresh 30s/20-request mutation window.
        return {
            "continuation": True, "phase": "apply",
            "work_row_cursor": state["work_row_cursor"],
            "work_row_total": state["work_row_total"],
        }

    if state.get("phase") not in {"prefetch", "plan"} and "plan" in state:
        _ensure_work_row_indexes(state)

    if state.get("phase") == "slice_in_flight":
        # The previous process may have died after the remote request.  Read only;
        # never resubmit the persisted slice.
        state["phase"] = "reconcile_slice"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "reconcile_slice":
        records = _read_phase_pages(
            conn, job_id, state, "reconcile_slice", budgeted_cli, asset, table,
            actor=actor, field_ids=state["plan"]["field_ids"],
            deadline=deadline, max_requests=int(validated["max_requests"]),
        )
        if records is None:
            return {
                "continuation": True, "phase": "reconcile_slice",
                "read_checkpoint": state["read_checkpoints"]["reconcile_slice"]["evidence"]
                if state["read_checkpoints"]["reconcile_slice"].get("complete") else {
                    "offset": state["read_checkpoints"]["reconcile_slice"].get("offset", 0),
                    "pages": state["read_checkpoints"]["reconcile_slice"].get("pages", 0),
                },
            }
        slice_indexes = state.get("slice_row_indexes")
        if isinstance(slice_indexes, list):
            slice_rows = [state["plan"]["rows"][index] for index in slice_indexes]
        else:
            start = int(state["slice_start"])
            end = int(state["slice_end"])
            slice_rows = state["plan"]["rows"][start:end]
        ok, reason = _verify_rows(records, slice_rows, table, _field_types(asset, table))
        if not ok:
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot in-flight slice cannot be proven; do not replay: " + reason
            )
        _clear_read_phase_records(state, "reconcile_slice")
        if isinstance(state.get("slice_work_end"), int):
            state["work_row_cursor"] = state["slice_work_end"]
        state["next_row"] = max(
            state.get("next_row", 0),
            (max(slice_indexes) + 1) if isinstance(slice_indexes, list) and slice_indexes else 0,
        )
        state["phase"] = "apply"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "apply":
        plan_rows = state["plan"]["rows"]
        work_indexes = _ensure_work_row_indexes(state)
        work_start = int(state.get("work_row_cursor", 0))
        if work_start < len(work_indexes):
            work_end = min(len(work_indexes), work_start + int(validated["slice_rows"]))
            slice_indexes = work_indexes[work_start:work_end]
            selected_rows = [plan_rows[index] for index in slice_indexes]
            start = slice_indexes[0]
            end = slice_indexes[-1] + 1
            _refresh_plan_field_ids(
                budgeted_cli, asset, table, actor=actor,
                expected=state["plan"]["field_ids"],
            )
            state["phase"] = "slice_in_flight"
            state["slice_start"] = start
            state["slice_end"] = end
            state["slice_row_indexes"] = slice_indexes
            state["slice_work_start"] = work_start
            state["slice_work_end"] = work_end
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            before_mutation_requests = budgeted_cli.request_count
            try:
                stats = _apply_slice(
                    asset, selected_rows, cli=budgeted_cli,
                    caller_session=caller_session, actor=actor,
                    field_ids=state["plan"]["field_ids"],
                )
            except SnapshotBudgetExceeded:
                # The wrapper raises before invoking the underlying CLI.  Do
                # not leave a false in-flight marker in that case; a later
                # bounded continuation may safely submit this slice.
                if budgeted_cli.request_count == before_mutation_requests:
                    state["phase"] = "apply"
                    save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                raise
            state["created"] += stats["created"]
            state["updated"] += stats["updated"]
            state["skipped"] += stats["skipped"]
            state["work_row_cursor"] = work_end
            state["next_row"] = (
                work_indexes[work_end] if work_end < len(work_indexes) else len(plan_rows)
            )
            state.pop("slice_row_indexes", None)
            state.pop("slice_work_start", None)
            state.pop("slice_work_end", None)
            state["phase"] = "apply"
            save_logical_snapshot_state(conn, job_id, _continuation_state(state))
            return {
                "continuation": True, "phase": "apply", "next_row": state["next_row"],
                "work_row_cursor": work_end, "work_row_total": len(work_indexes),
                "total_rows": len(plan_rows),
            }
        state["next_row"] = len(plan_rows)
        state["phase"] = "pre_delete"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "delete_in_flight":
        records = _read_phase_pages(
            conn, job_id, state, "delete_in_flight", budgeted_cli, asset, table,
            actor=actor, field_ids=state["plan"]["field_ids"],
            deadline=deadline, max_requests=int(validated["max_requests"]),
        )
        if records is None:
            checkpoint = state["read_checkpoints"]["delete_in_flight"]
            return {
                "continuation": True, "phase": "delete_in_flight",
                "read_checkpoint": checkpoint.get("evidence") or {
                    "offset": checkpoint.get("offset", 0), "pages": checkpoint.get("pages", 0),
                },
            }
        in_flight = state["delete_batch"]
        remaining = {str(record.get("record_id")) for record in records}
        if any(record_id in remaining for record_id in in_flight):
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot in-flight delete cannot be proven; do not replay"
            )
        state["delete_index"] = int(
            state.get("delete_batch_end", int(state["delete_index"]) + len(in_flight))
        )
        state["deleted"] += len(in_flight) + len(state.get("delete_absent_batch", []))
        state.pop("delete_batch_start", None)
        state.pop("delete_batch_end", None)
        state.pop("delete_absent_batch", None)
        state.pop("delete_batch", None)
        _clear_read_phase_records(state, "delete_in_flight")
        state["phase"] = "delete"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "pre_delete":
        records = _read_phase_pages(
            conn, job_id, state, "pre_delete", budgeted_cli, asset, table,
            actor=actor, field_ids=state["plan"]["field_ids"],
            deadline=deadline, max_requests=int(validated["max_requests"]),
        )
        if records is None:
            checkpoint = state["read_checkpoints"]["pre_delete"]
            return {
                "continuation": True, "phase": "pre_delete",
                "read_checkpoint": checkpoint.get("evidence") or {
                    "offset": checkpoint.get("offset", 0), "pages": checkpoint.get("pages", 0),
                },
            }
        ok, reason = _verify_rows(records, state["plan"]["rows"], table, _field_types(asset, table))
        if not ok:
            raise LogicalSnapshotUnknownWriteError("logical snapshot pre-delete read-back failed: " + reason)
        _clear_read_phase_records(state, "pre_delete")
        state["phase"] = "delete"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "delete":
        delete_targets = list(state["plan"]["delete_target_ids"])
        index = int(state.get("delete_index", 0))
        if index < len(delete_targets):
            batch = delete_targets[index:index + _CREATE_BATCH]
            _refresh_plan_field_ids(
                budgeted_cli, asset, table, actor=actor,
                expected=state["plan"]["field_ids"],
            )
            with _delete_serialization_lock(
                asset.asset_id, already_held=queue_lock_held
            ):
                present, absent = _verify_delete_guard_batch(
                    budgeted_cli, asset, table, batch, actor=actor,
                    guard=validated["delete_guard"],
                    guard_field_id=state["plan"]["field_ids"][validated["delete_guard"]["field"]],
                    expected_unique_keys=state["plan"].get("delete_target_keys", {}),
                    expected_field_ids=state["plan"].get("field_ids", {}),
                )
                if absent:
                    state["delete_absent_batch"] = absent
                if not present:
                    state["delete_index"] = index + len(batch)
                    state["deleted"] += len(absent)
                    state.pop("delete_absent_batch", None)
                    save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                    return {
                        "continuation": True, "phase": "delete",
                        "deleted": state["deleted"], "delete_total": len(delete_targets),
                    }
                state["phase"] = "delete_in_flight"
                state["delete_batch_start"] = index
                state["delete_batch_end"] = index + len(batch)
                state["delete_index"] = index
                state["delete_batch"] = present
                save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                before_mutation_requests = budgeted_cli.request_count
                try:
                    _delete_batch(budgeted_cli, asset, table, present, actor=actor)
                except SnapshotBudgetExceeded:
                    if budgeted_cli.request_count == before_mutation_requests:
                        state["phase"] = "delete"
                        save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                    raise
                state["delete_index"] = index + len(batch)
                state["deleted"] += len(present) + len(absent)
                state.pop("delete_batch_start", None)
                state.pop("delete_batch_end", None)
                state.pop("delete_absent_batch", None)
                state.pop("delete_batch", None)
                state["phase"] = "delete"
                save_logical_snapshot_state(conn, job_id, _continuation_state(state))
                return {"continuation": True, "phase": "delete", "deleted": state["deleted"], "delete_total": len(delete_targets)}
        state["phase"] = "final_verify"
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))

    if state.get("phase") == "final_verify":
        records = _read_phase_pages(
            conn, job_id, state, "final_verify", budgeted_cli, asset, table,
            actor=actor, field_ids=state["plan"]["field_ids"],
            deadline=deadline, max_requests=int(validated["max_requests"]),
        )
        if records is None:
            checkpoint = state["read_checkpoints"]["final_verify"]
            return {
                "continuation": True, "phase": "final_verify",
                "read_checkpoint": checkpoint.get("evidence") or {
                    "offset": checkpoint.get("offset", 0), "pages": checkpoint.get("pages", 0),
                },
            }
        plan_rows = state["plan"]["rows"]
        ok, reason = _verify_rows(records, plan_rows, table, _field_types(asset, table))
        if not ok:
            raise LogicalSnapshotUnknownWriteError("logical snapshot final read-back failed: " + reason)
        grouped = _group_records_by_key(records, table.unique_key, _field_types(asset, table))
        expected = {
            _record_key(item["unique_key"], table.unique_key, _field_types(asset, table))
            for item in plan_rows
        }
        guard = validated["delete_guard"]
        guard_values = {str(value) for value in guard["values"]}
        actual = {
            key for key, candidates in grouped.items()
            if any(str(record.get("fields", {}).get(guard["field"], "")) in guard_values for record in candidates)
        }
        if actual != expected or any(len(grouped[key]) != 1 for key in expected):
            raise LogicalSnapshotUnknownWriteError(
                "logical snapshot final read-back set mismatch; do not replay"
            )
        result = {
            "asset_id": asset.asset_id,
            "caller_session": caller_session,
            "mode": "logical_snapshot",
            "op": SNAPSHOT_OP,
            "created": state["plan"]["add"],
            "updated": state["plan"]["update"],
            "skipped": state["plan"]["unchanged"],
            "deleted": state["deleted"],
            "failed": 0,
            "read_back_verified": True,
            "snapshot": {
                "version": SNAPSHOT_VERSION,
                "prefetch_pages": state["prefetch_pages"],
                "prefetch_rows": len(state["remote_records"]),
                "slice_rows": validated["slice_rows"],
                "slice_budget_s": validated["slice_budget_s"],
                "max_requests": validated["max_requests"],
                "payload_sha256": payload_sha256,
                "contract_sha256": contract_sha256,
                "slices": (
                    len(_ensure_work_row_indexes(state)) + validated["slice_rows"] - 1
                ) // validated["slice_rows"],
                "work_rows": len(_ensure_work_row_indexes(state)),
                "delete_slices": (
                    state["plan"]["delete"] + _CREATE_BATCH - 1
                ) // _CREATE_BATCH,
                "plan": {
                    "add": state["plan"]["add"], "update": state["plan"]["update"],
                    "delete": state["plan"]["delete"], "unchanged": state["plan"]["unchanged"],
                },
                "field_options_diff": state["plan"]["field_options_diff"],
            },
        }
        _clear_read_phase_records(state, "final_verify")
        state["phase"] = "done"
        state["result"] = result
        save_logical_snapshot_state(conn, job_id, _continuation_state(state))
        return result

    if state.get("phase") == "done":
        return state["result"]
    raise ValueError(f"unknown logical snapshot phase: {state.get('phase')}")
