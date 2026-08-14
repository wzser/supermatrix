#!/usr/bin/env python3
"""recheck-enforcement.test.py — closure-report.py `--recheck-worklist` 回归测试。

守 2026-07-11 巡警整改的执行层强制留痕：daily review 每轮必须对每条**开放复发类判断**
留一条复检行（next-run-verified 或 recheck-skipped-with-reason）。`--recheck-worklist`
是这条纪律的机械入口——它列出「今天还没留复检行」的复发类判断(owed)，被 SOP Step7 和
check-daily-review-outcome.sh Gate 2 共同消费。owed 漏检 = 当日零产/仅 backlog-GC 的假绿。

覆盖：
  1  复发类实跑 fail 且当天无复检行 → owed 含它、rechecked_today=false
  2  当天补 recheck-skipped-with-reason → owed 清空、rechecked_today=true（判断仍开放）
  3  当天补 next-run-verified(fail) → owed 清空、仍在 recheck_required（复发未消,继续追）
  4  awaiting_next_run(等首个实跑样本,连 next-run 行都没有) → owed 含它;补复检行后清空
  5  普通 awaiting_verdict(非复发,等用户 verdict) → 只进 open_awaiting_verdict,不进 required/owed

跑法：python3 test/recheck-enforcement.test.py   (exit 0 全过，非 0 有失败)
"""
import json, os, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "closure-report.py")
TODAY = "2026-07-11"

# 2026-07-23 巡警整改：复检/landing 行的「本轮已复检」不再由自证 ts[:10]==today 判，
# 必须带独立锚 = 本轮 scheduler run_id + 一条 run 开始之后产出的外部 receipt。
# 下面是本轮合法锚的取值(run context 由 Gate2/SOP 从 :3502 取真值传入)。
RUN_ID = "run-2026-07-11-daily"
RUN_START = "2026-07-11T06:00:00+08:00"
FRESH = TODAY + "T06:10:00+08:00"   # 晚于 RUN_START = 新鲜受锚
STALE = "2026-07-11T05:00:00+08:00"  # 早于 RUN_START = 陈旧 receipt，不受锚


def anchor(run_id=RUN_ID, produced_at=FRESH, kind="notify_receipt", ref="om_testreceipt"):
    """一条合法锚 = run_id + receipt{kind,ref,produced_at}。"""
    return {"run_id": run_id, "receipt": {"kind": kind, "ref": ref, "produced_at": produced_at}}

# 复发类 tracker 条目：损失=循环本身，标 verify=next_run_recurrence，引用被追的判断
RECURRENCE_TRACKER = """# 框架修复追踪

## heartbeat 终态 blocker 不消费——同 key 无限重烧 child

- **owner**: heartbeat
- **状态**: 🟡 已修复待部署验证
- **验收方式**: verify=next_run_recurrence
- **证据**: {jid}
"""

# 非复发 tracker（不标 recurrence、不 🟢）：引用的判断只是「外部修复未达成」，不算复发类
PLAIN_TRACKER = """# 框架修复追踪

## 某一次性事故

- **owner**: someone
- **状态**: 🟡 已认领未实施
- **证据**: {jid}
"""


def base_row(jid, status="awaiting_verdict", ts="2026-07-08T06:20:00+08:00"):
    return {"id": jid, "ts": ts, "theme": "重复劳动",
            "user_visible_symptom": "循环烧 child", "function_loss": "token 白烧",
            "evidence": "x", "confidence": "high", "gray_zone_hit": "none", "status": status}


def next_run_row(jid, verdict, ts, anch=None):
    r = {"kind": "next-run-verified", "for_id": jid, "ts": ts, "verdict": verdict,
         "observed_followups": 0 if verdict == "pass" else 9, "threshold": 3,
         "run_window": "w", "evidence": "cross_session_log 计数", "by": "test"}
    if anch:
        r.update(anch)
    return r


def skipped_row(jid, ts, anch=None):
    r = {"kind": "recheck-skipped-with-reason", "for_id": jid, "ts": ts,
         "reason": "no_fresh_recurrence_sample", "observed_followups": 0, "threshold": 3,
         "detail": "本轮无同 key re-fire，修复效力未经实跑证明，保持异常优先", "by": "test"}
    if anch:
        r.update(anch)
    return r


def landing_enroll_row(jid, owner="ad-adjust", probe="grep owner repo commit"):
    return {"kind": "landing-enroll", "for_id": jid, "ts": "2026-07-12T06:30:00+08:00",
            "landing_owner": owner, "landing_probe": probe, "by": "test"}


def landing_check_row(jid, verdict, ts, evidence="owner artifact 核对", anch=None):
    r = {"kind": "landing-checked", "for_id": jid, "ts": ts,
         "verdict": verdict, "evidence": evidence, "by": "test"}
    if anch:
        r.update(anch)
    return r


