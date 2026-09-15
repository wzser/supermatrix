#!/usr/bin/env python3.11
"""Validate and exercise the public modular-input bundle without external IO."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    "bin/fp-generate-init",
    "scripts/fp_assemble.py",
    "data/module-manifest.json",
    "data/category-capability-defaults.json",
    "data/session-variants.json",
    "data/backend-model-effort-catalog.json",
    "config/schema.sql",
    "config/public-bindings.json",
    "config/session-meta-runtime.schema.json",
    "config/session-meta-table.json",
    "config/patrol-state.json",
    "config/dependencies.json",
    "config/permissions.json",
    "templates/CLAUDE.md",
    "templates/AGENTS.md",
    "snippets/coding-principle.md",
    "snippets/sop-principle.md",
    "snippets/python-runtime.md",
    "full-docs/coding-principle.md",
    "full-docs/sop-principle.md",
    "full-docs/python-runtime.md",
    "scripts/bitable-init-sync.sh",
    "scripts/sync-session-table.sh",
    "scripts/session-meta-schema-check.sh",
    "examples/session-meta.runtime.example.json",
    "examples/session-meta.remote.fixture.json",
)
FORBIDDEN = (
    re.compile(r"/Users/|/home/|[A-Za-z]:\\"),
    re.compile(r"\b(?:oc_|ou_|tbl_|app_|wik_)[A-Za-z0-9]{8,}\b"),
)
IGNORED_GENERATED_ENV_DIRS = frozenset({".venv"})
IGNORED_CACHE_DIRS = frozenset({"__pycache__"})


def fail(message: str) -> None:
    raise SystemExit(f"FAIL: {message}")


def load_json(rel: str):
    try:
        return json.loads((ROOT / rel).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"invalid {rel}: {exc}")


def iter_static_files():
    """Yield shipped bundle files, excluding generated environments and caches."""
    for path in ROOT.rglob("*"):
        relative_parts = path.relative_to(ROOT).parts
        if any(part in IGNORED_GENERATED_ENV_DIRS or part in IGNORED_CACHE_DIRS for part in relative_parts):
            continue
        if path.is_file() and path.suffix != ".pyc":
            yield path


def validate_static() -> None:
    for rel in REQUIRED:
        path = ROOT / rel
        if not path.is_file():
            fail(f"missing required carrier: {rel}")

    manifest = load_json("data/module-manifest.json")
    modules = manifest.get("modules")
    if not isinstance(modules, list) or not modules:
        fail("manifest modules must be a non-empty list")
    section_nos = [item["section_no"] for item in modules]
    if section_nos != sorted(set(section_nos)):
        fail("manifest section_no values must be sorted and unique")
    module_names = {item["module"] for item in modules}
    for item in modules:
        if item["owner"] == "__session__" or item.get("assembly") == "fp_runtime":
            continue
        for key in ("snippet_path", "full_doc_path"):
            rel = item[key]
            if Path(rel).is_absolute() or not (ROOT / rel).is_file():
                fail(f"manifest path is not portable/readable: {rel}")

    policy = load_json("data/category-capability-defaults.json")
    for category, names in policy["defaults"].items():
        if not set(names) <= module_names:
            fail(f"category {category} references an unknown module")
    variants = load_json("data/session-variants.json")
    if variants.get("sessions") != {}:
        fail("public session-variants must remain empty")

    bindings = load_json("config/public-bindings.json")
    if bindings.get("binding_status") != "static_contract_only":
        fail("public bindings must remain a static contract")
    boundary = bindings.get("bundle_boundary") or {}
    if boundary.get("queue_consumer_process") is not False:
        fail("public bundle must not claim to ship a queue consumer")
    if bindings.get("queue_contract", {}).get("completion") != "published_wait_terminal_done_plus_independent_record_readback":
        fail("queue completion contract is not fail-closed")
    tables = bindings.get("tables") or {}
    expected_remote_field_counts = {
        "session_meta": 22,
        "patrol_state": 5,
        "principle_modules": 16,
    }
    expected_remote_fields = {
        "session_meta": """
Session|text|local|1
主Backend当前|single_select|local|0
部门|single_select|feishu|0
头像|attachment|feishu|0
Model|text|local|0
Group ID|text|local|0
Scope|single_select|local|0
Workdir|text|local|0
分类|single_select|feishu|0
附属于|text|mixed|0
Created|date_time|local|0
Updated|date_time|local|0
别称|text|feishu|0
Purpose|text|feishu|0
主model当前|single_select|local|0
主effort当前|single_select|local|0
主model默认值|single_select|feishu_on_edit_local_on_backend_switch|0
主effort默认值|single_select|feishu_on_edit_local_on_backend_switch|0
子backend|single_select|feishu|0
子model|single_select|feishu|0
子effort|single_select|feishu|0
负责人|user|feishu|0
""",
        "patrol_state": """
配置项|text|feishu|1
开关|checkbox|feishu|0
说明|text|feishu|0
更新时间|text|feishu|0
ID|auto_number|readonly|0
""",
        "principle_modules": """
