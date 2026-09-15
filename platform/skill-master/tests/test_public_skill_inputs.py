from __future__ import annotations

import json
import hashlib
import importlib.util
import os
import re
import sys
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APPROVED = {"diagnose", "improve-codebase-architecture", "tdd"}
PUBLIC_INDEX = ROOT / "docs" / "onboarding-v1-skill-index.md"
PUBLIC_REGISTRY = ROOT / "docs" / "onboarding-v1-skill-registry.json"
PUBLIC_SOURCES = ROOT / "docs" / "onboarding-v1-skill-upgrade-sources.json"
PUBLIC_DEPS = ROOT / "docs" / "onboarding-v1-skill-dependencies.json"
ASSET_MANIFEST = ROOT / "docs" / "onboarding-v1-skill-assets.json"
SYNC = ROOT / "scripts" / "sync-skills.sh"


def parse_index(path: Path) -> list[dict[str, str]]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) == 5 and cells[0] not in {"Name", "---"} and not set(cells[0]) <= {"-"}:
            rows.append(dict(zip(("Name", "Origin", "Scope", "Owner", "Purpose"), cells)))
    return rows


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def manifest_sources(manifest: dict) -> set[str]:
    paths = {item["source"] for item in manifest["static_files"]}
    paths.update(item["source"] for skill in manifest["skills"] for item in skill["files"])
    return paths


def required_include_files(entries: list[str]) -> set[str]:
    paths: set[str] = set()
    for entry in entries:
        if entry.endswith("/**"):
            root = ROOT / entry[:-3]
            paths.update(str(path.relative_to(ROOT)) for path in root.rglob("*") if path.is_file())
        else:
            paths.add(entry)
    return paths


def test_public_index_and_mirror_contract_are_closed_to_three_skills() -> None:
    rows = parse_index(PUBLIC_INDEX)
    assert {row["Name"] for row in rows} == APPROVED
    assert len(rows) == len(APPROVED)
    assert all(row["Origin"] == "skill-master" and row["Scope"] == "shared" for row in rows)

    registry = json.loads(PUBLIC_REGISTRY.read_text(encoding="utf-8"))
    assert registry["enabled_skill_names"] == sorted(APPROVED)
    assert registry["unique_key"] == ["Name"]
    assert registry["mirror"]["conflict_policy"] == "local_wins"
    assert registry["mirror"]["terminal_acceptance"] == (
        "terminal=true AND queue_state=done AND read_back_verified=true"
    )
    assert set(registry["fields"]) == {
        "Name", "Origin", "Scope", "Owner", "Purpose", "Calls", "Updated",
        "AutoUpgrade", "UpgradePolicy", "GitHubRepo", "UpstreamPath", "UpgradeState",
        "RegistrySource", "HostedBy",
    }

    sources = json.loads(PUBLIC_SOURCES.read_text(encoding="utf-8"))
    mappings = sources["packages"][0]["mappings"]
    assert sources["packages"][0]["enabled"] is True
    assert {item["local"] for item in mappings} == APPROVED


