# Spawn2.0 + 通讯录 完整文档（full doc）— owner 维护

> owner：supermatrix-root｜模块：spawn2.0｜section_no：200
> 角色：本文件是该能力的**单一事实源（SSoT）**。FP 从这里蒸馏出十几行 snippet 注入消费方的 CLAUDE.md；CLAUDE.md 用一行指针指回本文件。
> Last verified: 2026-08-05（点名的路径/命令/环境变量请定期校验仍存在）
> 实现位置：`src/cli/apiServer.ts`（`/api/spawn2.0` handler + `resolveSpawn2ClosureTarget` / `withSpawn2DeliveryInstruction`）与 `src/app/childSession.ts`（child runtime config 继承）。本文件给契约与坑，机制细节读代码。

## 1. 这个能力是什么（一句话）

Spawn2.0 让一个 session 把**一次性任务**委派给「通讯录」里另一个按名字寻址的 session 执行，并用 `closure` 显式声明结果投递到哪里（回调用方 / 转某 session / 发某 topic / 进待办池）；「通讯录」就是这套**按 session 名 / topic 名寻址**的命名空间——`from`、`target`、`closure.target.session_name`、`closure.target.topic` 全部走它。

## 2. 最小用法（消费方最常用的那条路径）

向本机 SuperMatrix runtime 的 `POST http://localhost:3501/api/spawn2.0` 发 JSON。五个必填字段：`from`、`target`、`prompt`、`client_request_id`、`closure`。`client_request_id` 必须以 `YYYY-MM-DD:` 开头（幂等键）。

```bash
curl -s -X POST http://localhost:3501/api/spawn2.0 \
  -H "Content-Type: application/json" \
  -d '{
    "from": "scheduler",
    "target": "supermatrix-root",
    "prompt": "把今天的 smoke 结果汇总成一句话。",
    "client_request_id": "2026-05-31:scheduler:supermatrix-root:smoke",
    "closure": { "kind": "message", "target": { "type": "inline" } }
  }'
```

`closure.target.type` 声明**想要的交付结果**，不是调用方选的传输模式：

| target.type | 必带寻址字段 | 结果去向 | 框架初始 mode |
| --- | --- | --- | --- |
| `inline` | 无 | 同步 HTTP 响应回 caller；响应窗口关掉则自动转异步跟进 | sync_inline |
| `session` | `session_name`（通讯录名） | 注入该 session 的下一轮上下文（`parent_continuation_inject`） | sync_inline |
| `topic` | `topic`（自定义字符串） | 发布到 eventbus topic | sync_inline |
| `todo_pool` | 无 | 立即异步 kickoff，结果进待办池，返 `ref` 轮询 | async_kickoff |

调用方**不要**把交付机制写进 `prompt`——框架会按 `closure.target` 在 prompt 前自动加一行交付规则（例如 inline → 「直接在本回复给结果，勿另行回调。」，session → 「直接回复，框架会转投目标会话。」）。

需要单次指定 child 的 reasoning effort 时，传顶层 `effort` 或 `execution.effort`，取值只能是 `low`、`medium`、`high`、`xhigh`、`max`、`ultra`、`default`。具体继承、清空与锁的语义见 §5；它不会改 target session 的持久默认值。

## 3. 最容易踩的坑（高频 failure mode）

