---
name: session-purpose-update
description: 当某个 session 的职责边界发生迁移（能力转入/转出、服务归属变更）需要更新其在 session-catalog.json 里的 capability 描述时使用；不覆盖 alias/头像/分类等其它 session-meta 字段的修改，也不覆盖业务 session 自行改 CLAUDE.md 职责段。
---

# SOP: Session 职责边界 / purpose 更新

> Created: 2026-05-18 | Last updated: 2026-05-19

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** session-meta 治理 / 全局 catalog 同步。

**它要解决什么问题：** 当某个 session 的职责发生迁移（一项能力/服务从 A 转到 B），它在 Bitable session 表 `Purpose` 字段、本地 SQLite `sessions.purpose`、以及全局 `session-catalog.json` 的 `capability` 字段里的描述会与实际归属脱节。不更新会导致跨 session 路由错派（按旧 catalog 转给已不负责的 session）。做完后三处一致，`session-catalog.json` 即路由真源。

## When to Use

- 用户确认某项源码/服务/scheduler 归属在两个 session 间迁移，要求更新职责边界。
- 巡检发现某 session 的 purpose 与其实际 CLAUDE.md/代码归属不符。
- 新增/裁撤一个 session 的某条能力，需要让全局 catalog 反映。

**不适用场景（Do NOT use when）—— 必填**：

- 只改 alias / 头像 / 分类 / Heartbeat → 走 `sync-session-table.sh` 常规同步，字段契约见 `rules/session-meta-fields.md`，不需要重生成 catalog。
- 新 session 首次创建的 meta 推送 → 走 `new-session-init-sync.md`。
- 业务 session 只想改自己 CLAUDE.md/AGENTS.md 职责边界段 → 那是 session 自治范围，FP 只做软分发提示。

## Prerequisites

- 职责迁移已被用户明确确认（这是边界变更，FP 不自行裁决归属）。
- 已知两个 session 的 Bitable `record_id`（`lark-cli base +record-search` 查）。
- FP workspace 可执行 `scripts/sync-session-table.sh`；`<SM_REPO_ROOT>` 下可跑 `scripts/regenerate-catalog.ts`。

## Steps

### Step 1: 起草新 purpose 文本

- **要解决的问题**：purpose 文本进 `session-catalog.json` 的 `capability` 字段，对所有 session 可见且驱动路由，措辞必须准确反映迁移后的归属。
- **输入**：两个 session 当前 purpose（`sqlite3 data/supermatrix.db "SELECT purpose FROM sessions WHERE name=..."`）、用户确认的迁移范围。
- **处理**：按压缩版格式（一句话定位 + 【做什么】+ 【不做什么】）。转入方加「做什么」条目并按需调整一句话定位；转出方删对应「做什么」条目，并在「不做什么」补一条 `→ 转 <转入方>` 的移交指引。保持 做什么 ≈3 条。
- **产物**：两段完整 purpose 终稿。
- **下一步消费方**：Step 2 写入 Bitable。

### Step 2: 写入 Bitable Purpose 单元格（权威源）

- **要解决的问题**：`Purpose` 是 pull-only 字段，本地 DB 是缓存；必须改 Bitable 才是改了真源。
- **输入**：两段终稿 + 两个 record_id。
- **处理**：`lark-cli base +record-batch-update --base-token <FP_SESSION_BASE_TOKEN> --table-id <FP_SESSION_TABLE_ID> --json '{"records":[{"record_id":"...","fields":{"Purpose":"..."}}]}'`。
- **产物**：Bitable 两行 `Purpose` 更新。
- **下一步消费方**：Step 3 拉回本地。

### Step 3: sync-session-table.sh 拉回 SQLite

- **要解决的问题**：把 Bitable 权威值同步进本地 `sessions.purpose`——catalog 重生成读的是本地 DB。
- **输入**：已更新的 Bitable。
- **处理**：FP workspace 跑 `./scripts/sync-session-table.sh`，确认日志 `[2/5] Pulling Purpose ...` 无 anomaly。
- **产物**：`sessions.purpose` 两行更新。
- **下一步消费方**：Step 4 重生成 catalog。

### Step 4: 重生成 session-catalog.json

- **要解决的问题**：`session-catalog.json` 的 `capability` 字段来源于 `sessions.purpose`，但 catalog 只在 session create/delete/setBackend 时自动重生成——纯 purpose 改动不会触发，必须显式重生成。
- **输入**：已更新的 `sessions.purpose`。
- **处理**：`cd <SM_REPO_ROOT> && SM_DB_PATH=<SM_RUNTIME_ROOT>/data/supermatrix.db SM_WORKSPACE_ROOT=<SM_WORKSPACE_ROOT> npx tsx scripts/regenerate-catalog.ts "purpose update: <转出方>→<转入方> <能力>"`。该脚本只刷新全局 `session-catalog.json` 一份文件（symlink 已由迁移建好，无需重建）。
- **产物**：`workspaces/session-catalog.json` 的 `generated_at` 和两个 session 的 `capability` 已更新；全部 workspace 通过 symlink 实时可见。
- **下一步消费方**：Step 5 记账 + 通知。

### Step 5: changelog + 软分发通知

- **要解决的问题**：留治理审计痕迹；提示两个 session 检查自己 CLAUDE.md/AGENTS.md 的 `## 职责边界` 段是否需同步（catalog 的 capability 是压缩版，CLAUDE.md 是完整版，两边都要跟随迁移）。
- **输入**：本次变更概要。
- **处理**：写 `data/principles-log.db` changelog（`trigger_type` 视来源，`target_doc` 留两个 session 名或 NULL）+ Bitable 镜像；`/api/spawn` 通知转入/转出两个 session 自查并更新自己的职责边界段（软分发，不强改）。
- **产物**：changelog 行 + 两条 spawn 通知。
- **下一步消费方**：审计 / 两个 session 自治更新。

## Common Pitfalls

- 只改了 Bitable 没跑 sync，或跑了 sync 没重生成 catalog → `session-catalog.json` 不更新，路由仍按旧值。三步缺一不可。
- 直接改本地 `sessions.purpose` → 下次 `sync-session-table.sh` 会被 Bitable 值覆盖。必须改 Bitable。
- 忘了在转出方「不做什么」补 `→ 转 <转入方>`，导致迁移后没有路由指引。
- 只更新了 catalog 的压缩版 capability，忘了通知 session 同步自己 CLAUDE.md 的完整版职责边界段——两边会脱节。
- catalog 是 SM core 生成物，不要手改 `session-catalog.json`；改 purpose 必须走 Bitable→sync→regenerate。

## Verification

- `sqlite3 data/supermatrix.db "SELECT purpose FROM sessions WHERE name IN (...)"` 显示新文本。
- `jq '.sessions[] | select(.name=="<转入方>" or .name=="<转出方>") | {name, capability}' workspaces/session-catalog.json` 显示新 capability，`.generated_at` 为本次时间。
- `data/principles-log.db` 有对应 changelog 行。
