from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

from .sync_status import queue_job_status as _queue_job_status

from . import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sm-feishu",
        description="Portable asset validation and existing Feishu queue access",
    )
    parser.add_argument("--version", action="store_true", help="print version")
    subparsers = parser.add_subparsers(dest="command")

    asset = subparsers.add_parser("asset", help="validate a local asset contract")
    asset_sub = asset.add_subparsers(dest="asset_command")
    validate = asset_sub.add_parser("validate", help="validate without network access")
    validate.add_argument("path")

    queue = subparsers.add_parser("queue", help="use the existing queue")
    queue_sub = queue.add_subparsers(dest="queue_command")

    q_enqueue = queue_sub.add_parser("enqueue", help="enqueue rows; consumer performs writes")
    q_enqueue.add_argument("--asset", required=True)
    q_enqueue.add_argument("--from", dest="from_session", required=True)
    q_enqueue.add_argument("--key", required=True)
    q_enqueue.add_argument(
        "--skill-provenance", choices=["bitable-ops"], default="",
        help="declare the routing skill for coverage telemetry",
    )
    rows_group = q_enqueue.add_mutually_exclusive_group(required=False)
    rows_group.add_argument("--rows")
    rows_group.add_argument("--payload-json")
    q_enqueue.add_argument(
        "--op",
        default="bitable_rows_upsert",
        choices=[
            "bitable_rows_upsert",
            "bitable_rows_create_if_absent",
            "bitable_rows_update_existing",
            "bitable_rows_replace",
            "bitable_rows_logical_snapshot",
            "bitable_attachment_upload",
            "bitable_attachment_replace_if_current",
            "bitable_attachment_dedupe",
            "bitable_record_delete_if_current",
            "bitable_record_update_if_current",
            "upsert",
        ],
    )
    q_enqueue.add_argument("--max-delete", type=int)
    q_enqueue.add_argument("--delete-guard")
    q_enqueue.add_argument("--snapshot-input-complete", action="store_true")
    q_enqueue.add_argument("--snapshot-confirmation-ref")
    q_enqueue.add_argument("--snapshot-slice-rows", type=int, default=200)
    q_enqueue.add_argument("--snapshot-slice-budget-s", type=float, default=30.0)
    q_enqueue.add_argument("--snapshot-max-requests", type=int, default=20)
    q_enqueue.add_argument("--attach-json")
    q_enqueue.add_argument("--db")
    q_enqueue.add_argument("--registry-glob")
    q_enqueue.add_argument("--no-drain", action="store_true", help=argparse.SUPPRESS)
    q_enqueue.add_argument("--drain-scope", choices=["all", "asset", "none"], default="none",
                           help=argparse.SUPPRESS)
    q_enqueue.add_argument(
        "--wait",
        action="store_true",
        help="wait for this job to reach a terminal readback verdict",
    )
    q_enqueue.add_argument("--wait-timeout-s", type=float, default=300.0)

    q_consumer = queue_sub.add_parser(
        "consumer", help="consume the existing queue and perform terminal readback"
    )
    q_consumer.add_argument("--db")
    q_consumer.add_argument("--registry-glob")
    q_consumer.add_argument("--max-workers", type=int, default=1)
    q_consumer.add_argument("--time-budget-s", type=float, default=60.0)

    q_status = queue_sub.add_parser(
        "status", help="read queue state and terminal readback evidence"
    )
    q_status.add_argument("--db")
    q_status.add_argument("--job-id", type=int, action="append")
    q_status.add_argument("--key", action="append")
    return parser
def _load_rows_arg(args) -> list:
    if args.rows:
        rows_path = Path(args.rows)
        if not rows_path.is_absolute():
            raise ValueError("--rows must be an absolute path (cwd-independent contract)")
        return json.loads(rows_path.read_text(encoding="utf-8"))
    if args.payload_json:
        return json.loads(args.payload_json)
    raise ValueError("--rows or --payload-json is required for this op")