模块名|text|local|1
标题|text|local|0
Owner|text|local|0
段号|number|local|0
类别|single_select|local|0
覆盖度|single_select|local|0
飞书原版链接|text|local|0
snippet路径|text|local|0
原版文档路径|text|local|0
上次蒸馏commit|text|local|0
蒸馏内容|text|local|0
蒸馏方法|text|local|0
变体清单|text|local|0
内容sha256|text|local|0
装配方式|text|local|0
启用|checkbox|mixed|0
""",
    }
    expected_remote_fields = {
        name: [
            (parts[0], parts[1], parts[2], parts[3] == "1")
            for line in spec.strip().splitlines()
            if (parts := line.split("|"))
        ]
        for name, spec in expected_remote_fields.items()
    }
    expected_remote_required = {
        "session_meta": "required",
        "patrol_state": "none_for_public_bundle",
        "principle_modules": "conditional",
    }
    for name, table in tables.items():
        if table.get("remote_required") != expected_remote_required.get(name):
            fail(f"remote requirement is missing or ambiguous for {name}")
        if not table.get("unique_key"):
            fail(f"missing unique key for {name}")
        fields = table.get("remote_fields") or []
        if len(fields) != expected_remote_field_counts.get(name):
            fail(f"remote field mapping count is wrong for {name}")
        if len({field.get("remote_name") for field in fields}) != len(fields):
            fail(f"remote field names are not unique for {name}")
        actual_remote_fields = [
            (field["remote_name"], field["native_type"], field["authority"], field["required"])
            for field in fields
        ]
        if actual_remote_fields != expected_remote_fields[name]:
            fail(f"native type/authority/required mapping drifted for {name}")
        for field in fields:
            if not field.get("remote_name") or not field.get("native_type"):
                fail(f"incomplete native field mapping in {name}")
            if field.get("authority") not in {
                "local", "feishu", "mixed", "readonly",
                "feishu_on_edit_local_on_backend_switch",
            }:
                fail(f"unknown authority in {name}: {field.get('authority')}")
        if table.get("existing_owner_carrier", {}).get("bundle_has_running_consumer") is not False:
            fail(f"consumer availability is not explicit for {name}")
    session = tables["session_meta"]
    if session["unique_key"] != ["Session"] or session["write_mode"] != "owner-queue-only":
        fail("session metadata must use the registered Session owner queue contract")
    if session["catalog_role"] != "first-principle.session_metadata":
        fail("session metadata catalog role is not anchored to the 8ed5 public catalog")
    if len(session["local_fields_consumed_by_public_generation"]) != 9:
        fail("session generation field inventory is incomplete")
    patrol_binding = tables["patrol_state"]
    if patrol_binding["write_mode"] != "read-only" or patrol_binding["remote_sync_direction"] != "none":
        fail("patrol control must remain remote read-only")
    principle = tables["principle_modules"]
    if principle["actual_public_source"] != "data/module-manifest.json":
        fail("principle source must remain module-manifest")
    if bindings["queue_contract"].get("missing_consumer_policy") != "blocked_missing_consumer_is_not_completion":
        fail("missing consumer policy is not fail-closed")
    if bindings["queue_contract"].get("missing_consumer_outcome") != "blocked_missing_consumer":
        fail("missing consumer outcome is not explicit")
    if tables["session_meta"]["existing_owner_carrier"].get("missing_consumer_outcome") != "configuration_error":
        fail("session carrier must fail closed on missing runtime configuration")
    for name in ("patrol_state", "principle_modules"):
        if tables[name]["existing_owner_carrier"].get("missing_consumer_outcome") != "blocked_missing_consumer":
            fail(f"non-public consumer gap is not machine-checkable for {name}")
    session_contract = load_json("config/session-meta-table.json")
    if session_contract["remote_required"] != "required":
        fail("session metadata requirement must remain required")
    if session_contract.get("schema_source") != "config/public-bindings.json#/tables/session_meta/remote_fields":
        fail("session schema source must point to public-bindings remote_fields")
    if "schema_readback_required_fields" in session_contract:
        fail("session schema fields must not be duplicated outside public-bindings")
    if session_contract["seed_allowlist"]["fields"] != ["Session", "别称", "Purpose", "分类", "附属于"]:
        fail("session seed allowlist widened or changed")
    if session_contract["seed_allowlist"]["operation"] != "bitable_rows_create_if_absent":
        fail("session seed must use create-if-absent")
    runtime_example = load_json("examples/session-meta.runtime.example.json")
    if any(runtime_example.values()):
        fail("runtime example must not contain default IDs, paths, or credentials")
    patrol = load_json("config/patrol-state.json")
    if patrol != {
        "schema_version": 1,
        "enabled": False,
        "missing_state_policy": "closed",
        "reason": "public bundle has no live roster, runtime database, or remote bindings",
        "allowed_modes": [],
    }:
        fail("patrol must start disabled and fail-closed")
    dependencies = load_json("config/dependencies.json")
    if dependencies["required"]["python"]["version"] != "3.11.15":
        fail("Python dependency pin changed")
    permissions = load_json("config/permissions.json")
    if permissions["external_effects"]["network"] or permissions["external_effects"]["remote_lark_or_github_write"]:
        fail("public bundle cannot grant external write effects")
    with sqlite3.connect(":memory:") as conn:
        conn.executescript((ROOT / "config/schema.sql").read_text(encoding="utf-8"))
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"session_meta", "patrol_state", "principle_modules", "queue_bindings"} <= tables:
            fail("schema is missing a declared table")

    for path in iter_static_files():
        if path.name in {"asset-provenance.json", Path(__file__).name}:
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN:
            if pattern.search(text):
                fail(f"private path or resource id in {path.relative_to(ROOT)}")

    provenance_path = ROOT / "asset-provenance.json"
    if provenance_path.exists():
        provenance = load_json("asset-provenance.json")
        for rel, recorded in provenance.get("files", {}).items():
            actual = hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()
            if actual != recorded:
                fail(f"stale provenance for {rel}")


def run_generation() -> None:
    python = Path(sys.executable).resolve()
    if sys.version_info[:2] != (3, 11):
        fail(f"verification requires Python 3.11, got {sys.version}")
    env = os.environ.copy()
    for key in ("SM_DB", "SM_RUNTIME_ROOT", "SM_CATALOG_SOURCE"):
        env.pop(key, None)
    env.update({
        "FP_ROOT": str(ROOT),
        "FP_PYTHON": str(python),
        "PYTHONDONTWRITEBYTECODE": "1",
    })

    def bundle_snapshot() -> dict[str, str]:
        return {
            str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in iter_static_files()
        }

    with tempfile.TemporaryDirectory(prefix="public-onboarding-") as tmp:
        tmp_path = Path(tmp)
        workdir = tmp_path / "agent-workdir"
        workdir.mkdir()
        state = tmp_path / "state"
        env["FP_STATE_DIR"] = str(state)
        args = [
            str(ROOT / "bin/fp-generate-init"),
            "--session-name", "example-agent",
            "--alias", "Example agent",
            "--avatar", "emoji:🧪",
            "--category", "工具",
            "--purpose", "示例身份与原则装配",
            "--backend", "codex",
            "--workdir", str(workdir),
        ]
        no_state_env = env.copy()
        no_state_env.pop("FP_STATE_DIR", None)
        no_state_env.pop("FP_NDJSON_PATH", None)
        before_no_state = bundle_snapshot()
        no_state = subprocess.run(
            args, cwd=tmp_path, env=no_state_env, text=True, capture_output=True
        )
        if no_state.returncode == 0:
            fail("generator must reject an unset external state path")
        after_no_state = bundle_snapshot()
        if before_no_state != after_no_state:
            changed = sorted(
                set(before_no_state) ^ set(after_no_state)
                | {
                    path
                    for path in set(before_no_state) & set(after_no_state)
                    if before_no_state[path] != after_no_state[path]
                }
            )
            fail(f"generator mutated the static bundle without external state: {changed}")
        in_bundle_env = env.copy()
        in_bundle_env["FP_STATE_DIR"] = str(ROOT / "runtime-state")
        in_bundle = subprocess.run(
            args, cwd=tmp_path, env=in_bundle_env, text=True, capture_output=True
        )
        if in_bundle.returncode == 0:
            fail("generator accepted an in-bundle external state path")
        first = subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True)
        if first.returncode != 0:
            fail(f"generate failed: {first.stderr or first.stdout}")
        payload = json.loads(first.stdout)
        files = {item["filename"]: item["content"] for item in payload["config_files"]}
        if files["CLAUDE.md"] != files["AGENTS.md"]:
            fail("generated config files are not byte-identical")
        for name, content in files.items():
            (workdir / name).write_text(content, encoding="utf-8")

        assemble = [
            str(python), str(ROOT / "scripts/fp_assemble.py"),
            "--session", "example-agent", "--workdir", str(workdir),
            "--category-override", "工具", "--write",
        ]
        for attempt in range(2):
            result = subprocess.run(assemble, cwd=ROOT, env=env, text=True, capture_output=True)
            if result.returncode != 0 or "example-agent: no-op" not in result.stdout:
                fail(f"idempotent assembly attempt {attempt + 1} failed: {result.stderr or result.stdout}")

        second = subprocess.run(args, cwd=ROOT, env=env, text=True, capture_output=True)
        if second.returncode != 0 or json.loads(second.stdout)["config_files"] != payload["config_files"]:
            fail("repeated generation changed the static output")
        records = (state / "session-init.ndjson").read_text(encoding="utf-8").splitlines()
        if len(records) != 1:
            fail(f"ndjson idempotency expected one record, got {len(records)}")

    print(
        "PASS: public inputs, state-path guard, generation, write/rerun idempotence; "
        f"python={python} version={sys.version.split()[0]}"
    )


def write_provenance() -> None:
    files = {}
    for path in sorted(iter_static_files()):
        if path.name != "asset-provenance.json":
            files[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    (ROOT / "asset-provenance.json").write_text(
        json.dumps({"schema_version": 1, "source": "public-approved-static-inputs", "files": files}, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-provenance", action="store_true")
    args = parser.parse_args()
    if args.write_provenance:
        write_provenance()
    validate_static()
    run_generation()


if __name__ == "__main__":
    main()
