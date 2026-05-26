from __future__ import annotations

import json
from pathlib import Path

from lingxing_remote_runner import run_remote_operation


DEFAULT_REPORTS = [
    {"doc": "spCampaignReports", "family": "sp", "kind": "daily"},
    {"doc": "spKeywordReports", "family": "sp", "kind": "daily"},
    {"doc": "queryWordReports", "family": "sp", "kind": "daily"},
    {"doc": "hsaCampaignReports", "family": "sb", "kind": "daily"},
    {"doc": "sdCampaignReports", "family": "sd", "kind": "daily"},
    {"doc": "spCampaignHourData", "family": "sp", "kind": "hourly"},
]


def run(args, config: dict) -> dict:
    output_dir = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    result = run_remote_operation(
        config,
        "fetch-ad-reports",
        {"reports": DEFAULT_REPORTS},
    )
    target = output_dir / "ad-report-summary.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "ok", "output_file": str(target), "report_count": len(result.get("items", []))}

