#!/usr/bin/env python3
"""Append a query/consultation log entry to logs/queries/queries.jsonl.

Reads a JSON object from stdin, validates required fields, fills in defaults,
appends one line to the log. Exit non-zero on validation failure.

Required fields:
  intent     — one of: definition / inventory / comparison / solution / alignment / unknown
  kb_state   — one of: has / partial / none / out-of-scope
  prompt     — raw prompt text from caller

Optional (auto-filled if missing):
  timestamp        — ISO-8601 UTC, default now
  caller           — detected calling session, default "unknown"
  concepts         — list of concept slugs touched, default []
  sources          — list of [Sxxxx] cited, default []
  routing_target   — target session for out-of-scope, default null
  answer_summary   — 1–2 sentence gist of the reply, default ""
  notes            — free-text caveats / suspicions, default ""

Usage:
  echo '{"intent":"definition","kb_state":"has","prompt":"什么是 harness"}' \
    | python3 scripts/log-query.py

Designed to be portable: copy this file to any knowledge-session workspace
that has `logs/queries/` at the repo root. No mythos-specific assumptions.
"""
from __future__ import annotations

import json
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOG_DIR = ROOT / "logs" / "queries"
LOG_FILE = LOG_DIR / "queries.jsonl"

VALID_INTENTS = {"definition", "inventory", "comparison", "solution", "alignment", "unknown"}
VALID_KB_STATES = {"has", "partial", "none", "out-of-scope"}


def fail(msg: str) -> None:
    print(f"log-query: {msg}", file=sys.stderr)
    sys.exit(2)


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty stdin; expected a JSON object")

    try:
        rec = json.loads(raw)
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON: {exc}")

    if not isinstance(rec, dict):
        fail("payload must be a JSON object")

    for required in ("intent", "kb_state", "prompt"):
        if required not in rec:
            fail(f"missing required field '{required}'")

    if rec["intent"] not in VALID_INTENTS:
        fail(f"intent must be one of {sorted(VALID_INTENTS)} (got {rec['intent']!r})")

    if rec["kb_state"] not in VALID_KB_STATES:
        fail(f"kb_state must be one of {sorted(VALID_KB_STATES)} (got {rec['kb_state']!r})")

    rec.setdefault(
        "timestamp",
        datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    )
    rec.setdefault("caller", "unknown")
    rec.setdefault("concepts", [])
    rec.setdefault("sources", [])
    rec.setdefault("routing_target", None)
    rec.setdefault("answer_summary", "")
    rec.setdefault("notes", "")

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(f"log-query: appended to {LOG_FILE.relative_to(ROOT)}", file=sys.stderr)


if __name__ == "__main__":
    main()
