#!/usr/bin/env python3
"""gate3-backfill-tracking.test.py — Gate 3 补跑结局追踪回归测试（2026-08-01 巡警 guided-fix）。

事故背景：07-31 21:37 Gate3 派的补跑 child sess_child_423ccf4d 于 22:07 被用户取消
（status=cancelled）。旧实现两个漏洞被同时打穿：
  ① status 枚举盲区——L2 只处理 completed/failed，cancelled 落 else 被当「补跑进行中」
     永久挂起，永远到不了 backfill-failed 和 L3 escalated-to-user；
  ② 跨零点追踪断档——L2 按 reviewDate=today 找 backfill-dispatched，08-01 的 run 对
     07-31 派的补跑零追踪（backfill-cancelled 是复盘 child 自检补记的，不是 Gate3 追到的）。

本测试从 scripts/check-daily-review-outcome.sh 抽出 Gate 3 的 PYEOF 块，用假 API server
（/api/sessions/<id>/result、/api/notify、/api/spawn2.0）隔离驱动，锁以下行为：
  1  跨零点 cancelled/timeout/error/unknown/failed 终态 → 记 backfill-failed（reviewDate=
     补跑覆盖日、detectedDate=检出日、status 单列）+ L3 升级（notify + escalated-to-user）
  2  running → 「进行中」下轮再追，零新行
  3  completed → backfill-recovered，reviewDate=补跑覆盖日
  4  查询本身失败（500）→ 瞬时故障不误判 failed，零新行
  5  自检补记的 backfill-cancelled 行 = 已收口，不再重复追踪/升级
  6  L1 不受影响：今日 child-failed 且无未结补跑 → 正常派补跑
  7  当日补跑 cancelled → reviewDate=当日、reason 为「当日补跑也失败（status=cancelled）」

跑法：python3 test/gate3-backfill-tracking.test.py   (exit 0 全过，非 0 有失败)
"""
import json, os, re, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "scripts", "check-daily-review-outcome.sh")
TODAY = "2026-08-01"
YDAY = "2026-07-31"

src = open(SCRIPT).read()
m = re.search(r"python3 - <<'PYEOF'\n(.*?)\nPYEOF", src, re.S)
assert m, "抽不到 Gate 3 PYEOF 块——脚本结构变了，测试要同步"
GATE3_SRC = m.group(1)


