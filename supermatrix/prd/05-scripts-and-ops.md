# SuperMatrix Scripts & Ops 深度 PRD

> 本文档深度解析 SuperMatrix 的脚本层、运维层与数据库迁移层。
> 版本: v1.0-draft
> 日期: 2026-05-20
> 源码锚定: 基于 SuperMatrix 主仓库 commit 范围 ce32f76 及之前

---

## 1. 数据库迁移

### 1.1 迁移文件总览

SuperMatrix 使用基于文件名的顺序迁移系统，所有迁移文件位于 `src/adapters/store-sqlite/migrations/` [源码锚点] `src/adapters/store-sqlite/migrations.ts:7`。顶层 `migrations/` 目录与源码目录内容完全一致（通过目录列表比对确认），属于历史冗余或为了某些外部工具兼容而保留的镜像。

| 版本 | 文件 | 变更摘要 | 类型 |
|------|------|----------|------|
| 001 | `001_initial.sql` | 创建 schema_version、sessions、bindings、attachments、constitution_history、message_runs 六张核心表及索引 | critical |
| 002 | `002_child_sessions.sql` | sessions 表增加 parent_id、depth 列及索引 | critical |
| 003 | `003_session_model.sql` | sessions 表增加 model 列 | critical |
| 004 | `004_session_thinking.sql` | sessions 表增加 thinking 列（默认 0） | critical |
| 005 | `005_session_timeout.sql` | sessions 表增加 inactivity_timeout_s、max_runtime_s 列 | critical |
| 006 | `006_session_effort.sql` | sessions 表增加 effort 列 | critical |
| 007 | `007_cross_session_log.sql` | 创建 cross_session_log 表及 from/to 索引 | critical |
| 008 | `008_cross_session_log_sync_tracking.opt.sql` | cross_session_log 增加 bitable_record_id、synced_at 列 | optional |
| 009 | `009_session_alias_avatar.sql` | sessions 表增加 alias、avatar 列及索引 | critical |
| 010 | `010_cross_session_log_full_message.opt.sql` | cross_session_log 增加 final_message、message_run_id 列 | optional |
| 011 | `011_token_usage.sql` | 创建 token_usage 表及索引 | critical |
| 012 | `012_session_chat_name.sql` | sessions 表增加 chat_name 列 | critical |
| 013 | `013_child_capabilities.sql` | sessions 表增加 child_type、trigger_kind、post_identity 等 6 列及索引；回填历史 child 行的 child_type | critical |
| 014 | `014_usage_views.sql` | 创建 usage_by_parent（递归 CTE）和 usage_by_requester 两个统计视图 | critical |
| 015 | `015_cross_session_log_child_model.sql` | cross_session_log 增加 child_model 列 | critical |
| 016 | `016_message_runs_stream_log.opt.sql` | message_runs 增加 stream_log 列 | optional |
| 017 | `017_session_category.sql` | sessions 表增加 category 列及索引 | critical |
| 018 | `018_sessions_timestamp_guard.sql` | 修复历史 timestamp 漂移；创建 INSERT/UPDATE 触发器强制 integer 类型 | critical |
| 019 | `019_session_heartbeat.sql` | sessions 表增加 heartbeat_enabled 列及复合索引 | critical |
| 020 | `020_heartbeat_default_on.sql` | 回填非 child、非 deleted、非 heartbeat 会话的 heartbeat_enabled = 1 | critical |
| 021 | `021_message_runs_sender_id.opt.sql` | message_runs 增加 sender_id 列 | optional |
| 022 | `022_session_model_locked.opt.sql` | sessions 表增加 model_locked 列（默认 0） | optional |
| 023 | `023_spawn_predicates.opt.sql` | 创建 spawn_predicates、spawn_predicate_patches 表及索引 | optional |
| 024 | `024_watcher_state.opt.sql` | 创建 watcher_state、watcher_ticks 表及索引 | optional |
| 025 | `025_result_sink_attempts.opt.sql` | 创建 result_sink_attempts 表及索引 | optional |
| 026 | `026_watcher_exceptions.opt.sql` | 创建 watcher_exceptions 表及索引 | optional |
| 027 | `027_session_fp_managed.opt.sql` | sessions 表增加 fp_managed 列（nullable） | optional |
| 028 | `028_spawn_async_items.opt.sql` | 创建 spawn_async_items 表及索引 | optional |
| 029 | `029_spawn_async_item_courier_statuses.opt.sql` | 为 spawn_async_items 创建 courier 部分索引（status IN waiting_child, delivering） | optional |

**类型判定规则**: 文件名以 `.opt.sql` 结尾为 optional，其余为 critical [源码锚点] `src/adapters/store-sqlite/migrations.ts:36-37`。optional 迁移失败不会终止启动流程，仅被记录为 degraded；critical 迁移失败会抛出异常并终止 boot。

### 1.2 关键设计决策

- **递归 CTE 深度上限**: `014_usage_views.sql` 中 `usage_by_parent` 视图的递归深度上限为 16，对应 child-depth 护栏值 3 并留有充裕余量，同时防止手动破坏 parent_id 导致的循环 [源码锚点] `src/adapters/store-sqlite/migrations/014_usage_views.sql:27-30`。
- **历史数据回填**: `013_child_capabilities.sql` 对已有 child 行进行启发式回填：status=idle 的设为 `ephemeral_conversation`，其余设为 `one_shot_delegation` [源码锚点] `src/adapters/store-sqlite/migrations/013_child_capabilities.sql:20-26`。
- **timestamp 触发器**: `018_sessions_timestamp_guard.sql` 在 INSERT/UPDATE 时通过 `RAISE(ABORT)` 强制拒绝非 integer 的 timestamp，修复了早期动态类型漂移 [源码锚点] `src/adapters/store-sqlite/migrations/018_sessions_timestamp_guard.sql:13-33`。

---

## 2. 迁移系统

### 2.1 Runner 逻辑

`applyMigrations` 是迁移系统的入口函数，执行流程如下 [源码锚点] `src/adapters/store-sqlite/migrations.ts:23-57`：

1. **确保版本表存在**: `ensureVersionTable` 创建 `schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)` [源码锚点] `src/adapters/store-sqlite/migrations.ts:85-89`。
2. **读取已应用版本**: 从 `schema_version` 表中读取所有已记录的 version 号，构建 `Set<number>` [源码锚点] `src/adapters/store-sqlite/migrations.ts:25-30`。
3. **扫描迁移文件**: 读取 `migrations/` 目录下所有 `.sql` 文件，按文件名排序。
4. **双 Pass 执行**:
   - **Pass 1 (critical)**: 所有非 `.opt.sql` 文件依次执行，`runOne` 内部抛出即终止整个 boot。
   - **Pass 2 (optional)**: 所有 `.opt.sql` 文件依次执行，失败被捕获并压入 `degraded` 数组，boot 继续。

### 2.2 单条迁移执行 (runOne)

`runOne` 的语义 [源码锚点] `src/adapters/store-sqlite/migrations.ts:59-83`：

