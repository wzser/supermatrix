#!/usr/bin/env python3
"""Sync skill-master/skills/INDEX.md → Feishu Bitable.

Strategy: enqueue an idempotent upsert batch by `Name` through wendangwang.
- Push all local skills every run (no change detection) — simple + correct for
  the tens-of-records scale.
- Do not delete remote records here; sync queue onboarding for this table is
  intentionally upsert-only.

Target table:
  app_token = F9F9bncWwaVzlRsZYs8csffQnB3  (Wiki → Bitable)
  table_id  = tblREDACTEDTABLEID
"""
import json
import os
import sys
import time
from pathlib import Path

from feishu_enqueue import enqueue_bitable_rows

REGISTRY_ASSET = "skill-master.registry.技能清单"

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "skills" / "INDEX.md"
CALL_LOG = ROOT / "metrics" / "call-log.jsonl"
SOURCE_REGISTRY = ROOT / "config" / "skill-upgrade-sources.json"
HOSTED_BY = "skill-master + wendangwang"

VALID_ORIGINS = {"skill-master", "claude-builtin", "codex-builtin"}
VALID_SCOPES = {"shared", "claude-only", "codex-only", "inventory-only"}


def parse_index():
    if not INDEX.exists():
        print(f"ERROR: INDEX.md missing at {INDEX}", file=sys.stderr)
        sys.exit(1)
    text = INDEX.read_text(encoding="utf-8")
    parts = text.split("## Skills", 1)
    if len(parts) < 2:
        return []
    rows = []
    for line in parts[1].splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5:
            continue
        name, origin, scope, owner, purpose = cells[0], cells[1], cells[2], cells[3], cells[4]
        if origin not in VALID_ORIGINS or scope not in VALID_SCOPES:
            continue
        rows.append({
            "Name": name,
            "Origin": origin,
            "Scope": scope,
            "Owner": owner,
            "Purpose": purpose,
        })
    return rows


def aggregate_calls():
    counts = {}
    if not CALL_LOG.exists():
        return counts
    with CALL_LOG.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            name = rec.get("skill")
            if not name:
                continue
            counts[name] = counts.get(name, 0) + 1
    return counts


def load_upgrade_metadata():
    metadata = {}
    if not SOURCE_REGISTRY.exists():
        return metadata
    try:
        registry = json.loads(SOURCE_REGISTRY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid source registry JSON: {SOURCE_REGISTRY}: {exc}") from exc

    for package in registry.get("packages", []):
        if not package.get("enabled", False):
            continue
        repo = package.get("repo", "")
        policy = package.get("policy", "")
        package_id = package.get("id", "")
        for mapping in package.get("mappings", []):
            local = mapping.get("local")
            if not local:
                continue
            metadata[local] = {
                "AutoUpgrade": "yes",
                "UpgradePolicy": policy,
                "GitHubRepo": repo,
                "UpstreamPath": mapping.get("source", ""),
                "UpgradeState": "enabled",
                "RegistrySource": f"skills/INDEX.md + {SOURCE_REGISTRY.relative_to(ROOT)}#{package_id}",
                "HostedBy": HOSTED_BY,
            }
        for local in package.get("unmatched_local", []):
            metadata.setdefault(local, {
                "AutoUpgrade": "no",
                "UpgradePolicy": f"unmatched-local:{policy}",
                "GitHubRepo": repo,
                "UpstreamPath": "",
                "UpgradeState": "source-unmatched",
                "RegistrySource": f"skills/INDEX.md + {SOURCE_REGISTRY.relative_to(ROOT)}#{package_id}",
                "HostedBy": HOSTED_BY,
            })
    return metadata


def default_upgrade_metadata(row):
    if row["Origin"] != "skill-master":
        state = "builtin-or-external-inventory"
        policy = f"excluded:{row['Origin']}"
    elif row["Owner"] == "mattpocock":
        state = "needs-source-mapping"
        policy = "excluded:unmapped-external-skill"
    else:
        state = "self-built-or-owner-specific"
        policy = "excluded:local"
    return {
        "AutoUpgrade": "no",
        "UpgradePolicy": policy,
        "GitHubRepo": "",
        "UpstreamPath": "",
        "UpgradeState": state,
        "RegistrySource": "skills/INDEX.md",
        "HostedBy": HOSTED_BY,
    }


def main():
    local = parse_index()
    calls = aggregate_calls()
    upgrade_metadata = load_upgrade_metadata()

    now_ms = int(time.time() * 1000)
    rows = []

    for row in local:
        name = row["Name"]
        payload = {
            **row,
            **default_upgrade_metadata(row),
            **upgrade_metadata.get(name, {}),
            "Updated": now_ms,
            "Calls": calls.get(name, 0),
        }
        rows.append(payload)

    receipt = enqueue_bitable_rows(REGISTRY_ASSET, rows, key_suffix="sync-skills-to-feishu")
    drained = receipt.get("drained", {})
    print(
        f"local={len(local)} | enqueued_rows={receipt['rows']} "
        f"job_id={receipt.get('job_id')} duplicate={receipt.get('duplicate')} "
        f"drained_done={drained.get('done', 0)} drained_failed={drained.get('failed', 0)} "
        f"read_back_verified={receipt.get('read_back_verified')} "
        f"rows={receipt.get('rows_path')} receipt={receipt['receipt_path']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
