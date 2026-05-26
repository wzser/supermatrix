# {{name}}

> **首次激活说明 — 这是临时的"上线初始化运行手册"**
>
> 你是刚被 supermatrix-root `/new` 命令创建出来的新 session。本文件目前是
> 通用初始 stub，不是你最终的 CLAUDE.md/AGENTS.md。完成下方「自驱初始化
> 流程」后，first-principle 的 fp-generate-init CLI 会返回正式版本，并由
> 你自己把它覆写到本文件位置。在那之前，**严格按本文件执行**。
>
> backend 适配：本 stub 同时是 claude backend 的 `CLAUDE.md` 和 codex
> backend 的 `AGENTS.md`。最终落盘文件名由 `fp-generate-init` 在 JSON
> 里返回的 `config_md_filename` 决定，**不要在 stub 里硬编码**，统一用
> `$FILENAME` 变量。

---

## 第 0 步：每次激活先判断是否需要初始化

每次被激活，**第一件事**就是判断「是否已经初始化完毕」。两种判定方式
任一为「已初始化」即可跳过：

```bash
# (a) sessions 表的 category 列非空
CATEGORY=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT category FROM sessions WHERE name='$SM_SESSION_NAME' LIMIT 1;")

# (b) workdir 下的 .init-state.json 已被清理（不存在）
[ -f .init-state.json ] && IN_PROGRESS=1 || IN_PROGRESS=0
```

- `CATEGORY` 非空 且 `IN_PROGRESS=0` → 已初始化，跳过本文件其余内容，按
  正常 session 工作（此时本文件应已被 FP 生成的正式版覆写，不会再被读到）。
- `CATEGORY` 为空 → 进入「自驱初始化流程」。
- `CATEGORY` 为空 且 `.init-state.json` 已存在 → 上次初始化中断，**续上**
  剩余字段，不要从头问。

---

## 自驱初始化流程（不要等用户开口，激活的第一句话就是问候 + 问 4 字段）

### 步骤 1：拿到自己的群 chat_id

```bash
CHAT_ID=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id \
   WHERE s.name='$SM_SESSION_NAME' LIMIT 1;")
```

### 步骤 2：在群里**主动**发出第一句问候 + 索要 4 字段

激活的**第一句话**必须直接是给用户的问候 + 字段问询；**不要**等用户先
开口，**不要**先去读其他文档。

要收集的 4 个字段：

- **alias** — 人类可读的名字（如 `ads-master`、`amz-listing-tool`）
- **avatar** — 头像；接受 emoji（如 🤖）/ URL / 本地文件路径 任一种，
  stub 不解析、不强校验
- **category** — 必须 5 选 1：`业务` / `知识` / `平台` / `工具` / `外部`
- **purpose** — 一句话职责描述（用于群描述，建议 ≤100 字）

发问示例（一次问全；也可以分轮，自行判断，规则只有「不阻塞」「不重复
问已收到的字段」）：

```bash
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --text "👋 你好，我是新建的 session $SM_SESSION_NAME，请帮我把以下 4 个字段补齐：

1) alias — 人类可读名字（例：ads-master）
2) avatar — emoji / URL / 本地路径都行
3) category — 必须 5 选 1：业务 / 知识 / 平台 / 工具 / 外部
4) purpose — 一句话职责（≤100 字）

可以一次性发齐，也可以一项一项答；我收齐后会自动写入并改群名/群描述/群头像。"
```

### 步骤 3：每收到部分答案立刻持久化到 `.init-state.json`

每收到一个字段就立刻 append/update 到 workdir 根目录下的
`.init-state.json`（schema 固定）：

```json
{
  "alias": "...",
  "avatar": "...",
  "category": "...",
  "purpose": "...",
  "started_at": "2026-04-27T10:00:00Z"
}
```

下次激活如果 `.init-state.json` 还在，**先读它**，已收字段不再问，只问
剩下的——这是「中断续上」的唯一机制。

### 步骤 4：校验

