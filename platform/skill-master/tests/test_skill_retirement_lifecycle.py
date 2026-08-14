import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative_path: str):
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def retirement_entry(**overrides):
    entry = {
        "retirement_id": "ret_test_skill",
        "name": "test-skill",
        "owner": "skill-master",
        "state": "tombstone",
        "retired_at": "2026-07-01T00:00:00Z",
        "grace_days": 30,
        "owner_acknowledged": True,
        "replacement": "route to the owner session",
        "primary_tombstone_path": "/tmp/test-skill/SKILL.md",
        "secondary_marker_paths": [],
        "discovery_links": [],
        "recovery": {"status": "git", "repo": "/tmp/repo", "commit": "abc", "path": "SKILL.md"},
        "active_same_name": False,
    }
    entry.update(overrides)
    return entry


def test_hit_resets_rolling_thirty_day_quiet_period():
    lifecycle = load_module("skill_retirement_quiet", "scripts/skill_retirement.py")
    entry = lifecycle.parse_entry(retirement_entry())
    hits = [{"retirement_id": entry.retirement_id, "at": "2026-07-29T00:00:00Z"}]

    decision = lifecycle.evaluate_entry(
        entry,
        hits,
        [],
        lifecycle.parse_time("2026-08-15T00:00:00Z"),
    )

    assert decision["quiet_since"] == "2026-07-29T00:00:00Z"
    assert decision["purge_after"] == "2026-08-28T00:00:00Z"
    assert "quiet_period_not_elapsed" in decision["blockers"]
    assert decision["purge_ready"] is False


def test_unresolved_restore_request_blocks_purge():
    lifecycle = load_module("skill_retirement_request", "scripts/skill_retirement.py")
    entry = lifecycle.parse_entry(retirement_entry(retired_at="2026-06-01T00:00:00Z"))
    requests = [
        {
            "retirement_id": entry.retirement_id,
            "request_id": "req-1",
            "event": "requested",
            "at": "2026-06-15T00:00:00Z",
        }
    ]

    decision = lifecycle.evaluate_entry(
        entry,
        [],
        requests,
        lifecycle.parse_time("2026-08-01T00:00:00Z"),
    )

    assert "unresolved_restore_request" in decision["blockers"]
    assert decision["purge_ready"] is False


def test_resolved_restore_request_allows_later_purge():
    lifecycle = load_module("skill_retirement_resolved", "scripts/skill_retirement.py")
    entry = lifecycle.parse_entry(retirement_entry(retired_at="2026-06-01T00:00:00Z"))
    requests = [
        {
            "retirement_id": entry.retirement_id,
            "request_id": "req-1",
            "event": "requested",
            "at": "2026-06-15T00:00:00Z",
        },
        {
            "retirement_id": entry.retirement_id,
            "request_id": "req-1",
            "event": "resolved",
            "at": "2026-06-16T00:00:00Z",
        },
    ]

    decision = lifecycle.evaluate_entry(
        entry,
        [],
        requests,
        lifecycle.parse_time("2026-08-01T00:00:00Z"),
    )

    assert decision["quiet_since"] == "2026-06-16T00:00:00Z"
    assert decision["purge_ready"] is True
    assert decision["blockers"] == []


def test_malformed_ledger_fails_closed(tmp_path):
    lifecycle = load_module("skill_retirement_malformed", "scripts/skill_retirement.py")
    ledger = tmp_path / "hits.jsonl"
    ledger.write_text("not-json\n", encoding="utf-8")

    with pytest.raises(lifecycle.LedgerError):
        lifecycle.load_jsonl(ledger)


def test_registry_rejects_non_thirty_day_grace(tmp_path):
    lifecycle = load_module("skill_retirement_registry", "scripts/skill_retirement.py")
    registry = tmp_path / "registry.json"
    registry.write_text(
        json.dumps({"schema_version": 2, "retirements": [retirement_entry(grace_days=14)]}),
        encoding="utf-8",
    )

    with pytest.raises(lifecycle.RegistryError, match="grace_days"):
        lifecycle.load_registry(registry)


def test_tombstone_contains_rigid_report_route_stop_contract(tmp_path):
    lifecycle = load_module("skill_retirement_render", "scripts/skill_retirement.py")
    entry = lifecycle.parse_entry(
        retirement_entry(
            name="first-principle",
            primary_tombstone_path=str(tmp_path / "first-principle" / "SKILL.md"),
            replacement="Use spawn2.0 target=first-principle.",
        )
    )

    text = lifecycle.render_tombstone(entry)

    assert "name: first-principle" in text
    assert "skill-master-retirement: ret_test_skill" in text
    assert "report-retired-skill-hit.py" in text
    assert "Use spawn2.0 target=first-principle." in text
    assert "Do not execute, reconstruct, or copy" in text
    assert "/workspaces/first-principle/requests/" not in text


