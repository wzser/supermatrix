import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module():
    path = ROOT / "scripts" / "manage-inactive-skills.py"
    spec = importlib.util.spec_from_file_location("manage_inactive_skills", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_index(path: Path, rows: list[tuple[str, str, str, str, str]]) -> None:
    path.write_text(
        "| Name | Origin | Scope | Owner | Purpose |\n"
        "|---|---|---|---|---|\n"
        + "".join(f"| {name} | {origin} | {scope} | {owner} | {purpose} |\n" for name, origin, scope, owner, purpose in rows),
        encoding="utf-8",
    )


def write_skill(path: Path, name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def test_eligible_rows_exclude_builtins_inventory_and_tombstones(tmp_path):
    lifecycle = load_module()
    index = tmp_path / "INDEX.md"
    write_index(
        index,
        [
            ("active", "skill-master", "shared", "owner", "active"),
            ("hidden", "skill-master", "inventory-only", "owner", "hidden"),
            ("builtin", "codex-builtin", "codex-only", "codex", "builtin"),
            ("old", "skill-master", "shared", "owner", "[RETIRED-TOMBSTONE until quiet] old"),
        ],
    )

    assert list(lifecycle.eligible_rows(index)) == ["active"]


def test_instrumentation_is_idempotent_and_preserves_body(tmp_path):
    lifecycle = load_module()
    skill = tmp_path / "skill" / "SKILL.md"
    write_skill(skill, "sample")

    first = lifecycle.instrument_skill(skill, "sample", apply=True)
    second = lifecycle.instrument_skill(skill, "sample", apply=True)
    text = skill.read_text(encoding="utf-8")

    assert first["status"] == "instrumented"
    assert second["status"] == "present"
    assert text.count("record-tick.sh sample") == 1
    assert "# sample" in text


def test_first_enrollment_starts_a_fresh_fourteen_day_window(tmp_path):
    lifecycle = load_module()
    index = tmp_path / "INDEX.md"
    canonical = tmp_path / "skills"
    state = tmp_path / "state.json"
    write_index(index, [("sample", "skill-master", "shared", "owner", "active")])
    write_skill(canonical / "sample" / "SKILL.md", "sample")

    result = lifecycle.weekly_run(
        index_path=index,
        canonical_dir=canonical,
        call_log=tmp_path / "calls.jsonl",
        state_path=state,
        events_path=tmp_path / "events.jsonl",
        report_dir=tmp_path / "reports",
        now=lifecycle.parse_time("2026-08-04T00:00:00Z"),
        roots=tuple(tmp_path / name for name in ("claude", "agents", "kimi", "kimi-code")),
        apply=True,
    )

    decision = result["decisions"][0]
    assert result["summary"]["instrumented_now"] == 1
    assert decision["retire_after"] == "2026-08-18T00:00:00Z"
    assert decision["eligible"] is False
    assert lifecycle.parse_index(index)[1]["sample"].scope == "shared"


def test_recent_call_resets_inactivity_window(tmp_path):
    lifecycle = load_module()
    decision = lifecycle.evaluate_inactivity(
        name="sample",
        record={"status": "active", "coverage_started_at": "2026-08-01T00:00:00Z"},
        last_call=lifecycle.parse_time("2026-08-10T00:00:00Z"),
        now=lifecycle.parse_time("2026-08-20T00:00:00Z"),
        inactive_days=14,
    )

    assert decision["retire_after"] == "2026-08-24T00:00:00Z"
    assert decision["eligible"] is False


def test_due_skill_becomes_inventory_only_and_source_is_preserved(tmp_path):
    lifecycle = load_module()
    index = tmp_path / "INDEX.md"
    canonical = tmp_path / "skills"
    state = tmp_path / "state.json"
    events = tmp_path / "events.jsonl"
    roots = tuple(tmp_path / name for name in ("claude", "agents", "kimi", "kimi-code"))
    write_index(index, [("sample", "skill-master", "shared", "owner", "active purpose")])
    write_skill(canonical / "sample" / "SKILL.md", "sample")
    lifecycle.instrument_skill(canonical / "sample" / "SKILL.md", "sample", apply=True)
    state.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "inactive_days": 14,
                "skills": {
                    "sample": {
                        "status": "active",
                        "coverage_started_at": "2026-08-01T00:00:00Z",
                        "enrolled_at": "2026-08-01T00:00:00Z",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    for root in roots:
        root.mkdir()
        (root / "sample").symlink_to(canonical / "sample", target_is_directory=True)

    result = lifecycle.weekly_run(
        index_path=index,
        canonical_dir=canonical,
        call_log=tmp_path / "calls.jsonl",
        state_path=state,
        events_path=events,
        report_dir=tmp_path / "reports",
        now=lifecycle.parse_time("2026-08-16T00:00:00Z"),
        roots=roots,
        apply=True,
    )

    row = lifecycle.parse_index(index)[1]["sample"]
    assert result["summary"]["retired"] == 1
    assert row.scope == "inventory-only"
    assert row.purpose.startswith("[RETIRED-INACTIVE 14D")
    assert (canonical / "sample" / "SKILL.md").is_file()
    assert all(not (root / "sample").exists() for root in roots)
    assert json.loads(events.read_text(encoding="utf-8"))["event"] == "retired_inactive"


def test_conflicting_discovery_path_blocks_retirement(tmp_path):
    lifecycle = load_module()
    index = tmp_path / "INDEX.md"
    canonical = tmp_path / "skills"
    conflict_root = tmp_path / "claude"
    write_index(index, [("sample", "skill-master", "shared", "owner", "active")])
    write_skill(canonical / "sample" / "SKILL.md", "sample")
    conflict_root.mkdir()
    (conflict_root / "sample").mkdir()
    state = {
        "skills": {
            "sample": {
                "status": "active",
                "coverage_started_at": "2026-08-01T00:00:00Z",
            }
        }
    }

    result = lifecycle.retire_one(
        name="sample",
        index_path=index,
        canonical_dir=canonical,
        state=state,
        now=lifecycle.parse_time("2026-08-16T00:00:00Z"),
        inactivity={"name": "sample", "coverage_started_at": "2026-08-01T00:00:00Z", "eligible": True},
        roots=(conflict_root,),
        events_path=tmp_path / "events.jsonl",
        apply=True,
    )

    assert result["status"] == "blocked"
    assert result["blockers"] == ["discovery_path_conflict"]
    assert lifecycle.parse_index(index)[1]["sample"].scope == "shared"


def test_restore_reenables_scope_and_resets_observation_window(tmp_path):
    lifecycle = load_module()
    index = tmp_path / "INDEX.md"
    canonical = tmp_path / "skills"
    state = tmp_path / "state.json"
    events = tmp_path / "events.jsonl"
    roots = tuple(tmp_path / name for name in ("claude", "agents", "kimi", "kimi-code"))
    write_index(
        index,
        [("sample", "skill-master", "inventory-only", "owner", "[RETIRED-INACTIVE 14D at=x; previous-scope=shared] active")],
    )
    write_skill(canonical / "sample" / "SKILL.md", "sample")
    state.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "inactive_days": 14,
                "skills": {
                    "sample": {
                        "status": "retired_inactive",
                        "coverage_started_at": "2026-08-01T00:00:00Z",
                        "previous_scope": "shared",
                        "previous_purpose": "active",
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    result = lifecycle.restore_one(
        name="sample",
        index_path=index,
        canonical_dir=canonical,
        state_path=state,
        events_path=events,
        now=lifecycle.parse_time("2026-08-20T00:00:00Z"),
        roots=roots,
        apply=True,
    )

    row = lifecycle.parse_index(index)[1]["sample"]
    persisted = json.loads(state.read_text(encoding="utf-8"))
    assert result["status"] == "restored"
    assert row.scope == "shared"
    assert row.purpose == "active"
    assert persisted["skills"]["sample"]["coverage_started_at"] == "2026-08-20T00:00:00Z"
    assert all((root / "sample").is_symlink() for root in roots)


def test_sync_hides_only_managed_inventory_links(tmp_path):
    canonical = tmp_path / "canonical"
    skill = canonical / "sample"
    write_skill(skill / "SKILL.md", "sample")
    write_index(
        canonical / "INDEX.md",
        [("sample", "skill-master", "inventory-only", "owner", "retired")],
    )
    home = tmp_path / "home"
    kimi_code = tmp_path / "kimi-code"
    managed_paths = [
        home / ".claude" / "skills" / "sample",
        home / ".agents" / "skills" / "sample",
        home / ".kimi" / "skills" / "sample",
        kimi_code / "skills" / "sample",
    ]
    for path in managed_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(skill, target_is_directory=True)
    conflict = home / ".agents" / "skills" / "sample"
    conflict.unlink()
    conflict.symlink_to(tmp_path / "someone-else", target_is_directory=True)

    completed = subprocess.run(
        ["bash", str(ROOT / "scripts" / "sync-skills.sh")],
        cwd=ROOT,
        env={
            **os.environ,
            "HOME": str(home),
            "KIMI_CODE_HOME": str(kimi_code),
            "SKILL_MASTER_CANONICAL": str(canonical),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert not managed_paths[0].is_symlink()
    assert conflict.is_symlink()
    assert not managed_paths[2].is_symlink()
    assert not managed_paths[3].is_symlink()