- `category` ∈ `{业务, 知识, 平台, 工具, 外部}` —— 否则群里告知 + 重问该字段
- `alias` 非空 —— 否则重问
- `purpose` 非空 —— 否则重问
- `avatar` 非空（不解析、不强校验）—— 否则重问

### 步骤 5：4 字段齐全后调 FP CLI 拿模板内容

**直接同机 shell 调**（同机权限相同，最简单）：

```bash
FP_CLI=<SM_WORKSPACE_ROOT>/first-principle/bin/fp-generate-init
"$FP_CLI" \
  --category "$CATEGORY_VALUE" \
  --alias    "$ALIAS_VALUE" \
  --avatar   "$AVATAR_VALUE" \
  --purpose  "$PURPOSE_VALUE" \
  --backend  "<claude|codex — 由你自己知道>" \
  --session-name "$SM_SESSION_NAME" \
  --workdir  "$PWD" \
  > /tmp/fp-init-$$.json
```

> **为什么不走 spawn**：同机直接 CLI 调，参数清楚、错误清楚，避免 spawn
> 的自然语言 prompt 转译失败。spawn 仅在 fp-generate-init 不可达时作为
> fallback。

解析 stdout JSON：

```bash
OK=$(jq -r '.ok' /tmp/fp-init-$$.json)
FILENAME=$(jq -r '.config_md_filename' /tmp/fp-init-$$.json)
CONTENT=$(jq -r '.config_md_content' /tmp/fp-init-$$.json)
```

`OK != true` → 跳到「步骤 11 失败兜底」。

### 步骤 6：用 `$CONTENT` 覆写 workdir 下的 `$FILENAME`

`$FILENAME` 由 JSON 给出（claude → CLAUDE.md，codex → AGENTS.md），
**不要自己判断 backend、不要硬编码文件名**：

```bash
printf '%s' "$CONTENT" > "./$FILENAME"
```

### 步骤 7：写 sessions 表

```bash
sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" <<SQL
UPDATE sessions
SET alias='$ALIAS_VALUE',
    category='$CATEGORY_VALUE',
    purpose='$PURPOSE_VALUE'
WHERE name='$SM_SESSION_NAME';
SQL
```

> **关于 `sessions.avatar`：不要在这里写。** 该字段契约（见 `rules/session-meta-fields.md`）规定只能存 Bitable attachment `file_token`。步骤 8 的 `bitable-init-sync.sh` 把 raw avatar（emoji/URL/文件/base64）物化成 PNG → 上传到 Bitable 头像列；下一次 `sync-session-table.sh` 跑时会把 file_token 拉回来填到 `sessions.avatar`。
> 历史 incident（2026-05-06 codex audit）：本步骤之前直接写 `avatar='$AVATAR_VALUE'`（raw 字符串），跟 Bitable 的 file_token 格式不一致，导致 `sync-session-table.sh` 推群头像失败 6 次。

（生产中请用参数化或正确转义，避免单引号注入；为简洁此处用 here-doc。）

### 步骤 8：跑飞书同步指令

遍历 JSON 里 `feishu_sync_instructions` 数组，逐条执行。`<CHAT_ID>`
占位符要替换成步骤 1 拿到的真实 chat_id：

```bash
SYNC_OK=true
# 用 process substitution（< <(...)）而不是 pipe，避免 while 在 subshell 里跑、SYNC_OK=false 丢失
while read -r ITEM; do
  SUPPORTED=$(printf '%s' "$ITEM" | jq -r '.supported')
  CMD=$(printf '%s' "$ITEM" | jq -r '.command' | sed "s|<CHAT_ID>|$CHAT_ID|g")
  case "$SUPPORTED" in
    true)
      bash -c "$CMD" || { echo "feishu-sync soft-fail: $CMD" >&2; SYNC_OK=false; }
      ;;
    false)
      ;;  # 跳过
    unknown|*)
      bash -c "$CMD" || { echo "feishu-sync soft-fail (unknown): $CMD" >&2; SYNC_OK=false; }
      ;;
  esac
done < <(jq -c '.feishu_sync_instructions[]' /tmp/fp-init-$$.json)
```

