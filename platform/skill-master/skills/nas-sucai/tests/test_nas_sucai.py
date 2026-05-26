import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SKILL_ROOT = Path(__file__).resolve().parents[1]
SKILL_MASTER_ROOT = SKILL_ROOT.parents[1]
INDEX_PATH = SKILL_MASTER_ROOT / "skills" / "INDEX.md"
COMMON_PATH = SKILL_ROOT / "scripts" / "nas_sucai_common.py"


def load_common_module():
    spec = importlib.util.spec_from_file_location("nas_sucai_common", COMMON_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["nas_sucai_common"] = module
    spec.loader.exec_module(module)
    return module


class ManifestTests(unittest.TestCase):
    def test_manifest_files_exist(self) -> None:
        expected = [
            SKILL_ROOT / "SKILL.md",
            SKILL_ROOT / "README.md",
            SKILL_ROOT / "SETUP.md",
            SKILL_ROOT / "agents" / "openai.yaml",
        ]
        for path in expected:
            self.assertTrue(path.exists(), f"Missing skill file: {path}")

    def test_index_registers_nas_sucai_as_shared_skill(self) -> None:
        text = INDEX_PATH.read_text(encoding="utf-8")
        self.assertIn(
            "| nas-sucai | skill-master | shared | nas |",
            text,
        )


class ConfigTests(unittest.TestCase):
    def test_load_config_uses_business_file_and_legacy_fallback(self) -> None:
        module = load_common_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            codex_home = Path(tmpdir) / ".codex"
            codex_home.mkdir(parents=True, exist_ok=True)
            legacy_path = codex_home / "nas-ftps.json"
            legacy_path.write_text(
                json.dumps(
                    {
                        "lan_host": "192.168.31.67",
                        "lan_port": 21,
                        "username": "ftt-codex-1",
                        "remote_root": "/",
                        "passive_mode": True,
                        "timeout_seconds": 8.0,
                        "certificate_sha256": "AB:CD",
                        "keychain_service": "codex-nas-ftps",
                        "validation_directory": "/2026产品图片/codex-smoke",
                        "control_encoding": "gb18030",
                        "password_file": str(codex_home / "nas-ftps.secret"),
                        "password_env_var": "NAS_FTPS_PASSWORD",
                    }
                ),
                encoding="utf-8",
            )

            config = module.load_config(codex_home=codex_home)

        self.assertEqual(config.lan_host, "192.168.31.67")
        self.assertEqual(config.keychain_service, "codex-nas-ftps")

    def test_load_config_uses_business_defaults_for_optional_fields(self) -> None:
        module = load_common_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            codex_home = Path(tmpdir) / ".codex"
            codex_home.mkdir(parents=True, exist_ok=True)
            config_path = codex_home / "nas-sucai.json"
            config_path.write_text(
                json.dumps(
                    {
                        "lan_host": "192.168.31.67",
                        "username": "ftt-codex-1",
                        "certificate_sha256": "AB:CD",
                    }
                ),
                encoding="utf-8",
            )

            config = module.load_config(codex_home=codex_home)

        self.assertEqual(config.lan_port, 21)
        self.assertEqual(config.remote_root, "/")
        self.assertEqual(config.keychain_service, "codex-nas-sucai")
        self.assertEqual(config.validation_directory, "/2026产品图片/codex-smoke")

    def test_resolve_password_prefers_env_then_file_then_keychain(self) -> None:
        module = load_common_module()
        config = module.NasSucaiConfig(
            lan_host="192.168.31.67",
            lan_port=21,
            username="ftt-codex-1",
            remote_root="/",
            passive_mode=True,
            timeout_seconds=8.0,
            certificate_sha256="AB:CD",
            keychain_service="codex-nas-sucai",
            validation_directory="/2026产品图片/codex-smoke",
            control_encoding="gb18030",
            password_file=None,
            password_env_var="NAS_SUCAI_PASSWORD",
        )

        with mock.patch.dict("os.environ", {"NAS_SUCAI_PASSWORD": "env-secret"}, clear=True):
            self.assertEqual(module.resolve_password(config), "env-secret")


class FakeFTP:
    def __init__(self, entries):
        self.entries = entries

    def mlsd(self, path):
        value = self.entries.get(path, [])
        if isinstance(value, Exception):
            raise value
        return iter(value)

    def cwd(self, _path):
        return None


class ReadActionTests(unittest.TestCase):
    def test_list_directory_returns_entry_dicts(self) -> None:
        module = load_common_module()
        ftp = FakeFTP(
            {
                "/2026产品图片": [
                    ("hero.jpg", {"type": "file", "size": "12"}),
                    ("clips", {"type": "dir"}),
                ]
            }
        )
        entries = module.list_directory(ftp, "/2026产品图片")
        self.assertEqual(entries[0]["path"], "/2026产品图片/hero.jpg")
        self.assertEqual(entries[0]["size"], 12)

    def test_search_directory_walks_nested_dirs_and_sorts_matches(self) -> None:
        module = load_common_module()
        ftp = FakeFTP(
            {
                "/": [("2026产品图片", {"type": "dir"})],
                "/2026产品图片": [
                    ("hero.jpg", {"type": "file", "size": "12"}),
                    ("subdir", {"type": "dir"}),
                ],
                "/2026产品图片/subdir": [
                    ("hero-video.mp4", {"type": "file", "size": "24"})
                ],
            }
        )
        matches = module.search_directory(ftp, "/", "hero")
        self.assertEqual(
            [item["path"] for item in matches],
            ["/2026产品图片/hero.jpg", "/2026产品图片/subdir/hero-video.mp4"],
        )

    def test_search_directory_skips_inaccessible_nested_directory(self) -> None:
        module = load_common_module()
        ftp = FakeFTP(
            {
                "/2026产品图片": [
                    ("hero.jpg", {"type": "file", "size": "12"}),
                    ("#recycle", {"type": "dir"}),
                    ("subdir", {"type": "dir"}),
                ],
                "/2026产品图片/#recycle": RuntimeError("550 can't be listed"),
                "/2026产品图片/subdir": [
                    ("hero-video.mp4", {"type": "file", "size": "24"})
                ],
            }
        )

        matches = module.search_directory(ftp, "/2026产品图片", "hero")

        self.assertEqual(
            [item["path"] for item in matches],
            ["/2026产品图片/hero.jpg", "/2026产品图片/subdir/hero-video.mp4"],
        )

    def test_error_payload_preserves_code_and_message(self) -> None:
        module = load_common_module()
        payload = module.error_payload(
            module.NasSucaiError("permission_required", "blocked"),
            action="search",
        )
        self.assertEqual(payload["status"], "error")
        self.assertEqual(payload["action"], "search")
        self.assertEqual(payload["code"], "permission_required")

    def test_success_payload_wraps_action_endpoint_result(self) -> None:
        module = load_common_module()
        endpoint = {"label": "lan", "host": "h", "port": 21, "fingerprint": "fp"}
        payload = module.success_payload("list", endpoint, {"entries": []})
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["action"], "list")
        self.assertEqual(payload["endpoint"], endpoint)
        self.assertEqual(payload["result"], {"entries": []})


