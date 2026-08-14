#!/bin/bash
# check-daily-review-outcome.sh
# 每日复盘的健康自检（无需 LLM 配额，可独立 / 挂 scheduler 跑）。
#
# 判绿判据 = 两道 gate 全过（2026-07-11 巡警整改：从「只认 child!=failed」升级为
#            「child 健康 且 当日真的复检了开放复发项」，堵住零产/仅 backlog-GC 的假绿）：
#   Gate 1  复盘子会话健康：scheduler v2 最近 run 的 child session 没有 status=failed。
#           连不上 scheduler → 本 gate 跳过（不判红），不阻塞 Gate 2。
#   Gate 2  复检覆盖(本地、无 scheduler 依赖、恒运行)：closure-report.py --recheck-worklist
#           的 owed 必须为空——即每一个开放复发类判断(等实跑 / 实跑 fail 未翻案)当天都已
#           append 一条 next-run-verified 或 recheck-skipped-with-reason。owed 非空 =
#           当天零产或只做了无关的 backlog-GC、漏检了在追的复发项 → 记 health + 告警 + 判红。
#
# 为什么加 Gate 2：07-07/08/09 三轮 guided-fix 反复硬化 closure-report.py 的收口闸门，
#   但闸门永远等不到新的实跑样本喂进来——因为 daily review 停止产出复检行(07-10 零产、
#   07-11 仅 GC)，而旧版本脚本 `if child!=failed: OK` 结构上放行这种 hollow green。
#   Gate 2 把「当日有没有复检开放复发项」变成机械判绿条件，让漏检当场判红。
#
# Gate 3 — 失败恢复半环（2026-07-31 巡警 guided-fix 方向①，恒运行、不改判绿退出码）：
#   Gate 1 只检出+告警，此后全程零动作——07-26~07-31 实证 6 天 4 次 child-failed
#   只有重复 recheck-owed，一次后端抖动等额抹掉一整天识别目的。Gate 3 补恢复阶梯：
#     L1 当日一次补跑：今日有 child-failed 且未补跑过 → spawn2.0 todo_pool 重派
#        socail-king 补跑今日复盘（client_request_id 按日幂等，409=已派过）。
#     L2 追踪补跑结局：补跑 child completed → 记 backfill-recovered；
#        failed → 记 backfill-failed 并升级用户（/api/notify level=error）。
#     L3 连续失败升级：昨日+今日连跪且今日未恢复 → 升级用户决策（每日最多一次）。
#   SK_RECOVERY_DRY_RUN=1 时只打印意图、不真发 spawn/notify、不写 health（隔离演练用）。
#   2026-08-01 巡警 guided-fix 补两个追踪漏洞（07-31 补跑 sess_child_423ccf4d 实测打穿）：
#     ① status 枚举收口：cancelled/timeout/error/unknown 等一切非 completed 终态按 failed
#        路径处理（记 backfill-failed 并进 L3 升级阶梯），不再落「进行中」分支永久挂起。
#     ② 跨零点追踪：未结补跑改按 childSessionId 追、不按 reviewDate=today 过滤；结局行
#        reviewDate 记补跑覆盖的复盘日、detectedDate 记检出日。
#
# Usage:
#   SM_SESSION_NAME=socail-king ./scripts/check-daily-review-outcome.sh
#   ./scripts/check-daily-review-outcome.sh  (reads SM_SESSION_NAME from env)
#
# Exit: 0 = 两道 gate 全过；1 = 有 gate 判红（child 失败 或 复检漏检）并已记录 + 告警。

set -uo pipefail  # 不用 -e：两道 gate 各自捕获错误、汇总退出码，避免中途 abort 漏跑 Gate 2

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$SCRIPT_DIR/state"
# HEALTH_FILE / TODAY 可用 env 覆盖，便于对本监控脚本做隔离 dry-run（默认走真实状态/系统日期）
HEALTH_FILE="${SK_HEALTH_FILE:-$STATE_DIR/daily-review-health.jsonl}"
CLOSURE_REPORT="$SCRIPT_DIR/scripts/closure-report.py"
TASK_ID="068f4358-49c7-47d1-aa4c-4850b5b68a48"  # socail-king-daily-cross-session-review
TODAY="${SK_REVIEW_TODAY:-$(date +%F)}"