- **`session` / `topic` closure 漏带寻址字段** → 现象：`400 invalid spawn2.0 body`。原因：schema 是 `.strict()`，`target.type=session` 必须同时带 `session_name`，`type=topic` 必须带 `topic`；只写 `{ "type": "session" }` 会被判非法。正确做法：寻址字段和 type 一起给，例如 `{ "type": "session", "session_name": "first-principle" }`。
- **`from` / `target` / `session_name` 不在通讯录** → 现象：`404 session not found` / `from session not found` / `closure target session not found`。原因：三者都要能 `findSessionByName` 命中现存 session。正确做法：用准确的 session 名（不是群名、不是别名）；不确定就查 `sqlite3 $SM_DB "SELECT name,scope,status FROM sessions WHERE name LIKE '%xxx%';"`。
- **想自己选同步/异步，传 `mode`** → 现象：`400 mode is not supported`。原因：2.0 不让 caller 选传输模式，mode 由 `closure.target` 推导、并在同步窗口关不掉时自动转异步。正确做法：删掉 `mode`，用 `closure.target` 表达诉求；要立即异步就用 `todo_pool`。
- **`client_request_id` 格式不对** → 现象：`400 ... must start with YYYY-MM-DD:`。原因：它是带日期前缀的幂等键。正确做法：`<日期>:<from>:<target>:<用途>`，每个逻辑请求唯一。
- **`client_request_id` 复用（含同步窗口超时后重发）** → 现象：`409 { duplicate:true, existing:{ commId, status, childSessionId } }`（同 key 正在处理时 `existing.status="in_flight"`）。原因：2026-07-04 起服务端强制幂等——同 key 已有 `pending` / `completed` comm 或另一请求 in-flight 就拒绝，只有先前 comm `failed` 才放行重试。正确做法：收到 409 别再重发，拿 `existing.commId` / `childSessionId` 跟进先前那次；HTTP 连接超时 ≠ 未登记，同步窗口超时会自动转异步、结果不丢。
- **`backend=sent`/`no_reply` 想「发了不要回」** → 现象：`400 closure.kind=no_reply is forbidden`。原因：2.0 没有「发了不收口」的逃生门，每个 spawn 都必须有收口去向。正确做法：选一个真实的 `closure.target`。
- **顶层 `effort` 与 `execution.effort` 给了不同值** → 现象：`400 effort conflict: top-level effort=<x> but execution.effort=<y>`。原因：两种写法是兼容别名，不允许表达两个不同的本次 child 配置。正确做法：只给一种，或两处给完全相同的值；两处相同可接受。
- **给 kimi 后端的 target 传具体 `effort`（模型相关，kimi-code 0.30.0 起）** → kimi 的 thinking 能力按模型分档，校验针对**最终生效的 child tuple**（child defaults 可能把 child 重定向到与 target session 不同的 backend/model，所以看的是生效 backend+model，不是 target session 表面值）：
  - **kimi K3 模型（`k3` / `k3-256k`）接受档位**——`low` / `medium` / `high` / `xhigh` / `max` / `ultra` 均可，执行时映射到 K3 原生 `low` / `high` / `max`；**不再拒绝**（旧文档说的「kimi 一律 400」已过时）。
  - **kimi K2.7（thinking 固定 on）模型给具体 effort → `400 kimi 模型「<model>」的 thinking 固定为 on，不支持设置 effort「<level>」；K3 模型（k3 / k3-256k）才支持档位，或用 default 清除已存值`**。原因：K2.7 无档位维度，写具体值也不控制任何一轮，直接拒绝而不是静默接受。
  - `effort:"default"`（清空）对**所有** kimi 模型仍接受。

## 4. 最佳案例参考（必填 — canonical worked example）

**Case A — `session` 收口（本文件正是这条路径产出的真实案例）**

调用方 first-principle 把「产出 spawn2.0 full doc」委派给 owner supermatrix-root，结果收口回 first-principle 的 inbox，并挂 `inbox-message` 校验断言：

输入（first-principle → `/api/spawn2.0`）：

```json
{
  "from": "first-principle",
  "target": "supermatrix-root",
  "prompt": "请基于模板 .../owner-full-doc-template.md，为「Spawn2.0 + 通讯录」产出 full doc ... 完成后回复一行：FULLDOC-READY spawn2.0 <绝对路径> <commit hash> comm_fulldoc_spawn20_20260531",
  "client_request_id": "2026-05-31:first-principle:supermatrix-root:fulldoc-onboard",
  "closure": { "kind": "message", "target": { "type": "session", "session_name": "first-principle" } },
  "verification_predicate": {
    "type": "inbox-message", "session_name": "first-principle",
    "field": "final_message", "contains_all": ["FULLDOC-READY", "spawn2.0"],
    "expected_window_sec": 86400
  }
}
```