class FakeAPI(BaseHTTPRequestHandler):
    results = {}  # child_id -> (status, errorMessage) 或 'RAISE'
    gets = []     # 被查询的 child_id
    posts = []    # (path, body)

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        mm = re.match(r'/api/sessions/([^/]+)/result', self.path)
        if mm:
            self.gets.append(mm.group(1))
            v = self.results.get(mm.group(1))
            if v == 'RAISE':
                self.send_error(500)
                return
            if v:
                self._send(200, {'status': v[0], 'errorMessage': v[1]})
                return
        self.send_error(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        self.posts.append((self.path, body))
        if self.path == '/api/notify':
            self._send(200, {'messageId': 'om_fake'})
        elif self.path == '/api/spawn2.0':
            self._send(200, {'commId': 'comm_fake', 'childSessionId': 'sess_new_backfill'})
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


FAILED_YDAY = {'kind': 'child-failed', 'childSessionId': 'sess_main_y', 'taskId': 't',
               'errorMessage': 'kimi returned empty completion', 'ts': YDAY + 'T00:00:00Z'}
DISPATCH_YDAY = {'kind': 'backfill-dispatched', 'reviewDate': YDAY,
                 'forChildSessionId': 'sess_main_y', 'commId': 'c',
                 'childSessionId': 'sess_bf_y', 'errorMessage': 'kimi returned empty completion',
                 'ts': YDAY + 'T21:37:48+0800'}

failures = []


def run_case(name, health_rows, api_results, today=TODAY):
    with tempfile.TemporaryDirectory() as td:
        hf = os.path.join(td, 'health.jsonl')
        with open(hf, 'w') as f:
            for r in health_rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
        g3 = os.path.join(td, 'gate3.py')
        with open(g3, 'w') as f:
            f.write(GATE3_SRC)
        FakeAPI.results = api_results
        FakeAPI.gets, FakeAPI.posts = [], []
        server = ThreadingHTTPServer(('127.0.0.1', 0), FakeAPI)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        try:
            env = dict(os.environ, HEALTH_FILE=hf, TODAY=today, CHAT_ID='oc_test',
                       SESSION_NAME='socail-king', SM_API_BASE=f'http://127.0.0.1:{port}')
            env.pop('SK_RECOVERY_DRY_RUN', None)
            p = subprocess.run([sys.executable, g3], env=env, capture_output=True,
                               text=True, timeout=60)
        finally:
            server.shutdown()
        with open(hf) as f:
            rows = [json.loads(l) for l in f if l.strip()]
        return p, rows[len(health_rows):], list(FakeAPI.gets), list(FakeAPI.posts)


def check(name, cond, detail=''):
    if cond:
        print(f'  PASS {name}')
    else:
        print(f'  FAIL {name}  {detail}')
        failures.append(name)


# --- Case 1: 跨零点 + 非 completed 终态（漏洞①② 事故复现，逐 status 过） ---
for st, err in [('cancelled', 'cancelled by user'), ('timeout', 'timed out'),
                ('error', 'backend error'), ('unknown', ''), ('failed', 'boom')]:
    p, new, gets, posts = run_case(f'cross-midnight {st}', [FAILED_YDAY, DISPATCH_YDAY],
                                   {'sess_bf_y': (st, err)})
    bf = [r for r in new if r.get('kind') == 'backfill-failed']
    esc = [r for r in new if r.get('kind') == 'escalated-to-user']
    check(f'1.{st} 追到昨日补跑并记 backfill-failed',
          len(bf) == 1 and bf[0].get('reviewDate') == YDAY
          and bf[0].get('detectedDate') == TODAY
          and bf[0].get('childSessionId') == 'sess_bf_y'
          and bf[0].get('status') == st,
          f'new={new}')
    check(f'1.{st} 进 L3 升级（escalated-to-user + notify）',
          len(esc) == 1 and any(path == '/api/notify' for path, _ in posts),
          f'new={new} posts={posts}')
    check(f'1.{st} 不再落「进行中」分支', '进行中' not in p.stdout, p.stdout)

# --- Case 2: running = 真进行中，下轮再追、零新行 ---
p, new, gets, posts = run_case('running', [FAILED_YDAY, DISPATCH_YDAY],
                               {'sess_bf_y': ('running', '')})
check('2 running 零新行且提示进行中', not new and '进行中' in p.stdout and p.returncode == 0,
      f'new={new} out={p.stdout}')

# --- Case 3: completed → backfill-recovered，reviewDate=补跑覆盖日 ---
p, new, gets, posts = run_case('completed', [FAILED_YDAY, DISPATCH_YDAY],
                               {'sess_bf_y': ('completed', '')})
rec = [r for r in new if r.get('kind') == 'backfill-recovered']
check('3 completed 记 backfill-recovered(reviewDate=昨日)',
      len(rec) == 1 and rec[0].get('reviewDate') == YDAY
      and rec[0].get('detectedDate') == TODAY and p.returncode == 0, f'new={new}')

# --- Case 4: 查询本身失败(500) = 瞬时故障，不误判 failed ---
p, new, gets, posts = run_case('query-500', [FAILED_YDAY, DISPATCH_YDAY],
                               {'sess_bf_y': 'RAISE'})
check('4 查询失败零新行、WARN 下轮再追',
      not new and 'WARN' in p.stdout and p.returncode == 0, f'new={new} out={p.stdout}')

# --- Case 5: 自检补记的 backfill-cancelled = 已收口，不重复追踪 ---
CANCEL_ROW = {'kind': 'backfill-cancelled', 'reviewDate': YDAY,
              'forChildSessionId': 'sess_main_y', 'backfillChildSessionId': 'sess_bf_y',
              'errorMessage': 'cancelled by user', 'ts': TODAY + 'T06:01:00+0800'}
p, new, gets, posts = run_case('self-recorded-cancel', [FAILED_YDAY, DISPATCH_YDAY, CANCEL_ROW], {})
check('5 backfill-cancelled 在案即收口（零查询零新行）',
      not new and not gets and p.returncode == 0, f'new={new} gets={gets} out={p.stdout}')

# --- Case 6: L1 不受影响——今日 child-failed 且无未结补跑 → 正常派补跑 ---
FAILED_TODAY = {'kind': 'child-failed', 'childSessionId': 'sess_main_t', 'taskId': 't',
                'errorMessage': 'kimi returned empty completion', 'ts': TODAY + 'T06:10:00+0800'}
p, new, gets, posts = run_case('L1-dispatch', [FAILED_TODAY], {})
disp = [r for r in new if r.get('kind') == 'backfill-dispatched']
check('6 今日失败正常派补跑（backfill-dispatched + spawn POST）',
      len(disp) == 1 and disp[0].get('reviewDate') == TODAY
      and any(path == '/api/spawn2.0' for path, _ in posts), f'new={new} posts={posts}')

# --- Case 7: 当日补跑 cancelled → reviewDate=当日、reason 指明 status ---
DISPATCH_TODAY = {'kind': 'backfill-dispatched', 'reviewDate': TODAY,
                  'forChildSessionId': 'sess_main_t', 'commId': 'c2',
                  'childSessionId': 'sess_bf_t', 'errorMessage': 'x', 'ts': TODAY + 'T08:00:00+0800'}
p, new, gets, posts = run_case('today-cancelled', [FAILED_TODAY, DISPATCH_TODAY],
                               {'sess_bf_t': ('cancelled', 'cancelled by user')})
bf = [r for r in new if r.get('kind') == 'backfill-failed']
esc = [r for r in new if r.get('kind') == 'escalated-to-user']
check('7 当日补跑 cancelled 记 failed(reviewDate=当日) + 升级 reason 含 status',
      len(bf) == 1 and bf[0].get('reviewDate') == TODAY
      and len(esc) == 1 and 'cancelled' in esc[0].get('reason', ''),
      f'new={new}')

print()
if failures:
    print(f'FAILED: {len(failures)} 个断言没过: {failures}')
    sys.exit(1)
print('ALL PASS — Gate 3 补跑追踪：非 completed 终态收口 + 跨零点追踪 两个漏洞已锁死。')
