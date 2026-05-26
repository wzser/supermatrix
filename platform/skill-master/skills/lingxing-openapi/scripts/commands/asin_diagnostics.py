from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from lingxing_client import build_period_windows
from lingxing_remote_runner import run_remote_operation


def run(args, config: dict) -> dict:
    if not args.asin:
        raise SystemExit("asin-diagnostics requires at least one --asin")
    output_dir = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    windows = {
        label: {"start": start.isoformat(), "end": end.isoformat()}
        for label, (start, end) in build_period_windows(dt.date.fromisoformat(args.run_date)).items()
    }
    result = run_remote_operation(
        config,
        "asin-diagnostics",
        {
            "asins": [asin.upper() for asin in args.asin],
            "periods": windows,
            "batch_size": args.batch_size,
            "page_length": args.page_length,
        },
    )
    target = output_dir / f"asin-diagnostics-{dt.date.fromisoformat(args.run_date).isoformat()}.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "output_file": str(target), "asin_count": len(result.get("metrics", {}))}

