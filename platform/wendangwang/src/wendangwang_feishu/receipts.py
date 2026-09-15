from __future__ import annotations

import fcntl
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _receipt_id(payload: dict[str, Any], created_at: str) -> str:
    basis = json.dumps(payload, ensure_ascii=False, sort_keys=True) + created_at
    return "rcpt_" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def write_receipt(path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    created_at = _now()
    receipt = {
        "receipt_id": _receipt_id(payload, created_at),
        "created_at": created_at,
        **payload,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # 跨进程串行化单行 append：per-asset 锁放开后多个 drain 会并发写同一 receipt ndjson，
    # 而 O_APPEND 对 >PIPE_BUF(4096B) 的行不保证原子（receipt 行常超 4KB）→ 行交错损坏。
    # 用一把只在 append 期间短持的专用 flock（微秒级，不阻塞 drain），与队列/资产锁解耦。
    lock_path = Path(str(path) + ".lock")
    with lock_path.open("w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(receipt, ensure_ascii=False, sort_keys=True) + "\n")
    return receipt
