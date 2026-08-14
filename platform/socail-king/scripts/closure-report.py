#!/usr/bin/env python3
"""closure-report.py — SK judgment 收口自检 + 落地漂移检测。

为什么存在：judgments.jsonl 是 append-only 多路日志，一条判断的真实状态是
"最后一条带 status 的记录赢"（latest-wins），不是逐行计数。裸数行会把
pending 与它后来的 fixed/closed 转移行同时算进去。本脚本按 latest-wins 归约，
产出圈末自检（backlog / closure rate）并检测"已沉进规则却没标终态"的漂移。

用法：
  python3 scripts/closure-report.py                # 打印自检报告
  python3 scripts/closure-report.py --emit          # 额外打印可直接 append 的落地转移行(JSONL)
  python3 scripts/closure-report.py --recheck-worklist  # 只读打印复发类日常复检 worklist(JSON)
  python3 scripts/closure-report.py --stale-days 7  # 自定义 pending 超期阈值(默认 7)
  python3 scripts/closure-report.py --today 2026-07-01  # 覆盖"今天"(默认系统日期)
  python3 scripts/closure-report.py --repo /path/to/fixture  # 指定仓库根(测试用，默认本仓)

复发类日常复检 worklist(2026-07-11 巡警整改，执行层强制留痕)：`--recheck-worklist` 是
  **只读输出**、不改任何 gate/status。它复用同一份 latest-wins 归约，列出「必须每轮留一条复检行」
  的复发类判断——`owed` 里的 judgment 今天还没有 next-run-verified / recheck-skipped-with-reason 行。
  daily review 的 Step 7 与 check-daily-review-outcome.sh 都消费它：前者据此逐条补复检行，后者据此
  判绿(owed 非空 = 当日零产/仅 GC 漏检了开放复发项 → 告警、判红)。这是「把新的实跑样本喂进闸门」
  的执行层入口，不是给闸门再加一道逻辑。

landing/owner-欠账 强制核对(2026-07-18 巡警整改，item ①)：`--recheck-worklist` 除复发类外再输出
  `landing_required`——「点名 owner 改代码/改合同」的判断经 `landing-enroll` 行显式登记(带 owner+probe)后
  进此表，只要还开放(非终态)且最新 `landing-checked` 未 landed，就每轮强制去 owner repo 抽产物核对
  (probe 如「grep ad-adjust commit」/「核 comm read_back_verified」)并 append 一条 landing-checked
  (verdict=landed/pending)；owed 折叠复发类 + landing 两路。堵的正是「owner 已 ship 却无人核对、判断
  无限停 awaiting_verdict」(judg-2026-07-12-001 ad-adjust 6 天无人核对即此漏洞)。marker 驱动、不靠
  tracker 引用——被点名的 landing 判断往往还没进 framework-fix-tracker。

真实闭环率(2026-07-18 巡警整改，item ②)：closure_rate 分子剔除「暂计」项——终态(fixed/closed)但真正
  止损的框架修复仍 🟡/🔴 未部署 / 复发未经实跑证 / 窗口收口 的判断。这些多因 coordination-pattern 沉淀
  即 fixed，但复发风险未消，不能当「真的解决了」抬高闭环率原样播报进 health/notify(false-green)。

窗口收口(2026-07-18 巡警整改，item ④)：复发类判断若原始触发(具体 comm/logical_key)不再出现、无法
  再产生实跑样本(如 judg-2026-07-08-001 滞留 10 天),用一行 `recurrence-window-closed` 显式主动收口：
  从复发闸门解绑、终态 closed 自证不被降级,但仍计入「暂计」不抬高真实闭环率(框架修复仍由 owner tracker 追)。

落地判据(机械可判)：judgment_id 被 rules/ 引用且**落地真实发生**才算——
  - coordination-patterns.md 引用 → fixed(pattern_sunk_to_rule)：协作模式本身就是 SK 的产出，引用即落地
  - framework-fix-tracker.md 引用 → 只有该条目状态含 🟢(已部署/已修复)，或该判断有
    outcome-verified 行(事故结果已实地验证)，才算 fixed；🟡/🔴 条目引用 = 记录了缺口
    但外部修复没发生，判断保持开放并列入「外部修复未达成」追踪——记录沉淀不能替代落地
  - judgment-thresholds.md 引用(识别误区/反例)         → closed(calibrated_counterexample)

复发类闸门(2026-07-08 巡警整改新增)：某些 framework 修复的损失**就是循环本身**
  (如 heartbeat 对终态 blocker 同 key 每 10 分钟无限重烧 child)。这类修复的收口证据
  只能是**一次真实下轮实跑**——同 logical_key follow-up 次数 ≤ 阈值即 backoff，
  owner 回执 / tests passed（fix_evidence / outcome_verified）**不算**（tests 过 ≠ 部署且
  patrol 进程真加载新代码 ≠ 复发真停）。做法：给 tracker 条目加机器标记 `verify=next_run_recurrence`，
  这类条目引用的判断只有拿到一条 `next-run-verified` 且 `verdict=pass` 的实跑行才转 fixed；
  没拿到就列入「等实跑复发验证」，owner 回执越闸的既成终态会被降级(closure_gate_violation_demote)。
  `verdict=fail`(复发仍在)= 修复没生效，列入「实跑验证未通过」继续追 owner。

实跑 fail 最高权威(2026-07-09 巡警整改)：一条 next-run-verified `verdict=fail` 且**无后续 pass
  翻案**时，这条实跑 fail 压过一切自报信号——owner 把 tracker 条目标 `🟢 已部署`、outcome_verified、
  tests passed、任何 rule 文件引用都不能把它顶成 fixed；连 30 天 stale_cold 冷收口也会被降级回开放态。
  防的正是「owner 绿灯/自报/超时掩盖业务未完成」：🟢 只证代码进生产、tests 只证本地过、冷收口只证没人
  回 verdict——都不证复发真停。只有一条真实下轮实跑 pass 能翻案。

状态生命周期：pending → awaiting_verdict → confirmed → fixed | closed
  终态(算收口)：fixed, closed
  开放态：pending, pending_interview, awaiting_verdict, confirmed

证据卫生(2026-07-07 巡警整改新增，--emit 均自动生成修复行)：
  - 重复主判断行：同 id 出现 >1 条实体行(theme+symptom 非空) = 复盘 run 重复 append；
    --emit 生成 dedupe-annotation 标记行(append-only 不删历史，snapshot/飞书本就按 id 归约)
  - 伪收口：终态转移的唯一依据是 framework-fix-tracker 非🟢引用(手写 pattern_sunk_to_rule
    绕过上面闸门) → --emit 生成降级转移(closure_gate_violation_demote)退回最近开放态；
    终态只能来自本脚本 --emit 或用户 verdict 路径，手写终态会在下一轮被机制纠回
"""
import argparse, datetime, glob, json, os, re, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JUDG_ID_RE = re.compile(r"^judg-\d{4}-\d{2}-\d{2}-\d+$")
ANY_JUDG_RE = re.compile(r"judg-\d{4}-\d{2}-\d{2}-\d+")
TERMINAL = {"fixed", "closed"}
# 机器标记：tracker 条目损失=循环本身，收口只认一次真实下轮实跑(见模块 docstring 复发类闸门)
RECURRENCE_MARK = "verify=next_run_recurrence"
# landing/owner-欠账 类(2026-07-18 巡警整改)：判断点名 owner 改代码/改合同，须每轮去 owner
# repo 抽产物核对「真做了没」，而非无限停 awaiting_verdict。marker 驱动(显式 enroll)，
# 不靠 tracker 引用——被点名的 landing 判断往往还没进 framework-fix-tracker。
LANDING_ENROLL_KIND = "landing-enroll"   # 登记 landing 判断(带 landing_owner / landing_probe)
LANDING_CHECK_KIND = "landing-checked"   # 每轮 owner-artifact 核对结果(verdict=landed|pending)
# 复发类触发已消失、观察窗届满 → 一次主动收口/降级决策(既非 next-run pass、也非无限 owed)。
# 损失=循环本身的复发类判断,若原始触发(具体 comm/logical_key)不再出现、无法再产生实跑样本,
# 用这行显式收口:从复发闸门解绑,终态 closed 自证不被降级,但仍计入「暂计」不抬高真实闭环率。
WINDOW_CLOSED_KIND = "recurrence-window-closed"