发生了什么：框架在 prompt 前自动加一行「交付规则：直接回复，框架会转投目标会话。」；spawn 一个 supermatrix-root 后端子会话执行；子会话产出本 doc、在 SuperMatrix 仓 commit、回一行 `FULLDOC-READY spawn2.0 ...`；该 finalMessage 经 `parent_continuation_inject` 投回 first-principle 下一轮，`inbox-message` predicate 校验 `final_message` 含 `["FULLDOC-READY","spawn2.0"]` 通过。

输出（同步 HTTP 响应回 caller，200）：

```json
{
  "ok": true, "mode": "sync_inline", "closure": "verified",
  "childSessionId": "sess_child_xxxxxxxx",
  "childSessionName": "supermatrix-root-...",
  "finalMessage": "FULLDOC-READY spawn2.0 /Users/LOCAL_USER/SuperMatrix/fp-modules/spawn2.0-full.md <hash> comm_fulldoc_spawn20_20260531",
  "backendSessionId": "...", "spawnCommId": "comm_xxxxxxxx_<ts>"
}
```

**Case B — `inline` 收口（同步直返，已 live smoke 通过）**

2026-05-27 cutover 直测：`from=scheduler`、`target=supermatrix-root`、`closure.target.type=inline`。框架走 sync_inline，单次 attempt 三段校验（communication / completion / delivery）全过，HTTP 200 直返：`ok:true`、child=`sess_child_7e1147cf`、`spawnCommId=comm_7e1147cf_1779880408362`、`closure:"verified"`，`finalMessage` 即子会话回复正文。证据见 `docs/superpowers/plans/2026-05-27-spawn2-cutover-smoke-report.md`。

## 5. 完整契约 / API / 报错排查（细节区）

**Endpoint**：`POST http://localhost:3501/api/spawn2.0`（本机 loopback，端口默认 3501）。

**请求字段全集**（`spawn2BodySchema`，`.strict()`，多余字段会 400）：

- `from` *(必填)*：调用方 session 名，须命中通讯录。
- `target` *(必填)*：执行方 session 名，须命中通讯录。
- `prompt` *(必填, ≥1)*：任务正文；交付机制别写这里。
- `client_request_id` *(必填)*：幂等键，正则 `^\d{4}-\d{2}-\d{2}:`。
- `closure` *(必填)*：`{ kind, target }`。第一版只接受 `kind="message"`（`no_reply` 直接 400，其它 kind 报 unsupported）；`target` 见 §2 表。
- `execution` *(可选)*：`{ backend?, model?, effort? }`。`backend ∈ {claude, codex, kimi}`；`effort ∈ {low, medium, high, xhigh, max, ultra, default}`。
- `backend` / `model` / `effort` *(可选, 顶层兼容写法)*：与对应的 `execution.*` 同时出现但值不同则 400；两处值相同可接受。`model:"default"` 表示清空用后端默认，`effort:"default"` 表示显式清空 child effort（传为 `null`）并使用后端默认。
- `origin` *(可选)*：fan-out 批次溯源，判别联合 `{kind:"scheduler",task_id,run_id,triggered_at}` / `{kind:"message_run",run_id}` / `{kind:"other",key}`；用于把同一触发扇出的多条 spawn 合并进一个 batch_key（否则逐条投递）。
- `verification_predicate` *(可选)*：交付后校验断言。type 取值见 `src/app/spawnPredicate/schema.ts`：`inbox-message` / `git-log` / `db-row` / `file-mtime` / `http-get` 等；非法则 400 `invalid verification_predicate`。

