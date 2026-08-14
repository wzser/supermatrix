#!/usr/bin/env python3
"""Detect silent death in the skill evaluation pipeline."""

import argparse
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAST_RUN = ROOT / "metrics" / "last-run.txt"
REVIEWS_DIR = ROOT / "metrics" / "reviews"
ISSUE_LIFECYCLE_EVENTS = ROOT / "metrics" / "issue-lifecycle-events.jsonl"
ISSUE_LIFECYCLE = ROOT / "metrics" / "issue-lifecycle.jsonl"
ISSUE_FOLLOWUPS = ROOT / "metrics" / "issue-followups.jsonl"
OWNER_RESOLUTION_ESCALATIONS = ROOT / "metrics" / "owner-resolution-escalations.jsonl"
ISSUE_BACKLOG_TREND = ROOT / "metrics" / "issue-backlog-trend.jsonl"
FEISHU_RECEIPTS = ROOT / "metrics" / "feishu-sync-receipts.ndjson"
ALERTS = ROOT / "metrics" / "evaluate-health-alerts.jsonl"
SPAWN_URL = "http://localhost:3501/api/spawn2.0"
COUNTS_ASSET = "skill-master.metrics.Skill调用计数"
ISSUES_ASSET = "skill-master.issue.Skill问题池"
READBACK_PENDING_GRACE_SECONDS = 30 * 60
TERMINAL_LIFECYCLES = {"resolved", "closed", "downgraded"}
PROGRESS_EVENTS = {"fix_submitted", "recheck_passed"}


def newest_review_mtime():
    if not REVIEWS_DIR.exists():
        return None
    mtimes = [p.stat().st_mtime for p in REVIEWS_DIR.glob("*.md") if p.is_file()]
    return max(mtimes) if mtimes else None


def newest_review_path():
    if not REVIEWS_DIR.exists():
        return None
    paths = [p for p in REVIEWS_DIR.glob("*.md") if p.is_file()]
    return max(paths, key=lambda p: p.stat().st_mtime) if paths else None


def last_run_mtime():
    return LAST_RUN.stat().st_mtime if LAST_RUN.exists() else None