# 独立锚(2026-07-23 巡警整改：封「自证环」)：复检/landing 行「本轮已复检」曾靠自报
#   ts[:10]==today 判——但 ts 由写行的 daily-review child 自己填，07-23 实测出现 commit
#   06:11:40 的树内已含 ts=06:40:00 的行(未来 28 分钟),即 ts 是预填/伪造、非真实产出时刻,
#   照样过 owed=[] 假绿。修法:一条复检/landing 行要算「本轮已复检」,必须带独立、可交叉核的锚:
#     row["run_id"]  = 本轮 scheduler child run_id(写行方不能自造成本轮)
#     row["receipt"] = {"kind":<下列之一>,"ref":<外部 handle>,"produced_at":<ISO,晚于 run start>}
#   受锚判据(见 anchor_ok)：run_id 非空且(给了 --run-id 时)==本轮 + receipt 三字段齐 +
#   produced_at 可解析且(给了 --run-start 时)晚于 run start。缺任一 → 不算已复检 → 计 owed。
#   ts 只再用于 latest-wins 排序,不再作「今天membership」判据。receipt.ref 的真伪(handle 能不能
#   解析回真实外部时刻)由巡警下轮从 :3502/:3501 + 外部日志交叉核,本脚本只做结构+新鲜性锚。
RECEIPT_KINDS = {"notify_receipt", "queue_receipt", "owner_artifact"}


