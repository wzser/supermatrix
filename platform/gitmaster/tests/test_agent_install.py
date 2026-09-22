from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AgentInstallDocumentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.document = (ROOT / "AGENT_INSTALL.md").read_text(encoding="utf-8")

    def test_agent_operated_path_does_not_require_a_new_installer(self) -> None:
        self.assertIn('version: "1.2.0"', self.document)
        self.assertIn("No new installer is required", self.document)
        self.assertIn("configuration gap", self.document)
        self.assertIn("package gap", self.document)
        self.assertNotIn("Record `BLOCKED / R00` before installation mutations", self.document)

    def test_single_checklist_covers_every_distributed_role_and_relay(self) -> None:
        ids = re.findall(r"^\| \[ \] \| ([A-Z][0-9]{2}) \|", self.document, re.MULTILINE)
        self.assertEqual(len(ids), 57)
        self.assertEqual(len(ids), len(set(ids)))
        expected = {f"M{i:02d}" for i in range(1, 13)}
        expected.update(f"N{i:02d}" for i in range(1, 9))
        expected.update(f"L{i:02d}" for i in range(1, 8))
        expected.update(f"B{i:02d}" for i in range(1, 7))
        self.assertTrue(expected.issubset(ids), sorted(expected.difference(ids)))
        for role in (
            "supermatrix-root", "scheduler", "heartbeat", "watchdog",
            "first-principle", "skill-master", "autobitable", "localgit",
            "socail-king", "mythos", "gitmaster", "larkc",
        ):
            self.assertIn(f"`{role}`", self.document)

    def test_resume_still_distinguishes_supervisor_ownership(self) -> None:
        self.assertIn("Confirmed pre-registration", self.document)
        self.assertIn("Registered or handed over", self.document)
        self.assertIn("Unknown or contradictory", self.document)
        self.assertIn("Do not run direct S5/start.sh", self.document)

    def test_permission_and_parity_claims_are_bounded(self) -> None:
        self.assertIn("base:record:read", self.document)
        self.assertIn("not a complete platform permission list", self.document)
        self.assertIn("outbound", self.document)
        self.assertIn("HTTPS", self.document)
        self.assertIn("missing package code", self.document)
        self.assertIn("No parity claim", self.document)
        self.assertIn("return to R", self.document)

    def test_permission_login_and_readback_have_distinct_scope_encoding(self) -> None:
        self.assertIn('auth check --json --scope "$REQUIRED_USER_SCOPES_SPACE"', self.document)
        self.assertIn("comma-separated string for `auth login`", self.document)
        self.assertIn("same saved items joined with spaces", self.document)
        self.assertIn("lark-install-permissions.v1.json", self.document)
        self.assertIn("Do not run `event consume` as a permanent second consumer", self.document)

    def test_module_dependencies_and_queue_use_materialized_namespace(self) -> None:
        self.assertIn("Construct each child environment from empty", self.document)
        self.assertIn("native `env -i`", self.document)
        self.assertIn("not a general environment scrubber", self.document)
        self.assertIn("### M0.1. Prepare Materialized Module Dependencies", self.document)
        self.assertIn("card-callback/` needs its own `npm ci`", self.document)
        self.assertIn("SM_FEISHU_NAMESPACE_MODE=standalone", self.document)
        self.assertIn('LARK_CLI_PROFILE="$PROFILE"', self.document)
        self.assertIn('"$WENDANGWANG_ROOT/bin/feishu-sync-status" --db "$QUEUE_DB"', self.document)
        self.assertIn("This no-job/no-key status call creates the queue schema", self.document)
        self.assertIn("On resume, preserve and inspect existing jobs", self.document)
        self.assertIn("read `QUEUE_DB` from this runtime JSON's `queue_db`", self.document)
        for unsupported in ("SKILL_MASTER_CONFIG", "SKILL_MASTER_ROOT"):
            self.assertNotIn(unsupported, self.document)

    def test_public_automation_uses_the_shipped_prompt_profile(self) -> None:
        self.assertIn("X-SM-Dry-Run: true", self.document)
        self.assertIn("command.type=prompt", self.document)
        self.assertIn("writeback.enabled=false", self.document)
        self.assertIn("public-safe/scripts/register-webhook-secret.mjs", self.document)
        self.assertIn("waiting_child", self.document)
        self.assertIn("timeout means no approval", self.document)

    def test_s5_command_does_not_inherit_ambient_credentials(self) -> None:
        section = self.document.split("## S5. Apply, Resume and Inspect Through One Entry", 1)[1]
        command = re.search(r"```sh\n(.*?)\n```", section, re.DOTALL).group(1)
        with tempfile.TemporaryDirectory(prefix="agent-install-env-") as temporary:
            root = Path(temporary)
            npm = root / "npm"
            npm.write_text("#!/bin/sh\nexec /usr/bin/env\n", encoding="utf-8")
            npm.chmod(0o700)
            ambient = {
                "PATH": "/usr/bin:/bin", "NPM_BIN": str(npm),
                "ISOLATED_HOME": str(root / "home"),
                "XDG_CONFIG_HOME": str(root / "xdg"),
                "CODEX_HOME": str(root / "codex"), "TOOL_PATH": "/usr/bin:/bin",
                "PYTHON_BIN": str(root / "python"), "LARK_BIN": str(root / "lark"),
                "CODEX_BIN": str(root / "codex-bin"), "APP_ROOT": str(root / "app"),
                "PROFILE": "example-install", "RUNTIME_ROOT": str(root / "runtime"),
                "WORKSPACE_ROOT": str(root / "workspaces"), "DB_PATH": str(root / "state.db"),
                "API_PORT": "3511", "SCHEDULER_PORT": "3512",
            }
            blocked = {
                "OPENAI_API_KEY", "LARK_APP_SECRET", "SM_API_BASE",
                "HTTP_PROXY", "NODE_OPTIONS", "PYTHONPATH",
            }
            ambient.update({key: "TEST_INHERITED_VALUE" for key in blocked})
            result = subprocess.run(
                ["/bin/sh", "-c", command], env=ambient,
                text=True, capture_output=True, check=True,
            )
            observed = dict(line.split("=", 1) for line in result.stdout.splitlines())
            self.assertFalse(blocked.intersection(observed), blocked.intersection(observed))
            self.assertEqual(observed["HOME"], ambient["ISOLATED_HOME"])
            self.assertEqual(observed["SM_LARK_CLI_PATH"], ambient["LARK_BIN"])
            self.assertEqual(observed["SM_CODEX_CLI_PATH"], ambient["CODEX_BIN"])

    def test_native_login_registration_and_same_boot_handoff_are_distinct(self) -> None:
        self.assertIn('LAUNCH_UID="$(id -u)"', self.document)
        self.assertIn('$USER_HOME/Library/LaunchAgents/$LABEL.plist', self.document)
        self.assertIn("unchanged OS `bootId`", self.document)
        self.assertNotIn('UID="$(id -u)"\n', self.document.replace('LAUNCH_UID="$(id -u)"\n', ''))
        self.assertNotIn("**and a new bootId**", self.document)
        self.assertIn("not a promised boot-time SLA", self.document)
        self.assertNotIn("[SOURCE_ROOT]", self.document)
        self.assertIn("| `INSTALL_ID`, `LABEL` |", self.document)
        self.assertIn("state.json`'s `installId`", self.document)

    def test_native_services_do_not_assume_unshipped_log_rotation(self) -> None:
        self.assertIn("does not implement automatic log rotation", self.document)
        self.assertNotIn("five rotated files, and 30 days", self.document)
        self.assertIn("LARK_FAKE=0", self.document)
        self.assertIn("--env-file=", self.document)
        self.assertIn("BROKER_EVENTS_LOG", self.document)

    def test_sop_and_setup_reference_the_same_version(self) -> None:
        for relative in (
            "sop/SOP-agent-install-draft-20260914-83e8f1.md",
            "public-overrides/supermatrix/docs/SETUP.md",
        ):
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertIn("1.2.0", text)
            self.assertNotIn("1.1.0", text)
        self.assertLess(self.document.splitlines().index("## S1. Establish the Contract Before Writing"), 25)

    def test_install_contract_is_bound_to_the_v031_release_assets(self) -> None:
        documents = [
            self.document,
            (ROOT / "sop/SOP-agent-install-draft-20260914-83e8f1.md").read_text(encoding="utf-8"),
            (ROOT / "public-overrides/supermatrix/docs/SETUP.md").read_text(encoding="utf-8"),
        ]
        for document in documents:
            self.assertIn("v0.3.1", document)
            self.assertNotIn("v0.3.0", document)
        self.assertIn("supermatrix-v0.3.1.tar", self.document)
        self.assertIn("supermatrix-v0.3.1/", self.document)


if __name__ == "__main__":
    unittest.main()
