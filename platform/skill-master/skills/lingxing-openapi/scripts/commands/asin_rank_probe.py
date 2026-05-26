from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from lingxing_client import build_period_windows
from lingxing_remote_runner import run_remote_operation


def run(args, config: dict) -> dict:
    if not args.asin:
        raise SystemExit("asin-rank-probe requires at least one --asin")
    output_dir = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    windows = []
    if args.window:
        for value in args.window:
            start, end = value.split(",", 1)
            windows.append({"label": f"{start}_{end}", "start": start, "end": end})
    else:
        for label, (start, end) in build_period_windows(dt.date.fromisoformat(args.run_date)).items():
            windows.append({"label": label, "start": start.isoformat(), "end": end.isoformat()})
    result = run_remote_operation(
        config,
        "asin-rank-probe",
        {
            "asins": [asin.upper() for asin in args.asin],
            "windows": windows,
            "batch_size": args.batch_size,
            "sleep_seconds": args.sleep_seconds,
            "rate_limit_sleep": args.rate_limit_sleep,
        },
    )
    target = output_dir / f"asin-rank-probe-{dt.date.fromisoformat(args.run_date).isoformat()}.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "output_file": str(target), "row_count": len(result.get("items", []))}

