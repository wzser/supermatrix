#!/usr/bin/env python3
"""Validate deployable canonical skill frontmatter with a real YAML parser."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:  # macOS system Python may not see user-site PyYAML under a temporary HOME
    yaml = None


DEPLOYABLE_SCOPES = {"shared", "claude-only", "codex-only"}
FRONTMATTER = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
    flags=re.DOTALL,
)
RUBY_SAFE_LOAD = """
require "json"
require "yaml"
value = YAML.safe_load(
  STDIN.read,
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false
)
STDOUT.write(JSON.generate(value))
"""


class FrontmatterParseError(ValueError):
    pass


def safe_load_yaml(block: str) -> object:
    if yaml is not None:
        try:
            return yaml.safe_load(block)
        except yaml.YAMLError as exc:
            raise FrontmatterParseError(str(exc)) from exc

    completed = subprocess.run(
        ["/usr/bin/ruby", "-e", RUBY_SAFE_LOAD],
        input=block,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise FrontmatterParseError(completed.stderr.strip())
    return json.loads(completed.stdout)


def deployable_names(index: Path) -> list[str]:
    names: list[str] = []
    for line in index.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5:
            continue
        name, origin, scope, _owner, _purpose = cells
        if origin == "skill-master" and scope in DEPLOYABLE_SCOPES:
            names.append(name)
    return names


def validate_skill(path: Path, expected_name: str) -> list[str]:
    if not path.is_file():
        return [f"missing SKILL.md: {path}"]
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"cannot read UTF-8 SKILL.md {path}: {exc}"]

    match = FRONTMATTER.match(text)
    if not match:
        return [f"missing YAML frontmatter delimiters: {path}"]
    try:
        metadata = safe_load_yaml(match.group(1))
    except FrontmatterParseError as exc:
        detail = str(exc).splitlines()[0]
        return [f"invalid YAML frontmatter in {path}: {detail}"]

    if not isinstance(metadata, dict):
        return [f"YAML frontmatter must be a mapping: {path}"]

    issues: list[str] = []
    name = metadata.get("name")
    description = metadata.get("description")
    if not isinstance(name, str) or not name.strip():
        issues.append(f"missing string frontmatter name: {path}")
    elif name != expected_name:
        issues.append(f"frontmatter name mismatch in {path}: {name!r} != {expected_name!r}")
    if not isinstance(description, str) or not description.strip():
        issues.append(f"missing string frontmatter description: {path}")
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, required=True)
    parser.add_argument("--index", type=Path, required=True)
    args = parser.parse_args()

    issues: list[str] = []
    for name in deployable_names(args.index):
        issues.extend(validate_skill(args.canonical / name / "SKILL.md", name))
    if issues:
        for issue in issues:
            print(f"ERROR: {issue}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
