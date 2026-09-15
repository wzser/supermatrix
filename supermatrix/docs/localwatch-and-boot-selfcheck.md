# LocalWatch 与 SM 重启自检机制

> 单机本地守护与启动自检的实现说明。读完应能回答：
> - localwatch 是什么、怎么把 SM 拉起来、怎么救 SM。
> - SM 启动时跑了哪些自检、什么样的失败会让它直接退出、什么样的会降级继续。
> - 这两层是怎么咬合的：localwatch 何时介入、SM 自检何时让 launchd/localwatch 重拉。

更新于 2026-08-03。视觉版见 `docs/localwatch-architecture.html`（早期 HTML 图，名字仍叫 Local Watchdog，2026-04-22 之后内部一律叫 **localwatch**）。

---

## 1. 三层结构总览

```
macOS launchd  (com.LOCAL_USER.localwatch.plist)
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
    ├── business-screen   (node …business-screen/server.js, port 4322) — 局域网 HELLO 屏
    └── business-screen EVA (node …business-screen/server-eva.js, port 4323) — EVA 主题 fork 看板
```

> **为什么不能让 launchd 直接跑 SM？** Claude Code 的 OAuth token 存放在 macOS login keychain，只有交互式终端 session 能读。launchd 启动的脚本默认非交互式 → 取不到 token → SM 一启动就 401。所以 launchd 拉的是 `terminal-launcher.sh`，由它打开 Terminal.app 跑 localwatch，SM 是 Terminal 子孙进程，自然继承 keychain 访问权限。
> 这条记入了 memory `project_launchd_terminal_architecture`。

---

## 2. LocalWatch 机制

实现：`scripts/localwatch.sh`。这是 **被管进程的 supervisor**，负责把 SM/scheduler/business-screen 及 EVA fork 看板在本机长期跑稳；它不解析飞书消息，也不读写 SQLite，只看 PID 和 HTTP 健康端点。

### 2.1 单实例与无损接班（启动头几秒）

| 步骤 | 实现 | 作用 |
|------|------|------|
| 加锁 | `mkdir logs/.localwatch.lock`（atomic），先进入本仓 canonical cwd，再发布 PID/repo/script/cwd/process-start/boot-id/capability 与 `provenance.json` | 同一时刻只允许一个 localwatch；启动者不会只凭 `kill -0` 信任旧锁，而会核验本仓精确命令/cwd/start/完整 metadata。陈旧或复用 PID 的锁仅在没有任何同名 localwatch 存活时回收。 |
| 锁陈旧检测 | 锁里有上一任 PID 时，复核本仓精确命令/cwd、进程启动时刻与 pidfile mtime；身份不一致才回收锁。 | PID 复用或其他 worktree 的进程不能冒充当前 localwatch；回收锁本身不发信号。 |
| `adopt_existing_supermatrix()` | 只盘点 cwd 等于本仓、命令参数精确指向本仓 `node_modules/.bin/tsx` 与 `src/cli/main.ts` 的 launcher；一个既有 SM 则收养，多个或本仓 legacy dev-loop 则 fail-closed。 | localwatch 重启不再连带重启健康的 SM，也不会误收养其他 worktree 或用 TERM/KILL 抢占。 |
| 启动前双实例检查 | `start_supermatrix()` 发现既有 SM 时拒绝启动并告警。 | 防止竞态创建第二个 SM；不再用清 PID/杀进程掩盖拓扑异常。 |

### 2.2 进程管理

每个被管对象都有一对函数：`start_X()` 拉起 + `handle_X_exit()` 处理退出。

**SuperMatrix（核心）：**
- successor localwatch 若只发现一个既有 SM，会保留其 PID 并继续监督；发现多个则停止启动、交由 codexroot。
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
- scheduler-v2、card-ask、business-screen 与 session-architecture 启动前都先读取端口 listener；只有“单一 PID + 精确 node entry + 精确 cwd + 预期健康响应”同时成立才无损收养。任何未知/多 PID/不健康占口都只告警并拒绝启动，不发送 TERM/KILL。
- 被管 PID 启动或收养时记录进程启动时刻；健康阈值与 memory guard 的局部自愈在 TERM 前核验 command/cwd/start，TERM 后若仍存活则在 KILL 前再次核验。PID 被复用或身份漂移时 fail-closed，转 codexroot。
- 两个看板退出后固定 5s 重拉，无熔断、无回退（旁路服务挂了不影响主链路）。

### 2.3 健康巡检