def _build_enqueue_payload(args, asset):
    """按 op 构造队列 payload，并在入队前做机械校验（不触网）。"""
    from .bitable import (
        bitable_upsert_plan,
        check_controlled_attachment_upload,
        check_controlled_rows_update_existing,
        check_controlled_rows_replace,
        check_migration_restore_attachment,
        enforce_migration_write_upsert_shape,
        migration_restore_upsert_grant,
        resolve_migration_write_exception,
        resolve_migration_write_grant,
        validate_record_delete_if_current_payload,
        validate_record_update_if_current_payload,
        validate_rows_create_if_absent_payload,
    )
    from .attachment_dedupe import (
        validate_attachment_dedupe_key,
        validate_attachment_dedupe_payload,
    )

    if asset.authority_model == "derived_projection":
        raise ValueError(
            f"asset {asset.asset_id} is a derived_projection and forbids all data-time writes"
        )
    if asset.sync_direction == "none" and args.op not in {
        "bitable_record_delete_if_current",
        "bitable_record_update_if_current",
        "bitable_rows_update_existing",
        "bitable_attachment_upload",
        "bitable_attachment_replace_if_current",
    }:
        raise ValueError(
            f"asset {asset.asset_id} has sync_direction=none and is not enqueue-able; "
            "this is a register-only/no-default-sync asset"
        )
    if not asset.tables or not asset.tables[0].unique_key:
        raise ValueError(
            f"enqueue rejected: asset {asset.asset_id} has no unique_key; "
            "data-time queue operations require a stable registered key. "
            "Route the schema-time contract change to jianbiao before enqueueing."
        )
    # 迁移写入例外：仅当 op/caller/key 前缀命中合同声明时才非空，据此让本来被字段级权威闸
    # 拒绝的 feishu 列（如 link 列）通过入队机械校验；消耗判定在 drain 侧（见 sync_drain）。
    migration_grant = resolve_migration_write_grant(
        asset, op=args.op, caller_session=args.from_session,
        client_key=getattr(args, "key", None))
    migration_exception = resolve_migration_write_exception(
        asset, op=args.op, caller_session=args.from_session,
        client_key=getattr(args, "key", None))
    if args.op in {"bitable_rows_upsert", "bitable_rows_update_existing"}:
        rows = _load_rows_arg(args)
        grant = migration_grant
        if args.op == "bitable_rows_upsert":
            # 恢复例外（migration_restore_exception）：命中则校验行形状恰为 唯一键∪writable_fields
            # 并把被授 feishu 列并入 grant；未命中恒空、不改变日常 upsert 行为。
            grant = grant | migration_restore_upsert_grant(
                asset, rows, caller_session=args.from_session,
                client_key=getattr(args, "key", None))
            # 写入例外 upsert 变体（migration_write_exception）：命中则校验恰 1 行 + 精确形状
            # （唯一键∪授予列）；未命中(migration_grant 空)恒空、不改变日常 upsert 行为。与 drain 同序先闸。
            enforce_migration_write_upsert_shape(
                asset, rows, migration_grant, exception=migration_exception,
                label="migration_write_exceptions" if migration_exception
                else "migration_write_exception",
            )
        if args.op == "bitable_rows_update_existing":
            check_controlled_rows_update_existing(
                asset, caller_session=args.from_session, rows=rows,
            )
        # queue_op=args.op：upsert 与 update_existing 都在 plan 内执行受控规则。
        bitable_upsert_plan(asset, rows, caller_session=args.from_session,
                            existing_records=[], existing_records_complete=False,
                            queue_op=args.op, migration_grant_fields=grant)
        return rows
    if args.op == "bitable_rows_create_if_absent":
        rows = _load_rows_arg(args)
        validate_rows_create_if_absent_payload(
            asset, rows, caller_session=args.from_session,
        )
        return rows
    if args.op == "bitable_rows_replace":
        if args.max_delete is None:
            raise ValueError("--max-delete is required for bitable_rows_replace (delete safety cap)")
        rows = _load_rows_arg(args)
        bitable_upsert_plan(asset, rows, caller_session=args.from_session,
                            existing_records=[], existing_records_complete=False,
                            queue_op=args.op,
                            migration_grant_fields=migration_grant)
        guard = json.loads(args.delete_guard) if args.delete_guard else None
        if guard is not None:
            allowed = {f.name_zh for f in asset.tables[0].fields}
            if guard.get("field") not in allowed:
                raise ValueError(f"delete_guard field not in contract: {guard.get('field')}")
        # 受控替换闸（入队即拒，与 drain 同序）：非 owner 必须命中合同
        # controlled_data_time_updates 里 op=bitable_rows_replace 的规则（caller / 行字段 /
        # delete_guard / max_delete 精确匹配），否则不入队。
        check_controlled_rows_replace(
            asset, caller_session=args.from_session, rows=rows,
            delete_guard=guard, max_delete=args.max_delete)
        return {"rows": rows, "delete_guard": guard, "max_delete": args.max_delete}
    if args.op == "bitable_rows_logical_snapshot":
        from .logical_snapshot import SNAPSHOT_VERSION, validate_snapshot_payload

        if args.max_delete is None:
            raise ValueError("--max-delete is required for logical snapshot")
        if not args.delete_guard:
            raise ValueError("--delete-guard is required for logical snapshot")
        if not args.snapshot_input_complete:
            raise ValueError("--snapshot-input-complete is required for logical snapshot")
        if not args.snapshot_confirmation_ref:
            raise ValueError("--snapshot-confirmation-ref is required for logical snapshot")
        rows = _load_rows_arg(args)
        guard = json.loads(args.delete_guard)
        payload = {
            "rows": rows,
            "delete_guard": guard,
            "max_delete": args.max_delete,
            "snapshot": {
                "version": SNAPSHOT_VERSION,
                "input_complete": True,
                "source_row_count": len(rows),
                "confirmation_ref": args.snapshot_confirmation_ref,
                "slice_rows": args.snapshot_slice_rows,
                "slice_budget_s": args.snapshot_slice_budget_s,
                "max_requests": args.snapshot_max_requests,
            },
        }
        validate_snapshot_payload(asset, payload, caller_session=args.from_session)
        return payload
    if args.op == "bitable_attachment_upload":
        if not args.attach_json:
            raise ValueError("--attach-json is required for bitable_attachment_upload")
        spec_path = Path(args.attach_json)
        spec = json.loads(spec_path.read_text(encoding="utf-8")) if spec_path.exists() else json.loads(args.attach_json)
        table = asset.tables[0]
        # 恢复例外（migration_restore_exception）：命中(caller+key前缀)则 field/unique_key 必须
        # 恰为声明形状（不匹配 raise）；未命中恒 False、不改变日常附件上传行为。与 drain 同序先闸。
        check_migration_restore_attachment(
            asset, field=spec.get("field"), unique_key_values=spec.get("unique_key"),
            caller_session=args.from_session, client_key=getattr(args, "key", None))
        # 受控附件上传闸（入队即拒，与 drain 同序）：非 owner 必须命中合同
        # controlled_data_time_updates 里 op=bitable_attachment_upload 的规则（caller /
        # field / unique_key 精确匹配），否则不入队。
        check_controlled_attachment_upload(
            asset, field=spec.get("field"), unique_key_values=spec.get("unique_key"),
            caller_session=args.from_session)
        field_def = next((f for f in table.fields if f.name_zh == spec.get("field")), None)
        if field_def is None or field_def.type != "attachment":
            raise ValueError(f"field must be an attachment column in contract: {spec.get('field')}")
        for key in table.unique_key:
            if not spec.get("unique_key", {}).get(key):
                raise ValueError(f"missing unique key {key} in attach-json")
        for path in spec.get("files", []):
            if not Path(path).is_absolute():
                raise ValueError(f"attachment file must be an absolute path: {path}")
            if not Path(path).exists():
                raise ValueError(f"attachment file does not exist: {path}")
        return spec
    if args.op == "bitable_attachment_replace_if_current":
        from .attachment_replace import (
            ATTACHMENT_REPLACE_OP,
            check_controlled_attachment_replace,
            make_attachment_replace_dedupe_key,
            validate_attachment_replace_payload,
        )

        if not args.payload_json:
            raise ValueError(f"--payload-json is required for {ATTACHMENT_REPLACE_OP}")
        payload = json.loads(args.payload_json)
        validate_attachment_replace_payload(payload)
        check_controlled_attachment_replace(
            asset, field_id=payload.get("field_id"), caller_session=args.from_session
        )
        expected_key = make_attachment_replace_dedupe_key(asset.asset_id, payload)
        if args.key != expected_key:
            raise ValueError(
                "attachment replace dedupe key must bind asset, record, field, expected hash, "
                f"and all new file content SHA256: expected {expected_key}"
            )
        return payload
    if args.op == "bitable_record_update_if_current":
        if not args.payload_json:
            raise ValueError("--payload-json is required for bitable_record_update_if_current")
        payload = json.loads(args.payload_json)
        if not isinstance(payload, dict):
            raise ValueError("payload-json must be an object for bitable_record_update_if_current")
        validate_record_update_if_current_payload(
            asset,
            payload,
            caller_session=args.from_session,
            client_key=getattr(args, "key", None),
        )
        return payload
    if args.op == "bitable_record_delete_if_current":
        if not args.payload_json:
            raise ValueError("--payload-json is required for bitable_record_delete_if_current")
        payload_path = Path(args.payload_json)
        if payload_path.is_absolute():
            if not payload_path.is_file():
                raise ValueError(
                    "delete payload-json absolute path must name an existing file: "
                    + str(payload_path)
                )
            payload = json.loads(payload_path.read_text(encoding="utf-8"))
        else:
            payload = json.loads(args.payload_json)
        if not isinstance(payload, dict):
            raise ValueError("payload-json must be an object for bitable_record_delete_if_current")
        validate_record_delete_if_current_payload(
            asset,
            payload,
            caller_session=args.from_session,
            client_key=getattr(args, "key", None),
        )
        return payload
    if args.op == "bitable_attachment_dedupe":
        if args.drain_scope != "asset" or args.no_drain:
            raise ValueError("bitable_attachment_dedupe requires --drain-scope=asset")
        if not args.payload_json:
            raise ValueError("--payload-json is required for bitable_attachment_dedupe")
        payload = json.loads(args.payload_json)
        validate_attachment_dedupe_payload(
            asset,
            payload,
            caller_session=args.from_session,
        )
        validate_attachment_dedupe_key(args.key, payload)
        return payload
    raise ValueError(f"unsupported op: {args.op}")