1. **解析版本号**: 通过正则 `/^(\d+)_/u` 从文件名提取前导数字 [源码锚点] `src/adapters/store-sqlite/migrations.ts:91-95`。
2. **幂等跳过**: 若版本号已存在于 `appliedVersions`，直接返回。
3. **事务包装**: 使用 `db.transaction(() => { db.exec(sql); 写入 schema_version })` 保证原子性 [源码锚点] `src/adapters/store-sqlite/migrations.ts:66-72`。
4. **已应用回退**: 若执行抛出且 `isAlreadyApplied(err)` 为 true，说明目标 schema 状态已存在（仅缺少版本记录），则通过 `INSERT OR IGNORE` 回填版本记录，不抛异常 [源码锚点] `src/adapters/store-sqlite/migrations.ts:74-80`。

### 2.3 isAlreadyApplied 匹配规则

当前匹配两条 SQLite 错误模式 [源码锚点] `src/adapters/store-sqlite/migrations.ts:13-21`：

- `/duplicate column name:/i` — 对应 ALTER TABLE ADD COLUMN 时列已存在。
- `/table .+ already exists/i` — 对应 CREATE TABLE IF NOT EXISTS 但表已通过其他途径存在。

若错误消息匹配任一模式，视为 schema 已到达目标状态，仅缺失版本记录。

### 2.4 事务策略

每条迁移在一个独立的 `better-sqlite3` transaction 中执行，包含两部分：
- 执行迁移 SQL (`db.exec(sql)`)
- 写入版本记录 (`INSERT INTO schema_version`)

这意味着单条迁移内部是原子的，但跨迁移之间不存在全局事务。如果 boot 在 Pass 1 中途崩溃，已执行的迁移会有版本记录，下次 boot 会正确跳过；但如果崩溃发生在 `db.exec(sql)` 成功而 `INSERT schema_version` 尚未写入的瞬间，`isAlreadyApplied` 机制会在下次重试时捕获重复错误并回填版本记录。

### 2.5 降级处理

optional 迁移的降级语义 [源码锚点] `src/adapters/store-sqlite/migrations.ts:46-54`：

- 失败时收集 `{ version, file, error: msg }` 到 `degraded` 数组。
- 返回值 `{ degraded }` 被调用方（`SqliteBindingStore.init()`）消费，通常会打印 warn 日志但不会终止进程。
- 后果：缺失 optional 表/列的代码路径必须能优雅降级。例如 `rowToSession` 读取 `fp_managed` 时将其视为 nullable，`watcher-tick.sh` 通过 `tableColumns` 运行时探测列存在性 [源码锚点] `scripts/watcher-tick.sh:215-229`、`scripts/watcher-tick.sh:314-321`。

---

## 3. 初始化脚本

### 3.1 setup-dogfood-session.sh 完整流程

`scripts/setup-dogfood-session.sh` 是 dogfood session 的一次性初始化脚本，使用 `zsh` 解释器 [源码锚点] `scripts/setup-dogfood-session.sh:1`。

**安全设置**: `set -euo pipefail`（严格模式：遇错退出、未定义变量报错、管道失败传播）[源码锚点] `scripts/setup-dogfood-session.sh:16`。

**执行步骤**:

1. **环境校验**: 检查 `.env.local` 存在 [源码锚点] `scripts/setup-dogfood-session.sh:22-25`；检查 `lark-cli` 可执行 [源码锚点] `scripts/setup-dogfood-session.sh:35-38`；检查 SQLite 数据库已初始化 [源码锚点] `scripts/setup-dogfood-session.sh:40-43`。
2. **幂等性检查**: 查询 `sessions` 表中是否存在同名且非 deleted 的 session，存在则失败退出 [源码锚点] `scripts/setup-dogfood-session.sh:45-49`。
3. **创建飞书群**: 通过 `lark-cli im +chat-create --as user` 创建私有群，设置 `LARK_CLI_NO_PROXY=1` 避免代理干扰 [源码锚点] `scripts/setup-dogfood-session.sh:52`；用 `python3` 解析 JSON 响应提取 `chat_id` [源码锚点] `scripts/setup-dogfood-session.sh:53`。
4. **生成 Session ID**: `sess_` + 8 位 hex（`secrets.token_hex(4)`）[源码锚点] `scripts/setup-dogfood-session.sh:62`。
5. **插入数据库**: 直接通过 `sqlite3` CLI 执行两条 INSERT：
   - `sessions` 行：scope='user', backend='claude', workdir=REPO_DIR, status='idle' [源码锚点] `scripts/setup-dogfood-session.sh:66-71`。
   - `bindings` 行：group_id=chat_id, session_id=session_id [源码锚点] `scripts/setup-dogfood-session.sh:72-74`。
6. **生成 CONSTITUTION.md**: 在仓库根目录写入 `CONSTITUTION.md`（gitignored），包含 session 元数据、操作约束（`npm run verify`、禁止 push、禁止修改 domain/ports/check-deps.ts 等）、以及起始文档索引 [源码锚点] `scripts/setup-dogfood-session.sh:77-109`。

### 3.2 CONSTITUTION.md 生成逻辑

CONSTITUTION.md 是 dogfood session 的"宪法"文件，由脚本内联 heredoc 生成，包含以下不可变条款 [源码锚点] `scripts/setup-dogfood-session.sh:77-109`：

- 必须运行 `npm run verify` 后再 commit。
- 小而聚焦的 commit，每个 commit 保持树绿色。
- 未经显式人类批准禁止 `git push`。
- 禁止在无显式指令时修改 `src/domain/`、`src/ports/` 或 `scripts/check-deps.ts`。
- 禁止修改此 CONSTITUTION.md 本身。
- 禁止直接操作 `.git/`，应使用常规 git 命令。
- 编辑 `src/adapters/lark-cli/` 前需考虑测试 + 手动 smoke，因为 broken adapter 意味着 chat 失联。

> **注意**: `AGENTS.md` 规定 "`CONSTITUTION.md` at the repository root is generated and refreshed only by `scripts/setup-dogfood-session.sh`; manual edits are not the long-term source of truth" [源码锚点] `AGENTS.md:Framework Invariants`。违反后果：dogfood identity drifts。

---

## 4. 运维脚本清单

### 4.1 脚本分类总表

