#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.path.insert(0, str(Path(__file__).resolve().parent / "commands"))

from lingxing_client import ensure_credentials, pick_best_small_category, resolve_runtime_config
from lingxing_remote_runner import run_remote_operation
import asin_diagnostics
import asin_rank_probe
import asin_rank_sync
import download_aba
import fetch_ad_reports
import listing_publish


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Lingxing OpenAPI global skill CLI.")
    parser.add_argument("--skill-root", help="Override the skill root for loading local-config.json.")
    parser.add_argument("--app-id")
    parser.add_argument("--app-secret")
    parser.add_argument("--server-host")
    parser.add_argument("--server-user")
    parser.add_argument("--server-key")
    parser.add_argument("--relay-url")
    parser.add_argument("--relay-token")
    parser.add_argument("--relay-ca-cert")
    parser.add_argument("--relay-timeout", type=int)
    parser.add_argument("--relay-connect-timeout", type=int)
    parser.set_defaults(relay_tls_verify=None, relay_fallback_to_ssh=None)
    parser.add_argument("--relay-no-tls-verify", dest="relay_tls_verify", action="store_false")
    parser.add_argument("--no-relay-fallback", dest="relay_fallback_to_ssh", action="store_false")
    parser.add_argument("--timeout", type=int)
    parser.add_argument("--output-dir")
    parser.add_argument("--site-filters", nargs="+")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("auth", help="Fetch an access token for diagnostics.")

    call_parser = subparsers.add_parser("call", help="Call any Lingxing OpenAPI path.")
    call_parser.add_argument("--api-path", required=True)
    call_parser.add_argument("--method", default="POST")
    call_parser.add_argument("--body-json")
    call_parser.add_argument("--query-json")
    call_parser.add_argument("--headers-json")

    seller_parser = subparsers.add_parser("seller-list", help="List sellers, optionally filtered by country.")
    seller_parser.add_argument("--country", action="append")

    probe_parser = subparsers.add_parser("probe", help="Probe an arbitrary API request and return structured output.")
    probe_parser.add_argument("--api-path", required=True)
    probe_parser.add_argument("--method", default="POST")
    probe_parser.add_argument("--body-json")
    probe_parser.add_argument("--query-json")
    probe_parser.add_argument("--headers-json")

    state_parser = subparsers.add_parser("resume-state", help="Summarize a saved state file.")
    state_parser.add_argument("--state-path", required=True)

    aba_parser = subparsers.add_parser("download-aba", help="Run a preset ABA download request and save the extracted file.")
    aba_parser.add_argument("--api-path", required=True)
    aba_parser.add_argument("--body-json", required=True)
    aba_parser.add_argument("--download-url-key", action="append", default=["data.downloadUrl", "data.url", "downloadUrl"])
    aba_parser.add_argument("--filename")
    aba_parser.add_argument("--fallback-filename", default="lingxing-aba-report.bin")
    aba_parser.add_argument("--remote-temp-name")

    ad_parser = subparsers.add_parser("fetch-ad-reports", help="Probe a high-value subset of Lingxing ad report APIs.")

    diag_parser = subparsers.add_parser("asin-diagnostics", help="Fetch US-merged ASIN metrics across complete periods.")
    diag_parser.add_argument("--asin", action="append")
    diag_parser.add_argument("--run-date", default="2026-03-27")
    diag_parser.add_argument("--batch-size", type=int, default=50)
    diag_parser.add_argument("--page-length", type=int, default=1000)

    rank_sync_parser = subparsers.add_parser("asin-rank-sync", help="Fetch period rank snapshots with resumable state.")
    rank_sync_parser.add_argument("--asin", action="append")
    rank_sync_parser.add_argument("--run-date", default="2026-03-27")
    rank_sync_parser.add_argument("--batch-size", type=int, default=50)
    rank_sync_parser.add_argument("--sleep-seconds", type=float, default=6.0)
    rank_sync_parser.add_argument("--rate-limit-sleep", type=float, default=15.0)
    rank_sync_parser.add_argument("--state-path")

    rank_probe_parser = subparsers.add_parser("asin-rank-probe", help="Probe rank fields across one or more windows.")
    rank_probe_parser.add_argument("--asin", action="append")
    rank_probe_parser.add_argument("--run-date", default="2026-03-27")
    rank_probe_parser.add_argument("--window", action="append")
    rank_probe_parser.add_argument("--batch-size", type=int, default=50)
    rank_probe_parser.add_argument("--sleep-seconds", type=float, default=6.0)
    rank_probe_parser.add_argument("--rate-limit-sleep", type=float, default=15.0)

    title_parser = subparsers.add_parser("listing-title", help="Update an Amazon listing title by ASIN.")
    title_parser.add_argument("--asin", required=True)
    title_parser.add_argument("--store-id", type=int)
    title_parser.add_argument("--sku")
    title_parser.add_argument("--title", required=True)
    title_parser.add_argument("--poll", action="store_true")
    title_parser.add_argument("--poll-attempts", type=int, default=6)
    title_parser.add_argument("--poll-sleep", type=float, default=15.0)

    bullets_parser = subparsers.add_parser("listing-bullets", help="Update Amazon listing bullet points and optional description.")
    bullets_parser.add_argument("--asin", required=True)
    bullets_parser.add_argument("--store-id", type=int)
    bullets_parser.add_argument("--sku")
    bullets_parser.add_argument("--bullet", action="append")
    bullets_parser.add_argument("--description")
    bullets_parser.add_argument("--poll", action="store_true")
    bullets_parser.add_argument("--poll-attempts", type=int, default=6)
    bullets_parser.add_argument("--poll-sleep", type=float, default=15.0)

    images_parser = subparsers.add_parser("listing-images", help="Update Amazon listing main/secondary image slots by ASIN.")
    images_parser.add_argument("--asin", required=True)
    images_parser.add_argument("--store-id", type=int)
    images_parser.add_argument("--sku")
    images_parser.add_argument("--main-image-url")
    images_parser.add_argument("--main-image-path")
    images_parser.add_argument("--image1-url")
    images_parser.add_argument("--image1-path")
    images_parser.add_argument("--image2-url")
    images_parser.add_argument("--image2-path")
    images_parser.add_argument("--image-upload-backend", choices=["auto", "see", "catbox"], default="auto")
    images_parser.add_argument("--upload-domain")
    images_parser.add_argument("--upload-token")
    images_parser.add_argument("--poll", action="store_true")
    images_parser.add_argument("--poll-attempts", type=int, default=6)
    images_parser.add_argument("--poll-sleep", type=float, default=15.0)

    update_parser = subparsers.add_parser("listing-update", help="Update title, bullets/description, and image slots in one request.")
    update_parser.add_argument("--asin", required=True)
    update_parser.add_argument("--store-id", type=int)
    update_parser.add_argument("--sku")
    update_parser.add_argument("--title")
    update_parser.add_argument("--bullet", action="append")
    update_parser.add_argument("--description")
    update_parser.add_argument("--main-image-url")
    update_parser.add_argument("--main-image-path")
    update_parser.add_argument("--image1-url")
    update_parser.add_argument("--image1-path")
    update_parser.add_argument("--image2-url")
    update_parser.add_argument("--image2-path")
    update_parser.add_argument("--image-upload-backend", choices=["auto", "see", "catbox"], default="auto")
    update_parser.add_argument("--upload-domain")
    update_parser.add_argument("--upload-token")
    update_parser.add_argument("--poll", action="store_true")
    update_parser.add_argument("--poll-attempts", type=int, default=6)
    update_parser.add_argument("--poll-sleep", type=float, default=15.0)

    status_parser = subparsers.add_parser("listing-status", help="Check a Lingxing listing publish batch result.")
    status_parser.add_argument("--record-id", required=True)
    status_parser.add_argument("--store-id", required=True, type=int)
    return parser


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def cmd_auth(config: dict) -> dict:
    return run_remote_operation(config, "auth", {})