# Resolve binding chat_id from supermatrix.db（脚本内动态解析，别硬编码字面值）
SM_DB="/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db"
SESSION_NAME="${SM_SESSION_NAME:-socail-king}"
CHAT_ID=$(sqlite3 "$SM_DB" "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id WHERE s.name='$SESSION_NAME' LIMIT 1;" 2>/dev/null || echo "oc_REDACTEDCHATID")

echo "=== Daily Review Health Check ==="
echo "Session : $SESSION_NAME"
echo "Task ID : $TASK_ID"
echo "Today   : $TODAY"
echo "Health  : $HEALTH_FILE"
echo ""

FAIL=0

# ============================================================================
# Gate 1 — 复盘子会话健康（scheduler v2 child status）
# 连不上 scheduler v2 → 跳过本 gate（不判红），继续 Gate 2。
# ============================================================================
echo "--- Gate 1: 复盘子会话健康 (scheduler v2 child status) ---"
RUNS_JSON=$(curl -sf "http://localhost:3502/tasks/$TASK_ID/runs?limit=5" 2>/dev/null || echo "[]")
RUNS_COUNT=$(echo "$RUNS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "0")

# 本轮 run 锚(2026-07-23 巡警整改：封 closure-report 自证环)——取 TODAY 当天 triggeredAt 最大的
# run 作「本轮」，供 Gate 2 传给 closure-report 做受锚判据：复检/landing 行须带此 run_id + 一条
# run 开始之后产出的外部 receipt 才算「本轮已复检」，自报 ts 不再放行。取不到(scheduler 连不上/
# 当天无 run) → 留空，Gate 2 退化到 ad-hoc 受锚(仍强制锚结构齐全，只是不再比 run start 新鲜性)。
CUR_RUN_ID=""; CUR_RUN_START=""
eval "$(echo "$RUNS_JSON" | TODAY="$TODAY" python3 -c "
import json, sys, os, datetime
try:
    runs = json.load(sys.stdin)
except Exception:
    runs = []
today = os.environ['TODAY']
def day(r):
    return datetime.datetime.fromtimestamp(r.get('triggeredAt', 0) / 1000).astimezone().strftime('%Y-%m-%d')
cand = [r for r in runs if r.get('triggeredAt') and day(r) == today]
r = max(cand, key=lambda x: x['triggeredAt']) if cand else None
if r:
    iso = datetime.datetime.fromtimestamp(r['triggeredAt'] / 1000).astimezone().isoformat()
    print('CUR_RUN_ID=%r' % r['id'])
    print('CUR_RUN_START=%r' % iso)
" 2>/dev/null)"
if [ -n "$CUR_RUN_ID" ]; then
  echo "本轮 run 锚: run_id=$CUR_RUN_ID  run_start=$CUR_RUN_START"
else
  echo "本轮 run 锚: (取不到——Gate 2 走 ad-hoc 受锚，仍强制锚结构齐全)"
fi

if [ "$RUNS_COUNT" -eq 0 ]; then
  echo "SKIP: scheduler v2 无 run 或连不上——Gate 1 跳过（不判红），继续 Gate 2。"
else
  echo "Found $RUNS_COUNT recent runs."
  G1_OUT=$(echo "$RUNS_JSON" | SESSION_NAME="$SESSION_NAME" CHAT_ID="$CHAT_ID" HEALTH_FILE="$HEALTH_FILE" TASK_ID="$TASK_ID" python3 -c "
import json, sys, os, datetime
from urllib.request import urlopen, Request

runs = json.load(sys.stdin)
health_file = os.environ['HEALTH_FILE']
chat_id = os.environ['CHAT_ID']
session_name = os.environ['SESSION_NAME']
task_id = os.environ['TASK_ID']

already_recorded = set()
try:
    with open(health_file) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                entry = json.loads(line)
                if entry.get('childSessionId'):
                    already_recorded.add(entry['childSessionId'])
            except Exception:
                pass
except FileNotFoundError:
    pass

found_any = False
for run in runs:
    run_id = run.get('id', '')
    triggered_at = run.get('triggeredAt', 0)
    child_id = run.get('childSessionId', '')
    if not child_id:
        continue
    try:
        req = Request(f'http://localhost:3501/api/sessions/{child_id}/result')
        with urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
    except Exception as e:
        print(f'WARN: Cannot check child {child_id}: {e}', file=sys.stderr)
        continue
    status = result.get('status', 'unknown')
    if status != 'failed':
        print(f'OK: {child_id} -> status={status}')
        continue
    error_msg = result.get('errorMessage', 'unknown error')
    if child_id in already_recorded:
        print(f'ALREADY KNOWN: {child_id} -> FAILED: {error_msg}')
        continue
    found_any = True
    entry = {
        'ts': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'kind': 'child-failed', 'childSessionId': child_id, 'taskId': task_id,
        'runId': run_id, 'triggeredAt': triggered_at, 'errorMessage': error_msg,
        'healthCheckRun': True,
    }
    os.makedirs(os.path.dirname(health_file), exist_ok=True)
    with open(health_file, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    print(f'NEW FAILURE: {child_id} -> {error_msg}')
    payload = json.dumps({
        'source': session_name, 'title': '每日复盘执行失败',
        'body': f'复盘 child session {child_id} 失败: {error_msg}（scheduler v2 仍标记为 success——这是假成功）',
        'level': 'warn', 'targetChatId': chat_id,
        'metadata': {'runId': run_id, 'childSessionId': child_id, 'errorMessage': error_msg, 'healthCheck': True, 'taskId': task_id},
    }).encode()
    try:
        with urlopen(Request('http://127.0.0.1:3501/api/notify', data=payload, headers={'Content-Type': 'application/json'}), timeout=10) as r:
            ar = json.loads(r.read())
        with open(health_file, 'a') as f:
            f.write(json.dumps({'ts': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'kind': 'alert-sent', 'childSessionId': child_id, 'messageId': ar.get('messageId', ''), 'deduped': ar.get('deduped', False)}, ensure_ascii=False) + '\n')
        print(f'ALERT SENT: messageId={ar.get(\"messageId\")}')
    except Exception as e:
        print(f'ALERT FAILED: {e}', file=sys.stderr)

sys.exit(1 if found_any else 0)
" 2>&1)
  G1_RET=$?
  echo "$G1_OUT"
  if [ "$G1_RET" -ne 0 ]; then FAIL=1; echo "Gate 1: RED（有 child failed 新增）"; else echo "Gate 1: green"; fi
fi
echo ""

# ============================================================================
# Gate 2 — 复检覆盖（本地，无 scheduler 依赖，恒运行）
# owed 非空 = 当天漏检了在追的开放复发项 → 记 health + 告警 + 判红。
# ============================================================================
echo "--- Gate 2: 复检覆盖 (closure-report.py --recheck-worklist) ---"
G2_OUT=$(SESSION_NAME="$SESSION_NAME" CHAT_ID="$CHAT_ID" HEALTH_FILE="$HEALTH_FILE" \
  CLOSURE_REPORT="$CLOSURE_REPORT" TODAY="$TODAY" \
  RUN_ID_ENV="$CUR_RUN_ID" RUN_START_ENV="$CUR_RUN_START" python3 -c "
import json, os, subprocess, sys, datetime
from urllib.request import urlopen, Request

health_file = os.environ['HEALTH_FILE']
chat_id = os.environ['CHAT_ID']
session_name = os.environ['SESSION_NAME']
report = os.environ['CLOSURE_REPORT']
today = os.environ['TODAY']
run_id = os.environ.get('RUN_ID_ENV', '')      # 本轮 run 锚(空=ad-hoc 受锚)
run_start = os.environ.get('RUN_START_ENV', '')

# 复盘未到点排除(2026-07-18 巡警整改，item ③)：日常复盘 06:00 才跑，check 每 2h 跑一轮；
# 06:00 前 owed 必然非空(今日还没产出复检行)，此时判红是「复盘未到点」的假警。只在
# 「查的就是今天」且当前本地时刻 < 复盘应完成时刻(默认 07:00 = 06:00 + 1h 缓冲) 时跳过判红。
# TODAY 被覆盖成过去日期(backfill/dry-run)时不套用本 guard，照常判红。
due_hour = int(os.environ.get('SK_REVIEW_DUE_HOUR', '7'))
_now = datetime.datetime.now()
if today == _now.strftime('%Y-%m-%d') and _now.hour < due_hour:
    print(f'SKIP: 复盘未到点（本地 {_now.hour:02d}:00 < {due_hour:02d}:00，今日 06:00 复盘尚未产出/完成），Gate 2 不判红。')
    sys.exit(0)

cmd = ['python3', report, '--recheck-worklist', '--today', today]
if run_id:
    cmd += ['--run-id', run_id]
if run_start:
    cmd += ['--run-start', run_start]
try:
    raw = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=60).decode()
    wl = json.loads(raw)
except Exception as e:
    print(f'WARN: 无法计算 recheck worklist: {e}', file=sys.stderr)
    print('Gate 2: SKIP（worklist 计算失败，不判红）')
    sys.exit(0)

owed = wl.get('owed', [])
required = wl.get('recheck_required', [])
print(f'开放复发类判断(recheck_required): {len(required)} 条')
for r in required:
    mark = 'OK 今日已复检' if r.get('rechecked_today') else 'OWED 今日未复检'
    print(f\"    {r['jid']}  [{r['status']}]  last={r.get('last_recheck_ts','')}  -> {mark}\")

if not owed:
    print('Gate 2: green（开放复发项当日全部已留复检行）')
    sys.exit(0)

# 当日去重：同一天已记过 recheck-owed(同 owed 集合)就不重复告警，避免多次跑刷屏。
# 按 reviewDate(本地 today)去重，不按 ts——ts 曾用 utcnow(),本地 00:00-08:00 窗内 UTC 日期
# 落后一天，ts.startswith(today) 恒 False → dedup 失效、每轮重发(实测每日 5 条假警)。reviewDate
# 就是本地 today，时区无关(2026-07-18 巡警整改，item ③)。
already_today = False
try:
    with open(health_file) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            if e.get('kind') == 'recheck-owed' and e.get('reviewDate') == today \
               and set(e.get('owed', [])) == set(owed):
                already_today = True
except FileNotFoundError:
    pass

entry = {
    'ts': datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'),
    'kind': 'recheck-owed', 'reviewDate': today, 'owed': owed,
    'note': '当日复盘漏检开放复发/landing 项——零产或仅 backlog-GC，未 append next-run-verified/recheck-skipped-with-reason/landing-checked',
    'healthCheckRun': True,
}
os.makedirs(os.path.dirname(health_file), exist_ok=True)
with open(health_file, 'a') as f:
    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
print(f'RED: 漏检 {len(owed)} 条开放复发/landing 项: {owed}')

if not already_today:
    body = f\"{today} 复盘漏检 {len(owed)} 条开放复发/landing 判断（{', '.join(owed)}）——当日零产或仅做无关 backlog-GC，没给在追的项留复检行。跑 SOP Step 7 复检并 append next-run-verified/recheck-skipped-with-reason/landing-checked。\"
    payload = json.dumps({
        'source': session_name, 'title': '每日复盘漏检开放复发/landing 项',
        'body': body, 'level': 'warn', 'targetChatId': chat_id,
        'metadata': {'owed': owed, 'reviewDate': today, 'healthCheck': True, 'gate': 'recheck-coverage'},
    }).encode()
    try:
        with urlopen(Request('http://127.0.0.1:3501/api/notify', data=payload, headers={'Content-Type': 'application/json'}), timeout=10) as r:
            ar = json.loads(r.read())
        with open(health_file, 'a') as f:
            f.write(json.dumps({'ts': datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z'), 'kind': 'alert-sent', 'reviewDate': today, 'gate': 'recheck-coverage', 'messageId': ar.get('messageId', ''), 'deduped': ar.get('deduped', False)}, ensure_ascii=False) + '\n')
        print(f'ALERT SENT: messageId={ar.get(\"messageId\")}')
    except Exception as e:
        print(f'ALERT FAILED: {e}', file=sys.stderr)
else:
    print('（同 owed 集合当日已告警，跳过重复告警）')

sys.exit(1)
" 2>&1)
G2_RET=$?
echo "$G2_OUT"
if [ "$G2_RET" -ne 0 ]; then FAIL=1; echo "Gate 2: RED（复检漏检）"; fi
echo ""

# ============================================================================
# Gate 3 — 失败恢复半环（2026-07-31 巡警 guided-fix；动作门，不改 FAIL 退出码）
# 今日 06:00 child-failed → 当日一次补跑；补跑失败或连续两日失败 → 升级用户。
# ============================================================================
echo "--- Gate 3: 失败恢复半环 (backfill / escalation ladder) ---"
SESSION_NAME="$SESSION_NAME" CHAT_ID="$CHAT_ID" HEALTH_FILE="$HEALTH_FILE" \
TODAY="$TODAY" python3 - <<'PYEOF'
import json, os, sys, datetime
from urllib.request import urlopen, Request
from urllib.error import HTTPError

health_file = os.environ['HEALTH_FILE']
chat_id = os.environ['CHAT_ID']
session_name = os.environ['SESSION_NAME']
today = os.environ['TODAY']
DRY = os.environ.get('SK_RECOVERY_DRY_RUN') == '1'
API_BASE = os.environ.get('SM_API_BASE', 'http://127.0.0.1:3501')  # env 可覆盖，便于隔离测试

entries = []
try:
    with open(health_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                pass
except FileNotFoundError:
    pass

def local_date_of(e):
    ta = e.get('triggeredAt')
    if ta:
        return datetime.datetime.fromtimestamp(ta / 1000).astimezone().strftime('%Y-%m-%d')
    return (e.get('ts') or '')[:10] or None

def has(kind, **kw):
    for e in entries:
        if e.get('kind') == kind and all(e.get(k) == v for k, v in kw.items()):
            return e
    return None

def append_row(row):
    row['ts'] = datetime.datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')
    if DRY:
        print('DRY-RUN would append:', json.dumps(row, ensure_ascii=False))
        return
    os.makedirs(os.path.dirname(health_file), exist_ok=True)
    with open(health_file, 'a') as f:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')

def notify(title, body, level, metadata):
    payload = json.dumps({'source': session_name, 'title': title, 'body': body,
                          'level': level, 'targetChatId': chat_id, 'metadata': metadata}).encode()
    if DRY:
        print(f'DRY-RUN would notify: [{level}] {title}')
        return {'messageId': 'dry-run'}
    with urlopen(Request(f'{API_BASE}/api/notify', data=payload,
                         headers={'Content-Type': 'application/json'}), timeout=10) as r:
        return json.loads(r.read())

failed_today = [e for e in entries if e.get('kind') == 'child-failed' and local_date_of(e) == today]

# 补跑结局集合：一个 backfill child 已有任一结局行即算收口，不再重复追。
# backfill-cancelled 是复盘 child 自检补记的终态行（字段名是 backfillChildSessionId）。
done_children = set()
for e in entries:
    if e.get('kind') in ('backfill-recovered', 'backfill-failed') and e.get('childSessionId'):
        done_children.add(e['childSessionId'])
    elif e.get('kind') == 'backfill-cancelled' and e.get('backfillChildSessionId'):
        done_children.add(e['backfillChildSessionId'])

# 未结补跑按 childSessionId 追、不按 reviewDate=today 过滤（2026-08-01 巡警 guided-fix 漏洞②：
# 补跑跨零点才出终态时按 today 过滤，昨日补跑永远零追踪——07-31 补跑 22:07 才被 cancelled 实测）。
outstanding = None
for e in reversed(entries):
    if e.get('kind') == 'backfill-dispatched' and e.get('childSessionId') \
            and e['childSessionId'] not in done_children:
        outstanding = e
        break

bf_failed = bool(has('backfill-failed', reviewDate=today))
bf_reason = '当日补跑也失败'

# 进行中 status 白名单；其余一切非 completed 终态都走 failed 路径（2026-08-01 巡警 guided-fix
# 漏洞①：cancelled 曾落 else 分支被当「补跑进行中」永久挂起，永远到不了 L2 failed 和 L3 升级）。
IN_PROGRESS = {'running', 'pending', 'queued', 'starting', 'in_progress', 'in_flight'}

if outstanding:
    # L2 — 追未结补跑的结局（可能来自昨日，跨零点收口）
    child = outstanding['childSessionId']
    disp_date = outstanding.get('reviewDate') or today
    try:
        with urlopen(f'{API_BASE}/api/sessions/{child}/result', timeout=10) as r:
            res = json.loads(r.read())
        st = res.get('status', 'unknown')
    except Exception as ex:
        # 查询本身失败是瞬时故障、不是补跑终态——下轮再追，不误判 failed
        print(f'WARN: 无法查询 backfill child {child}: {ex}（下轮再追）')
        sys.exit(0)
    if st == 'completed':
        append_row({'kind': 'backfill-recovered', 'reviewDate': disp_date,
                    'detectedDate': today, 'childSessionId': child})
        print(f'BACKFILL RECOVERED: {child} completed——{disp_date} 复盘已由补跑产出。')
        sys.exit(0)
    if st in IN_PROGRESS:
        print(f'Gate 3: 补跑进行中（{child} status={st}，reviewDate={disp_date}），下轮再看。')
        sys.exit(0)
    # 一切非 completed 终态（failed/cancelled/timeout/error/unknown…）按 failed 路径处理；
    # cancelled by user 通过 status/errorMessage 单列，但不许落「进行中」分支永久挂起。
    bf_failed = True
    bf_reason = (f'当日补跑也失败（status={st}）' if disp_date == today
                 else f'补跑终态 {st}（{disp_date} 复盘的补跑，跨零点收口）')
    append_row({'kind': 'backfill-failed', 'reviewDate': disp_date, 'detectedDate': today,
                'childSessionId': child, 'status': st,
                'errorMessage': res.get('errorMessage', '')})
    print(f'BACKFILL FAILED: {child} status={st} -> {res.get("errorMessage", "")}')
    if disp_date != today and failed_today and not has('backfill-dispatched', reviewDate=today):
        print(f'（{disp_date} 补跑已跨零点收口；今日 child-failed 的补跑由下一轮按 L1 另派。）')
else:
    if not failed_today:
        print('Gate 3: 今日无 child-failed，无需恢复动作。')
        sys.exit(0)
    if has('backfill-recovered', reviewDate=today):
        print('Gate 3: 今日补跑已恢复（backfill-recovered 在案），无需动作。')
        sys.exit(0)

    disp = has('backfill-dispatched', reviewDate=today)
    if not disp:
        # L1 — 当日一次补跑（按日幂等：client_request_id 含日期，409=已派过）
        fail = failed_today[-1]
        err = fail.get('errorMessage', '')
        prompt = (
            f'今日 06:00 日常复盘子会话失败（{err}），这是当日一次补跑。'
            '请按 sop/ 下 active 版 SOP-judgment-via-interview 跑今日日常复盘 Step 1-7 并在自己侧闭环。'
            '这是补跑：先查 state/judgments.jsonl 与 state/daily-review-health.jsonl 今日已有产物，'
            '幂等补位、不重复已完成子步骤；手写 append 一律走 scripts/append-journal.sh。')
        body = {'from': session_name, 'target': session_name, 'prompt': prompt,
                'client_request_id': f'{today}:{session_name}:{session_name}:daily-review-backfill',
                'closure': {'kind': 'message', 'target': {'type': 'todo_pool'}}}
        if DRY:
            print('DRY-RUN would dispatch backfill:', body['client_request_id'])
            comm_id, child = 'dry-run', ''
        else:
            try:
                with urlopen(Request(f'{API_BASE}/api/spawn2.0',
                                     data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'}), timeout=30) as r:
                    resp = json.loads(r.read())
            except HTTPError as he:  # 409 duplicate = 已派过，沿用 existing
                resp = json.loads(he.read())
            existing = resp.get('existing', {}) or {}
            comm_id = resp.get('commId') or existing.get('commId', '')
            child = resp.get('childSessionId') or existing.get('childSessionId', '')
        append_row({'kind': 'backfill-dispatched', 'reviewDate': today,
                    'forChildSessionId': fail.get('childSessionId', ''),
                    'commId': comm_id, 'childSessionId': child, 'errorMessage': err})
        print(f'BACKFILL DISPATCHED: commId={comm_id} child={child}')
        sys.exit(0)
    if not disp.get('childSessionId'):
        print('WARN: backfill-dispatched 无 childSessionId，无法追踪补跑结局。')

# L3 — 升级阶梯：补跑也失败，或连续两日 06:00 连跪且今日未恢复（每日最多升级一次）
yday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
failed_yday = any(e.get('kind') == 'child-failed' and local_date_of(e) == yday for e in entries)
if (bf_failed or failed_yday) and not has('escalated-to-user', reviewDate=today):
    reason = bf_reason if bf_failed else '连续两日 06:00 复盘 child 失败'
    ar = notify('每日复盘连续失败，需用户决策',
                f'{today} 复盘失败升级：{reason}。已按阶梯自动补跑一次仍未恢复。'
                '请决策：检查后端配额/凭据、暂停 06:00 任务，或更换 backend。',
                'error', {'reviewDate': today, 'healthCheck': True, 'gate': 'recovery-escalation'})
    append_row({'kind': 'escalated-to-user', 'reviewDate': today, 'reason': reason,
                'messageId': ar.get('messageId', '')})
    print(f'ESCALATED TO USER: {reason}')
else:
    print('Gate 3: 未达升级条件（补跑结局未出或今日已升级）。')
PYEOF
echo ""

echo "=== 结果: $([ "$FAIL" -eq 0 ] && echo GREEN || echo RED) ==="
exit "$FAIL"
