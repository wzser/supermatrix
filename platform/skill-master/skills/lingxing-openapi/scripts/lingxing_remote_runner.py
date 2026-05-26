from __future__ import annotations

import json
import os
import socket
import subprocess
import ssl
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


REMOTE_TEMPLATE = r"""
import datetime as dt, gzip, hashlib, json, os, pathlib, subprocess, time, urllib.parse, urllib.request, zipfile

APP_ID = __APP_ID__
APP_SECRET = __APP_SECRET__
PAYLOAD = json.loads(__PAYLOAD_JSON__)

LISTING_API_PATH = "/erp/sc/data/mws/listing"
SEARCH_PRODUCT_API_PATH = "/listing/publish/openapi/amazon/product/search"
PUBLISH_API_PATH = "/listing/publish/openapi/amazon/product/publish"
PUBLISH_RESULT_API_PATH = "/listing/publish/openapi/amazon/product/list"

try:
    import requests
except ModuleNotFoundError as exc:
    raise SystemExit(f"Remote python missing requests: {exc}")


def sign_params(access_token, extra):
    ts = str(int(time.time()))
    params = {"access_token": access_token, "app_key": APP_ID, "timestamp": ts, **extra}
    pairs = []
    for key in sorted(params):
        value = params[key]
        if value == "":
            continue
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        pairs.append(f"{key}={value}")
    md5 = hashlib.md5("&".join(pairs).encode()).hexdigest().upper()
    keyhex = APP_ID.encode().hex()
    proc = subprocess.run(
        ["openssl", "enc", "-aes-128-ecb", "-K", keyhex, "-nosalt", "-base64"],
        input=md5.encode(),
        capture_output=True,
        check=True,
    )
    return {
        "access_token": access_token,
        "app_key": APP_ID,
        "timestamp": ts,
        "sign": "".join(proc.stdout.decode().splitlines()),
    }


def get_token():
    resp = requests.post(
        "https://openapi.lingxing.com/api/auth-server/oauth/access-token",
        files={"appId": (None, APP_ID), "appSecret": (None, APP_SECRET)},
        timeout=60,
    )
    resp.raise_for_status()
    payload = resp.json()
    if str(payload.get("code")) != "200":
        raise RuntimeError(payload)
    return payload["data"]["access_token"]


def call_json(access_token, api_path, *, method="POST", body=None, query=None, headers=None, timeout=90):
    body = body or {}
    query = query or {}
    params = sign_params(access_token, body if method.upper() == "POST" else query)
    if query:
        params.update(query)
    url = f"https://openapi.lingxing.com{api_path}"
    if method.upper() == "GET":
        resp = requests.get(url, params=params, timeout=timeout, headers=headers)
    else:
        resp = requests.post(url, params=params, json=body, headers=headers or {"Content-Type": "application/json"}, timeout=timeout)
    resp.raise_for_status()
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type:
        return {"kind": "json", "payload": resp.json()}
    return {"kind": "text", "payload": resp.text}


def call_compact_json(access_token, api_path, *, body=None, headers=None, timeout=90):
    body = body or {}
    params = sign_params(access_token, body)
    url = f"https://openapi.lingxing.com{api_path}"
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    resp = requests.post(
        url,
        params=params,
        data=raw,
        headers=headers or {"Content-Type": "application/json"},
        timeout=timeout,
    )
    resp.raise_for_status()
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type:
        return {"kind": "json", "payload": resp.json()}
    return {"kind": "text", "payload": resp.text}


def filtered_sellers(rows, country_codes):
    mapping = {"美国": "US", "加拿大": "CA", "墨西哥": "MX"}
    out = []
    for row in rows:
        code = mapping.get(row.get("country"), row.get("country"))
        if country_codes and code not in country_codes:
            continue
        copied = dict(row)
        copied["country_code"] = code
        out.append(copied)
    return out


def pick_best_small_category(items):
    best = None
    for item in items or []:
        try:
            rank = int(item.get("rank"))
        except (TypeError, ValueError):
            continue
        candidate = {"rank": rank, "category": item.get("category"), "prev_rank": item.get("prev_rank")}
        if best is None or rank < int(best["rank"]):
            best = candidate
    return best


def chunk_values(values, size):
    for idx in range(0, len(values), size):
        yield values[idx: idx + size]


def build_period_windows(today):
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


def month_end_for(day_in_month):
    if day_in_month.month == 12:
        return dt.date(day_in_month.year, 12, 31)
    return dt.date(day_in_month.year, day_in_month.month + 1, 1) - dt.timedelta(days=1)


def normalize_listing_row(row):
    return {
        "sid": int(row["sid"]),
        "seller_sku": row["seller_sku"],
        "title": row.get("item_name"),
        "asin1": row.get("asin1"),
    }


def auth_op():
    token = get_token()
    return {"token": token}


def call_op():
    token = get_token()
    result = call_json(
        token,
        PAYLOAD["api_path"],
        method=PAYLOAD.get("method", "POST"),
        body=PAYLOAD.get("body"),
        query=PAYLOAD.get("query"),
        headers=PAYLOAD.get("headers"),
        timeout=int(PAYLOAD.get("timeout", 90)),
    )
    return {"access_mode": "remote", **result}


def seller_list_op():
    token = get_token()
    rows = call_json(token, "/erp/sc/data/seller/lists", method="GET", timeout=60)["payload"].get("data", [])
    return {"items": filtered_sellers(rows, set(PAYLOAD.get("countries") or []))}


def asin_rank_probe_op():
    token = get_token()
    sellers = call_json(token, "/erp/sc/data/seller/lists", method="GET", timeout=60)["payload"].get("data", [])
    us_sids = sorted(int(s["sid"]) for s in filtered_sellers(sellers, {"US"}) if s.get("status") == 1)
    sleep_seconds = float(PAYLOAD.get("sleep_seconds", 6.0))
    windows = PAYLOAD["windows"]
    results = []
    for window_index, window in enumerate(windows):
        for asin_batch in chunk_values(PAYLOAD["asins"], int(PAYLOAD.get("batch_size", 50))):
            body = {
                "offset": 0,
                "length": len(asin_batch),
                "sort_field": "volume",
                "sort_type": "desc",
                "search_field": "asin",
                "search_value": asin_batch,
                "mid": 1,
                "sid": us_sids,
                "start_date": window["start"],
                "end_date": window["end"],
                "summary_field": "asin",
            }
            raw = call_json(token, "/bd/productPerformance/openApi/asinList", body=body, timeout=90)["payload"]
            rows = ((raw.get("data") or {}).get("list") or []) if raw.get("code") == 0 else []
            for row in rows:
                resolved_asin = row.get("asin") or (asin_batch[0] if len(asin_batch) == 1 else None)
                results.append(
                    {
                        "asin": resolved_asin,
                        "window_label": window.get("label"),
                        "start_date": window["start"],
                        "end_date": window["end"],
                        "cate_rank": row.get("cate_rank"),
                        "prev_cate_rank": row.get("prev_cate_rank"),
                        "rank_category": row.get("rank_category"),
                        "small_best": pick_best_small_category(row.get("small_cate_rank")),
                        "ranking_update_time": row.get("ranking_update_time"),
                        "volume": row.get("volume"),
                        "amount": row.get("amount"),
                    }
                )
            if raw.get("code") == 103:
                time.sleep(float(PAYLOAD.get("rate_limit_sleep", 15.0)))
        if window_index != len(windows) - 1:
            time.sleep(sleep_seconds)
    return {"items": results, "us_sids": us_sids}


def asin_diagnostics_op():
    token = get_token()
    sellers = call_json(token, "/erp/sc/data/seller/lists", method="GET", timeout=60)["payload"].get("data", [])
    us_sids = sorted(int(s["sid"]) for s in filtered_sellers(sellers, {"US"}) if s.get("status") == 1)
    periods = PAYLOAD["periods"]
    asins = [asin.upper() for asin in PAYLOAD["asins"]]
    metrics = {asin: {name: {"units": 0.0, "sales": 0.0, "profit": 0.0, "ad_cost": 0.0, "ad_sales": 0.0} for name in periods} for asin in asins}
    anomalies = []
    page_length = int(PAYLOAD.get("page_length", 1000))
    for period_name, window in periods.items():
        start = dt.date.fromisoformat(window["start"])
        end = dt.date.fromisoformat(window["end"])
        chunk_start = start
        while chunk_start <= end:
            chunk_end = min(chunk_start + dt.timedelta(days=6), end)
            for asin_batch in chunk_values(asins, int(PAYLOAD.get("batch_size", 50))):
                offset = 0
                while True:
                    body = {
                        "offset": offset,
                        "length": page_length,
                        "sids": us_sids,
                        "startDate": chunk_start.isoformat(),
                        "endDate": chunk_end.isoformat(),
                        "searchField": "asin",
                        "searchValue": asin_batch,
                    }
                    raw = call_json(token, "/bd/profit/statistics/open/asin/list", body=body, timeout=120)["payload"]
                    records = ((raw.get("data") or {}).get("records") or []) if raw.get("code") == 0 else []
                    for record in records:
                        asin = str(record.get("asin") or "").upper()
                        if asin not in metrics:
                            continue
                        currency = record.get("currencyCode")
                        if currency and currency != "USD":
                            anomalies.append({"asin": asin, "period": period_name, "sid": record.get("sid"), "currencyCode": currency})
                            continue
                        bucket = metrics[asin][period_name]
                        bucket["units"] += float(record.get("totalSalesQuantity") or 0)
                        bucket["sales"] += float(record.get("totalSalesAmount") or 0)
                        bucket["profit"] += float(record.get("grossProfit") or 0)
                        bucket["ad_cost"] += abs(float(record.get("totalAdsCost") or 0))
                        bucket["ad_sales"] += float(record.get("totalAdsSales") or 0)
                    if len(records) < page_length:
                        break
                    offset += page_length
            chunk_start = chunk_end + dt.timedelta(days=1)
    return {"metrics": metrics, "anomalies": anomalies, "us_sids": us_sids}


def listing_inspect_op():
    token = get_token()
    if PAYLOAD.get("store_id") and PAYLOAD.get("sku"):
        listing = {
            "sid": int(PAYLOAD["store_id"]),
            "seller_sku": PAYLOAD["sku"],
            "title": None,
            "asin1": PAYLOAD.get("asin"),
        }
        product_raw = call_compact_json(
            token,
            SEARCH_PRODUCT_API_PATH,
            body={"store_id": listing["sid"], "skus": [listing["seller_sku"]]},
            timeout=120,
        )["payload"]
        product_data = product_raw.get("data") or []
        if isinstance(product_data, dict):
            product_rows = product_data.get("list") or []
        else:
            product_rows = product_data
        info = (product_rows or [None])[0]
        detail = info.get("info") if isinstance(info, dict) else None
        summaries = (detail or {}).get("summaries") or []
        product_types = (detail or {}).get("productTypes") or []
        resolved_product_type = (
            (summaries[0] or {}).get("productType")
            if summaries
            else ((product_types[0] or {}).get("productType") if product_types else None)
        )
        return {
            "listing": listing,
            "product_type": resolved_product_type,
            "attributes": (detail or {}).get("attributes") or {},
            "summaries": summaries,
            "raw_product_info": info,
            "raw_listing": None,
        }
    countries = set(PAYLOAD.get("countries") or [])
    sellers = call_json(token, "/erp/sc/data/seller/lists", method="GET", timeout=60)["payload"].get("data", [])
    seller_rows = [s for s in filtered_sellers(sellers, countries) if s.get("status") == 1]
    sid_value = ",".join(str(int(s["sid"])) for s in seller_rows)
    listing_body = {
        "offset": 0,
        "length": 20,
        "search_field": "asin",
        "search_value": [PAYLOAD["asin"]],
        "sid": sid_value,
    }
    listing_raw = call_json(token, LISTING_API_PATH, body=listing_body, timeout=120)["payload"]
    _lcode = str(listing_raw.get("code", ""))
    _ldata = listing_raw.get("data")
    if _lcode in ("0", "1"):
        if isinstance(_ldata, list):
            listing_rows = _ldata
        elif isinstance(_ldata, dict):
            listing_rows = _ldata.get("list") or []
        else:
            listing_rows = []
    else:
        listing_rows = []
    if not listing_rows:
        return {"listing": None, "raw_listing": listing_raw, "seller_count": len(seller_rows)}
    listing = normalize_listing_row(listing_rows[0])
    product_raw = call_compact_json(
        token,
        SEARCH_PRODUCT_API_PATH,
        body={"store_id": listing["sid"], "skus": [listing["seller_sku"]]},
        timeout=120,
    )["payload"]
    product_data = product_raw.get("data") or []
    if isinstance(product_data, dict):
        product_rows = product_data.get("list") or []
    else:
        product_rows = product_data
    info = (product_rows or [None])[0]
    detail = info.get("info") if isinstance(info, dict) else None
    summaries = (detail or {}).get("summaries") or []
    product_types = (detail or {}).get("productTypes") or []
    resolved_product_type = (
        (summaries[0] or {}).get("productType")
        if summaries
        else ((product_types[0] or {}).get("productType") if product_types else None)
    )
    return {
        "listing": listing,
        "product_type": resolved_product_type,
        "attributes": (detail or {}).get("attributes") or {},
        "summaries": summaries,
        "raw_product_info": info,
        "raw_listing": listing_raw,
    }


def listing_publish_op():
    token = get_token()
    raw = call_compact_json(
        token,
        PUBLISH_API_PATH,
        body=PAYLOAD["body"],
        timeout=int(PAYLOAD.get("timeout", 120)),
    )["payload"]
    return raw


def listing_publish_status_op():
    token = get_token()
    raw = call_compact_json(
        token,
        PUBLISH_RESULT_API_PATH,
        body=PAYLOAD["body"],
        timeout=int(PAYLOAD.get("timeout", 120)),
    )["payload"]
    return raw


def fetch_ad_reports_op():
    from datetime import date, timedelta
    DOC_BASE = "https://apidoc.lingxing.com/docs/newAd/report"
    REPORTS = PAYLOAD["reports"]
    token = get_token()
    sellers = call_json(token, "/erp/sc/data/seller/lists", method="GET", timeout=60)["payload"].get("data", [])
    seller_rows = [s for s in sellers if s.get("status") == 1 and s.get("has_ads_setting") == 1]

    def fetch_doc_api_path(doc):
        url = f"{DOC_BASE}/{doc}.md"
        text = requests.get(url, timeout=30).text
        import re
        match = re.search(r"\|\s*`([^`]+)`\s*\|", text)
        if not match:
            raise RuntimeError(f"cannot parse API path from doc {doc}")
        return match.group(1)

    def has_data(payload):
        data = payload.get("data")
        if isinstance(data, list):
            return len(data) > 0
        if isinstance(data, dict):
            if isinstance(data.get("list"), list):
                return len(data["list"]) > 0
            return bool(data)
        return False

    def date_candidates():
        today = date.today()
        return [today - timedelta(days=i) for i in range(1, 15)]

    summary = []
    for report in REPORTS:
        api_path = fetch_doc_api_path(report["doc"])
        hit = None
        for seller in seller_rows:
            for probe_date in date_candidates():
                body = {"sid": seller["sid"], "report_date": probe_date.isoformat(), "offset": 0, "length": 1}
                raw = call_json(
                    token,
                    api_path,
                    body=body,
                    headers={"Content-Type": "application/json", "X-API-VERSION": "2"},
                    timeout=90,
                )["payload"]
                if raw.get("code") == 0 and has_data(raw):
                    hit = {"sid": seller["sid"], "report_date": probe_date.isoformat(), "api_path": api_path, "rows": len(raw.get("data", [])) if isinstance(raw.get("data"), list) else None}
                    break
            if hit:
                break
        summary.append({"doc": report["doc"], "family": report["family"], "kind": report["kind"], **(hit or {"status": "no_data_found", "api_path": api_path})})
    return {"items": summary}


def download_aba_op():
    token = get_token()
    raw = call_json(
        token,
        PAYLOAD["api_path"],
        body=PAYLOAD.get("body"),
        headers=PAYLOAD.get("headers") or {"Content-Type": "application/json"},
        timeout=int(PAYLOAD.get("timeout", 120)),
    )["payload"]
    download_url = None
    for key in PAYLOAD.get("download_url_keys") or []:
        current = raw
        found = True
        for part in key.split("."):
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                found = False
                break
        if found and current:
            download_url = current
            break
    if not download_url:
        return {"metadata": raw, "downloaded": False}
    resp = requests.get(download_url, timeout=300, stream=True)
    resp.raise_for_status()
    target = pathlib.Path(PAYLOAD["remote_temp_path"])
    with open(target, "wb") as handle:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)
    extracted_path = None
    if target.suffix == ".zip":
        with zipfile.ZipFile(target) as zf:
            names = [name for name in zf.namelist() if not name.endswith("/")]
            if names:
                extracted_path = str(target.with_suffix(""))
                with zf.open(names[0]) as src, open(extracted_path, "wb") as dst:
                    dst.write(src.read())
    elif target.suffix in {".gz", ".gzip"}:
        extracted_path = str(target.with_suffix(""))
        with gzip.open(target, "rb") as src, open(extracted_path, "wb") as dst:
            dst.write(src.read())
    return {
        "metadata": raw,
        "downloaded": True,
        "remote_temp_path": str(target),
        "remote_extracted_path": extracted_path,
    }


OPS = {
    "auth": auth_op,
    "call": call_op,
    "seller-list": seller_list_op,
    "asin-rank-probe": asin_rank_probe_op,
    "asin-diagnostics": asin_diagnostics_op,
    "fetch-ad-reports": fetch_ad_reports_op,
    "download-aba": download_aba_op,
    "listing-inspect": listing_inspect_op,
    "listing-publish": listing_publish_op,
    "listing-publish-status": listing_publish_status_op,
}


result = OPS[PAYLOAD["operation"]]()
print(json.dumps(result, ensure_ascii=False))
"""