def test_active_duplicate_gets_marker_but_no_skill_file(tmp_path):
    lifecycle = load_module("skill_retirement_duplicate", "scripts/skill_retirement.py")
    marker = tmp_path / "smallmodel-manager" / "RETIRED.md"
    entry = lifecycle.parse_entry(
        retirement_entry(
            name="smallmodel-manager",
            active_same_name=True,
            primary_tombstone_path=None,
            secondary_marker_paths=[str(marker)],
        )
    )

    result = lifecycle.deploy_entry(entry, apply=True)

    assert marker.is_file()
    assert not (marker.parent / "SKILL.md").exists()
    assert result["primary_written"] is False
    assert result["status"] == "deployed"


def test_deploy_creates_only_registered_tombstone_marker_and_link(tmp_path):
    lifecycle = load_module("skill_retirement_deploy", "scripts/skill_retirement.py")
    primary = tmp_path / "canonical" / "retired" / "SKILL.md"
    marker = tmp_path / "legacy" / "RETIRED.md"
    link = tmp_path / "discovery" / "retired"
    entry = lifecycle.parse_entry(
        retirement_entry(
            primary_tombstone_path=str(primary),
            secondary_marker_paths=[str(marker)],
            discovery_links=[{"path": str(link), "target": str(primary.parent)}],
        )
    )

    dry_run = lifecycle.deploy_entry(entry, apply=False)
    assert dry_run["status"] == "dry_run"
    assert not primary.exists()

    result = lifecycle.deploy_entry(entry, apply=True)

    assert primary.is_file()
    assert marker.is_file()
    assert link.is_symlink()
    assert link.resolve() == primary.parent.resolve()
    assert result["hashes"][str(primary)] == lifecycle.sha256_file(primary)
    assert result["hashes"][str(marker)] == lifecycle.sha256_file(marker)


def test_deploy_preserves_conflicting_existing_path(tmp_path):
    lifecycle = load_module("skill_retirement_conflict", "scripts/skill_retirement.py")
    primary = tmp_path / "retired" / "SKILL.md"
    primary.parent.mkdir(parents=True)
    primary.write_text("human restored content\n", encoding="utf-8")
    entry = lifecycle.parse_entry(retirement_entry(primary_tombstone_path=str(primary)))

    result = lifecycle.deploy_entry(entry, apply=True)

    assert result["status"] == "blocked"
    assert result["blockers"] == ["deployment_path_conflict"]
    assert primary.read_text(encoding="utf-8") == "human restored content\n"


def test_hit_report_is_appended_before_notification(tmp_path, monkeypatch):
    reporter = load_module("retired_skill_reporter", "scripts/report-retired-skill-hit.py")
    ledger = tmp_path / "hits.jsonl"
    calls = []
    monkeypatch.setattr(reporter, "notify_skill_master", lambda event: calls.append(event) or {"ok": True})

    event = reporter.report_hit(
        retirement_id="ret_first",
        skill="first-principle",
        session="caller-session",
        reason="Principle update requested",
        ledger_path=ledger,
        notify=True,
    )

    written = json.loads(ledger.read_text(encoding="utf-8").splitlines()[0])
    assert written["event_id"] == event["event_id"]
    assert calls[0]["event_id"] == event["event_id"]
    assert event["notification"]["ok"] is True


def deployed_entry(tmp_path, **overrides):
    lifecycle = load_module(f"skill_retirement_fixture_{len(sys.modules)}", "scripts/skill_retirement.py")
    primary = tmp_path / "canonical" / "retired" / "SKILL.md"
    marker = tmp_path / "legacy" / "RETIRED.md"
    link = tmp_path / "discovery" / "retired"
    raw = retirement_entry(
        retired_at="2026-01-01T00:00:00Z",
        primary_tombstone_path=str(primary),
        secondary_marker_paths=[str(marker)],
        discovery_links=[{"path": str(link), "target": str(primary.parent)}],
        **overrides,
    )
    entry = lifecycle.parse_entry(raw)
    expected = lifecycle.expected_hashes(entry)
    entry = replace(entry, expected_sha256=expected)
    result = lifecycle.deploy_entry(entry, apply=True)
    assert result["status"] == "deployed"
    return lifecycle, entry


def test_changed_tombstone_is_preserved(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path)
    entry.primary_tombstone_path.write_text("manual restore\n", encoding="utf-8")

    result = lifecycle.purge_entry(
        entry,
        hits=[],
        requests=[],
        now=lifecycle.parse_time("2026-03-01T00:00:00Z"),
        apply=True,
    )

    assert entry.primary_tombstone_path.exists()
    assert "retirement_content_changed" in result["blockers"]
    assert result["removed"] == []