def _enqueue_job_ids(out: dict[str, Any]) -> list[int]:
    if out.get("chunked"):
        return [int(job_id) for job_id in out.get("job_ids", [])]
    if "job_id" in out:
        return [int(out["job_id"])]
    return []


def _enqueue_submission(out: dict[str, Any]) -> str:
    if out.get("coalesced"):
        return "latest_pending_replaced"
    if out.get("retried"):
        return "retry_accepted"
    if out.get("duplicate"):
        return "duplicate_accepted"
    return "accepted"


def _load_queue_job_snapshots(db_path: Path | None, job_ids: list[int]) -> list[dict[str, Any]]:
    if not job_ids:
        return []
    from .sync_queue import connect

    conn = connect(db_path)
    try:
        placeholders = ",".join("?" for _ in job_ids)
        rows = conn.execute(
            "SELECT j.id, j.dedupe_key, j.op, j.status, j.attempts, j.slice_claims, j.started_at,"
            " j.processed_at, j.receipt_ref, j.last_error, s.state_json"
            " FROM sync_jobs j LEFT JOIN sync_logical_snapshots s ON s.job_id=j.id"
            f" WHERE j.id IN ({placeholders})",
            job_ids,
        ).fetchall()
    finally:
        conn.close()
    by_id = {}
    for row in rows:
        item = dict(row)
        state_json = item.pop("state_json", None)
        if state_json:
            item["logical_snapshot"] = json.loads(state_json)
        by_id[int(row["id"])] = item
    return [by_id[job_id] for job_id in job_ids if job_id in by_id]


