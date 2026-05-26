#!/usr/bin/env python3
"""Periodic skill-usage evaluation (every ~3 days).

What it does, in order:
  1. Aggregate metrics/call-log.jsonl → per-skill counts (total, 3d window, top sessions).
  2. Upsert to Feishu SkillCallCounts (orphan cleanup for skills removed from INDEX).
  3. Fan out to every active sibling session (from CONSTITUTION.md) asking for
     problem reports about skill usage in the last 3 days. Parse replies.
  4. Append issues to metrics/issues.jsonl + upsert to Feishu SkillIssues.
  5. Write a review report to metrics/reviews/<utc-date>.md.

Usage:
  evaluate-skills.py                      # aggregate + fanout + write review
  evaluate-skills.py --no-fanout          # aggregate + write review only
  evaluate-skills.py --sessions foo,bar   # fan out only to these sessions
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONSTITUTION = ROOT / "CONSTITUTION.md"
LOG = ROOT / "metrics" / "call-log.jsonl"
ISSUES_LOG = ROOT / "metrics" / "issues.jsonl"
REVIEWS_DIR = ROOT / "metrics" / "reviews"
LAST_RUN = ROOT / "metrics" / "last-run.txt"

APP_TOKEN = os.environ.get("SKILL_MASTER_FEISHU_BASE_TOKEN", "")
COUNTS_TID = os.environ.get("SKILL_MASTER_CALL_COUNTS_TABLE_ID", "")
ISSUES_TID = os.environ.get("SKILL_MASTER_ISSUES_TABLE_ID", "")
SKILLS_TID = os.environ.get("SKILL_MASTER_FEISHU_TABLE_ID", "")
LARK_CLI = os.environ.get("SKILL_MASTER_LARK_CLI_PATH") or os.environ.get("SM_LARK_CLI_PATH") or "lark-cli"

SPAWN_URL = "http://localhost:3501/api/spawn"
SELF = "skill-master"
WINDOW_HOURS = 72
SPAWN_TIMEOUT_S = 240
FANOUT_PARALLEL = 6

QUESTION_PROMPT = """skill-master 每 3 天一次的 skill 使用评估。

过去 3 天你是否使用 / 触发了任何 skill（不限 skill-master 维护的，原生 claude / codex skill 也算）？使用过程中遇到的任何问题 —— 触发不准确、output 不对、报错、卡死、文档缺失、跟别的 skill 冲突 —— 都请按下面格式列出。没有问题就只回 `NONE`。

格式（每行一个问题，字段用 ` | ` 分隔，共 4 段）:
```
<skill-name> | <severity: info|bug|suggestion> | <one-line title> | <detailed description>
```

示例:
```
web-access | bug | CDP 连接偶尔 timeout | 在切换 amzh10 pack 时，约 1/5 的请求 chrome 连接超时，要手动 retry。
```

