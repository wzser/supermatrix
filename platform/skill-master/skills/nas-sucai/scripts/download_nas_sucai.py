#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from nas_sucai_common import close_ftps_client
from nas_sucai_common import connect_nas
from nas_sucai_common import download_file
from nas_sucai_common import error_payload
from nas_sucai_common import load_config
from nas_sucai_common import resolve_password
from nas_sucai_common import success_payload


ACTION = "download"


def main(argv: list[str] | None = None) -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--remote", required=True)
        parser.add_argument("--local", required=True)
        parser.add_argument("--overwrite", action="store_true")
        args = parser.parse_args(argv)

        config = load_config()
        password = resolve_password(config)
        ftp, endpoint = connect_nas(config, password)
        try:
            local_path = download_file(
                ftp,
                args.remote,
                Path(args.local),
                overwrite=args.overwrite,
            )
            payload = success_payload(
                ACTION,
                endpoint,
                {"local_path": str(local_path)},
            )
            json.dump(payload, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
            return 0
        finally:
            close_ftps_client(ftp)
    except Exception as exc:
        json.dump(error_payload(exc, action=ACTION), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
