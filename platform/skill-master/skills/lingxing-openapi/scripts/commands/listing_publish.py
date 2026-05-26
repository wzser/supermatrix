from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import time
import urllib.parse
from pathlib import Path
from typing import Any

from lingxing_remote_runner import run_remote_operation


MARKETPLACE_ID = "ATVPDKIKX0DER"
GET_IMAGE_URL_SCRIPT = Path.home() / ".codex" / "skills" / "get-image-url" / "scripts" / "see_upload.py"
SEE_CONFIG_PATH = Path.home() / ".codex" / "get-image-url.json"
CATBOX_UPLOAD_URL = "https://litterbox.catbox.moe/resources/internals/api.php"


def localized_text(value: str) -> list[dict[str, str]]:
    return [{"value": value, "language_tag": "en_US", "marketplace_id": MARKETPLACE_ID}]


def image_slot(url: str) -> list[dict[str, str]]:
    return [{"media_location": url, "marketplace_id": MARKETPLACE_ID}]


def _load_see_token(upload_token: str | None = None) -> str | None:
    if upload_token:
        return upload_token.strip() or None
    env_token = os.environ.get("SEE_API_TOKEN", "").strip()
    if env_token:
        return env_token
    if SEE_CONFIG_PATH.exists():
        try:
            payload = json.loads(SEE_CONFIG_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            payload = {}
        token = str(payload.get("api_token", "")).strip()
        if token:
            return token
    return None


def upload_via_see(path: Path, *, token: str | None, domain: str | None) -> dict[str, Any]:
    cmd = ["python3", str(GET_IMAGE_URL_SCRIPT), "upload", str(path)]
    if token:
        cmd.extend(["--token", token])
    if domain:
        cmd.extend(["--domain", domain])
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Failed to parse get-image-url output for {path}: {exc}")
    if proc.returncode != 0 or not payload.get("success"):
        error = payload.get("error") or {}
        kind = error.get("kind") or "upload_failed"
        message = error.get("message") or proc.stderr.strip() or "S.EE upload failed"
        raise RuntimeError(json.dumps({"backend": "see", "kind": kind, "message": message}, ensure_ascii=False))
    uploaded = (payload.get("uploaded") or [None])[0]
    if not uploaded or not uploaded.get("url"):
        raise SystemExit(f"S.EE upload for {path} returned no usable URL.")
    return {"backend": "see", **uploaded}


def upload_via_catbox(path: Path) -> dict[str, Any]:
    cmd = [
        "curl",
        "-fsS",
        "-F",
        "reqtype=fileupload",
        "-F",
        f"fileToUpload=@{path}",
        CATBOX_UPLOAD_URL,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise SystemExit(f"Catbox upload failed for {path}: {(proc.stderr or proc.stdout).strip()}")
    url = (proc.stdout or "").strip()
    if not url.startswith("http"):
        raise SystemExit(f"Catbox upload for {path} returned unexpected response: {url}")
    return {
        "backend": "catbox",
        "source_path": str(path),
        "url": url,
        "page": None,
        "delete_url": None,
        "file_id": None,
        "hash": None,
        "domain": urllib.parse.urlparse(url).netloc or None,
    }


def upload_local_image(path_value: str, *, backend: str, upload_token: str | None, upload_domain: str | None) -> dict[str, Any]:
    path = Path(path_value).expanduser().resolve()
    if not path.is_file():
        raise SystemExit(f"Local image path does not exist: {path}")
    selected_backend = backend
    if selected_backend == "auto":
        selected_backend = "see" if _load_see_token(upload_token) else "catbox"
    if selected_backend == "see":
        token = _load_see_token(upload_token)
        if not token:
            raise SystemExit(
                "No S.EE token found for automatic upload. Set SEE_API_TOKEN or ~/.codex/get-image-url.json, "
                "or use --image-upload-backend catbox."
            )
        return upload_via_see(path, token=token, domain=upload_domain)
    if selected_backend == "catbox":
        return upload_via_catbox(path)
    raise SystemExit(f"Unsupported image upload backend: {backend}")


def resolve_slot_url(url_value: str | None, path_value: str | None, *, backend: str, upload_token: str | None, upload_domain: str | None) -> tuple[str | None, dict[str, Any] | None]:
    if url_value and path_value:
        raise SystemExit("Do not pass both a URL and a local path for the same image slot.")
    if path_value:
        upload_meta = upload_local_image(path_value, backend=backend, upload_token=upload_token, upload_domain=upload_domain)
        return str(upload_meta["url"]), upload_meta
    return url_value, None


def prepare_images(args) -> tuple[dict[str, str | None], list[dict[str, Any]]]:
    backend = getattr(args, "image_upload_backend", "auto")
    upload_token = getattr(args, "upload_token", None)
    upload_domain = getattr(args, "upload_domain", None)
    mappings = [
        ("main_image_url", "main_image_path", "main"),
        ("image1_url", "image1_path", "image1"),
        ("image2_url", "image2_path", "image2"),
    ]
    resolved: dict[str, str | None] = {}
    uploads: list[dict[str, Any]] = []
    for url_key, path_key, slot in mappings:
        url_value, meta = resolve_slot_url(
            getattr(args, url_key, None),
            getattr(args, path_key, None),
            backend=backend,
            upload_token=upload_token,
            upload_domain=upload_domain,
        )
        resolved[url_key] = url_value
        if meta:
            uploads.append({"slot": slot, **meta})
    return resolved, uploads


def build_attributes(mode: str, args, image_inputs: dict[str, str | None]) -> dict[str, Any]:
    attributes: dict[str, Any] = {}
    title = getattr(args, "title", None)
    bullets = list(getattr(args, "bullet", None) or [])
    description = getattr(args, "description", None)
    main_image = image_inputs.get("main_image_url")
    image1 = image_inputs.get("image1_url")
    image2 = image_inputs.get("image2_url")

    if mode in {"title", "update"} and title:
        attributes["item_name"] = localized_text(title)
    elif mode == "title":
        raise SystemExit("listing-title requires --title")

    if mode in {"bullets", "update"}:
        if bullets:
            attributes["bullet_point"] = [localized_text(item)[0] for item in bullets]
        if description:
            attributes["product_description"] = localized_text(description)
        if mode == "bullets" and not attributes:
            raise SystemExit("listing-bullets requires at least one --bullet or --description")

    if mode in {"images", "update"}:
        if main_image:
            attributes["main_product_image_locator"] = image_slot(main_image)
        if image1:
            attributes["other_product_image_locator_1"] = image_slot(image1)
        if image2:
            attributes["other_product_image_locator_2"] = image_slot(image2)
        if mode == "images" and not any([main_image, image1, image2]):
            raise SystemExit("listing-images requires at least one of --main-image-url, --image1-url, --image2-url")

    if mode == "update" and not attributes:
        raise SystemExit(
            "listing-update requires at least one of --title, --bullet, --description, "
            "--main-image-url, --image1-url, --image2-url"
        )
    return attributes


def build_publish_body(inspect_info: dict[str, Any], attributes: dict[str, Any]) -> dict[str, Any]:
    listing = inspect_info["listing"]
    return {
        "store_id": listing["sid"],
        "data": [
            {
                "sku": listing["seller_sku"],
                "productType": inspect_info["product_type"],
                "attributes": attributes,
                "operationType": 1,
            }
        ],
    }


def resolve_output_dir(args, config: dict[str, Any]) -> Path:
    base = Path(getattr(args, "output_dir", None) or config["default_output_dir"]).resolve()
    target = base / "listing-publish" / dt.date.today().isoformat()
    target.mkdir(parents=True, exist_ok=True)
    return target


def dump_json(output_dir: Path, prefix: str, payload: dict[str, Any]) -> Path:
    path = output_dir / f"{prefix}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def inspect_listing(config: dict[str, Any], asin: str, *, store_id: int | None = None, sku: str | None = None) -> dict[str, Any]:
    payload = {
        "asin": asin.upper(),
        "countries": [item.upper() for item in config["default_site_filters"]],
    }
    if store_id:
        payload["store_id"] = int(store_id)
    if sku:
        payload["sku"] = sku
    result = run_remote_operation(config, "listing-inspect", payload)
    if not result.get("listing"):
        raise SystemExit(f"No listing found for ASIN {asin}")
    if not result.get("product_type"):
        raise SystemExit(f"No product_type returned for ASIN {asin}")
    return result


def poll_once(config: dict[str, Any], record_id: str, store_id: int) -> dict[str, Any]:
    return run_remote_operation(
        config,
        "listing-publish-status",
        {
            "body": {
                "offset": 0,
                "length": 20,
                "record_unique_id": record_id,
                "store_id": store_id,
            }
        },
    )


def summarize_rows(raw: dict[str, Any]) -> list[dict[str, Any]]:
    data = raw.get("data") or []
    if isinstance(data, dict):
        return data.get("list") or []
    return data


def maybe_poll(args, config: dict[str, Any], output_dir: Path, record_id: str, store_id: int) -> dict[str, Any]:
    attempts = int(getattr(args, "poll_attempts", 1))
    sleep_seconds = float(getattr(args, "poll_sleep", 15.0))
    latest_raw: dict[str, Any] | None = None
    rows: list[dict[str, Any]] = []
    for attempt in range(attempts):
        latest_raw = poll_once(config, record_id, store_id)
        rows = summarize_rows(latest_raw)
        if rows and int(rows[0].get("status") or 0) != 0:
            break
        if attempt != attempts - 1:
            time.sleep(sleep_seconds)
    poll_path = dump_json(output_dir, f"poll-{record_id}", latest_raw or {"data": []})
    first_row = rows[0] if rows else {}
    return {
        "poll_output_file": str(poll_path),
        "poll_rows": rows,
        "final_status": first_row.get("status"),
        "failure_reason": first_row.get("failure_reason"),
    }


def submit_mode(mode: str, args, config: dict[str, Any]) -> dict[str, Any]:
    output_dir = resolve_output_dir(args, config)
    inspect_info = inspect_listing(config, args.asin, store_id=getattr(args, "store_id", None), sku=getattr(args, "sku", None))
    inspect_path = dump_json(output_dir, f"inspect-{args.asin.upper()}", inspect_info)
    image_inputs, upload_artifacts = prepare_images(args)
    if upload_artifacts:
        dump_json(output_dir, f"uploads-{args.asin.upper()}-{mode}", {"uploads": upload_artifacts})
    attributes = build_attributes(mode, args, image_inputs)
    body = build_publish_body(inspect_info, attributes)
    response = run_remote_operation(config, "listing-publish", {"body": body})
    submit_payload = {
        "asin": args.asin.upper(),
        "mode": mode,
        "submitted_at": dt.datetime.now().isoformat(timespec="seconds"),
        "inspect": inspect_info,
        "request_body": body,
        "response": response,
    }
    submit_path = dump_json(output_dir, f"submit-{args.asin.upper()}-{mode}", submit_payload)
    record_id = ((response.get("data") or {}).get("record_unique_id"))
    result = {
        "status": "ok",
        "inspect_output_file": str(inspect_path),
        "submit_output_file": str(submit_path),
        "upload_count": len(upload_artifacts),
        "uploads": upload_artifacts,
        "record_unique_id": record_id,
        "store_id": body["store_id"],
        "sku": body["data"][0]["sku"],
    }
    if getattr(args, "poll", False) and record_id:
        result.update(maybe_poll(args, config, output_dir, str(record_id), int(body["store_id"])))
    return result


def run_title(args, config: dict[str, Any]) -> dict[str, Any]:
    return submit_mode("title", args, config)


def run_bullets(args, config: dict[str, Any]) -> dict[str, Any]:
    return submit_mode("bullets", args, config)


def run_images(args, config: dict[str, Any]) -> dict[str, Any]:
    return submit_mode("images", args, config)


def run_update(args, config: dict[str, Any]) -> dict[str, Any]:
    return submit_mode("update", args, config)


def run_status(args, config: dict[str, Any]) -> dict[str, Any]:
    output_dir = resolve_output_dir(args, config)
    raw = poll_once(config, args.record_id, int(args.store_id))
    rows = summarize_rows(raw)
    poll_path = dump_json(output_dir, f"poll-{args.record_id}", raw)
    first_row = rows[0] if rows else {}
    return {
        "status": "ok",
        "poll_output_file": str(poll_path),
        "rows": rows,
        "final_status": first_row.get("status"),
        "failure_reason": first_row.get("failure_reason"),
    }
