#!/usr/bin/env python3
"""Fetch YouTube video metadata + transcript; emit a KB-ready markdown body.

Usage:
  python3 scripts/fetch-transcript.py <youtube-url-or-id> [--lang en,zh-Hans,zh-Hant]

Output to stdout is a single markdown document:

  # <title>

  **Channel:** <channel>
  **Upload date:** <YYYY-MM-DD>
  **Duration:** <H:MM:SS>
  **Source URL:** <url>
  **Transcript language:** <lang> (auto-generated|manual|unavailable)

  ## Description
  <description>

  ## Transcript
  <plain-text transcript with timestamps stripped>

If transcript is unavailable, the Transcript section contains a single line
`_transcript unavailable: <reason>_` and the script exits 2 so the caller can
treat the source as `content_type: unreachable`.

Fetch strategy (in order):
  1. yt-dlp with no cookies (works for most videos without geo-block / age-gate)
  2. yt-dlp --cookies-from-browser chrome/firefox (for videos that now require
     YouTube's anti-bot check)
  3. youtube-transcript-api as a last-resort transcript-only fallback

Metadata is always taken from yt-dlp when any of (1)/(2) succeed; if only (3)
works we fall back to oEmbed for title/channel and leave upload_date unknown.

Requires: yt-dlp (pip3 install --user yt-dlp), optional youtube-transcript-api.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path


YTDLP = os.path.expanduser("~/Library/Python/3.9/bin/yt-dlp")
if not Path(YTDLP).exists():
    from shutil import which
    YTDLP = which("yt-dlp") or "yt-dlp"


def extract_id(arg: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", arg):
        return arg
    p = urllib.parse.urlparse(arg)
    if p.hostname in ("youtu.be",):
        return p.path.lstrip("/")
    if p.hostname and "youtube.com" in p.hostname:
        qs = urllib.parse.parse_qs(p.query)
        if "v" in qs:
            return qs["v"][0]
        m = re.search(r"/(shorts|embed|live)/([A-Za-z0-9_-]{11})", p.path)
        if m:
            return m.group(2)
    sys.exit(f"ERROR: could not parse YouTube video id from: {arg}")


def run_ytdlp(url: str, cookies_browser: str | None, languages: list[str]) -> tuple[dict | None, str | None, str | None]:
    """Return (metadata_dict, transcript_text, error_reason)."""
    cmd = [YTDLP, "-J", "--skip-download",
           "--write-auto-sub", "--write-sub",
           "--sub-lang", ",".join(languages),
           "--sub-format", "vtt",
           "--output", "/tmp/kb-yt/%(id)s.%(ext)s",
           url]
    if cookies_browser:
        cmd[1:1] = ["--cookies-from-browser", cookies_browser]
    Path("/tmp/kb-yt").mkdir(parents=True, exist_ok=True)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return None, None, "yt-dlp timeout (90s)"
    if out.returncode != 0:
        last_err = out.stderr.strip().splitlines()[-1] if out.stderr else "unknown"
        return None, None, f"yt-dlp exit {out.returncode}: {last_err}"
    try:
        meta = json.loads(out.stdout)
    except json.JSONDecodeError as e:
        return None, None, f"yt-dlp json parse: {e}"
    vid = meta.get("id", "")
    transcript = None
    for lang in languages:
        vtt = Path(f"/tmp/kb-yt/{vid}.{lang}.vtt")
        if vtt.exists():
            transcript = vtt_to_plain(vtt.read_text(encoding="utf-8"))
            break
    return meta, transcript, None


def run_transcript_api(video_id: str, languages: list[str]) -> tuple[str | None, str | None]:
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return None, "youtube-transcript-api not installed"
    try:
        api = YouTubeTranscriptApi()
        transcript = api.fetch(video_id, languages=languages)
    except Exception as exc:
        msg = str(exc).splitlines()[0] if str(exc) else type(exc).__name__
        return None, f"transcript-api: {msg[:200]}"
    parts = []
    for entry in transcript:
        if hasattr(entry, "text"):
            parts.append(entry.text)
        elif isinstance(entry, dict):
            parts.append(entry.get("text", ""))
    text = " ".join(parts).strip()
    return text if text else None, None if text else "empty transcript"


def vtt_to_plain(vtt: str) -> str:
    lines = []
    for line in vtt.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if "-->" in line:
            continue
        if re.fullmatch(r"\d+", line):
            continue
        line = re.sub(r"<[^>]+>", "", line)
        if lines and line == lines[-1]:
            continue
        lines.append(line)
    return " ".join(lines)


def fetch_oembed(url: str) -> dict | None:
    try:
        q = urllib.parse.urlencode({"url": url, "format": "json"})
        with urllib.request.urlopen(f"https://www.youtube.com/oembed?{q}", timeout=10) as r:
            return json.loads(r.read())
    except Exception:
        return None


def render(meta: dict | None, transcript: str | None, url: str, transcript_err: str | None) -> str:
    if meta:
        title = meta.get("title") or "(unknown title)"
        channel = meta.get("channel") or meta.get("uploader") or "(unknown channel)"
        upload = meta.get("upload_date") or ""
        if upload and len(upload) == 8:
            upload = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}"
        duration = meta.get("duration") or 0
        desc = (meta.get("description") or "").strip()
    else:
        embed = fetch_oembed(url) or {}
        title = embed.get("title", "(unknown title)")
        channel = embed.get("author_name", "(unknown channel)")
        upload = ""
        duration = 0
        desc = ""

    dur_hms = ""
    if duration:
        h, rem = divmod(int(duration), 3600)
        m, s = divmod(rem, 60)
        dur_hms = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"

    lines = [f"# {title}", "",
             f"**Channel:** {channel}",
             f"**Upload date:** {upload or 'unknown'}",
             f"**Duration:** {dur_hms or 'unknown'}",
             f"**Source URL:** {url}",
             ""]

    if desc:
        lines += ["## Description", "", desc, ""]

    lines += ["## Transcript", ""]
    if transcript:
        lines += [transcript, ""]
    else:
        reason = transcript_err or "no transcript available"
        lines += [f"_transcript unavailable: {reason}_", ""]

    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--lang", default="en,zh-Hans,zh-Hant,zh",
                        help="Comma-separated subtitle language preference")
    args = parser.parse_args()

    vid = extract_id(args.url)
    url = f"https://www.youtube.com/watch?v={vid}"
    languages = [s.strip() for s in args.lang.split(",") if s.strip()]

    meta = None
    transcript = None
    errors: list[str] = []

    for cookies in (None, "chrome", "firefox"):
        m, t, err = run_ytdlp(url, cookies, languages)
        if m:
            meta, transcript = m, t
            if t:
                break
            errors.append(f"yt-dlp({cookies or 'no-cookies'}): got meta but no transcript")
        elif err:
            errors.append(f"yt-dlp({cookies or 'no-cookies'}): {err[:200]}")
            if "Sign in to confirm" not in err and cookies is None:
                break

    if not transcript:
        t, err = run_transcript_api(vid, languages)
        if t:
            transcript = t
        elif err:
            errors.append(err)

    sys.stdout.write(render(meta, transcript, url, "; ".join(errors) if errors else None))
    return 0 if transcript else 2


if __name__ == "__main__":
    sys.exit(main())