def _queue_job_status(db_path: Path | None, *, job_ids: list[int], keys: list[str]) -> dict[str, Any]:
    from .sync_status import queue_job_status

    return queue_job_status(db_path, job_ids=job_ids, keys=keys)


def _enqueue_message(job_state: str, terminal: bool) -> str:
    if job_state == "in_progress":
        return (
            "accepted:already_running; job_state_at_response is a queue snapshot,"
            " not a submission failure; do not bypass direct write or resubmit"
        )
    if job_state == "pending":
        return "accepted:queued; background drain will write via wendangwang queue"
    if job_state == "done":
        return (
            "verified_done:terminal; status=done already proves queue read-back verification;"
            " receipt_ref is an owner audit locator, not a caller file API"
        )
    if job_state == "failed" or (terminal and job_state == "mixed"):
        return (
            "terminal_failed:terminal; diagnose from last_error; receipt_ref is an owner"
            " audit locator, not a caller file API"
        )
    return "accepted:mixed_job_states; see job_states_at_response"


def _shape_enqueue_response(out: dict[str, Any], *, db_path: Path | None) -> dict[str, Any]:
    """External queue response: top-level status describes submission acceptance.

    The queue job status is deliberately moved under job_state_at_response so callers
    do not confuse a transient in_progress snapshot with a rejected submission.
    """
    job_ids = _enqueue_job_ids(out)
    snapshots = _load_queue_job_snapshots(db_path, job_ids)
    state_counts: dict[str, int] = {}
    for snapshot in snapshots:
        state_counts[snapshot["status"]] = state_counts.get(snapshot["status"], 0) + 1
    if len(state_counts) == 1:
        job_state = next(iter(state_counts))
    elif state_counts:
        job_state = "mixed"
    else:
        job_state = out.get("status", "unknown")
    terminal = bool(snapshots) and all(
        snapshot["status"] in {"done", "failed"} for snapshot in snapshots
    )
    receipt_refs = sorted({
        snapshot["receipt_ref"] for snapshot in snapshots if snapshot.get("receipt_ref")
    })
    result = {
        "ok": True,
        **out,
        "accepted": True,
        "submission": _enqueue_submission(out),
        "status": "accepted",
        "job_state_at_response": job_state,
        "job_states_at_response": state_counts,
        "terminal": terminal,
        "message": _enqueue_message(job_state, terminal),
    }
    if receipt_refs:
        result["receipt_ref"] = receipt_refs[0] if len(receipt_refs) == 1 else receipt_refs
    if len(snapshots) == 1 and snapshots[0]["op"] == "bitable_attachment_replace_if_current":
        from .attachment_replace import attachment_retry_advice
        from .sync_queue import attachment_retry_authorization_for_job, connect

        snapshot = snapshots[0]
        conn = connect(db_path)
        try:
            retry_authorization = attachment_retry_authorization_for_job(
                conn, int(snapshot["id"])
            )
        finally:
            conn.close()
        result["attachment_retry"] = attachment_retry_advice(
            op=snapshot["op"], dedupe_key=snapshot["dedupe_key"],
            status=snapshot["status"], last_error=snapshot["last_error"],
            retry_authorization=retry_authorization,
        )
    return result