def test_public_asset_manifest_lists_metadata_and_only_approved_skill_trees() -> None:
    manifest = json.loads(ASSET_MANIFEST.read_text(encoding="utf-8"))
    assert manifest["distribution"]["enabled_skill_names"] == sorted(APPROVED)
    assert set(manifest["distribution"]["required_include"]) == {
        "docs/onboarding-v1-skill-dependencies.json",
        "docs/onboarding-v1-skill-discovery.json",
        "docs/onboarding-v1-skill-index.md",
        "docs/onboarding-v1-public-example.md",
        "docs/onboarding-v1-skill-registry.json",
        "docs/onboarding-v1-skill-upgrade-sources.json",
        "scripts/audit-skill-discovery.py",
        "scripts/evaluate-skills.py",
        "scripts/feishu_enqueue.py",
        "scripts/sync-skills-to-feishu.py",
        "scripts/sync-skills.sh",
        "scripts/validate-skill-frontmatter.py",
        "scripts/record-tick.sh",
        "skills/diagnose/**",
        "skills/improve-codebase-architecture/**",
        "skills/tdd/**",
    }
    assert set(manifest["distribution"]["disabled_skill_trees"]) == {
        "skills/* (except the three enabled skill trees)"
    }
    assert len(manifest["skills"]) == len(APPROVED)
    assert {skill["name"] for skill in manifest["skills"]} == APPROVED
    assert manifest_sources(manifest) == required_include_files(manifest["distribution"]["required_include"])
    assert manifest["source"]["commit"] == re.fullmatch(r"[0-9a-f]{40}", manifest["source"]["commit"]).group(0)
    assert manifest["source"]["verification_scope"] == "private-source-acceptance-only"

    for skill in manifest["skills"]:
        assert skill["name"] in APPROVED
        actual = {
            str(path.relative_to(ROOT))
            for path in (ROOT / skill["source_directory"]).rglob("*")
            if path.is_file()
        }
        assert skill["file_count"] == len(skill["files"])
        assert {item["source"] for item in skill["files"]} == actual
        for item in skill["files"]:
            path = ROOT / item["source"]
            assert path.is_file()
            assert item["bytes"] == path.stat().st_size
            assert item["sha256"] == file_sha256(path)

    for item in manifest["static_files"]:
        path = ROOT / item["source"]
        assert path.is_file()
        assert item["bytes"] == path.stat().st_size
        assert item["sha256"] == file_sha256(path)


def test_public_inputs_have_no_machine_private_literals() -> None:
    paths = [
        ROOT / item["source"]
        for item in json.loads(ASSET_MANIFEST.read_text(encoding="utf-8"))["static_files"]
    ]
    paths += [PUBLIC_INDEX, PUBLIC_REGISTRY, PUBLIC_SOURCES, PUBLIC_DEPS]
    paths += list((ROOT / "skills" / "diagnose").rglob("*"))
    paths += list((ROOT / "skills" / "improve-codebase-architecture").rglob("*"))
    paths += list((ROOT / "skills" / "tdd").rglob("*"))
    text = "\n".join(path.read_text(encoding="utf-8") for path in paths if path.is_file())
    assert "/Users/" not in text
    assert "/Volumes/" not in text
    assert not re.search(r"\b(?:F9F9|NFRabn|tbl[A-Za-z0-9]+|fld[A-Za-z0-9]+)\b", text)