主循环每 10s 一 tick，按 tick 取模分配巡检节奏：

| 频率 | tick 模 | 检查项 | 失败动作 |
|------|---------|--------|----------|
| 10s | 每 tick | `handle_*_exit`：被管 PID 是否还活着 | 走对应 handle 流程 |
| 30s | %3 | `check_process_alive`：仅 log warn | 不动手 |
| 30s | %3 | `localwatch-managed-services.ts check`：热读受管 macOS 服务注册表、进程和 loopback TCP probe | 由受限 repair policy 处理；异常写 log / 心跳群 |
| 3min | %18 | `/api/health`（SM）、`:3502/health`（scheduler-v2）、`:8787/health`（card-ask）、`:4322/`（business-screen）、`:4323/`（session architecture） | SM 只告警；旁路组件连续 `HEALTH_FAIL_THRESHOLD=3` 次失败时仅在精确身份复核通过后局部重启，否则拒绝发信号并转 codexroot |
| 5min | %30 | `report_orphan_vitest`：盘点 ppid=1 且 `etime≥5min` 的 `node (vitest`)` 疑似孤儿 worker | 只报告 PID，不发信号；交由 codexroot 核对进程 owner |
| 30min | %180 | `check_lark_connectivity`：`lark-cli im +messages-send` 发心跳到 `LOCALWATCH_HEARTBEAT_GROUP` | 失败 → 写 log + macOS 通知（无重启动作，飞书坏了重启 SM 没用） |

> **超时硬性约束**：所有外部命令通过 `bounded <secs> <cmd>` 包裹（gtimeout/timeout/纯 bash 兜底），上限分别是 lark 10s、repair 60s、pm2/lsof 5s、typecheck 180s。这是 2026-04-22 SSH host-key 提示把 lark 心跳卡死的修复——任何返回 124 都是 bug，需要查根因。

### 2.3.1 热加载受管 macOS 服务注册表

`scripts/localwatch-managed-services.ts` 是 localwatch 的唯一 managed-app helper。每个 30s tick 由 `scripts/localwatch.sh` 调一次 `check`，所以新增、禁用或调整条目只需改配置，无需改脚本或重启 localwatch。默认路径可由环境变量覆盖：

| 用途 | 默认路径 | 环境变量 |
|------|----------|----------|
| 注册表 | `/Users/LOCAL_USER/SuperMatrixRuntime/config/localwatch-services.json` | `LOCALWATCH_MANAGED_SERVICES_CONFIG` |
| 持久状态 | `/Users/LOCAL_USER/SuperMatrixRuntime/data/localwatch-managed-services.state.json` | `LOCALWATCH_MANAGED_SERVICES_STATE` |

仓内受版本控制的首份模板为 `templates/localwatch-services.json`；live 文件由部署/本次接入创建。helper 的 stdout 始终是一行 structured JSON，包含每项 probe、连续失败计数、动作、异常列表和恢复事件。

注册表是 strict schema：每项必须有 `id`、`label`、`enabled`、`probes.primaryProcess`、`probes.requiredProcesses`、`probes.tcp`、`launch.kind="macos-app"`、`launch.bundleId`、`repairPolicy`、`failureThreshold`、`cooldownSec`、`startupGraceSec`。`primaryProcess` 是绝对 executable path；`requiredProcesses` 是零到三个额外的绝对 executable path。helper 逐行检查 `ps -axo command=` 的命令开头是否正好是该 executable path（或后接空白参数），不会把 prompt/参数中的 path 当作存活进程。`tcp.host` 固定为 `127.0.0.1`；`launch` 只允许经固定参数 `open -g -b <bundleId>` 启动。没有 `command`、shell、路径脚本或任意参数入口。JSON/schema 非法时 helper fail closed、不执行外部动作；同一已持久化的 config error 只通知一次，错误内容改变才再通知，恢复有效注册表后清除该状态。

初始注册项：

| id | 进程 / TCP | launch / policy | 阈值与节流 |
|----|------------|-----------------|------------|
| `clash-verge` | primary `/Applications/Clash Verge.app/Contents/MacOS/clash-verge` + required `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`；`127.0.0.1:7897` | `io.github.clash-verge-rev.clash-verge-rev`；`relaunch-on-unhealthy` | 2 次连续失败；120s cooldown；30s startup grace |
| `ziniao` | primary `/Applications/ziniao.app/Contents/MacOS/ziniao` + no required child；`127.0.0.1:9481` | `com.ziniao.fzzixun`；`launch-if-absent` | 2 次告警阈值；120s cooldown；30s startup grace |

只有 primary executable 明确缺失时，不等待 failure threshold 就请求 `open`，但已有 startup grace/cooldown 仍抑制重复拉起。primary 仍在而 required child 或 TCP 失败时按 failure threshold 计数；Clash 到第 2 次才走 bounded `osascript` 优雅退出 → 确认 primary 与全部 tracked executable 都已退出 → `open -g`，未确认退出绝不继续 `open`。紫鸟 primary 仍在而 9481 bridge 失败时只告警，不关闭店铺窗口，也不调用 ZClaw 业务接口。`open` 返回 0 只表示请求发出：状态保留为 `starting`，只有之后 process 和 TCP 都实际恢复才产出 `recovered`。首次全绿仅建立 baseline，不产生 `recovered`。

state 以临时文件 `fsync` 后 rename 原子写入，保存连续失败、cooldown、startup grace、最后状态、最后动作与实际恢复时间。helper 内的 `ps` / `osascript` / `open` 和 TCP probe 各有 3–5s 上限，外层 localwatch 调用也有 20s `bounded` 上限。执行 repair 前先落 cooldown 状态；无法持久化时不执行 repair，以免 launch storm。failure threshold、launch attempt、config/state error 与 recovered 都会写 `logs/localwatch.log` 并发送到 `LOCALWATCH_HEARTBEAT_GROUP`。当前异常服务还会并入 `check_lark_connectivity` 的异常组件列表，不能被“一切正常”掩盖。

### 2.4 自动修复派遣（auto-repair）

`attempt_auto_repair` 按 fatal 关键字派给 `scripts/repair/` 里的脚本，串行执行（受 `REPAIR_SCRIPT_TIMEOUT=60s` 限制）：

| Fatal 关键字 | 派遣脚本 | 修什么 |
|--------------|----------|--------|
| `duplicate column` | `scripts/repair/fix-migration-drift.sh` | schema_version 漂移：列已存在但 schema_version 没登记，回填记录 |
| `EADDRINUSE` | `scripts/repair/fix-port-in-use.sh` | 只报告精确占口 PID 并 fail-closed；不再自动杀进程 |
| `bootstrap.pid` / `dual.*instance` | `scripts/repair/fix-stale-pid.sh` | 陈旧 `.bootstrap.pid` 文件 |

修复脚本只在 SM 退出后的下一次启动前跑一次。修不了的话下次还会撞同样的 fatal，最终触发 2.5 的熔断。

### 2.5 熔断（circuit breaker）

`identical_count` 每见一次相同 fatal +1，触到 `MAX_IDENTICAL_CRASHES=5` 即：
- `send_alert`（先飞书 root group，失败回退 macOS 通知）发出告警，包含 fatal 摘要与"需要人工介入"。
- 设 `sm_stopped=true`，主循环不再重拉 SM，直到 localwatch 自身被重启。

scheduler / business-screen 没有熔断，因为它们不是单点。

### 2.6 关闭

收到 SIGINT/SIGTERM 时先消费 codexroot gate 写入、同时绑定当前 PID 与随机 boot-id、两分钟内有效的一次性 permit。没有 permit 就告警并继续运行；有 `restart-localwatch` permit 才退出，而且保留 SM/scheduler/business-screen 等子进程，由 successor localwatch 收养。routine stop 永不放行。锁通过 `trap EXIT` 自动释放。

### 2.7 codexroot maintenance gate

> **平台生命周期红线：**任何 session 都不得私自对 SuperMatrix 或 localwatch 执行 `kill -9` / `SIGKILL`、`pkill`、`launchctl stop/kickstart`，也不得复制代码中的局部 backend/组件超时升级逻辑来实现平台重启。统一通过 `spawn2.0 target=codexroot` 提交，由 codexroot 执行 maintenance gate。Legacy localwatch 缺少 capability 或 lock PID 已失效时，不能从同名脚本推断身份；migration bridge 只审计并 fail-closed，保留人工重启边界。

唯一入口是 `scripts/platform-maintenance-gate.sh`。它用当前 run 的 `SM_CALLER_ATTESTATION` 通过 `/api/caller-identity` 解析 owner，只有 `ownerSessionName=codexroot` 才继续，并把 allow/deny/completed 追加到 runtime data 下的 `platform-maintenance-audit.jsonl`。这是同 UID 下的策略与误操作闸门，不是不可伪造的 OS 鉴权。

reload executor 会在任何 dedup/dispatch 前，把当前 run 的 `SM_CALLER_ATTESTATION` 再交给 live `/api/caller-identity` 解析，并要求 owner=codexroot 且 session ID 精确一致；只伪造环境 approval 会直接拒绝。随后才生成随机、两分钟有效、按文件名寻址的一次性 permit；permit 带同一个 attestation token，`/reload` handler 原子 claim 后由运行中的 registry 再解析一次，并校验 source、force、codexroot owner、caller session 与精确 `messageRunId`。lifecycle 只排除这个 run；同一 child session 的第二个 run 仍会阻断。只写 `--source`、复制旧命令、伪造 actor 或重放 permit 都会在读取 session/触发 lifecycle 前被拒绝。

- `reload-supermatrix --source scheduled-daily`：只接受 task `c79b09c8-138a-4fd8-9377-ed93986b5e9f`、03:45–04:10、非 force、除当前 gate child 外 busy=0、24h 未执行；caller child 还必须能读回 pending scheduler→codexroot comm，且 `origin_run_id=scheduler:<精确 task id>:<run id>`。scheduler 只能点火 codexroot，不能直接跑脚本。命令到达 handler 时会再次检查 busy/inFlight，发现竞态就消费 permit 后直接拒绝，不登记 pending reload。
- `reload-supermatrix --source codexroot-maintenance`：必须有单行原因；安全 reload 遇到其他 busy 直接 skip，dispatch 后新起的 busy/inFlight 同样由 handler 拒绝且不留 pending。force 还必须显式带 `--emergency`，仅用于平台级不可用、数据损坏或安全隔离，影响 session 会进入审计。
- `restart-localwatch`：仅用于 localwatch 自身代码/plist/监督机制变更或已失效；要求其他 busy=0，并把旧/新 PID 都核验为本仓精确脚本命令、cwd、进程启动时刻与随机 boot-id；一次性 permit 同时绑定 PID+boot-id，发布 permit 后、发 signal 前还会立即重复核验，最后读回 SuperMatrix health。
- `stop-localwatch`：routine 永不放行。机器关机、卸载和明确事故隔离属于单独 OS 运维流程。
- `activate-localwatch-gate`：仅精确凌晨 task/时间窗可用的有界 rollout 检查。已有 capability 且完整 provenance 时只读回 no-op；legacy lock、stale PID 或同名存活进程无法建立身份链时写入 audit 并拒绝，不发送 signal、不等待 successor，保留人工重启边界。

单 backend、单 session、模型、认证或网络故障都不构成全局 reload 理由；localwatch crash recovery、launchd 保活和旁路组件局部自愈仍保留。

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
| `supervisor-presence` | 顺着 ppid 链最多走 5 层；`localwatch.sh` / `pm2` 为 ok，`dev-loop.sh` 明确 warn 为已退役；走到 ppid=1 或裸跑同样 warn。 | warn-only | 无 |
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
| 端口占用 | 进 5 启动 apiServer 时 `EADDRINUSE` → bootstrap fatal | `fix-port-in-use.sh` 只报告 PID；不杀进程 | 熔断后交 codexroot 裁决 |
| 检测到双开 | dual-instance fail | 派 `fix-stale-pid.sh` 清陈旧 PID | 自愈 |
| 启动后 `/api/health` 连续 3 次不通 | — | check_sm_health 只告警并转 codexroot；不发信号 | 保持现场，等待裁决 |
| typecheck 失败导致快速崩溃 | bootstrap 还没跑就崩 | 退避循环里反复跑 `tsc --noEmit` 直到通过才重拉 | 等用户改完代码自动恢复 |
| 飞书侧不可达 | — | check_lark_connectivity → log + macOS 通知，**不重启 SM** | 等飞书自己恢复 |
| SM 干净 reload（exit 0） | — | 1.5s 重拉，不计 crash | 透明 |
| localwatch 自己挂了 | — | terminal-launcher 按 lock PID + 本仓精确脚本命令/cwd 判定消失 → 退出 → launchd 重新拉 terminal-launcher → 重新打开 Terminal 跑 localwatch | 自愈，且不受其他 worktree 的同名进程干扰 |
| terminal-launcher 自己挂了 | — | launchd KeepAlive=true / ThrottleInterval=30s 重拉 | 自愈 |

> **熔断的边界**：localwatch 的熔断只覆盖 SM。scheduler / business-screen 没有熔断（认定它们是无状态旁路）。SM 熔断后 localwatch 继续活着、继续巡检旁路；恢复申请交给 codexroot maintenance gate。

---

## 5. 运维一页纸（Operator Runbook）

```
# 看 localwatch 自己有没有跑
pgrep -fl localwatch\.sh

