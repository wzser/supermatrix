from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SYNC_SCRIPT = ROOT / "scripts" / "sync-skills.sh"
VALIDATOR = ROOT / "scripts" / "validate-skill-frontmatter.py"


def write_index(path: Path, name: str, scope: str = "shared") -> None:
    path.write_text(
        "\n".join(
            [
                "# Skill Registry",
                "",
                "| Name | Origin | Scope | Owner | Purpose |",
                "|---|---|---|---|---|",
                f"| {name} | skill-master | {scope} | skill-master | test fixture |",
                "",
            ]
        ),
        encoding="utf-8",
    )


def run_validator(tmp_path: Path, skill_text: str) -> subprocess.CompletedProcess[str]:
    canonical = tmp_path / "canonical"
    skill_dir = canonical / "sample"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(skill_text, encoding="utf-8")
    index = tmp_path / "INDEX.md"
    write_index(index, "sample")
    return subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--canonical",
            str(canonical),
            "--index",
            str(index),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_validator_rejects_frontmatter_that_has_fields_but_is_not_valid_yaml(tmp_path: Path) -> None:
    result = run_validator(
        tmp_path,
        """---
name: sample
description: Coordinates sibling sessions: dispatch and acceptance.
---
""",
    )

    assert result.returncode != 0
    assert "invalid YAML frontmatter" in result.stderr


def test_validator_accepts_quoted_yaml_description(tmp_path: Path) -> None:
    result = run_validator(
        tmp_path,
        """---
name: sample
description: "Coordinates sibling sessions: dispatch and acceptance."
---
""",
    )

    assert result.returncode == 0, result.stderr


def test_sync_runs_yaml_preflight_before_any_discovery_path_mutation() -> None:
    text = SYNC_SCRIPT.read_text(encoding="utf-8")

    preflight = text.index('python3 "$FRONTMATTER_VALIDATOR"')
    first_mutation = text.index('mkdir -p "$CLAUDE_DIR"')
    assert preflight < first_mutation
    assert 'ln -sfn "$src" "$KIMI_NATIVE_DIR/$name"' in text
    assert 'ln -sfn "$src" "$KIMI_LEGACY_DIR/$name"' in text
