#!/usr/bin/env python3
"""Read-only audit for stale or conflicting agent skill discovery files."""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "skill-retirement-audit.json"
DEFAULT_INDEX = ROOT / "skills" / "INDEX.md"
DEFAULT_CANONICAL = ROOT / "skills"
DEFAULT_DISCOVERY_ROOTS = (
    Path.home() / ".claude" / "skills",
    Path.home() / ".agents" / "skills",
    Path.home() / ".kimi" / "skills",
    Path.home() / ".codex" / "skills",
)


def _expanded_path(value: str | Path) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(value))))


def _is_excluded(path: Path, fragments: Iterable[str]) -> bool:
    rendered = str(path)
    return any(os.path.expandvars(os.path.expanduser(fragment)) in rendered for fragment in fragments)


def _frontmatter_name(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    match = re.match(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", text, flags=re.DOTALL)
    if not match:
        return None
    name = re.search(r"(?m)^name:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", match.group(1))
    return name.group(1).strip() if name else None


def _index_rows(path: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    if not path.is_file():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5 or cells[0] in {"Name", "------"} or set(cells[0]) == {"-"}:
            continue
        rows[cells[0]] = {
            "origin": cells[1],
            "scope": cells[2],
            "owner": cells[3],
            "purpose": cells[4],
        }
    return rows


def _broken_symlinks(root: Path) -> list[Path]:
    broken: list[Path] = []
    if not root.exists():
        return broken
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            candidate = Path(current) / name
            if candidate.is_symlink() and not candidate.exists():
                broken.append(candidate)
    return broken


def _discovered_skill_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    results: list[Path] = []
    for entry in root.iterdir():
        if entry.is_symlink() and not entry.exists():
            continue
        candidate = entry / "SKILL.md"
        if candidate.is_file():
            results.append(candidate)
    return results


def _inventory_skill_files(patterns: Iterable[str]) -> list[Path]:
    results: list[Path] = []
    for pattern in patterns:
        expanded = os.path.expandvars(os.path.expanduser(pattern))
        results.extend(Path(match) for match in glob.glob(expanded, recursive=True))
    return results


def run_audit(
    *,
    config_path: Path = DEFAULT_CONFIG,
    index_path: Path = DEFAULT_INDEX,
    canonical_dir: Path = DEFAULT_CANONICAL,
    discovery_roots: Iterable[Path] = DEFAULT_DISCOVERY_ROOTS,
) -> dict[str, Any]:
    config_path = _expanded_path(config_path)
    index_path = _expanded_path(index_path)
    canonical_dir = _expanded_path(canonical_dir)
    roots = [_expanded_path(root) for root in discovery_roots]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    excludes = config.get("exclude_path_fragments", [])
    retired = config.get("retired_names", {})
    retirements = {
        item["name"]: item
        for item in config.get("retirements", [])
        if isinstance(item, dict) and isinstance(item.get("name"), str)
    }
    patterns = [
        (item["code"], re.compile(item["regex"], flags=re.MULTILINE))
        for item in config.get("stale_patterns", [])
    ]
    findings: list[dict[str, Any]] = []

    cleanups = config.get("active_same_name_cleanups", [])
    if not isinstance(cleanups, list):
        findings.append({"code": "active_same_name_cleanup_invalid", "reason": "must_be_a_list"})
        cleanups = []
    for cleanup in cleanups:
        if not isinstance(cleanup, dict):
            findings.append({"code": "active_same_name_cleanup_invalid", "reason": "must_be_an_object"})
            continue
        name = cleanup.get("name")
        removed = cleanup.get("removed_skill_path")
        active = cleanup.get("active_skill_path")
        marker = cleanup.get("marker_path")
        if not all(isinstance(value, str) and value for value in (name, removed, active)):
            findings.append({
                "code": "active_same_name_cleanup_invalid",
                "name": name if isinstance(name, str) else "",
                "reason": "name_removed_skill_path_active_skill_path_required",
            })
            continue
        if marker is not None and (not isinstance(marker, str) or not marker):
            findings.append({
                "code": "active_same_name_cleanup_invalid",
                "name": name,
                "reason": "marker_path_must_be_a_nonempty_string_or_null",
            })
            continue
        removed_path = _expanded_path(removed)
        active_path = _expanded_path(active)
        if removed_path.exists() or removed_path.is_symlink():
            findings.append({
                "code": "active_same_name_legacy_skill_present",
                "name": name,
                "path": str(removed_path),
            })
        if not active_path.is_file():
            findings.append({
                "code": "active_same_name_active_skill_missing",
                "name": name,
                "path": str(active_path),
            })
        if marker is not None:
            marker_path = _expanded_path(marker)
            if not marker_path.is_file():
                findings.append({
                    "code": "active_same_name_marker_missing",
                    "name": name,
                    "path": str(marker_path),
                })

    for retirement in retirements.values():
        if retirement.get("state") == "purged":
            continue
        expected = retirement.get("expected_sha256", {})
        registered_files = []
        primary = retirement.get("primary_tombstone_path")
        if isinstance(primary, str) and primary:
            registered_files.append(_expanded_path(primary))
        registered_files.extend(
            _expanded_path(path)
            for path in retirement.get("secondary_marker_paths", [])
            if isinstance(path, str) and path
        )
        for path in registered_files:
            expected_digest = expected.get(str(path)) if isinstance(expected, dict) else None
            if not path.is_file() or path.is_symlink():
                findings.append({
                    "code": "retirement_file_missing",
                    "name": retirement["name"],
                    "path": str(path),
                })
                continue
            actual_digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if not isinstance(expected_digest, str) or actual_digest != expected_digest:
                findings.append({
                    "code": "retirement_content_changed",
                    "name": retirement["name"],
                    "path": str(path),
                })
        for link in retirement.get("discovery_links", []):
            if not isinstance(link, dict):
                continue
            path = _expanded_path(link.get("path", ""))
            if not path.is_symlink():
                findings.append({
                    "code": "retirement_link_changed" if path.exists() else "retirement_link_missing",
                    "name": retirement["name"],
                    "path": str(path),
                })
            elif os.readlink(path) != link.get("target"):
                findings.append({
                    "code": "retirement_link_changed",
                    "name": retirement["name"],
                    "path": str(path),
                })

    discovered: dict[Path, set[str]] = defaultdict(set)
    for root in roots:
        for broken in _broken_symlinks(root):
            if not _is_excluded(broken, excludes):
                findings.append({
                    "code": "broken_symlink",
                    "path": str(broken),
                    "target": os.readlink(broken),
                })
        for skill_file in _discovered_skill_files(root):
            if not _is_excluded(skill_file, excludes):
                discovered[skill_file].add(str(root))

    canonical_files = list(canonical_dir.glob("*/SKILL.md")) if canonical_dir.is_dir() else []
    inventory_files = _inventory_skill_files(config.get("inventory_globs", []))
    all_paths = set(canonical_files) | set(inventory_files) | set(discovered)
    all_paths = {path for path in all_paths if path.is_file() and not _is_excluded(path, excludes)}

    allowed_duplicate_names = set(config.get("allowed_duplicate_names", []))
    files_by_target: dict[str, dict[str, Any]] = {}
    for skill_file in sorted(all_paths, key=str):
        real_path = str(skill_file.resolve())
        record = files_by_target.setdefault(
            real_path,
            {"path": Path(real_path), "seen_at": set(), "discovery_roots": set()},
        )
        record["seen_at"].add(str(skill_file))
        record["discovery_roots"].update(discovered.get(skill_file, set()))

    occurrences: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for real_path, source in sorted(files_by_target.items()):
        skill_file = source["path"]
        name = _frontmatter_name(skill_file)
        if not name:
            findings.append({
                "code": "invalid_skill_frontmatter",
                "path": str(skill_file),
                "seen_at": sorted(source["seen_at"]),
            })
            continue
        retirement = retirements.get(name)
        allowed_source_targets: set[str] = set()
        registered_primary_target: str | None = None
        if retirement:
            for path in retirement.get("allowed_source_skill_paths", []):
                if isinstance(path, str) and path:
                    allowed_source_targets.add(str(_expanded_path(path).resolve()))
            primary = retirement.get("primary_tombstone_path")
            if isinstance(primary, str) and primary:
                registered_primary_target = str(_expanded_path(primary).resolve())
        is_allowed_source = real_path in allowed_source_targets
        if not is_allowed_source:
            occurrences[name][real_path] = source

        if retirement and real_path != registered_primary_target and not is_allowed_source:
            code = "retired_skill_discoverable" if source["discovery_roots"] else "retired_skill_file_present"
            findings.append({
                "code": code,
                "name": name,
                "path": str(skill_file),
                "seen_at": sorted(source["seen_at"]),
                "discovery_roots": sorted(source["discovery_roots"]),
                "replacement": retirement.get("replacement", "contact skill-master"),
            })
        elif name in retired:
            code = "retired_skill_discoverable" if source["discovery_roots"] else "retired_skill_file_present"
            findings.append({
                "code": code,
                "name": name,
                "path": str(skill_file),
                "seen_at": sorted(source["seen_at"]),
                "discovery_roots": sorted(source["discovery_roots"]),
                "replacement": retired[name],
            })

        try:
            text = skill_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            findings.append({"code": "unreadable_skill_file", "path": str(skill_file)})
            continue
        for pattern_code, regex in patterns:
            match = regex.search(text)
            if match:
                findings.append({
                    "code": "stale_contract_pattern",
                    "pattern": pattern_code,
                    "name": name,
                    "path": str(skill_file),
                    "match": match.group(0)[:160],
                })

    for name, targets in sorted(occurrences.items()):
        if len(targets) > 1 and name not in allowed_duplicate_names:
            findings.append({
                "code": "duplicate_skill_name",
                "name": name,
                "targets": sorted(targets),
            })

    rows = _index_rows(index_path)
    managed_scopes = {"shared", "claude-only", "codex-only"}
    active_managed = {
        name for name, row in rows.items()
        if row["origin"] == "skill-master" and row["scope"] in managed_scopes
    }
    for name in sorted(active_managed):
        skill_file = canonical_dir / name / "SKILL.md"
        if not skill_file.is_file():
            findings.append({
                "code": "canonical_skill_missing",
                "name": name,
                "path": str(skill_file),
            })

    for skill_file in canonical_files:
        name = _frontmatter_name(skill_file)
        if name and name not in rows:
            findings.append({
                "code": "canonical_skill_unregistered",
                "name": name,
                "path": str(skill_file),
            })

    canonical_resolved = canonical_dir.resolve()
    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if not entry.is_symlink() or not entry.exists():
                continue
            try:
                entry.resolve().relative_to(canonical_resolved)
            except ValueError:
                continue
            if entry.name not in active_managed:
                findings.append({
                    "code": "stale_managed_symlink",
                    "name": entry.name,
                    "path": str(entry),
                    "target": str(entry.resolve()),
                })

    findings.sort(key=lambda item: (item["code"], item.get("name", ""), item.get("path", "")))
    return {
        "schema_version": 1,
        "ok": not findings,
        "summary": {
            "discovery_roots": len(roots),
            "skill_names": len(occurrences),
            "unique_skill_files": sum(len(targets) for targets in occurrences.values()),
            "findings": len(findings),
        },
        "findings": findings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    parser.add_argument("--canonical", type=Path, default=DEFAULT_CANONICAL)
    parser.add_argument("--discovery-root", action="append", type=Path, dest="discovery_roots")
    parser.add_argument("--json", action="store_true", help="emit the stable JSON report")
    args = parser.parse_args()
    report = run_audit(
        config_path=args.config,
        index_path=args.index,
        canonical_dir=args.canonical,
        discovery_roots=args.discovery_roots or DEFAULT_DISCOVERY_ROOTS,
    )
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"skill discovery audit: {'PASS' if report['ok'] else 'FAIL'}")
        print(json.dumps(report["summary"], ensure_ascii=False))
        for finding in report["findings"]:
            print(json.dumps(finding, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
