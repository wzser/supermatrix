from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .sync_queue import DEFAULT_DB, _payload_rows


STATUS_OPEN_MAX_ATTEMPTS = 3
STATUS_OPEN_RETRY_DELAY_SECONDS = 0.05
# 30 天误报统计：正常大批量 replace/upsert 落在 2-6 分钟；超过 15 分钟才值得人工排查。
IN_PROGRESS_ESCALATE_SECONDS = 15 * 60

_EMPTY_PROVENANCE = {
    "receipt_id": "",
    "read_back_verified": False,
    "receipt_job_verified": False,
}

_EMPTY_VERDICT = {
    "verdict_final": False,
    "verdict_receipt_id": "",
    "verdict_receipt_path": "",
}


def _connect_status_read_only(path: Path) -> sqlite3.Connection:
    # WAL may need to create its disposable shared-memory sidecar before it can
    # serve a snapshot. Open with that capability, then prohibit every SQL write
    # before starting the status read transaction.
    uri = f"{path.resolve().as_uri()}?mode=rw"
    for attempt in range(STATUS_OPEN_MAX_ATTEMPTS):
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(uri, uri=True)
            conn.execute("PRAGMA query_only=ON")
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN")
            conn.execute("SELECT 1 FROM sqlite_schema LIMIT 1").fetchone()
            return conn
        except sqlite3.OperationalError:
            if conn is not None:
                conn.close()
            if attempt + 1 == STATUS_OPEN_MAX_ATTEMPTS or not path.exists():
                raise
            time.sleep(STATUS_OPEN_RETRY_DELAY_SECONDS)
    raise AssertionError("unreachable")


def _resolve_receipt_path(receipt_ref: object) -> Path | None:
    path = Path(str(receipt_ref))
    if path.is_absolute():
        return path
    owner_root = DEFAULT_DB.parent.parent.resolve()
    resolved = (owner_root / path).resolve()
    try:
        resolved.relative_to(owner_root)
    except ValueError:
        return None
    return resolved


