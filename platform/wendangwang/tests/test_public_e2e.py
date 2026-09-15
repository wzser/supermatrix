from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_GLOB = str(ROOT / "tests/fixtures/public-demo.asset.json")
STUB = ROOT / "tests/fixtures/lark-cli"


class PublicQueueE2ETests(unittest.TestCase):
    def _env(self, state: Path, *, deny: bool = False) -> dict[str, str]:
        env = os.environ.copy()
        env.update({
            "SM_FEISHU_PYTHON": sys.executable,
            "LARK_CLI_BIN": str(STUB),
            "PUBLIC_LARK_STUB_STATE": str(state),
            "SM_FEISHU_NAMESPACE_MODE": "standalone",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        if deny:
            env["PUBLIC_LARK_STUB_MODE"] = "deny"
        else:
            env.pop("PUBLIC_LARK_STUB_MODE", None)
        return env

    def _run(self, name: str, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(ROOT / "bin" / name), *args],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    @staticmethod
    def _json(stdout: str) -> dict:
        return json.loads(stdout.strip().splitlines()[-1])

    def test_fresh_install_initializes_missing_db_before_explicit_enqueue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            db = temp / "new-private.sqlite"
            self.assertFalse(db.exists())

            missing_lark_env = os.environ.copy()
            missing_lark_env.update({
                "SM_FEISHU_PYTHON": sys.executable,
                "LARK_CLI_BIN": "/definitely-missing-lark-cli",
                "SM_FEISHU_NAMESPACE_MODE": "standalone",
                "PYTHONDONTWRITEBYTECODE": "1",
            })
            previous_umask = os.umask(0o077)
            try:
                first_counts = None
                for _ in range(2):
                    status = self._run(
                        "feishu-sync-status", "--db", str(db),
                        env=missing_lark_env,
                    )
                    self.assertEqual(status.returncode, 0, status.stderr)
                    counts = self._json(status.stdout)
                    self.assertEqual(
                        {key: counts[key] for key in (
                            "cancelled", "done", "failed", "held",
                            "in_progress", "pending", "superseded",
                        )},
                        {key: 0 for key in (
                            "cancelled", "done", "failed", "held",
                            "in_progress", "pending", "superseded",
                        )},
                    )
                    if first_counts is None:
                        first_counts = counts
                    else:
                        self.assertEqual(counts, first_counts)
                    self.assertEqual(status.stderr, "")
            finally:
                os.umask(previous_umask)

            self.assertTrue(db.is_file())
            self.assertEqual(db.stat().st_mode & 0o777, 0o600)
            with sqlite3.connect(db.resolve().as_uri() + "?mode=ro", uri=True) as conn:
                tables = {
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM sqlite_schema WHERE type='table'"
                    )
                }
            self.assertIn("sync_jobs", tables)
            self.assertIn("sync_job_keys", tables)

            rows = temp / "rows.json"
            rows.write_text(
                json.dumps([{"键": "fresh", "值": "initialized"}], ensure_ascii=False)
            )
            state = temp / "lark-state.json"
            env = self._env(state)
            enqueue = self._run(
                "feishu-sync-enqueue",
                "--asset", "public.demo", "--from", "user-agent",
                "--key", "fresh-install-key", "--rows", str(rows),
                "--db", str(db), "--registry-glob", CONTRACT_GLOB,
                "--no-drain", env=env,
            )
            self.assertEqual(enqueue.returncode, 0, enqueue.stderr)
            accepted = self._json(enqueue.stdout)
            job_id = int(accepted["job_id"])
            self.assertEqual(accepted["status"], "accepted")

            resume_status = self._run("feishu-sync-status", "--db", str(db), env=env)
            self.assertEqual(resume_status.returncode, 0, resume_status.stderr)
            self.assertEqual(self._json(resume_status.stdout)["pending"], 1)
            resumed_job_status = self._run(
                "feishu-sync-status", "--db", str(db), "--job-id", str(job_id), env=env,
            )
            self.assertEqual(resumed_job_status.returncode, 0, resumed_job_status.stderr)
            resumed_job = self._json(resumed_job_status.stdout)["jobs"][0]
            self.assertEqual(resumed_job["id"], job_id)
            self.assertEqual(resumed_job["dedupe_key"], "fresh-install-key")
            self.assertEqual(resumed_job["status"], "pending")

            consumer = self._run(
                "feishu-sync-consumer", "--db", str(db),
                "--registry-glob", CONTRACT_GLOB, env=env,
            )
            self.assertEqual(consumer.returncode, 0, consumer.stderr)

    def test_enqueue_consume_readback_duplicate_and_permission_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            rows = temp / "rows.json"
            rows.write_text(json.dumps([{"键": "alpha", "值": "one"}], ensure_ascii=False))
            state = temp / "lark-state.json"
            db = temp / "queue.sqlite"
            env = self._env(state)
            db_init = self._run("feishu-sync-status", "--db", str(db), env=env)
            self.assertEqual(db_init.returncode, 0, db_init.stderr)
            enqueue = self._run(
                "feishu-sync-enqueue",
                "--asset", "public.demo", "--from", "user-agent",
                "--key", "demo-key-1", "--rows", str(rows), "--db", str(db),
                "--registry-glob", CONTRACT_GLOB, "--no-drain", env=env,
            )
            self.assertEqual(enqueue.returncode, 0, enqueue.stderr)
            accepted = self._json(enqueue.stdout)
            job_id = int(accepted["job_id"])
            self.assertEqual(accepted["status"], "accepted")

            consumer = self._run(
                "feishu-sync-consumer", "--db", str(db),
                "--registry-glob", CONTRACT_GLOB, env=env,
            )
            self.assertEqual(consumer.returncode, 0, consumer.stderr)
            status = self._run("feishu-sync-status", "--db", str(db), "--job-id", str(job_id), env=env)
            self.assertEqual(status.returncode, 0, status.stderr)
            job = self._json(status.stdout)["jobs"][0]
            self.assertEqual(job["status"], "done")
            self.assertTrue(job["read_back_verified"])
            self.assertTrue(job["receipt_job_verified"])
            self.assertEqual(json.loads(state.read_text())["records"], {"rec_demo_1": {"键": "alpha", "值": "one"}})

            duplicate = self._run(
                "feishu-sync-enqueue",
                "--asset", "public.demo", "--from", "user-agent",
                "--key", "demo-key-1", "--rows", str(rows), "--db", str(db),
                "--registry-glob", CONTRACT_GLOB, "--no-drain", env=env,
            )
            self.assertEqual(duplicate.returncode, 0, duplicate.stderr)
            self.assertTrue(self._json(duplicate.stdout)["duplicate"])
            self.assertEqual(len(json.loads(state.read_text())["records"]), 1)

            failed_db = temp / "failed.sqlite"
            failed_init = self._run("feishu-sync-status", "--db", str(failed_db), env=env)
            self.assertEqual(failed_init.returncode, 0, failed_init.stderr)
            failed = self._run(
                "feishu-sync-enqueue",
                "--asset", "public.demo", "--from", "user-agent",
                "--key", "demo-key-permission", "--rows", str(rows), "--db", str(failed_db),
                "--registry-glob", CONTRACT_GLOB, "--no-drain", env=self._env(state, deny=True),
            )
            self.assertEqual(failed.returncode, 0, failed.stderr)
            failed_id = int(self._json(failed.stdout)["job_id"])
            denied_consumer = self._run(
                "feishu-sync-consumer", "--db", str(failed_db),
                "--registry-glob", CONTRACT_GLOB, env=self._env(state, deny=True),
            )
            self.assertEqual(denied_consumer.returncode, 1)
            failed_status = self._run(
                "feishu-sync-status", "--db", str(failed_db), "--job-id", str(failed_id),
                env=self._env(state),
            )
            failed_job = self._json(failed_status.stdout)["jobs"][0]
            self.assertEqual(failed_job["status"], "failed")
            self.assertIn("permission denied", failed_job["last_error"])


if __name__ == "__main__":
    unittest.main()
