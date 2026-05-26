# Scheduler 定时任务使用指南

Scheduler 是一个独立的定时任务调度服务，运行在 `http://localhost:3500`。

支持两种执行方式：**Shell**（跑命令）和 **HTTP**（调接口）。任务按 Cron 表达式定时触发，也可以手动触发。所有执行记录持久化到 SQLite。

---

## 快速开始

### 创建一个 Shell 任务

每天早上 9 点执行一段脚本：

```bash
curl -s -X POST http://localhost:3500/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "daily-report",
    "cron": "0 9 * * *",
    "executor": "shell",
    "config": {
      "command": "python3 /path/to/report.py",
      "cwd": "/path/to/project",
      "timeout": 60000
    },
    "notifyOnFailure": true
  }'
```

### 创建一个 HTTP 任务

每小时调一次外部 API：

```bash
curl -s -X POST http://localhost:3500/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "hourly-sync",
    "cron": "0 * * * *",
    "executor": "http",
    "config": {
      "url": "https://api.example.com/sync",
      "method": "POST",
      "headers": {"Authorization": "Bearer xxx"},
      "body": {"source": "scheduler"},
      "timeout": 30000
    },
    "notifyOnFailure": true
  }'
```

### 触发跨 Session 任务

通过 HTTP executor 调 SuperMatrix API 委派任务给其他 session：

```bash
curl -s -X POST http://localhost:3500/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "weekly-code-review",
    "cron": "0 10 * * 1",
    "executor": "http",
    "config": {
      "url": "http://localhost:3501/api/spawn",
      "method": "POST",
      "headers": {"Content-Type": "application/json"},
      "body": {"target": "reviewer", "prompt": "请检查本周的代码变更"},
      "timeout": 120000
    }
  }'
```

### 创建审核（≥2026-05-13）

POST /tasks 通过 zod 结构校验后会再跑 `checkHardConstraints` + `lintTaskInput`，命中任一返回:

```
HTTP 400
{
  "error": "task input failed lint",
  "errors": [{ "code": "...", "field": "...", "message": "...", "hint": "..." }]
}
```

错误码对照见 `sop/creation-lint-errors.md`。

PATCH /tasks/:id 也会 lint **合并后** 的有效字段（仅当 merged.class 存在；legacy 跳过）。

### 异步语义审核（L2，≥2026-05-13）

POST/PATCH /tasks 通过 L1 后**立即生效**（不阻塞 caller），同时写一条 `creation_review` 记录排队。`scheduler` 服务定期（默认 30 min 一次）批量把待审条目通过 fire_and_forget spawn 发给 scheduler session 做语义判定。

scheduler session 决议有 4 种：

| decision | 行为 | 任务变化 |
|---|---|---|
| `approved` | 通过 | 不变 |
| `patched` | 改一些字段 | 调 PATCH /tasks/:id，patched 后再过一次 L1 |
| `rejected` | 拒绝 | 默认 disable 任务；写 decision_reason |
| `escalated` | LLM 拿不准 | 不动任务，标 status；后续 ownerDM 升级到真人 |

#### 相关端点

```
GET  /proposals/creation?status=<pending|dispatched|approved|patched|rejected|escalated|expired>
POST /proposals/creation/:id/approve   body: { reason: string }
POST /proposals/creation/:id/patch     body: { reason: string; patch: object }
POST /proposals/creation/:id/reject    body: { reason: string; disable?: boolean (default true) }
POST /proposals/creation/:id/escalate  body: { reason: string }
```

24h 未决议的 dispatched review 会被 `runDecisionPollTick` 标 `expired`（默认 1h 跑一次轮询）。

#### 审核规则

scheduler session 按 `sop/creation-review-decisions.md` 走 8 条语义检查 + 决议规则。本 SOP 涵盖 description 意图、delegation prompt token、idempotency vs 副作用、duration/cron 合理性、category↔class、business-in-shell、owner 真实性。

#### 旧 task 不受影响

L2 只对入站 POST/PATCH 的 classed task 写 review 记录。Legacy 95 task 不进入 review 队列。

---

## Cron 表达式

标准 5 字段格式：`分 时 日 月 周`

