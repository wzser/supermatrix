#!/usr/bin/env python3
"""Lightweight verification for evaluate-skills.py session discovery."""
import importlib.util
import json
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "scripts" / "evaluate-skills.py"


def load_evaluate_skills():
    spec = importlib.util.spec_from_file_location("evaluate_skills", MODULE_PATH)
    if not spec or not spec.loader:
        raise RuntimeError(f"cannot load {MODULE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_temp_catalog_without_constitution():
    module = load_evaluate_skills()
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        module.CONSTITUTION = tmpdir / "CONSTITUTION.md"
        module.SESSION_CATALOG = tmpdir / "session-catalog.json"
        module.SESSION_CATALOG.write_text(
            json.dumps(
                {
                    "sessions": [
                        {"name": "skill-master", "backend": "claude", "status": "idle"},
                        {"name": "ads-master", "backend": "codex", "status": "idle"},
                        {"name": "scheduler", "backend": "claude", "status": "busy"},
                    ]
                }
            ),
            encoding="utf-8",
        )

        sessions = module.parse_sessions()

    expected = ["ads-master", "scheduler"]
    if sessions != expected:
        raise AssertionError(f"expected {expected}, got {sessions}")
    print("parse_sessions reads session-catalog.json and excludes skill-master")


def verify_real_catalog_nonempty():
    module = load_evaluate_skills()
    sessions = module.parse_sessions()
    if not sessions:
        raise AssertionError("real session-catalog.json returned no sessions")
    if module.SELF in sessions:
        raise AssertionError(f"{module.SELF} should be excluded")
    print(f"real session-catalog.json returned {len(sessions)} sessions")


def verify_fanout_gate_budget_and_cooldown():
    module = load_evaluate_skills()
    candidates = ["a", "b", "c", "d", "e"]
    selected, meta = module.select_due_sessions(
        candidates,
        {"cursor": 0, "last_polled": {}},
        budget=2,
        cycle_days=14,
    )
    if len(selected) != 2:
        raise AssertionError(f"expected budget-limited selection of 2, got {selected}")
    if meta["cursor_after"] != 2:
        raise AssertionError(f"expected cursor_after=2, got {meta['cursor_after']}")

    now_ms = int(time.time() * 1000)
    selected2, _ = module.select_due_sessions(
        candidates,
        {"cursor": meta["cursor_after"], "last_polled": {s: now_ms for s in selected}},
        budget=2,
        cycle_days=14,
    )
    overlap = sorted(set(selected) & set(selected2))
    if overlap:
        raise AssertionError(f"cooldown should prevent immediate repeat, got overlap {overlap}")
    print("fanout gate enforces budget and cooldown")


def main():
    verify_temp_catalog_without_constitution()
    verify_real_catalog_nonempty()
    verify_fanout_gate_budget_and_cooldown()


if __name__ == "__main__":
    main()
