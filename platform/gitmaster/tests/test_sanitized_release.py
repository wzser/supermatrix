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
