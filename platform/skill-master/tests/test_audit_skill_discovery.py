import importlib.util
import hashlib
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_auditor():
    script = ROOT / "scripts" / "audit-skill-discovery.py"
    spec = importlib.util.spec_from_file_location("audit_skill_discovery", script)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def write_skill(path: Path, name: str, body: str = "Current contract.") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n{body}\n",
        encoding="utf-8",
    )


def write_index(path: Path, rows: list[tuple[str, str, str]]) -> None:
    path.write_text(
        "| Name | Origin | Scope | Owner | Purpose |\n"
        "|---|---|---|---|---|\n"
        + "".join(
            f"| {name} | {origin} | {scope} | owner | purpose |\n"
            for name, origin, scope in rows
        ),
        encoding="utf-8",
    )


def test_audit_reports_retired_conflicts_broken_links_and_stale_contracts(tmp_path):
    auditor = load_auditor()
    canonical = tmp_path / "canonical"
    discovery = tmp_path / "discovery"
    inventory = tmp_path / "inventory"
    excluded = tmp_path / "archive"
    index = tmp_path / "INDEX.md"
    config = tmp_path / "audit.json"

    write_skill(canonical / "active" / "SKILL.md", "active")
    write_skill(discovery / "retired" / "SKILL.md", "retired")
    write_skill(discovery / "duplicate" / "SKILL.md", "duplicate", "first copy")
    write_skill(inventory / "duplicate" / "SKILL.md", "duplicate", "second copy")
    write_skill(inventory / "legacy" / "SKILL.md", "legacy", "POST /api/spawn")
    write_skill(excluded / "fixture" / "SKILL.md", "fixture", "POST /api/spawn")
    (discovery / "broken").symlink_to(tmp_path / "missing-target")
    write_index(
        index,
        [
            ("active", "skill-master", "shared"),
            ("missing", "skill-master", "shared"),
        ],
    )
    config.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "retired_names": {"retired": "use the owner session"},
                "inventory_globs": [str(inventory / "**" / "SKILL.md"), str(excluded / "**" / "SKILL.md")],
                "exclude_path_fragments": [str(excluded)],
                "stale_patterns": [
                    {"code": "legacy_spawn_api", "regex": r"/api/spawn(?!2\\.0)"}
                ],
            }
        ),
        encoding="utf-8",
    )

    report = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[discovery],
    )

    codes = {finding["code"] for finding in report["findings"]}
    assert report["ok"] is False
    assert "retired_skill_discoverable" in codes
    assert "duplicate_skill_name" in codes
    assert "broken_symlink" in codes
    assert "stale_contract_pattern" in codes
    assert "canonical_skill_missing" in codes
    assert not any(str(excluded) in finding.get("path", "") for finding in report["findings"])


def test_audit_accepts_three_discovery_links_to_one_canonical_skill(tmp_path):
    auditor = load_auditor()
    canonical = tmp_path / "canonical"
    index = tmp_path / "INDEX.md"
    config = tmp_path / "audit.json"
    target = canonical / "shared"
    write_skill(target / "SKILL.md", "shared")
    write_index(index, [("shared", "skill-master", "shared")])
    config.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "retired_names": {},
                "inventory_globs": [],
                "exclude_path_fragments": [],
                "stale_patterns": [],
            }
        ),
        encoding="utf-8",
    )

    discovery_roots = []
    for backend in ("claude", "agents", "kimi"):
        root = tmp_path / backend
        root.mkdir()
        (root / "shared").symlink_to(target, target_is_directory=True)
        discovery_roots.append(root)

    report = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=discovery_roots,
    )

    assert report["ok"] is True
    assert report["findings"] == []


