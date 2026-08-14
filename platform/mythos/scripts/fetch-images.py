#!/usr/bin/env python3
"""Fetch inline images from a KB source markdown file and rewrite references to local paths.

Usage:
  python3 scripts/fetch-images.py kb/sources/YYYY-MM-DD_slug.md [more...]

Behavior (per file):
  - Parse frontmatter, require `id: S00XX`.
  - Scan body for markdown image refs `![alt](url)` where url is http(s).
  - Download each (UA spoofed, follow redirects), check Content-Type starts with `image/`,
    check size <= 5MB. Save to `kb/sources/_media/<sid>/NN.ext` with sequential NN.
  - Rewrite the original markdown in-place: `![alt](url)` -> `![alt](./_media/<sid>/NN.ext)`.
  - Idempotent: refs already pointing to `./_media/<sid>/` are skipped.
  - Failures are logged; the original URL stays in place. Script exits 0 unless a fatal error.
"""
from __future__ import annotations

import mimetypes
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SOURCES_DIR = ROOT / "kb" / "sources"
MEDIA_DIR = SOURCES_DIR / "_media"

MAX_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

FRONTMATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
ID_RE = re.compile(r"^id:\s*(S\d{4})\s*$", re.M)
IMG_RE = re.compile(r"!\[([^\]]*)\]\((?!\./_media/)([^)\s]+)(\s+\"[^\"]*\")?\)")


def parse_sid(text: str) -> str:
    m = FRONTMATTER_RE.match(text)
    if not m:
        sys.exit("ERROR: no frontmatter found")
    idm = ID_RE.search(m.group(1))
    if not idm:
        sys.exit("ERROR: no `id: S00XX` in frontmatter")
    return idm.group(1)


def pick_extension(url: str, content_type: str) -> str:
    path_ext = Path(urlparse(url).path).suffix.lower()
    if path_ext in ALLOWED_EXT:
        return path_ext
    if content_type:
        guess = mimetypes.guess_extension(content_type.split(";")[0].strip())
        if guess:
            g = guess.lower()
            if g == ".jpe":
                g = ".jpg"
            if g in ALLOWED_EXT:
                return g
    return ""


def curl_head(url: str) -> tuple[int, dict[str, str]]:
    try:
        out = subprocess.run(
            ["curl", "-sIL", "-A", UA, "--max-time", "20", url],
            capture_output=True, text=True, check=False,
        )
    except Exception as exc:
        return 0, {"_error": str(exc)}
    if out.returncode != 0:
        return 0, {"_error": out.stderr.strip() or f"curl exit {out.returncode}"}
    last_block = out.stdout.strip().split("\r\n\r\n")[-1]
    headers: dict[str, str] = {}
    status = 0
    for line in last_block.splitlines():
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                status = int(parts[1])
        elif ":" in line:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
    return status, headers


def curl_download(url: str, dest: Path) -> tuple[bool, str]:
    try:
        out = subprocess.run(
            ["curl", "-sL", "-A", UA, "--max-time", "60",
             "--max-filesize", str(MAX_BYTES), "-o", str(dest), url],
            capture_output=True, text=True, check=False,
        )
    except Exception as exc:
        return False, str(exc)
    if out.returncode != 0:
        if dest.exists():
            dest.unlink()
        return False, out.stderr.strip() or f"curl exit {out.returncode}"
    return True, ""


def next_slot(sid_dir: Path) -> int:
    sid_dir.mkdir(parents=True, exist_ok=True)
    used = []
    for p in sid_dir.iterdir():
        stem = p.stem
        if stem.isdigit():
            used.append(int(stem))
    return (max(used) + 1) if used else 1


def process_file(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    sid = parse_sid(text)
    sid_dir = MEDIA_DIR / sid

    fetched = 0
    skipped = 0
    failed = 0
    replacements: list[tuple[str, str]] = []
    seen_urls: dict[str, str] = {}

    for m in IMG_RE.finditer(text):
        alt, url, _title = m.group(1), m.group(2), m.group(3) or ""
        if not url.startswith(("http://", "https://")):
            skipped += 1
            continue

        if url in seen_urls:
            replacements.append((m.group(0), f"![{alt}]({seen_urls[url]})"))
            continue

        status, headers = curl_head(url)
        ctype = headers.get("content-type", "")
        clen = headers.get("content-length", "")
        if status < 200 or status >= 400:
            print(f"  FAIL {sid} {url} — HEAD status={status} err={headers.get('_error','')}", file=sys.stderr)
            failed += 1
            continue
        if not ctype.lower().startswith("image/"):
            print(f"  FAIL {sid} {url} — non-image content-type: {ctype}", file=sys.stderr)
            failed += 1
            continue
        if clen and clen.isdigit() and int(clen) > MAX_BYTES:
            print(f"  FAIL {sid} {url} — size {clen} > cap {MAX_BYTES}", file=sys.stderr)
            failed += 1
            continue

        ext = pick_extension(url, ctype)
        if not ext:
            print(f"  FAIL {sid} {url} — unknown extension (ctype={ctype})", file=sys.stderr)
            failed += 1
            continue

        slot = next_slot(sid_dir)
        dest = sid_dir / f"{slot:02d}{ext}"
        ok, err = curl_download(url, dest)
        if not ok:
            print(f"  FAIL {sid} {url} — download: {err}", file=sys.stderr)
            failed += 1
            continue
        if dest.stat().st_size > MAX_BYTES:
            dest.unlink()
            print(f"  FAIL {sid} {url} — body exceeded {MAX_BYTES}", file=sys.stderr)
            failed += 1
            continue

        rel = f"./_media/{sid}/{dest.name}"
        seen_urls[url] = rel
        replacements.append((m.group(0), f"![{alt}]({rel})"))
        print(f"  OK   {sid} -> {rel}  ({url})", file=sys.stderr)
        fetched += 1

    if replacements:
        new_text = text
        for old, new in replacements:
            new_text = new_text.replace(old, new)
        path.write_text(new_text, encoding="utf-8")

    try:
        display = path.relative_to(ROOT)
    except ValueError:
        display = path
    print(f"{display} [{sid}]: fetched={fetched} skipped={skipped} failed={failed}", file=sys.stderr)


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: fetch-images.py <source.md> [more...]", file=sys.stderr)
        return 1
    for arg in argv[1:]:
        p = Path(arg)
        if not p.is_absolute():
            p = (Path.cwd() / p).resolve()
        if not p.exists():
            print(f"SKIP: {p} not found", file=sys.stderr)
            continue
        process_file(p)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