def window_closed_row(jid, ts):
    return {"kind": "recurrence-window-closed", "for_id": jid, "ts": ts,
            "reason": "acute_recurrence_window_elapsed", "by": "test"}


def write_fixture(tmp, tracker, rows):
    os.makedirs(os.path.join(tmp, "state"), exist_ok=True)
    os.makedirs(os.path.join(tmp, "rules"), exist_ok=True)
    with open(os.path.join(tmp, "rules", "framework-fix-tracker.md"), "w") as f:
        f.write(tracker)
    with open(os.path.join(tmp, "state", "judgments.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def worklist(tmp, today=TODAY, run_id=None, run_start=None):
    cmd = [sys.executable, SCRIPT, "--recheck-worklist", "--today", today, "--repo", tmp]
    if run_id:
        cmd += ["--run-id", run_id]
    if run_start:
        cmd += ["--run-start", run_start]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


FAILS = []


def check(cond, msg):
    print(("  ok  " if cond else "FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


def req_map(wl):
    return {r["jid"]: r for r in wl["recheck_required"]}


def land_map(wl):
    return {r["jid"]: r for r in wl.get("landing_required", [])}


def test_fail_no_recheck_is_owed():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00")])
        wl = worklist(tmp)
        check(jid in wl["owed"], "1: 复发实跑 fail 且当天无复检行 → owed 含它")
        check(req_map(wl).get(jid, {}).get("rechecked_today") is False,
              "1: recheck_required 标 rechecked_today=false")


def test_skipped_today_satisfies():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       skipped_row(jid, TODAY + "T14:00:00+08:00", anch=anchor())])
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid not in wl["owed"], "2: 当天补【受锚】recheck-skipped-with-reason → owed 清空")
        check(req_map(wl).get(jid, {}).get("rechecked_today") is True,
              "2: rechecked_today=true（判断仍在 recheck_required、未收口）")
        check(jid in req_map(wl), "2: 判断保持开放、下轮仍需复检")


def test_next_run_today_satisfies_but_stays_required():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       next_run_row(jid, "fail", TODAY + "T06:10:00+08:00", anch=anchor())])
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid not in wl["owed"], "3: 当天补【受锚】next-run-verified(fail) → owed 清空")
        check(jid in req_map(wl), "3: 复发仍在，判断继续留在 recheck_required")


def test_awaiting_first_sample_is_owed():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-003"
        # 复发类但连一条 next-run 行都没有 = awaiting_next_run（等首个实跑样本）
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid), [base_row(jid)])
        wl = worklist(tmp)
        check(jid in wl["owed"], "4: awaiting_next_run（无任何实跑行）也算 owed，必须留痕")
        # 当天补【受锚】skip → 清空
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), skipped_row(jid, TODAY + "T14:00:00+08:00", anch=anchor())])
        wl2 = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid not in wl2["owed"], "4: 补【受锚】recheck-skipped-with-reason 后 owed 清空")


def test_plain_awaiting_verdict_not_required():
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-004"
        # 非复发、只是等用户 verdict → 走 digest/stale 管道，不进复发日常复检
        write_fixture(tmp, PLAIN_TRACKER.format(jid=jid), [base_row(jid)])
        wl = worklist(tmp)
        check(jid not in wl["owed"] and jid not in req_map(wl),
              "5: 普通 awaiting_verdict 不进 required/owed（不制造每日噪声行）")
        check(jid in wl["open_awaiting_verdict"], "5: 但仍报进 open_awaiting_verdict 供可见性")


def test_landing_enrolled_open_is_owed():
    # item ①：显式 landing-enroll 的开放判断 → 进 landing_required + owed；当天补 landing-checked 后清空
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-12-001"
        write_fixture(tmp, PLAIN_TRACKER.format(jid="judg-x-none"),
                      [base_row(jid), landing_enroll_row(jid)])
        wl = worklist(tmp)
        check(jid in wl["owed"], "6: landing-enroll 开放判断当天未核对 → owed 含它")
        check(jid in land_map(wl) and land_map(wl)[jid]["checked_today"] is False,
              "6: 进 landing_required、checked_today=false")
        check(jid not in req_map(wl), "6: landing 类不混进复发类 recheck_required")
        # 当天补【受锚】landing-checked(verdict=pending) → owed 清空（判断仍开放、仍在 landing_required）
        write_fixture(tmp, PLAIN_TRACKER.format(jid="judg-x-none"),
                      [base_row(jid), landing_enroll_row(jid),
                       landing_check_row(jid, "pending", TODAY + "T09:00:00+08:00", anch=anchor())])
        wl2 = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid not in wl2["owed"], "6: 当天补【受锚】landing-checked(pending) → owed 清空")
        check(jid in land_map(wl2), "6: 仍在 landing_required（未 landed，下轮继续核）")