def iso(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def latest_counts_receipt():
    if not FEISHU_RECEIPTS.exists():
        return None
    latest = None
    with FEISHU_RECEIPTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("asset_id") == COUNTS_ASSET:
                latest = record
    return latest


def latest_asset_receipt(asset_id):
    if not FEISHU_RECEIPTS.exists():
        return None
    latest = None
    with FEISHU_RECEIPTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("asset_id") == asset_id:
                latest = record
    return latest


def receipt_ts(record):
    if not isinstance(record, dict) or not record.get("ts"):
        return None
    try:
        return datetime.fromisoformat(str(record["ts"]).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def recent_pending_receipt_has_verified_predecessor(asset_id, latest, grace_seconds=READBACK_PENDING_GRACE_SECONDS):
    latest_ts = receipt_ts(latest)
    if latest_ts is None or time.time() - latest_ts > grace_seconds:
        return False
    if not FEISHU_RECEIPTS.exists():
        return False
    with FEISHU_RECEIPTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record is latest:
                continue
            if record.get("asset_id") == asset_id and record.get("read_back_verified") is True:
                return True
    return False


def asset_readback_ok(asset_id):
    receipt = latest_asset_receipt(asset_id)
    if not receipt:
        return False
    return (
        receipt.get("read_back_verified") is True
        or recent_pending_receipt_has_verified_predecessor(asset_id, receipt)
    )


def parse_sessions_polled(text):
    match = re.search(r"^## Sessions polled \((\d+)\)", text, flags=re.MULTILINE)
    return int(match.group(1)) if match else None


def parse_fanout_selected(text):
    match = re.search(r"^- Selected: (\d+) / (\d+)", text, flags=re.MULTILINE)
    if not match:
        return None, None
    return int(match.group(1)), int(match.group(2))


def parse_review_number(text, label):
    match = re.search(rf"^- {re.escape(label)}: (\d+)", text, flags=re.MULTILINE)
    return int(match.group(1)) if match else None


def lifecycle_counts():
    now_ms = int(time.time() * 1000)
    counts = {
        "total": 0,
        "open": 0,
        "resolved": 0,
        "owner_ack_pending": 0,
        "owner_ack_pending_overdue": 0,
        "owner_acknowledged": 0,
        "owner_rejected": 0,
        "owner_acknowledged_overdue": 0,
        "fix_submitted": 0,
        "recheck_failed": 0,
        "recheck_passed": 0,
    }
    if not ISSUE_LIFECYCLE.exists():
        return counts
    with ISSUE_LIFECYCLE.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            counts["total"] += 1
            if record.get("Status") in TERMINAL_LIFECYCLES:
                counts["resolved"] += 1
            else:
                counts["open"] += 1
            if record.get("Lifecycle") == "owner_ack_pending":
                counts["owner_ack_pending"] += 1
                if (record.get("NextReviewAt") or 0) <= now_ms:
                    counts["owner_ack_pending_overdue"] += 1
            if record.get("Lifecycle") == "owner_acknowledged":
                counts["owner_acknowledged"] += 1
            if record.get("LastLifecycleEvent") == "owner_rejected":
                counts["owner_rejected"] += 1
            if record.get("Lifecycle") == "owner_acknowledged" and (record.get("NextReviewAt") or 0) <= now_ms:
                counts["owner_acknowledged_overdue"] += 1
            if record.get("Lifecycle") == "fix_submitted":
                counts["fix_submitted"] += 1
            if record.get("Lifecycle") == "recheck_failed":
                counts["recheck_failed"] += 1
            if record.get("Lifecycle") == "recheck_passed":
                counts["recheck_passed"] += 1
    return counts


def recent_lifecycle_progress(window_hours=72):
    if not ISSUE_LIFECYCLE_EVENTS.exists():
        return 0
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    count = 0
    with ISSUE_LIFECYCLE_EVENTS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("At", 0) >= cutoff and record.get("Event") in PROGRESS_EVENTS:
                count += 1
    return count


def recent_owner_ack_pushes(window_hours=72):
    if not ISSUE_FOLLOWUPS.exists():
        return 0
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    count = 0
    with ISSUE_FOLLOWUPS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") in {"owner_ack_handoff_sent", "owner_ack_self_recorded", "owner_ack_external_recorded"}:
                count += 1
    return count


def recent_owner_ack_handoff_failures(window_hours=72):
    if not ISSUE_FOLLOWUPS.exists():
        return 0
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    latest_by_issue = {}
    with ISSUE_FOLLOWUPS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("At", 0) < cutoff:
                continue
            action = record.get("Action")
            if action not in {
                "owner_ack_handoff_failed",
                "owner_ack_handoff_sent",
                "owner_ack_self_recorded",
                "owner_ack_external_recorded",
                "owner_ack_consumed",
                "owner_reject_consumed",
            }:
                continue
            keys = record.get("IssueKeys") or ([record["IssueKey"]] if record.get("IssueKey") else [])
            for key in keys:
                previous = latest_by_issue.get(key)
                if previous is None or record.get("At", 0) >= previous.get("At", 0):
                    latest_by_issue[key] = record
    return sum(1 for record in latest_by_issue.values() if record.get("Action") == "owner_ack_handoff_failed")


def recent_owner_resolution_escalations(window_hours=72):
    if not OWNER_RESOLUTION_ESCALATIONS.exists():
        return 0
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    count = 0
    with OWNER_RESOLUTION_ESCALATIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") == "owner_resolution_escalation_sent":
                count += 1
    return count


def recent_owner_resolution_escalation_failures(window_hours=72):
    if not OWNER_RESOLUTION_ESCALATIONS.exists():
        return 0
    cutoff = int((time.time() - window_hours * 3600) * 1000)
    latest_by_issue = {}
    with OWNER_RESOLUTION_ESCALATIONS.open(encoding="utf-8") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("At", 0) < cutoff:
                continue
            if record.get("Action") not in {
                "owner_resolution_escalation_failed",
                "owner_resolution_escalation_unroutable",
                "owner_resolution_escalation_sent",
                "owner_resolution_user_decision_requested",
                "owner_resolution_continue_recommended",
                "owner_resolution_user_decision_recorded",
            }:
                continue
            keys = record.get("IssueKeys") or ([record["IssueKey"]] if record.get("IssueKey") else [])
            for key in keys:
                previous = latest_by_issue.get(key)
                if previous is None or record.get("At", 0) >= previous.get("At", 0):
                    latest_by_issue[key] = record
    failures = 0
    for record in latest_by_issue.values():
        if record.get("Action") == "owner_resolution_escalation_sent" and not record.get("CommId"):
            if record.get("SpawnOk") is True:
                continue
            failures += 1
        elif record.get("Action") == "owner_resolution_escalation_unroutable":
            failures += 1
        elif record.get("Action") == "owner_resolution_escalation_failed":
            if record.get("Duplicate") and record.get("CommId"):
                continue
            failures += 1
    return failures


def latest_backlog_trend():
    if not ISSUE_BACKLOG_TREND.exists():
        return None
    latest = None
    with ISSUE_BACKLOG_TREND.open(encoding="utf-8") as f:
        for line in f:
            try:
                latest = json.loads(line)
            except json.JSONDecodeError:
                continue
    return latest


def backlog_trend_is_decreasing(snapshot):
    if not snapshot or not snapshot.get("previous_snapshot"):
        return False
    return (
        (snapshot.get("open_delta") is not None and snapshot["open_delta"] < 0)
        or (snapshot.get("resolved_delta") is not None and snapshot["resolved_delta"] > 0)
    )


def backlog_has_active_progress(trend, ack_pushes, lifecycle_progress, resolution_escalations):
    return (
        backlog_trend_is_decreasing(trend)
        or ack_pushes > 0
        or lifecycle_progress > 0
    )


def degraded_checks():
    degraded = []
    review_path = newest_review_path()
    sessions_polled = None
    review_resolved = None
    if review_path is None:
        degraded.append("review-missing")
    else:
        text = review_path.read_text(encoding="utf-8", errors="replace")
        sessions_polled = parse_sessions_polled(text)
        fanout_selected, fanout_candidates = parse_fanout_selected(text)
        review_resolved = parse_review_number(text, "Resolved issues with lifecycle evidence")
        if "Coverage boundary:" not in text:
            degraded.append("coverage-boundary-missing")
        if fanout_selected is not None and fanout_candidates and fanout_selected <= 1 < fanout_candidates:
            degraded.append("fanout-sample-too-small")
        if "Lifecycle event log:" not in text:
            degraded.append("lifecycle-evidence-missing-from-report")
        if "Backlog trend receipt:" not in text:
            degraded.append("backlog-trend-missing-from-report")
        if "Feishu sync evidence" not in text:
            degraded.append("feishu-readback-missing-from-report")
        if sessions_polled == 0:
            degraded.append("sessions-polled-zero")
        if review_resolved is None:
            degraded.append("resolved-count-missing-from-review")
    if not ISSUE_LIFECYCLE_EVENTS.exists() or ISSUE_LIFECYCLE_EVENTS.stat().st_size == 0:
        degraded.append("lifecycle-events-missing")
    counts = lifecycle_counts()
    ack_pushes = recent_owner_ack_pushes()
    lifecycle_progress = recent_lifecycle_progress()
    resolution_escalations = recent_owner_resolution_escalations()
    trend = latest_backlog_trend()
    trend_decreasing = backlog_trend_is_decreasing(trend)
    active_progress = backlog_has_active_progress(trend, ack_pushes, lifecycle_progress, resolution_escalations)
    timed_out_default = int((trend or {}).get("timed_out_default_unresolved", 0))
    if timed_out_default:
        degraded.append(f"timed-out-default-unresolved-{timed_out_default}")
    if counts["owner_ack_pending"] > 0 and ack_pushes == 0:
        degraded.append("owner-ack-handoff-or-lifecycle-progress-missing")
    if counts["owner_ack_pending_overdue"] > 0 and ack_pushes == 0:
        degraded.append(f"owner-ack-pending-overdue-{counts['owner_ack_pending_overdue']}")
    if counts["owner_rejected"] > 0 and ack_pushes == 0:
        degraded.append("owner-reject-reroute-missing")
    if counts["owner_acknowledged_overdue"] > 0 and not active_progress:
        degraded.append("owner-acknowledged-fix-overdue")
    if counts["owner_acknowledged_overdue"] > 0 and resolution_escalations == 0 and not active_progress:
        degraded.append("owner-acknowledged-resolution-escalation-missing")
    if counts["owner_acknowledged"] > 0 and not active_progress:
        degraded.append("owner-ack-without-fix-recheck-or-resolution")
    if counts["open"] > 0 and counts["resolved"] == 0 and not trend_decreasing:
        degraded.append("backlog-open-without-resolved-lifecycle-evidence")
    if counts["open"] > 0:
        if not trend:
            degraded.append("backlog-trend-receipt-missing")
        elif not trend.get("previous_snapshot"):
            degraded.append("backlog-trend-baseline-only")
        elif not active_progress:
            degraded.append("backlog-lifecycle-not-decreasing")
    if recent_owner_ack_handoff_failures() > 0:
        degraded.append("owner-ack-handoff-failed")
    if recent_owner_resolution_escalation_failures() > 0:
        degraded.append("owner-resolution-escalation-failed")
    if not asset_readback_ok(COUNTS_ASSET):
        degraded.append("feishu-readback-not-verified")
    if asset_readback_ok(ISSUES_ASSET):
        pass
    elif counts["open"] > 0:
        degraded.append("feishu-skillissues-readback-missing")
    return degraded


def notify_self(alert):
    prompt = (
        "[skill-master-evaluate health alert]\n"
        f"reason={alert['reason']}\n"
        f"last_run_mtime={alert['last_run_mtime']}\n"
        f"newest_review_mtime={alert['newest_review_mtime']}\n"
        "请立即恢复 scripts/evaluate-skills.py 评估链，并确认 metrics/last-run.txt、"
        "metrics/reviews/<today>.md、metrics/issue-lifecycle.jsonl 都刷新。"
    )
    payload = {
        "from": "skill-master",
        "target": "skill-master",
        "prompt": prompt,
        "client_request_id": f"{datetime.now(timezone.utc).date().isoformat()}:skill-master:evaluate-health-alert",
        "closure": {"kind": "message", "target": {"type": "todo_pool"}},
    }
    req = urllib.request.Request(
        SPAWN_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-age-hours", type=float, default=73.0)
    parser.add_argument("--notify", action="store_true")
    args = parser.parse_args()

    now = time.time()
    last_run = last_run_mtime()
    review = newest_review_mtime()
    max_age = args.max_age_hours * 3600
    stale = []
    if last_run is None or now - last_run > max_age:
        stale.append("last-run")
    if review is None or now - review > max_age:
        stale.append("review")

    degraded = degraded_checks()

    if not stale and not degraded:
        print(json.dumps({
            "ok": True,
            "last_run_mtime": iso(last_run),
            "newest_review_mtime": iso(review),
        }, ensure_ascii=False))
        return 0

    alert = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ok": False,
        "reason": ",".join(stale + degraded),
        "last_run_mtime": iso(last_run),
        "newest_review_mtime": iso(review),
        "max_age_hours": args.max_age_hours,
    }
    ALERTS.parent.mkdir(parents=True, exist_ok=True)
    with ALERTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(alert, ensure_ascii=False) + "\n")

    if args.notify:
        try:
            alert["notify_result"] = notify_self(alert)
        except Exception as exc:
            alert["notify_error"] = str(exc)
            with ALERTS.open("a", encoding="utf-8") as f:
                f.write(json.dumps(alert, ensure_ascii=False) + "\n")

    print(json.dumps(alert, ensure_ascii=False), file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
