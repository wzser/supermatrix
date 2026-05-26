#!/usr/bin/env python3
"""
Bilingual interleaving for FP wiki sync.

Reads markdown on stdin, splits into blocks (heading / paragraph / list / quote /
code / table / hr / blank), translates English text blocks to Simplified Chinese
via `claude -p --model sonnet`, interleaves them, writes to stdout.

- Code fences, tables, horizontal rules: preserved verbatim, no translation.
- Headings: translated; English heading kept on its own line, Chinese rendered as
  an italic sub-line right after.
- Paragraphs / lists / blockquotes: translated; original block, blank line,
  translated block, blank line.

Translation cache: data/translations.cache.json. Key = sha256(prompt_version + block).
"""

import hashlib
import json
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_PATH = REPO_ROOT / "data" / "translations.cache.json"
PROMPT_VERSION = "v1"
MODEL = "sonnet"
TIMEOUT_S = 180


PROMPT_TMPL = """Translate the following English markdown to Simplified Chinese.

Rules:
- Output ONLY the translation. No preamble, no explanation, no quoted English source.
- Preserve all markdown formatting (bold, italic, inline code, links, list bullets, blockquote markers).
- Keep technical identifiers in English (API names, file paths, function/variable names, command names, code snippets, env vars). Optionally add a brief Chinese gloss in parentheses on first occurrence in the block.
- If the input is a heading like `## Foo`, output ONLY the heading text (no `#` markers).

INPUT:
{content}"""


def load_cache():
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            sys.stderr.write(f"[translate-md] cache read failed, starting fresh: {e}\n")
    return {}


def save_cache(cache):
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CACHE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(CACHE_PATH)


def cache_key(content: str) -> str:
    h = hashlib.sha256()
    h.update(PROMPT_VERSION.encode("utf-8"))
    h.update(b"\x00")
    h.update(MODEL.encode("utf-8"))
    h.update(b"\x00")
    h.update(content.encode("utf-8"))
    return h.hexdigest()


def call_claude(prompt: str) -> str:
    proc = subprocess.run(
        ["claude", "-p", "--model", MODEL],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exit {proc.returncode}: {proc.stderr.strip()[:500]}")
    return proc.stdout.strip()


def translate(text: str, cache: dict) -> str:
    key = cache_key(text)
    if key in cache:
        return cache[key]
    prompt = PROMPT_TMPL.format(content=text)
    result = call_claude(prompt)
    cache[key] = result
    return result


_HEADING = re.compile(r"^#+\s")
_HR = re.compile(r"^(---+|===+|\*\*\*+)\s*$")
_LIST = re.compile(r"^\s*([-*+]|\d+\.)\s")
_BLOCK_BREAK = re.compile(r"^(#+\s|```|---+\s*$|===+\s*$|\*\*\*+\s*$|\|)")


def parse_blocks(md: str):
    """Return list of (kind, text). Kinds: heading|code|table|hr|list|quote|paragraph|blank."""
    lines = md.splitlines()
    n = len(lines)
    out = []
    i = 0
    while i < n:
        line = lines[i]
        if line.lstrip().startswith("```"):
            j = i + 1
            while j < n and not lines[j].lstrip().startswith("```"):
                j += 1
            if j < n:
                j += 1  # include closing fence
            out.append(("code", "\n".join(lines[i:j])))
            i = j
            continue
        if not line.strip():
            out.append(("blank", ""))
            i += 1
            continue
        if _HEADING.match(line):
            out.append(("heading", line))
            i += 1
            continue
        if _HR.match(line):
            out.append(("hr", line))
            i += 1
            continue
        if line.startswith("|"):
            j = i
            while j < n and lines[j].startswith("|"):
                j += 1
            out.append(("table", "\n".join(lines[i:j])))
            i = j
            continue
        if line.startswith(">"):
            j = i
            while j < n and lines[j].startswith(">"):
                j += 1
            out.append(("quote", "\n".join(lines[i:j])))
            i = j
            continue
        if _LIST.match(line):
            j = i
            while j < n:
                cur = lines[j]
                if not cur.strip():
                    break
                if _BLOCK_BREAK.match(cur.lstrip()) and not _LIST.match(cur):
                    break
                j += 1
            out.append(("list", "\n".join(lines[i:j])))
            i = j
            continue
        # paragraph
        j = i
        while j < n:
            cur = lines[j]
            if not cur.strip():
                break
            if _BLOCK_BREAK.match(cur):
                break
            if _LIST.match(cur):
                break
            if cur.startswith(">"):
                break
            j += 1
        out.append(("paragraph", "\n".join(lines[i:j])))
        i = j
    return out


def render(blocks, cache: dict) -> str:
    parts = []
    for kind, content in blocks:
        if kind == "blank":
            parts.append("")
            continue
        if kind in ("code", "table", "hr"):
            parts.append(content)
            continue
        if kind == "heading":
            parts.append(content)
            try:
                trans = translate(content, cache).strip()
            except Exception as e:
                sys.stderr.write(f"[translate-md] heading translate failed: {e}\n")
                trans = ""
            if trans:
                parts.append(f"*{trans}*")
            continue
        # paragraph / list / quote
        parts.append(content)
        try:
            trans = translate(content, cache).strip()
        except Exception as e:
            sys.stderr.write(f"[translate-md] block translate failed: {e}\n")
            trans = f"_[翻译失败]_"
        parts.append("")
        parts.append(trans)
    return "\n".join(parts) + "\n"


def main():
    src = sys.stdin.read()
    cache = load_cache()
    initial = len(cache)
    blocks = parse_blocks(src)
    result = render(blocks, cache)
    save_cache(cache)
    added = len(cache) - initial
    sys.stderr.write(f"[translate-md] {len(blocks)} blocks; cache hits={len(cache)-added} new={added}\n")
    sys.stdout.write(result)


if __name__ == "__main__":
    main()
