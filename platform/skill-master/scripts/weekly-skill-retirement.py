#!/usr/bin/env python3
"""Run the weekly inactive-skill lifecycle without spawning child sessions."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RECEIPT = ROOT / "data" / "skill-lifecycle" / "scheduler-receipts" / "weekly-inactive-retirement.receipt"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _run(command: list[str], *, allow_nonzero_json: bool = False) -> dict[str, Any]:
    completed = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    payload: dict[str, Any] | None = None
    if completed.stdout.strip().startswith("{"):
        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError:
            payload = None
    ok = completed.returncode == 0 or (
        allow_nonzero_json and isinstance(payload, dict)
    )
    return {
        "ok": ok,
        "returncode": completed.returncode,
        "command": command,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "json": payload,
    }


def _inactive_stale_findings(audit: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(audit, dict):
        return [{"code": "audit_json_missing"}]
    return [
        item
        for item in audit.get("findings", [])
        if item.get("code") == "stale_managed_symlink"
    ]


def run_weekly(*, apply: bool) -> dict[str, Any]:
    current = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    tombstone_command = [
        "python3",
        "scripts/manage-skill-retirements.py",
        "purge-due" if apply else "audit",
    ]
    if apply:
        tombstone_command.append("--apply")
    tombstone_command.append("--json")
    tombstones = _run(tombstone_command)
    if not tombstones["ok"]:
        result = {"schema_version": 1, "ok": False, "at": current, "stage": "tombstones", "tombstones": tombstones}
        if apply:
            _atomic_write(RECEIPT, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return result

    inactive_command = ["python3", "scripts/manage-inactive-skills.py", "weekly"]
    if apply:
        inactive_command.append("--apply")
    inactive_command.append("--json")
    inactive = _run(inactive_command)
    if not inactive["ok"]:
        result = {
            "schema_version": 1,
            "ok": False,
            "at": current,
            "stage": "inactive",
            "tombstones": tombstones["json"],
            "inactive": inactive,
        }
        if apply:
            _atomic_write(RECEIPT, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return result

    sync = {"ok": True, "skipped": not apply}
    audit = {"ok": True, "skipped": not apply}
    registry_sync = {"ok": True, "skipped": True}
    retired = int((inactive["json"] or {}).get("summary", {}).get("retired", 0))
    tombstone_purged = int((tombstones["json"] or {}).get("summary", {}).get("purged", 0))
    if apply:
        sync = _run(["bash", "scripts/sync-skills.sh"])
        audit = _run(
            [
                "python3",
                "scripts/audit-skill-discovery.py",
                "--json",
                "--discovery-root",
                str(Path.home() / ".claude" / "skills"),
                "--discovery-root",
                str(Path.home() / ".agents" / "skills"),
                "--discovery-root",
                str(Path.home() / ".codex" / "skills"),
                "--discovery-root",
                str(Path.home() / ".kimi-code" / "skills"),
                "--discovery-root",
                str(Path.home() / ".kimi" / "skills"),
            ],
            allow_nonzero_json=True,
        )
        stale = _inactive_stale_findings(audit.get("json"))
        if stale:
            audit["ok"] = False
            audit["inactive_stale_findings"] = stale
        if retired or tombstone_purged:
            registry_sync = _run(["python3", "scripts/sync-skills-to-feishu.py"])

    ok = bool(sync["ok"] and audit["ok"] and registry_sync["ok"])
    result = {
        "schema_version": 1,
        "ok": ok,
        "at": current,
        "apply": apply,
        "stage": "complete" if ok else "verification",
        "summary": {
            "retired_inactive": retired,
            "purged_tombstones": tombstone_purged,
            "instrumented_now": int((inactive["json"] or {}).get("summary", {}).get("instrumented_now", 0)),
        },
        "tombstones": tombstones["json"],
        "inactive": inactive["json"],
        "sync": sync,
        "audit": audit,
        "registry_sync": registry_sync,
    }
    if apply:
        _atomic_write(RECEIPT, json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = run_weekly(apply=args.apply)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.json else None))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
