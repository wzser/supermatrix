#!/usr/bin/env python3
"""Rebuild the auto-maintained metadata block in kb/MAP.md.

Updates only the content between `<!-- AUTO:meta -->` and `<!-- /AUTO:meta -->`
markers — currently the date line and the source/concept count line. Other
sections (当前形态 / 标签地形 / Concept 综述索引 / 尚未成文 / 争议 / 待处理 /
使用须知) require human/agent judgment and stay manual.

Usage:
  python3 scripts/rebuild-map.py            # rewrite MAP.md in place
  python3 scripts/rebuild-map.py --check    # print what would change, exit 1 if drift
"""
from __future__ import annotations

import argparse
import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAP_PATH = ROOT / "kb" / "MAP.md"
SOURCES_JSONL = ROOT / "kb" / "sources.jsonl"
CONCEPTS_DIR = ROOT / "kb" / "concepts"

START = "<!-- AUTO:meta -->"
END = "<!-- /AUTO:meta -->"
BLOCK_RE = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)


def count_sources() -> int:
    text = SOURCES_JSONL.read_text(encoding="utf-8")
    return sum(1 for line in text.splitlines() if line.strip())


def count_concepts() -> int:
    return len(list(CONCEPTS_DIR.glob("*.md")))


def render_block(today: str, sources: int, concepts: int) -> str:
    return (
        f"{START}\n"
        f"最后更新：{today}\n"
        f"Source 数量：{sources}　Concept 综述数量：{concepts}\n"
        f"{END}"
    )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="Print drift, do not write. Exit 1 if drift detected.")
    parser.add_argument("--date", default=None,
                        help="Override date (default: today). Useful for tests.")
    args = parser.parse_args(argv[1:])

    today = args.date or datetime.date.today().isoformat()
    sources = count_sources()
    concepts = count_concepts()

    text = MAP_PATH.read_text(encoding="utf-8")
    if not BLOCK_RE.search(text):
        sys.exit(f"ERROR: AUTO:meta markers not found in {MAP_PATH.relative_to(ROOT)}. "
                 f"Insert `{START}` ... `{END}` around the metadata lines first.")

    new_block = render_block(today, sources, concepts)
    new_text = BLOCK_RE.sub(new_block, text, count=1)

    if new_text == text:
        print(f"clean: sources={sources} concepts={concepts} date={today}")
        return 0

    if args.check:
        old_match = BLOCK_RE.search(text).group(0)
        print("DRIFT detected")
        print("--- old ---")
        print(old_match)
        print("--- new ---")
        print(new_block)
        return 1

    MAP_PATH.write_text(new_text, encoding="utf-8")
    print(f"updated {MAP_PATH.relative_to(ROOT)}: sources={sources} concepts={concepts} date={today}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