| 脚本 | 功能 | 安全设置 | 调用方式 |
|------|------|----------|----------|
| `check-deps.ts` | 六边形架构依赖方向检查 | N/A (tsx) | `npm run lint:deps` |
| `setup-dogfood-session.sh` | Dogfood session 初始化 | `set -euo pipefail` | 手动执行 |
| `dev-loop.sh` | 开发监督循环（重启 on crash/reload） | `set -u` | `npm start` 或 launchd 调用 |
| `localwatch.sh` | 进程管理 & 健康监控（替代 dev-loop） | `set -u` | 手动执行或 terminal-launcher 调用 |
| `safe-reload.sh` | 空闲时触发 `/reload`，带 dedup | `set -eu` | Scheduler shell executor |
| `sync-bitable.sh` | cross_session_log ↔ Feishu Bitable 增量同步 | `set -euo pipefail` | Scheduler shell executor |
| `spawn-closure-watcher.sh` | 扫描 spawn_async_items 并路由 | `set -uo pipefail` | Scheduler shell executor |
| `watcher-tick.sh` | 评估 spawn_predicates 并路由异常事务 | `set -uo pipefail` | Scheduler shell executor |
| `weekly-review-watchdog.sh` | 调度 R1/R2 周评审 + V1 核验 | `set -euo pipefail` | Scheduler shell executor |
| `regenerate-catalog.ts` | 重建全局 session-catalog.json | N/A (tsx) | 手动执行 |
| `migrate-to-session-catalog.ts` | 退役 CONSTITUTION.md，迁移到 catalog | N/A (tsx) | 一次性迁移 |
| `flag-nonconforming-avatars.ts` | 列出违反 FP 格式的 avatar 行 | N/A (tsx) | 手动执行 |
| `package-dist.sh` | 构建脱敏分发包 | `set -euo pipefail` | 手动执行 |
| `spike-claude-stream.sh` | 录制 Claude stream JSON 样本 | `set -euo pipefail` | 手动执行 |
| `repair/fix-migration-drift.sh` | 自动修复 schema_version 漂移 | `set -u` | localwatch auto-repair |
| `repair/fix-port-in-use.sh` | 杀死占用 3501 端口的进程 | `set -u` | localwatch auto-repair |
| `repair/fix-stale-pid.sh` | 删除过期的 .bootstrap.pid | `set -u` | localwatch auto-repair |
| `repair/restart-scheduler.sh` | 重启 Scheduler 进程并确认端口绑定 | `set -u` | 手动或 auto-repair |

### 4.2 已知问题与注意事项

- **`dev-loop.sh` 与 `localwatch.sh` 的竞争**: 两者都可以管理 SuperMatrix 进程。`localwatch.sh` 的 `takeover()` 会杀死其他 `localwatch.sh`、`dev-loop.sh` 和 `tsx.*src/cli/main.ts` 进程 [源码锚点] `scripts/localwatch.sh:200-246`；`dev-loop.sh` 的 takeover 也会杀死同类进程 [源码锚点] `scripts/dev-loop.sh:34-82`。如果同时运行两个 supervisor，会发生 takeover 竞争。
- **`localwatch.sh` 的 `set -u` 而非 `set -e`**: 某些函数内部通过 `set +e` 临时关闭错误退出以处理外部命令失败，因此整体不启用 `set -e` [源码锚点] `scripts/localwatch.sh:2`。
- **`watcher-tick.sh` 的 hardcoded 路径**: `skTarget = "socail-king"`、`sopPath = "/Users/LOCAL_USER/SuperMatrixRuntime/..."` 等路径在脚本中 hardcoded [源码锚点] `scripts/watcher-tick.sh:37-39`，分发到不同机器时需要环境变量覆盖。
- **`sync-bitable.sh` 的 macOS/Linux date 兼容**: 使用 `date -r`（macOS）回退到 `date -d`（Linux）[源码锚点] `scripts/sync-bitable.sh:58`，但在某些 BSD 系统上可能不工作。
- **`terminal-launcher.sh` 的 hardcoded 路径**: `WATCHDOG_SCRIPT` 和 `LOG` 路径 hardcoded 为 `/Users/LOCAL_USER/SuperMatrix/...` [源码锚点] `scripts/launchd/terminal-launcher.sh:9-10`，这是设计上的，因为 launchd plist 也 hardcoded 了同一套路径。

---

## 5. LaunchAgent

### 5.1 Plist 配置

SuperMatrix 使用两套 launchd agent：