def parse_ts(s):
    """宽松解析 ISO8601(含 Z / +0800 无冒号偏移 / 小数秒)→ datetime；失败返回 None。"""
    if not s:
        return None
    s = str(s).strip().replace("Z", "+00:00")
    m = re.search(r"([+-]\d{2})(\d{2})$", s)   # +0800 -> +08:00
    if m:
        s = s[:m.start()] + m.group(1) + ":" + m.group(2)
    try:
        return datetime.datetime.fromisoformat(s)
    except Exception:
        return None


def _gt(a, b):
    """a > b，容忍 aware/naive 混用(统一按墙钟比较，实测数据全带 +08:00 偏移)。"""
    if a is None or b is None:
        return False
    if a.tzinfo and not b.tzinfo:
        b = b.replace(tzinfo=a.tzinfo)
    if b.tzinfo and not a.tzinfo:
        a = a.replace(tzinfo=b.tzinfo)
    return a > b


def anchor_ok(o, today_iso, run_id=None, run_start=None):
    """复检/landing 行是否带合法「本轮」锚。返回 (ok: bool, reason: str)。

    run_id / run_start 为 None = ad-hoc 模式(无 scheduler 上下文,如人工排障)：仍强制锚结构
    齐全(run_id + receipt 三字段),并按 receipt.produced_at 的日期落今天,**绝不退回信自报 ts**。
    给了 run_start(Gate2/SOP 从 :3502 取真值)= strict 模式：额外要 produced_at 晚于 run start,
    给了 run_id 则要 == 本轮。
    """
    rid = str(o.get("run_id") or "").strip()
    if not rid:
        return False, "no_run_id"
    if run_id is not None and rid != str(run_id):
        return False, "run_id_not_this_round"
    rc = o.get("receipt")
    if not isinstance(rc, dict):
        return False, "no_receipt"
    if rc.get("kind") not in RECEIPT_KINDS:
        return False, "bad_receipt_kind"
    if not str(rc.get("ref") or "").strip():
        return False, "no_receipt_ref"
    pa = parse_ts(rc.get("produced_at"))
    if pa is None:
        return False, "bad_produced_at"
    if run_start is not None:
        rs = parse_ts(run_start)
        if not _gt(pa, rs):
            return False, "receipt_not_after_run_start"
    else:
        # ad-hoc：无 run start 可比，退化到「receipt 日期落今天」(仍要求锚结构齐)
        if str(rc.get("produced_at"))[:10] != today_iso:
            return False, "receipt_not_today"
    return True, "anchored"


def load_rows(jsonl):
    rows = []
    with open(jsonl) as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            rows.append(json.loads(ln))
    return rows