严格要求:
- 不要寒暄、不要解释、不要反问。
- 没问题就只回 NONE；有问题就只回问题行（可多行），不要加任何前后缀。
"""


def lark(*args):
    result = subprocess.run([LARK_CLI, *args], capture_output=True, text=True)
    for out in (result.stdout, result.stderr):
        if not out:
            continue
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            continue
    return {}


def require_feishu_config():
    missing = []
    for name, value in (
        ("SKILL_MASTER_FEISHU_BASE_TOKEN", APP_TOKEN),
        ("SKILL_MASTER_CALL_COUNTS_TABLE_ID", COUNTS_TID),
        ("SKILL_MASTER_ISSUES_TABLE_ID", ISSUES_TID),
        ("SKILL_MASTER_FEISHU_TABLE_ID", SKILLS_TID),
    ):
        if not value:
            missing.append(name)
    if missing:
        raise SystemExit(f"Missing required env vars: {', '.join(missing)}")


def parse_sessions():
    if not CONSTITUTION.exists():
        return []
    text = CONSTITUTION.read_text(encoding="utf-8")
    m = re.search(r"## Other Active Sessions\s*\n(.+?)(?=\n---)", text, re.DOTALL)
    if not m:
        return []
    sessions = []
    for line in m.group(1).splitlines():
        m2 = re.match(r"-\s+\*\*([^*]+)\*\*", line)
        if m2:
            name = m2.group(1).strip()
            if name and name != SELF:
                sessions.append(name)
    return sessions


def aggregate_calls():
    agg = {}
    if not LOG.exists():
        return agg
    cutoff = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HOURS)
    with LOG.open() as f:
        for line in f:
            try:
                rec = json.loads(line)
            except Exception:
                continue
            skill = rec.get("skill") or ""
            if not skill:
                continue
            try:
                t = datetime.fromisoformat(rec.get("ts", "").replace("Z", "+00:00"))
            except Exception:
                t = None
            a = agg.setdefault(skill, {"total": 0, "window": 0, "last": None, "sessions": {}})
            a["total"] += 1
            if t and t >= cutoff:
                a["window"] += 1
            if t and (a["last"] is None or t > a["last"]):
                a["last"] = t
            s = rec.get("session") or "unknown"
            a["sessions"][s] = a["sessions"].get(s, 0) + 1
    return agg


def top_sessions_str(sessions, n=3):
    items = sorted(sessions.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return ", ".join(f"{k}({v})" for k, v in items)


def list_remote(table_id, key_field):
    records = []
    offset = 0
    while True:
        resp = lark(
            "base", "+record-list",
            "--base-token", APP_TOKEN,
            "--table-id", table_id,
            "--as", "user",
            "--limit", "100",
            "--offset", str(offset),
        )
        data = resp.get("data", {})
        rows = data.get("data", [])
        rids = data.get("record_id_list", [])
        fields = data.get("fields", [])
        has_more = data.get("has_more", False)
        for i, row in enumerate(rows):
            rec = {"record_id": rids[i]}
            for j, fname in enumerate(fields):
                rec[fname] = row[j] if j < len(row) else None
            records.append(rec)
        offset += len(rows)
        if not has_more or not rows:
            break
    by_key = {}
    for r in records:
        by_key.setdefault(r.get(key_field) or "", []).append(r)
    return records, by_key


def upsert(table_id, fields, record_id=None):
    args = [
        "base", "+record-upsert",
        "--base-token", APP_TOKEN,
        "--table-id", table_id,
        "--as", "user",
        "--json", json.dumps(fields, ensure_ascii=False),
    ]
    if record_id:
        args += ["--record-id", record_id]
    return lark(*args)


def delete_rec(table_id, record_id):
    return lark(
        "base", "+record-delete",
        "--base-token", APP_TOKEN,
        "--table-id", table_id,
        "--as", "user",
        "--record-id", record_id,
        "--yes",
    )


def push_call_counts(agg):
    _, by_name = list_remote(COUNTS_TID, "Name")
    now_ms = int(time.time() * 1000)
    created = updated = deleted = 0
    for skill, a in agg.items():
        payload = {
            "Name": skill,
            "Calls": a["total"],
            "Calls_3d": a["window"],
            "TopSessions": top_sessions_str(a["sessions"]),
            "Updated": now_ms,
        }
        if a["last"]:
            payload["LastCalled"] = int(a["last"].timestamp() * 1000)
        recs = by_name.get(skill, [])
        if recs:
            resp = upsert(COUNTS_TID, payload, record_id=recs[0]["record_id"])
            if resp.get("ok"):
                updated += 1
            for dup in recs[1:]:
                if delete_rec(COUNTS_TID, dup["record_id"]).get("ok"):
                    deleted += 1
        else:
            if upsert(COUNTS_TID, payload).get("ok"):
                created += 1
    for name, recs in by_name.items():
        if name and name not in agg:
            for r in recs:
                if delete_rec(COUNTS_TID, r["record_id"]).get("ok"):
                    deleted += 1
    return created, updated, deleted


def spawn(session, prompt, timeout_s=SPAWN_TIMEOUT_S):
    body = json.dumps({"from": "skill-master", "target": session, "prompt": prompt}).encode()
    req = urllib.request.Request(SPAWN_URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
            if not data.get("ok", True):
                return None, data.get("error") or "spawn not ok"
            return data.get("finalMessage") or "", None
    except Exception as e:
        return None, str(e)


ISSUE_LINE = re.compile(r"^\s*([^|]+?)\s*\|\s*(info|bug|suggestion)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$")


def parse_issues(session, text):
    out = []
    if not text:
        return out
    stripped = text.strip()
    if stripped.upper().startswith("NONE"):
        return out
    for line in stripped.splitlines():
        line = line.strip().strip("`").strip()
        if not line or line.startswith("#"):
            continue
        m = ISSUE_LINE.match(line)
        if not m:
            continue
        skill, sev, title, desc = m.group(1), m.group(2), m.group(3), m.group(4)
        out.append({
            "Skill": skill[:80],
            "Session": session,
            "Severity": sev,
            "Title": title[:200],
            "Description": desc[:2000],
            "Status": "open",
            "ReportedAt": int(time.time() * 1000),
        })
    return out


def push_issues(issues):
    if not issues:
        return 0
    ISSUES_LOG.parent.mkdir(parents=True, exist_ok=True)
    pushed = 0
    with ISSUES_LOG.open("a") as f:
        for issue in issues:
            if upsert(ISSUES_TID, issue).get("ok"):
                pushed += 1
            f.write(json.dumps(issue, ensure_ascii=False) + "\n")
    return pushed


def write_review(agg, session_results, issues):
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    path = REVIEWS_DIR / f"{today}.md"
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [f"# Skill usage review — {now_iso}", ""]

    lines.append("## Call counts")
    lines.append("")
    lines.append("| Skill | Calls (3d) | Calls (total) | Last called | Top sessions |")
    lines.append("|---|---:|---:|---|---|")
    rows = sorted(agg.items(), key=lambda kv: (kv[1]["window"], kv[1]["total"]), reverse=True)
    for skill, a in rows:
        last = a["last"].isoformat(timespec="seconds") if a["last"] else "—"
        lines.append(f"| {skill} | {a['window']} | {a['total']} | {last} | {top_sessions_str(a['sessions'])} |")
    if not rows:
        lines.append("| _(no ticks recorded)_ |  |  |  |  |")

    lines.append("")
    lines.append(f"## Sessions polled ({len(session_results)})")
    lines.append("")
    for s, status, n_issues in session_results:
        lines.append(f"- {status} **{s}** — {n_issues} issue(s)")

    lines.append("")
    lines.append(f"## Issues collected ({len(issues)})")
    lines.append("")
    if issues:
        lines.append("| Skill | Session | Severity | Title |")
        lines.append("|---|---|---|---|")
        for i in issues:
            lines.append(f"| {i['Skill']} | {i['Session']} | {i['Severity']} | {i['Title']} |")
    else:
        lines.append("_(none reported)_")

    path.write_text("\n".join(lines) + "\n")
    return path


def fanout(sessions):
    results = []
    all_issues = []
    if not sessions:
        return results, all_issues
    with ThreadPoolExecutor(max_workers=FANOUT_PARALLEL) as ex:
        futures = {ex.submit(spawn, s, QUESTION_PROMPT): s for s in sessions}
        for fut in as_completed(futures):
            s = futures[fut]
            reply, err = fut.result()
            if err:
                print(f"  ✗ {s}: {err}", file=sys.stderr)
                results.append((s, "✗", 0))
                continue
            issues = parse_issues(s, reply)
            print(f"  ✓ {s}: {len(issues)} issue(s)")
            results.append((s, "✓", len(issues)))
            all_issues.extend(issues)
    return results, all_issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fanout", action="store_true", help="skip the session polling step")
    ap.add_argument("--sessions", type=str, default=None, help="comma-separated session list override")
    args = ap.parse_args()

    agg = aggregate_calls()
    print(f"[1/3] aggregated {len(agg)} skills across {sum(a['total'] for a in agg.values())} calls")

    require_feishu_config()
    c, u, d = push_call_counts(agg)
    print(f"[2/3] CallCounts sync: created={c} updated={u} deleted={d}")

    session_results = []
    all_issues = []
    if not args.no_fanout:
        if args.sessions:
            sessions = [s.strip() for s in args.sessions.split(",") if s.strip()]
        else:
            sessions = parse_sessions()
        print(f"[3/3] fanout to {len(sessions)} sessions")
        session_results, all_issues = fanout(sessions)
        n_pushed = push_issues(all_issues)
        print(f"  pushed {n_pushed}/{len(all_issues)} issues to Feishu")
    else:
        print("[3/3] fanout skipped")

    path = write_review(agg, session_results, all_issues)
    print(f"review: {path}")

    LAST_RUN.parent.mkdir(parents=True, exist_ok=True)
    LAST_RUN.write_text(datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n")


if __name__ == "__main__":
    main()