| 表达式 | 含义 |
|--------|------|
| `* * * * *` | 每分钟 |
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时整点 |
| `0 9 * * *` | 每天早上 9 点 |
| `0 9 * * 1-5` | 工作日早上 9 点 |
| `0 9,18 * * *` | 每天 9 点和 18 点 |
| `0 3 * * *` | 每天凌晨 3 点 |
| `0 0 * * 0` | 每周日凌晨 |
| `0 0 1 * *` | 每月 1 号凌晨 |

---

## 任务管理

### 查看所有任务

```bash
curl -s http://localhost:3500/tasks
```

### 查看单个任务

```bash
curl -s http://localhost:3500/tasks/{id}
```

### 修改任务

支持部分更新，只传需要改的字段：

```bash
# 改 cron 表达式
curl -s -X PATCH http://localhost:3500/tasks/{id} \
  -H 'Content-Type: application/json' \
  -d '{"cron": "0 10 * * *"}'

# 暂停任务
curl -s -X PATCH http://localhost:3500/tasks/{id} \
  -H 'Content-Type: application/json' \
  -d '{"enabled": false}'

# 恢复任务
curl -s -X PATCH http://localhost:3500/tasks/{id} \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

### 删除任务

```bash
curl -s -X DELETE http://localhost:3500/tasks/{id}
# 返回 204，关联的执行记录会一起删除
```

### 手动触发一次

不等 Cron 到时间，立即执行：

```bash
curl -s -X POST http://localhost:3500/tasks/{id}/run
# 返回 202，异步执行
```

---

## 执行记录

### 查看某个任务的执行历史

```bash
curl -s 'http://localhost:3500/tasks/{id}/runs?limit=10'
```

### 查看全局最近执行记录

```bash
curl -s 'http://localhost:3500/runs/recent?limit=20'
```

返回示例：

```json
{
  "id": "run-uuid",
  "taskId": "task-uuid",
  "startedAt": 1775964000002,
  "finishedAt": 1775964000007,
  "status": "success",
  "output": "命令输出内容",
  "error": null
}
```

`status` 有三种值：`running`、`success`、`failed`。

---

## 失败通知

设置 `"notifyOnFailure": true` 的任务，执行失败时会通过飞书发送通知。

需要服务启动时配置环境变量：

```bash
SCHEDULER_NOTIFY_GROUP_ID=oc_xxxxx  # 飞书群 chat_id
```

通知格式：

```
[Scheduler] 任务失败
任务: daily-report
时间: 2026-04-12T09:00:01.234Z
错误: Command failed: exit code 1
```

---

## 健康检查

```bash
curl -s http://localhost:3500/health
# {"status":"ok","tasks":4,"uptime":3600.123}
```

---

## Executor 配置参考

### Shell

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | Shell 命令，通过 `/bin/sh -c` 执行 |
| `cwd` | string | 是 | 工作目录 |
| `timeout` | number | 是 | 超时毫秒数 |

### HTTP

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | 是 | 请求 URL |
| `method` | string | 是 | HTTP 方法（GET/POST/PUT/DELETE） |
| `headers` | object | 否 | 请求头 |
| `body` | any | 否 | 请求体（自动 JSON 序列化） |
| `timeout` | number | 是 | 超时毫秒数 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SCHEDULER_PORT` | 3500 | 服务端口 |
| `SCHEDULER_DB_PATH` | （必填） | SQLite 数据库路径 |
| `SCHEDULER_NOTIFY_GROUP_ID` | （空） | 飞书通知群 ID |
| `SCHEDULER_LARK_CLI_PATH` | `lark-cli` | lark-cli 路径 |
| `SCHEDULER_LOG_LEVEL` | `info` | 日志级别 |

---

## 在 Claude Code 中使用

直接使用 `/schedule` 命令，用自然语言描述即可：

- "帮我每天 9 点跑一下 report.py"
- "查看当前有哪些定时任务"
- "暂停 daily-report 任务"
- "手动触发一下 hourly-sync"

Skill 会自动转换为 API 调用。

---

## Bitable Column Setup (after Plan 4)

Before enabling Bitable sync against a table that pre-dates the classed lifecycle, run:

```bash
SCHEDULER_BITABLE_BASE_TOKEN=<token> SCHEDULER_BITABLE_TABLE_ID=<id> \
  npm run bitable:ensure-fields
```

This creates any of the seven classed-lifecycle columns that don't already exist:
任务分类 / 预期时长(分钟) / Owner session / 并发策略 / 覆盖配置 / 迁移阶段 / 最近运行状态 / 最近触发时间.

The script is idempotent — re-running only creates what's missing.
