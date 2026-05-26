#!/usr/bin/env python3
"""Build reverse index and audit report from kb/sources.jsonl + kb/concepts/*.md.

Outputs:
  _index/source-usage.json   # persistent reverse index (agent-consumed)
  stdout                     # audit report (human review)

Not synced to Feishu. Pure read-only over KB.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KB = ROOT / "kb"
SOURCES_JSONL = KB / "sources.jsonl"
CONCEPTS_DIR = KB / "concepts"
INDEX_DIR = ROOT / "_index"

CITE_RE = re.compile(r"\[S(\d{4})\]")
CONCEPT_LINK_RE = re.compile(r"\]\((?:\.\./concepts/|concepts/|(?=[a-z0-9-]+\.md\)))([a-z0-9-]+)\.md\)")
FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def load_sources() -> dict[str, dict]:
    records = {}
    for lineno, line in enumerate(SOURCES_JSONL.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        rec = json.loads(line)
        sid = rec["id"]
        if sid in records:
            sys.exit(f"duplicate source id {sid} at line {lineno}")
        records[sid] = rec
    return records


def parse_frontmatter(text: str) -> dict[str, object]:
    """Parse YAML-ish frontmatter. Handles scalar fields and indented `- item` lists.

    For list items of the form `- slug: "description"`, the raw string
    `slug: "description"` is kept; downstream may split on first colon.
    """
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    meta: dict[str, object] = {}
    lines = m.group(1).splitlines()
    i = 0
    kv_re = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")
    list_item_re = re.compile(r"^\s+-\s+(.*)$")
    while i < len(lines):
        line = lines[i]
        kv = kv_re.match(line)
        if not kv:
            i += 1
            continue
        key = kv.group(1).strip()
        val = kv.group(2).strip()
        if val == "":
            items: list[str] = []
            i += 1
            while i < len(lines) and list_item_re.match(lines[i]):
                items.append(list_item_re.match(lines[i]).group(1).strip())
                i += 1
            meta[key] = items
            continue
        if val == "[]":
            meta[key] = []
        elif val.lower() in ("null", "~"):
            meta[key] = None
        else:
            meta[key] = val.strip('"').strip("'")
        i += 1
    return meta


def load_concepts() -> dict[str, dict]:
    concepts = {}
    for path in sorted(CONCEPTS_DIR.glob("*.md")):
        slug = path.stem
        text = path.read_text(encoding="utf-8")
        cited = sorted({f"S{m}" for m in CITE_RE.findall(text)})
        linked_concepts = sorted({s for s in CONCEPT_LINK_RE.findall(text) if s != slug})
        meta = parse_frontmatter(text)
        concepts[slug] = {
            "path": str(path.relative_to(ROOT)),
            "cites": cited,
            "related": linked_concepts,
            "last_updated": meta.get("last_updated", ""),
            "confidence": meta.get("confidence", ""),
            "refresh_cadence": meta.get("refresh_cadence", ""),
            "parent": meta.get("parent"),
            "children": meta.get("children", []) or [],
            "unwritten_children": meta.get("unwritten_children", []) or [],
            "boundary_with": meta.get("boundary_with", []) or [],
        }
    return concepts


def build_reverse_index(sources: dict, concepts: dict) -> dict:
    usage = {sid: [] for sid in sources}
    for slug, info in concepts.items():
        for sid in info["cites"]:
            if sid in usage:
                usage[sid].append(slug)
    return usage


def audit(sources: dict, concepts: dict, usage: dict) -> list[str]:
    lines: list[str] = []

    missing_ids: list[tuple[str, str]] = []
    for slug, info in concepts.items():
        for sid in info["cites"]:
            if sid not in sources:
                missing_ids.append((slug, sid))

    orphan_sources = sorted([sid for sid, users in usage.items() if not users])

    single_source_high_conf = []
    for slug, info in concepts.items():
        if info["confidence"] == "high" and len(info["cites"]) < 2:
            single_source_high_conf.append((slug, info["cites"]))

    missing_meta = []
    for slug, info in concepts.items():
        for field in ("last_updated", "confidence", "refresh_cadence"):
            if not info[field]:
                missing_meta.append((slug, field))

    tree_inconsistencies: list[tuple[str, str]] = []
    for slug, info in concepts.items():
        for child in info["children"]:
            if child not in concepts:
                tree_inconsistencies.append((slug, f"references unknown child `{child}`"))
                continue
            child_parent = concepts[child]["parent"]
            if child_parent != slug:
                tree_inconsistencies.append((slug, f"child `{child}` has parent=`{child_parent}` (expected `{slug}`)"))
        if info["parent"] and info["parent"] not in concepts:
            tree_inconsistencies.append((slug, f"parent `{info['parent']}` not found"))

    lines.append("## Missing [Sxxxx] (cited in concept but not in sources.jsonl)")
    if missing_ids:
        for slug, sid in missing_ids:
            lines.append(f"  - {slug} cites {sid} — not found")
    else:
        lines.append("  - none")

    lines.append("")
    lines.append(f"## Orphan sources (no concept cites them): {len(orphan_sources)}")
    if orphan_sources:
        for sid in orphan_sources:
            rec = sources[sid]
            title = rec.get("title", "")[:70]
            lines.append(f"  - {sid}: {title}")
    else:
        lines.append("  - none")

    lines.append("")
    lines.append("## Single-source high-confidence concepts (thin evidence)")
    if single_source_high_conf:
        for slug, cites in single_source_high_conf:
            lines.append(f"  - {slug}: cites {cites}")
    else:
        lines.append("  - none")

    lines.append("")
    lines.append("## Concepts missing frontmatter fields")
    if missing_meta:
        for slug, field in missing_meta:
            lines.append(f"  - {slug}: missing `{field}`")
    else:
        lines.append("  - none")

    lines.append("")
    lines.append("## Concept tree inconsistencies")
    if tree_inconsistencies:
        for slug, msg in tree_inconsistencies:
            lines.append(f"  - {slug}: {msg}")
    else:
        lines.append("  - none")

    lines.append("")
    lines.append("## Concept-to-concept link graph")
    for slug, info in concepts.items():
        related = ", ".join(info["related"]) if info["related"] else "—"
        lines.append(f"  - {slug} → {related}")

    lines.append("")
    lines.append("## Summary")
    lines.append(f"  - sources: {len(sources)}")
    lines.append(f"  - concepts: {len(concepts)}")
    lines.append(f"  - orphan sources: {len(orphan_sources)}")
    lines.append(f"  - missing citations: {len(missing_ids)}")
    lines.append(f"  - single-source high-conf: {len(single_source_high_conf)}")
    lines.append(f"  - missing frontmatter fields: {len(missing_meta)}")
    lines.append(f"  - tree inconsistencies: {len(tree_inconsistencies)}")

    return lines


def write_reverse_index(sources: dict, concepts: dict, usage: dict) -> None:
    INDEX_DIR.mkdir(exist_ok=True)
    payload = {
        "generated_from": "scripts/build-index.py",
        "source_count": len(sources),
        "concept_count": len(concepts),
        "source_usage": usage,
        "concepts": {
            slug: {
                "path": info["path"],
                "cites": info["cites"],
                "related": info["related"],
                "last_updated": info["last_updated"],
                "confidence": info["confidence"],
                "refresh_cadence": info["refresh_cadence"],
                "source_count": len(info["cites"]),
                "parent": info["parent"],
                "children": info["children"],
                "unwritten_children": info["unwritten_children"],
                "boundary_with": info["boundary_with"],
            }
            for slug, info in concepts.items()
        },
    }
    out = INDEX_DIR / "source-usage.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}", file=sys.stderr)


def main() -> None:
    sources = load_sources()
    concepts = load_concepts()
    usage = build_reverse_index(sources, concepts)
    write_reverse_index(sources, concepts, usage)

    print("# KB Audit Report")
    print()
    for line in audit(sources, concepts, usage):
        print(line)


if __name__ == "__main__":
    main()
