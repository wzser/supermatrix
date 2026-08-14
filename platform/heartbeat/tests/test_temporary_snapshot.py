import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from heartbeat_patrol.state import HeartbeatState
from heartbeat_patrol.temporary_snapshot import (
    cleanup_expired_temporary_snapshots,
    create_temporary_snapshot,
)


class TemporarySnapshotTest(unittest.TestCase):
    def new_state(self, root: Path) -> HeartbeatState:
        return HeartbeatState(root / "heartbeat.sqlite")

    def test_create_requires_owner_reason_and_a_future_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = self.new_state(root)
            snapshot_dir = root / "temporary-snapshots"
            expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(timespec="seconds")

            with self.assertRaisesRegex(ValueError, "owner"):
                create_temporary_snapshot(
                    state=state,
                    snapshot_dir=snapshot_dir,
                    owner="",
                    reason="schema migration guard",
                    expires_at=expires_at,
                )
            with self.assertRaisesRegex(ValueError, "reason"):
                create_temporary_snapshot(
                    state=state,
                    snapshot_dir=snapshot_dir,
                    owner="heartbeat",
                    reason="",
                    expires_at=expires_at,
                )
            with self.assertRaisesRegex(ValueError, "future"):
                create_temporary_snapshot(
                    state=state,
                    snapshot_dir=snapshot_dir,
                    owner="heartbeat",
                    reason="schema migration guard",
                    expires_at="2020-01-01T00:00:00+00:00",
                )

    def test_snapshot_has_receipt_and_expiry_cleanup_keeps_audit(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = self.new_state(root)
            state.log_event(event_type="test_seed", status="completed", summary="before temporary snapshot")
            snapshot_dir = root / "temporary-snapshots"
            now = datetime(2026, 8, 3, 3, 0, tzinfo=timezone.utc)
            expires_at = (now + timedelta(minutes=10)).isoformat(timespec="seconds")

            created = create_temporary_snapshot(
                state=state,
                snapshot_dir=snapshot_dir,
                owner="heartbeat",
                reason="reversible schema migration",
                expires_at=expires_at,
                now=now,
            )

            snapshot_path = Path(created["snapshot_path"])
            receipt_path = Path(created["receipt_path"])
            self.assertTrue(snapshot_path.is_file())
            self.assertTrue(receipt_path.is_file())
            self.assertEqual(sqlite3.connect(snapshot_path).execute("PRAGMA quick_check(1)").fetchone()[0], "ok")
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt["status"], "active")
            self.assertEqual(receipt["owner"], "heartbeat")
            self.assertEqual(receipt["reason"], "reversible schema migration")
            self.assertEqual(receipt["expires_at"], expires_at)
            self.assertGreater(created["snapshot_bytes"], 0)

            before_expiry = cleanup_expired_temporary_snapshots(
                state=state,
                snapshot_dir=snapshot_dir,
                now=now + timedelta(minutes=9),
            )
            self.assertEqual(before_expiry["cleaned"], [])
            self.assertTrue(snapshot_path.exists())
            expected_release = sum(
                path.stat().st_size
                for path in (snapshot_path, Path(f"{snapshot_path}-wal"), Path(f"{snapshot_path}-shm"))
                if path.exists()
            )

            cleaned = cleanup_expired_temporary_snapshots(
                state=state,
                snapshot_dir=snapshot_dir,
                now=now + timedelta(minutes=11),
            )
            self.assertEqual(len(cleaned["cleaned"]), 1)
            self.assertFalse(snapshot_path.exists())
            receipt = json.loads(receipt_path.read_text())
            self.assertEqual(receipt["status"], "cleaned")
            self.assertEqual(receipt["released_bytes"], expected_release)
            with sqlite3.connect(state.path) as conn:
                events = [
                    row[0]
                    for row in conn.execute(
                        "SELECT event_type FROM heartbeat_events ORDER BY created_at, event_id"
                    ).fetchall()
                ]
            self.assertIn("temporary_snapshot_created", events)
            self.assertIn("temporary_snapshot_cleaned", events)

    def test_failed_snapshot_validation_leaves_no_unreceipted_database_copy(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = self.new_state(root)
            snapshot_dir = root / "temporary-snapshots"
            expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(timespec="seconds")

            with patch("heartbeat_patrol.temporary_snapshot._quick_check", side_effect=RuntimeError("bad snapshot")):
                with self.assertRaisesRegex(RuntimeError, "bad snapshot"):
                    create_temporary_snapshot(
                        state=state,
                        snapshot_dir=snapshot_dir,
                        owner="heartbeat",
                        reason="must not leave an unreceipted copy",
                        expires_at=expires_at,
                    )

            self.assertEqual(list(snapshot_dir.glob("heartbeat-temporary-*.sqlite")), [])
            self.assertEqual(list(snapshot_dir.glob("heartbeat-temporary-*.receipt.json")), [])

    def test_cleanup_refuses_a_receipt_that_points_outside_managed_directory(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state = self.new_state(root)
            snapshot_dir = root / "temporary-snapshots"
            snapshot_dir.mkdir()
            outside = root / "heartbeat.sqlite.copy"
            outside.write_bytes(b"do not delete")
            receipt_path = snapshot_dir / "heartbeat-temporary-untrusted.receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "format": "heartbeat-temporary-snapshot-v1",
                        "snapshot_id": "untrusted",
                        "status": "active",
                        "owner": "heartbeat",
                        "reason": "test",
                        "expires_at": "2020-01-01T00:00:00+00:00",
                        "snapshot_path": str(outside),
                    }
                )
            )

            result = cleanup_expired_temporary_snapshots(
                state=state,
                snapshot_dir=snapshot_dir,
                now=datetime(2026, 8, 3, tzinfo=timezone.utc),
            )

            self.assertTrue(outside.exists())
            self.assertEqual(result["cleaned"], [])
            self.assertEqual(result["skipped_unsafe"], [str(receipt_path.resolve())])

    def test_full_patrol_runs_expiry_cleanup_but_targeted_patrol_does_not(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            state_path = root / "heartbeat.sqlite"
            state = HeartbeatState(state_path)
            snapshot_dir = root / "temporary-snapshots"
            current = datetime.now(timezone.utc)
            created = create_temporary_snapshot(
                state=state,
                snapshot_dir=snapshot_dir,
                owner="heartbeat",
                reason="patrol cleanup integration test",
                expires_at=(current + timedelta(minutes=5)).isoformat(timespec="seconds"),
            )
            snapshot_path = Path(created["snapshot_path"])
            receipt_path = Path(created["receipt_path"])
            receipt = json.loads(receipt_path.read_text())
            receipt["expires_at"] = "2020-01-01T00:00:00+00:00"
            receipt_path.write_text(json.dumps(receipt))

            repo = Path(__file__).resolve().parents[1]
            env = os.environ.copy()
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["HEARTBEAT_STATE_DB"] = str(state_path)
            env["SM_DB_PATH"] = str(root / "missing-supermatrix.db")
            env["HEARTBEAT_COMPLETION_DIR"] = str(root / "completion")
            targeted = subprocess.run(
                ["./heartbeat-patrol", "--session", "alpha"],
                cwd=repo / "scripts",
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )
            self.assertNotEqual(targeted.returncode, 0)
            self.assertTrue(snapshot_path.exists())

            full = subprocess.run(
                ["./heartbeat-patrol"],
                cwd=repo / "scripts",
                env=env,
                text=True,
                capture_output=True,
                timeout=10,
            )
            self.assertNotEqual(full.returncode, 0)
            self.assertFalse(snapshot_path.exists())
            with sqlite3.connect(state_path) as conn:
                event_types = [
                    row[0]
                    for row in conn.execute("SELECT event_type FROM heartbeat_events").fetchall()
                ]
            self.assertIn("temporary_snapshot_cleaned", event_types)


if __name__ == "__main__":
    unittest.main()
