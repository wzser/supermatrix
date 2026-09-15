from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

from heartbeat_patrol.history import (
    CanonicalPackWriter,
    archive_completion_bytes,
    compact_closed_live_manifests,
    compact_rotated_enqueue_logs,
    emit_trigger_result,
    index_trigger_log,
    is_never_sweep_history_path,
    open_enqueue_log_for_child,
    pointerize_trigger_payload,
    prepare_enqueue_log,
    maintain_enqueue_trigger_logs,
    reconstruct_completion_pointer_bytes,
    reconstruct_completion_bytes,
    rotate_enqueue_log_in_place,
    run_dry_run_migration,
    unlink_history_path,
    verify_dry_run_artifacts,
)
from heartbeat_patrol.state import HeartbeatState


class CompletionHistoryTest(unittest.TestCase):
    def test_manifest_locates_canonical_template_and_reconstructs_original_receipt(self) -> None:
        receipt = {
            "status": "completed",
            "run": {
                "completion_id": "attempt-one",
                "patrol_id": "patrol-one",
                "started_at": "2026-08-20T01:00:00+00:00",
                "finished_at": "2026-08-20T01:00:02+00:00",
            },
            "todos": {"live": 3, "terminal": 9, "over_sla_landing": 1},
            "unrecovered": {"targets": 1, "failures": 2, "active": []},
            "escalation_handoffs": {
                "awaiting_acceptance": 1,
                "notify_failed": 0,
                "legacy_unverifiable": 0,
                "recent": [{"handoff_id": "handoff-one", "created_at": "2026-08-20T00:59:00+00:00"}],
            },
        }
        raw = (json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_path = root / "completion" / "attempt-one.json"
            original_path.parent.mkdir()
            original_path.write_bytes(raw)

            manifest = archive_completion_bytes(
                raw=raw,
                original_path=original_path,
                canonical_dir=root / "canonical",
                event_ids=["event-one"],
                handoff_ids=["handoff-one"],
                todo_ids=["todo-one"],
                batch_keys=["batch-one"],
                created_at="2026-08-20T02:00:00+00:00",
            )

            required = {
                "completion_id",
                "patrol_id",
                "event_ids",
                "handoff_ids",
                "todo_ids",
                "batch_keys",
                "started_at",
                "finished_at",
                "status",
                "original_sha256",
                "normalized_sha256",
                "original_path",
                "canonical_object_id",
                "content_sha256",
                "archive_path",
                "byte_offset",
                "byte_length",
                "schema_version",
                "created_at",
            }
            self.assertTrue(required.issubset(manifest))
            self.assertEqual(manifest["original_sha256"], hashlib.sha256(raw).hexdigest())
            self.assertEqual(manifest["event_ids"], ["event-one"])
            self.assertEqual(manifest["handoff_ids"], ["handoff-one"])
            self.assertEqual(manifest["todo_ids"], ["todo-one"])
            self.assertEqual(manifest["batch_keys"], ["batch-one"])

            canonical = json.loads(Path(manifest["archive_path"]).read_text())
            self.assertEqual(canonical["todos"], receipt["todos"])
            self.assertEqual(canonical["escalation_handoffs"], receipt["escalation_handoffs"])

            rebuilt = reconstruct_completion_bytes(manifest)
            self.assertEqual(rebuilt, raw)
            self.assertEqual(hashlib.sha256(rebuilt).hexdigest(), manifest["original_sha256"])

    def test_completion_pointer_reconstructs_canonical_body_without_duplicate_receipt_body(self) -> None:
        receipt = {
            "status": "completed",
            "run": {
                "completion_id": "attempt-pointer",
                "patrol_id": "patrol-pointer",
                "started_at": "2026-08-24T01:00:00+00:00",
                "finished_at": "2026-08-20T01:00:02+00:00",
            },
            "coverage": {"scope": "targeted", "coverage_complete": False},
            "todos": {"live": 0, "terminal": 1, "over_sla_landing": 0},
            "unrecovered": {"targets": 0, "failures": 0, "active": []},
            "escalation_handoffs": {"recent": []},
        }
        raw = (json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            from heartbeat_patrol.history import archive_live_completion, completion_pointer

            manifest = archive_live_completion(
                raw=raw,
                original_path=root / "completion" / "attempt-pointer.json",
                state_db_path=None,
                canonical_dir=root / "canonical",
                manifest_dir=root / "manifests" / "live",
                created_at="2026-08-24T02:00:00+00:00",
            )
            pointer = completion_pointer(manifest)

            self.assertEqual(pointer["schema"], "heartbeat.completion-pointer/v1")
            self.assertEqual(pointer["run"], receipt["run"])
            self.assertNotIn("todos", pointer)
            self.assertNotIn("unrecovered", pointer)
            self.assertTrue(manifest["manifest_path"].endswith("completion-2026-08-24.jsonl"))
            self.assertEqual(reconstruct_completion_pointer_bytes(pointer), raw)

    def test_production_manifest_and_completion_canonical_are_never_sweep(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            protected = root / "history-manifests" / "production-20260820" / "completion-manifest.jsonl"
            protected.parent.mkdir(parents=True)
            protected.write_text("protected\n")
            self.assertTrue(
                is_never_sweep_history_path(
                    protected,
                    data_root=root,
                )
            )
            self.assertTrue(
                is_never_sweep_history_path(
                    root / "history-canonical" / "completion" / "objects" / "aa" / "object.json",
                    data_root=root,
                )
            )
            self.assertFalse(
                is_never_sweep_history_path(
                    root / "history-manifests" / "T02-dryrun-20260821" / "completion-manifest.jsonl",
                    data_root=root,
                )
            )
            with self.assertRaises(PermissionError):
                unlink_history_path(protected, data_root=root)
            self.assertTrue(protected.is_file())

    def test_closed_live_manifest_compacts_with_uncompressed_hash_readback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "history-manifests" / "live" / "completion" / "2026-08" / "completion-2026-08-20.jsonl"
            manifest.parent.mkdir(parents=True)
            original = b'{"completion_id":"one"}\n{"completion_id":"two"}\n'
            manifest.write_bytes(original)

            result = compact_closed_live_manifests(
                manifest_root=root / "history-manifests" / "live",
                before_day="2026-08-22",
                apply=True,
                data_root=root,
            )

            compressed = manifest.with_suffix(".jsonl.gz")
            self.assertEqual(result["compacted"], 1)
            self.assertFalse(manifest.exists())
            self.assertTrue(compressed.is_file())
            import gzip

            self.assertEqual(gzip.decompress(compressed.read_bytes()), original)
            receipt = json.loads(compressed.with_suffix(".gz.segment.json").read_text())
            self.assertEqual(receipt["uncompressed_sha256"], hashlib.sha256(original).hexdigest())

    def test_live_manifest_append_lock_blocks_compaction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "history-manifests" / "live" / "completion" / "2026-08" / "completion-2026-08-20.jsonl"
            manifest.parent.mkdir(parents=True)
            manifest.write_bytes(b'{"completion_id":"one"}\n')
            lock = manifest.with_suffix(".lock").open("a")
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            child = subprocess.Popen(
                [str(VENV_PYTHON), "-c", "import time; time.sleep(0.5)"],
                pass_fds=(lock.fileno(),),
            )
            lock.close()
            try:
                blocked = compact_closed_live_manifests(
                    manifest_root=root / "history-manifests" / "live",
                    before_day="2026-08-22",
                    apply=True,
                    data_root=root,
                )
                self.assertEqual(blocked["compacted"], 0)
                self.assertTrue(manifest.is_file())
            finally:
                child.wait(timeout=2)
            compacted = compact_closed_live_manifests(
                manifest_root=root / "history-manifests" / "live",
                before_day="2026-08-22",
                apply=True,
                data_root=root,
            )
            self.assertEqual(compacted["compacted"], 1)


class EnqueueLogRetentionTest(unittest.TestCase):
    def test_maintenance_bounds_active_logs_and_reports_rotations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_dir = Path(directory) / "enqueue-triggers"
            log_dir.mkdir()
            active = log_dir / "alpha.log"
            active.write_bytes(b"oversized watcher output\n")

            result = maintain_enqueue_trigger_logs(
                log_dir=log_dir,
                max_bytes=8,
                compact_after_seconds=3600,
                retention_days=14,
                now_epoch=10_000,
            )

            self.assertEqual(len(result["rotated"]), 1)
            self.assertEqual(active.read_bytes(), b"")
            self.assertTrue(Path(result["rotated"][0]["rotated_path"]).is_file())

    def test_active_log_is_archived_and_truncated_in_place(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log_path = root / "enqueue-triggers" / "alpha.log"
            log_path.parent.mkdir()
            original = b"0123456789abcdef\n"
            log_path.write_bytes(original)
            inode = log_path.stat().st_ino

            with log_path.open("ab") as watcher_output:
                rotation = rotate_enqueue_log_in_place(
                    log_path,
                    max_bytes=8,
                    created_at="2026-08-24T01:02:03+00:00",
                )

                self.assertEqual(rotation["status"], "rotated")
                self.assertEqual(log_path.stat().st_ino, inode)
                self.assertEqual(log_path.read_bytes(), b"")
                archived = Path(rotation["rotated_path"])
                self.assertEqual(archived.read_bytes(), original)

                watcher_output.write(b"watcher continued\n")
                watcher_output.flush()
            self.assertEqual(log_path.read_bytes(), b"watcher continued\n")

    def test_active_log_rotates_at_cap_and_closed_segment_compacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log_path = root / "enqueue-triggers" / "alpha.log"
            log_path.parent.mkdir()
            original = b"0123456789abcdef\n"
            log_path.write_bytes(original)

            rotation = prepare_enqueue_log(
                log_path,
                max_bytes=8,
                created_at="2026-08-24T01:02:03+00:00",
            )

            self.assertEqual(rotation["status"], "rotated")
            rotated = Path(rotation["rotated_path"])
            self.assertEqual(rotated.read_bytes(), original)
            self.assertFalse(log_path.exists())
            os.utime(rotated, (1, 1))

            result = compact_rotated_enqueue_logs(
                log_dir=log_path.parent,
                compact_before_epoch=2,
                retention_before_epoch=0,
                max_segments_per_session=8,
                minimum_keep=2,
                apply=True,
            )

            self.assertEqual(result["compacted"], 1)
            self.assertEqual(result["deleted"], 0)
            self.assertFalse(rotated.exists())
            import gzip

            compressed = Path(str(rotated) + ".gz")
            self.assertEqual(gzip.decompress(compressed.read_bytes()), original)

    def test_inherited_writer_lease_blocks_compaction_until_child_exits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "alpha.log"
            log_path.write_bytes(b"0123456789abcdef\n")
            environment = {
                "HEARTBEAT_STORAGE_RETENTION_APPLY": "1",
                "HEARTBEAT_ENQUEUE_LOG_MAX_BYTES": "8",
                "HEARTBEAT_ENQUEUE_LOG_COMPACT_AFTER_SECONDS": "3600",
            }
            with unittest.mock.patch.dict(os.environ, environment, clear=False):
                output, lease, rotation = open_enqueue_log_for_child(log_path)
            rotated = Path(rotation["rotated_path"])
            os.utime(rotated, (1, 1))
            child = subprocess.Popen(
                [str(VENV_PYTHON), "-c", "import time; time.sleep(0.5)"],
                pass_fds=(lease.fileno(),),
            )
            output.close()
            lease.close()
            try:
                blocked = compact_rotated_enqueue_logs(
                    log_dir=log_path.parent,
                    compact_before_epoch=2,
                    retention_before_epoch=0,
                    max_segments_per_session=8,
                    minimum_keep=2,
                    apply=True,
                )
                self.assertEqual(blocked["compacted"], 0)
                self.assertTrue(rotated.is_file())
            finally:
                child.wait(timeout=2)
            compacted = compact_rotated_enqueue_logs(
                log_dir=log_path.parent,
                compact_before_epoch=2,
                retention_before_epoch=0,
                max_segments_per_session=8,
                minimum_keep=2,
                apply=True,
            )
            self.assertEqual(compacted["compacted"], 1)

    def test_closed_segment_count_is_bounded_but_minimum_generations_survive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            log_dir = Path(directory)
            for index in range(5):
                path = log_dir / f"alpha.20260824T00000{index}.{'a' * 16}.log.gz"
                path.write_bytes(b"compressed-placeholder")
                Path(str(path) + ".segment.json").write_text("{}\n")
                os.utime(path, (index + 1, index + 1))

            result = compact_rotated_enqueue_logs(
                log_dir=log_dir,
                compact_before_epoch=0,
                retention_before_epoch=0,
                max_segments_per_session=2,
                minimum_keep=2,
                apply=True,
            )

            self.assertEqual(result["deleted"], 3)
            remaining = sorted(log_dir.glob("*.log.gz"))
            self.assertEqual(len(remaining), 2)
            self.assertTrue(all(Path(str(path) + ".segment.json").is_file() for path in remaining))


class TriggerHistoryTest(unittest.TestCase):
    def test_only_associated_json_is_pointerized_and_other_lines_remain_raw(self) -> None:
        associated = b'{"patrol_id":"patrol-one","status":"completed"}\n'
        unassociated = b'{"status":"drained","fired":1}\n'
        stderr = b"controller timeout: raw stderr must survive\n"
        original = associated + unassociated + stderr

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log_path = root / "enqueue-triggers" / "alpha.log"
            log_path.parent.mkdir()
            log_path.write_bytes(original)
            pack = CanonicalPackWriter(
                archive_path=root / "canonical" / "trigger" / "segments" / "segment-test.jsonl",
                schema_version="heartbeat.trigger-canonical/v1",
                created_at="2026-08-20T02:00:00+00:00",
            )

            entries = list(
                index_trigger_log(
                    log_path=log_path,
                    valid_patrol_ids={"patrol-one"},
                    pack=pack,
                    created_at="2026-08-20T02:00:00+00:00",
                )
            )
            segment = pack.close()

            self.assertEqual([entry["disposition"] for entry in entries], [
                "pointerized",
                "retained_raw_unassociated",
                "retained_raw_non_json",
            ])
            pointer = entries[0]
            self.assertEqual(pointer["patrol_id"], "patrol-one")
            self.assertEqual(pointer["line_number"], 1)
            self.assertEqual(pointer["original_byte_offset"], 0)
            self.assertEqual(pointer["original_byte_length"], len(associated))
            self.assertEqual(pointer["log_sha256"], hashlib.sha256(original).hexdigest())
            for field in (
                "canonical_object_id",
                "content_sha256",
                "archive_path",
                "byte_offset",
                "byte_length",
                "schema_version",
                "created_at",
            ):
                self.assertIn(field, pointer)
            with Path(pointer["archive_path"]).open("rb") as source:
                source.seek(pointer["byte_offset"])
                self.assertEqual(source.read(pointer["byte_length"]), associated)
            self.assertEqual(segment["sha256"], hashlib.sha256(Path(segment["archive_path"]).read_bytes()).hexdigest())
            self.assertEqual(log_path.read_bytes(), original)

    def test_new_associated_trigger_output_becomes_a_verifiable_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HeartbeatState(root / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            payload = {"ok": True, "patrol_id": patrol_id, "status": "completed"}

            pointer = pointerize_trigger_payload(
                payload=payload,
                state_db_path=state.path,
                canonical_dir=root / "canonical",
                original_log_path=root / "enqueue-triggers" / "alpha.log",
                created_at="2026-08-20T02:00:00+00:00",
            )

            self.assertEqual(pointer["schema"], "heartbeat.trigger-pointer/v1")
            self.assertEqual(pointer["patrol_id"], patrol_id)
            archive_path = Path(pointer["archive_path"])
            with archive_path.open("rb") as source:
                source.seek(pointer["byte_offset"])
                archived = source.read(pointer["byte_length"])
            expected = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode()
            self.assertEqual(archived, expected)
            self.assertEqual(hashlib.sha256(archived).hexdigest(), pointer["content_sha256"])


class DryRunMigrationTest(unittest.TestCase):
    def test_dry_run_exports_state_writes_every_manifest_and_reconstructs_sixty_samples(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HeartbeatState(root / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            state.log_event(
                event_type="todo_injected",
                status="sent",
                patrol_id=patrol_id,
                target_session="alpha",
            )
            state.finish_patrol(
                patrol_id,
                sessions_scanned=1,
                items_detected=1,
                alerts_sent=0,
                spawns_started=0,
                spawns_skipped_duplicate=0,
                errors=[],
            )
            completion_dir = root / "completion"
            completion_dir.mkdir()
            for index in range(60):
                receipt = {
                    "status": "completed",
                    "run": {
                        "completion_id": f"attempt-{index:03d}",
                        "patrol_id": patrol_id,
                        "started_at": f"2026-08-20T01:{index:02d}:00+00:00",
                        "finished_at": f"2026-08-20T01:{index:02d}:01+00:00",
                    },
                    "todos": {"live": index, "terminal": 9, "over_sla_landing": 0},
                    "unrecovered": {"targets": 0, "failures": 0, "active": []},
                    "escalation_handoffs": {"recent": []},
                }
                (completion_dir / f"attempt-{index:03d}.json").write_text(
                    json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
                )
            trigger_dir = root / "enqueue-triggers"
            trigger_dir.mkdir()
            (trigger_dir / "alpha.log").write_bytes(
                (json.dumps({"patrol_id": patrol_id, "status": "completed"}) + "\n").encode()
                + b'{"status":"drained"}\n'
                + b"raw stderr\n"
            )

            report = run_dry_run_migration(
                state_db_path=state.path,
                completion_dir=completion_dir,
                trigger_dir=trigger_dir,
                canonical_dir=root / "canonical",
                manifest_dir=root / "manifests",
                samples_path=root / "samples.json",
                report_path=root / "report.json",
                created_at="2026-08-20T02:00:00+00:00",
            )

            self.assertTrue(report["ttl_safe_export"])
            self.assertEqual(report["completion"]["files_scanned"], 60)
            self.assertEqual(report["completion"]["manifests_written"], 60)
            self.assertEqual(report["completion"]["reconstruction_sample_total"], 60)
            self.assertEqual(report["completion"]["reconstruction_hash_matches"], 60)
            self.assertEqual(report["trigger"]["pointerized"], 1)
            self.assertEqual(report["trigger"]["retained_raw_unassociated"], 1)
            self.assertEqual(report["trigger"]["retained_raw_non_json"], 1)
            self.assertEqual(report["production_files_deleted"], 0)
            verification = verify_dry_run_artifacts(manifest_dir=root / "manifests")
            self.assertTrue(verification["approved"])
            self.assertEqual(verification["completion_canonical_exact"], 60)
            self.assertEqual(verification["trigger_sample_passed"], 3)


WORKSPACE = Path(__file__).resolve().parents[1]
VENV_PYTHON = WORKSPACE / ".venv" / "bin" / "python"


class EmitTriggerResultTest(unittest.TestCase):
    def _emit(self, payload: dict[str, object], environment: dict[str, str]) -> tuple[str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with unittest.mock.patch.dict(os.environ, environment, clear=False):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                emit_trigger_result(payload)
        return stdout.getvalue(), stderr.getvalue()

    def test_pointerize_failure_keeps_exactly_one_raw_audit_line_and_reports_reason(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HeartbeatState(root / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            payload = {"ok": True, "patrol_id": patrol_id, "status": "completed"}
            # Fault injection: the canonical root is a regular file, so archiving raises OSError.
            blocked_canonical = root / "canonical-is-a-file"
            blocked_canonical.write_text("not a directory")

            stdout, stderr = self._emit(
                payload,
                {
                    "HEARTBEAT_TRIGGER_POINTER_MODE": "1",
                    "HEARTBEAT_STATE_DB": str(state.path),
                    "HEARTBEAT_HISTORY_CANONICAL_DIR": str(blocked_canonical),
                    "HEARTBEAT_TRIGGER_ORIGINAL_LOG_PATH": str(root / "enqueue-triggers" / "alpha.log"),
                },
            )

            self.assertEqual(len(stdout.splitlines()), 1)
            emitted = json.loads(stdout)
            self.assertEqual(emitted, payload)
            self.assertNotIn("canonical_object_id", emitted)
            self.assertNotIn("archive_path", emitted)

            self.assertEqual(len(stderr.splitlines()), 1)
            degraded = json.loads(stderr)
            self.assertEqual(degraded["schema"], "heartbeat.trigger-pointer-degraded/v1")
            self.assertEqual(degraded["event"], "trigger_pointerize_failed")
            self.assertEqual(degraded["disposition"], "retained_raw_pointerize_failed")
            self.assertEqual(degraded["patrol_id"], patrol_id)
            self.assertEqual(degraded["source_log_path"], str(root / "enqueue-triggers" / "alpha.log"))
            self.assertTrue(degraded["error_type"])
            self.assertTrue(degraded["error"])
            self.assertTrue(degraded["created_at"])

    def test_unexpected_pointerize_error_is_also_degraded_not_raised(self) -> None:
        payload = {"ok": True, "patrol_id": "patrol-unexpected", "status": "completed"}
        with unittest.mock.patch(
            "heartbeat_patrol.history.pointerize_trigger_payload",
            side_effect=RuntimeError("immutable canonical object collision"),
        ):
            stdout, stderr = self._emit(payload, {"HEARTBEAT_TRIGGER_POINTER_MODE": "1"})

        self.assertEqual(json.loads(stdout), payload)
        self.assertEqual(len(stdout.splitlines()), 1)
        degraded = json.loads(stderr)
        self.assertEqual(degraded["error_type"], "RuntimeError")
        self.assertEqual(degraded["error"], "immutable canonical object collision")

    def test_pointerize_failure_does_not_crash_the_patrol_process(self) -> None:
        self.assertTrue(VENV_PYTHON.exists(), f"project venv interpreter missing: {VENV_PYTHON}")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HeartbeatState(root / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            blocked_canonical = root / "canonical-is-a-file"
            blocked_canonical.write_text("not a directory")
            program = (
                "import json, sys;"
                "sys.path.insert(0, %r);" % str(WORKSPACE)
                + "from heartbeat_patrol.history import emit_trigger_result;"
                "emit_trigger_result(json.loads(sys.argv[1]));"
                "print('patrol-continued', file=sys.stderr)"
            )
            payload = {"ok": True, "patrol_id": patrol_id, "status": "completed"}
            process = subprocess.run(
                [str(VENV_PYTHON), "-c", program, json.dumps(payload)],
                capture_output=True,
                text=True,
                env={
                    **os.environ,
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "HEARTBEAT_TRIGGER_POINTER_MODE": "1",
                    "HEARTBEAT_STATE_DB": str(state.path),
                    "HEARTBEAT_HISTORY_CANONICAL_DIR": str(blocked_canonical),
                    "HEARTBEAT_TRIGGER_ORIGINAL_LOG_PATH": str(root / "enqueue-triggers" / "alpha.log"),
                },
            )

            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(len(process.stdout.splitlines()), 1)
            self.assertEqual(json.loads(process.stdout), payload)
            self.assertIn("patrol-continued", process.stderr)
            self.assertIn("heartbeat.trigger-pointer-degraded/v1", process.stderr)

    def test_successful_pointer_mode_output_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = HeartbeatState(root / "heartbeat.sqlite")
            patrol_id = state.start_patrol("MiniMax-M2.7")
            payload = {"ok": True, "patrol_id": patrol_id, "status": "completed"}

            stdout, stderr = self._emit(
                payload,
                {
                    "HEARTBEAT_TRIGGER_POINTER_MODE": "1",
                    "HEARTBEAT_STATE_DB": str(state.path),
                    "HEARTBEAT_HISTORY_CANONICAL_DIR": str(root / "canonical"),
                    "HEARTBEAT_TRIGGER_ORIGINAL_LOG_PATH": str(root / "enqueue-triggers" / "alpha.log"),
                },
            )

            self.assertEqual(stderr, "")
            self.assertEqual(len(stdout.splitlines()), 1)
            pointer = json.loads(stdout)
            self.assertEqual(pointer["schema"], "heartbeat.trigger-pointer/v1")
            self.assertEqual(pointer["patrol_id"], patrol_id)
            archived = Path(pointer["archive_path"]).read_bytes()
            expected = (json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n").encode()
            self.assertEqual(archived, expected)
            self.assertEqual(hashlib.sha256(archived).hexdigest(), pointer["content_sha256"])

    def test_pointer_mode_disabled_emits_the_raw_payload_once(self) -> None:
        payload = {"ok": True, "patrol_id": "patrol-plain", "status": "completed"}
        stdout, stderr = self._emit(payload, {"HEARTBEAT_TRIGGER_POINTER_MODE": "0"})

        self.assertEqual(stderr, "")
        self.assertEqual(len(stdout.splitlines()), 1)
        self.assertEqual(json.loads(stdout), payload)


if __name__ == "__main__":
    unittest.main()