def _preflight_relay_tcp(config: dict[str, Any], url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if not parsed.hostname:
        return
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    timeout = int(config.get("relay_connect_timeout") or 8)
    try:
        with socket.create_connection((parsed.hostname, port), timeout=timeout):
            return
    except OSError as exc:
        raise RuntimeError(f"Lingxing relay TCP connect failed: {exc}") from exc


def _run_relay_operation(config: dict[str, Any], operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps({"operation": operation, **payload}, ensure_ascii=False).encode("utf-8")
    url = str(config["relay_url"]).rstrip("/") + "/v1/operation"
    _preflight_relay_tcp(config, url)
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config['relay_token']}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    context = None
    if url.startswith("https://"):
        ca_cert_path = str(config.get("relay_ca_cert_path") or "").strip()
        if ca_cert_path:
            context = ssl.create_default_context(cafile=ca_cert_path)
        elif not config.get("relay_tls_verify", True):
            context = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(request, timeout=int(config.get("relay_timeout") or config["default_timeout"]), context=context) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Lingxing relay HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Lingxing relay request failed: {exc.reason}") from exc
    return json.loads(raw)


def _run_ssh_operation(config: dict[str, Any], operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    remote_code = (
        REMOTE_TEMPLATE.replace("__APP_ID__", json.dumps(config["app_id"]))
        .replace("__APP_SECRET__", json.dumps(config["app_secret"]))
        .replace("__PAYLOAD_JSON__", json.dumps(json.dumps({"operation": operation, **payload}, ensure_ascii=False)))
    )
    cmd = [
        "ssh",
        "-i",
        str(config["server_key_path"]),
        f'{config["server_user"]}@{config["server_host"]}',
        "python3",
        "-",
    ]
    try:
        proc = subprocess.run(
            cmd,
            input=remote_code,
            text=True,
            capture_output=True,
            check=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        if "Operation not permitted" in detail:
            raise RuntimeError(
                "SSH was blocked by the current sandbox. Re-run this command in a normal terminal "
                "or through a Codex shell action with SSH permission."
            ) from exc
        raise RuntimeError(detail or str(exc)) from exc
    return json.loads(proc.stdout)


def run_remote_operation(config: dict[str, Any], operation: str, payload: dict[str, Any]) -> dict[str, Any]:
    if config.get("relay_url"):
        try:
            return _run_relay_operation(config, operation, payload)
        except Exception:
            if not config.get("relay_fallback_to_ssh", True) or not config.get("server_key_path"):
                raise
    return _run_ssh_operation(config, operation, payload)