**主进程 agent** (`com.LOCAL_USER.supermatrix`):
- **Label**: `com.LOCAL_USER.supermatrix` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:5`
- **ProgramArguments**: 调用 `scripts/launchd/supermatrix-launch.sh` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:7-9`
- **RunAtLoad**: true [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:10`
- **KeepAlive**: true — 进程退出时自动重启 [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:11`
- **ThrottleInterval**: 30 — 两次启动间隔至少 30 秒，防止 crash loop [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:12`
- **StandardOutPath**: `logs/supermatrix.stdout.log` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:13`
- **StandardErrorPath**: `logs/supermatrix.stderr.log` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:14`
- **EnvironmentVariables**: 仅注入 `HOME` 和 `LARK_CLI_NO_PROXY=1` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:15-19`

**终端 launcher agent** (`com.LOCAL_USER.localwatch`):
- **Label**: `com.LOCAL_USER.localwatch` [源码锚点] `scripts/launchd/com.LOCAL_USER.localwatch.plist:6`
- **ProgramArguments**: `/bin/bash` → `terminal-launcher.sh` [源码锚点] `scripts/launchd/com.LOCAL_USER.localwatch.plist:8-10`
- **RunAtLoad**: true, **KeepAlive**: true, **ThrottleInterval**: 30 [源码锚点] `scripts/launchd/com.LOCAL_USER.localwatch.plist:12-17`
- 日志路径: `logs/terminal-launcher.{stdout,stderr}.log` [源码锚点] `scripts/launchd/com.LOCAL_USER.localwatch.plist:18-21`

### 5.2 Install / Uninstall 流程

**install.sh** (`set -euo pipefail`) [源码锚点] `scripts/launchd/install.sh:5`：
1. 检查 `.env.local` 存在 [源码锚点] `scripts/launchd/install.sh:13-16`。
2. 创建 `logs/` 目录，赋予 launch 脚本执行权限 [源码锚点] `scripts/launchd/install.sh:18-19`。
3. 若已有同名 agent loaded，先 `launchctl unload` [源码锚点] `scripts/launchd/install.sh:22-25`。
4. 复制 plist 到 `~/Library/LaunchAgents/` [源码锚点] `scripts/launchd/install.sh:28`。
5. `launchctl load` 加载新 agent [源码锚点] `scripts/launchd/install.sh:31`。
6. 睡眠 1 秒后验证 `launchctl list` 包含目标 label [源码锚点] `scripts/launchd/install.sh:34-40`。

**uninstall.sh** (`set -euo pipefail`) [源码锚点] `scripts/launchd/uninstall.sh:4`：
1. 检查 plist 文件存在，不存在则直接退出 0 [源码锚点] `scripts/launchd/uninstall.sh:8-11`。
2. `launchctl unload`（忽略错误）并删除 plist [源码锚点] `scripts/launchd/uninstall.sh:14-17`。
3. 明确说明不会 broad pkill，避免误杀无关进程 [源码锚点] `scripts/launchd/uninstall.sh:19-20`。

### 5.3 日志路径

- `logs/supermatrix.stdout.log` / `logs/supermatrix.stderr.log` — 主进程 stdout/stderr。
- `logs/sm-crash.log` — `localwatch.sh` 将 stderr 单独重定向至此，用于 crash 分析 [源码锚点] `scripts/localwatch.sh:272`。
- `logs/localwatch.log` — localwatch 自身日志（结构化时间戳）。
- `logs/terminal-launcher.log` — terminal-launcher 的 AppleScript 监控日志 [源码锚点] `scripts/launchd/terminal-launcher.sh:10`。

### 5.4 环境变量传递

launchd agent 的 EnvironmentVariables 仅包含最小集合：`HOME` 和 `LARK_CLI_NO_PROXY` [源码锚点] `scripts/launchd/com.LOCAL_USER.supermatrix.plist:15-19`。其余所有环境变量（包括 `SM_ROOT_GROUP_ID`、`SM_DB_PATH` 等）通过 `supermatrix-launch.sh` 中 `source .env.local` 加载 [源码锚点] `scripts/launchd/supermatrix-launch.sh:21-23`。这确保了敏感配置不进入 plist，且 `.env.local` 修改后只需 restart agent 即可生效。

### 5.5 Terminal.app 架构

由于 Claude Code 的 OAuth 凭证存储在 macOS login keychain 中，只有交互式终端 session 才有权限读取。因此主进程必须跑在 Terminal.app 里 [源码锚点] `scripts/launchd/README.md:61-75`：

```
launchd → terminal-launcher.sh → 打开 Terminal.app → localwatch.sh → SM
```

`terminal-launcher.sh` (`set -u`) 通过 `osascript` 打开 Terminal.app 执行 `localwatch.sh` [源码锚点] `scripts/launchd/terminal-launcher.sh:21-26`，然后进入监控循环：每 30 秒检查 `localwatch.sh` 进程是否存活，若消失则退出，触发 launchd 重启并重新打开终端 [源码锚点] `scripts/launchd/terminal-launcher.sh:32-36`。

---

## 6. Smoke 验证

### 6.1 验证步骤

`docs/SMOKE.md` 定义了 10 步手动验证流程（外加 Kimi 后端 9 步专项验证）[源码锚点] `docs/SMOKE.md:1-92`。

**通用前置条件** [源码锚点] `docs/SMOKE.md:5-19`:
- Node 22+, `npm install` 完成。
- `.env.local` 配置完整（`SM_ROOT_GROUP_ID`, `SM_ROOT_USER_ID`, `SM_WORKSPACE_ROOT`, `SM_DB_PATH`, `SM_BACKEND`, `SM_LOG_LEVEL`）。
- `lark-cli` 凭证已配置（`LARK_APP_ID`, `LARK_APP_SECRET`）。
- `claude` 或 `codex` CLI 在 PATH 中。

**10 步通用验证**:

| 步骤 | 操作 | 预期结果 | 故障排查 |
|------|------|----------|----------|
| 1 | `npm run start` | 控制台打印 `supermatrix starting`，成功订阅 root group | 检查 `LARK_APP_ID` 和 lark-cli auth |
| 2 | Root 群发送 `/help` | 回复包含 `/new`, `/delete`, `/list`, `/restart` 等中文说明 | 检查 root group 绑定和 dispatcher 路由 |
| 3 | `/new claude alpha` | 创建 `$SM_WORKSPACE_ROOT/alpha`，git init，创建飞书群，回复创建成功 | 检查 `im:chat:create_by_user` scope |
| 4 | alpha 群发送 `ping` | 流式卡片出现并 finalize，message_run status=`completed` | 检查 claude CLI 安装和 OAuth/API Key |
| 5 | 长 prompt + `/cancel` | 卡片 finalize 为 cancellation，message_run status=`failed` | 检查 cancel 信号是否正确路由到 backend |
| 6 | `/reset` | 回复上下文已清空，backend_session_id 被清除 | 检查 sessionLifecycle.reset 逻辑 |
| 7 | 长 prompt + `/restart` | backend 进程被中断，session 回到 idle | 检查 processLifecycle.kill 逻辑 |
| 8 | `/list` + `/status alpha` | alpha 被列出，status 详情完整 | 检查 store.listSessions |
| 9 | `/delete alpha` | 群被解散，session status=`deleted` | 检查 lark-cli 解散群权限 |
| 10 | Ctrl+C 后重启 | busy session 根据 backend_session_id 翻转为 idle 或 error；running message_run 翻转为 timeout | 检查 bootSelfCheck.reconcileBackendProcesses |

**Kimi 后端专项验证**（9 步） [源码锚点] `docs/SMOKE.md:80-92`:
1. `kimi info` 返回版本号。
2. `/new test-kimi kimi`，群名以 `-kimi` 结尾。
3. 首轮问候 ≤60s 收 final。
4. 多轮接续验证 ACP session 持续。
5. `/cancel` 中途：kimi ACP 进程不死（同一 PID），Lark 卡片 cancelled。
6. `/backend` 切换：群名后缀变化，上下文清空。
7. `/reload` 后只有一个 ACP PID（旧进程已清理）。
8. 2-3 个 kimi session 并发时只有一个 ACP PID（单进程复用）。
9. 交互式 `kimi`（不含 `acp`）不被 reconcile 误杀。

### 6.2 已知限制

- `docs/SMOKE.md` 第 19 行注明：`src/adapters/lark-cli/realClient.ts` 当前为 stub，执行完整端到端 smoke 前需要先运行 `scripts/spike-lark.ts` 并替换 wiring [源码锚点] `docs/SMOKE.md:19`。这意味着 SMOKE.md 的某些步骤在特定 checkout 状态下可能无法直接执行。

---

## 7. 依赖检查

### 7.1 分层规则

`scripts/check-deps.ts` 实现了六边形架构的依赖方向守卫 [源码锚点] `scripts/check-deps.ts:7-14`：

```
domain  → domain
ports   → ports, domain
adapters → adapters, ports, domain
app     → app, ports, domain
cli     → cli, app, adapters, ports, domain
unknown → all layers (免死金牌)
```

**判定函数** `isViolation(from, to)` [源码锚点] `scripts/check-deps.ts:26-29`]:
- 若任一 layer 为 `unknown`，不视为违规。
- 否则检查 `to` 是否在 `ALLOWED[from]` 列表中，不在则违规。

**路径分类** `classifyImport(path)` [源码锚点] `scripts/check-deps.ts:16-24`]:
- 通过字符串包含 `/src/domain/` 等子串判定文件所属 layer。
- 使用相对路径解析（`resolve(file, "..", spec)`）将 import 语句中的相对路径映射到实际目标文件，再分类其 layer。

### 7.2 Violation 判定逻辑

扫描流程 [源码锚点] `scripts/check-deps.ts:47-74`]:
1. 递归遍历 `src/` 下所有 `.ts` 文件（排除 `.d.ts`）。
2. 正则 `/from\s+["']([^"']+)["']/g` 提取所有 `from "..."` import 语句。
3. 忽略非相对路径的 import（`!spec.startsWith(".")`）。
4. 对每条相对路径 import，计算目标文件的绝对路径，分类其 layer。
5. 若 `isViolation(fromLayer, toLayer)` 为 true，记录违规信息。
6. 存在违规则 `process.exit(1)`，否则输出 `check-deps: OK`。

### 7.3 测试对账

`tests/scripts/checkDeps.test.ts` 覆盖了核心判定场景 [测试对账] `tests/scripts/checkDeps.test.ts`：

| 场景 | 预期 | 对应源码 |
|------|------|----------|
| domain → ports | 违规 | `check-deps.ts:7-8` |
| adapters → ports | 允许 | `check-deps.ts:10` |
| app → adapters | 违规 | `check-deps.ts:11` |
| cli → app | 允许 | `check-deps.ts:12` |
| ports → domain | 允许 | `check-deps.ts:9` |
| domain → domain | 允许 | `check-deps.ts:8` |

当前代码零违规 [源码锚点] `00-skeleton.md:74`。

---

## 8. Watcher 脚本

### 8.1 两层 Watcher 架构

SuperMatrix 的 spawn closure 监控由两个互补脚本组成：