def rule_citations(repo, outcome_verified_jids, next_run_pass_jids, next_run_fail_jids,
                   window_closed_jids=frozenset()):
    """judgment_id -> landed verdict ('fixed'|'closed', reason, fname).

    framework-fix-tracker 引用只有条目 🟢、判断自带 outcome-verified 行才算落地；
    否则收进 external_pending。**复发类**条目(带 RECURRENCE_MARK)例外——owner 回执
    不算，只有 next-run-verified pass 才算，否则收进 awaiting_next_run 且**从 cited 拿掉**
    (复发闸门优先于其他文件引用，避免伪收口)。

    真实下轮实跑 fail 的最高权威(2026-07-09 巡警整改)：某判断有一条 next-run-verified
    verdict=fail 且**没有**后续 pass 翻案时，业务实测就是没好——这条实跑 fail 压过一切
    **自报**信号：owner 把 tracker 标 🟢 已部署、outcome_verified、tests passed、或任何
    coordination/thresholds 文件引用都不能把它顶成 fixed。防的正是「owner 绿灯/自报掩盖
    业务未完成」：deployed 只证明代码进了生产，next-run fail 证明复发还在。
    Returns (cited, external_pending, awaiting_next_run):
      external_pending / awaiting_next_run = [(jid, section_title)].
    """
    cited = {}
    external_pending = []
    awaiting_next_run = []
    blocked_by_recurrence = set()

    def unresolved_fail(jid):
        return (jid in next_run_fail_jids and jid not in next_run_pass_jids
                and jid not in window_closed_jids)

    for path in glob.glob(os.path.join(repo, "rules", "*.md")):
        fname = os.path.basename(path)
        with open(path) as f:
            text = f.read()
        if fname == "framework-fix-tracker.md":
            for section in text.split("\n## ")[1:]:
                title = section.splitlines()[0].strip()
                deployed = "🟢" in section
                recurrence = RECURRENCE_MARK in section
                for jid in set(ANY_JUDG_RE.findall(section)):
                    if jid in window_closed_jids:
                        continue  # 已窗口收口：从复发闸门解绑，终态自证，不进任何 pending
                    if unresolved_fail(jid):
                        # 实跑 fail 未翻案：压过 🟢 已部署等自报信号，绝不收口
                        awaiting_next_run.append((jid, title))
                        blocked_by_recurrence.add(jid)
                    elif deployed:
                        cited[jid] = ("fixed", "pattern_sunk_to_rule", fname)
                    elif recurrence:
                        # 复发类：owner 回执/tests(outcome_verified) 不算，只认真实下轮实跑
                        if jid in next_run_pass_jids:
                            cited[jid] = ("fixed", "next_run_verified", fname)
                        else:
                            awaiting_next_run.append((jid, title))
                            blocked_by_recurrence.add(jid)
                    elif jid in outcome_verified_jids:
                        cited[jid] = ("fixed", "outcome_verified", fname)
                    else:
                        external_pending.append((jid, title))
            continue
        for jid in set(ANY_JUDG_RE.findall(text)):
            if fname == "judgment-thresholds.md":
                cited.setdefault(jid, ("closed", "calibrated_counterexample", fname))
            else:  # coordination-patterns.md：模式本身是 SK 产出，引用即落地
                cited[jid] = ("fixed", "pattern_sunk_to_rule", fname)
    # 复发闸门 + 实跑 fail 优先：等实跑验证 / 实测 fail 未翻案的判断不允许被任何文件引用顶成 fixed。
    # 兜底覆盖只在非 tracker 文件被引用、tracker 里没有对应 section 的实跑 fail 判断。
    awaiting_jids = {j for j, _ in awaiting_next_run}
    for jid in next_run_fail_jids:
        if unresolved_fail(jid):
            blocked_by_recurrence.add(jid)
            if jid not in awaiting_jids:
                awaiting_next_run.append((jid, "next-run 实跑 fail 未翻案"))
    for jid in blocked_by_recurrence:
        if jid not in next_run_pass_jids:
            cited.pop(jid, None)
    return cited, external_pending, awaiting_next_run


def reduce_status(rows):
    """latest-wins effective status per base judgment id.

    Returns (base, effective, last_ts) where last_ts[jid] is the max event ts
    string seen for that judgment — used to stamp new transitions strictly after
    it so a same-day transition can't lose to a later-created base row.
    """
    base = {}        # jid -> base judgment row
    events = {}      # jid -> list of (ts, status, row)
    for o in rows:
        st = o.get("status")
        if st is None:
            continue
        target = o.get("for_id") or o.get("parent_id") or o.get("id")
        ts = str(o.get("ts") or "")
        events.setdefault(target, []).append((ts, st, o))
        oid = o.get("id", "")
        if JUDG_ID_RE.match(str(oid)) and not o.get("for_id") and not o.get("parent_id"):
            base[oid] = o
    effective = {}
    last_ts = {}
    for jid, evs in events.items():
        if jid not in base:
            continue  # transitions whose base isn't a real judgment row are ignored
        evs.sort(key=lambda e: e[0])
        effective[jid] = evs[-1][1]
        last_ts[jid] = evs[-1][0]
    return base, effective, last_ts, events


