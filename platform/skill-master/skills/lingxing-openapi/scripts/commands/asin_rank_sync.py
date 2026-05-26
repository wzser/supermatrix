from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from lingxing_client import build_period_windows
from lingxing_remote_runner import run_remote_operation


def run(args, config: dict) -> dict:
    if not args.asin:
        raise SystemExit("asin-rank-sync requires at least one --asin")
    output_dir = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    state_path = Path(args.state_path or output_dir / f"rank-sync-state-{args.run_date}.json").resolve()
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"periods": {}, "errors": []}
    windows = build_period_windows(dt.date.fromisoformat(args.run_date))
    pending = [name for name in windows if name not in state["periods"]]
    for period_name in pending:
        start, end = windows[period_name]
        result = run_remote_operation(
            config,
            "asin-rank-probe",
            {
                "asins": [asin.upper() for asin in args.asin],
                "windows": [{"label": period_name, "start": start.isoformat(), "end": end.isoformat()}],
                "batch_size": args.batch_size,
                "sleep_seconds": args.sleep_seconds,
                "rate_limit_sleep": args.rate_limit_sleep,
            },
        )
        state["periods"][period_name] = result
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "state_path": str(state_path), "completed_periods": list(state["periods"])}