def job_receipt_provenance(job: Mapping[str, Any]) -> dict[str, Any]:
    """Derive a safe job-to-receipt proof from owner queue state and receipt storage."""
    if job.get("status") != "done" or not job.get("receipt_ref"):
        return dict(_EMPTY_PROVENANCE)

    receipt_path = _resolve_receipt_path(job["receipt_ref"])
    if receipt_path is None:
        return dict(_EMPTY_PROVENANCE)

    try:
        receipts = [
            json.loads(line)
            for line in receipt_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        return dict(_EMPTY_PROVENANCE)
    if not all(isinstance(receipt, dict) for receipt in receipts):
        return dict(_EMPTY_PROVENANCE)

    relevant = [
        receipt
        for receipt in receipts
        if receipt.get("source") == "sync-queue-drain"
        and receipt.get("job_id") == job.get("id")
        and receipt.get("dedupe_key") == job.get("dedupe_key")
    ]
    if not relevant:
        return dict(_EMPTY_PROVENANCE)

    final_receipt = relevant[-1]
    receipt_id = final_receipt.get("receipt_id")
    if (
        not isinstance(receipt_id, str)
        or not receipt_id
        or final_receipt.get("asset_id") != job.get("asset_id")
        or final_receipt.get("caller_session") != job.get("from_session")
        or final_receipt.get("read_back_verified") is not True
        or final_receipt.get("status") not in (None, "done")
        or sum(receipt.get("receipt_id") == receipt_id for receipt in receipts) != 1
    ):
        return dict(_EMPTY_PROVENANCE)

    return {
        "receipt_id": receipt_id,
        "read_back_verified": True,
        "receipt_job_verified": True,
        **(
            {"remote_deleted": int(final_receipt.get("deleted") or 0)}
            if "deleted" in final_receipt else {}
        ),
    }


def failed_job_verdict_provenance(
    job: Mapping[str, Any], *, ack_receipt_ref: object | None = None
) -> dict[str, Any]:
    """Point a terminally failed dead-letter job back at its recorded final verdict.

    Read-only mirror of job_receipt_provenance's shape: path-safe resolution plus
    field-level binding of the receipt to this job before trusting it.
    """
    if job.get("status") != "failed":
        return dict(_EMPTY_VERDICT)
    if ack_receipt_ref is None:
        ack_receipt_ref = os.environ.get("SM_DEAD_LETTER_ACK_RECEIPT", "")
    receipt_path = _resolve_receipt_path(ack_receipt_ref)
    if receipt_path is None or not receipt_path.exists():
        return dict(_EMPTY_VERDICT)

    try:
        receipts = [
            json.loads(line)
            for line in receipt_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except (OSError, UnicodeError, json.JSONDecodeError):
        return dict(_EMPTY_VERDICT)
    if not all(isinstance(receipt, dict) for receipt in receipts):
        return dict(_EMPTY_VERDICT)

    relevant = [
        receipt
        for receipt in receipts
        if receipt.get("receipt_type") == "dead_letter_owner_ack"
        and receipt.get("action") == "final_verdict"
        and receipt.get("verdict") == "final"
        and isinstance(receipt.get("job_ids"), list)
        and job.get("id") in receipt["job_ids"]
    ]
    if not relevant:
        return dict(_EMPTY_VERDICT)

    final_receipt = relevant[-1]
    receipt_id = final_receipt.get("receipt_id")
    if (
        not isinstance(receipt_id, str)
        or not receipt_id
        or not str(final_receipt.get("owner_session") or "").strip()
        or not str(final_receipt.get("evidence_ref") or "").strip()
        or sum(receipt.get("receipt_id") == receipt_id for receipt in receipts) != 1
    ):
        return dict(_EMPTY_VERDICT)

    return {
        "verdict_final": True,
        "verdict_receipt_id": receipt_id,
        "verdict_receipt_path": str(receipt_path),
    }


def _parse_utc(timestamp: object) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(timestamp))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _local_time_display(started: datetime) -> str:
    # 展示层转本地时区；存储保持 UTC 不动。
    return started.astimezone().strftime("%Y-%m-%d %H:%M:%S")


def _human_elapsed(seconds: float) -> str:
    minutes, secs = divmod(max(int(seconds), 0), 60)
    return f"{minutes} 分 {secs} 秒" if minutes else f"{secs} 秒"


def _in_progress_human(job: Mapping[str, Any]) -> str:
    parts = [str(job.get("op") or "")]
    row_count = job.get("payload_row_count")
    if row_count is not None:
        parts[0] += f" {row_count} 行"
    started = _parse_utc(job.get("started_at") or job.get("enqueued_at"))
    if started is not None:
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        parts.append(
            f"开始于 {_local_time_display(started)}（本地时间），已运行 {_human_elapsed(elapsed)}"
        )
        if elapsed < IN_PROGRESS_ESCALATE_SECONDS:
            parts.append("大批量 replace/upsert 正常需要数分钟，属正常执行，无需报修")
        else:
            parts.append("超出常规耗时，可 spawn wendangwang 排查")
    return "；".join(part for part in parts if part)


def _pending_human(job: Mapping[str, Any]) -> str:
    parts = []
    enqueued = _parse_utc(job.get("enqueued_at"))
    if enqueued is not None:
        parts.append(f"排队于 {_local_time_display(enqueued)}（本地时间）")
    queue_ahead = job.get("queue_ahead")
    if queue_ahead:
        parts.append(f"同资产任务排队中（前面还有 {queue_ahead} 个），per-asset 锁串行属正常")
    return "；".join(parts)


def _status_message(job: Mapping[str, Any]) -> str:
    status = job["status"]
    if status == "done" and job["receipt_job_verified"]:
        return "verified_done:terminal; owner receipt belongs to job and read-back is verified"
    if status == "done":
        return "terminal_done_unverified: owner receipt linkage or read-back proof is missing"
    if status == "failed":
        if job.get("verdict_final"):
            return (
                "terminal_failed:final_verdict; 已终局裁决（不接受 redrive/recover），"
                f"依据：{job.get('verdict_receipt_path')}"
            )
        return "terminal_failed:terminal; diagnose from owner queue state"
    if status == "superseded":
        return "terminal_superseded: verified replacement delivery and owner evidence are recorded"
    if status == "cancelled":
        return "terminal_cancelled: current contract forbids target writes and owner evidence is recorded"
    if status == "in_progress":
        message = "accepted:already_running; do not bypass direct write or resubmit"
        human = _in_progress_human(job)
        return f"{message} | {human}" if human else message
    message = "accepted:queued; background drain will write via wendangwang queue"
    human = _pending_human(job)
    return f"{message} | {human}" if human else message


def queue_job_status(
    db_path: Path | None, *, job_ids: list[int], keys: list[str]
) -> dict[str, Any]:
    path = Path(db_path) if db_path else DEFAULT_DB
    if not path.exists():
        return {
            "ok": True,
            "found": 0,
            "missing": ([{"job_id": job_id} for job_id in job_ids]
                        + [{"dedupe_key": key} for key in keys]),
            "terminal": False,
            "job_states": {},
            "jobs": [],
        }
    conn = _connect_status_read_only(path)
    rows: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    seen: set[int] = set()
    attachment_authorizations: dict[int, dict[str, Any]] = {}
    fields = (
        "j.id, j.dedupe_key, j.asset_id, j.from_session, j.op, j.status, j.attempts,"
        " j.enqueued_at, j.started_at, j.processed_at, j.receipt_ref, j.last_error,"
        " j.superseded_by_job_id, j.superseded_by_job_ids, j.supersede_evidence_ref,"
        " j.cancelled_by_contract_sha256, j.cancel_evidence_ref,"
        " j.recovery_count, j.recovery_origin_json, j.slice_claims"
    )
    try:
        for job_id in job_ids:
            row = conn.execute(
                f"SELECT {fields} FROM sync_jobs j WHERE j.id=?", (job_id,)
            ).fetchone()
            if row is None:
                missing.append({"job_id": job_id})
            elif int(row["id"]) not in seen:
                rows.append(dict(row))
                seen.add(int(row["id"]))
        for key in keys:
            matched = conn.execute(
                f"SELECT {fields} FROM sync_job_keys k"
                " JOIN sync_jobs j ON j.id=k.job_id"
                " WHERE k.dedupe_key=? ORDER BY j.id",
                (key,),
            ).fetchall()
            if not matched:
                missing.append({"dedupe_key": key})
            for row in matched:
                if int(row["id"]) not in seen:
                    rows.append(dict(row))
                    seen.add(int(row["id"]))
        for row in rows:
            if row["op"] == "bitable_rows_logical_snapshot":
                try:
                    snapshot_row = conn.execute(
                        "SELECT state_json FROM sync_logical_snapshots WHERE job_id=?",
                        (row["id"],),
                    ).fetchone()
                except sqlite3.OperationalError:
                    snapshot_row = None
                if snapshot_row is not None:
                    try:
                        state = json.loads(snapshot_row["state_json"])
                    except (TypeError, json.JSONDecodeError):
                        state = {}
                    if isinstance(state, dict):
                        row["logical_snapshot"] = {
                            key: state[key]
                            for key in (
                                "phase", "next_row", "prefetch_offset", "delete_index",
                                "work_row_cursor", "work_row_total", "slice_start", "slice_end",
                                "prefetch_pages",
                                "payload_sha256", "contract_sha256",
                            )
                            if key in state
                        }
                        checkpoints = state.get("read_checkpoints")
                        if isinstance(checkpoints, dict):
                            row["logical_snapshot"]["read_checkpoints"] = {
                                str(phase): {
                                    key: checkpoint[key]
                                    for key in (
                                        "offset", "pages", "has_more", "complete", "evidence",
                                    )
                                    if key in checkpoint
                                }
                                for phase, checkpoint in checkpoints.items()
                                if isinstance(checkpoint, dict)
                            }
                        row["logical_snapshot"].update({
                            "slice_claims": int(row.get("slice_claims") or 0),
                            "terminal": state.get("phase") == "done",
                        })
            if row["op"] == "bitable_attachment_replace_if_current":
                from .sync_queue import attachment_retry_authorization_for_job

                try:
                    authorization = attachment_retry_authorization_for_job(
                        conn, int(row["id"])
                    )
                except sqlite3.OperationalError:
                    # A pre-feature queue DB has no authorization table; status must
                    # fail closed rather than infer retryability from error text.
                    authorization = None
                if authorization is not None:
                    attachment_authorizations[int(row["id"])] = authorization
            if row["status"] == "pending":
                row["queue_ahead"] = int(conn.execute(
                    "SELECT COUNT(*) FROM sync_jobs WHERE asset_id=? AND id!=?"
                    " AND (status='in_progress' OR (status='pending' AND id<?))",
                    (row["asset_id"], row["id"], row["id"]),
                ).fetchone()[0])
            elif row["status"] == "in_progress":
                payload_row = conn.execute(
                    "SELECT payload_json FROM sync_jobs WHERE id=?", (row["id"],)
                ).fetchone()
                try:
                    payload_rows = _payload_rows(json.loads(payload_row["payload_json"]))
                except (json.JSONDecodeError, TypeError):
                    payload_rows = None
                row["payload_row_count"] = (
                    len(payload_rows) if payload_rows is not None else None
                )
            try:
                origins = json.loads(row.get("recovery_origin_json") or "[]")
            except (TypeError, json.JSONDecodeError):
                origins = []
            row["recovery_origin"] = origins[-1] if isinstance(origins, list) and origins else None
            row["recovery_attempt"] = (
                row["recovery_origin"].get("recovery_attempt")
                if isinstance(row["recovery_origin"], dict)
                else None
            )
    finally:
        conn.close()

    state_counts: dict[str, int] = {}
    for row in rows:
        if row["op"] == "bitable_attachment_replace_if_current":
            from .attachment_replace import attachment_retry_advice

            row["attachment_retry"] = attachment_retry_advice(
                op=row["op"], dedupe_key=row["dedupe_key"],
                status=row["status"], last_error=row["last_error"],
                retry_authorization=attachment_authorizations.get(int(row["id"])),
            )
        row.update(job_receipt_provenance(row))
        if row["status"] == "failed":
            row.update(failed_job_verdict_provenance(row))
        row["terminal"] = row["status"] in {
            "done", "failed", "superseded", "cancelled"
        }
        row["message"] = _status_message(row)
        state_counts[row["status"]] = state_counts.get(row["status"], 0) + 1
    return {
        "ok": True,
        "found": len(rows),
        "missing": missing,
        "terminal": bool(rows) and all(row["terminal"] for row in rows),
        "job_states": state_counts,
        "jobs": rows,
    }