def test_mismatched_symlink_is_preserved(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path)
    link = Path(entry.discovery_links[0]["path"])
    link.unlink()
    link.symlink_to(tmp_path / "someone-elses-skill")

    result = lifecycle.purge_entry(
        entry,
        hits=[],
        requests=[],
        now=lifecycle.parse_time("2026-03-01T00:00:00Z"),
        apply=True,
    )

    assert link.is_symlink()
    assert "retirement_link_changed" in result["blockers"]
    assert result["removed"] == []


def test_eligible_purge_removes_only_registered_paths(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path)
    unrelated = tmp_path / "unrelated.txt"
    unrelated.write_text("keep\n", encoding="utf-8")

    result = lifecycle.purge_entry(
        entry,
        hits=[],
        requests=[],
        now=lifecycle.parse_time("2026-03-01T00:00:00Z"),
        apply=True,
    )

    assert result["status"] == "purged"
    assert unrelated.read_text(encoding="utf-8") == "keep\n"
    assert not entry.primary_tombstone_path.exists()
    assert not entry.secondary_marker_paths[0].exists()
    assert not Path(entry.discovery_links[0]["path"]).is_symlink()
    assert sorted(result["removed"]) == sorted(
        [
            str(entry.primary_tombstone_path),
            str(entry.secondary_marker_paths[0]),
            str(Path(entry.discovery_links[0]["path"])),
        ]
    )


def test_unresolved_request_prevents_any_purge_mutation(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path)
    requests = [
        {
            "retirement_id": entry.retirement_id,
            "request_id": "req-1",
            "event": "requested",
            "at": "2026-02-01T00:00:00Z",
        }
    ]

    result = lifecycle.purge_entry(
        entry,
        hits=[],
        requests=requests,
        now=lifecycle.parse_time("2026-04-01T00:00:00Z"),
        apply=True,
    )

    assert "unresolved_restore_request" in result["blockers"]
    assert entry.primary_tombstone_path.exists()
    assert result["removed"] == []


def test_purge_all_updates_registry_and_appends_event(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path)
    manager = load_module("skill_retirement_manager_purge", "scripts/manage-skill-retirements.py")
    registry = tmp_path / "registry.json"
    raw = retirement_entry(
        retired_at="2026-01-01T00:00:00Z",
        primary_tombstone_path=str(entry.primary_tombstone_path),
        secondary_marker_paths=[str(path) for path in entry.secondary_marker_paths],
        discovery_links=[dict(link) for link in entry.discovery_links],
        expected_sha256=entry.expected_sha256,
        allowed_source_skill_paths=[],
    )
    registry.write_text(
        json.dumps({"schema_version": 2, "retirements": [raw]}),
        encoding="utf-8",
    )
    hits = tmp_path / "hits.jsonl"
    requests = tmp_path / "requests.jsonl"
    events = tmp_path / "purge-events.jsonl"

    report = manager.purge_all(
        registry,
        hits,
        requests,
        events,
        apply=True,
        now=lifecycle.parse_time("2026-03-01T00:00:00Z"),
    )

    persisted = json.loads(registry.read_text(encoding="utf-8"))
    recorded = json.loads(events.read_text(encoding="utf-8").splitlines()[0])
    assert report["summary"]["purged"] == 1
    assert persisted["retirements"][0]["state"] == "purged"
    assert recorded["event"] == "purged"
    assert recorded["removed"] == report["entries"][0]["removed"]


def test_canonical_purge_removes_only_registered_tombstone_index_row(tmp_path):
    lifecycle, entry = deployed_entry(tmp_path, name="retired")
    manager = load_module("skill_retirement_manager_index", "scripts/manage-skill-retirements.py")
    registry = tmp_path / "registry.json"
    raw = retirement_entry(
        name="retired",
        retired_at="2026-01-01T00:00:00Z",
        primary_tombstone_path=str(entry.primary_tombstone_path),
        secondary_marker_paths=[str(path) for path in entry.secondary_marker_paths],
        discovery_links=[dict(link) for link in entry.discovery_links],
        expected_sha256=entry.expected_sha256,
    )
    registry.write_text(
        json.dumps({"schema_version": 2, "retirements": [raw]}),
        encoding="utf-8",
    )
    index = tmp_path / "INDEX.md"
    index.write_text(
        "| Name | Origin | Scope | Owner | Purpose |\n"
        "|---|---|---|---|---|\n"
        "| retired | skill-master | shared | owner | [RETIRED-TOMBSTONE until rolling quiet period completes] route |\n"
        "| active | skill-master | shared | owner | keep |\n",
        encoding="utf-8",
    )

    report = manager.purge_all(
        registry,
        tmp_path / "hits.jsonl",
        tmp_path / "requests.jsonl",
        tmp_path / "events.jsonl",
        apply=True,
        now=lifecycle.parse_time("2026-03-01T00:00:00Z"),
        index_path=index,
        canonical_dir=tmp_path / "canonical",
    )

    assert report["summary"]["purged"] == 1
    text = index.read_text(encoding="utf-8")
    assert "| retired |" not in text
    assert "| active |" in text
