# SOP: 新 Session 初始化飞书元信息同步

> Created: 2026-04-28 | Last updated: 2026-04-28

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** 新 session 创建后的飞书 Bitable 元信息回填 + ndjson 状态回写流程。

**它要解决什么问题：** SuperMatrix framework 在初始化新 session 时会写 SQLite `sessions` / `bindings` 表 + 在 `data/session-init.ndjson` 追加一行（含 `alias / purpose / category / avatar`），并把 `feishu_sync_ok` 留为 `null` 等待 FP 同步。但 `scripts/sync-session-table.sh` 设计上 alias / Purpose / 分类 / 头像是**单向 pull (Bitable → Local)**，不会把本地这些字段反向 push。结果新 session 的 Bitable 行缺字段，必须 FP 主动补推。本 SOP 是 FP 在「新 session 出现 + ndjson 标记未同步」事件触发下的兜底动作。

> **2026-04-29 起：主路径已自动化。** `bin/fp-generate-init` 在 init 步骤 5 被新 session 调用时，会在返回的 `feishu_sync_instructions` 里包含一条 `bitable_metadata_sync` 指令，指向 `scripts/bitable-init-sync.sh`。新 session 在步骤 8 跑完后 Bitable 行就已经写好。本 SOP **现在只在主路径失败时被激活**：(a) `bitable-init-sync.sh` 内部失败导致步骤 8 软失败、(b) 新 session 跳过/未跑步骤 8、(c) FP 修改 base 模板期间临时退化。

## When to Use

事件触发，任一即激活：

1. 用户/框架刚创建新 session 但 init 流程异常（典型信号：`data/session-init.ndjson` 末行 `feishu_sync_ok != true`）
2. FP 激活时扫到 `data/session-init.ndjson` 有 `feishu_sync_ok != true` 的行（兜底）

## Prerequisites

- `lark-cli` 可用，权限覆盖 base / im
- 目标 session 在本地 SQLite `sessions` 表已存在（framework 自动写入；如缺失先跑 `scripts/sync-session-table.sh` 让 push 阶段自动 create Bitable 行）
- 本 session 工作目录是 `<SM_WORKSPACE_ROOT>/first-principle/`

## Steps

### Step 1. 找出待同步 session

**要解决的问题（Problem）** — 必须事件触发，不能依靠记忆。来源唯一：ndjson 状态。

**输入（Input）** — `data/session-init.ndjson`

**处理（Processing）** —

```bash
python3 -c "
import json, pathlib
for line in pathlib.Path('data/session-init.ndjson').read_text(encoding='utf-8').splitlines():
    if not line.strip(): continue
    o = json.loads(line)
    if o.get('feishu_sync_ok') is not True:
        print(o['session_name'], '|', o.get('alias',''), '|', o.get('purpose',''), '|', o.get('category',''), '|', o.get('avatar',''))
"
```

**产物（Output）** — 待处理 session 列表（含 alias / purpose / category / avatar 路径）

**下一步消费方（Next）** — Step 2 逐个处理

### Step 2. 推 alias / Purpose / 分类 到 Bitable

**Problem** — `sync-session-table.sh` 把这三个字段当作 Bitable→Local pull-only，本地有但 Bitable 空时**不会**反向 push；必须显式 `+record-upsert`。

**Input** — `session_name, alias, purpose, category`（来自 Step 1）

**Processing** —

```bash
export NAME=<session_name>   # 必须 export，下面 python -c 用 os.environ['NAME'] 读
RID=$(lark-cli base +record-list \
        --base-token <FP_SESSION_BASE_TOKEN> --table-id <FP_SESSION_TABLE_ID> \
        --limit 200 --field-id Session 2>/dev/null | \
      python3 -c "
import json, sys, os
d = json.load(sys.stdin)['data']
fields, rids, rows = d['fields'], d['record_id_list'], d['data']
si = fields.index('Session')
for i, r in enumerate(rows):
    if r[si] == os.environ['NAME']: print(rids[i]); break
" )

lark-cli base +record-upsert \
  --base-token <FP_SESSION_BASE_TOKEN> --table-id <FP_SESSION_TABLE_ID> \
  --record-id "$RID" \
  --json '{"别称":"<alias>","Purpose":"<purpose>","分类":"<category>"}'
```

如果 RID 为空：先跑 `./scripts/sync-session-table.sh`（push 阶段会自动 create 该 session 行），然后回到本步骤重做一次。

**Output** — Bitable 行的「别称 / Purpose / 分类」三列填上

**Next** — Step 3 处理头像

### Step 3. 头像（如有）

**Problem** — ndjson 的 `avatar` 字段四种形态：emoji 串（如 `emoji:🚀`，**已被 HIGH-1 契约 reject**）/ 本地文件路径 / HTTPS URL / `data:image/...;base64,...` data URI。后三种都要物化成 PNG 上传到 Bitable，群头像由 `sync-session-table.sh` 在 Step 4 自动接管。

**Input** — `session_name, avatar`

