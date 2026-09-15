from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_TEXT_SUFFIXES = {".py", ".md", ".json", ".toml", ".gitignore", ""}
GENERATED_DIRECTORY_NAMES = {".git", "__pycache__", ".venv"}


def _iter_public_text_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file() or any(
            part in GENERATED_DIRECTORY_NAMES for part in path.relative_to(root).parts
        ):
            continue
        if path == Path(__file__) or path.suffix not in PUBLIC_TEXT_SUFFIXES:
            continue
        yield path


class PublicContractTests(unittest.TestCase):
    def test_catalog_has_required_and_conditional_role_boundaries(self) -> None:
        catalog = json.loads((ROOT / "config/public-table-contracts.json").read_text())
        roles = catalog["roles"]
        self.assertEqual(len(roles), 14)
        self.assertEqual(
            {role["role"] for role in roles},
            {
                "first-principle", "skill-master", "watchdog", "scheduler",
                "heartbeat", "autobitable", "socail-king", "mythos", "localgit",
            },
        )
        for role in roles:
            self.assertIn(role["status"], {"required", "conditional"})
            if role["sync_direction"] == "none":
                self.assertFalse(role["queue_consumer"])
        localgit_roles = [role for role in roles if role["role"] == "localgit"]
        self.assertEqual(len(localgit_roles), 2)
        self.assertFalse(next(role for role in localgit_roles if role["capability"] == "repo_management_docs")["queue_consumer"])
        localgit = next(role for role in localgit_roles if role["capability"] == "daily_commit_mirror")
        self.assertFalse(localgit["queue_consumer"])
        self.assertEqual(
            [field[0] for field in localgit["fields"]],
            ["date", "repo_name", "committed", "commit_message", "files_changed", "skipped_reason"],
        )
        self.assertEqual(
            next(role for role in roles if role["role"] == "autobitable")["capability"],
            "webhook_config_ledger",
        )

    def test_owner_mappings_are_static_and_fail_closed(self) -> None:
        catalog = json.loads((ROOT / "config/public-table-contracts.json").read_text())
        self.assertFalse(catalog["catalog_state"]["complete"])
        self.assertEqual(catalog["catalog_state"]["platform_table_contracts"], "not-verified")
        self.assertTrue(catalog["queue_consumer_semantics"]["runtime_transport_wins"])
        self.assertTrue(catalog["queue_consumer_semantics"]["catalog_cannot_rewrite_runtime"])

        roles = catalog["roles"]
        session = next(role for role in roles if role["capability"] == "session_metadata")
        session_map = session["static_mapping"]
        self.assertEqual(session_map["source_local_key"], ["session_name"])
        self.assertEqual(session_map["remote_key"], ["Session"])
        self.assertIn("附属于", session_map["remote_required_not_in_public_local_schema"])
        self.assertIn(
            "first-principle/scripts/bitable-init-sync.sh",
            {ref["sourceRef"] for ref in session_map["consumer_refs"]},
        )

        principle = next(role for role in roles if role["capability"] == "principle_management_mirror")
        principle_map = principle["static_mapping"]
        self.assertEqual(principle_map["source_local_key"], ["module"])
        self.assertEqual(principle_map["remote_key"], ["模块名"])
        self.assertIn("updated_at", principle_map["local_only_fields"])

        patrol = next(role for role in roles if role["capability"] == "patrol_control")
        self.assertEqual(patrol["static_mapping"]["source_local_key"], ["scope"])
        self.assertEqual(patrol["static_mapping"]["remote_key"], ["配置项"])
        self.assertEqual(patrol["static_mapping"]["mapping_state"], "blocked-unbound")
        self.assertEqual(patrol["runtime_transport"], "native-lark-cli-read")
        self.assertEqual(patrol["sync_direction"], "none")
        self.assertFalse(patrol["queue_consumer"])

        skill_check = catalog["owner_source_checks"]["skill-master"]
        self.assertEqual(skill_check["source_field_count"], 14)
        self.assertEqual(skill_check["catalog_field_count"], 14)
        skill_role = next(role for role in roles if role["capability"] == "skill_registry_mirror")
        self.assertEqual(skill_role["source_check"]["fifteenth_field"], "not-present-in-owner-source")

        watchdog = next(role for role in roles if role["capability"] == "issue_mirror")
        self.assertTrue(watchdog["queue_consumer"])
        self.assertEqual(watchdog["runtime_transport"], "native-lark-cli")
        self.assertFalse(watchdog["queue_route_override"])

        for role in roles:
            for table in role.get("tables", [{"name": role.get("capability", "")}]):
                self.assertTrue(table["name"].strip(), role)
                fields = table.get("fields", role.get("fields", []))
                field_names = {field[0] for field in fields}
                key = table.get("unique_key", role.get("unique_key"))
                if key:
                    self.assertTrue(set(key) <= field_names, (role, table))
                for field in fields:
                    self.assertTrue(field[0].strip(), role)

        self.assertEqual(
            {entry["name"] for entry in catalog["runtime_entrypoints"]},
            {"enqueue", "consumer", "status", "cli"},
        )
        for entry in catalog["runtime_entrypoints"]:
            self.assertEqual(set(entry), {"name", "path"})
            self.assertFalse(Path(entry["path"]).is_absolute(), entry)
            runtime_path = (ROOT / entry["path"]).resolve()
            self.assertTrue(runtime_path.is_relative_to(ROOT.resolve()), entry)
            self.assertTrue(runtime_path.is_file(), entry)

        references = []
        def collect_consumer_refs(value):
            if isinstance(value, dict):
                if "consumer_refs" in value:
                    references.extend(value["consumer_refs"])
                for child in value.values():
                    collect_consumer_refs(child)
            elif isinstance(value, list):
                for child in value:
                    collect_consumer_refs(child)

        collect_consumer_refs(catalog)
        self.assertTrue(references)
        for reference in references:
            self.assertEqual(set(reference), {"sourceRef", "availability"})
            self.assertTrue(reference["sourceRef"].strip())
            self.assertEqual(reference["availability"], "owner-source-only")

        seed = catalog["seed_input"]
        self.assertEqual(seed["availability"], "installer-provided")
        self.assertEqual(seed["source"], "user-owned non-sensitive installation input")
        self.assertIn("unique_key", seed["identity"])
        self.assertIn("install_key:", seed["stable_seed_key"])
        self.assertIn("schema and each initialized seed row", seed["read_back"])

    def test_demo_contract_is_safe_and_validatable(self) -> None:
        contract = json.loads(
            (ROOT / "tests/fixtures/public-demo.asset.json").read_text()
        )
        self.assertEqual(contract["asset_id"], "public.demo")
        self.assertIn("example.invalid", contract["access_url"])
        self.assertEqual(contract["tables"][0]["unique_key"], ["键"])
        self.assertTrue(all(field["local_name"] for field in contract["tables"][0]["fields"]))

    def test_public_files_have_no_namespace_specific_identifiers(self) -> None:
        forbidden = (
            re.compile(r"/Users/[^\s`\"']+"),
            re.compile(r"https://[^\s`\"']+\.feishu\.cn"),
            re.compile(r"\boc_[A-Za-z0-9]{8,}\b"),
            re.compile(r"\btbl[A-Za-z0-9]{8,}\b"),
        )
        for path in _iter_public_text_files(ROOT):
            text = path.read_text(encoding="utf-8")
            for pattern in forbidden:
                self.assertIsNone(pattern.search(text), f"private value in {path}: {pattern.pattern}")

    def test_public_file_scan_ignores_venv_artifact_but_rejects_shipped_source(self) -> None:
        forbidden_url = "https://example.feishu.cn"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            venv_bin = root / ".venv/bin/python"
            venv_bin.parent.mkdir(parents=True)
            venv_bin.write_bytes(b"\x80\x81\x82")
            shipped_source = root / "src/shipped_like.py"
            shipped_source.parent.mkdir()
            shipped_source.write_text("VALUE = 'safe'\n", encoding="utf-8")

            self.assertEqual(list(_iter_public_text_files(root)), [shipped_source])

            shipped_source.write_text(f"VALUE = '{forbidden_url}'\n", encoding="utf-8")
            with self.assertRaises(AssertionError):
                for path in _iter_public_text_files(root):
                    self.assertIsNone(
                        re.search(r"https://[^\s`\"']+\.feishu\.cn", path.read_text(encoding="utf-8")),
                        f"private value in {path}",
                    )

    def test_public_surface_has_no_schema_api_or_network_imports(self) -> None:
        import importlib
        import subprocess
        from unittest.mock import patch

        package_src = str(ROOT / "src")
        import sys
        sys.path.insert(0, package_src)
        with patch.object(subprocess, "run", side_effect=AssertionError("network forbidden")):
            bitable = importlib.import_module("wendangwang_feishu.bitable")
            self.assertFalse(hasattr(bitable, "bitable_create_live"))
            self.assertFalse(hasattr(bitable, "bitable_create_table_payload"))
            with self.assertRaises(ImportError):
                from wendangwang_feishu.bitable import bitable_create_live
            with self.assertRaises(ModuleNotFoundError):
                importlib.import_module("wendangwang_feishu.field_groups")
        cli_text = (ROOT / "src/wendangwang_feishu/cli.py").read_text()
        for forbidden in (".schema_ops", ".provision", ".contract_ops", ".reconcile", ".menu"):
            self.assertNotIn(forbidden, cli_text)
        self.assertEqual(package_src, str(ROOT / "src"))

    def test_public_cli_help_exposes_only_documented_surface(self) -> None:
        import os
        import subprocess
        import sys

        env = os.environ.copy()
        env.update({"PYTHONPATH": str(ROOT / "src"), "PYTHONDONTWRITEBYTECODE": "1"})
        help_result = subprocess.run(
            [sys.executable, "-m", "wendangwang_feishu.cli", "--help"],
            cwd=ROOT, env=env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        for command in ("asset", "queue"):
            self.assertIn(command, help_result.stdout)
        for command in ("inspect", "bitable", "inventory", "receipt", "reconcile", "menu"):
            self.assertNotIn(command, help_result.stdout)
        queue_help = subprocess.run(
            [sys.executable, "-m", "wendangwang_feishu.cli", "queue", "--help"],
            cwd=ROOT, env=env, text=True, capture_output=True, check=False,
        )
        self.assertEqual(queue_help.returncode, 0, queue_help.stderr)
        for command in ("enqueue", "consumer", "status"):
            self.assertIn(command, queue_help.stdout)
        for command in ("drain", "snapshot-plan", "dead-letter-owner-ack"):
            self.assertNotIn(command, queue_help.stdout)

    def test_option_source_is_rejected_deterministically(self) -> None:
        import os
        import subprocess
        import sys
        import tempfile

        contract = json.loads(
            (ROOT / "tests/fixtures/public-demo.asset.json").read_text()
        )
        contract["tables"][0]["fields"][0]["option_source"] = {
            "catalog": "backend-model-effort",
            "dimension": "model",
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "option-source.json"
            path.write_text(json.dumps(contract, ensure_ascii=False))
            env = os.environ.copy()
            env.update({"PYTHONPATH": str(ROOT / "src"), "PYTHONDONTWRITEBYTECODE": "1"})
            result = subprocess.run(
                [sys.executable, "-m", "wendangwang_feishu.cli",
                 "asset", "validate", str(path)],
                cwd=ROOT, env=env, text=True, capture_output=True, check=False,
            )
        self.assertEqual(result.returncode, 1)
        self.assertIn("option_source is not supported in the public export", result.stderr)
        self.assertNotIn("ModuleNotFoundError", result.stderr)


if __name__ == "__main__":
    unittest.main()
