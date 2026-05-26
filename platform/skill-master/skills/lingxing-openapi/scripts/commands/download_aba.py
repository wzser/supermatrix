from __future__ import annotations

import json
import shutil
from pathlib import Path
from urllib.parse import urlparse

from lingxing_remote_runner import run_remote_operation


def run(args, config: dict) -> dict:
    output_dir = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    remote_name = args.remote_temp_name or Path(urlparse(args.fallback_filename).path).name or "lingxing-aba-download.bin"
    remote_temp_path = f"/tmp/{remote_name}"
    body = json.loads(args.body_json) if args.body_json else {}
    result = run_remote_operation(
        config,
        "download-aba",
        {
            "api_path": args.api_path,
            "body": body,
            "headers": {"Content-Type": "application/json"},
            "download_url_keys": args.download_url_key,
            "remote_temp_path": remote_temp_path,
            "timeout": config["default_timeout"],
        },
    )
    if not result.get("downloaded"):
        return {"status": "metadata_only", **result}

    final_name = args.filename or Path(result.get("remote_extracted_path") or result["remote_temp_path"]).name
    final_path = output_dir / final_name
    remote_source = result.get("remote_extracted_path") or result["remote_temp_path"]
    import subprocess
    subprocess.run(
        [
            "ssh",
            "-i",
            str(config["server_key_path"]),
            f'{config["server_user"]}@{config["server_host"]}',
            "cat",
            remote_source,
        ],
        check=True,
        stdout=open(final_path, "wb"),
    )
    subprocess.run(
        [
            "ssh",
            "-i",
            str(config["server_key_path"]),
            f'{config["server_user"]}@{config["server_host"]}',
            "rm",
            "-f",
            result["remote_temp_path"],
            *( [result["remote_extracted_path"]] if result.get("remote_extracted_path") else [] ),
        ],
        check=True,
    )
    return {
        "status": "ok",
        "output_file": str(final_path),
        "metadata": result.get("metadata"),
    }