**`backend` / `model` / `effort` 解析与持久化边界**：三项按同一优先级逐字段解析：本次请求显式给出的 `execution.*` 或同值顶层兼容字段优先；字段未显式给出时读系统级唯一的 `child_session_defaults(singleton=1)`；只有 singleton 中该字段为「跟随」（`configured=false`）时，才回溯 child 所属的顶层主 session 当前 backend/model/effort tuple。嵌套 child 也始终回溯所属顶层主 session，不继承中间 child 的 tuple。`model:"default"` / `effort:"default"`，以及 singleton 已配置为 `default`，都是明确清空为 `null`、使用最终选定 backend 的默认值，不是「跟随」。系统级具体 backend 与顶层主 session backend 不同时，未由本次请求或 singleton 锁定的 model/effort 不得跨 backend 带入主 session 值，改用所选 backend 默认；本次显式 backend 与 singleton 具体 backend 不同时同样另起 tuple，不混用 singleton 的 model/effort。Bitable 的每个 active main 行仅是同一 singleton 的镜像，不是逐行或逐 target 的 child lock。`backend` / `model` / `effort` 的显式值仍是本次 child 的 request-level override；本请求不修改 target session 的持久值，也不受 target 的 `modelLocked` / `effortLocked` 限制，后两者只约束持久默认值的批量设置／默认回落。**kimi 例外（模型相关，kimi-code 0.30.0 起）**：effort 校验针对最终生效 child tuple 的 backend+model（`apiServer.ts` 仅当 `effectiveTuple.backend==="kimi" && effectiveTuple.effort` 时跑 `resolveAndValidateEffort`）。生效为 kimi K3 模型（`k3` / `k3-256k`）时**接受**具体 effort（`low`/`medium`/`high`/`xhigh`/`max`/`ultra`，执行时映射到 K3 原生 `low`/`high`/`max`）；生效为 kimi K2.7（thinking 固定 on）模型时给具体 effort 直接 `400`（见 §3 错误原文）；`default`（清空 → `null`，跳过校验）对所有 kimi 模型接受。校验发生在建 child **之前**，admission 与 child 执行不会分叉。

**返回 schema**：

- 同步成功（inline/session/topic 收口达成）：`200 { ok:true, mode:"sync_inline", closure:"verified", childSessionId, childSessionName, finalMessage, backendSessionId, spawnCommId }`。
- 待办池 kickoff：`202 { ok:true, mode:"async_kickoff", closure:"todo_pool", childSessionId, childSessionName, messageRunId, spawnCommId?, ref?, resultUrl? }`，之后按 `resultUrl` 取结果（见 §5.1 消费账本）。
- 同步转异步（响应窗口超时 / caller 断开 / 收口未达成）：`200 { ok:false, status:"switched_async", ref, spawnCommId, resultUrl, message }`，结果由 closure watcher / Heartbeat 后台跟进；调用方也可按 `resultUrl` 自行取走（先到为准，见 §5.1）。
- 并发挤占排队：`200 { ok:true, status:"queued", ref, comm_id, spawnCommId, ttlSec }`。
- 错误：`400`（schema / 冲突 / 非法 predicate）、`404`（session 不在通讯录）、`409`（`client_request_id` 重复，见 §3；body 带 `duplicate:true` + `existing`，先前 comm 有 async item 时 `existing` 附 `ref` + `resultUrl`）、`500`（communication 段失败或内部错误）。

### 5.1 结果消费账本（2026-07-20 起）

「调用方已拿到结果」进入 `spawn_async_items` 状态机，推送与自取**谁先到算谁的**：