def cmd_call(args, config: dict) -> dict:
    return run_remote_operation(
        config,
        "call",
        {
            "api_path": args.api_path,
            "method": args.method.upper(),
            "body": json.loads(args.body_json) if args.body_json else {},
            "query": json.loads(args.query_json) if args.query_json else {},
            "headers": json.loads(args.headers_json) if args.headers_json else {},
            "timeout": config["default_timeout"],
        },
    )


def cmd_seller_list(args, config: dict) -> dict:
    return run_remote_operation(
        config,
        "seller-list",
        {"countries": [item.upper() for item in (args.country or config["default_site_filters"])]},
    )


def cmd_probe(args, config: dict) -> dict:
    return cmd_call(args, config)


def cmd_resume_state(args, _config: dict) -> dict:
    path = Path(args.state_path).expanduser().resolve()
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        "state_path": str(path),
        "completed_periods": sorted((payload.get("periods") or {}).keys()),
        "error_count": len(payload.get("errors") or []),
        "top_level_keys": sorted(payload.keys()),
    }


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    config = resolve_runtime_config(args)
    ensure_credentials(config)

    handlers = {
        "auth": lambda: cmd_auth(config),
        "call": lambda: cmd_call(args, config),
        "seller-list": lambda: cmd_seller_list(args, config),
        "probe": lambda: cmd_probe(args, config),
        "resume-state": lambda: cmd_resume_state(args, config),
        "download-aba": lambda: download_aba.run(args, config),
        "fetch-ad-reports": lambda: fetch_ad_reports.run(args, config),
        "asin-diagnostics": lambda: asin_diagnostics.run(args, config),
        "asin-rank-sync": lambda: asin_rank_sync.run(args, config),
        "asin-rank-probe": lambda: asin_rank_probe.run(args, config),
        "listing-title": lambda: listing_publish.run_title(args, config),
        "listing-bullets": lambda: listing_publish.run_bullets(args, config),
        "listing-images": lambda: listing_publish.run_images(args, config),
        "listing-update": lambda: listing_publish.run_update(args, config),
        "listing-status": lambda: listing_publish.run_status(args, config),
    }
    print(json.dumps(handlers[args.command](), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