def test_audit_accepts_registered_tombstone_and_rejects_changed_content(tmp_path):
    auditor = load_auditor()
    canonical = tmp_path / "canonical"
    discovery = tmp_path / "discovery"
    index = tmp_path / "INDEX.md"
    config = tmp_path / "audit.json"
    primary = canonical / "retired" / "SKILL.md"
    tombstone = (
        "---\nname: retired\ndescription: RETIRED — contact skill-master.\n---\n"
        "<!-- skill-master-retirement: ret_test -->\n\n# Retired\n"
    )
    primary.parent.mkdir(parents=True)
    primary.write_text(tombstone, encoding="utf-8")
    discovery.mkdir()
    (discovery / "retired").symlink_to(primary.parent, target_is_directory=True)
    write_index(index, [("retired", "skill-master", "shared")])
    config.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "inventory_globs": [],
                "exclude_path_fragments": [],
                "allowed_duplicate_names": [],
                "stale_patterns": [],
                "retirements": [
                    {
                        "retirement_id": "ret_test",
                        "name": "retired",
                        "owner": "skill-master",
                        "state": "tombstone",
                        "retired_at": "2026-07-14T00:00:00Z",
                        "grace_days": 30,
                        "owner_acknowledged": True,
                        "replacement": "route to owner",
                        "primary_tombstone_path": str(primary),
                        "secondary_marker_paths": [],
                        "discovery_links": [
                            {"path": str(discovery / "retired"), "target": str(primary.parent)}
                        ],
                        "expected_sha256": {
                            str(primary): hashlib.sha256(tombstone.encode("utf-8")).hexdigest()
                        },
                        "allowed_source_skill_paths": [],
                        "recovery": {"status": "git"},
                        "active_same_name": False,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    report = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[discovery],
    )
    assert report["ok"] is True

    primary.write_text(tombstone + "old executable logic\n", encoding="utf-8")
    changed = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[discovery],
    )
    assert any(finding["code"] == "retirement_content_changed" for finding in changed["findings"])


def test_audit_enforces_active_same_name_cleanup(tmp_path):
    auditor = load_auditor()
    canonical = tmp_path / "canonical"
    legacy = tmp_path / "legacy" / "amz-sql"
    active = canonical / "amz-sql" / "SKILL.md"
    marker = legacy / "RETIRED.md"
    index = tmp_path / "INDEX.md"
    config = tmp_path / "audit.json"

    write_skill(active, "amz-sql", "Route work to the amz-sql owner session.")
    marker.parent.mkdir(parents=True)
    marker.write_text("Legacy route retired.\n", encoding="utf-8")
    write_index(index, [("amz-sql", "skill-master", "codex-only")])
    config.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "inventory_globs": [str(legacy / "**" / "SKILL.md")],
                "exclude_path_fragments": [],
                "allowed_duplicate_names": [],
                "stale_patterns": [],
                "active_same_name_cleanups": [
                    {
                        "cleanup_id": "cleanup_test_amz_sql_owner_route",
                        "name": "amz-sql",
                        "removed_skill_path": str(legacy / "SKILL.md"),
                        "active_skill_path": str(active),
                        "marker_path": str(marker),
                        "recovery": "active canonical owner route",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    assert auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[],
    )["ok"] is True

    (legacy / "SKILL.md").write_text(
        "---\nname: amz-sql\ndescription: legacy route\n---\n",
        encoding="utf-8",
    )
    legacy_present = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[],
    )
    assert any(
        finding["code"] == "active_same_name_legacy_skill_present"
        for finding in legacy_present["findings"]
    )

    (legacy / "SKILL.md").unlink()
    marker.unlink()
    marker_missing = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[],
    )
    assert any(
        finding["code"] == "active_same_name_marker_missing"
        for finding in marker_missing["findings"]
    )

    marker.write_text("Legacy route retired.\n", encoding="utf-8")
    active.unlink()
    active_missing = auditor.run_audit(
        config_path=config,
        index_path=index,
        canonical_dir=canonical,
        discovery_roots=[],
    )
    assert any(
        finding["code"] == "active_same_name_active_skill_missing"
        for finding in active_missing["findings"]
    )
