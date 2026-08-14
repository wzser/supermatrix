#!/usr/bin/env python3
"""Snapshot, verify, and roll back active skill installations.

This script is the rollback foundation for weekly skill upgrades. The intended
flow is:

  1. Before upgrading, run:  skill-upgrade-rollback.py snapshot --reason weekly
  2. Run upgrade steps.
  3. Run:                  skill-upgrade-rollback.py verify-current
  4. If usage looks wrong: skill-upgrade-rollback.py restore <snapshot-id>

Snapshots are file-level archives of the active skill roots plus a symlink
manifest. They do not depend on git being clean.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = ROOT / "skills"
SOURCE_REGISTRY = ROOT / "config" / "skill-upgrade-sources.json"
SNAPSHOT_DIR = ROOT / "data" / "skill-upgrades" / "snapshots"
REPORT_DIR = ROOT / "data" / "skill-upgrades" / "reports"
BASELINE_DIR = ROOT / "data" / "skill-upgrades" / "baselines"
SYNC_SCRIPT = ROOT / "scripts" / "sync-skills.sh"

HOME = Path.home()
CLAUDE_SKILLS = HOME / ".claude" / "skills"
AGENTS_SKILLS = HOME / ".agents" / "skills"
KIMI_SKILLS = HOME / ".kimi" / "skills"
CODEX_SKILLS = HOME / ".codex" / "skills"
SUPERPOWERS_ROOT = HOME / ".codex" / "superpowers"
GSTACK_ROOT = HOME / ".claude" / "skills" / "gstack"

EXCLUDE_NAMES = {
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".DS_Store",
}


@dataclass(frozen=True)
class ManagedRoot:
    key: str
    source: Path
    archive_name: str
    extract_parent: Path
    arcname: str


MANAGED_ROOTS = [
    ManagedRoot("skill-master", SKILLS_DIR, "skill-master-skills.tar.gz", ROOT, "skills"),
    ManagedRoot("superpowers", SUPERPOWERS_ROOT, "codex-superpowers.tar.gz", HOME / ".codex", "superpowers"),
    ManagedRoot("gstack", GSTACK_ROOT, "gstack.tar.gz", HOME / ".claude" / "skills", "gstack"),
    ManagedRoot("skill-upgrade-baselines", BASELINE_DIR, "skill-upgrade-baselines.tar.gz", BASELINE_DIR.parent, "baselines"),
]


def utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def git_info(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"exists": False}
    inside = run(["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"])
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return {"exists": True, "git": False}
    head = run(["git", "-C", str(path), "rev-parse", "HEAD"])
    branch = run(["git", "-C", str(path), "branch", "--show-current"])
    status = run(["git", "-C", str(path), "status", "--short"])
    return {
        "exists": True,
        "git": True,
        "head": head.stdout.strip() if head.returncode == 0 else "",
        "branch": branch.stdout.strip() if branch.returncode == 0 else "",
        "dirty": bool(status.stdout.strip()),
        "status_short": status.stdout.splitlines()[:200],
    }


def parse_index() -> list[dict[str, str]]:
    index = SKILLS_DIR / "INDEX.md"
    if not index.exists():
        return []
    rows: list[dict[str, str]] = []
    in_table = False
    for raw in index.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line == "## Skills":
            in_table = True
            continue
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5 or cells[0] in {"Name", "------"}:
            continue
        name, origin, scope, owner, purpose = cells[:5]
        if origin in {"skill-master", "claude-builtin", "codex-builtin"}:
            rows.append({
                "name": name,
                "origin": origin,
                "scope": scope,
                "owner": owner,
                "purpose": purpose,
            })
    return rows


def is_excluded(path: Path, base: Path) -> bool:
    try:
        rel = path.relative_to(base)
    except ValueError:
        return False
    return any(part in EXCLUDE_NAMES for part in rel.parts)


def add_tree(tf: tarfile.TarFile, source: Path, arcname: str) -> None:
    def add_path(path: Path) -> None:
        if is_excluded(path, source):
            return
        try:
            rel = path.relative_to(source)
        except ValueError:
            return
        target = Path(arcname) / rel if rel.parts else Path(arcname)
        try:
            tf.add(path, arcname=str(target), recursive=False)
        except FileNotFoundError:
            return
        if path.is_dir() and not path.is_symlink():
            try:
                children = sorted(path.iterdir(), key=lambda p: p.name)
            except PermissionError:
                return
            for child in children:
                add_path(child)

    add_path(source)


def make_archive(source: Path, dest: Path, arcname: str) -> dict[str, Any]:
    if not source.exists():
        return {"exists": False}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(dest, "w:gz") as tf:
        add_tree(tf, source, arcname)
    return {
        "exists": True,
        "archive": dest.name,
        "bytes": dest.stat().st_size,
    }


def real_or_none(path: Path) -> Path | None:
    try:
        return path.resolve(strict=False)
    except OSError:
        return None


def path_under(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def capture_symlinks() -> list[dict[str, str]]:
    roots = [r.source for r in MANAGED_ROOTS]
    discovery_dirs = [CLAUDE_SKILLS, AGENTS_SKILLS, CODEX_SKILLS]
    records: list[dict[str, str]] = []
    for directory in discovery_dirs:
        if not directory.exists():
            continue
        for entry in sorted(directory.iterdir(), key=lambda p: p.name):
            if not entry.is_symlink():
                continue
            raw_target = os.readlink(entry)
            target = real_or_none(entry)
            if target is None:
                continue
            if not any(path_under(target, root) for root in roots):
                continue
            records.append({
                "path": str(entry),
                "name": entry.name,
                "raw_target": raw_target,
                "resolved_target": str(target),
            })
    return records


def create_snapshot(reason: str, label: str | None = None, dry_run: bool = False) -> dict[str, Any]:
    snapshot_id = f"{utc_stamp()}-{label or reason}"
    snapshot_id = re.sub(r"[^A-Za-z0-9_.-]+", "-", snapshot_id).strip("-")
    dest_dir = SNAPSHOT_DIR / snapshot_id

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "snapshot_id": snapshot_id,
        "created_at": iso_now(),
        "reason": reason,
        "root": str(ROOT),
        "exclude_names": sorted(EXCLUDE_NAMES),
        "roots": [],
        "symlinks": capture_symlinks(),
        "index_rows": parse_index(),
        "tool": str(Path(__file__).resolve()),
    }

    if dry_run:
        for managed in MANAGED_ROOTS:
            manifest["roots"].append({
                "key": managed.key,
                "path": str(managed.source),
                "archive": managed.archive_name,
                "extract_parent": str(managed.extract_parent),
                "arcname": managed.arcname,
                "archive_result": {"dry_run": True, "exists": managed.source.exists()},
                "git": git_info(managed.source),
            })
        return manifest

    dest_dir.mkdir(parents=True, exist_ok=False)
    for managed in MANAGED_ROOTS:
        archive = dest_dir / managed.archive_name
        result = make_archive(managed.source, archive, managed.arcname)
        manifest["roots"].append({
            "key": managed.key,
            "path": str(managed.source),
            "archive": managed.archive_name,
            "extract_parent": str(managed.extract_parent),
            "arcname": managed.arcname,
            "archive_result": result,
            "git": git_info(managed.source),
        })
    (dest_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    return manifest


def load_manifest(snapshot_id: str) -> tuple[Path, dict[str, Any]]:
    if snapshot_id == "latest":
        snapshots = sorted(p for p in SNAPSHOT_DIR.glob("*") if (p / "manifest.json").exists())
        if not snapshots:
            raise SystemExit("No snapshots found")
        snap_dir = snapshots[-1]
    else:
        snap_dir = SNAPSHOT_DIR / snapshot_id
    manifest_path = snap_dir / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit(f"No manifest found for snapshot {snapshot_id}: {manifest_path}")
    return snap_dir, json.loads(manifest_path.read_text(encoding="utf-8"))


def restore_archive(snap_dir: Path, root_entry: dict[str, Any]) -> str:
    archive_result = root_entry.get("archive_result") or {}
    if not archive_result.get("exists"):
        return f"skip {root_entry.get('key')}: source was missing in snapshot"
    archive = snap_dir / root_entry["archive"]
    extract_parent = Path(root_entry["extract_parent"]).expanduser()
    target = extract_parent / root_entry["arcname"]
    if not archive.exists():
        raise SystemExit(f"Archive missing: {archive}")
    if target.exists() or target.is_symlink():
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    extract_parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        tf.extractall(extract_parent)
    return f"restored {root_entry.get('key')} -> {target}"


def restore_symlinks(records: list[dict[str, str]], force_links: bool = False) -> list[str]:
    out: list[str] = []
    for rec in records:
        path = Path(rec["path"]).expanduser()
        target = rec["raw_target"]
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            if path.is_symlink() or force_links:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            else:
                out.append(f"skip link {path}: existing non-symlink")
                continue
        os.symlink(target, path)
        out.append(f"link {path} -> {target}")
    return out


def run_sync() -> tuple[int, str]:
    if not SYNC_SCRIPT.exists():
        return 127, f"missing {SYNC_SCRIPT}"
    res = run([str(SYNC_SCRIPT)], cwd=ROOT, timeout=60)
    return res.returncode, (res.stdout + res.stderr).strip()


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end < 0:
        return {}
    block = text[4:end]
    fields: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip('"')
    return fields


def check_skill_file(path: Path, expected_name: str | None = None) -> list[str]:
    issues: list[str] = []
    if not path.exists():
        return [f"missing {path}"]
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return [f"not utf-8 {path}"]
    fm = parse_frontmatter(text)
    if not fm.get("name"):
        issues.append(f"missing frontmatter name: {path}")
    if not fm.get("description"):
        issues.append(f"missing frontmatter description: {path}")
    if expected_name and fm.get("name") and fm["name"] != expected_name:
        issues.append(f"name mismatch: {path} has {fm['name']}, expected {expected_name}")
    return issues


def expected_link_dirs(scope: str) -> list[Path]:
    if scope == "shared":
        return [CLAUDE_SKILLS, AGENTS_SKILLS, KIMI_SKILLS]
    if scope == "claude-only":
        return [CLAUDE_SKILLS]
    if scope == "codex-only":
        return [AGENTS_SKILLS]
    return []


def verify_source_registry() -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not SOURCE_REGISTRY.exists():
        warnings.append(f"source registry missing: {SOURCE_REGISTRY}")
        return errors, warnings
    try:
        registry = json.loads(SOURCE_REGISTRY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"source registry invalid json: {exc}")
        return errors, warnings
    if registry.get("schema_version") != 1:
        errors.append(f"source registry unsupported schema: {registry.get('schema_version')}")
    seen_ids: set[str] = set()
    for package in registry.get("packages", []):
        package_id = package.get("id")
        if not package_id:
            errors.append("source registry package missing id")
            continue
        if package_id in seen_ids:
            errors.append(f"source registry duplicate package id: {package_id}")
        seen_ids.add(package_id)
        if not package.get("enabled", True):
            continue
        if not package.get("repo"):
            errors.append(f"{package_id}: missing repo")
        if package.get("kind") == "mapped-skill-set":
            if not package.get("upstream_worktree"):
                errors.append(f"{package_id}: missing upstream_worktree")
            if not package.get("baseline_root"):
                errors.append(f"{package_id}: missing baseline_root")
            if not package.get("local_root"):
                errors.append(f"{package_id}: missing local_root")
            for mapping in package.get("mappings", []):
                local = mapping.get("local")
                source = mapping.get("source")
                if not local or not source:
                    errors.append(f"{package_id}: mapping missing local/source: {mapping}")
                    continue
                local_dir = ROOT / package["local_root"] / local
                if not local_dir.exists():
                    warnings.append(f"{package_id}: local mapped skill missing until created: {local_dir}")
        elif package.get("kind") == "git-package":
            if not package.get("local_root"):
                errors.append(f"{package_id}: missing local_root")
        else:
            errors.append(f"{package_id}: unsupported kind {package.get('kind')}")
    return errors, warnings


def verify_current(write_report: bool = True) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    rows = parse_index()

    active_skill_master = [
        row for row in rows
        if row["origin"] == "skill-master" and row["scope"] in {"shared", "claude-only", "codex-only"}
    ]
    for row in active_skill_master:
        name = row["name"]
        skill_dir = SKILLS_DIR / name
        if not skill_dir.is_dir():
            errors.append(f"missing canonical dir for {name}: {skill_dir}")
            continue
        errors.extend(check_skill_file(skill_dir / "SKILL.md", expected_name=name))
        for link_dir in expected_link_dirs(row["scope"]):
            link = link_dir / name
            if not link.is_symlink():
                errors.append(f"missing symlink for {name}: {link}")
                continue
            resolved = link.resolve(strict=False)
            if resolved != skill_dir.resolve(strict=False):
                errors.append(f"wrong symlink for {name}: {link} -> {resolved}, expected {skill_dir}")

    for link_root in [CLAUDE_SKILLS, AGENTS_SKILLS, KIMI_SKILLS, CODEX_SKILLS]:
        if not link_root.exists():
            warnings.append(f"discovery dir missing: {link_root}")
            continue
        for entry in sorted(link_root.iterdir(), key=lambda p: p.name):
            if entry.is_symlink() and not entry.exists():
                errors.append(f"broken symlink: {entry} -> {os.readlink(entry)}")

    superpower_skill_dir = SUPERPOWERS_ROOT / "skills"
    if superpower_skill_dir.exists():
        count = 0
        for skill_dir in sorted(p for p in superpower_skill_dir.iterdir() if p.is_dir()):
            skill_file = skill_dir / "SKILL.md"
            if skill_file.exists():
                count += 1
                errors.extend(check_skill_file(skill_file))
        if count == 0:
            warnings.append(f"no superpowers skills found under {superpower_skill_dir}")
    else:
        warnings.append(f"superpowers skills dir missing: {superpower_skill_dir}")

    if GSTACK_ROOT.exists():
        count = 0
        for skill_file in GSTACK_ROOT.glob("*/SKILL.md"):
            count += 1
            errors.extend(check_skill_file(skill_file))
        if count == 0:
            warnings.append(f"no gstack skill files found under {GSTACK_ROOT}")
    else:
        warnings.append(f"gstack root missing: {GSTACK_ROOT}")

    registry_errors, registry_warnings = verify_source_registry()
    errors.extend(registry_errors)
    warnings.extend(registry_warnings)

    result = {
        "checked_at": iso_now(),
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "counts": {
            "index_rows": len(rows),
            "active_skill_master": len(active_skill_master),
        },
    }

    if write_report:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        report_path = REPORT_DIR / f"{utc_stamp()}-verify-current.md"
        lines = [
            "# Skill Availability Verification",
            "",
            f"- checked_at: {result['checked_at']}",
            f"- ok: {result['ok']}",
            f"- index_rows: {len(rows)}",
            f"- active_skill_master: {len(active_skill_master)}",
            "",
            "## Errors",
            *(f"- {e}" for e in errors),
            *(["- none"] if not errors else []),
            "",
            "## Warnings",
            *(f"- {w}" for w in warnings),
            *(["- none"] if not warnings else []),
        ]
        report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        result["report_path"] = str(report_path)
    return result


def list_snapshots() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not SNAPSHOT_DIR.exists():
        return out
    for snap_dir in sorted(SNAPSHOT_DIR.iterdir()):
        manifest_path = snap_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        out.append({
            "snapshot_id": manifest.get("snapshot_id", snap_dir.name),
            "created_at": manifest.get("created_at"),
            "reason": manifest.get("reason"),
            "path": str(snap_dir),
        })
    return out


def cmd_snapshot(args: argparse.Namespace) -> int:
    manifest = create_snapshot(args.reason, args.label, args.dry_run)
    if args.json:
        print(json.dumps(manifest, indent=2, ensure_ascii=False))
    else:
        print(f"snapshot_id={manifest['snapshot_id']}")
        print(f"created_at={manifest['created_at']}")
        if args.dry_run:
            print("dry_run=true")
        else:
            print(f"path={SNAPSHOT_DIR / manifest['snapshot_id']}")
        for root in manifest["roots"]:
            result = root["archive_result"]
            print(f"- {root['key']}: exists={result.get('exists')} archive={root['archive']} bytes={result.get('bytes', '-')}")
        print(f"symlinks={len(manifest['symlinks'])}")
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    snapshots = list_snapshots()
    if args.json:
        print(json.dumps(snapshots, indent=2, ensure_ascii=False))
    else:
        if not snapshots:
            print("No snapshots")
        for snap in snapshots:
            print(f"{snap['snapshot_id']}\t{snap.get('created_at')}\t{snap.get('reason')}\t{snap.get('path')}")
    return 0


def cmd_restore(args: argparse.Namespace) -> int:
    snap_dir, manifest = load_manifest(args.snapshot_id)
    if args.dry_run:
        print(f"snapshot_id={manifest['snapshot_id']}")
        print(f"path={snap_dir}")
        for root_entry in manifest.get("roots", []):
            archive = snap_dir / root_entry["archive"]
            archive_result = root_entry.get("archive_result") or {}
            target = Path(root_entry["extract_parent"]).expanduser() / root_entry["arcname"]
            print(
                f"would_restore {root_entry.get('key')} archive={archive} "
                f"exists={archive.exists()} target={target} captured={archive_result.get('exists')}"
            )
        print(f"would_restore_symlinks={len(manifest.get('symlinks', []))}")
        print(f"would_run_sync={not args.skip_sync}")
        return 0

    if not args.no_safety_snapshot:
        safety = create_snapshot("pre-restore", f"before-{manifest['snapshot_id']}")
        print(f"safety_snapshot={safety['snapshot_id']}")

    for root_entry in manifest.get("roots", []):
        print(restore_archive(snap_dir, root_entry))

    for line in restore_symlinks(manifest.get("symlinks", []), force_links=args.force_links):
        print(line)

    if not args.skip_sync:
        code, output = run_sync()
        print("sync-skills.sh:")
        print(output)
        if code != 0:
            print(f"sync failed with exit {code}", file=sys.stderr)
            return code

    result = verify_current(write_report=True)
    print(f"verify ok={result['ok']} report={result.get('report_path')}")
    if result["errors"]:
        for err in result["errors"]:
            print(f"ERROR: {err}", file=sys.stderr)
    return 0 if result["ok"] else 2


def cmd_verify(args: argparse.Namespace) -> int:
    result = verify_current(write_report=not args.no_report)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"ok={result['ok']}")
        print(f"errors={len(result['errors'])}")
        print(f"warnings={len(result['warnings'])}")
        if result.get("report_path"):
            print(f"report={result['report_path']}")
        for err in result["errors"]:
            print(f"ERROR: {err}")
        for warning in result["warnings"]:
            print(f"WARN: {warning}")
    return 0 if result["ok"] else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_snapshot = sub.add_parser("snapshot", help="create a rollback snapshot")
    p_snapshot.add_argument("--reason", default="manual", help="snapshot reason, e.g. weekly/manual/pre-restore")
    p_snapshot.add_argument("--label", default=None, help="optional snapshot id suffix")
    p_snapshot.add_argument("--dry-run", action="store_true", help="show what would be captured without writing archives")
    p_snapshot.add_argument("--json", action="store_true", help="print JSON manifest")
    p_snapshot.set_defaults(func=cmd_snapshot)

    p_list = sub.add_parser("list", help="list rollback snapshots")
    p_list.add_argument("--json", action="store_true", help="print JSON")
    p_list.set_defaults(func=cmd_list)

    p_restore = sub.add_parser("restore", help="restore a snapshot; use 'latest' for newest")
    p_restore.add_argument("snapshot_id")
    p_restore.add_argument("--no-safety-snapshot", action="store_true", help="do not snapshot current state before restoring")
    p_restore.add_argument("--force-links", action="store_true", help="replace existing non-symlink discovery entries")
    p_restore.add_argument("--skip-sync", action="store_true", help="do not run sync-skills.sh after restore")
    p_restore.add_argument("--dry-run", action="store_true", help="show what would be restored without modifying files")
    p_restore.set_defaults(func=cmd_restore)

    p_verify = sub.add_parser("verify-current", help="check current skill availability")
    p_verify.add_argument("--json", action="store_true", help="print JSON")
    p_verify.add_argument("--no-report", action="store_true", help="do not write markdown report")
    p_verify.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.time()
    try:
        return args.func(args)
    finally:
        elapsed = time.time() - started
        if not getattr(args, "json", False):
            print(f"elapsed={elapsed:.1f}s")


if __name__ == "__main__":
    sys.exit(main())