def test_sync_discovers_only_approved_skills_in_isolated_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    kimi_home = tmp_path / "kimi-code"
    preseeded = home / ".agents" / "skills"
    preseeded.mkdir(parents=True)
    os.symlink(ROOT / "skills" / "nas-sucai", preseeded / "nas-sucai")
    env = {
        **os.environ,
        "HOME": str(home),
        "KIMI_CODE_HOME": str(kimi_home),
        "SKILL_MASTER_CANONICAL": str(ROOT / "skills"),
        "SKILL_MASTER_INDEX": str(PUBLIC_INDEX),
        "SKILL_MASTER_PYTHON": sys.executable,
    }
    result = subprocess.run(["bash", str(SYNC)], env=env, text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr

    roots = [home / ".claude" / "skills", home / ".agents" / "skills", kimi_home / "skills", home / ".kimi" / "skills"]
    for root in roots:
        assert {entry.name for entry in root.iterdir()} == APPROVED
        for name in APPROVED:
            link = root / name
            assert link.is_symlink()
            assert link.resolve() == (ROOT / "skills" / name).resolve()
            assert f"name: {name}" in (link / "SKILL.md").read_text(encoding="utf-8")


def test_public_index_is_consumable_by_existing_registry_parser(monkeypatch) -> None:
    monkeypatch.setenv("SKILL_MASTER_INDEX", str(PUBLIC_INDEX))
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = importlib.util.spec_from_file_location("public_sync_skills_to_feishu", ROOT / "scripts" / "sync-skills-to-feishu.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    rows = module.parse_index()
    assert len(rows) == len(APPROVED)
    assert {row["Name"] for row in rows} == APPROVED


def test_public_index_is_consumable_by_existing_evaluator_owner_parser(monkeypatch) -> None:
    monkeypatch.setenv("SKILL_MASTER_INDEX", str(PUBLIC_INDEX))
    scripts_dir = str(ROOT / "scripts")
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    spec = importlib.util.spec_from_file_location(
        "public_evaluate_skills", ROOT / "scripts" / "evaluate-skills.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    assert module.load_index_owners() == {
        name: "upstream-maintainer" for name in sorted(APPROVED)
    }


def test_public_discovery_audit_treats_the_index_as_the_enablement_allowlist(tmp_path: Path) -> None:
    home = tmp_path / "home"
    kimi_home = tmp_path / "kimi-code"
    env = {
        **os.environ,
        "HOME": str(home),
        "KIMI_CODE_HOME": str(kimi_home),
    }
    subprocess.run(["bash", str(SYNC)], env={**env, "SKILL_MASTER_INDEX": str(PUBLIC_INDEX)}, check=True)
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "audit-skill-discovery.py"),
            "--config",
            str(ROOT / "docs" / "onboarding-v1-skill-discovery.json"),
            "--index",
            str(PUBLIC_INDEX),
            "--canonical",
            str(ROOT / "skills"),
            "--discovery-root",
            str(home / ".agents" / "skills"),
            "--json",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["ok"] is True

    external_skill = tmp_path / "external-skill"
    external_skill.mkdir()
    (external_skill / "SKILL.md").write_text(
        "---\nname: outside-public-index\ndescription: test\n---\n", encoding="utf-8"
    )
    os.symlink(external_skill, home / ".agents" / "skills" / "outside-public-index")
    rejected = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "audit-skill-discovery.py"),
            "--config",
            str(ROOT / "docs" / "onboarding-v1-skill-discovery.json"),
            "--index",
            str(PUBLIC_INDEX),
            "--canonical",
            str(ROOT / "skills"),
            "--discovery-root",
            str(home / ".agents" / "skills"),
            "--json",
        ],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert rejected.returncode != 0
    rejected_report = json.loads(rejected.stdout)
    assert any(item["code"] == "skill_not_in_allowlist" for item in rejected_report["findings"])


def test_dependency_manifest_is_explicit_and_secret_free() -> None:
    deps = json.loads(PUBLIC_DEPS.read_text(encoding="utf-8"))
    assert deps["runtime"]["python"]["version"] == "3.11.15"
    assert deps["runtime"]["python"]["requires"] == ">=3.11,<3.12"
    assert deps["runtime"]["python"]["third_party"] == []
    assert deps["tools"]["codex"]["discovery_root"] == "$HOME/.agents/skills"
    assert deps["tools"]["codex"]["version"] == "0.153.4"
    assert deps["tools"]["codex"]["load_contract"] == "read <skill>/SKILL.md as UTF-8"
    assert "secret" not in json.dumps(deps).lower()


def test_public_example_selects_and_preflights_declared_python() -> None:
    deps = json.loads(PUBLIC_DEPS.read_text(encoding="utf-8"))
    example = (ROOT / "docs" / "onboarding-v1-public-example.md").read_text(encoding="utf-8")
    assert deps["runtime"]["python"]["version"] == "3.11.15"
    assert 'PYTHON_BIN="${SKILL_MASTER_PYTHON:-}"' in example
    assert "sys.version_info[:3] == (3, 11, 15)" in example
    assert not re.search(r"(?m)^python3(?:\.\d+)?\s+scripts/", example)
    assert sys.version_info[:3] == (3, 11, 15)
