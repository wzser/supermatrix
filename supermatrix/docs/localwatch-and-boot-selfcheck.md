# LocalWatch 与 SM 重启自检机制

> 单机本地守护与启动自检的实现说明。读完应能回答：
> - localwatch 是什么、怎么把 SM 拉起来、怎么救 SM。
> - SM 启动时跑了哪些自检、什么样的失败会让它直接退出、什么样的会降级继续。
> - 这两层是怎么咬合的：localwatch 何时介入、SM 自检何时让 launchd/localwatch 重拉。

更新于 2026-04-27。视觉版见 `docs/localwatch-architecture.html`（早期 HTML 图，名字仍叫 Local Watchdog，2026-04-22 之后内部一律叫 **localwatch**）。

---

## 1. 三层结构总览

```
macOS launchd  (com.supermatrix.localwatch.plist)
    │  KeepAlive=true, ThrottleInterval=30s, RunAtLoad=true
    ▼
terminal-launcher.sh
    │  osascript → 打开 Terminal.app → 在交互式终端里运行 localwatch
    │  存在的唯一目的：让 localwatch 跑在 Terminal session 里，
    │  这样 SM 启动后才能读到 macOS login keychain 里的 Claude OAuth 凭证。
    ▼
scripts/localwatch.sh
    │  单实例锁 + 接管旧实例 + 拉起被管进程 + 健康巡检 + 自愈派遣
    ├── SuperMatrix       (tsx src/cli/main.ts)         — 飞书消息入口
    ├── Scheduler         (node …scheduler/dist/main.js) — 定时任务
    └── business-screen   (node …business-screen/server.js, port 4322) — 局域网 HELLO 屏
```

> **为什么不能让 launchd 直接跑 SM？** Claude Code 的 OAuth token 存放在 macOS login keychain，只有交互式终端 session 能读。launchd 启动的脚本默认非交互式 → 取不到 token → SM 一启动就 401。所以 launchd 拉的是 `terminal-launcher.sh`，由它打开 Terminal.app 跑 localwatch，SM 是 Terminal 子孙进程，自然继承 keychain 访问权限。
> 这条记入了 memory `project_launchd_terminal_architecture`。

---

## 2. LocalWatch 机制

实现：`scripts/localwatch.sh`。这是 **被管进程的 supervisor**，负责把 SM/scheduler/business-screen 在本机长期跑稳；它不解析飞书消息，也不读写 SQLite，只看 PID 和 HTTP 健康端点。

### 2.1 单实例与接管（启动头几秒）

| 步骤 | 实现 | 作用 |
|------|------|------|
| 加锁 | `mkdir logs/.localwatch.lock`（atomic） | 同一时刻只允许一个 localwatch。这是 2026-04-17 两个守护互相 SIGTERM SM 的修复。 |
| 锁陈旧检测 | 锁里有上一任 PID，`kill -0` 探活；探不到就回收锁。 | 重启场景下不需要人工删锁。 |
| `takeover()` | `pgrep -f 'localwatch\.sh' / 'dev-loop\.sh' / 'tsx.*src/cli/main\.ts'`、business-screen 的旧 node。SIGTERM 2s → SIGKILL。 | 新 localwatch 启动时把上一任全杀干净，避免双胞胎。 |
| 清陈旧 PID 文件 | `rm -f $(dirname $SM_DB_PATH)/.bootstrap.pid` | 配合 SM 自检里的 `dual-instance` check，防止旧 PID 文件让新 SM 拒绝启动。 |

### 2.2 进程管理

每个被管对象都有一对函数：`start_X()` 拉起 + `handle_X_exit()` 处理退出。

