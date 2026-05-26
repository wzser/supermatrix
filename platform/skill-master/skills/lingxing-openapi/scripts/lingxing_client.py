from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any


DEFAULT_SERVER_HOST = "YOUR_RELAY_HOST"
DEFAULT_SERVER_USER = "ubuntu"
DEFAULT_TIMEOUT = 90
DEFAULT_OUTPUT_SUBDIR = "output/lingxing"
DEFAULT_SITE_FILTERS = ["US"]
DEFAULT_RELAY_FALLBACK_TO_SSH = True
DEFAULT_RELAY_TLS_VERIFY = True
DEFAULT_RELAY_CONNECT_TIMEOUT = 8


def script_dir() -> Path:
    return Path(__file__).resolve().parent


def skill_root_from_arg(value: str | None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return script_dir().parent


def load_local_config(skill_root: Path) -> dict[str, Any]:
    path = skill_root / "local-config.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid Lingxing local config JSON: {path} ({exc})")


def _expand_output_dir(raw_value: str, cwd: Path) -> str:
    path = Path(raw_value).expanduser()
    if not path.is_absolute():
        path = cwd / path
    return str(path.resolve())


def _truthy(value: Any, *, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def resolve_runtime_config(args, *, env: dict[str, str] | None = None, cwd: Path | None = None) -> dict[str, Any]:
    env = env or os.environ
    cwd = cwd or Path.cwd()
    skill_root = skill_root_from_arg(getattr(args, "skill_root", None))
    local = load_local_config(skill_root)

    output_dir = (
        getattr(args, "output_dir", None)
        or str(local.get("default_output_dir", "")).strip()
        or env.get("LINGXING_OUTPUT_DIR", "").strip()
        or DEFAULT_OUTPUT_SUBDIR
    )
    timeout = (
        getattr(args, "timeout", None)
        or local.get("default_timeout")
        or env.get("LINGXING_TIMEOUT")
        or DEFAULT_TIMEOUT
    )
    site_filters = (
        getattr(args, "site_filters", None)
        or local.get("default_site_filters")
        or env.get("LINGXING_DEFAULT_SITE_FILTERS", "")
        or DEFAULT_SITE_FILTERS
    )
    if isinstance(site_filters, str):
        site_filters = [item.strip().upper() for item in site_filters.split(",") if item.strip()]

    relay_timeout = (
        getattr(args, "relay_timeout", None)
        or local.get("relay_timeout")
        or env.get("LINGXING_RELAY_TIMEOUT")
        or timeout
    )
    relay_connect_timeout = (
        getattr(args, "relay_connect_timeout", None)
        or local.get("relay_connect_timeout")
        or env.get("LINGXING_RELAY_CONNECT_TIMEOUT")
        or DEFAULT_RELAY_CONNECT_TIMEOUT
    )
    relay_tls_verify = (
        getattr(args, "relay_tls_verify", None)
        if getattr(args, "relay_tls_verify", None) is not None
        else local.get("relay_tls_verify", env.get("LINGXING_RELAY_TLS_VERIFY"))
    )
    relay_fallback_to_ssh = (
        getattr(args, "relay_fallback_to_ssh", None)
        if getattr(args, "relay_fallback_to_ssh", None) is not None
        else local.get("relay_fallback_to_ssh", env.get("LINGXING_RELAY_FALLBACK_TO_SSH"))
    )

    return {
        "skill_root": str(skill_root),
        "app_id": getattr(args, "app_id", None)
        or str(local.get("app_id", "")).strip()
        or env.get("LINGXING_APP_ID", "").strip(),
        "app_secret": getattr(args, "app_secret", None)
        or str(local.get("app_secret", "")).strip()
        or env.get("LINGXING_APP_SECRET", "").strip(),
        "server_host": getattr(args, "server_host", None)
        or str(local.get("server_host", "")).strip()
        or env.get("LINGXING_SERVER_HOST", "").strip()
        or DEFAULT_SERVER_HOST,
        "server_user": getattr(args, "server_user", None)
        or str(local.get("server_user", "")).strip()
        or env.get("LINGXING_SERVER_USER", "").strip()
        or DEFAULT_SERVER_USER,
        "server_key_path": getattr(args, "server_key", None)
        or str(local.get("server_key_path", "")).strip()
        or env.get("LINGXING_SERVER_KEY_PATH", "").strip(),
        "default_timeout": int(timeout),
        "default_output_dir": _expand_output_dir(str(output_dir), cwd),
        "default_site_filters": site_filters,
        "relay_url": getattr(args, "relay_url", None)
        or str(local.get("relay_url", "")).strip()
        or env.get("LINGXING_RELAY_URL", "").strip(),
        "relay_token": getattr(args, "relay_token", None)
        or str(local.get("relay_token", "")).strip()
        or env.get("LINGXING_RELAY_TOKEN", "").strip(),
        "relay_ca_cert_path": getattr(args, "relay_ca_cert", None)
        or str(local.get("relay_ca_cert_path", "")).strip()
        or env.get("LINGXING_RELAY_CA_CERT_PATH", "").strip(),
        "relay_timeout": int(relay_timeout),
        "relay_connect_timeout": int(relay_connect_timeout),
        "relay_tls_verify": _truthy(relay_tls_verify, default=DEFAULT_RELAY_TLS_VERIFY),
        "relay_fallback_to_ssh": _truthy(relay_fallback_to_ssh, default=DEFAULT_RELAY_FALLBACK_TO_SSH),
    }


def ensure_credentials(config: dict[str, Any]) -> None:
    relay_configured = bool(config.get("relay_url"))
    if relay_configured:
        if not config.get("relay_token"):
            raise SystemExit("Missing Lingxing relay token. Provide --relay-token, set LINGXING_RELAY_TOKEN, or add local-config.json.")
        return

    if not config.get("app_id") or not config.get("app_secret"):
        raise SystemExit(
            "Missing Lingxing credentials. Provide --app-id/--app-secret, set env vars, or add local-config.json."
        )
    if not config.get("server_key_path"):
        raise SystemExit(
            "Missing Lingxing server key path. Provide --server-key, set env, or add local-config.json."
        )


def pick_best_small_category(items: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    for item in items or []:
        try:
            rank = int(item.get("rank"))
        except (TypeError, ValueError):
            continue
        candidate = {
            "rank": rank,
            "category": item.get("category"),
            "prev_rank": item.get("prev_rank"),
        }
        if best is None or rank < int(best["rank"]):
            best = candidate
    return best


def build_period_windows(today: dt.date) -> dict[str, tuple[dt.date, dt.date]]:
    last_saturday = today - dt.timedelta(days=(today.weekday() - 5) % 7)
    month_end = today.replace(day=1) - dt.timedelta(days=1)
    month_start = month_end.replace(day=1)
    prev_month_end = month_start - dt.timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    prev2_month_end = prev_month_start - dt.timedelta(days=1)
    prev2_month_start = prev2_month_end.replace(day=1)
    yoy_month_start = month_start.replace(year=month_start.year - 1)
    yoy_month_end = month_end_for(yoy_month_start)
    return {
        "本周": (last_saturday - dt.timedelta(days=6), last_saturday),
        "上周": (last_saturday - dt.timedelta(days=13), last_saturday - dt.timedelta(days=7)),
        "上上周": (last_saturday - dt.timedelta(days=20), last_saturday - dt.timedelta(days=14)),
        "本月": (month_start, month_end),
        "上月": (prev_month_start, prev_month_end),
        "上上月": (prev2_month_start, prev2_month_end),
        "去年同月": (yoy_month_start, yoy_month_end),
    }


def month_end_for(day_in_month: dt.date) -> dt.date:
    if day_in_month.month == 12:
        return dt.date(day_in_month.year, 12, 31)
    return dt.date(day_in_month.year, day_in_month.month + 1, 1) - dt.timedelta(days=1)


def chunk_values(values: list[str], size: int) -> list[list[str]]:
    if size <= 0:
        raise ValueError("size must be positive")
    return [values[idx : idx + size] for idx in range(0, len(values), size)]
