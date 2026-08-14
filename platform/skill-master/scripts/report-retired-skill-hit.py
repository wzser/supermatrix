#!/usr/bin/env python3
"""Record a retired-skill hit locally, then notify skill-master via spawn2.0."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skill_retirement import append_jsonl_locked, format_time


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEDGER = ROOT / "data" / "skill-retirements" / "hits.jsonl"
SPAWN_URL = "http://localhost:3501/api/spawn2.0"


def notify_skill_master(event: dict[str, Any]) -> dict[str, Any]:
    request_body = {
        "from": event["session"] if event["session"] != "unknown" else "skill-master",
        "target": "skill-master",
        "prompt": (
            f"退役 skill 命中：name={event['skill']} retirement_id={event['retirement_id']} "
            f"caller_session={event['session']} reason={event['reason']} event_id={event['event_id']}。"
            "请登记恢复评审；在评审完成前禁止自动 purge，也不要原样恢复旧逻辑。"
        ),
        "client_request_id": (
            f"{event['at'][:10]}:{event['session']}:{event['skill']}:retired-hit:{event['event_id'][-12:]}"
        ),
        "closure": {"kind": "message", "target": {"type": "todo_pool"}},
    }
    encoded = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        SPAWN_URL,
        data=encoded,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return {"ok": bool(payload.get("ok")), "response": payload}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": str(exc)}


def report_hit(
    *,
    retirement_id: str,
    skill: str,
    session: str,
    reason: str,
    ledger_path: Path = DEFAULT_LEDGER,
    notify: bool = True,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    event = {
        "schema_version": 1,
        "event": "hit",
        "event_id": f"hit_{uuid.uuid4().hex}",
        "retirement_id": retirement_id,
        "skill": skill,
        "session": session or "unknown",
        "reason": reason,
        "at": format_time(now),
    }
    append_jsonl_locked(ledger_path, event)
    notification = notify_skill_master(event) if notify else {"ok": False, "skipped": True}
    return {**event, "notification": notification}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--retirement-id", required=True)
    parser.add_argument("--skill", required=True)
    parser.add_argument("--session", default="unknown")
    parser.add_argument("--reason", required=True)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--no-notify", action="store_true")
    args = parser.parse_args()
    result = report_hit(
        retirement_id=args.retirement_id,
        skill=args.skill,
        session=args.session,
        reason=args.reason,
        ledger_path=args.ledger,
        notify=not args.no_notify,
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