def _enqueue_write_unconfirmed(
    *, out_error: Exception, db_path: Path | None, asset_id: str,
    dedupe_key: str, wait: bool, timeout_s: float, registry_glob: str,
) -> tuple[dict[str, Any], int]:
    """Return a safe same-key disposition after an enqueue lock failure."""
    try:
        status = _queue_job_status(db_path, job_ids=[], keys=[dedupe_key])
    except Exception as exc:  # noqa: BLE001 - status must remain structured on lock failure
        status = {"ok": False, "error": str(exc), "found": 0, "jobs": []}
    jobs = status.get("jobs") or []
    if len(jobs) == 1:
        existing = jobs[0]
        existing_out = {
            "job_id": int(existing["id"]),
            "status": existing.get("status", "unknown"),
            "duplicate": True,
        }
        if wait and existing.get("status") not in _WAIT_TERMINAL_STATES:
            result, rc = _enqueue_wait_convergence(
                existing_out, db_path=db_path, asset_id=asset_id,
                registry_glob=registry_glob, timeout_s=timeout_s,
            )
            result["enqueue_confirmation"] = "same_key_existing_after_lock_failure"
            result["enqueue_error"] = str(out_error)
            return result, rc
        result = _shape_enqueue_response(existing_out, db_path=db_path)
        result["enqueue_confirmation"] = "same_key_existing_after_lock_failure"
        result["enqueue_error"] = str(out_error)
        state = existing.get("status")
        return (
            result,
            0 if state in {"done", "superseded"} else 1 if state == "failed" else 2,
        )
    result = {
        "ok": False,
        "accepted": False,
        "confirmed": False,
        "asset_id": asset_id,
        "dedupe_key": dedupe_key,
        "status": "unconfirmed",
        "submission": "enqueue_unconfirmed",
        "terminal": False,
        "waited": False,
        "wait_timed_out": False,
        "enqueue_error": str(out_error),
        "message": (
            "enqueue not confirmed; query the same dedupe key with "
            "bin/feishu-sync-status; do not use a new key or direct write"
        ),
    }
    if status.get("error"):
        result["status_query_error"] = status["error"]
    return result, 2


def _skill_provenance_adoption(skill_provenance: str) -> dict[str, str]:
    """Return a compatibility-safe next action for queue coverage adoption."""
    if skill_provenance == "bitable-ops":
        return {
            "status": "declared",
            "required_value": "bitable-ops",
            "next_invocation": "declaration counted in the bitable-ops activation-rate window",
        }
    return {
        "status": "missing",
        "required_value": "bitable-ops",
        "next_invocation": "append --skill-provenance bitable-ops to subsequent enqueue calls",
    }


_WAIT_TERMINAL_STATES = {"done", "failed", "superseded", "cancelled"}


def _recover_wait_ambiguous_create_if_absent(
    snapshots: list[dict[str, Any]], *, db_path: Path | None, registry_glob: str,
) -> tuple[int, bool]:
    """Reconcile only a terminal controlled create that was never safe to replay."""
    from .sync_drain import (
        _AMBIGUOUS_CREATE_RECOVERY_MARKER,
        recover_ambiguous_create,
    )

    recovered = 0
    recovery_lock_busy = False
    for snapshot in snapshots:
        if (
            snapshot.get("status") != "failed"
            or snapshot.get("op") != "bitable_rows_create_if_absent"
            or _AMBIGUOUS_CREATE_RECOVERY_MARKER not in str(snapshot.get("last_error") or "")
        ):
            continue
        result = recover_ambiguous_create(
            job_id=int(snapshot["id"]),
            db_path=db_path,
            registry_glob=registry_glob,
        )
        if result.get("ok"):
            recovered += 1
        elif not result.get("terminal", True):
            recovery_lock_busy = True
    return recovered, recovery_lock_busy


def _enqueue_wait_convergence(
    out: dict[str, Any], *, db_path: Path | None, asset_id: str,
    registry_glob: str, timeout_s: float,
    sleeper: Any = time.sleep,
) -> tuple[dict[str, Any], int]:
    """--wait：发起方同步收敛自己刚入队的 job 到终态（2026-07-18 摩擦审计 P0-②：
    「确认写完了」此前不自助，150 条/月保姆 spawn 全由此来）。

    只做本 asset 作用域 drain（per-asset 锁，绝不占全局锁）+ 快照轮询；受控
    create_if_absent 的 ambiguous terminal 会走双读 + 原 job CAS 收敛，绝不重放 create。
    与 minute tick 并发安全：SQL 原子 claim 防双领，锁被占说明有人正在干本 asset、退避后看快照即可。
    超时不是失败：返回当前快照，caller 用 bin/feishu-sync-status 继续查。
    exit code：0=全部 done（superseded 视同被更新内容取代）；1=有 failed/cancelled；2=超时未终态。
    """
    from .sync_drain import drain

    job_ids = _enqueue_job_ids(out)
    deadline = time.monotonic() + max(0.0, timeout_s)
    totals = {
        "done": 0,
        "failed": 0,
        "requeued": 0,
        "reconciled": 0,
        "ledger_pending": 0,
    }
    rounds = 0
    while job_ids:
        snapshots = _load_queue_job_snapshots(db_path, job_ids)
        if snapshots and all(s["status"] in _WAIT_TERMINAL_STATES for s in snapshots):
            recovered, recovery_lock_busy = _recover_wait_ambiguous_create_if_absent(
                snapshots, db_path=db_path, registry_glob=registry_glob,
            )
            if recovered:
                totals["reconciled"] += recovered
                continue
            if recovery_lock_busy and deadline - time.monotonic() > 0:
                sleeper(min(0.2, max(0.0, deadline - time.monotonic())))
                continue
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        summary = drain(
            db_path=db_path, registry_glob=registry_glob, asset_scope=asset_id,
            lock_wait_s=min(5.0, remaining), time_budget_s=remaining,
        )
        rounds += 1
        for key in totals:
            totals[key] += int(summary.get(key) or 0)
        if summary.get("locked") or summary.get("requeued"):
            sleeper(min(2.0, max(0.0, deadline - time.monotonic())))
    result = _shape_enqueue_response(out, db_path=db_path)
    snapshots = _load_queue_job_snapshots(db_path, job_ids)
    states = {snapshot["status"] for snapshot in snapshots}
    timed_out = bool(job_ids) and not (states and states <= _WAIT_TERMINAL_STATES)
    result["waited"] = True
    result["wait_rounds"] = rounds
    result["wait_timed_out"] = timed_out
    result["drained"] = {
        **totals, "locked": False,
        "requested_scope": "asset", "skipped": None, "mode": "wait_scoped",
    }
    if timed_out:
        result["message"] = (
            "accepted:wait_timeout; jobs not terminal within wait budget —"
            " poll bin/feishu-sync-status with job_id/key; do not re-enqueue the"
            " same key and do not spawn wendangwang"
        )
        return result, 2
    if states <= {"done", "superseded"}:
        return result, 0
    return result, 1