- **`spawn-closure-watcher.sh`**: 面向 **async items**（`spawn_async_items` 表），处理已降级为异步的 spawn 闭包的再驱动、投递、裁决。
- **`watcher-tick.sh`**: 面向 **predicates**（`spawn_predicates` 表），周期性评估活跃的验证断言，检测异常信号并路由到 socail-king 进行裁决。

### 8.2 spawn-closure-watcher.sh

**安全设置**: `set -uo pipefail`（无 `set -e`）[源码锚点] `scripts/spawn-closure-watcher.sh:2`。

**执行模型**: 这是一个 bash 包装的 TSX 内联脚本。bash 部分仅负责定位 `tsx` 二进制并启动 heredoc TS 代码 [源码锚点] `scripts/spawn-closure-watcher.sh:1-12`。核心逻辑用 TypeScript 内联编写，直接 `import Database from "better-sqlite3"` 和 `import { classifyAndRoute } from "./scripts/lib/spawnClosureClassify.ts"` [源码锚点] `scripts/spawn-closure-watcher.sh:13-16`。

**扫描范围**: 查询 `spawn_async_items` 表中 status 属于 `('pending', 'waiting_child', 'delivering', 're_driving', 'adjudicating')` 的行，按 `updated_at ASC` 排序，LIMIT 受 `SPAWN_CLOSURE_SCAN_LIMIT` 控制（默认 100）[源码锚点] `scripts/spawn-closure-watcher.sh:46-55`。

**路由决策**: 对每个 item 调用 `classifyAndRoute()`，结果 action 属于 `deliver`, `failure_notice`, `redrive`, `redeliver`, `adjudicate`, `noop`, `failed` 之一，汇总到 `TickSummary` 并输出 JSON。自动重投关闭时，`failure_notice` 先以 `<comm_id>:failure-notice` 向 caller 写入 `status_reconcile` heartbeat todo；仅 `inserted` 或 `duplicate` 后才将 item 标为 `parked + auto_redrive_suppressed` [源码锚点] `scripts/spawn-closure-watcher.sh:36-116`, `scripts/lib/spawnClosureClassify.ts`。

### 8.3 watcher-tick.sh

**安全设置**: `set -uo pipefail`（无 `set -e`）[源码锚点] `scripts/watcher-tick.sh:2`。

**执行模型**: 同样是 bash 包装的 TSX 内联脚本，但代码量更大（1040 行），包含完整的 predicate 评估、信号检测、SK 路由、fallback 逻辑 [源码锚点] `scripts/watcher-tick.sh:1-1040`。

**核心流程**:

1. **扫描活跃 predicates**: 从 `spawn_predicates` LEFT JOIN `cross_session_log`、`sessions`、`watcher_state`，过滤 status='active'、predicate_json 非空、未 closed、且创建时间晚于 `strictPredicateCutoverMs`（默认未来时间戳 1778828828000）和 7 天 cutoff 的行 [源码锚点] `scripts/watcher-tick.sh:848-900`。
2. **评估 predicate**: 对每个行调用 `evaluateSpawnPredicate()`，传入 `dbRegistry` 和 `env` [源码锚点] `scripts/watcher-tick.sh:913-919`。
3. **更新 watcher_state**: 通过 `upsertWatcherState()` 写入评估结果、更新 consecutive_false_count、consecutive_transient_fail_count、patch_count_24h [源码锚点] `scripts/watcher-tick.sh:242-293`。
4. **检测触发信号**: `detectTriggerSignals()` 检查五种信号 [源码锚点] `scripts/watcher-tick.sh:445-512`]:
   - `predicate_long_false` — 连续 false 超过阈值（`expectedWindowSec * 1.5 / cronPeriodSec`）
   - `predicate_patch_churn` — 24h 内 patch ≥ 3 次
   - `child_unhealthy` — child session error/deleted、latest message_run failed/timeout、或 transient fail 超过阈值
   - `delivery_failed` — result_sink_attempts 有 failed 或 continuation 有 failed 行
   - `spawn_creation_missing_child` — spawn 创建超过 1h 但 child_session_id 仍为 null
5. **路由限流**: 每 tick 最多路由 `routeLimit`（默认 3）条信号，超过则停止并记录 warn [源码锚点] `scripts/watcher-tick.sh:950-959`。
6. **去重与冷却**: `isSignalEligible()` 检查同一信号 1h 内是否已路由过，以及 `next_eligible_at` 是否尚未到达 [源码锚点] `scripts/watcher-tick.sh:514-534`。
7. **SK 路由或 fallback**: `routeToSkOrFallback()` 优先通过 `/api/spawn` 路由到 `socail-king`；若 24h 内已尝试 3 次或 spawn 失败，则 fallback 到 `/api/notify` [源码锚点] `scripts/watcher-tick.sh:691-735`、`scripts/watcher-tick.sh:737-846`。
8. **记录 tick**: 将扫描数、评估数、路由数写入 `watcher_ticks` 表 [源码锚点] `scripts/watcher-tick.sh:295-312`。

### 8.4 spawnClosureClassify.ts（共享库）

`scripts/lib/spawnClosureClassify.ts` 提供 `classifyAsyncItem` 和 `classifyAndRoute`，被 `spawn-closure-watcher.sh` 内联引用 [源码锚点] `scripts/lib/spawnClosureClassify.ts:1-559`。

**RouteDecision 类型** [源码锚点] `scripts/lib/spawnClosureClassify.ts:39-44`]:
- `deliver` — 向 caller 投递完整结果
- `redrive` — 重新驱动 target session 执行原始 spawn
- `redeliver` — 重新投递已有执行结果
- `adjudicate` — 提交 socail-king 裁决
- `noop` — 无需操作

**分类规则**（按优先级）:

1. **adjudicating 冷却**: 若处于 adjudicating 且未过 stale 窗口（默认 30min），noop [源码锚点] `scripts/lib/spawnClosureClassify.ts:73-82`。
2. **re_driving 宽限期**: 若处于 re_driving 且未过 grace 窗口（默认 30min），noop [源码锚点] `scripts/lib/spawnClosureClassify.ts:84-93`。
3. **delivery 去重**: 若处于 delivering，关闭 item 并 noop [源码锚点] `scripts/lib/spawnClosureClassify.ts:95-98`。
4. **行缺失**: 缺少 caller_session 或 target_session → adjudicate [源码锚点] `scripts/lib/spawnClosureClassify.ts:100-102`。
5. **comm 缺失**: cross_session_log 行不存在 → adjudicate [源码锚点] `scripts/lib/spawnClosureClassify.ts:104-107`。
6. **过期**: item 创建时间超过 stale 窗口（默认 24h）→ adjudicate [源码锚点] `scripts/lib/spawnClosureClassify.ts:109-112`。
7. **尝试预算耗尽**: attempt_count ≥ 2 → adjudicate [源码锚点] `scripts/lib/spawnClosureClassify.ts:114-116`。
8. **已通过验证**: allPassed 且 failure_kind ≠ late_result → 关闭并 noop [源码锚点] `scripts/lib/spawnClosureClassify.ts:118-121`。
9. **waiting_child 分支**:
   - executionPassed + finalMessage → deliver [源码锚点] `scripts/lib/spawnClosureClassify.ts:124-126`
   - executionTerminal → redrive [源码锚点] `scripts/lib/spawnClosureClassify.ts:127-129`
   - 否则 noop（child 仍在运行）[源码锚点] `scripts/lib/spawnClosureClassify.ts:130`