def test_landing_landed_drops_from_required():
    # item ①：最新 landing-checked=landed → 退出 landing_required（owner 真做了、可转 fixed）
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-12-001"
        write_fixture(tmp, PLAIN_TRACKER.format(jid="judg-x-none"),
                      [base_row(jid), landing_enroll_row(jid),
                       landing_check_row(jid, "landed", TODAY + "T09:00:00+08:00",
                                         evidence="owner commit 5e4f750 存在")])
        wl = worklist(tmp)
        check(jid not in land_map(wl), "7: landing-checked=landed → 退出 landing_required")
        check(jid not in wl["owed"], "7: landed → 不再 owed")


def test_window_closed_drops_from_recurrence():
    # item ④：复发类判断 append recurrence-window-closed → 从复发闸门解绑，不再 required/owed
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       window_closed_row(jid, TODAY + "T10:00:00+08:00")])
        wl = worklist(tmp)
        check(jid not in wl["owed"], "8: 窗口收口后不再 owed（停止无限日复检）")
        check(jid not in req_map(wl), "8: 从 recheck_required 解绑")


# ============================================================================
# 2026-07-23 巡警整改：自证环封堵。复检/landing 行的「本轮已复检」必须带独立锚
# (run_id + run-开始后产出的外部 receipt)，不能靠自报 ts。以下用 07-23 实测的
# 攻击面(future-stamped 裸 ts 行)当回归样本。
# ============================================================================

def test_unanchored_recheck_stays_owed_strict():
    # 复现 07-23：当天有复检行，但没有 run_id/receipt(裸 ts) → 不算已复检、仍 owed。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       skipped_row(jid, TODAY + "T14:00:00+08:00")])  # 无 anchor
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid in wl["owed"], "9: 裸 ts 复检行(无锚)在 strict 模式仍 owed（封 07-23 自证环）")
        check(req_map(wl).get(jid, {}).get("rechecked_today") is False,
              "9: rechecked_today=false（自报 ts 不再放行）")


def test_unanchored_recheck_stays_owed_loose():
    # 无 run context(人工 ad-hoc 跑)也不能退回信 ts：仍要求锚存在，否则 owed。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       skipped_row(jid, TODAY + "T14:00:00+08:00")])  # 无 anchor
        wl = worklist(tmp)  # 不传 run context
        check(jid in wl["owed"], "10: 无 run context 时裸 ts 行仍 owed（loose 模式也不信 ts）")


def test_stale_receipt_stays_owed():
    # 锚齐全但 receipt.produced_at 早于 run start = 引用了 run 之前的陈旧产物 → 不算本轮复检。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       skipped_row(jid, TODAY + "T14:00:00+08:00",
                                   anch=anchor(produced_at=STALE))])
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid in wl["owed"], "11: receipt 早于 run start(陈旧) → 仍 owed（新鲜性锚）")


def test_wrong_run_id_stays_owed():
    # 锚+新鲜 receipt 齐，但 run_id 是别轮的 → 不算本轮复检（防拿旧轮锚顶今轮）。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-08-001"
        write_fixture(tmp, RECURRENCE_TRACKER.format(jid=jid),
                      [base_row(jid), next_run_row(jid, "fail", "2026-07-09T06:10:00+08:00"),
                       skipped_row(jid, TODAY + "T14:00:00+08:00",
                                   anch=anchor(run_id="run-some-other-round"))])
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid in wl["owed"], "12: run_id 非本轮 → 仍 owed（防旧轮锚顶今轮）")


def test_unanchored_landing_stays_owed():
    # landing 侧同样：裸 ts landing-checked(pending) 不清 owed。
    with tempfile.TemporaryDirectory() as tmp:
        jid = "judg-2026-07-12-001"
        write_fixture(tmp, PLAIN_TRACKER.format(jid="judg-x-none"),
                      [base_row(jid), landing_enroll_row(jid),
                       landing_check_row(jid, "pending", TODAY + "T09:00:00+08:00")])  # 无 anchor
        wl = worklist(tmp, run_id=RUN_ID, run_start=RUN_START)
        check(jid in wl["owed"], "13: 裸 ts landing-checked(无锚) → 仍 owed")
        check(land_map(wl).get(jid, {}).get("checked_today") is False,
              "13: landing checked_today=false")


if __name__ == "__main__":
    test_fail_no_recheck_is_owed()
    test_skipped_today_satisfies()
    test_next_run_today_satisfies_but_stays_required()
    test_awaiting_first_sample_is_owed()
    test_plain_awaiting_verdict_not_required()
    test_landing_enrolled_open_is_owed()
    test_landing_landed_drops_from_required()
    test_window_closed_drops_from_recurrence()
    test_unanchored_recheck_stays_owed_strict()
    test_unanchored_recheck_stays_owed_loose()
    test_stale_receipt_stays_owed()
    test_wrong_run_id_stays_owed()
    test_unanchored_landing_stays_owed()
    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED")
        sys.exit(1)
    print("ALL PASS")