_CHILD_SESSION_PREFIX = "child_"


def _resolve_runtime_session_owner(name: str) -> str:
    """child_<parent>_<suffix> 递归解析回顶层 owner session 名（§245 同款规则）。"""
    for _ in range(8):
        if not name.startswith(_CHILD_SESSION_PREFIX):
            return name
        inner = name[len(_CHILD_SESSION_PREFIX):]
        parent, sep, _suffix = inner.rpartition("_")
        if not sep or not parent:
            return name
        name = parent
    return name


_CALLER_IDENTITY_TIMEOUT_S = 2.0


def _caller_identity_url() -> str:
    """SuperMatrix loopback API（端口沿用平台约定 SM_API_PORT，默认 3501）。"""
    port = os.environ.get("SM_API_PORT", "").strip() or "3501"
    return f"http://127.0.0.1:{port}/api/caller-identity"


def _unattested(reason: str, from_session: str, **extra: Any) -> dict[str, Any]:
    """unattested 是一个**明确的答案**，不是身份：不带任何 owner 字段。"""
    return {
        "state": "unattested",
        "reason": reason,
        "claimed_from_session": from_session.strip(),
        "from_session_self_reported": True,
        **extra,
    }


def _resolve_caller_provenance(from_session: str) -> dict[str, Any]:
    """问运行时「这个调用方是谁」，绝不本地解释 SM_CALLER_ATTESTATION、绝不采信自报名字。

    契约：SuperMatrix `docs/caller-provenance-boundary.md`（owner=codexroot）。身份只能是
    `POST /api/caller-identity` 200 响应里的 `ownerSessionName`；无 token / 403 / 端点不可达
    一律归 `unattested`——合法（scheduler script 任务、人工终端、kimi 共享 ACP 进程拿不到
    token）但**不是身份**，不得升级成自报的 owner。

    **两种状态都不承载 owner 写权限**：同 uid 的兄弟进程能用 `ps -Ewww -p <pid>` 读到后端
    进程的 env（契约 E1 更正结论），token 因此可被搬运重放，端点自己回 `ownerAuthority:false`。
    所以解析结果只用于 ①落库 provenance ②与 `--from` 比对抓漂移，绝不当授权用。
    """
    if os.environ.get("SM_FEISHU_NAMESPACE_MODE", "").strip() == "standalone":
        return _unattested("standalone_namespace", from_session)
    token = os.environ.get("SM_CALLER_ATTESTATION", "").strip()
    if not token:
        # 无 token 即无身份，不必打端点：存量热路径（66k+ scheduler 入队）不加 loopback 往返。
        return _unattested(
            "no_attestation_token", from_session,
            runtime_session_name_env=os.environ.get("SM_SESSION_NAME", "").strip(),
        )

    import urllib.error
    import urllib.request

    request = urllib.request.Request(
        _caller_identity_url(),
        data=json.dumps({"token": token}).encode("utf-8"),  # 端点是 .strict()：只能带 token
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_CALLER_IDENTITY_TIMEOUT_S) as response:
            body = json.loads(response.read().decode("utf-8"))
            status = response.status
    except urllib.error.HTTPError as exc:
        # 403 = token 不解析（伪造/过期/已随 run 结束回收）；其余状态码（如运行时尚未
        # 加载 0f2088e 时的 404）都当端点答不了。两者都不是身份。
        reason = "attestation_rejected" if exc.code == 403 else "runtime_unavailable"
        return _unattested(reason, from_session, endpoint_status=exc.code)
    except TimeoutError:
        return _unattested("runtime_timeout", from_session)
    except (urllib.error.URLError, OSError) as exc:
        # URLError 会把 socket.timeout 包在 .reason 里，单独辨一次，别把超时说成不可达。
        if isinstance(getattr(exc, "reason", None), TimeoutError):
            return _unattested("runtime_timeout", from_session)
        return _unattested("runtime_unavailable", from_session)
    except json.JSONDecodeError:
        return _unattested("runtime_unavailable", from_session)

    session_name = str(body.get("sessionName") or "")
    owner_session_name = str(body.get("ownerSessionName") or session_name)
    if status != 200 or body.get("attested") is not True or not owner_session_name:
        return _unattested("runtime_unavailable", from_session, endpoint_status=status)
    return {
        "state": "attested",
        "session_name": session_name,
        "owner_session_name": owner_session_name,
        "backend": str(body.get("backend") or ""),
        # 端点自报本次解析是否可作为 owner 授权。今天恒为 false（token 可被同 uid 兄弟
        # 进程从 env 里搬走重放）；照抄它，不自己推断、不因缺省而默认成 true。
        "owner_authority": body.get("ownerAuthority") is True,
        "resolved_by": "supermatrix_caller_identity",
        "claimed_from_session": from_session.strip(),
    }


