import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from argparse import Namespace
from contextlib import redirect_stdout
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT_PATH = SKILL_DIR / "scripts" / "see_upload.py"


def load_module():
    if not SCRIPT_PATH.exists():
        raise AssertionError(f"Missing upload script: {SCRIPT_PATH}")
    spec = importlib.util.spec_from_file_location("see_upload", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SeeUploadTests(unittest.TestCase):
    def test_upload_script_exists(self):
        self.assertTrue(SCRIPT_PATH.exists(), f"Missing upload script: {SCRIPT_PATH}")

    def test_resolve_runtime_config_prefers_cli_token(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            codex_home = Path(tmpdir) / ".codex"
            codex_home.mkdir(parents=True, exist_ok=True)
            (codex_home / "get-image-url.json").write_text(
                json.dumps(
                    {
                        "api_token": "config-token",
                        "default_domain": "config.example",
                    }
                ),
                encoding="utf-8",
            )
            args = Namespace(token="cli-token", domain=None)

            resolved = module.resolve_runtime_config(
                args,
                env={
                    "SEE_API_TOKEN": "env-token",
                    "SEE_DEFAULT_DOMAIN": "env.example",
                },
                codex_home=codex_home,
            )

        self.assertEqual(resolved["token"], "cli-token")
        self.assertEqual(resolved["default_domain"], "config.example")

    def test_build_multipart_body_includes_file_and_optional_fields(self):
        module = load_module()
        body, content_type = module.build_multipart_body(
            fields={
                "domain": "cdn.example",
                "custom_slug": "hero-image",
                "is_private": "1",
            },
            file_field_name="file",
            filename="photo.png",
            content=b"abc123",
            mime_type="image/png",
            boundary="TESTBOUNDARY",
        )

        body_text = body.decode("utf-8", errors="replace")
        self.assertEqual(content_type, "multipart/form-data; boundary=TESTBOUNDARY")
        self.assertIn('name="domain"', body_text)
        self.assertIn("cdn.example", body_text)
        self.assertIn('name="custom_slug"', body_text)
        self.assertIn("hero-image", body_text)
        self.assertIn('name="is_private"', body_text)
        self.assertIn('name="file"; filename="photo.png"', body_text)
        self.assertIn("Content-Type: image/png", body_text)
        self.assertIn("abc123", body_text)

    def test_request_json_uses_curl_runner_with_bearer_auth(self):
        module = load_module()
        calls = []

        def fake_runner(command, input=None, capture_output=None, check=None):
            calls.append((command, input, capture_output, check))
            return subprocess.CompletedProcess(
                args=command,
                returncode=0,
                stdout=b'{"success": true, "data": []}',
                stderr=b"",
            )

        payload = module.request_json(
            "GET",
            "/file/domains",
            "cli-token",
            runner=fake_runner,
        )

        command, stdin_payload, capture_output, check = calls[0]
        self.assertEqual(payload["success"], True)
        self.assertEqual(command[0], "curl")
        self.assertIn("Authorization: Bearer cli-token", command)
        self.assertIsNone(stdin_payload)
        self.assertTrue(capture_output)
        self.assertFalse(check)

    def test_request_json_retries_with_raw_token_after_auth_rejection(self):
        module = load_module()
        auth_headers = []

        def fake_runner(command, input=None, capture_output=None, check=None):
            auth_value = command[command.index("-H") + 1]
            auth_headers.append(auth_value)
            if len(auth_headers) == 1:
                return subprocess.CompletedProcess(
                    args=command,
                    returncode=22,
                    stdout=b'{"success": false, "code": "unauthorized", "message": "blocked"}',
                    stderr=b"",
                )
            return subprocess.CompletedProcess(
                args=command,
                returncode=0,
                stdout=b'{"success": true, "data": []}',
                stderr=b"",
            )

        payload = module.request_json(
            "GET",
            "/file/domains",
            "cli-token",
            runner=fake_runner,
        )

        self.assertEqual(payload["success"], True)
        self.assertEqual(
            auth_headers,
            [
                "Authorization: Bearer cli-token",
                "Authorization: cli-token",
            ],
        )

    def test_request_json_returns_structured_error_when_curl_is_missing(self):
        module = load_module()

        def fake_runner(command, input=None, capture_output=None, check=None):
            raise FileNotFoundError("curl")

        with self.assertRaises(module.CommandError) as raised:
            module.request_json(
                "GET",
                "/file/domains",
                "cli-token",
                runner=fake_runner,
            )

        self.assertEqual(raised.exception.payload["error"]["kind"], "missing_dependency")

    def test_normalize_upload_result_returns_expected_shape(self):
        module = load_module()
        payload = {
            "success": True,
            "code": "success",
            "message": "Upload success.",
            "data": {
                "file_id": 42,
                "width": 1200,
                "height": 630,
                "size": 2048,
                "filename": "photo.png",
                "storename": "abc123.png",
                "path": "/2026/03/abc123.png",
                "hash": "deadbeef",
                "url": "https://cdn.example/2026/03/abc123.png",
                "page": "https://s.ee/i/deadbeef",
                "delete": "https://s.ee/delete/deadbeef/token",
                "upload_status": 1,
            },
        }

        normalized = module.normalize_upload_result(
            source_path=Path("/tmp/photo.png"),
            payload=payload,
            requested_domain="cdn.example",
            is_private=True,
        )

        self.assertEqual(normalized["source_path"], "/tmp/photo.png")
        self.assertEqual(normalized["file_id"], 42)
        self.assertEqual(normalized["filename"], "photo.png")
        self.assertEqual(normalized["storename"], "abc123.png")
        self.assertEqual(normalized["url"], "https://cdn.example/2026/03/abc123.png")
        self.assertEqual(normalized["page"], "https://s.ee/i/deadbeef")
        self.assertEqual(
            normalized["delete_url"], "https://s.ee/delete/deadbeef/token"
        )
        self.assertEqual(normalized["delete_key"], "deadbeef")
        self.assertEqual(normalized["hash"], "deadbeef")
        self.assertEqual(normalized["size"], 2048)
        self.assertEqual(normalized["width"], 1200)
        self.assertEqual(normalized["height"], 630)
        self.assertEqual(normalized["upload_status"], 1)
        self.assertEqual(normalized["domain"], "s.ee")
        self.assertTrue(normalized["is_private"])
        self.assertEqual(
            normalized["markdown"], "![photo.png](https://cdn.example/2026/03/abc123.png)"
        )
        self.assertEqual(normalized["raw"], payload)

    def test_main_errors_when_custom_slug_used_with_multiple_files(self):
        module = load_module()
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = module.main(
                [
                    "upload",
                    "/tmp/one.png",
                    "/tmp/two.png",
                    "--custom-slug",
                    "same-slug",
                ],
                env={},
            )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["kind"], "invalid_arguments")

    def test_main_errors_when_token_missing(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            image_path = Path(tmpdir) / "image.png"
            image_path.write_bytes(b"png")
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = module.main(
                    ["upload", str(image_path)],
                    env={},
                    codex_home=Path(tmpdir) / ".codex",
                )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["kind"], "missing_token")

    def test_main_errors_when_file_missing(self):
        module = load_module()
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            exit_code = module.main(
                ["upload", "/tmp/missing-image.png"],
                env={"SEE_API_TOKEN": "token"},
            )

        payload = json.loads(stdout.getvalue())
        self.assertEqual(exit_code, 2)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["error"]["kind"], "missing_file")


if __name__ == "__main__":
    unittest.main()
