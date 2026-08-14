#!/bin/bash
# append-journal.sh — judgments.jsonl / 审计类 jsonl 的统一 append 入口。
#
# 为什么存在（2026-07-31 巡警 guided-fix 方向②收口）：
#   SOP 一直禁「ts 预填成未来时刻」，但手写 append 仍照犯（07-29 commit 876a7dd
#   06:19:50 的树内含 ts=06:20:00/06:21:00 行，main-session boomerang 手写）。
#   文字禁令拦不住，改成机械收口：所有手写 append 走本脚本，ts/ts_ms 由脚本
#   按真实落盘时刻强制覆盖，LLM 不再有机会自填 ts。
#
# 用法：
#   echo '{"kind":"next-run-verified","for_id":"judg-...",...}' | ./scripts/append-journal.sh state/judgments.jsonl
#   ./scripts/append-journal.sh state/judgments.jsonl < row.json
#
# 行为：从 stdin 读一个 JSON object，强制覆盖 ts=now(本地 ISO 带时区)；
# 若对象带 ts_ms 字段则同步覆盖为当前 epoch ms；其余字段原样保留，append 一行。
# 不查重、不校验业务字段——业务纪律（锚、查重、append-only）仍归 SOP 各步骤。

set -euo pipefail

TARGET="${1:?usage: append-journal.sh <jsonl-path> (JSON object on stdin)}"
PAYLOAD="$(cat)"   # stdin 全量读入，避免 heredoc 抢占 python 的 stdin

PAYLOAD="$PAYLOAD" python3 - "$TARGET" <<'EOF'
import json, sys, os, datetime

target = sys.argv[1]
raw = os.environ.get("PAYLOAD", "").strip()
if not raw:
    sys.exit("append-journal.sh: stdin 为空，期望一个 JSON object")
try:
    obj = json.loads(raw)
except Exception as e:
    sys.exit(f"append-journal.sh: stdin 不是合法 JSON: {e}")
if not isinstance(obj, dict):
    sys.exit("append-journal.sh: 期望顶层 JSON object")

now = datetime.datetime.now().astimezone()
obj["ts"] = now.strftime("%Y-%m-%dT%H:%M:%S%z")
if "ts_ms" in obj:
    obj["ts_ms"] = int(now.timestamp() * 1000)

os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
with open(target, "a") as f:
    f.write(json.dumps(obj, ensure_ascii=False) + "\n")
print(f"appended -> {target} ts={obj['ts']}")
EOF