def _enqueue_provenance_gate(from_session: str) -> tuple[dict[str, Any], str | None]:
    """返回 (来源判定, 拒绝原因|None)。判定要落库，别只用于放行/拒绝。"""
    provenance = _resolve_caller_provenance(from_session)
    if provenance["state"] == "attested":
        resolved = provenance["owner_session_name"]
        if resolved == from_session.strip():
            return provenance, None
        return provenance, (
            f"enqueue rejected: caller attestation mismatch: --from={from_session!r} but "
            f"SuperMatrix resolved this caller as {provenance['session_name']!r} "
            f"(owner {resolved!r}); "
            "enqueue under your own session name — 冒用他人 owner 身份写登记表已被拒绝"
        )
    # unattested：保留旧的 SM_SESSION_NAME 名字闸作为弱兜底（它可伪造，只挡「跑偏的 agent」），
    # 缺失 env 时照旧放行，否则会一刀切断 scheduler script / 人工终端 / kimi 路径。
    return provenance, _enqueue_attestation_rejection(from_session)


def _enqueue_attestation_rejection(from_session: str) -> str | None:
    """--from 是自报字段；SuperMatrix 后端会给每个 session 进程注入 SM_SESSION_NAME。
    两者不一致就拒绝入队——A session 不能自报成 B、往 B 的登记表写行（漂移/receipt
    provenance 全按 from_session 归属，误归属会把责任记到无辜 owner 头上）。

    边界（诚实标注，别把它当认证）：所有 session 跑在同一个 OS 用户下，env 可伪造、
    队列 DB 可直写、lark-cli 可绕过——这是**误归属闸**，不是不可伪造的身份认证；真正
    不可伪造需要独立 UID 守护进程 + peer credential，属于明确非目标（反重基建）。
    SM_SESSION_NAME 缺失（scheduler script 任务、人工终端）保持放行=unattested，
    否则会一刀切断存量 script 入队链路。
    """
    if os.environ.get("SM_FEISHU_NAMESPACE_MODE", "").strip() == "standalone":
        return None
    attested = os.environ.get("SM_SESSION_NAME", "").strip()
    if not attested:
        return None
    resolved = _resolve_runtime_session_owner(attested)
    if resolved == from_session.strip():
        return None
    return (
        f"enqueue rejected: caller attestation mismatch: --from={from_session!r} but "
        f"runtime session is {attested!r} (resolved owner {resolved!r}); "
        "enqueue under your own session name — 冒用他人 owner 身份写登记表已被拒绝"
    )


