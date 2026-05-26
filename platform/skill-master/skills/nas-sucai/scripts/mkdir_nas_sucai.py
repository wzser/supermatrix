#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys

from nas_sucai_common import close_ftps_client
from nas_sucai_common import connect_nas
from nas_sucai_common import error_payload
from nas_sucai_common import load_config
from nas_sucai_common import make_directory
from nas_sucai_common import resolve_password
from nas_sucai_common import success_payload


ACTION = "mkdir"


def main(argv: list[str] | None = None) -> int:
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument("--path", required=True)
        args = parser.parse_args(argv)

        config = load_config()
        password = resolve_password(config)
        ftp, endpoint = connect_nas(config, password)
        try:
            remote_path = make_directory(ftp, args.path)
            payload = success_payload(
                ACTION,
                endpoint,
                {"remote_path": remote_path},
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