- **`POST /api/spawn_async_items/<ref>/take`**：取结果 + 原子记账（`verdict='caller_consumed'`）。调用方跟进异步 spawn 的**唯一规范入口**——switched_async / todo_pool / 409 响应里的 `resultUrl` 就是它。有终态结果且确认送达才记账；未跑完返回当前状态不记账；重复 take 幂等（`alreadyConsumed:true`）。
- **`GET /api/spawn_async_items/<ref>` 与 `GET /api/sessions/:id/result` 保持纯读**：诊断、监控可用，永不记账，也不会抑制后续推送。
- **`GET /api/spawn_async_items/by-comm/<comm_id>`**：按 comm 只读查 async item（status/verdict/ref），供 heartbeat 注入前复检。
- 已 take 的 item 进入 `closed + verdict='caller_consumed'`，closure fast-path / watcher 不再 claim，heartbeat 注入前复检会清掉对应 todo——**不会再收到重复投递**。从不 take 则推送照常送达，行为与以前一致。
- **`resultUrl` 是路径不是完整 URL**（形如 `/api/spawn_async_items/<ref>/take`），自己拼 host：
  `curl -s -X POST "http://localhost:3501$RESULT_URL"`。返回 `200 { ok:true, ...item }`；**判「结果到手」看 `commStatus==="completed"` 且 `finalMessage` 非空**，其它 status 只是当前进度（不记账，可稍后再 take）。

**通讯录寻址说明**：session 名即 `sessions` 表 `name` 列，由 `findSessionByName` 解析。没有「列全部名字」的公开 endpoint（`/api/health` 只回计数）；查名字直接读库 `sqlite3 $SM_DB "SELECT name,scope,status FROM sessions;"`。`topic` 是自由字符串，不做存在性校验（eventbus 侧消费）。

**同步响应超时**：`SM_SPAWN_SYNC_RESPONSE_TIMEOUT_MS`（默认 240000ms）；到点子会话还没完成就转异步跟进，不会丢结果。

**排查清单**：400→比对 §3 与 schema；404→查 `sessions` 表确认名字与 `status`（deleted/error 的 target 不可用）；409→同 key 已登记，用 `existing.resultUrl`（无则按 `existing.commId` 查 `cross_session_log`）跟进先前那次，别换 key 重发同一逻辑请求；500 且 `communication` 段失败→看 runtime 日志 `mod=api` 的 `api spawn2` / `phase_check` 行；转异步后没动静→查 closure watcher（`scripts/spawn-closure-watcher.sh`）与 `spawn_async_items`。

**与 legacy `/api/spawn` 的关系**：runtime 自 2026-06-01 起在 `.env.local` 置 `SM_DISABLE_LEGACY_SPAWN=1`，HTTP `/api/spawn` 对**所有**外部调用方一律返回 `410 { error:"legacy /api/spawn is disabled; use POST /api/spawn2.0 ..." }`；框架内部 caller（root-owned watcher/dispatcher 等）走进程内 `childSession.spawnChild` 路径，不经此 HTTP 入口，与消费方无关。新接入一律走 `/api/spawn2.0`。代码 gate：`src/cli/apiServer.ts` `legacySpawnDisabled()`。背景见 `docs/superpowers/plans/2026-05-26-spawn2-api.md` 与 `2026-05-27-spawn2-cutover-smoke-report.md`。

## 6. 外部依赖

- **SuperMatrix runtime（本机）**：`http://localhost:3501` 的 HTTP API，必须在跑（launchd/localwatch 常驻）。
- **SQLite `sessions` 表**：通讯录寻址来源；路径见 `$SM_DB`（`.../SuperMatrixRuntime/data/supermatrix.db`）。
- **后端 CLI 二进制**：`claude` / `codex` / `kimi`——target 用哪个 backend 就要求对应 CLI 可达。
- **closure watcher / Heartbeat（owner=heartbeat）**：同步转异步后的后台收口跟进路径。
- **凭证**：`SM_PREDICATE_PATCH_TOKEN`（仅 `PATCH /api/spawn/:comm_id/predicate` 改断言时需要，spawn 本身不需要）。
