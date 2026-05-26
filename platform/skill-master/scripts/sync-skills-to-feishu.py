#!/usr/bin/env python3
"""Sync skill-master/skills/INDEX.md → Feishu Bitable.

Strategy: upsert by `Name` (unique key) + orphan cleanup.
- Never cache record_id locally; always list remote fresh.
- Push all local skills every run (no change detection) — simple + correct for
  the tens-of-records scale.
- Delete remote records whose Name is not in the local INDEX.

Required environment:
  SKILL_MASTER_FEISHU_BASE_TOKEN
  SKILL_MASTER_FEISHU_TABLE_ID
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

APP_TOKEN = os.environ.get("SKILL_MASTER_FEISHU_BASE_TOKEN", "")
TABLE_ID = os.environ.get("SKILL_MASTER_FEISHU_TABLE_ID", "")
LARK_CLI = os.environ.get("SKILL_MASTER_LARK_CLI_PATH") or os.environ.get("SM_LARK_CLI_PATH") or "lark-cli"

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "skills" / "INDEX.md"
CALL_LOG = ROOT / "metrics" / "call-log.jsonl"

VALID_ORIGINS = {"skill-master", "claude-builtin", "codex-builtin"}
VALID_SCOPES = {"shared", "claude-only", "codex-only", "inventory-only"}


def lark(*args):
    result = subprocess.run([LARK_CLI, *args], capture_output=True, text=True)
    for out in (result.stdout, result.stderr):
        if not out:
            continue
        try:
            resp = json.loads(out)
        except json.JSONDecodeError:
            continue
        if not resp.get("ok", True):
            print(f"  lark-cli error: {resp.get('error', {}).get('message', 'unknown')}", file=sys.stderr)
        return resp
    return {}


def require_feishu_config():
    missing = []
    if not APP_TOKEN:
        missing.append("SKILL_MASTER_FEISHU_BASE_TOKEN")
    if not TABLE_ID:
        missing.append("SKILL_MASTER_FEISHU_TABLE_ID")
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(2)


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


def list_remote():
    records = []
    offset = 0
    while True:
        resp = lark(
            "base", "+record-list",
            "--base-token", APP_TOKEN,
            "--table-id", TABLE_ID,
            "--as", "user",
            "--format", "json",
            "--limit", "100",
            "--offset", str(offset),
        )
        data = resp.get("data", {})
        rows = data.get("data", [])
        rids = data.get("record_id_list", [])
        fields_order = data.get("fields", [])
        has_more = data.get("has_more", False)
        for i, row in enumerate(rows):
            rec = {"record_id": rids[i]}
            for j, fname in enumerate(fields_order):
                rec[fname] = row[j] if j < len(row) else None
            records.append(rec)
        offset += len(rows)
        if not has_more or not rows:
            break
    return records


def upsert(fields, record_id=None):
    args = [
        "base", "+record-upsert",
        "--base-token", APP_TOKEN,
        "--table-id", TABLE_ID,
        "--as", "user",
        "--json", json.dumps(fields, ensure_ascii=False),
    ]
    if record_id:
        args += ["--record-id", record_id]
    return lark(*args)


def delete(record_id):
    return lark(
        "base", "+record-delete",
        "--base-token", APP_TOKEN,
        "--table-id", TABLE_ID,
        "--as", "user",
        "--record-id", record_id,
        "--yes",
    )


def main():
    require_feishu_config()
    local = parse_index()
    local_names = {r["Name"] for r in local}
    calls = aggregate_calls()

    remote = list_remote()
    remote_by_name = {}
    empty_name_ids = []
    for rec in remote:
        name = rec.get("Name") or ""
        if name:
            remote_by_name.setdefault(name, []).append(rec)
        else:
            empty_name_ids.append(rec["record_id"])

    now_ms = int(time.time() * 1000)
    created = updated = deleted = 0

    for row in local:
        name = row["Name"]
        payload = {**row, "Updated": now_ms, "Calls": calls.get(name, 0)}
        if name in remote_by_name:
            recs = remote_by_name[name]
            keep = recs[0]
            resp = upsert(payload, record_id=keep["record_id"])
            if resp.get("ok"):
                updated += 1
            for dup in recs[1:]:
                if delete(dup["record_id"]).get("ok"):
                    deleted += 1
        else:
            resp = upsert(payload)
            if resp.get("ok"):
                created += 1

    for name, recs in remote_by_name.items():
        if name in local_names:
            continue
        for rec in recs:
            if delete(rec["record_id"]).get("ok"):
                deleted += 1

    for rid in empty_name_ids:
        if delete(rid).get("ok"):
            deleted += 1

    total = created + updated + deleted
    print(f"local={len(local)} remote={len(remote)} | created={created} updated={updated} deleted={deleted}")
    return 0 if total == 0 or (created + updated) == len(local) else 0


if __name__ == "__main__":
    sys.exit(main())
