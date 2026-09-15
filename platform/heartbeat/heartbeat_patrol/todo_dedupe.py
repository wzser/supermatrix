"""Stable problem-type keys used by patrol Todo registration."""

from __future__ import annotations

import re


_ROUND_SUFFIX_RE = re.compile(
    r"(?:[:#/])(?:run|attempt|instance|round|patrol|event|item|cycle)[-_][^:#/]+$",
    re.IGNORECASE,
)
_OPAQUE_INSTANCE_SUFFIX_RE = re.compile(
    r"(?:[:#/])(?:[0-9]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
    re.IGNORECASE,
)
_TYPE_MARKER_RE = re.compile(
    r"(?:heartbeat[_ -]problem[_ -]type|问题类型)\s*[:=：]\s*([^\s\n｜|;,；，]+)",
    re.IGNORECASE,
)
_SOURCE_ISSUE_RE = re.compile(r"(?:^|｜|\|)问题=([^\s｜|;,；，]+)")


def problem_type_from_logical_key(logical_key: str) -> str:
    """Remove only documented per-round instance suffixes from a logical key."""
    value = str(logical_key or "").strip()
    if not value:
        return ""
    while True:
        shortened = _ROUND_SUFFIX_RE.sub("", value)
        shortened = _OPAQUE_INSTANCE_SUFFIX_RE.sub("", shortened)
        if shortened == value:
            return value
        value = shortened


def problem_type_marker(problem_type: str) -> str:
    return f"问题类型：{problem_type_from_logical_key(problem_type)}"


def text_contains_problem_type(text: str, problem_type: str) -> bool:
    """Match both the new explicit marker and legacy source/key text."""
    candidate = problem_type_from_logical_key(problem_type)
    if not candidate:
        return False
    value = str(text or "")
    for match in _TYPE_MARKER_RE.finditer(value):
        if problem_type_from_logical_key(match.group(1)) == candidate:
            return True
    for match in _SOURCE_ISSUE_RE.finditer(value):
        if problem_type_from_logical_key(match.group(1)) == candidate:
            return True
    return candidate in value