# 看 launchd 状态
launchctl list | grep com.LOCAL_USER.localwatch

# 看 SM 当前活着的 PID
pgrep -fl 'tsx.*src/cli/main\.ts'

# 实时跟踪
tail -f logs/localwatch.log logs/supermatrix.stdout.log logs/sm-crash.log

# 申请重启 SM / localwatch
# 从当前 codexroot run 执行；其他 session 先通过 spawn2.0 target=codexroot 提交申请。
./scripts/platform-maintenance-gate.sh reload-supermatrix --source codexroot-maintenance --reason '<必要性与影响>'
./scripts/platform-maintenance-gate.sh restart-localwatch --reason '<仅限 localwatch 自身变更或失效>'

# routine stop-localwatch 不放行；机器关机、卸载、事故隔离属于独立 OS 运维流程。

# 看本轮启动 announce 是否有 warn / 降级
# 在 root 群直接看 SM 上线消息；或：
grep -E 'check|degraded|warn' logs/supermatrix.stdout.log | tail -50
```

熔断后的恢复：
1. 看 `logs/sm-crash.log` 最后那条 fatal。
2. 决定是改代码还是跑 `scripts/repair/` 里的相应脚本。
3. 由 codexroot 执行 `platform-maintenance-gate.sh restart-localwatch --reason '<熔断恢复证据>'`；gate 校验 busy=0、精确 PID、一次性 permit、新 PID 与 SM health readback。

---

## 6. 关键源码索引

| 关注点 | 文件 |
|--------|------|
| launchd plist | `scripts/launchd/com.LOCAL_USER.localwatch.plist` |
| launchd → Terminal.app 桥 | `scripts/launchd/terminal-launcher.sh` |
| supervisor 主体 | `scripts/localwatch.sh` |
| managed-app helper / 模板 | `scripts/localwatch-managed-services.ts` / `templates/localwatch-services.json` |
| 自愈脚本 | `scripts/repair/fix-migration-drift.sh` / `fix-port-in-use.sh` / `fix-stale-pid.sh` |
| 自检框架 | `src/app/bootSelfCheck/index.ts` `types.ts` `formatReport.ts` |
| 自检条目 | `src/app/bootSelfCheck/checks/{localDeps,dualInstance,supervisorPresence,schedulerHealth,reconcileBackendProcesses}.ts` |
| 启动编排 | `src/cli/bootstrap.ts` |
| Migration runner | `src/adapters/store-sqlite/migrations.ts` `migrations/` |
| SMOKE 验证清单 | `docs/SMOKE.md` |
| 故障溯源 | `docs/reviews/`（含 2026-04-16 boot-fault-isolation-analysis、2026-04-22 bug-audit-report 等） |

---

## 7. 不变量（破坏后需要重新审视本文档）

- **localwatch 是 SM 的唯一本地 supervisor**——`dev-loop.sh` 与 direct-SM launchd 脚本均为 fail-closed 退役 stub。
- **主动生命周期操作只走 codexroot gate**——直接 `/reload`、伪造 `--source`、重放 permit、TERM/INT、takeover、未知端口清理和 routine stop 都拒绝；全局 Lark/vitest 扫描只报告，不再跨 session 发信号。LocalWatch 对旁路组件的局部自愈必须绑定并即时复核 command/cwd/process-start，同 UID 下的恶意 `SIGKILL` 仍需后续 OS 身份隔离才能硬阻断。
- **SM 主进程必须跑在 Terminal.app 子孙下**——keychain 访问的硬约束，改动 launchd 链路前先想清楚 keychain。
- **SqliteBindingStore.init() 是 boot 的唯一硬门槛**——其他 check 失败要么是 fail 要么是 warn，永远不在这一层之外悄悄阻塞启动。
- **核心 vs 旁路 migration 分层**——加新 migration 时若属于旁路功能（bitable sync、可观测性等），必须显式标 optional；否则整个系统会被旁路 schema drift 击垮。
- **任何外部命令必须经 `bounded` 包裹**——localwatch 主循环不允许出现没超时的 `lark-cli` / `pm2` / `lsof` / `curl` / `tsc`。
- **managed-app 配置不携带可执行命令**——只能声明受限 process / loopback TCP / macOS bundle；helper 绝不把配置字段交给 shell。