**SuperMatrix（核心）：**
- 启动前主动 `pkill 'tsx.*src/cli/main\.ts'`、清陈旧 `.bootstrap.pid`。
- `tsx src/cli/main.ts` 后台启动，stdout → `logs/supermatrix.stdout.log`，stderr → `logs/sm-crash.log`。
- 退出处理：
  - `exit code=0`（一般是 sourceWatcher 触发的热重载）→ 1.5s 后直接重拉，不计入连续 crash。
  - 非 0：先抓 `sm-crash.log` 第一行 fatal/Error/SQLITE/Cannot find/EADDRINUSE 作为故障特征，然后：
    1. 调 `attempt_auto_repair "$current_fatal"`（见 2.4）。
    2. 累计连续相同 fatal；累计 ≥ `MAX_IDENTICAL_CRASHES=5` → 熔断（见 2.5）。
    3. uptime < 30s 视为快速崩溃，进入指数退避：2s→4s→…→封顶 60s；退避期间反复跑 `tsc --noEmit` 直到 typecheck 通过才重拉，避免把语法错误的代码循环跑。
    4. uptime ≥ 30s 视为正常运行后偶发崩溃，固定 1.5s 间隔重启、退避计数器清零。

**Scheduler / business-screen（旁路）：**
- 都先看 PM2：`pm2 jlist` 里如果已经有同名 online 任务，localwatch 让位（`*_pid=0`），不重复管。
- business-screen 启动前用 `lsof -nP -iTCP:$BUSINESS_SCREEN_PORT -sTCP:LISTEN` 清占口 PID（避免 EADDRINUSE）。
- 退出后固定 5s 重拉，无熔断、无回退（旁路服务挂了不影响主链路）。

### 2.3 健康巡检

主循环每 10s 一 tick，按 tick 取模分配巡检节奏：

| 频率 | tick 模 | 检查项 | 失败动作 |
|------|---------|--------|----------|
| 10s | 每 tick | `handle_*_exit`：被管 PID 是否还活着 | 走对应 handle 流程 |
| 30s | %3 | `check_process_alive`：仅 log warn | 不动手 |
| 3min | %18 | `/api/health`（SM）、`:3500/health`（scheduler）、`:4322/`（business-screen） | 连续 `HEALTH_FAIL_THRESHOLD=3` 次失败 → 飞书告警 + 强杀该进程让 handle_exit 重拉 |
| 5min | %30 | `reap_orphan_vitest`：清 ppid=1 且 `etime≥5min` 的 `node (vitest`)` 孤儿 worker | SIGTERM 2s → SIGKILL，并飞书告警提醒不要 `vitest \| tail/head/grep` |
| 30min | %180 | `check_lark_connectivity`：`lark-cli im +messages-send` 发心跳到 root group | 失败 → 写 log + macOS 通知（无重启动作，飞书坏了重启 SM 没用） |

> **超时硬性约束**：所有外部命令通过 `bounded <secs> <cmd>` 包裹（gtimeout/timeout/纯 bash 兜底），上限分别是 lark 10s、repair 60s、pm2/lsof 5s、typecheck 180s。这是 2026-04-22 SSH host-key 提示把 lark 心跳卡死的修复——任何返回 124 都是 bug，需要查根因。

### 2.4 自动修复派遣（auto-repair）

`attempt_auto_repair` 按 fatal 关键字派给 `scripts/repair/` 里的脚本，串行执行（受 `REPAIR_SCRIPT_TIMEOUT=60s` 限制）：

| Fatal 关键字 | 派遣脚本 | 修什么 |
|--------------|----------|--------|
| `duplicate column` | `scripts/repair/fix-migration-drift.sh` | schema_version 漂移：列已存在但 schema_version 没登记，回填记录 |
| `EADDRINUSE` | `scripts/repair/fix-port-in-use.sh` | 端口被旧进程占住，清掉占口 PID |
| `bootstrap.pid` / `dual.*instance` | `scripts/repair/fix-stale-pid.sh` | 陈旧 `.bootstrap.pid` 文件 |

修复脚本只在 SM 退出后的下一次启动前跑一次。修不了的话下次还会撞同样的 fatal，最终触发 2.5 的熔断。

### 2.5 熔断（circuit breaker）

`identical_count` 每见一次相同 fatal +1，触到 `MAX_IDENTICAL_CRASHES=5` 即：
- `send_alert`（先飞书 root group，失败回退 macOS 通知）发出告警，包含 fatal 摘要与"需要人工介入"。
- 设 `sm_stopped=true`，主循环不再重拉 SM，直到 localwatch 自身被重启。

scheduler / business-screen 没有熔断，因为它们不是单点。

### 2.6 关闭

收到 SIGINT/SIGTERM → `cleanup`：对三个被管 PID 各发 SIGTERM，再 `pkill -TERM` 兜底子孙 SM/business-screen，`wait`，退出。锁通过 `trap EXIT` 自动释放。

---

## 3. SM 重启自检机制（boot self-check）

实现：`src/app/bootSelfCheck/`，由 `src/cli/bootstrap.ts` 编排。它分 **pre-wiring** 与 **post-wiring** 两段，中间夹着 SqliteBindingStore.init() 这一硬门槛。

### 3.1 启动主链

```
bootstrap(env)
  │
  ├─[1] validateEnv(env)                    — Zod schema 校验环境变量
  │
  ├─[2] runChecks("pre-wiring", "execute", { cfg, logger, processLister }, [
  │       localDepsCheck,
  │       dualInstanceCheck,
  │       supervisorPresenceCheck,
  │       schedulerHealthCheck,
  │     ])
  │     hasFail(preResults) → renderStderrFailReport → process.exit(1)
  │
  ├─[3] new SqliteBindingStore(cfg.dbPath).init()       ◀━━ 单一硬门槛
  │       applyMigrations() 全部成功 → resetBusySessionsOnBoot()
  │
  ├─[4] runChecks("post-wiring", "execute", { …, store }, [
  │       reconcileBackendProcessesCheck,
  │     ])
  │     reconciler 自身抛错 → 回退 resetRunningMessageRunsOnBoot + warn
  │     hasFail(postResults) → exit(1)
  │
  ├─[5] cleanupStaleChildSessions / cleanupStuckBusyChildren
  │
  ├─[6] 装配组件：fs / clock / lark / eventBus / topicBus / backends /
  │       lifecycle / dispatcher / commandRouter / replier
  │
  └─[7] 启动服务：apiServer.listen / sourceWatcher.start /
        lark.start(dispatcher.handleInbound)   ◀━━ 飞书消息此刻才进来
