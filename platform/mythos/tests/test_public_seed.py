import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"

UPSTREAM_LICENSES = {
    "S0002": {
        "url": "https://raw.githubusercontent.com/a2aproject/A2A/6d6640c29b102f7a8d23784901351b5d2454fe71/LICENSE",
        "path": PUBLIC / "third-party" / "a2a-LICENSE",
        "sha256": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
    },
    "S0003": {
        "url": "https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/2997f33bf6e4aab3db48d755fc877c8feab32c71/LICENSE",
        "path": PUBLIC / "third-party" / "mcp-LICENSE",
        "sha256": "0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a",
    },
}


def _validated_python() -> str:
    assert sys.version_info[:2] == (3, 11), (
        f"public seed tests require Python 3.11, got {sys.version}"
    )
    assert Path(sys.executable).is_file()
    return sys.executable


def _run(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    python = _validated_python()
    env = os.environ.copy()
    env["MYTHOS_KB_ROOT"] = str(PUBLIC)
    return subprocess.run(
        [python, str(ROOT / "scripts" / script), *args],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _sources() -> dict[str, dict]:
    return {
        row["id"]: row
        for row in (
            json.loads(line)
            for line in (PUBLIC / "kb" / "sources.jsonl").read_text(encoding="utf-8").splitlines()
            if line.strip()
        )
    }


def test_public_seed_has_resolvable_citations_and_source_files():
    sources = _sources()
    concept = (PUBLIC / "kb" / "concepts" / "agent-workflows.md").read_text(encoding="utf-8")
    notices = (PUBLIC / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    cited = set(re.findall(r"\[S(\d{4})\]", concept))
    assert cited == {sid[1:] for sid in sources}
    assert all((PUBLIC / "kb" / row["file"]).is_file() for row in sources.values())
    assert {row["license"] for row in sources.values()} == {"MIT", "Apache-2.0", "CC-BY-4.0"}
    assert all(row["license_url"].startswith("https://github.com/") for row in sources.values())
    assert all(row["source_revision"] for row in sources.values())
    for row in sources.values():
        body = (PUBLIC / "kb" / row["file"]).read_text(encoding="utf-8")
        body = re.sub(r"\A---\n.*?\n---\n\s*", "", body, count=1, flags=re.S)
        assert hashlib.sha256(body.encode()).hexdigest() == row["content_sha256"]
        assert row["content_sha256"] in notices
        assert row["source_revision"] in notices
        assert row["notice_ref"].startswith("THIRD_PARTY_NOTICES.md#")
        assert row["modification_note"] == "Local YAML frontmatter was added; the captured source body is unchanged."
    assert "Copyright (c) 2025 OpenAI" in notices
    assert "Permission is hereby granted" in notices
    assert b"Apache License" in UPSTREAM_LICENSES["S0002"]["path"].read_bytes()
    assert b"Documentation in this project (excluding specifications) is licensed under" in UPSTREAM_LICENSES["S0003"]["path"].read_bytes()
    assert "No captured upstream source body was rewritten" in notices


def test_fixed_upstream_license_bytes_are_present_and_digest_verified_offline():
    notices = (PUBLIC / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    for source_id, license_info in UPSTREAM_LICENSES.items():
        license_path = license_info["path"]
        license_bytes = license_path.read_bytes()
        assert license_bytes
        assert hashlib.sha256(license_bytes).hexdigest() == license_info["sha256"]
        assert license_info["url"] in notices
        assert source_id in notices


def test_public_query_fixture_points_to_real_sources():
    sources = _sources()
    fixture = PUBLIC / "fixtures" / "query-fixture.jsonl"
    cases = [json.loads(line) for line in fixture.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(cases) == 2
    assert {sid for case in cases for sid in case["sources"]} <= set(sources)
    assert {case["concept"] for case in cases} == {"agent-workflows"}


def test_public_project_declares_supported_python_range():
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'requires-python = ">=3.11,<3.12"' in pyproject


def test_public_index_build_is_clean_and_portable():
    result = _run("build-index.py")
    assert result.returncode == 0, result.stderr
    assert "missing citations: 0" in result.stdout
    assert (PUBLIC / "_index" / "source-usage.json").is_file()


def test_public_seed_fresh_export_creates_only_controlled_runtime(tmp_path):
    python = _validated_python()
    fresh_public = tmp_path / "public"
    shutil.copytree(
        PUBLIC,
        fresh_public,
        ignore=shutil.ignore_patterns("_index", "logs"),
    )
    env = os.environ.copy()
    env["MYTHOS_KB_ROOT"] = str(fresh_public)
    before_files = {
        path.relative_to(fresh_public).as_posix()
        for path in fresh_public.rglob("*")
        if path.is_file()
    }

    build = subprocess.run(
        [python, str(ROOT / "scripts" / "build-index.py")],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert build.returncode == 0, build.stderr
    assert (fresh_public / "_index" / "source-usage.json").is_file()

    log = subprocess.run(
        [python, str(ROOT / "scripts" / "log-query.py")],
        cwd=ROOT,
        env=env,
        input=json.dumps({
            "intent": "definition",
            "kb_state": "has",
            "prompt": "fresh runtime",
            "timestamp": "2026-09-14T00:00:00.000000+00:00",
        }),
        text=True,
        capture_output=True,
        check=False,
    )
    assert log.returncode == 0, log.stderr
    assert (fresh_public / "logs" / "queries" / "queries.jsonl").is_file()
    after_files = {
        path.relative_to(fresh_public).as_posix()
        for path in fresh_public.rglob("*")
        if path.is_file()
    }
    assert after_files - before_files == {
        "_index/source-usage.json",
        "logs/queries/queries.jsonl",
    }


def test_sync_dry_run_needs_no_remote_configuration():
    python = _validated_python()
    env = os.environ.copy()
    env["MYTHOS_KB_ROOT"] = str(PUBLIC)
    env["MYTHOS_PYTHON"] = python
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "sync-kb.sh"), "--dry-run", "all"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "DRY-RUN" in result.stdout


def test_sync_rejects_unusable_explicit_python(tmp_path):
    unusable_python = tmp_path / "not-python"
    unusable_python.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    unusable_python.chmod(0o755)
    env = os.environ.copy()
    env["MYTHOS_KB_ROOT"] = str(PUBLIC)
    env["MYTHOS_PYTHON"] = str(unusable_python)
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "sync-kb.sh"), "--dry-run", "map"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "MYTHOS_PYTHON" in result.stderr


def test_public_sync_config_has_no_live_target_defaults():
    config = (PUBLIC / "config" / "sync.example.env").read_text(encoding="utf-8")
    assert 'MYTHOS_CHARTER_URL=""' in config
    assert 'MYTHOS_MAP_URL=""' in config
    assert 'MYTHOS_PARENT_NODE_TOKEN=""' in config
    assert 'MYTHOS_SPACE_ID=""' in config
    assert 'MYTHOS_ENQUEUE_BIN=""' in config
    assert ("/" + "Users/") not in config


def test_live_sync_fails_closed_without_user_targets():
    python = _validated_python()
    env = {key: value for key, value in os.environ.items() if not key.startswith("MYTHOS_")}
    env["MYTHOS_KB_ROOT"] = str(PUBLIC)
    env["MYTHOS_PYTHON"] = python
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "sync-kb.sh"), "table"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert "required for live source sync" in result.stderr
