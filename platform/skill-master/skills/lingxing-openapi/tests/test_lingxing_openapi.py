import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SKILL_ROOT / "scripts" / "lingxing_openapi.py"
SPEC = importlib.util.spec_from_file_location("lingxing_openapi", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

COMMANDS_DIR = SKILL_ROOT / "scripts" / "commands"
if str(COMMANDS_DIR) not in sys.path:
    sys.path.insert(0, str(COMMANDS_DIR))
LISTING_SPEC = importlib.util.spec_from_file_location("listing_publish", COMMANDS_DIR / "listing_publish.py")
LISTING_MODULE = importlib.util.module_from_spec(LISTING_SPEC)
assert LISTING_SPEC.loader is not None
sys.modules[LISTING_SPEC.name] = LISTING_MODULE
LISTING_SPEC.loader.exec_module(LISTING_MODULE)

REMOTE_SPEC = importlib.util.spec_from_file_location("lingxing_remote_runner", SKILL_ROOT / "scripts" / "lingxing_remote_runner.py")
REMOTE_MODULE = importlib.util.module_from_spec(REMOTE_SPEC)
assert REMOTE_SPEC.loader is not None
sys.modules[REMOTE_SPEC.name] = REMOTE_MODULE
REMOTE_SPEC.loader.exec_module(REMOTE_MODULE)

RELAY_SPEC = importlib.util.spec_from_file_location("lingxing_relay_server", SKILL_ROOT / "scripts" / "lingxing_relay_server.py")
RELAY_MODULE = importlib.util.module_from_spec(RELAY_SPEC)
if RELAY_SPEC.loader is not None:
    sys.modules[RELAY_SPEC.name] = RELAY_MODULE
    RELAY_SPEC.loader.exec_module(RELAY_MODULE)


class ConfigTests(unittest.TestCase):
    def test_resolve_runtime_config_prefers_cli_then_config_then_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            skill_root = Path(tmpdir)
            (skill_root / "local-config.json").write_text(
                json.dumps(
                    {
                        "app_id": "cfg-app",
                        "app_secret": "cfg-secret",
                        "server_host": "cfg-host",
                        "server_user": "cfg-user",
                        "server_key_path": "/tmp/cfg.pem",
                        "default_timeout": 33,
                        "default_output_dir": "output/from-config",
                    }
                ),
                encoding="utf-8",
            )
            env = {
                "LINGXING_APP_ID": "env-app",
                "LINGXING_APP_SECRET": "env-secret",
                "LINGXING_SERVER_HOST": "env-host",
                "LINGXING_SERVER_USER": "env-user",
                "LINGXING_SERVER_KEY_PATH": "/tmp/env.pem",
            }
            args = MODULE.parse_args(
                [
                    "--skill-root",
                    str(skill_root),
                    "--server-host",
                    "cli-host",
                    "--server-user",
                    "cli-user",
                    "auth",
                ]
            )
            config = MODULE.resolve_runtime_config(args, env=env, cwd=Path("/tmp/project"))
            self.assertEqual(config["app_id"], "cfg-app")
            self.assertEqual(config["app_secret"], "cfg-secret")
            self.assertEqual(config["server_host"], "cli-host")
            self.assertEqual(config["server_user"], "cli-user")
            self.assertEqual(config["server_key_path"], "/tmp/cfg.pem")
            self.assertEqual(config["default_timeout"], 33)
            self.assertEqual(
                config["default_output_dir"],
                str((Path("/tmp/project") / "output" / "from-config").resolve()),
            )

    def test_default_output_dir_is_relative_to_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            args = MODULE.parse_args(["auth"])
            config = MODULE.resolve_runtime_config(args, env={}, cwd=Path(tmpdir))
            self.assertEqual(
                config["default_output_dir"],
                str((Path(tmpdir) / "output" / "lingxing").resolve()),
            )

    def test_relay_config_allows_missing_ssh_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            skill_root = Path(tmpdir)
            (skill_root / "local-config.json").write_text(
                json.dumps(
                    {
                        "app_id": "cfg-app",
                        "app_secret": "cfg-secret",
                        "relay_url": "https://relay.example.test",
                        "relay_token": "relay-token",
                        "relay_ca_cert_path": "/tmp/relay-ca.pem",
                        "relay_tls_verify": True,
                    }
                ),
                encoding="utf-8",
            )
            args = MODULE.parse_args(["--skill-root", str(skill_root), "auth"])
            config = MODULE.resolve_runtime_config(args, env={}, cwd=Path(tmpdir))
            self.assertEqual(config["relay_url"], "https://relay.example.test")
            self.assertEqual(config["relay_token"], "relay-token")
            self.assertEqual(config["relay_ca_cert_path"], "/tmp/relay-ca.pem")
            self.assertTrue(config["relay_tls_verify"])
            MODULE.ensure_credentials(config)


class RankHelperTests(unittest.TestCase):
    def test_pick_best_small_category_returns_lowest_rank(self) -> None:
        best = MODULE.pick_best_small_category(
            [
                {"rank": 99, "category": "A"},
                {"rank": 12, "category": "B"},
                {"rank": 15, "category": "C"},
            ]
        )
        self.assertEqual(best, {"rank": 12, "category": "B", "prev_rank": None})


class RelayRunnerTests(unittest.TestCase):
    def test_relay_preflight_uses_short_connect_timeout(self) -> None:
        with mock.patch.object(REMOTE_MODULE.socket, "create_connection") as create_connection:
            sock = mock.Mock()
            sock.__enter__ = mock.Mock(return_value=sock)
            sock.__exit__ = mock.Mock(return_value=None)
            create_connection.return_value = sock

            REMOTE_MODULE._preflight_relay_tcp(
                {"relay_connect_timeout": 4},
                "https://relay.example.test:18443/v1/operation",
            )

        create_connection.assert_called_once_with(("relay.example.test", 18443), timeout=4)

    def test_run_remote_operation_prefers_relay_when_configured(self) -> None:
        calls = []
        original_relay = getattr(REMOTE_MODULE, "_run_relay_operation", None)
        original_ssh = getattr(REMOTE_MODULE, "_run_ssh_operation", None)
        try:
            def fake_relay(config, operation, payload):
                calls.append(("relay", operation, payload))
                return {"ok": True}

            def fake_ssh(*_args, **_kwargs):
                raise AssertionError("SSH fallback should not run when relay succeeds")

            REMOTE_MODULE._run_relay_operation = fake_relay
            REMOTE_MODULE._run_ssh_operation = fake_ssh
            result = REMOTE_MODULE.run_remote_operation(
                {
                    "relay_url": "https://relay.example.test",
                    "relay_token": "token",
                    "relay_tls_verify": True,
                    "relay_timeout": 10,
                    "relay_fallback_to_ssh": True,
                    "app_id": "app",
                    "app_secret": "secret",
                    "server_key_path": "/tmp/key.pem",
                    "server_user": "ubuntu",
                    "server_host": "example",
                },
                "seller-list",
                {"countries": ["US"]},
            )
        finally:
            if original_relay is not None:
                REMOTE_MODULE._run_relay_operation = original_relay
            elif hasattr(REMOTE_MODULE, "_run_relay_operation"):
                del REMOTE_MODULE._run_relay_operation
            if original_ssh is not None:
                REMOTE_MODULE._run_ssh_operation = original_ssh
            elif hasattr(REMOTE_MODULE, "_run_ssh_operation"):
                del REMOTE_MODULE._run_ssh_operation

        self.assertEqual(result, {"ok": True})
        self.assertEqual(calls, [("relay", "seller-list", {"countries": ["US"]})])


class RelayServerTests(unittest.TestCase):
    def test_authorization_requires_bearer_token_match(self) -> None:
        self.assertTrue(RELAY_MODULE.is_authorized("Bearer abc", "abc"))
        self.assertFalse(RELAY_MODULE.is_authorized("Bearer wrong", "abc"))
        self.assertFalse(RELAY_MODULE.is_authorized("", "abc"))

    def test_build_embedded_operation_code_injects_payload(self) -> None:
        code = RELAY_MODULE.build_embedded_operation_code("app", "secret", "seller-list", {"countries": ["US"]})
        self.assertIn('\\"operation\\": \\"seller-list\\"', code)
        self.assertIn('\\"countries\\": [\\"US\\"]', code)
        self.assertIn('APP_ID = "app"', code)


class ParserTests(unittest.TestCase):
    def test_cli_supports_expected_subcommands(self) -> None:
        parser = MODULE.build_parser()
        choices = parser._subparsers._group_actions[0].choices
        self.assertEqual(
            set(choices),
            {
                "auth",
                "call",
                "seller-list",
                "probe",
                "resume-state",
                "download-aba",
                "fetch-ad-reports",
                "asin-diagnostics",
                "asin-rank-sync",
                "asin-rank-probe",
                "listing-title",
                "listing-bullets",
                "listing-images",
                "listing-update",
                "listing-status",
            },
        )


class ListingPublishTests(unittest.TestCase):
    def test_build_attributes_for_title(self) -> None:
        args = type("Args", (), {"title": "T", "bullet": None, "description": None})()
        self.assertEqual(
            LISTING_MODULE.build_attributes("title", args, {"main_image_url": None, "image1_url": None, "image2_url": None}),
            {
                "item_name": [
                    {
                        "value": "T",
                        "language_tag": "en_US",
                        "marketplace_id": "ATVPDKIKX0DER",
                    }
                ]
            },
        )

    def test_build_attributes_for_images(self) -> None:
        args = type(
            "Args",
            (),
            {
                "title": None,
                "bullet": None,
                "description": None,
            },
        )()
        self.assertEqual(
            LISTING_MODULE.build_attributes(
                "images",
                args,
                {
                    "main_image_url": "https://example.com/main.png",
                    "image1_url": None,
                    "image2_url": "https://example.com/alt-2.png",
                },
            ),
            {
                "main_product_image_locator": [
                    {
                        "media_location": "https://example.com/main.png",
                        "marketplace_id": "ATVPDKIKX0DER",
                    }
                ],
                "other_product_image_locator_2": [
                    {
                        "media_location": "https://example.com/alt-2.png",
                        "marketplace_id": "ATVPDKIKX0DER",
                    }
                ],
            },
        )

    def test_prepare_images_passes_through_urls(self) -> None:
        args = type(
            "Args",
            (),
            {
                "main_image_url": "https://example.com/main.png",
                "main_image_path": None,
                "image1_url": None,
                "image1_path": None,
                "image2_url": "https://example.com/alt-2.png",
                "image2_path": None,
                "image_upload_backend": "auto",
                "upload_token": None,
                "upload_domain": None,
            },
        )()
        resolved, uploads = LISTING_MODULE.prepare_images(args)
        self.assertEqual(
            resolved,
            {
                "main_image_url": "https://example.com/main.png",
                "image1_url": None,
                "image2_url": "https://example.com/alt-2.png",
            },
        )
        self.assertEqual(uploads, [])


if __name__ == "__main__":
    unittest.main()
