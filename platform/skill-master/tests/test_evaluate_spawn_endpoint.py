from __future__ import annotations

import importlib.util
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str):
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts/evaluate-skills.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_spawn_uses_non_default_sm_api_base_with_real_local_stub(monkeypatch):
    requests: list[tuple[str, dict]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - stdlib handler hook
            body = self.rfile.read(int(self.headers["Content-Length"]))
            requests.append((self.path, json.loads(body)))
            response = json.dumps({"ok": True, "finalMessage": "NONE"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        monkeypatch.setenv("SM_API_BASE", f"http://127.0.0.1:{server.server_port}/configured/")
        evaluate = load_module("evaluate_skills_spawn_endpoint")
        reply, error = evaluate.spawn("demo-session", "probe", "codex", "2026-09-14")
    finally:
        server.shutdown()
        thread.join(timeout=5)

    assert error is None
    assert reply == "NONE"
    assert requests == [
        (
            "/configured/api/spawn2.0",
            {
                "from": "skill-master",
                "target": "demo-session",
                "prompt": "probe",
                "client_request_id": "2026-09-14:skill-master:eval-fanout:demo-session",
                "execution": {"backend": "codex"},
                "closure": {"kind": "message", "target": {"type": "inline"}},
            },
        )
    ]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "required session-catalog.json is missing"),
        ("not-json", "required session-catalog.json is unreadable"),
        (json.dumps({"sessions": []}), "no non-empty sessions list"),
        (json.dumps({"sessions": [None]}), "malformed session entries"),
        (json.dumps({"sessions": [{"backend": "codex"}]}), "malformed session entries"),
        (json.dumps({"sessions": [{"name": "", "backend": "codex"}]}), "malformed session entries"),
        (json.dumps({"sessions": [{"name": "demo"}]}), "malformed session entries"),
        (json.dumps({"sessions": [{"name": "demo", "backend": ""}]}), "malformed session entries"),
    ],
)
def test_fanout_requires_valid_native_session_catalog(tmp_path, content, message):
    evaluate = load_module("evaluate_skills_catalog_required")
    evaluate.SESSION_CATALOG = tmp_path / "session-catalog.json"
    if content is not None:
        evaluate.SESSION_CATALOG.write_text(content, encoding="utf-8")

    with pytest.raises(RuntimeError, match=message):
        evaluate.require_session_catalog()
