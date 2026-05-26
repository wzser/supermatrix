#!/usr/bin/env python3
from __future__ import annotations

import hmac
import json
import os
import ssl
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from lingxing_remote_runner import REMOTE_TEMPLATE


DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 18443
MAX_BODY_BYTES = 10 * 1024 * 1024


def is_authorized(header_value: str | None, expected_token: str) -> bool:
    if not header_value or not expected_token:
        return False
    prefix = "Bearer "
    if not header_value.startswith(prefix):
        return False
    return hmac.compare_digest(header_value[len(prefix) :], expected_token)


def build_embedded_operation_code(app_id: str, app_secret: str, operation: str, payload: dict[str, Any]) -> str:
    operation_payload = {"operation": operation, **payload}
    return (
        REMOTE_TEMPLATE.replace("__APP_ID__", json.dumps(app_id))
        .replace("__APP_SECRET__", json.dumps(app_secret))
        .replace("__PAYLOAD_JSON__", json.dumps(json.dumps(operation_payload, ensure_ascii=False)))
    )


def run_embedded_operation(app_id: str, app_secret: str, operation: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    code = build_embedded_operation_code(app_id, app_secret, operation, payload)
    proc = subprocess.run(
        ["python3", "-"],
        input=code,
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(detail or f"embedded operation failed with exit code {proc.returncode}")
    return json.loads(proc.stdout)


def make_handler(app_id: str, app_secret: str, relay_token: str, operation_timeout: int):
    class LingxingRelayHandler(BaseHTTPRequestHandler):
        server_version = "LingxingOpenAPIRelay/1.0"

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"{self.address_string()} - {fmt % args}", flush=True)

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(200, {"ok": True})
                return
            self._send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/v1/operation":
                self._send_json(404, {"error": "not_found"})
                return
            if not is_authorized(self.headers.get("Authorization"), relay_token):
                self._send_json(401, {"error": "unauthorized"})
                return
            try:
                content_length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                self._send_json(400, {"error": "invalid_content_length"})
                return
            if content_length <= 0 or content_length > MAX_BODY_BYTES:
                self._send_json(413, {"error": "invalid_body_size"})
                return
            try:
                request_payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                operation = request_payload.pop("operation")
                result = run_embedded_operation(app_id, app_secret, operation, request_payload, operation_timeout)
            except KeyError:
                self._send_json(400, {"error": "missing_operation"})
                return
            except Exception as exc:
                self._send_json(502, {"error": "operation_failed", "detail": str(exc)})
                return
            self._send_json(200, result)

    return LingxingRelayHandler


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def main() -> None:
    app_id = env_required("LINGXING_APP_ID")
    app_secret = env_required("LINGXING_APP_SECRET")
    relay_token = env_required("LINGXING_RELAY_TOKEN")
    host = os.environ.get("LINGXING_RELAY_HOST", DEFAULT_HOST)
    port = int(os.environ.get("LINGXING_RELAY_PORT", DEFAULT_PORT))
    operation_timeout = int(os.environ.get("LINGXING_RELAY_OPERATION_TIMEOUT", "180"))
    certfile = os.environ.get("LINGXING_RELAY_CERTFILE", "").strip()
    keyfile = os.environ.get("LINGXING_RELAY_KEYFILE", "").strip()

    server = ThreadingHTTPServer((host, port), make_handler(app_id, app_secret, relay_token, operation_timeout))
    if certfile and keyfile:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=certfile, keyfile=keyfile)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    scheme = "https" if certfile and keyfile else "http"
    print(f"lingxing relay listening on {scheme}://{host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
