from __future__ import annotations

import hashlib
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


PROBE_SOURCE = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "storage-retention"
    / "T017"
    / "verify-per-candidate-recovery"
)


class PerCandidateRecoveryProbeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.probe = self.root / "verify-per-candidate-recovery"
        self.probe.write_bytes(PROBE_SOURCE.read_bytes())
        self.probe.chmod(0o755)

        source = self.root / "candidate.jsonl"
        source.write_bytes(b"recoverable candidate\n")
        self.candidate_path = str(source.resolve())
        self.digest = hashlib.sha256(source.read_bytes()).hexdigest()
        self.member = "Users/example/candidate.jsonl"
        self.archive = self.root / "recovery.tar"
        with tarfile.open(self.archive, "w") as output:
            output.add(source, arcname=self.member)
        self.archive_digest = hashlib.sha256(self.archive.read_bytes()).hexdigest()
        self.approved = self.root / "approved-candidates.json"
        self._write_approved()
        self.manifest = self.root / "per-candidate-recovery-manifest.json"
        self._write_manifest()

    def _write_approved(self, *, candidates: list[dict] | None = None) -> None:
        self.approved.write_text(
            json.dumps(
                {
                    "schema": "heartbeat.retention-candidates/v1",
                    "candidates": candidates
                    if candidates is not None
                    else [
                        {
                            "path": self.candidate_path,
                            "bytes": 22,
                            "sha256": self.digest,
                        }
                    ],
                }
            )
            + "\n"
        )

    def _write_manifest(self) -> None:
        self.manifest.write_text(
            json.dumps(
                {
                    "schema": "heartbeat.per-candidate-recovery-manifest/v1",
                    "source_candidate_manifest": str(self.approved),
                    "archive": {
                        "path": str(self.archive),
                        "sha256": self.archive_digest,
                    },
                    "candidates": [
                        {
                            "path": self.candidate_path,
                            "sha256": self.digest,
                            "bytes": 22,
                            "archive_path": str(self.archive),
                            "archive_sha256": self.archive_digest,
                            "member": self.member,
                            "member_sha256": self.digest,
                        }
                    ],
                }
            )
            + "\n"
        )

    def _run(self, *, path: str | None = None, digest: str | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [self.probe, path or self.candidate_path, digest or self.digest],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_valid_member_is_restored_to_temporary_file_and_verified(self) -> None:
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "passed")
        self.assertTrue(payload["manifest_present"])
        self.assertTrue(payload["archive_readable"])
        self.assertTrue(payload["digest_match"])
        self.assertTrue(payload["restore_dry_run"])
        self.assertTrue(payload["approved_candidate_match"])
        self.assertEqual(payload["source_candidate_manifest"], str(self.approved))

    def test_wrong_requested_digest_fails_closed(self) -> None:
        result = self._run(digest="0" * 64)
        self.assertNotEqual(result.returncode, 0)

    def test_corrupt_archive_fails_closed(self) -> None:
        self.archive.write_bytes(b"not a tar archive")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)

    def test_missing_manifest_fails_closed(self) -> None:
        self.manifest.unlink()
        result = self._run()
        self.assertNotEqual(result.returncode, 0)

    def test_candidate_absent_from_authoritative_manifest_fails_closed(self) -> None:
        self._write_approved(candidates=[])
        result = self._run()
        self.assertNotEqual(result.returncode, 0)

    def test_authoritative_byte_drift_fails_closed(self) -> None:
        self._write_approved(
            candidates=[
                {"path": self.candidate_path, "bytes": 23, "sha256": self.digest}
            ]
        )
        result = self._run()
        self.assertNotEqual(result.returncode, 0)

    def test_undeclared_authoritative_manifest_fails_closed(self) -> None:
        payload = json.loads(self.manifest.read_text())
        payload.pop("source_candidate_manifest")
        self.manifest.write_text(json.dumps(payload) + "\n")
        result = self._run()
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