def _queue_drain_rejection() -> str | None:
    if os.environ.get("SM_FEISHU_NAMESPACE_MODE", "").strip() == "standalone":
        return None
    session_name = os.environ.get("SM_SESSION_NAME", "").strip()
    if _resolve_runtime_session_owner(session_name) != "wendangwang":
        caller = session_name or "<missing>"
        return (
            "queue drain rejected: data-time table writes are executed only by "
            "wendangwang queue consumer/tick; caller session "
            f"{caller!r} must enqueue with bin/feishu-sync-enqueue and check "
            "bin/feishu-sync-status"
        )
    return None


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(f"sm-feishu {__version__}")
        return 0

    if args.command == "asset" and args.asset_command == "validate":
        from .registry import load_asset_contract
        from .validation import ContractError

        try:
            asset = load_asset_contract(Path(args.path))
        except ContractError as exc:
            print(f"invalid asset contract: {exc}", file=sys.stderr)
            return 1
        print(f"valid {asset.asset_id}")
        return 0

    if args.command == "queue" and args.queue_command == "enqueue":
        from .sync_drain import DEFAULT_REGISTRY_GLOB, _load_contract_index
        from .sync_queue import QueueWriteUnavailable, connect, enqueue

        caller_provenance, attestation_rejection = _enqueue_provenance_gate(args.from_session)
        if attestation_rejection:
            print(attestation_rejection, file=sys.stderr)
            return 1
        if args.db and not Path(args.db).exists():
            print(
                f"enqueue rejected: unknown --db path {args.db}"
                " (refusing to create a new queue database; drop --db to use the canonical queue)",
                file=sys.stderr,
            )
            return 1
        try:
            if args.op == "upsert":
                args.op = "bitable_rows_upsert"
            registry_glob = args.registry_glob or DEFAULT_REGISTRY_GLOB
            contracts = _load_contract_index(registry_glob)
            asset = contracts.get(args.asset)
            if asset is None:
                raise ValueError(f"unknown asset_id: {args.asset}")
            if not asset.base_token or not asset.tables:
                raise ValueError(f"asset {args.asset} is not an enqueue-able table asset")
            if args.op == "bitable_rows_logical_snapshot" and args.wait:
                raise ValueError(
                    "logical snapshot enqueue forbids --wait; existing worker owns writes"
                )
            payload = _build_enqueue_payload(args, asset)
            coalesce_unique_fields = (
                asset.tables[0].unique_key
                if asset.queue_pending_policy == "latest_by_unique_key"
                else None
            )
            db_path = Path(args.db) if args.db else None
            conn = None
            try:
                conn = connect(db_path)
                out = enqueue(
                    conn,
                    dedupe_key=args.key,
                    asset_id=args.asset,
                    from_session=args.from_session,
                    op=args.op,
                    payload=payload,
                    coalesce_unique_fields=coalesce_unique_fields,
                    caller_provenance=json.dumps(
                        caller_provenance, ensure_ascii=False, sort_keys=True
                    ),
                    skill_provenance=args.skill_provenance,
                )
            finally:
                if conn is not None:
                    conn.close()
            if args.wait:
                result, wait_rc = _enqueue_wait_convergence(
                    out,
                    db_path=db_path,
                    asset_id=args.asset,
                    registry_glob=registry_glob,
                    timeout_s=args.wait_timeout_s,
                )
                result["caller_provenance"] = caller_provenance
                result["skill_provenance"] = args.skill_provenance
                result["skill_provenance_adoption"] = _skill_provenance_adoption(
                    args.skill_provenance
                )
                print(json.dumps(result, ensure_ascii=False, sort_keys=True))
                return wait_rc
            result = _shape_enqueue_response(out, db_path=db_path)
            result["caller_provenance"] = caller_provenance
            result["skill_provenance"] = args.skill_provenance
            result["skill_provenance_adoption"] = _skill_provenance_adoption(
                args.skill_provenance
            )
            requested_scope = "none" if args.no_drain else args.drain_scope
            skipped = (
                "chunked_defer_to_wendangwang_queue_drain"
                if result.get("chunked")
                else "defer_to_wendangwang_queue_drain"
            )
            result["drained"] = {
                "locked": False,
                "done": 0,
                "failed": 0,
                "requeued": 0,
                "requested_scope": requested_scope,
                "skipped": skipped,
            }
        except (ValueError, OSError, json.JSONDecodeError) as exc:
            message = str(exc)
            if not message.startswith("enqueue rejected:"):
                message = f"enqueue rejected: {message}"
            print(message, file=sys.stderr)
            return 1
        except (sqlite3.OperationalError, QueueWriteUnavailable) as exc:
            result, result_rc = _enqueue_write_unconfirmed(
                out_error=exc,
                db_path=db_path,
                asset_id=args.asset,
                dedupe_key=args.key,
                wait=args.wait,
                timeout_s=args.wait_timeout_s,
                registry_glob=registry_glob,
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
            return result_rc
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0

    if args.command == "queue" and args.queue_command == "consumer":
        from .sync_drain import DEFAULT_REGISTRY_GLOB, drain

        rejection = _queue_drain_rejection()
        if rejection:
            print(rejection, file=sys.stderr)
            return 1
        summary = drain(
            db_path=Path(args.db) if args.db else None,
            registry_glob=args.registry_glob or DEFAULT_REGISTRY_GLOB,
            max_workers=args.max_workers,
            time_budget_s=args.time_budget_s,
        )
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return (
            0
            if not summary["failed"]
            and not summary.get("ledger_pending")
            and not summary.get("fatal_error")
            else 1
        )

    if args.command == "queue" and args.queue_command == "status":
        from .sync_queue import connect, status_counts

        job_ids = args.job_id or []
        keys = args.key or []
        if job_ids or keys:
            status = _queue_job_status(
                Path(args.db) if args.db else None,
                job_ids=job_ids,
                keys=keys,
            )
            print(json.dumps(status, ensure_ascii=False, sort_keys=True))
            return 0 if status["found"] else 1
        conn = connect(Path(args.db) if args.db else None)
        counts = status_counts(conn)
        conn.close()
        print(json.dumps(counts, ensure_ascii=False, sort_keys=True))
        return 0

    parser.print_help()
    return 2
if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