```

任何一个 fail 都会 stderr 渲染 + `process.exit(1)`，由 localwatch 接住决定是否重拉。

### 3.2 Pre-wiring 检查（cheap、无 store 依赖）

| Check | 主要动作 | 失败语义 | 自愈 |
|-------|----------|----------|------|
| `local-deps` | `lark-cli --version`（2s 超时）、DB 目录与 workspace 可写、模板文件可读 | fail | lark-cli 主路径不可用时自动 `which lark-cli` 取 PATH 兜底，并把 `cfg.larkCliPath` 就地改写 → 返回 warn 而非 fail；DB 目录与 workspace 不存在时自动 `mkdir -p`。 |
| `dual-instance` | 读 `dirname($SM_DB_PATH)/.bootstrap.pid`，PID 还活且命令匹配 `tsx .*src/cli/main\.ts` 即认定双开；再用 `processLister.list({ cmdPattern })` 兜底（排除自身 pid 与 ppid，因 tsx 包装本身也会匹配）。两关都过才把自己的 PID 写入 PID 文件。 | fail | 无 |
| `supervisor-presence` | 顺着 ppid 链最多走 5 层，匹配 `dev-loop.sh` / `localwatch.sh` / `pm2` 任一即 ok；走到 ppid=1 且没匹配上 → warn（"可能是 launchd 也可能是孤儿"）；裸跑 → warn 提示崩溃后没人拉。 | warn-only | 无 |
| `scheduler-health` | 若 env 设了 `SM_SCHEDULER_HEALTH_URL` 就 fetch，2s 超时；返回非 ok → warn。env 没设直接 ok+skipped。 | warn-only | 无 |

> `runChecks` 是 **短路顺序执行**：见到第一个 fail 立刻停止后续 check 并返回。所以 pre-wiring 顺序很关键，先廉价、先公共依赖、最后耦合度高的。

### 3.3 SqliteBindingStore.init()

这是唯一的硬门槛——之前 2026-04-16 的故障就发生在这里：
- `applyMigrations()` 当时是 all-or-nothing 串行，旁路 migration 008（cross_session_log 加 `bitable_record_id`）撞到列已存在 → 整个 init 失败 → SM exit → localwatch 重拉 → 再失败 → 进入 13000+ 次 crash loop，飞书全黑。
- 修复后：migration runner 容错（duplicate column / table already exists 自动登记 schema_version 视为已应用）+ migrations 分 critical / optional 两遍跑（optional 失败 → degraded 列表 + warn，不抛）。`store.init()` 的返回值现在是 `{ degraded: [{ version, file, error }] }`，bootstrap 看到非空就把每条降级 log warn。
- 这层失败对应 localwatch 的 `duplicate column` 自愈派遣（见 2.4），由 `scripts/repair/fix-migration-drift.sh` 修复。

`resetBusySessionsOnBoot` 把上次进程异常退出时还在 busy 的 session 状态重置——这是给 reconciler 兜底的粗暴版本，正常路径下应该被 reconciler 取代。

### 3.4 Post-wiring 检查（store 已就绪）

| Check | 主要动作 | 失败语义 |
|-------|----------|----------|
| `reconcile-backend-processes` | 用 `processLister.list({ cmdPattern: /(claude\|codex)/, cwdPrefix: workspaceRoot, ppid: 1 })` 找出所有"父进程已死"的 backend 孤儿；对照 `findRunningMessageRuns()`：能匹配到存活进程的 run 保留并把 session 状态修回 busy；匹配不到的 run 标 timeout；剩下未被任何 run 引用的孤儿一律 SIGKILL。返回 warn（信息性）+ detail 列出操作明细。 | reconciler 自身抛错 → bootstrap 兜底回退到 `resetRunningMessageRunsOnBoot` 并把降级写进 announce |

reconciler 取代了原来粗暴的 "全部 running run 标 timeout" 逻辑，能保住跨重启仍然存活的 backend 进程（典型场景：SM 自己挂了但子 backend 还在跑）。

### 3.5 失败上报

`runChecks` 返回的 `CheckResult[]` 在 bootstrap 中合并为 `allBootResults`，传给启动公告（announce），把 warn/info 也展示到 root group 与 stderr，让运维一眼看到当次启动有没有降级。

---

## 4. 两层之间的咬合点

| 场景 | SM 自检反应 | localwatch 反应 | 期望结局 |
|------|-------------|-----------------|----------|
| `lark-cli` 主路径不存在但 PATH 有 | local-deps warn + 改 cfg.larkCliPath | 不参与 | SM 启动成功，announce 里有 warn |
| 数据库目录不可写 | local-deps fail | 接住 exit(1)，无匹配 repair → 进入退避；连续 5 次 → 熔断 + 飞书告警 | 人工介入 |
| 旁路 migration 列重复 | init() 抛 → bootstrap fail | `attempt_auto_repair` 派 `fix-migration-drift.sh`；下一次启动 init 通过 | 自愈，无人工 |
| core migration 失败 | init() 抛 → bootstrap fail | 无匹配 repair → 重试相同 fatal → 熔断 | 飞书告警 + 人工 |
| 端口占用 | 进 5 启动 apiServer 时 `EADDRINUSE` → bootstrap fatal | 派 `fix-port-in-use.sh` 杀占口 PID | 自愈 |
| 检测到双开 | dual-instance fail | 派 `fix-stale-pid.sh` 清陈旧 PID | 自愈 |
| 启动后 `/api/health` 连续 3 次不通 | — | check_sm_health → 飞书告警 + SIGTERM → handle_supermatrix_exit 重拉 | 自愈 |
| typecheck 失败导致快速崩溃 | bootstrap 还没跑就崩 | 退避循环里反复跑 `tsc --noEmit` 直到通过才重拉 | 等用户改完代码自动恢复 |
| 飞书侧不可达 | — | check_lark_connectivity → log + macOS 通知，**不重启 SM** | 等飞书自己恢复 |
| SM 干净 reload（exit 0） | — | 1.5s 重拉，不计 crash | 透明 |
| localwatch 自己挂了 | — | terminal-launcher 监测 `pgrep -f localwatch\.sh` 消失 → 退出 → launchd 重新拉 terminal-launcher → 重新打开 Terminal 跑 localwatch | 自愈 |
| terminal-launcher 自己挂了 | — | launchd KeepAlive=true / ThrottleInterval=30s 重拉 | 自愈 |

> **熔断的边界**：localwatch 的熔断只覆盖 SM。scheduler / business-screen 没有熔断（认定它们是无状态旁路）。SM 熔断后 localwatch 继续活着、继续巡检 scheduler / business-screen，等人工 `kill localwatch.sh` 让 launchd 重拉。

---

## 5. 运维一页纸（Operator Runbook）

```
# 看 localwatch 自己有没有跑
pgrep -fl localwatch\.sh

