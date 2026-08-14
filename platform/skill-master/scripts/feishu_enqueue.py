#!/usr/bin/env python3
"""Small wrapper for owner-side writes through wendangwang sync queue."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import hashlib
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
WENDANGWANG_ROOT = Path("/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang")
ENQUEUE = Path("/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/bin/feishu-sync-enqueue")
CONTRACT_DIR = WENDANGWANG_ROOT / "registry" / "assets"
WENDANGWANG_RECEIPTS_DIR = WENDANGWANG_ROOT / "data" / "receipts"
RECEIPTS = ROOT / "metrics" / "feishu-sync-receipts.ndjson"
ROWS_DIR = ROOT / "metrics" / "feishu-sync-rows"
SELF = "skill-master"


def _slug(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("_") or "asset"


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _load_contract(asset_id: str) -> tuple[dict[str, Any], Path]:
    path = CONTRACT_DIR / f"{asset_id}.json"
    if not path.exists():
        raise FileNotFoundError(f"wendangwang asset contract not found: {path}")
    try:
        contract = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid wendangwang asset contract JSON: {path}: {exc}") from exc
    return contract, path


def _contract_unique_key(contract: dict[str, Any]) -> list[str]:
    tables = contract.get("tables")
    if not isinstance(tables, list) or not tables:
        raise ValueError(f"asset contract has no tables: {contract.get('asset_id')}")
    unique_key = tables[0].get("unique_key")
    if not isinstance(unique_key, list) or not unique_key or not all(isinstance(k, str) and k for k in unique_key):
        raise ValueError(f"asset contract has no usable unique_key: {contract.get('asset_id')}")
    return unique_key


def _row_keys(rows: list[dict[str, Any]], unique_key: list[str]) -> list[dict[str, Any]]:
    seen: set[tuple[str, ...]] = set()
    out: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        missing = [key for key in unique_key if row.get(key) in (None, "")]
        if missing:
            raise ValueError(f"row {index} missing contract unique key field(s): {', '.join(missing)}")
        row_key = {key: row[key] for key in unique_key}
        key_tuple = tuple(str(row_key[key]) for key in unique_key)
        if key_tuple in seen:
            raise ValueError(f"duplicate input row for contract unique key {unique_key}: {row_key}")
        seen.add(key_tuple)
        out.append(row_key)
    return out


def _json_digest(data: Any, *, length: int | None = None) -> str:
    raw = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    return digest[:length] if length else digest


def _contains_true_key(value: Any, key: str) -> bool:
    if isinstance(value, dict):
        if value.get(key) is True:
            return True
        return any(_contains_true_key(v, key) for v in value.values())
    if isinstance(value, list):
        return any(_contains_true_key(v, key) for v in value)
    return False


def _wendangwang_receipts(dedupe_key: str) -> list[dict[str, Any]]:
    if not WENDANGWANG_RECEIPTS_DIR.exists():
        return []
    matches: list[dict[str, Any]] = []
    paths = sorted(WENDANGWANG_RECEIPTS_DIR.glob("*sync-queue*.ndjson"))[-14:]
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            if dedupe_key not in line:
                continue
            try:
                record: Any = json.loads(line)
            except json.JSONDecodeError:
                record = {"raw": line}
            matches.append({"path": str(path), "record": record})
    return matches[-5:]


def enqueue_bitable_rows(
    asset_id: str,
    rows: list[dict[str, Any]],
    *,
    key_suffix: str,
    wait_for_readback_seconds: int = 20,
    enqueue_timeout_seconds: int = 180,
) -> dict[str, Any]:
    if not ENQUEUE.exists():
        raise FileNotFoundError(f"wendangwang enqueue CLI not found: {ENQUEUE}")
    if not rows:
        return {"ok": True, "asset_id": asset_id, "rows": 0, "skipped": "no rows"}

    contract, contract_path = _load_contract(asset_id)
    unique_key = _contract_unique_key(contract)
    row_keys = _row_keys(rows, unique_key)
    key_fingerprint = _json_digest({
        "asset_id": asset_id,
        "key_suffix": key_suffix,
        "unique_key": unique_key,
        "row_keys": row_keys,
    }, length=12)
    payload_sha256 = _json_digest(rows)

    now = datetime.now(timezone.utc)
    rows_path = (
        ROWS_DIR
        / now.strftime("%Y%m%d")
        / f"{_slug(asset_id)}-{_slug(key_suffix)}-{key_fingerprint}-{payload_sha256[:12]}-{now.strftime('%H%M%S')}.json"
    )
    _write_json(rows_path, rows)

    dedupe_key = f"{now.date().isoformat()}:{SELF}:{asset_id}:{key_suffix}:{key_fingerprint}"
    cmd = [
        str(ENQUEUE),
        "--asset", asset_id,
        "--from", SELF,
        "--key", dedupe_key,
        "--op", "bitable_rows_upsert",
        "--rows", str(rows_path),
        "--drain-scope", "asset",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=enqueue_timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"enqueue timed out after {enqueue_timeout_seconds}s for {asset_id}; "
            f"rows_path={rows_path}"
        ) from exc
    stdout = result.stdout.strip()
    stderr = result.stderr.strip()
    parsed: dict[str, Any] = {}
    if stdout:
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            parsed = {"raw_stdout": stdout}
    deadline = time.time() + max(0, wait_for_readback_seconds)
    remote_receipts = _wendangwang_receipts(dedupe_key)
    read_back_verified = _contains_true_key(parsed, "read_back_verified") or any(
        _contains_true_key(item.get("record"), "read_back_verified") for item in remote_receipts
    )
    while not read_back_verified and time.time() < deadline:
        time.sleep(2)
        remote_receipts = _wendangwang_receipts(dedupe_key)
        read_back_verified = any(
            _contains_true_key(item.get("record"), "read_back_verified") for item in remote_receipts
        )

    receipt = {
        "ts": now.isoformat(timespec="seconds"),
        "asset_id": asset_id,
        "contract_path": str(contract_path),
        "dedupe_key": dedupe_key,
        "op": "bitable_rows_upsert",
        "rows": len(rows),
        "rows_path": str(rows_path),
        "unique_key": unique_key,
        "row_key_count": len(row_keys),
        "row_keys_sample": row_keys[:10],
        "payload_sha256": payload_sha256,
        "returncode": result.returncode,
        "stdout": parsed,
        "stderr": stderr,
        "read_back_verified": read_back_verified,
        "wendangwang_receipts": remote_receipts,
    }
    RECEIPTS.parent.mkdir(parents=True, exist_ok=True)
    with RECEIPTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(receipt, ensure_ascii=False, sort_keys=True) + "\n")

    if result.returncode != 0:
        raise RuntimeError(f"enqueue failed for {asset_id}: {stderr or stdout}")
    if not parsed.get("ok", False):
        raise RuntimeError(f"enqueue returned not ok for {asset_id}: {stdout}")
    return {
        "ok": True,
        "asset_id": asset_id,
        "rows": len(rows),
        "dedupe_key": dedupe_key,
        "rows_path": str(rows_path),
        "receipt_path": str(RECEIPTS),
        "contract_path": str(contract_path),
        "unique_key": unique_key,
        "row_key_count": len(row_keys),
        "row_keys_sample": row_keys[:10],
        "payload_sha256": payload_sha256,
        "read_back_verified": read_back_verified,
        "wendangwang_receipts": remote_receipts,
        "duplicate": bool(parsed.get("duplicate")),
        "job_id": parsed.get("job_id"),
        "drained": parsed.get("drained", {}),
    }


def main() -> int:
    print("import enqueue_bitable_rows from this module; no standalone CLI is provided", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