def _bump(ts_str, fallback):
    """Return an ISO ts strictly greater than ts_str (latest-wins safe)."""
    try:
        return (datetime.datetime.fromisoformat(ts_str) + datetime.timedelta(minutes=1)).isoformat()
    except Exception:
        return fallback


def age_days(base_row, today):
    ts = str(base_row.get("ts") or "")[:10]
    try:
        return (today - datetime.date.fromisoformat(ts)).days
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", action="store_true", help="打印可 append 的落地转移行(JSONL)")
    ap.add_argument("--recheck-worklist", action="store_true",
                    help="只读打印复发类日常复检 worklist(JSON)：owed=今天还没留复检行的复发类判断")
    ap.add_argument("--stale-days", type=int, default=7)
    ap.add_argument("--today", default=None)
    ap.add_argument("--repo", default=REPO, help="仓库根目录(默认本仓，测试可覆盖)")
    ap.add_argument("--run-id", default=None,
                    help="本轮 scheduler child run_id(受锚 strict 模式)：复检/landing 行 run_id 须 == 它")
    ap.add_argument("--run-start", default=None,
                    help="本轮 run 起始 ISO 时刻(受锚 strict 模式)：receipt.produced_at 须晚于它")
    args = ap.parse_args()
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()
    jsonl = os.path.join(args.repo, "state", "judgments.jsonl")

    rows = load_rows(jsonl)
    base, effective, last_ts, events = reduce_status(rows)

    # 闭环字段索引：某判断的任意行(base/revision/outcome-verified)带非空
    # applied_to_rule / outcome_verified 即算有
    has_applied, has_outcome = set(), set()
    # 复发类实跑验证：next-run-verified 行按 verdict 分 pass/fail(见复发类闸门)
    next_run_pass, next_run_fail = set(), set()
    # landing/owner-欠账 类 + 窗口收口(见对应常量注释)
    landing_enrolled = {}        # jid -> {"owner":..., "probe":...}
    landing_check_latest = {}    # jid -> (ts, verdict)  最新一条 landing-checked
    window_closed = set()
    for o in rows:
        jid = o.get("for_id") or o.get("parent_id") or o.get("id")
        if not jid:
            continue
        if str(o.get("applied_to_rule") or "").strip():
            has_applied.add(jid)
        # fix_evidence(judgment-followup 行)= 实地修复证据，同等算 outcome
        if str(o.get("outcome_verified") or "").strip() or o.get("fix_evidence"):
            has_outcome.add(jid)
        k = o.get("kind")
        if k == "next-run-verified":
            v = str(o.get("verdict") or "").strip().lower()
            if v == "pass":
                next_run_pass.add(jid)
            elif v == "fail":
                next_run_fail.add(jid)
        elif k == LANDING_ENROLL_KIND:
            landing_enrolled[jid] = {"owner": o.get("landing_owner", ""),
                                     "probe": o.get("landing_probe", "")}
        elif k == LANDING_CHECK_KIND:
            ts = str(o.get("ts") or "")
            if ts >= landing_check_latest.get(jid, ("", ""))[0]:
                landing_check_latest[jid] = (ts, str(o.get("verdict") or "").strip().lower())
        elif k == WINDOW_CLOSED_KIND:
            window_closed.add(jid)
    landing_landed = {j for j, (ts, v) in landing_check_latest.items() if v == "landed"}

    cited, external_pending, awaiting_next_run = rule_citations(
        args.repo, has_outcome, next_run_pass, next_run_fail, window_closed)
    awaiting_next_run_jids = {jid for jid, _ in awaiting_next_run}
    external_pending_jids = {jid for jid, _ in external_pending}

    # 复发类日常复检 worklist(2026-07-11 巡警整改：执行层强制留痕)——只读，不改 gate/status。
    # recheck_required = 每轮必须留一条复检行的复发类判断:
    #   awaiting_next_run(等首个实跑样本) ∪ 未翻案 next_run_fail(实跑 fail 仍开放)。
    # owed = required 里今天还没有 next-run-verified / recheck-skipped-with-reason 行的。
    if args.recheck_worklist:
        RECHECK_KINDS = {"next-run-verified", "recheck-skipped-with-reason"}
        unresolved_fail = {j for j in next_run_fail
                           if j not in next_run_pass and j not in window_closed}
        # 复发类 required：窗口收口的从此解绑(不再 owed)
        required = sorted((awaiting_next_run_jids | unresolved_fail) - window_closed)
        today_iso = today.isoformat()
        eff_of = lambda j: (effective.get(j, base[j].get("status")) if j in base else "unknown")
        # 受锚判据(2026-07-23 巡警整改)：一条复检/landing 行只有带合法「本轮」锚(anchor_ok)才算
        # 「今天已复检」；自报 ts 不再放行。last_* 仍按 ts 取最新一条(展示/审计用),
        # last_reject_reason 记最新一条**未受锚**行的原因(帮排障：无 run_id / 陈旧 receipt / 非本轮)。
        rechecked_today, last_recheck, recheck_reject = set(), {}, {}
        landing_checked_today, landing_last, landing_reject = set(), {}, {}
        for o in rows:
            k = o.get("kind")
            tgt = o.get("for_id") or o.get("id")
            if not tgt:
                continue
            ts = str(o.get("ts") or "")
            ok, reason = anchor_ok(o, today_iso, args.run_id, args.run_start)
            if k in RECHECK_KINDS:
                if ts > last_recheck.get(tgt, ""):
                    last_recheck[tgt] = ts
                if ok:
                    rechecked_today.add(tgt)
                elif ts[:10] == today_iso:
                    recheck_reject[tgt] = reason   # 今天有行但未受锚 → 记原因
            elif k == LANDING_CHECK_KIND:
                if ts > landing_last.get(tgt, ""):
                    landing_last[tgt] = ts
                if ok:
                    landing_checked_today.add(tgt)
                elif ts[:10] == today_iso:
                    landing_reject[tgt] = reason
        # landing required：显式 enroll、仍开放(非终态)、最新 landing-checked 未 landed
        landing_required = sorted(
            j for j in landing_enrolled
            if j in base and eff_of(j) not in TERMINAL and j not in landing_landed)
        recurrence_owed = [j for j in required if j not in rechecked_today]
        landing_owed = [j for j in landing_required if j not in landing_checked_today]
        owed = sorted(set(recurrence_owed) | set(landing_owed))
        open_av = sorted(
            j for j in base
            if effective.get(j, base[j].get("status")) == "awaiting_verdict"
            and j not in required and j not in landing_required)
        anchor_ctx = (f"run:{args.run_id or '?'}@{args.run_start}"
                      if args.run_start else "missing(ad-hoc,receipt-date-fallback)")
        print(json.dumps({
            "today": today_iso,
            "anchor_context": anchor_ctx,
            "recheck_required": [
                {"jid": j, "status": eff_of(j),
                 "rechecked_today": j in rechecked_today,
                 "last_recheck_ts": last_recheck.get(j, ""),
                 "anchor_reject": recheck_reject.get(j, "")}
                for j in required
            ],
            "landing_required": [
                {"jid": j, "status": eff_of(j),
                 "owner": landing_enrolled[j].get("owner", ""),
                 "probe": landing_enrolled[j].get("probe", ""),
                 "checked_today": j in landing_checked_today,
                 "last_check_ts": landing_last.get(j, ""),
                 "anchor_reject": landing_reject.get(j, "")}
                for j in landing_required
            ],
            "owed": owed,
            "open_awaiting_verdict": open_av,
        }, ensure_ascii=False))
        return

    total = len(base)
    dist = {}
    for jid in base:
        st = effective.get(jid, base[jid].get("status"))
        dist[st] = dist.get(st, 0) + 1
    closed_n = sum(v for k, v in dist.items() if k in TERMINAL)

    # 真实收口(item ②，2026-07-18 巡警整改)：closure_rate 不得把「framework 未部署/复发未证/
    # 窗口收口」的终态判断当成真的解决了。这些判断状态虽是 fixed/closed(多因 coordination-pattern
    # 沉淀或主动窗口收口),但真正止损的框架修复仍 🟡/🔴 未部署 → 复发风险未消 → 计入「暂计」、
    # 不进真实闭环率分子。避免 88% 假绿被原样播报进 health.jsonl/notify。
    provisional = sorted(
        jid for jid in base
        if effective.get(jid, base[jid].get("status")) in TERMINAL
        and (jid in external_pending_jids or jid in awaiting_next_run_jids or jid in window_closed))
    true_closed = closed_n - len(provisional)
    rate = (true_closed / total * 100) if total else 0.0

    # drift: cited in a rule (=landed) but effective status not terminal
    drift = []
    for jid, (want, reason, fname) in cited.items():
        if jid not in base:
            continue
        eff = effective.get(jid, base[jid].get("status"))
        if eff not in TERMINAL:
            drift.append((jid, eff, want, reason, fname))

    # 缺闭环字段：confirmed/fixed 却没有任何 applied_to_rule / outcome_verified 记录
    missing_closure = []
    for jid, row in base.items():
        eff = effective.get(jid, row.get("status"))
        if eff in ("confirmed", "fixed") and jid not in has_applied and jid not in has_outcome:
            missing_closure.append((jid, eff))

    # 重复主判断行：同 id >1 条实体行(theme+symptom 非空)且尚无 dedupe-annotation
    primary_counts, dedup_annotated = {}, set()
    for o in rows:
        if o.get("kind") == "dedupe-annotation":
            dedup_annotated.add(o.get("for_id") or o.get("id"))
            continue
        if o.get("theme") is not None and str(o.get("user_visible_symptom") or "").strip():
            jid = o.get("id")
            if jid:
                primary_counts[jid] = primary_counts.get(jid, 0) + 1
    dup_primary = sorted(
        (jid, c) for jid, c in primary_counts.items()
        if c > 1 and jid not in dedup_annotated
    )

    # 伪收口：终态但没有有效落地依据(手写/旧脚本盲发绕闸)
    #   - 普通 🟡/🔴 引用：无 cited 且无 outcome-verified 行 = 伪收口
    #   - 复发类(awaiting_next_run)：owner 回执(has_outcome)不豁免，只有 next-run pass 才算，
    #     所以终态但在 awaiting_next_run 里 = 伪收口，必降级
    demote_title = dict(external_pending)
    demote_title.update(dict(awaiting_next_run))
    fake_terminal = []
    for jid, row in base.items():
        eff = effective.get(jid, row.get("status"))
        if eff not in TERMINAL or jid in cited:
            continue
        recurrence_blocked = jid in awaiting_next_run_jids
        plain_fake = jid in external_pending_jids and jid not in has_outcome
        if not (recurrence_blocked or plain_fake):
            continue
        # 降级目标 = 该判断事件史里最近一个开放态；全无则回 base status
        demote_to = row.get("status") or "pending"
        for ts, st, _o in sorted(events.get(jid, [])):
            if st not in TERMINAL:
                demote_to = st
        fake_terminal.append((jid, eff, demote_to, demote_title.get(jid, ""), recurrence_blocked))

    # escalation: open judgments older than stale-days
    stale = []
    for jid, row in base.items():
        eff = effective.get(jid, row.get("status"))
        if eff in TERMINAL:
            continue
        a = age_days(row, today)
        if a is not None and a >= args.stale_days:
            stale.append((a, jid, eff))
    stale.sort(reverse=True)

    if args.emit:
        fallback = today.isoformat() + "T23:59:00+08:00"
        for jid, eff, want, reason, fname in sorted(drift):
            stamp = _bump(last_ts.get(jid, ""), fallback)
            print(json.dumps({
                "kind": "status-transition", "for_id": jid, "status": want,
                "reason": reason, "evidence": "rules/" + fname,
                "ts": stamp, "by": "closure-report.py",
            }, ensure_ascii=False))
        for jid, c in dup_primary:
            print(json.dumps({
                "kind": "dedupe-annotation", "for_id": jid,
                "note": f"同 id 主判断行 {c} 条(复盘 run 重复 append)；以首条为准。"
                        "snapshot 按 id 归约、飞书 enqueue 按 judgment_id 幂等，无下游扩散；"
                        "本行仅标记证据卫生债，不改历史",
                "ts": _bump(last_ts.get(jid, ""), fallback), "by": "closure-report.py",
            }, ensure_ascii=False))
        for jid, eff, demote_to, title, recurrence in sorted(fake_terminal):
            if recurrence:
                evidence = (f"framework-fix-tracker 条目「{title}」标 {RECURRENCE_MARK}(复发类)"
                            "——owner 回执/tests passed 不算收口，只有一次真实下轮实跑"
                            "(next-run-verified verdict=pass、同 key follow-up ≤ 阈值)才算；"
                            "越闸终态被降级回开放态，等实跑复发验证")
            else:
                evidence = (f"framework-fix-tracker 条目「{title}」非🟢——tracker 引用不算落地"
                            "(记录沉淀≠外部修复发生)，越闸终态(手写或旧版脚本盲发)被机制降级回开放态继续追 owner")
            print(json.dumps({
                "kind": "status-transition", "for_id": jid, "status": demote_to,
                "reason": "closure_gate_violation_demote", "evidence": evidence,
                "ts": _bump(last_ts.get(jid, ""), fallback), "by": "closure-report.py",
            }, ensure_ascii=False))
        return

    print(f"# SK judgment 收口自检  (today={today}, stale>={args.stale_days}d)")
    print(f"判定总数 judged        : {total}")
    print(f"终态(fixed+closed,含暂计): {closed_n}")
    print(f"  其中暂计(framework 未部署/复发未证/窗口收口,复发风险未消): {len(provisional)}")
    print(f"真实收口 true closure  : {true_closed}")
    print(f"闭环率 closure rate    : {rate:.1f}%  (真实,已剔除未部署暂计项)")
    print("状态分布(latest-wins)  :")
    for k in ("pending", "pending_interview", "awaiting_verdict", "confirmed", "fixed", "closed"):
        if k in dist:
            print(f"    {k:<18}{dist[k]}")
    for k, v in dist.items():
        if k not in ("pending", "pending_interview", "awaiting_verdict", "confirmed", "fixed", "closed"):
            print(f"    {str(k):<18}{v}")
    print()
    print(f"## 暂计:终态但 framework 未部署/复发未证/窗口收口,不计入真实闭环率  ({len(provisional)})")
    for jid in provisional:
        eff = effective.get(jid, base[jid].get("status"))
        tag = "窗口收口" if jid in window_closed else ("等实跑复发验证" if jid in awaiting_next_run_jids else "外部修复未达成")
        print(f"    {jid}  [{eff}]  ({tag})")
    print()
    print(f"## 漂移:已沉进规则却没标终态  ({len(drift)})  —— 跑 --emit 生成转移行")
    for jid, eff, want, reason, fname in sorted(drift):
        print(f"    {jid}  {eff} -> {want}  ({reason}, {fname})")
    print()
    print(f"## 缺闭环字段:confirmed/fixed 却无 applied_to_rule/outcome_verified  ({len(missing_closure)})")
    for jid, eff in sorted(missing_closure):
        print(f"    {jid}  [{eff}]  —— 追加 revision 补 applied_to_rule 或 outcome-verified 行")
    print()
    print(f"## 重复主判断行:同 id 多条实体行且未标记  ({len(dup_primary)})  —— 跑 --emit 生成 dedupe-annotation")
    for jid, c in dup_primary:
        print(f"    {jid}  x{c}")
    print()
    print(f"## 伪收口:终态但无有效落地依据(含复发类越闸)  ({len(fake_terminal)})  —— 跑 --emit 自动降级")
    for jid, eff, demote_to, title, recurrence in sorted(fake_terminal):
        tag = " [复发类:owner回执≠实跑]" if recurrence else ""
        print(f"    {jid}  {eff} -> {demote_to}  (<- {title}){tag}")
    print()
    print(f"## 等实跑复发验证:复发类修复,owner 回执不算,待真实下轮同 key follow-up ≤ 阈值  ({len(awaiting_next_run)})")
    for jid, title in sorted(set(awaiting_next_run)):
        eff = effective.get(jid, base[jid].get("status")) if jid in base else "?"
        print(f"    {jid}  [{eff}]  <- {title}  —— 下轮实跑后 append next-run-verified(verdict=pass/fail)")
    print()
    nrf = sorted(j for j in next_run_fail if j in base)
    print(f"## 实跑验证未通过:next-run-verified verdict=fail(复发仍在)  ({len(nrf)})  —— 修复没生效,重新追 owner")
    for jid in nrf:
        eff = effective.get(jid, base[jid].get("status"))
        print(f"    {jid}  [{eff}]")
    print()
    print(f"## 外部修复未达成:framework-fix-tracker 引用但 🟡/🔴 未部署  ({len(external_pending)})  —— 追 owner,不算收口")
    for jid, title in sorted(set(external_pending)):
        eff = effective.get(jid, base[jid].get("status")) if jid in base else "?"
        print(f"    {jid}  [{eff}]  <- {title}")
    print()
    print(f"## 升级候选:开放态 >= {args.stale_days} 天  ({len(stale)})")
    for a, jid, eff in stale[:20]:
        print(f"    {a:>3}d  {jid}  [{eff}]")
    if len(stale) > 20:
        print(f"    ... 另有 {len(stale)-20} 条")


if __name__ == "__main__":
    main()
