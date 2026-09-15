from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sanitized_release.py"
SPEC = importlib.util.spec_from_file_location("sanitized_release", SCRIPT)
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release
SPEC.loader.exec_module(release)


class SanitizedReleaseTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.supermatrix = self.make_repo("SuperMatrix")
        self.workspaces = self.root / "workspaces"
        self.workspaces.mkdir()
        self.demo = self.make_repo("workspaces/demo")
        self.keywords = self.root / "private-keywords.json"
        self.write_keywords()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def make_repo(self, relative: str) -> Path:
        path = self.root / relative
        path.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        return path

    def write(self, root: Path, relative: str, content: str | bytes) -> None:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")

    def write_keywords(self) -> None:
        rows = [
            ("person", "zh", "\u5f20\u4e09", "PERSON_REDACTED"),
            ("person", "en", "Alice Private", "PERSON_REDACTED"),
            ("person_handle", "en", "alice-private", "HANDLE_REDACTED"),
            ("company", "en", "Private Company", "COMPANY_REDACTED"),
            ("brand", "zh", "\u79c1\u6709\u54c1\u724c", "BRAND_REDACTED"),
            ("product", "en", "Secret Product", "PRODUCT_REDACTED"),
            ("contact", "en", "private-contact", "CONTACT_REDACTED"),
            ("private_host", "en", "internal.invalid", "HOST_REDACTED"),
        ]
        payload = {
            "version": 1,
            "keywords": [
                {"category": category, "language": language, "term": term, "replacement": replacement}
                for category, language, term, replacement in rows
            ],
        }
        self.keywords.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def write_config(self, mappings: list[dict[str, object]], max_bytes: int = 1024) -> Path:
        path = self.root / "config.json"
        payload = {
            "schema_version": 1,
            "max_file_bytes": max_bytes,
            "allowed_artifact_patterns": [],
            "mappings": mappings,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def write_required_fixture_files(self, root: Path, mapping: dict[str, object]) -> None:
        for relative in mapping["required_files"]:
            path = root / str(mapping.get("subpath", ".")) / relative
            if not path.exists():
                self.write(root, path.relative_to(root).as_posix(), "public fixture\n")

    def build(self, config: Path) -> tuple[Path, Path, dict[str, object]]:
        output = self.root / "output"
        evidence = self.root / "build-evidence.json"
        args = argparse.Namespace(
            config=config,
            supermatrix_root=self.supermatrix,
            workspaces_root=self.workspaces,
            public_base_root=self.supermatrix,
            output=output,
            keyword_file=self.keywords,
            evidence=evidence,
        )
        payload = release.build_snapshot(args)
        return output, evidence, payload

    def test_build_uses_closed_allowlist_and_redacts_bilingual_values(self) -> None:
        self.write(
            self.supermatrix,
            "src/public.txt",
            "\u5f20\u4e09 Alice Private Secret Product ASIN_REDACTED user@example.com PHONE_REDACTED "
            "oc_REDACTEDCHATID /Users/LOCAL_USER/project\n",
        )
        self.write(self.supermatrix, "private/ignored.txt", "Private Company\n")
        config = self.write_config(
            [
                {
                    "name": "core",
                    "root": "supermatrix",
                    "subpath": ".",
                    "destination": "supermatrix",
                    "include": ["src/**"],
                    "exclude": [],
                }
            ]
        )

        output, evidence, payload = self.build(config)

        text = (output / "supermatrix/src/public.txt").read_text(encoding="utf-8")
        self.assertEqual(
            text,
            "PERSON_REDACTED PERSON_REDACTED PRODUCT_REDACTED ASIN_REDACTED "
            "user@example.com PHONE_REDACTED oc_REDACTEDCHATID /Users/LOCAL_USER/project\n",
        )
        self.assertFalse((output / "supermatrix/private/ignored.txt").exists())
        self.assertTrue(payload["ok"])
        evidence_text = evidence.read_text(encoding="utf-8")
        self.assertNotIn("Alice Private", evidence_text)
        self.assertNotIn("Secret Product", evidence_text)
        self.assertIn("term_fingerprints", evidence_text)

    def test_build_includes_nonignored_untracked_workspace_file(self) -> None:
        self.write(self.demo, "src/new.txt", "public content\n")
        config = self.write_config(
            [
                {
                    "name": "demo",
                    "root": "workspace:demo",
                    "subpath": ".",
                    "destination": "platform/demo",
                    "include": ["src/**"],
                    "exclude": [],
                }
            ]
        )

        output, _, payload = self.build(config)

        self.assertEqual((output / "platform/demo/src/new.txt").read_text(), "public content\n")
        self.assertEqual(payload["mapping_counts"], {"demo": 1})

    def test_build_rejects_empty_mapping_set(self) -> None:
        with self.assertRaisesRegex(release.ReleaseError, "nonempty mappings"):
            self.build(self.write_config([]))

    def test_build_rejects_a_missing_required_module_before_copying(self) -> None:
        self.write(self.supermatrix, "src/main.ts", "// public\n")
        mappings = [
            {"name": "core", "root": "supermatrix", "destination": "supermatrix", "include": ["src/**"]},
            {"name": "missing", "root": "workspace:demo", "destination": "platform/demo", "include": ["src/**"]},
        ]
        with self.assertRaisesRegex(release.ReleaseError, "mapping missing selected no files"):
            self.build(self.write_config(mappings))
        self.assertFalse((self.root / "output/supermatrix/src/main.ts").exists())

    def test_build_rejects_missing_or_excluded_required_file(self) -> None:
        self.write(self.demo, "README.md", "public\n")
        mapping = {
            "name": "demo", "root": "workspace:demo", "destination": "platform/demo",
            "include": ["**"], "required_files": ["src/main.ts"],
        }
        with self.assertRaisesRegex(release.ReleaseError, "missing required files: src/main.ts"):
            self.build(self.write_config([mapping]))
        self.write(self.demo, "src/main.ts", "// required\n")
        mapping["exclude"] = ["src/**"]
        with self.assertRaisesRegex(release.ReleaseError, "missing required files: src/main.ts"):
            self.build(self.write_config([mapping]))

    def test_required_files_are_exact_paths_and_present_in_build_evidence(self) -> None:
        self.write(self.demo, "src/main.ts", "// public\n")
        mapping = {
            "name": "demo", "root": "workspace:demo", "destination": "platform/demo",
            "include": ["src/**"], "required_files": ["src/**"],
        }
        with self.assertRaisesRegex(release.ReleaseError, "required_files must contain exact relative paths"):
            self.build(self.write_config([mapping]))
        mapping["required_files"] = ["src/main.ts"]
        _, _, payload = self.build(self.write_config([mapping]))
        self.assertEqual(payload["mapping_counts"], {"demo": 1})
        self.assertEqual(payload["required_files"], {"demo": ["src/main.ts"]})

    def test_build_rejects_secret_before_copy(self) -> None:
        token = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890"
        self.write(self.supermatrix, "src/config.ts", f"token = '{token}'\n")
        config = self.write_config(
            [
                {
                    "name": "core",
                    "root": "supermatrix",
                    "subpath": ".",
                    "destination": "supermatrix",
                    "include": ["src/**"],
                    "exclude": [],
                }
            ]
        )

        with self.assertRaisesRegex(release.ReleaseError, "high-confidence secret"):
            self.build(config)

    def test_secret_detector_distinguishes_fixture_words_from_credentials(self) -> None:
        self.assertEqual(release.detect_secrets('const accessToken = "expired-access-token";'), [])
        self.assertEqual(release.detect_secrets('"sk-live-should-never-render"'), [])
        assignment = 'const password = "' + "RealCredential2026Value" + '";'
        hits = release.detect_secrets(assignment)
        self.assertEqual([detector for detector, _ in hits], ["credential_assignment"])
        header = "-----BEGIN OPENSSH PRIVATE " + "KEY-----"
        footer = "-----END OPENSSH PRIVATE " + "KEY-----"
        self.assertEqual(release.detect_secrets(header), [])
        block = f"{header}\nnot-a-real-key-material-value\n{footer}"
        self.assertEqual([item[0] for item in release.detect_secrets(block)], ["private_key"])

    def test_public_lark_app_placeholder_preserves_owner_asset_hash(self) -> None:
        placeholder = "cli_" + "x" * 16
        real_shape = "cli_" + "a123b456c789d012"
        text, counts = release.apply_replacements(f"{placeholder}\n{real_shape}\n", [], [])
        self.assertEqual(text, f"{placeholder}\ncli_REDACTEDAPPID\n")
        self.assertEqual(counts, {"pattern:lark_app_id": 1})
        self.assertEqual(release.scan_text("README.md", placeholder, []), [])
        for value in (real_shape, "cli_" + "x" * 12 + "real"):
            self.assertIn("lark_app_id", [hit["detector"] for hit in release.scan_text("README.md", value, [])])

    def test_scan_finds_unprefixed_remote_resources_in_config_and_urls(self) -> None:
        resource = "Abc123Def456" + "Ghi789Jkl012Mno"
        host = "tenant-private." + "feishu.cn"
        cases = [
            (f'bitableBaseToken: process.env.WATCHDOG_BITABLE_BASE_TOKEN || "{resource}"', "remote_resource_assignment"),
            (f'bitableBaseToken: z.string().default("{resource}")', "remote_resource_assignment"),
            (f'{{"base_token": "{resource}"}}', "remote_resource_assignment"),
            (f'WIKI_PARENT_NODE_TOKEN="{resource}"', "remote_resource_assignment"),
            ('WIKI_SPACE_ID="' + "712345678" + '9012345678"', "remote_resource_assignment"),
            (f"https://{host}/wiki/{resource}", "lark_tenant_host"),
            (f"https://example.feishu.cn/base/{resource}", "lark_resource_url"),
            (f"https://YOUR_TENANT.feishu.cn/base/{resource}", "lark_resource_url"),
        ]
        for text, detector in cases:
            with self.subTest(text=text):
                hits = release.scan_text("config.txt", text, [])
                self.assertIn(detector, [hit["detector"] for hit in hits])
                self.assertNotIn(resource, json.dumps(hits))

    def test_remote_resource_redaction_keeps_public_docs_and_code_structure(self) -> None:
        resource = "Abc123Def456" + "Ghi789Jkl012Mno"
        host = "tenant-private." + "feishu.cn"
        original = (
            f'bitableBaseToken: process.env.WATCHDOG_BITABLE_BASE_TOKEN || "{resource}";\n'
            f"https://{host}/wiki/{resource}\n"
            "https://open.feishu.cn/document/server-docs\n"
            "https://open.larksuite.com/document/server-docs\n"
            "https://example.feishu.cn/wiki/YOUR_NODE_TOKEN\n"
        )
        redacted, counts = release.apply_replacements(original, [], [])
        self.assertNotIn(resource, redacted)
        self.assertNotIn(host, redacted)
        self.assertIn('process.env.WATCHDOG_BITABLE_BASE_TOKEN || "YOUR_RESOURCE_ID"', redacted)
        self.assertIn("https://example.feishu.cn/wiki/YOUR_RESOURCE_ID", redacted)
        self.assertIn("https://open.feishu.cn/document/server-docs", redacted)
        self.assertIn("https://open.larksuite.com/document/server-docs", redacted)
        self.assertEqual(counts["pattern:remote_resource_assignment"], 1)
        self.assertEqual(counts["pattern:lark_tenant_host"], 1)
        self.assertEqual(counts["pattern:lark_resource_url"], 1)
        self.assertEqual(release.scan_text("config.txt", redacted, []), [])

    def test_placeholder_resource_does_not_hide_private_tenant_hostname(self) -> None:
        host = "tenant-private." + "larksuite.com"
        hits = release.scan_text("README.md", f"https://{host}/base/YOUR_BASE_TOKEN", [])
        self.assertEqual([hit["detector"] for hit in hits], ["lark_tenant_host"])

    def test_placeholder_hostname_does_not_hide_resource_during_redaction(self) -> None:
        resource = "Abc123Def456" + "Ghi789Jkl012Mno"
        original = f"https://YOUR_TENANT.feishu.cn/wiki/{resource}"
        redacted, counts = release.apply_replacements(original, [], [])
        self.assertEqual(redacted, "https://YOUR_TENANT.feishu.cn/wiki/YOUR_RESOURCE_ID")
        self.assertEqual(counts, {"pattern:lark_resource_url": 1})
        self.assertEqual(release.scan_text("README.md", redacted, []), [])

    def test_static_metadata_allowance_cannot_open_runtime_directories(self) -> None:
        metadata = "platform/first-principle/data/module-manifest.json"
        self.assertEqual(release.path_policy_hit(metadata, []), "denied_runtime_component")
        self.assertIsNone(release.path_policy_hit(metadata, [], [metadata]))
        for path in (
            "platform/first-principle/data/session-init.jsonl",
            "platform/first-principle/data/supermatrix.db",
            "platform/first-principle/data/credentials.json",
            "platform/first-principle/logs/events.json",
            "platform/first-principle/node_modules/pkg/index.json",
        ):
            with self.subTest(path=path):
                self.assertIsNotNone(release.path_policy_hit(path, [], [path]))
        self.assertIsNotNone(release.path_policy_hit(metadata, [], ["platform/first-principle/data/*"]))

    def test_short_field_and_view_ids_are_detected_without_raw_evidence(self) -> None:
        for prefix in ("fld", "vew"):
            value = prefix + "Aa29bQz"
            with self.subTest(prefix=prefix):
                hits = release.scan_text("config.json", json.dumps({"id": value}), [])
                self.assertEqual([hit["detector"] for hit in hits], ["bitable_field_or_view_id"])
                self.assertNotIn(value, json.dumps(hits))

    def test_short_id_redaction_preserves_distinct_references(self) -> None:
        first, second = "fld" + "Aa29bQz", "fld" + "Bb39cRp"
        view = "vew" + "Cc49dSq"
        original = json.dumps([first, second, first, view])
        redacted, counts = release.apply_replacements(original, [], [])
        values = json.loads(redacted)
        self.assertEqual(values[0], values[2])
        self.assertNotEqual(values[0], values[1])
        self.assertTrue(values[0].startswith("fldREDACTED"))
        self.assertTrue(values[3].startswith("vewREDACTED"))
        self.assertNotIn(first, redacted)
        self.assertEqual(counts["pattern:bitable_field_or_view_id"], 4)
        self.assertEqual(release.scan_text("config.json", redacted, []), [])
        self.assertEqual(release.apply_replacements(redacted, [], [])[0], redacted)

    def test_static_metadata_allowance_flows_through_build_and_rescan(self) -> None:
        destination = "platform/demo/data/module-manifest.json"
        self.write(self.demo, "data/module-manifest.json", '{"modules": []}\n')
        config = self.write_config([{
            "name": "demo",
            "root": "workspace:demo",
            "subpath": ".",
            "destination": "platform/demo",
            "include": ["data/module-manifest.json"],
            "exclude": [],
        }])
        payload = json.loads(config.read_text())
        payload["allowed_static_paths"] = [destination]
        config.write_text(json.dumps(payload))
        output, _, built = self.build(config)
        self.assertTrue(built["ok"])
        args = argparse.Namespace(
            config=config,
            root=output,
            keyword_file=self.keywords,
            max_file_bytes=None,
            evidence=self.root / "rescan.json",
        )
        self.assertTrue(release.scan_existing(args)["ok"])
        self.write(output, destination, '{"label": "Alice Private"}\n')
        rescanned = release.scan_existing(args)
        self.assertFalse(rescanned["ok"])
        self.assertIn("private_keyword:person:en", rescanned["scan"]["finding_counts"])

    def test_synthetic_secret_fixture_is_marked_before_secret_scan(self) -> None:
        original = (
            "sk-ant-api03-"
            + "A1b2C3d4E5f6G7h8I9j0"
            + "K1l2M3n4O5p6Q7r8S9t0"
        )
        self.assertEqual([item[0] for item in release.detect_secrets(original)], ["anthropic_key"])
        normalized, counts = release.normalize_synthetic_secret_fixtures(original)
        self.assertIn("TEST_", normalized)
        self.assertEqual(release.detect_secrets(normalized), [])
        self.assertEqual(counts, {"source:synthetic_secret_fixture": 1})

        ghp, _ = release.normalize_synthetic_secret_fixtures(
            "ghp_" + "012345678901234567" + "890123456789012345"
        )
        self.assertRegex(ghp, r"^ghp_[A-Za-z0-9]{36}$")
        self.assertIn("EXAMPLE", ghp)
        self.assertEqual(release.detect_secrets(ghp), [])

    def test_build_escapes_nul_only_in_javascript_source(self) -> None:
        self.write(self.supermatrix, "src/id.ts", b"const id = `left\0right`;\n")
        config = self.write_config(
            [
                {
                    "name": "core",
                    "root": "supermatrix",
                    "subpath": ".",
                    "destination": "supermatrix",
                    "include": ["src/**"],
                    "exclude": [],
                }
            ]
        )

        output, _, payload = self.build(config)

        self.assertEqual((output / "supermatrix/src/id.ts").read_bytes(), b"const id = `left\\0right`;\n")
        self.assertEqual(payload["replacement_totals"], {"source:nul_escape": 1})

    def test_export_keeps_agent_install_contract_with_its_sop(self) -> None:
        owner = self.make_repo("workspaces/gitmaster")
        contract = "# Agent installation\nReturn to this document on every error.\n"
        sop = "# Install SOP\nRead [the contract](../AGENT_INSTALL.md).\n"
        self.write(owner, "AGENT_INSTALL.md", contract)
        self.write(owner, "sop/SOP-install-draft-20260913-abc123.md", sop)
        self.write(owner, "docs/private-handoff.md", "local evidence only\n")
        actual_config = json.loads(
            (SCRIPT.parents[1] / "config/public-export.json").read_text()
        )
        mapping = next(
            entry for entry in actual_config["mappings"] if entry["name"] == "gitmaster"
        )
        self.write_required_fixture_files(owner, mapping)

        output, _, payload = self.build(self.write_config([mapping]))

        exported = output / "platform/gitmaster"
        self.assertEqual((exported / "AGENT_INSTALL.md").read_text(), contract)
        self.assertEqual(
            (exported / "sop/SOP-install-draft-20260913-abc123.md").read_text(), sop
        )
        self.assertFalse((exported / "docs/private-handoff.md").exists())
        self.assertTrue(payload["ok"])

    def test_export_uses_current_retired_lifecycle_entries(self) -> None:
        entries = ["install.sh", "uninstall.sh", "supermatrix-launch.sh"]
        expected = "#!/bin/sh\necho 'retired' >&2\nexit 2\n"
        for name in entries:
            self.write(self.supermatrix, f"scripts/launchd/{name}", expected)
            self.write(
                self.supermatrix,
                f"supermatrix/scripts/launchd/{name}",
                "#!/bin/sh\nlaunchctl unload old-install.plist\n",
            )
        self.write(self.supermatrix, "supermatrix/scripts/launchd/public.plist", "public template\n")
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        names = {"supermatrix-launchd-public-templates", "supermatrix-retired-lifecycle-entries"}
        config = self.write_config([item for item in current["mappings"] if item["name"] in names])

        output, _, payload = self.build(config)

        for name in entries:
            self.assertEqual((output / f"supermatrix/scripts/launchd/{name}").read_text(), expected)
        self.assertFalse((output / "supermatrix/scripts/launchd/public.plist").exists())
        self.assertEqual(payload["mapping_counts"]["supermatrix-retired-lifecycle-entries"], 3)

    def test_export_uses_current_terminal_launcher_not_stale_public_template(self) -> None:
        name = "terminal-launcher.sh"
        current_launcher = '#!/bin/sh\nsource "$IDENTITY_HELPER"\n'
        self.write(self.supermatrix, f"scripts/launchd/{name}", current_launcher)
        self.write(
            self.supermatrix,
            f"supermatrix/scripts/launchd/{name}",
            "#!/bin/sh\npgrep -f localwatch\n",
        )
        self.write(self.supermatrix, "scripts/launchd/private.log", "never export\n")
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        names = {"supermatrix-launchd-public-templates", "supermatrix-terminal-launcher"}
        config = self.write_config([item for item in current["mappings"] if item["name"] in names])

        output, _, payload = self.build(config)

        self.assertEqual(
            (output / f"supermatrix/scripts/launchd/{name}").read_text(), current_launcher
        )
        self.assertFalse((output / "supermatrix/scripts/launchd/private.log").exists())
        self.assertTrue(payload["ok"])

    def test_export_replaces_legacy_core_setup_with_public_contract_pointer(self) -> None:
        owner = self.make_repo("workspaces/gitmaster")
        pointer = "# Setup\nRead ../../AGENT_INSTALL.md version 1.0.1.\n"
        self.write(self.supermatrix, "docs/SETUP.md", "Install old archive and LaunchAgent.\n")
        self.write(owner, "public-overrides/supermatrix/docs/SETUP.md", pointer)
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        names = {"supermatrix-core", "supermatrix-public-setup"}
        self.write_required_fixture_files(
            self.supermatrix, next(item for item in current["mappings"] if item["name"] == "supermatrix-core")
        )
        config = self.write_config([item for item in current["mappings"] if item["name"] in names])

        output, _, payload = self.build(config)

        self.assertEqual((output / "supermatrix/docs/SETUP.md").read_text(), pointer)
        self.assertTrue(payload["ok"])

    def test_public_modules_use_closed_owner_inputs(self) -> None:
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        mappings = {item["name"]: item for item in current["mappings"]}
        self.assertFalse(any(item["root"] == "public-base" for item in mappings.values()))

        admitted = {
            "first-principle": [".python-version", "data/module-manifest.json", "bin/fp-generate-init"],
            "heartbeat": [".python-version", "pyproject.toml", "config/heartbeat.env.example"],
            "watchdog": ["config/watchdog.example.env", "src/cli.ts", "src/scripts/weekly-review-closure.ts"],
            "autobitable": ["src/server.mjs", "public-safe/src/server.mjs"],
            "socail-king": ["schemas/judgment.schema.json", "src/public-safe-ledger.mjs"],
            "mythos": ["public/kb/sources.jsonl", "public/THIRD_PARTY_NOTICES.md", "public/third-party/a2a-LICENSE", "public/third-party/mcp-LICENSE", "pyproject.toml", "scripts/build-index.py"],
            "skill-master": ["docs/onboarding-v1-skill-assets.json", "tests/test_public_skill_inputs.py", "skills/tdd/SKILL.md"],
            "larkc": ["public-input/lark-install-permissions.v1.json", "public-input/verify-public-input.test.mjs", "card-callback/src/cardAction.js", "card-callback/package-lock.json"],
            "wendangwang": ["README.md", "bin/feishu-sync-enqueue"],
        }
        denied = {
            "first-principle": ["logs/private.md", "data/live-sessions.json"],
            "heartbeat": ["scripts/r26-history-apply", "data/private.db"],
            "watchdog": ["src/scripts/weekly-upgrade.ts", "docs/incident-private.md"],
            "autobitable": ["config/webhooks.json", "logs/private.jsonl"],
            "socail-king": ["data/judgments.jsonl"],
            "mythos": ["kb/sources.jsonl", "scripts/bulk-fetch.sh", "public/logs/queries/queries.jsonl"],
            "skill-master": ["skills/caveman/SKILL.md", "docs/INDEX.md", "scripts/retire-skill.py"],
            "larkc": ["card-callback/src/server.js", "card-callback/node_modules/package/index.js"],
            "wendangwang": ["registry/live.json", "logs/private.jsonl"],
        }
        for expected, cases in ((True, admitted), (False, denied)):
            for name, paths in cases.items():
                mapping = mappings[name]
                for path in paths:
                    with self.subTest(name=name, path=path):
                        selected = release.matches_any(path, mapping["include"]) and not release.matches_any(path, mapping["exclude"])
                        self.assertEqual(selected, expected)

        for path in current["allowed_static_paths"]:
            self.assertIsNone(release.path_policy_hit(path, [], current["allowed_static_paths"]))
        self.assertEqual(len(current["allowed_static_paths"]), 4)

    def test_every_configured_module_builds_from_its_required_source_inventory(self) -> None:
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        expected: dict[str, int] = {}
        for mapping in current["mappings"]:
            self.assertTrue(mapping["required_files"], mapping["name"])
            root_name = mapping["root"]
            if root_name == "supermatrix":
                root = self.supermatrix
            else:
                self.assertTrue(root_name.startswith("workspace:"))
                root = self.workspaces / root_name.split(":", 1)[1]
                if not root.exists():
                    self.make_repo(root.relative_to(self.root).as_posix())
            self.write_required_fixture_files(root, mapping)
            selected = release.selected_files(mapping, self.supermatrix, self.workspaces, None)
            self.assertEqual(set(mapping["required_files"]) - {row[1] for row in selected}, set())
            expected[mapping["name"]] = len(selected)
        config = self.root / "full-config.json"
        config.write_text(json.dumps(current), encoding="utf-8")

        output, _, payload = self.build(config)

        self.assertEqual(payload["mapping_counts"], expected)
        self.assertEqual(len(payload["required_files"]), len(current["mappings"]))
        for mapping in current["mappings"]:
            for path in mapping["required_files"]:
                self.assertTrue((output / mapping["destination"] / path).is_file())

    def test_localwatch_uses_current_source_and_test(self) -> None:
        self.write(self.supermatrix, "scripts/localwatch.sh", "# current parameterized LocalWatch\n")
        self.write(self.supermatrix, "tests/scripts/localwatch.test.ts", "// current LocalWatch regression\n")
        self.write(self.supermatrix, "supermatrix/scripts/localwatch.sh", "# stale public baseline\n")
        current = json.loads((SCRIPT.parent.parent / "config/public-export.json").read_text())
        names = {"supermatrix-localwatch", "supermatrix-localwatch-test"}
        output, _, payload = self.build(self.write_config([item for item in current["mappings"] if item["name"] in names]))
        self.assertEqual((output / "supermatrix/scripts/localwatch.sh").read_text(), "# current parameterized LocalWatch\n")
        self.assertEqual((output / "supermatrix/tests/scripts/localwatch.test.ts").read_text(), "// current LocalWatch regression\n")
        self.assertTrue(payload["ok"])

    def test_build_updates_public_localwatch_to_scheduler_v2(self) -> None:
        self.write(
            self.supermatrix,
            "scripts/localwatch.sh",
            'SCHEDULER_PORT="${SCHEDULER_V2_PORT:-3502}"\n',
        )
        config = self.write_config(
            [
                {
                    "name": "localwatch",
                    "root": "public-base",
                    "subpath": "scripts",
                    "destination": "supermatrix/scripts",
                    "include": ["localwatch.sh"],
                    "exclude": [],
                }
            ]
        )

        output, _, payload = self.build(config)

        self.assertEqual(
            (output / "supermatrix/scripts/localwatch.sh").read_text(),
            'SCHEDULER_PORT="${SCHEDULER_V2_PORT:-3502}"\n',
        )
        self.assertEqual(payload["replacement_totals"], {"public:localwatch_scheduler_v2": 1})

    def test_scan_detects_keyword_in_filename_and_binary(self) -> None:
        scan_root = self.root / "scan"
        self.write(scan_root, "Secret Product.txt", "safe\n")
        self.write(scan_root, "blob.bin", b"safe\0binary")
        keywords = release.load_keywords(self.keywords)

        result = release.scan_tree(scan_root, keywords, 1024, [])

        self.assertFalse(result["ok"])
        self.assertEqual(result["finding_count"], 2)
        self.assertEqual(
            set(result["finding_counts"]),
            {"path:private_keyword:product:en", "binary_or_non_utf8"},
        )

    def test_scan_detects_denied_path_and_oversized_file(self) -> None:
        scan_root = self.root / "scan"
        self.write(scan_root, "data/value.txt", "safe\n")
        self.write(scan_root, "large.txt", "x" * 17)
        keywords = release.load_keywords(self.keywords)

        result = release.scan_tree(scan_root, keywords, 16, [])

        self.assertEqual(result["finding_count"], 2)
        self.assertEqual(
            set(result["finding_counts"]),
            {"denied_runtime_component", "oversized_file"},
        )

    def test_path_policy_allows_security_source_but_blocks_secret_container(self) -> None:
        self.assertIsNone(release.path_policy_hit("src/secret-redaction.ts", []))
        self.assertEqual(release.path_policy_hit("config/secrets.json", []), "credential_filename")

    def test_nonempty_output_is_rejected(self) -> None:
        output = self.root / "output"
        self.write(output, "existing.txt", "do not overwrite\n")

        with self.assertRaisesRegex(release.ReleaseError, "must be empty"):
            release.prepare_empty_output(output)


if __name__ == "__main__":
    unittest.main()
