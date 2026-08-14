#!/bin/bash
# 验证：心跳待办池能否把待办注入回主 session 并触发执行。
# 检查对象：todo_33ff262ca41c（socail-king 自挂的简单计算待办）
# 由 1 小时后的 oneshot 定时任务调用。独立核对客观事实，不信任何人的自述。
set -u
HB_DB=/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/heartbeat/data/heartbeat.sqlite
TODO_ID=todo_33ff262ca41c
RESULT_FILE=/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/socail-king/state/heartbeat-inject-test.txt
EXPECT=12387
CHAT=oc_REDACTEDCHATID
OUT=/tmp/sk-hb-verify-verdict.txt

row=$(sqlite3 -separator '|' "$HB_DB" \
  "SELECT status,COALESCE(injected_at,''),COALESCE(claimed_at,''),COALESCE(finished_at,'') \
   FROM session_todos WHERE todo_id='$TODO_ID';" 2>/dev/null)
status=$(echo "$row"   | cut -d'|' -f1)
injected=$(echo "$row" | cut -d'|' -f2)
claimed=$(echo "$row"  | cut -d'|' -f3)
finished=$(echo "$row" | cut -d'|' -f4)

file_state="缺失"; file_body=""
if [ -f "$RESULT_FILE" ]; then
  file_body=$(cat "$RESULT_FILE")
  if echo "$file_body" | grep -q "$EXPECT"; then file_state="存在且结果正确($EXPECT)"
  else file_state="存在但结果不含 $EXPECT"; fi
fi

# 判定
if [ -z "$status" ]; then
  verdict="✗ 异常：待办行查不到（$TODO_ID 不存在）"
elif [ "$status" = "pending" ]; then
  verdict="✗ 注入失败：1 小时过去待办仍是 pending，heartbeat patrol 从没把它注入主 session。"
elif [ -f "$RESULT_FILE" ] && echo "$file_body" | grep -q "$EXPECT"; then
  verdict="✓ 全链路通：待办被注入(status=$status)，主 session 执行并写出了正确结果。"
else
  verdict="△ 注入到了但没触发执行：待办 status=$status（injected_at=$injected），但结果文件 $file_state —— 注入发生了，主 session 没真正动手。"
fi

events=$(sqlite3 -separator ' | ' "$HB_DB" \
  "SELECT created_at,event_type,decision,status FROM heartbeat_events \
   WHERE target_session='socail-king' AND created_at>='2026-05-19T06:17:00' \
   ORDER BY created_at DESC LIMIT 8;" 2>/dev/null)

{
  echo "心跳注入测试 — 验证报告"
  echo "检查时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "----------------------------------------"
  echo "$verdict"
  echo "----------------------------------------"
  echo "待办行 $TODO_ID："
  echo "  status   = ${status:-(空)}"
  echo "  injected_at = ${injected:-(无)}"
  echo "  claimed_at  = ${claimed:-(无)}"
  echo "  finished_at = ${finished:-(无)}"
  echo "结果文件 $RESULT_FILE：$file_state"
  [ -n "$file_body" ] && { echo "  文件内容："; echo "$file_body" | sed 's/^/    /'; }
  echo "----------------------------------------"
  echo "socail-king 相关 heartbeat_events（最近 8 条）："
  echo "${events:-  (无)}"
} > "$OUT"

cat "$OUT"
cd /tmp && lark-cli im +messages-send --as bot --chat-id "$CHAT" --file ./sk-hb-verify-verdict.txt >/dev/null 2>&1 \
  && echo "[已发 SK 飞书群]" || echo "[飞书发送失败，结果见 $OUT]"
