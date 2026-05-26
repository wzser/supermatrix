#!/usr/bin/env python3

import argparse
import json
import mimetypes
import os
import subprocess
import sys
import urllib.parse
import uuid
from pathlib import Path


API_BASE_URL = "https://s.ee/api/v1"
CONFIG_FILENAME = "get-image-url.json"
DEFAULT_TIMEOUT = 60


class CommandError(Exception):
    def __init__(self, kind, message, exit_code=2, **details):
        super().__init__(message)
        self.exit_code = exit_code
        self.payload = error_payload(kind, message, **details)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise CommandError("invalid_arguments", message, exit_code=2)


def codex_home_path(codex_home=None):
    if codex_home is not None:
        return Path(codex_home).expanduser()
    raw = os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    return Path(raw).expanduser()


def load_local_config(codex_home=None):
    config_path = codex_home_path(codex_home) / CONFIG_FILENAME
    if not config_path.exists():
        return {}
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CommandError(
            "invalid_config",
            "Local get-image-url config is not valid JSON.",
            exit_code=2,
            config_path=str(config_path),
            details=str(exc),
        )
    if not isinstance(payload, dict):
        raise CommandError(
            "invalid_config",
            "Local get-image-url config must be a JSON object.",
            exit_code=2,
            config_path=str(config_path),
        )
    return payload


def resolve_runtime_config(args, env=None, codex_home=None):
    env = dict(env or {})
    local_config = load_local_config(codex_home=codex_home)
    token = (
        (getattr(args, "token", None) or "").strip()
        or str(local_config.get("api_token", "")).strip()
        or str(env.get("SEE_API_TOKEN", "")).strip()
    )
    default_domain = (
        str(local_config.get("default_domain", "")).strip()
        or str(env.get("SEE_DEFAULT_DOMAIN", "")).strip()
    )
    selected_domain = (getattr(args, "domain", None) or "").strip() or default_domain
    return {
        "token": token,
        "default_domain": default_domain or None,
        "selected_domain": selected_domain or None,
        "config_path": str(codex_home_path(codex_home) / CONFIG_FILENAME),
    }


def build_multipart_body(
    fields,
    file_field_name,
    filename,
    content,
    mime_type=None,
    boundary=None,
):
    boundary = boundary or uuid.uuid4().hex
    mime_type = mime_type or "application/octet-stream"
    lines = []
    for name, value in fields.items():
        if value in (None, ""):
            continue
        lines.extend(
            [
                "--{0}".format(boundary).encode("utf-8"),
                'Content-Disposition: form-data; name="{0}"'.format(name).encode(
                    "utf-8"
                ),
                b"",
                str(value).encode("utf-8"),
            ]
        )
    lines.extend(
        [
            "--{0}".format(boundary).encode("utf-8"),
            'Content-Disposition: form-data; name="{0}"; filename="{1}"'.format(
                file_field_name, filename
            ).encode("utf-8"),
            "Content-Type: {0}".format(mime_type).encode("utf-8"),
            b"",
            content,
            "--{0}--".format(boundary).encode("utf-8"),
            b"",
        ]
    )
    body = b"\r\n".join(lines)
    return body, "multipart/form-data; boundary={0}".format(boundary)


def error_payload(kind, message, **details):
    error = {"kind": kind, "message": message}
    for key, value in details.items():
        if value is not None:
            error[key] = value
    return {"success": False, "error": error}