# 看 launchd 状态
launchctl list | grep com.supermatrix.localwatch

# 看 SM 当前活着的 PID
pgrep -fl 'tsx.*src/cli/main\.ts'

# 实时跟踪
tail -f logs/localwatch.log logs/supermatrix.stdout.log logs/sm-crash.log

# 主动重启 SM（让 handle_exit 接住）
pkill -TERM -f 'tsx.*src/cli/main\.ts'

# 主动重启 localwatch（terminal-launcher 会监测并退出，launchd 接力重拉）
pkill -TERM -f 'localwatch\.sh'

# 完全停掉（启动也不会自动恢复）
launchctl unload ~/Library/LaunchAgents/com.supermatrix.localwatch.plist

# 重新装载
launchctl load ~/Library/LaunchAgents/com.supermatrix.localwatch.plist

# 看本轮启动 announce 是否有 warn / 降级
# 在 root 群直接看 SM 上线消息；或：
grep -E 'check|degraded|warn' logs/supermatrix.stdout.log | tail -50
```

熔断后的恢复：
1. 看 `logs/sm-crash.log` 最后那条 fatal。
2. 决定是改代码还是跑 `scripts/repair/` 里的相应脚本。
3. `pkill -TERM -f 'localwatch\.sh'`，让 launchd 重拉一次干净的 localwatch（会清掉 `sm_stopped` 状态并重跑 takeover）。

---

## 6. 关键源码索引

| 关注点 | 文件 |
|--------|------|
| launchd plist template | `scripts/launchd/com.supermatrix.localwatch.plist` |
| launchd → Terminal.app 桥 | `scripts/launchd/terminal-launcher.sh` |
| supervisor 主体 | `scripts/localwatch.sh` |
| 自愈脚本 | `scripts/repair/fix-migration-drift.sh` / `fix-port-in-use.sh` / `fix-stale-pid.sh` |
| 自检框架 | `src/app/bootSelfCheck/index.ts` `types.ts` `formatReport.ts` |
| 自检条目 | `src/app/bootSelfCheck/checks/{localDeps,dualInstance,supervisorPresence,schedulerHealth,reconcileBackendProcesses}.ts` |
| 启动编排 | `src/cli/bootstrap.ts` |
| Migration runner | `src/adapters/store-sqlite/migrations.ts` `migrations/` |
| SMOKE 验证清单 | `docs/SMOKE.md` |
| 故障溯源 | `docs/reviews/`（含 2026-04-16 boot-fault-isolation-analysis、2026-04-22 bug-audit-report 等） |

---

## 7. 不变量（破坏后需要重新审视本文档）

- **localwatch 是 SM 的唯一本地 supervisor**——不再用 `dev-loop.sh`（保留只为兼容旧 ps 路径）。supervisor-presence check 仍接受 dev-loop 是为了灰度过渡，长期会移除。
- **SM 主进程必须跑在 Terminal.app 子孙下**——keychain 访问的硬约束，改动 launchd 链路前先想清楚 keychain。
- **SqliteBindingStore.init() 是 boot 的唯一硬门槛**——其他 check 失败要么是 fail 要么是 warn，永远不在这一层之外悄悄阻塞启动。
- **核心 vs 旁路 migration 分层**——加新 migration 时若属于旁路功能（bitable sync、可观测性等），必须显式标 optional；否则整个系统会被旁路 schema drift 击垮。
- **任何外部命令必须经 `bounded` 包裹**——localwatch 主循环不允许出现没超时的 `lark-cli` / `pm2` / `lsof` / `curl` / `tsc`。
