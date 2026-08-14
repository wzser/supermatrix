#!/usr/bin/env python3
"""closure-gate.test.py — closure-report.py 收口闸门回归测试。

聚焦 2026-07-08 巡警整改的新闸门：
  framework-fix-tracker 条目标了 `verify=next_run_recurrence`（复发类修复，损失=循环本身）时，
  owner 回执 / tests passed（outcome_verified / fix_evidence）**不算**收口——只有一条真实下轮
  实跑 `next-run-verified` pass 行（同 key follow-up ≤ 阈值）才能把判断转 fixed。

也守住既有行为不回归：非复发类 🟡 条目 + outcome_verified 仍照常收口。

跑法：python3 test/closure-gate.test.py   (exit 0 全过，非 0 有失败)
"""
import json, os, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "closure-report.py")

RECURRENCE_TRACKER = """# 框架修复追踪

## heartbeat 终态 blocker 不消费——同 key 无限重烧 child

- **framework 建议**: 同 key 连续 N 次未恢复 → 阻断 re-claim + 告警
- **owner**: heartbeat
- **状态**: 🟡 已修复待部署验证
- **验收方式**: verify=next_run_recurrence
- **验收判据(下轮追这个)**: 恢复后巡检轮次 spawn 次数 ≤ 阈值(3) 即 backoff
- **证据**: judg-2026-07-08-001
"""

NONRECURRENCE_TRACKER = """# 框架修复追踪

## 某一次性事故修复

- **owner**: someone
- **状态**: 🟡 已认领未实施
- **证据**: judg-2026-07-08-002
"""

# owner 已把复发类条目标 🟢 已部署，但真实下轮实跑仍 fail（复发没停）——
# 这是「owner 绿灯/自报掩盖业务未完成」的核心场景，🟢 绝不能顶掉未翻案的实跑 fail。
DEPLOYED_RECURRENCE_TRACKER = """# 框架修复追踪

## heartbeat 终态 blocker 不消费——同 key 无限重烧 child

- **owner**: heartbeat
- **状态**: 🟢 已部署 (2026-07-09)
- **验收方式**: verify=next_run_recurrence
- **证据**: judg-2026-07-08-001
"""


def base_row(jid, ts="2026-07-08T06:20:00+08:00"):
    return {"id": jid, "ts": ts, "theme": "重复劳动",
            "user_visible_symptom": "循环烧 child", "function_loss": "token 白烧",
            "evidence": "x", "confidence": "high", "gray_zone_hit": "none",
            "status": "awaiting_verdict"}


def owner_receipt_row(jid):
    # owner 回执：改了代码 + tests passed，塞进 fix_evidence（伪收口诱因）
    return {"id": jid + "-fix", "kind": "judgment-followup", "for_id": jid,
            "ts": "2026-07-08T06:28:00+08:00",
            "fix_evidence": "heartbeat 改了 runner.py，回归测试通过，已恢复 amz-radar"}


def next_run_row(jid, verdict, observed, ts="2026-07-09T06:05:00+08:00"):
    return {"kind": "next-run-verified", "for_id": jid, "ts": ts,
            "verdict": verdict, "observed_followups": observed, "threshold": 3,
            "run_window": "2026-07-09 05:40-06:00",
            "evidence": "cross_session_log 同 key follow-up 计数", "by": "test"}