def emit_json(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def parse_json_bytes(raw_bytes):
    text = raw_bytes.decode("utf-8", errors="replace").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise CommandError(
            "invalid_response",
            "S.EE API did not return valid JSON.",
            exit_code=1,
            response_text=text[:500],
        )


def extract_message(payload, fallback):
    if isinstance(payload, dict):
        for key in ("message", "error", "msg"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("message", "error", "msg"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return fallback


def has_upload_data(payload):
    data = payload.get("data")
    return isinstance(data, dict) and bool(data.get("url") or data.get("page"))


def build_curl_command(
    method,
    path,
    auth_value,
    headers=None,
    body=None,
    form_fields=None,
    timeout=DEFAULT_TIMEOUT,
):
    headers = dict(headers or {})
    headers.setdefault("Accept", "application/json")
    command = [
        "curl",
        "-sS",
        "-X",
        method.upper(),
        API_BASE_URL + path,
        "--max-time",
        str(timeout),
        "-H",
        "Authorization: {0}".format(auth_value),
    ]
    for key, value in headers.items():
        if key.lower() == "authorization":
            continue
        command.extend(["-H", "{0}: {1}".format(key, value)])
    if form_fields:
        for field in form_fields:
            command.extend(["-F", field])
    elif body is not None:
        command.extend(["--data-binary", "@-"])
    return command


def is_auth_error_payload(payload):
    if not isinstance(payload, dict):
        return False
    code = str(payload.get("code", "")).strip().lower()
    status = payload.get("status")
    return code in ("unauthorized", "auth_failed", "invalid_token") or status in (401, 403)


def is_error_payload(payload):
    if not isinstance(payload, dict):
        return False
    if payload.get("success") is False and not has_upload_data(payload):
        return True
    status = payload.get("status")
    if isinstance(status, int) and status >= 400:
        return True
    if payload.get("cloudflare_error"):
        return True
    return False


def request_json(
    method,
    path,
    token,
    headers=None,
    body=None,
    form_fields=None,
    timeout=DEFAULT_TIMEOUT,
    runner=None,
):
    runner = runner or subprocess.run
    auth_values = ["Bearer {0}".format(token), token]
    last_payload = None

    for index, auth_value in enumerate(auth_values):
        command = build_curl_command(
            method=method,
            path=path,
            auth_value=auth_value,
            headers=headers,
            body=body,
            form_fields=form_fields,
            timeout=timeout,
        )
        try:
            completed = runner(
                command,
                input=body if body is not None else None,
                capture_output=True,
                check=False,
            )
        except FileNotFoundError:
            raise CommandError(
                "missing_dependency",
                "The get-image-url skill requires curl on PATH.",
                exit_code=2,
                dependency="curl",
            )
        stdout = completed.stdout or b""
        stderr = completed.stderr or b""
        payload = parse_json_bytes(stdout) if stdout.strip() else {}
        last_payload = payload or last_payload

        if completed.returncode != 0 and not payload:
            raise CommandError(
                "network_error",
                "Unable to reach the S.EE API.",
                exit_code=1,
                details=stderr.decode("utf-8", errors="replace").strip() or str(completed.returncode),
            )

        if is_error_payload(payload):
            if is_auth_error_payload(payload) and index == 0:
                continue
            raise CommandError(
                "api_error",
                extract_message(payload, "S.EE API request failed."),
                exit_code=1,
                status=payload.get("status"),
                code=payload.get("code"),
                response=payload,
            )

        if not payload and completed.returncode != 0:
            raise CommandError(
                "network_error",
                "Unable to reach the S.EE API.",
                exit_code=1,
                details=stderr.decode("utf-8", errors="replace").strip() or str(completed.returncode),
            )

        return payload

    raise CommandError(
        "api_error",
        extract_message(last_payload or {}, "S.EE API request failed."),
        exit_code=1,
        code=(last_payload or {}).get("code"),
        response=last_payload,
    )


def extract_domain_names(payload):
    data = payload.get("data")
    if not isinstance(data, list):
        return []
    names = []
    for item in data:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
            continue
        if isinstance(item, dict):
            for key in ("domain", "name", "host", "url"):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    parsed = urllib.parse.urlparse(value if "://" in value else "https://{0}".format(value))
                    names.append((parsed.netloc or parsed.path).strip())
                    break
    return names


def fetch_available_domains(token, timeout=DEFAULT_TIMEOUT, runner=None):
    payload = request_json(
        "GET",
        "/file/domains",
        token,
        timeout=timeout,
        runner=runner,
    )
    return payload, extract_domain_names(payload)


def first_present(*values):
    for value in values:
        if value not in (None, ""):
            return value
    return None


def coerce_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def derive_domain(page_url, file_url, requested_domain):
    for candidate in (page_url, file_url):
        if not candidate:
            continue
        parsed = urllib.parse.urlparse(candidate)
        if parsed.netloc:
            return parsed.netloc
    return requested_domain


def normalize_upload_result(source_path, payload, requested_domain=None, is_private=False):
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    file_url = first_present(data.get("url"), data.get("src"))
    page_url = first_present(
        data.get("page"),
        data.get("page_url"),
        data.get("share_url"),
    )
    delete_url = first_present(data.get("delete"), data.get("delete_url"))
    file_hash = first_present(data.get("hash"), data.get("file_hash"))
    filename = first_present(data.get("filename"), data.get("origin_name"), source_path.name)
    storename = first_present(data.get("storename"), data.get("store_name"))
    if not storename and file_url:
        storename = Path(urllib.parse.urlparse(file_url).path).name

    return {
        "source_path": str(source_path),
        "file_id": coerce_int(data.get("file_id")),
        "filename": filename,
        "storename": storename,
        "url": file_url,
        "page": page_url,
        "delete_url": delete_url,
        "delete_key": file_hash,
        "hash": file_hash,
        "size": coerce_int(data.get("size")),
        "width": coerce_int(data.get("width")),
        "height": coerce_int(data.get("height")),
        "upload_status": coerce_int(data.get("upload_status")),
        "domain": derive_domain(page_url, file_url, requested_domain),
        "is_private": bool(is_private),
        "markdown": "![{0}]({1})".format(filename, file_url) if file_url else "",
        "raw": payload,
    }


def validate_source_paths(raw_paths):
    source_paths = []
    for raw_path in raw_paths:
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise CommandError(
                "missing_file",
                "Upload source file does not exist.",
                exit_code=2,
                source_path=str(path),
            )
        source_paths.append(path.resolve())
    return source_paths


def guess_mime_type(path):
    mime_type, _ = mimetypes.guess_type(path.name)
    return mime_type or "application/octet-stream"


def upload_file(
    source_path,
    token,
    domain=None,
    custom_slug=None,
    is_private=False,
    timeout=DEFAULT_TIMEOUT,
    runner=None,
):
    fields = []
    if domain:
        fields.append("domain={0}".format(domain))
    if custom_slug:
        fields.append("custom_slug={0}".format(custom_slug))
    if is_private:
        fields.append("is_private=1")
    fields.append("file=@{0};type={1}".format(source_path, guess_mime_type(source_path)))

    payload = request_json(
        "POST",
        "/file/upload",
        token,
        form_fields=fields,
        timeout=timeout,
        runner=runner,
    )
    return normalize_upload_result(
        source_path=source_path,
        payload=payload,
        requested_domain=domain,
        is_private=is_private,
    )


def cmd_upload(args, env=None, codex_home=None, runner=None):
    if args.custom_slug and len(args.paths) != 1:
        raise CommandError(
            "invalid_arguments",
            "--custom-slug can only be used with a single file upload.",
            exit_code=2,
        )
    if not args.paths:
        raise CommandError(
            "invalid_arguments",
            "At least one file path is required.",
            exit_code=2,
        )

    runtime_config = resolve_runtime_config(args, env=env, codex_home=codex_home)
    token = runtime_config["token"]
    if not token:
        raise CommandError(
            "missing_token",
            "Missing S.EE API token. Provide --token, add ~/.codex/get-image-url.json, or set SEE_API_TOKEN.",
            exit_code=2,
            config_path=runtime_config["config_path"],
        )

    source_paths = validate_source_paths(args.paths)
    selected_domain = runtime_config["selected_domain"]
    _, available_domains = fetch_available_domains(
        token,
        timeout=args.timeout,
        runner=runner,
    )
    if selected_domain and available_domains and selected_domain not in available_domains:
        raise CommandError(
            "invalid_domain",
            "Requested upload domain is not available for this account.",
            exit_code=2,
            domain=selected_domain,
            available_domains=available_domains,
        )

    uploaded = []
    for source_path in source_paths:
        uploaded.append(
            upload_file(
                source_path=source_path,
                token=token,
                domain=selected_domain,
                custom_slug=args.custom_slug,
                is_private=args.is_private,
                timeout=args.timeout,
                runner=runner,
            )
        )

    return {"success": True, "uploaded": uploaded}


def build_parser():
    parser = JsonArgumentParser(description="Upload local files to S.EE.")
    subparsers = parser.add_subparsers(dest="command", parser_class=JsonArgumentParser)

    upload_parser = subparsers.add_parser("upload", help="Upload one or more local files.")
    upload_parser.add_argument("paths", nargs="*", help="Local file paths to upload.")
    upload_parser.add_argument(
        "--token",
        help="Override the S.EE API token for this run.",
    )
    upload_parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="HTTP timeout in seconds.",
    )
    upload_parser.add_argument(
        "--domain",
        help="Optional S.EE domain to use for the uploaded file URLs.",
    )
    upload_parser.add_argument(
        "--custom-slug",
        help="Optional custom slug. Only valid for a single file upload.",
    )
    upload_parser.add_argument(
        "--private",
        dest="is_private",
        action="store_true",
        help="Upload as a private file.",
    )
    return parser


def main(argv=None, env=None, codex_home=None, runner=None):
    argv = list(argv or sys.argv[1:])
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
        if args.command != "upload":
            raise CommandError(
                "invalid_arguments",
                "Missing command. Use: upload <path> [<path> ...]",
                exit_code=2,
            )
        payload = cmd_upload(args, env=env, codex_home=codex_home, runner=runner)
    except CommandError as exc:
        emit_json(exc.payload)
        return exc.exit_code

    emit_json(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