**Processing** — 直接调 `scripts/bitable-init-sync.sh`，它已经处理 4 种 avatar 形态：

```bash
bash scripts/bitable-init-sync.sh \
  --session-name "$NAME" \
  --alias "$ALIAS" --purpose "$PURPOSE" --category "$CATEGORY" \
  --avatar "$AVATAR"   # 本地路径 / HTTPS URL / base64 data URI；emoji 会被 reject
```

- 本地路径 → 直接上传
- HTTPS URL → 脚本 curl 下载到临时 PNG → 上传
- base64 data URI → 脚本 decode 到临时 PNG → 上传
- emoji 形式 → 脚本 exit 1（**Bitable + Feishu 群头像都不接受 emoji**）；上游应在 init 时拒绝
- Bitable 头像列已经有同名 attachment → 幂等跳过

> 历史方案（已废）：之前文档建议用 `lark-cli im images create --image_type=avatar` —— 该子命令的 `--image_type` flag 不存在；且 IM `image_key` 跟 Bitable attachment `file_token` 不同源，写错列就坏。统一走 `bitable-init-sync.sh` 里的 `+record-upload-attachment` 路径。

**Output** — Bitable 头像列就绪

**Next** — Step 4

### Step 4. 跑通用同步脚本对齐骨架字段

**Problem** — 通用字段（Backend / Status / Workdir / Group ID / Created / Updated / 群名 / 群头像）由 `sync-session-table.sh` 维护；Step 2-3 完成后跑一次让整张表自洽。

**Input** — 当前本地 SQLite 状态 + Step 2-3 后的 Bitable 状态

**Processing** —

```bash
./scripts/sync-session-table.sh
```

如果脚本在旧头像附件下载处失败，先确认是否是 bot 身份下载 Bitable attachment 失败；当前脚本会自动 fallback 到 `--as user` 做只读下载，避免一个旧头像阻断后续 session 行 upsert。这里的 `--as user` 只用于附件下载，不发送 Feishu 消息。

**Output** — Bitable 行所有字段齐全；群名按 `{alias}-{name}-{backend}` 改好；群头像若 Bitable 有 token 则推到群

**Next** — Step 5 回写状态

### Step 5. 回写 ndjson + 记 changelog

**Problem** — `feishu_sync_ok=null` 是 Step 1 的扫描触发条件；处理完必须翻成 `true`，否则下次激活会重复扫到、重复同步（虽幂等但浪费）。

**Input** — `data/session-init.ndjson`

**Processing** —

```bash
NAME=<session_name>
python3 -c "
import json, pathlib, os
p = pathlib.Path('data/session-init.ndjson')
lines = p.read_text(encoding='utf-8').splitlines()
for i, line in enumerate(lines):
    if not line.strip(): continue
    o = json.loads(line)
    if o.get('session_name') == os.environ['NAME']:
        o['feishu_sync_ok'] = True
        lines[i] = json.dumps(o, ensure_ascii=False)
p.write_text('\n'.join(lines) + '\n', encoding='utf-8')
"

git add data/session-init.ndjson
git commit -m "chore(data): mark $NAME feishu_sync_ok=true after init sync"
```

记 changelog（按 `CLAUDE.md` → Changelog Recording Rules）：

```bash
sqlite3 data/principles-log.db "INSERT INTO changelog (trigger_type, trigger_source, target_doc, judgment, judgment_reason, change_summary, change_detail, request_file) VALUES ('event', '<session_name>', 'fp-self', 'accepted', '新 session 初始化兜底同步', '把 <name> 的 alias/Purpose/分类/头像 推到 Bitable 并回写 ndjson', '<具体动作清单>', NULL);"
```

并镜像到 Feishu Bitable changelog 表（参考 CLAUDE.md → Feishu sync 段）。

**Output** — ndjson `feishu_sync_ok=true`；changelog 留痕（SQLite + Bitable 双写）

**Next** — 流程结束

## Verification

任务收尾前必须验证：

1. `lark-cli base +record-list ... --field-id 别称 --field-id Purpose --field-id 分类` 读回目标 session 行，三字段非空
2. `data/session-init.ndjson` 该 session 行 `feishu_sync_ok = true`
3. 飞书群名（`lark-cli api GET /open-apis/im/v1/chats/<gid>`）符合 `{alias}-{name}-{backend}` 模式

## Rollback

n/a — 所有步骤幂等，重跑安全。如果 Step 2 把字段写错，重跑 Step 2 用正确值覆盖即可。

## Status (2026-04-29)

主路径已落地：`bin/fp-generate-init` 在 init 步骤 5 输出 `bitable_metadata_sync` 指令 → 新 session 在步骤 8 跑 `scripts/bitable-init-sync.sh` 自动写 Bitable。本 SOP 现在的角色是**兜底**：当主路径失败/被跳过时，FP 通过 ndjson 扫描激活手动流程。如果之后改造 `sync-session-table.sh` 让它直接支持反向 push、或框架原生集成 Bitable 推送，再考虑退役本 SOP。