10. **failure_kind 分支**:
    - `late_result` + executionPassed → deliver [源码锚点] `scripts/lib/spawnClosureClassify.ts:133-135`
    - `spawn_not_started` → redrive [源码锚点] `scripts/lib/spawnClosureClassify.ts:137-139`
    - `run_error` / `run_timeout` / `empty_output` → redrive [源码锚点] `scripts/lib/spawnClosureClassify.ts:141-143`
    - `delivery_missing` + executionPassed → redeliver [源码锚点] `scripts/lib/spawnClosureClassify.ts:145-152`
    - `delivery_missing` 无 executionPassed → adjudicate [源码锚点] `scripts/lib/spawnClosureClassify.ts:153-154`

### 8.5 测试对账

**spawn-closure-watcher.test.ts** [测试对账] `tests/scripts/spawn-closure-watcher.test.ts`:
- 验证扫描 5 个不同 status 的 async items 并输出 tick summary [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:18-41`。
- 验证 redrive 路由会 repost 原始 spawn 并将 item 标记为 `re_driving` [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:43-77`。
- 验证 deliver 路由会 enqueue heartbeat todo 并将 item 标记为 `closed` [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:79-113`。
- 验证 late_result 只 enqueue 一次（stable comm key），重复运行不会重复投递 [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:115-148`。
- 验证 adjudicate 路由会 spawn socail-king 并将 item 标记为 `adjudicating` [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:150-180`。
- 验证 stale adjudicating item 在窗口内被 skip，窗口外重新 adjudicate [源码锚点] `tests/scripts/spawn-closure-watcher.test.ts:182-239`。

**spawnClosureClassify.test.ts** [测试对账] `tests/scripts/spawnClosureClassify.test.ts`:
- D1: late_result + completed → deliver [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:19-34`。
- D2: spawn_not_started → redrive [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:36-45`。
- D3: run_error / run_timeout + attempt<2 → redrive [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:47-62`。
- D4: delivery_missing + execution output → redeliver [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:64-76`。
- 验证 continuation fallback（parent busy）被视为 deliverable full result [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:96-109`。
- 验证 stale item（SPAWN_CLOSURE_STALE_MS=1）→ adjudicate [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:175-193`。
- 验证 adjudication spawn 使用 `supermatrix_internal.caller_invocation="async_kickoff"` 而非 public mode [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:213-235`。
- 验证 re_driving item 在 grace 窗口内 noop，窗口外重新评估 [源码锚点] `tests/scripts/spawnClosureClassify.test.ts:332-379`。

**watcher-tick.test.ts** [测试对账] `tests/scripts/watcher-tick.test.ts`:
- 验证 strict cutover 过滤：创建时间早于 cutover 的行被 skip [源码锚点] `tests/scripts/watcher-tick.test.ts:77-102`。
- 验证 empty predicate JSON 被 skip [源码锚点] `tests/scripts/watcher-tick.test.ts:104-130`。
- 五种信号各被路由到 SK 并写入 watcher_state dedup [源码锚点] `tests/scripts/watcher-tick.test.ts:132-179`。
- 验证 pending tool-call 证据从 stream_log 提取并进入 SK payload [源码锚点] `tests/scripts/watcher-tick.test.ts:181-228`。
- 验证 SK spawn 不可用时 fallback 到 `/api/notify` 并记录 watcher_exceptions [源码锚点] `tests/scripts/watcher-tick.test.ts:230-283`。
- 验证 route limit 阻止单个 tick 内多次路由 [源码锚点] `tests/scripts/watcher-tick.test.ts:285-312`。

---

## 9. Bitable 同步

### 9.1 数据流

`scripts/sync-bitable.sh` 将 `cross_session_log` 表增量同步到 Feishu Bitable [源码锚点] `scripts/sync-bitable.sh:1-135`。

**安全设置**: `set -euo pipefail` [源码锚点] `scripts/sync-bitable.sh:2`。

**环境变量要求**:
- `SM_DB_PATH` — SQLite 数据库路径（必填）[源码锚点] `scripts/sync-bitable.sh:7`
- `SM_BITABLE_BASE_TOKEN` — Bitable base token（必填）[源码锚点] `scripts/sync-bitable.sh:8`
- `SM_BITABLE_TABLE_ID` — Bitable table ID（必填）[源码锚点] `scripts/sync-bitable.sh:9`

**两阶段同步策略**:

**阶段 1 — Insert 未同步记录** [源码锚点] `scripts/sync-bitable.sh:24-88`]:
- 查询 `bitable_record_id IS NULL` 的 cross_session_log 行。
- 通过 LEFT JOIN sessions 解析 from_session_id / to_session_id / child_session_id 的 name。
- 构建 fields JSON（发起方、目标方、类型、Prompt、状态、发起时间），可选追加子 Session、结果摘要、错误信息、完成时间。
- 调用 `lark-cli base +record-upsert` 写入 Bitable。
- 成功后将返回的 `record_id` 写回 `cross_session_log.bitable_record_id`，并更新 `synced_at`。

**阶段 2 — Update 已同步但状态变更的记录** [源码锚点] `scripts/sync-bitable.sh:90-133`]:
- 查询 `bitable_record_id IS NOT NULL` 且 `finished_at IS NOT NULL` 且 (`synced_at IS NULL` 或 `synced_at < finished_at`) 的行。
- 仅更新状态、子 Session、结果摘要、错误信息、完成时间（不重复写入 Prompt 等静态字段）。
- 同样通过 `record-upsert --record-id` 更新，成功后刷新 `synced_at`。

### 9.2 字段映射

| Bitable 字段 | 来源 |
|-------------|------|
| 发起方 | `sessions.name` (from_session_id) |
| 目标方 | `sessions.name` (to_session_id) |
| 类型 | `cross_session_log.kind` |
| Prompt | `cross_session_log.prompt`（截断 2000 字符） |
| 状态 | `cross_session_log.status` |
| 发起时间 | `cross_session_log.created_at`（毫秒转本地时间字符串） |
| 子Session | `sessions.name` (child_session_id) |
| 结果摘要 | `cross_session_log.result_preview`（截断 2000 字符） |
| 错误信息 | `cross_session_log.error_message` |
| 完成时间 | `cross_session_log.finished_at`（毫秒转本地时间字符串） |

### 9.3 已知问题

- Prompt 和结果摘要被截断为 2000 字符，防止 lark-cli 参数过长 [源码锚点] `scripts/sync-bitable.sh:43`、`scripts/sync-bitable.sh:46`。
- 日期转换使用 `date -r`（macOS）回退 `date -d`（Linux），但在某些系统可能不兼容 [源码锚点] `scripts/sync-bitable.sh:58`。
- 阶段 2 的 update 不更新"发起方"等静态字段，如果 session 改名后同步，Bitable 中的旧名不会自动刷新。

---

## 10. Catalog 管理

### 10.1 regenerate-catalog.ts

`scripts/regenerate-catalog.ts` 是一次性运维脚本，用于从 live `sessions` 表重建全局 `session-catalog.json` [源码锚点] `scripts/regenerate-catalog.ts:1-73`。

**使用场景**: session 的 `purpose` 被 FP 编辑后，catalog 中的 `capability` 字段（直接映射 purpose）会变 stale，因为 catalog 只在 create/delete/backend-switch 时自动重建。此脚本允许在不重启 live 进程的情况下 flush purpose backfill [源码锚点] `scripts/regenerate-catalog.ts:6-11`。

**执行流程**:
1. 要求环境变量 `SM_DB_PATH` 和 `SM_WORKSPACE_ROOT` [源码锚点] `scripts/regenerate-catalog.ts:30-34`。
2. 初始化 `SqliteBindingStore`，构造 `NodeWorkspaceFs` 和 `Clock`。
3. 调用 `createSessionCatalogService({ store, fs, catalogPath, clock }).regenerateCatalog(reason)` [源码锚点] `scripts/regenerate-catalog.ts:54-61`。
4. 输出 active session 数量。

**设计约束**: 脚本明确声明"does not touch symlinks, delete files, or commit" [源码锚点] `scripts/regenerate-catalog.ts:14-15`。symlink 的创建和删除由 `migrate-to-session-catalog.ts` 负责。

### 10.2 migrate-to-session-catalog.ts

这是从 CONSTITUTION.md 时代迁移到 session-catalog.json 时代的一次性脚本 [源码锚点] `scripts/migrate-to-session-catalog.ts:1-159`。

**默认 dry-run**: 不加 `--apply` 时只打印将要执行的操作，不修改文件系统 [源码锚点] `scripts/migrate-to-session-catalog.ts:54`、`scripts/migrate-to-session-catalog.ts:70-79`。

**执行流程**:
1. **写全局 catalog**（仅 `--apply`）：调用 `catalogService.regenerateCatalog("migration: retire CONSTITUTION.md")` [源码锚点] `scripts/migrate-to-session-catalog.ts:70-79`。
2. **遍历 active FP-governed sessions**（`fpManaged !== false`，排除 child 和 deleted）[源码锚点] `scripts/migrate-to-session-catalog.ts:82-83`。
3. **去重共享 workdir**：同一 workdir 被多个 session 共享时只迁移一次 [源码锚点] `scripts/migrate-to-session-catalog.ts:87-89`。
4. **创建 symlink**：`session-catalog.json -> $SM_WORKSPACE_ROOT/session-catalog.json` [源码锚点] `scripts/migrate-to-session-catalog.ts:103-108`。
5. **删除 CONSTITUTION.md** [源码锚点] `scripts/migrate-to-session-catalog.ts:110-115`。
6. **自动 commit**（仅对 `SM_WORKSPACE_ROOT` 下的 git repo）：`git add` + `git commit` [源码锚点] `scripts/migrate-to-session-catalog.ts:122-135`。
7. **外部 repo 处理**：不在 `SM_WORKSPACE_ROOT` 下的 repo 或不具备 git 的目录只做文件系统变更，不自动 commit [源码锚点] `scripts/migrate-to-session-catalog.ts:136-140`。

### 10.3 session-catalog.json 格式

由 `src/app/sessionCatalog.ts` 中的 `regenerateCatalog` 生成（脚本仅调用此服务）。JSON 结构大致为：

```json
{
  "generatedAt": 1716192000000,
  "reason": "manual regenerate: purpose backfill",
  "sessions": [
    {
      "id": "sess_abc12345",
      "name": "alpha",
      "alias": "",
      "scope": "user",
      "backend": "claude",
      "status": "idle",
      "workdir": "/path/to/alpha",
      "capability": "Iterate on feature X",
      "category": "业务",
      "fpManaged": true
    }
  ]
}
```

每个 session 目录中的 `session-catalog.json` 是一个 symlink 指向全局文件，保证所有工作区看到一致的目录视图 [源码锚点] `00-skeleton.md:459`、`scripts/migrate-to-session-catalog.ts:103-108`。

---

## 11. 不变式清单

以下不变式由 Scripts & Ops 层保护，违反将导致可预期的系统性后果：

1. **迁移版本唯一性**: 迁移文件名必须以 `\d+_` 开头，版本号全局唯一。`parseVersion` 通过正则提取前导数字，重复版本号会导致未定义行为 [源码锚点] `src/adapters/store-sqlite/migrations.ts:91-95`。**违反后果**: 同一版本被多次执行或跳过，schema 状态不一致。

2. **Critical 迁移失败即终止**: Critical 迁移（非 `.opt.sql`）在 `runOne` 中抛出异常会终止整个 boot。Optional 迁移失败仅 degrade [源码锚点] `src/adapters/store-sqlite/migrations.ts:40-54`。**违反后果**: 若将 critical 文件重命名为 optional 以绕过失败，可能导致核心表缺失而代码假设其存在，引发运行时崩溃。

3. **setup-dogfood-session.sh 的幂等性**: 脚本在检测到同名非 deleted session 时立即失败退出，而不是静默复用 [源码锚点] `scripts/setup-dogfood-session.sh:45-49`。**违反后果**: 重复运行会导致同一 workdir 绑定多个 session，破坏 one-to-one 约束。

4. **localwatch 单实例锁**: 通过 `mkdir` 原子操作实现锁，已存在锁目录时检查 pid 存活，存活则退出，否则 reclaim [源码锚点] `scripts/localwatch.sh:23-36`。**违反后果**: 两个 localwatch 同时运行会争夺同一 SM 子进程，引发 20s SIGTERM ping-pong（2026-04-17 已观察到）。

5. **check-deps 的方向性**: `domain` 层禁止导入 `ports`/`adapters`/`app`/`cli`；`app` 层禁止导入 `adapters`/`cli` [源码锚点] `scripts/check-deps.ts:7-14`。**违反后果**: 六边形边界模糊，平台变更不再局部可理解，修复会扩散到整个仓库。

6. **spawn_async_items 的 attempt_count 上限**: `classifyAsyncItem` 在 `attempt_count >= 2` 时强制路由到 adjudication [源码锚点] `scripts/lib/spawnClosureClassify.ts:114-116`。**违反后果**: 若绕过此限制（如直接 DB 修改 attempt_count），watcher 会无限重试，耗尽资源。

7. **watcher-tick 的 routeLimit**: 每 tick 最多路由 `SPAWN_WATCHER_ROUTE_LIMIT`（默认 3）条信号 [源码锚点] `scripts/watcher-tick.sh:950-959`。**违反后果**: 移除此限制可能导致单个 tick 内 spawn 大量 socail-king child sessions，引发级联负载。

8. **safe-reload.sh 的 dedup 窗口与 claim 顺序**: 默认 6h（21600s）的 dedup 窗口防止 scheduler fallback cron 在 4h 内重复触发 `/reload`；marker 是 **dispatch 前**写下的 claim（`mkdir` 锁串行化 check-and-claim，write-then-rename 落盘），dispatch 之后的任何失败都保留 claim 并 exit 2 [源码锚点] `scripts/safe-reload.sh:73-160`。**违反后果**: 若缩小窗口到 <4h，daily-reload 与 daily-reload-fallback 重叠期间可能产生 100+ 次重启；若把 marker 改回「发送成功后再写」，一次 send 成功但结果读取失败就会让后续每个 tick 重发 `/reload`（事故 watchdog-kimi-acp-982f503）。

9. **terminal-launcher.sh 的监控循环**: 进程通过 `pgrep -f 'localwatch\.sh'` 监控 localwatch 存活，消失则退出以触发 launchd 重启 [源码锚点] `scripts/launchd/terminal-launcher.sh:32-36`。**违反后果**: 若 localwatch 进程名变化（如被重命名），launcher 会误认为其已死，进入无限重启循环。

10. **sync-bitable.sh 的双向追踪**: 通过 `bitable_record_id` 和 `synced_at` 两个字段实现增量同步，缺一不可 [源码锚点] `scripts/sync-bitable.sh:36-37`、`scripts/sync-bitable.sh:102-104`。**违反后果**: 若手动删除 Bitable 记录但不清空 `bitable_record_id`，后续更新将因 record_id 失效而静默失败。

---

## 12. 反例场景

以下场景展示了违反上述不变式或错误使用脚本层时可能产生的实际问题：

### 反例 1: 将 Critical Migration 重命名为 Optional 绕过失败

**场景**: 某开发者在本地将 `018_sessions_timestamp_guard.sql` 重命名为 `.opt.sql`，因为触发器创建与某个旧的 SQLite 版本不兼容导致 boot 失败。
**后果**: boot 继续，但 `sessions` 表缺少 timestamp 触发器。随后某条代码路径插入了一个 `typeof(created_at) == 'text'` 的行。`rowToSession` 读取后传入 `asTimestamp`，在下游 `Date` 构造时产生 `Invalid Date`，导致飞书卡片更新时间显示为 `NaN` 或崩溃。
**根因**: critical 迁移的语义是保证表结构满足代码假设；绕过它破坏了类型契约 [源码锚点] `src/adapters/store-sqlite/migrations.ts:40-54`。

### 反例 2: 同时运行 dev-loop.sh 和 localwatch.sh

**场景**: 开发者在终端中手动运行 `./scripts/localwatch.sh`，同时忘记 unload 之前通过 launchd 加载的 dev-loop。
**后果**: localwatch 的 `takeover()` 杀死 dev-loop 的 PID，但 dev-loop 的 trap INT 处理可能在其子进程（tsx main.ts）已经退出后才执行。此时 localwatch 启动新的 SM 进程，而 launchd 发现 dev-loop 退出后重启它，dev-loop 又执行 takeover 杀死 localwatch 的 SM。两者进入 20s 的 SIGTERM ping-pong，最终触发 circuit breaker 停止重启。
**根因**: 两个 supervisor 的 takeover 逻辑互不原子，存在竞态窗口 [源码锚点] `scripts/localwatch.sh:200-246`、`scripts/dev-loop.sh:34-82`。

### 反例 3: watcher-tick.sh 的 hardcoded path 被分发到其他机器

**场景**: 将 SuperMatrix 仓库 clone 到另一台 Mac（用户名不同），scheduler 定时调用 `watcher-tick.sh`。
**后果**: 脚本中的 `sopPath = "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/socail-king/sop/spawn-exception-transaction.md"` 指向不存在的路径。adjudication spawn 的 prompt 包含此路径，socail-king 读取 SOP 失败，裁决质量下降或无法执行。
**根因**: hardcoded 绝对路径在分发场景下失效。应通过环境变量 `SPAWN_CLOSURE_ADJUDICATION_SOP` 覆盖 [源码锚点] `scripts/watcher-tick.sh:39`。

### 反例 4: safe-reload.sh 的 dedup marker 被误删

**场景**: 运维人员清理 `SuperMatrixRuntime/data/` 下的临时文件，误删 `.last-reload-fired`。
**后果**: 下一次 scheduler fallback cron（每 5 分钟）触发时，dedup 检查通过（无 marker），立即发送 `/reload`。后续 4h 内每 5 分钟都会发送一次 `/reload`，导致 SM 进程不断重启（因为 clean exit 后 dev-loop/localwatch 会立即重启）。飞书 event subscribe 反复断开重连，消息可能丢失或重复投递。
**根因**: dedup marker（claim）的存活是 safe-reload 正确性的前提，应被视为持久状态而非临时文件 [源码锚点] `scripts/safe-reload.sh:73-142`。

### 反例 5: sync-bitable.sh 在 Bitable 表结构变更后失败

**场景**: 业务侧修改了 Feishu Bitable 的字段名（如将"发起方"改为"FromSession"），但未通知 infra。
**后果**: `lark-cli base +record-upsert` 因字段名不匹配而失败。由于脚本使用 `while ... | while read` 管道处理，单个 upsert 失败只会打印 WARN 并 `continue` [源码锚点] `scripts/sync-bitable.sh:77-88`。然而 `record_id` 解析失败导致 `bitable_record_id` 未被写回 DB。下一次同步时，同一行再次被视为"未同步"，重复尝试插入，在 Bitable 中产生大量重复记录（如果 upsert 的字段匹配逻辑部分成功）或持续报错。
**根因**: Bitable 字段名与脚本硬编码的映射缺乏契约校验，失败时未回滚或标记为永久失败。

### 反例 6: localwatch.sh 的 reap_orphan_vitest 误杀正常测试

**场景**: 开发者在 session 中运行长时间（>5min）的 vitest 测试，且未使用 `nohup` 或 screen。
**后果**: `reap_orphan_vitest()` 每 5 分钟扫描一次 `ppid=1` 且 `etime>5min` 的 vitest worker 进程。如果测试进程因父 shell 退出而被 reparent 到 launchd（ppid=1），它会被 localwatch 误判为孤儿并 SIGKILL，导致测试失败且结果丢失。
**根因**: 启发式孤儿检测无法区分"被 SIGPIPE 遗留的孤儿"和"合法后台长时间测试"。注释中明确标注这是 bandaid [源码锚点] `scripts/localwatch.sh:585-622`。

---

## 13. 附录: 测试覆盖矩阵

| 测试文件 | 被测目标 | 关键断言 |
|----------|----------|----------|
| `tests/scripts/checkDeps.test.ts` | `check-deps.ts` | 六边形分层违规/允许判定 |
| `tests/scripts/localwatch.test.ts` | `localwatch.sh` | Scheduler 健康检查、self-check spawn payload 结构 |
| `tests/scripts/spawn-closure-watcher.test.ts` | `spawn-closure-watcher.sh` | Tick summary、redrive/deliver/adjudicate/noop 路由、stale 处理 |
| `tests/scripts/spawnClosureClassify.test.ts` | `spawnClosureClassify.ts` | classifyAsyncItem 全部 route 分支、attempt budget、grace window |
| `tests/scripts/watcher-tick.test.ts` | `watcher-tick.sh` | 信号检测、SK 路由、fallback、route limit、stream_log tool-call 提取 |
| `tests/scripts/weeklyReviewWatchdog.test.ts` | `weekly-review-watchdog.sh` | build_payload 结构、parse_result_response_file、review_doc_is_complete |

---

## 14. 版本与变更追溯

| 版本 | 日期 | 变更 | 作者 |
|------|------|------|------|
| v1.0-draft | 2026-05-20 | Scripts & Ops 深度 PRD 初稿 | supermatrix-root |