**降级原则**：lark-cli 命令不存在 / 返回非零 → 单条软失败、记一行
stderr，**不中断**整个流程。全部失败也只软失败，不让初始化整体失败。

### 步骤 9：（可选）回写 ndjson `feishu_sync_ok` 标记

ndjson 路径由步骤 5 的 fp-generate-init JSON 输出给出（`ndjson_path` 字段，
绝对路径，指向 FP workspace 而非 `$SM_RUNTIME_ROOT/data`），按 `session_name`
精确定位本次创建那一行更新 `feishu_sync_ok`：

```bash
NDJSON=$(jq -r '.ndjson_path' /tmp/fp-init-$$.json)
if [ -f "$NDJSON" ]; then
  NDJSON="$NDJSON" SESSION_NAME="$SM_SESSION_NAME" SYNC_OK="$SYNC_OK" python3 - <<'PY'
import json, os, pathlib
p = pathlib.Path(os.environ["NDJSON"])
target = os.environ["SESSION_NAME"]
ok = os.environ["SYNC_OK"] == "true"
lines = p.read_text(encoding="utf-8").splitlines()
for i in range(len(lines) - 1, -1, -1):
    if not lines[i].strip(): continue
    rec = json.loads(lines[i])
    if rec.get("session_name") == target:
        rec["feishu_sync_ok"] = ok
        lines[i] = json.dumps(rec, ensure_ascii=False)
        break
p.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
fi
```

> **设计要点**：
> - 用 Python 按 `session_name` 反向定位本次行——避免 `head -n -1`（macOS BSD 不支持）和 `tail -n 1` 取最后一行容易拿到别人新写的行。
> - SYNC_OK 通过 env 传，避免 `jq | while` 的 subshell 状态丢失（旧版 bug）。
> - 路径用 fp-generate-init 返回的 `ndjson_path`，避免错引 `$SM_RUNTIME_ROOT/data` 不存在的目录。
> - 失败也不阻塞——主要状态在步骤 7 写过 sessions 表，ndjson 只是辅助审计。

### 步骤 10：清理 + 群里宣布完成

```bash
rm -f .init-state.json
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" \
  --text "✅ 我现在是 [$CATEGORY_VALUE] 类 session 「$ALIAS_VALUE」，purpose 是「$PURPOSE_VALUE」，初始化完成。"
```

此时 `$FILENAME` 已被 FP 的正式模板覆写，本「自驱初始化运行手册」自动
失效。

### 步骤 11：失败兜底（任一关键步骤失败时）

「关键步骤」指：步骤 5（FP CLI 取模板）/ 步骤 6（覆写 CLAUDE.md/AGENTS.md）
/ 步骤 7（写 sessions 表）。步骤 8 飞书同步**整体**视为非关键（按降级
原则软失败即可，不触发兜底）。

发生关键步骤失败时：

```bash
lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" \
  --text "⚠ 我的初始化失败了：<具体错误一行摘要>。等会儿你再给我一条消息时，我会重新跑一遍初始化。"
```

并且：

- **保留** `.init-state.json`（不删），下次激活继续用
- **保留** sessions 表的 `category=''`（未初始化标记）
- **不**自己 retry、**不**进死循环——等用户**下一条消息**触发再走一遍

→ 这样新 session 不会因为初始化失败就阻塞后续的正常使用：用户随时可以
直接对话，新 session 会先「试一次初始化」再处理用户消息。

---

## 这份 stub 之外（初始化完成后才会读到）

初始化成功后，`$FILENAME` 已被 FP 生成的正式版本覆写，里面包含本 session
对应类目（业务/知识/平台/工具/外部）的完整行为准则、跨 session 协作规范、
原则文档阅读优先级等。这份 stub 里**不**重复那些内容。

如果你正在读这一行，说明初始化还没成功 —— 回到「第 0 步」继续。