class WriteActionTests(unittest.TestCase):
    def test_download_file_refuses_existing_destination_without_overwrite(self) -> None:
        module = load_common_module()
        with tempfile.TemporaryDirectory() as tmpdir:
            local_path = Path(tmpdir) / "hero.jpg"
            local_path.write_bytes(b"old")
            with self.assertRaises(RuntimeError):
                module.download_file(mock.Mock(), "/hero.jpg", local_path, overwrite=False)

    def test_upload_file_atomic_renames_temp_file_to_final_name(self) -> None:
        module = load_common_module()
        ftp = mock.Mock()
        with tempfile.TemporaryDirectory() as tmpdir:
            local_path = Path(tmpdir) / "hero.jpg"
            local_path.write_bytes(b"new")
            remote_path = module.upload_file_atomic(ftp, local_path, "/2026产品图片/hero.jpg")
        self.assertEqual(remote_path, "/2026产品图片/hero.jpg")
        ftp.storbinary.assert_called_once()
        ftp.rename.assert_called_once()

    def test_make_directory_returns_remote_path(self) -> None:
        module = load_common_module()
        ftp = mock.Mock()
        ftp.mkd.return_value = "/2026产品图片/new-folder"
        self.assertEqual(
            module.make_directory(ftp, "/2026产品图片/new-folder"),
            "/2026产品图片/new-folder",
        )

    def test_rename_remote_path_returns_src_and_dst(self) -> None:
        module = load_common_module()
        ftp = mock.Mock()
        src, dst = module.rename_remote_path(ftp, "/old.jpg", "/new.jpg")
        self.assertEqual((src, dst), ("/old.jpg", "/new.jpg"))


class DocumentationTests(unittest.TestCase):
    def test_setup_uses_business_named_config_paths(self) -> None:
        text = (SKILL_ROOT / "SETUP.md").read_text(encoding="utf-8")
        self.assertIn("~/.codex/nas-sucai.json", text)
        self.assertIn("~/.codex/nas-sucai.secret", text)
        self.assertIn("NAS_SUCAI_PASSWORD", text)


if __name__ == "__main__":
    unittest.main()