def write_fixture(tmp, tracker, rows):
    os.makedirs(os.path.join(tmp, "state"))
    os.makedirs(os.path.join(tmp, "rules"))
    with open(os.path.join(tmp, "rules", "framework-fix-tracker.md"), "w") as f:
        f.write(tracker)
    with open(os.path.join(tmp, "state", "judgments.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def run(tmp, *extra):
    out = subprocess.run([sys.executable, SCRIPT, "--repo", tmp, *extra],
                         capture_output=True, text=True, check=True)
    return out.stdout


def emitted_transitions(tmp):
    lines = run(tmp, "--emit").strip().splitlines()
    return [json.loads(x) for x in lines if x.strip()]


FAILS = []


def check(cond, msg):
    print(("  ok  " if cond else "FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def test_owner_receipt_does_not_close_recurrence():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER, [base_row(jid), owner_receipt_row(jid)])
        emits = emitted_transitions(tmp)
        fixed = [e for e in emits if e.get("for_id") == jid and e.get("status") in ("fixed", "closed")]
        check(not fixed, "A: owner 回执/tests 不把复发类判断转 fixed（伪收口被挡）")
        report = run(tmp)
        check("等实跑复发验证" in report and jid in report,
              "A: 报告把该判断列进「等实跑复发验证」而非收口")


def test_next_run_pass_closes_recurrence():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER,
                      [base_row(jid), owner_receipt_row(jid), next_run_row(jid, "pass", 2)])
        emits = emitted_transitions(tmp)
        fixed = [e for e in emits if e.get("for_id") == jid and e.get("status") == "fixed"
                 and e.get("reason") == "next_run_verified"]
        check(bool(fixed), "B: 真实下轮 next-run-verified pass 后转 fixed(next_run_verified)")


def test_next_run_fail_keeps_open():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER,
                      [base_row(jid), next_run_row(jid, "fail", 6)])
        emits = emitted_transitions(tmp)
        fixed = [e for e in emits if e.get("for_id") == jid and e.get("status") in ("fixed", "closed")]
        check(not fixed, "C: next-run-verified fail（复发仍在）不收口")
        report = run(tmp)
        check("实跑验证未通过" in report, "C: 报告把复发未消的判断标为实跑验证未通过")


def test_fake_terminal_demoted():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        # 有人已把它手写/旧脚本盲发成 fixed（伪收口既成事实）
        rows = [base_row(jid), owner_receipt_row(jid),
                {"kind": "status-transition", "for_id": jid, "status": "fixed",
                 "reason": "outcome_verified", "evidence": "rules/framework-fix-tracker.md",
                 "ts": "2026-07-08T07:00:00+08:00", "by": "old-script"}]
        write_fixture(tmp, RECURRENCE_TRACKER, rows)
        emits = emitted_transitions(tmp)
        demote = [e for e in emits if e.get("for_id") == jid
                  and e.get("status") not in ("fixed", "closed")
                  and e.get("reason") == "closure_gate_violation_demote"]
        check(bool(demote), "D: 既成的复发类伪收口被降级回开放态")


def test_deployed_green_cannot_override_real_run_fail():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        # owner 标 🟢 已部署 + owner 回执，但真实下轮实跑 fail 未翻案
        write_fixture(tmp, DEPLOYED_RECURRENCE_TRACKER,
                      [base_row(jid), owner_receipt_row(jid), next_run_row(jid, "fail", 74)])
        emits = emitted_transitions(tmp)
        fixed = [e for e in emits if e.get("for_id") == jid and e.get("status") in ("fixed", "closed")]
        check(not fixed, "F: owner 标 🟢 已部署也不能顶掉未翻案的实跑 fail（绿灯不等于业务好）")
        report = run(tmp)
        check("实跑验证未通过" in report and jid in report,
              "F: 报告仍把它标为实跑验证未通过，继续追 owner")


def test_deployed_green_stale_close_demoted():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        # 有人趁 🟢 + 冷却把它 stale_cold 关成 closed（自报/超时掩盖），必须被降级回开放态
        rows = [base_row(jid), owner_receipt_row(jid), next_run_row(jid, "fail", 74),
                {"kind": "status-transition", "for_id": jid, "status": "closed",
                 "reason": "stale_cold", "evidence": "age>30d 无 user_verdict",
                 "ts": "2026-08-09T06:00:00+08:00", "by": "closure-sweep"}]
        write_fixture(tmp, DEPLOYED_RECURRENCE_TRACKER, rows)
        emits = emitted_transitions(tmp)
        demote = [e for e in emits if e.get("for_id") == jid
                  and e.get("status") not in ("fixed", "closed")
                  and e.get("reason") == "closure_gate_violation_demote"]
        check(bool(demote), "G: 实跑 fail 未翻案时的 stale_cold 收口被降级回开放态（超时不掩盖复发）")


def test_window_closed_not_demoted():
    # item ④(2026-07-18)：复发类判断触发已消失、窗口届满 → recurrence-window-closed 主动收口 closed，
    # 不再被当伪收口降级（区别于 test D：D 无 window-closed 行，是越闸伪收口）。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        rows = [base_row(jid), next_run_row(jid, "fail", 74),
                {"kind": "recurrence-window-closed", "for_id": jid,
                 "ts": "2026-07-19T06:00:00+08:00", "reason": "acute_recurrence_window_elapsed",
                 "by": "socail-king"},
                {"kind": "status-transition", "for_id": jid, "status": "closed",
                 "reason": "acute_recurrence_window_elapsed", "evidence": "触发 10 天无复发",
                 "ts": "2026-07-19T06:01:00+08:00", "by": "socail-king"}]
        write_fixture(tmp, RECURRENCE_TRACKER, rows)
        emits = emitted_transitions(tmp)
        demote = [e for e in emits if e.get("for_id") == jid
                  and e.get("reason") == "closure_gate_violation_demote"]
        check(not demote, "H: 窗口收口的 closed 不被降级（主动收口决策 ≠ 越闸伪收口）")


def test_nonrecurrence_outcome_still_closes():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-002"
        write_fixture(tmp, NONRECURRENCE_TRACKER, [base_row(jid), owner_receipt_row(jid)])
        emits = emitted_transitions(tmp)
        fixed = [e for e in emits if e.get("for_id") == jid and e.get("status") == "fixed"
                 and e.get("reason") == "outcome_verified"]
        check(bool(fixed), "E(回归): 非复发类 🟡 + outcome_verified 仍照常收口")


if __name__ == "__main__":
    test_owner_receipt_does_not_close_recurrence()
    test_next_run_pass_closes_recurrence()
    test_next_run_fail_keeps_open()
    test_fake_terminal_demoted()
    test_deployed_green_cannot_override_real_run_fail()
    test_deployed_green_stale_close_demoted()
    test_window_closed_not_demoted()
    test_nonrecurrence_outcome_still_closes()
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED")
        sys.exit(1)
    print("ALL PASS")
