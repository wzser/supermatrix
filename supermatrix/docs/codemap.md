# Codemap 勘察档案

> **更新日期：2026-09-09**（增量更新）。本轮范围：**Todo #505** —— 新建工作区默认落移动硬盘 `sm-c`、挂载前置校验 fail-closed、旧根留兼容 symlink、rollback 双端清理、孤儿回收多前缀。非全仓覆盖。
> 方案：`workspaces/tobedone/artifacts/todo-pipeline/runs/505/attachments/方案-505-v1.md`（与同目录 `proposal.md` 内容逐字一致，两份是同一文件的两个副本）。
> 上一版档案（2026-08-04，范围为 `/now` Live Steer）与本目标无关，**原文保留在 附录 A**，本轮未重新核验其行号。
> 勘察分支：`lgs/todo-505`，与 `main` **零差异**；仓内 `grep -rn "505\|SM_NEW_WORKSPACE_ROOT\|provisioningRoot" src tests scripts docs` 除本档案外零命中 —— **无半成品，从零实现**。

一句话目标：把 `SM_WORKSPACE_ROOT` 一物二用（(a) 新工作区在哪建 / (b) 共享资产与前缀守卫的基准根）拆开，(a) 迁到独立的 provisioning root，实体落 sm-c、旧根留 symlink、盘没挂显式中止，并修好已经发生的孤儿回收漏检。

---

## 1. 相关现有能力清单（谁已经在做类似的事）

### 1.1 provisioning 主链（唯一改点所在）

- `src/app/sessionLifecycle.ts:224` `create()` — **全仓唯一的新工作区创建入口**，无第二处。关键行：
  - `:233` `useExistingWorkdir = Boolean(input.workdir)`（`/clone` 与 `/new --workdir` 走这一支，不经默认路径）
  - `:234` `const workdir = input.workdir ?? asAbsolutePath("${deps.workspaceRoot}/${input.name}")`（原文为模板字符串）— 默认路径唯一来源
  - `:236-246` `runRollback` — **reverse 执行的回滚栈**，每步独立 try/catch
  - `:253-262` 新建分支：`exists` 预检 → `mkdir` → `rollback.push(rmrf)` → `gitInit` → 拷 `.gitignore` → 首个 commit
  - `:272` `lark.createGroup`（失败点必须排在它之前，才满足「群未被创建」验收）
  - `:309` `// Past the rollback cliff` — 此后不再回滚
- `src/app/sessionLifecycle.ts:214` `ensureCatalogSymlink()` — **现成的「幂等建 symlink」范式**：先 `exists(link)` 再 `fs.symlink`，已存在返回 `null`。新的旧根兼容链接照抄这个形状即可。
- `src/app/sessionLifecycle.ts:344-366` SOP 目录初始化 —— 内含第三处 symlink 用法，指向 `${deps.workspaceRoot}/first-principle/templates/sop-template.md`。**这里的 workspaceRoot 是「共享资产根」语义，本轮绝不能替换成 provisioning root**（注释 `:353-357` 已记录过一次同类踩坑：`workspaces/workspaces/...` 悬空链接）。
- `src/app/sessionLifecycle.ts:34-60` `SessionLifecycleDeps` — 新增 `provisioningRoot?` / `assertProvisioningRootReady?` 的落点；现有可选依赖（`idFactory?`、`cancelBackend?`、`eventBus?`、`requestSchedulerCleanup?`）已确立「可选 dep 缺省即旧行为」的写法。
- `src/app/sessionLifecycle.ts:86` — app 层**直读 `process.env.SM_WORKSPACE_ROOT`** 拼 `sync-session-table.sh` 路径（既有先例，说明 app 层碰 env 不是新鲜事）。
- `src/app/commands/newSession.ts:132` `createNewHandler`（`/new`，root scope；`:156` `--workdir` 显式路径）、`:73` `cloneSession`（`workdir: source.workdir` → 复用既有目录）、`:110` `createCloneHandler`。三条路径共用同一个 `lifecycle.create`，**只有 `/new <backend> <name>` 无 `--workdir` 时才走默认路径分支**。
- `src/app/commandRouter.ts:34` — `UserError → "❌ " + message` 是**中文错误回飞书的唯一通道**；`SystemError` 会被吞成「内部错误，请查看 console 日志」。挂载校验必须抛 `UserError`，否则验收要求的「含『未挂载』字样」文案到不了群里。

### 1.2 文件系统 port / adapter

- `src/ports/WorkspaceFs.ts` — `exists / mkdir / rmrf / readFile / writeFile / copyFile / **symlink**(:10) / listDir / gitInit / gitCommit`。**symlink 已在契约里，本轮无需扩 port。**
- `src/adapters/workspace-node/index.ts` — `:22 exists`（`access()`，**跟随 symlink**）、`:31 mkdir`（`recursive:true`）、`:35 rmrf`（`rm{recursive,force}`，对 symlink 只删链接）、`:51 symlink`（裸 `fs.symlink`，目标已存在会抛 `EEXIST`）。

### 1.3 环境装配 / 配置

- `src/cli/bootstrap.ts:324` `envSchema`、`:342` `validateEnv`、`:138` `AppConfig` —— **可选 env 三段式**的样板是 `SM_MENTION_REGISTRY_PATH`（`:339` schema / `:359` 透传 / `:154` 字段 / `:377` 带默认值的派生）。
- `src/cli/bootstrap.ts:646-675` `createSessionLifecycle({...})` 装配点；`:651-661` 由 `cfg.workspaceRoot` 派生的四个**共享资产**路径（workspaceRoot / catalogPath / principlesTemplatesDir / claude·agents md 模板）—— 本轮全部保持指向旧根。
- 另外三处 `cfg.workspaceRoot` 派生：`:609` 附件落盘目录、`:890` 与 `:1236` heartbeat 脚本路径。
- `.env.local` 在**主 checkout** `/Users/LOCAL_USER/SuperMatrix/.env.local`（第 4 行 `SM_WORKSPACE_ROOT=/Users/LOCAL_USER/SuperMatrixRuntime/workspaces`），不在本 worktree 内。四个脚本各自 `set -a; source` 它：`scripts/localwatch.sh:27,190`、`scripts/safe-reload.sh:44,51`、`scripts/platform-maintenance-gate.sh:17,27`、`scripts/setup-dogfood-session.sh:27` —— **新增一个 env 不需要改任何脚本**。

### 1.4 孤儿回收链（已破，方案改动 3 的对象）

- `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:34-38` — 单次 `ctx.processLister.list({ cmdPattern, cwdPrefix: ctx.cfg.workspaceRoot, ppid: 1 })`。
- `src/adapters/process-lister-ps/index.ts:42-44` — `cwd = await getCwd(pid)`，`if (!cwd || !cwd.startsWith(filter.cwdPrefix)) continue`；`:92-102` `getCwd` = `lsof -a -p <pid> -d cwd -Fn`，**内核返回的是物理路径**。
- 因果链闭合（本轮实勘补齐）：三个 backend adapter 都用 `session.workdir` 当子进程 cwd —— `backend-claude/index.ts:83`、`backend-codex/index.ts:171`、`backend-kimi/index.ts:217,226`。DB 里存的是旧根 symlink 路径，内核把 cwd 解析成 `/Volumes/EXAMPLE_VOLUME/...`，`startsWith("/Users/LOCAL_USER/workspaces")` 恒 false → **已迁移工作区里的孤儿 claude/codex/kimi 永远扫不出来**。
- `src/ports/processLister.ts:10-14` `ListFilter` 只有单个 `cwdPrefix?: string`。方案选择不改 port、改为多次 list 后按 pid 合并。
- `src/app/bootSelfCheck/types.ts:18-22` `BootCheckConfig = { larkCliPath, dbPath, workspaceRoot }` —— 注释明说「比 AppConfig 窄，靠结构化类型兼容」。
- `src/cli/selfCheck.ts:90-91` `runFullSelfCheck` 自己 `validateEnv(process.env)` 造 cfg；`:138-143` `createCliUpgradeContext` **手工字面量**造 cfg（`workspaceRoot: process.env["SM_WORKSPACE_ROOT"] ?? process.cwd()`）。**这两处是方案没写、但验收判据依赖的同步点**（见 §6）。

### 1.5 既有路径守卫 / 消费方（本轮多数不改，但要知道它们在）

- `src/cli/apiServer.ts:290-307` `linkedGitIdentity` + `:310` `resolveLinkedSpawnWorkdir` —— 双端 `realpath`，**对 symlink 天然免疫，确认无需改动**（勘察复核了方案结论）。
- `src/app/spawnPredicate/lint.ts:18` `DEFAULT_PATH_ALLOWLIST=["/Users/LOCAL_USER/SuperMatrix"]`、`:29-38` `resolvePathAllowlist`（读 `SM_WORKSPACE_ROOT` + `SM_WATCHER_PATH_ALLOWLIST`，用 `resolve()` **不解 symlink**）。物理路径写法会被拒、旧根写法放行 —— 方案可选 9，本轮不做。
- `src/app/bootSelfCheck/checks/localDeps.ts:51-52` 只探 `cfg.workspaceRoot` 可写；`:121-133` `ensureWritableDir`（`access(W_OK)` → `mkdir -p` → 再 `access`）**是现成的可写性探针**。
- `scripts/migrate-to-session-catalog.ts:99` `isUnderRoot(s.workdir, workspaceRoot)` —— 又一处以旧根为前缀的判据（一次性脚本；DB 存旧根路径时仍成立，这正是方案选「DB 存 symlink 路径」的收益）。
- `scripts/regenerate-catalog.ts:38`、`scripts/migrate-to-session-catalog.ts:53` —— 独立 `requireEnv("SM_WORKSPACE_ROOT")`。

### 1.6 测试基建

- `tests/app/sessionLifecycle.create.test.ts`（242 行）：`:14 mkDeps`（`workspaceRoot=/ws`、模板放 `/tpl/*`）、`:50` 单一 describe、13 个用例。已有的直接相关用例：`:89` happy path（断言 `fs.dirs.has("/ws/foo")` + catalog symlink）、`:199` `createGroup failure rolls back workdir creation`（**现成的 rollback 断言模板**）、`:207` 「commit 只 stage 框架写入路径」。
- `tests/fakes/fakeWorkspaceFs.ts`：`exists` = `files ∪ dirs`；`symlink(:46)` **同时写 `symlinks` 和 `files`**（所以建链后 `exists(link)` 为 true）；`rmrf(:26)` 删 `dirs` + 前缀匹配的 `files`，**不清 `symlinks` map** —— 双端 rollback 断言若只看 `fs.symlinks` 会假绿（见 §4 扩展点）。
- `tests/fakes/fakeLarkGateway.ts:12` `failCreateGroup` —— 触发 rollback 的现成开关。
- `tests/fakes/fakeProcessLister.ts:21-28` `list` 自己实现了 `cwdPrefix` 的 `startsWith` 过滤 —— 多前缀合并要么在 fake 里给多组进程，要么断言调用次数。
- `tests/app/bootstrap.test.ts`：`:189 describe("validateEnv")`，`:190` 基线用例（断言全量 cfg 字段）、`:305` `honors explicit mention registry path override` = **新 env 用例逐字样板**。
- `tests/app/bootSelfCheck/checks/reconcileBackendProcesses.test.ts`（608 行）：所有用例用 `cfg: { workspaceRoot: "/workspace" } as BootCheckContext["cfg"]` **强制转型** —— 加可选字段不会破坏它们（但也意味着漏传不会被 typecheck 抓到，见 §6）。
- `tests/e2e/harness.ts:60-115`：`mkdtempSync` + **真 `NodeWorkspaceFs`** + 真 sqlite，`workspaceRoot = <tmp>/workspace`。可做「真 symlink + 真 git init」的 e2e；device-id 校验属 bootstrap 侧，lifecycle 只收注入闭包，e2e 注入 no-op 即可。
- `tests/e2e/newSession.e2e.test.ts`、`tests/app/commands/newSession.test.ts`、`tests/cli/selfCheck.test.ts`、`tests/cli/spawnWorkdir.test.ts`。

---

## 2. 入口与分层约定

- 六边形分层：`src/domain/ → src/ports/ → src/adapters/ | src/app/ | src/cli/`，由 `scripts/check-deps.ts`（`npm run lint:deps`）强制。**注意 `:58` `if (!spec.startsWith(".")) continue;` —— 只校验相对 import，完全不拦 `node:` 内建**（见 §5.5）。
- 本轮新代码落点（方案已定，勘察确认无更好挂点）：
  - 行为改动 → `src/app/sessionLifecycle.ts`（deps 类型 `:34` + 默认路径分支 `:234` + rollback `:258`）
  - 校验实现 + env → `src/cli/bootstrap.ts`（`:324` schema / `:342` 透传 / `:138` AppConfig / `:646` 注入）
  - 漏检修复 → `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts:34` + `src/app/bootSelfCheck/types.ts:18`（加**可选**字段）+ **`src/cli/selfCheck.ts:91,143` 两处 cfg 构造**
- 测试怎么跑（**vitest 绝不接 `| tail/head/grep`**，管道早关会留 GB 级孤儿 worker）：
  - `npm run test:unit`（`tests/domain tests/app tests/cli tests/scripts`）/ `npm run test:adapters` / `npm run test:e2e`
  - 焦点：`npx vitest run tests/app/sessionLifecycle.create.test.ts`
  - 全量闸口：`npm run verify` = `lint:deps && typecheck && test:unit && test:adapters && test:e2e`
  - 依赖方向单跑：`npx tsx scripts/check-deps.ts`
- 提交前：`SM-SOURCE-CHANGES.md` 追加 `Files / Problem / Change / Verification`（文件末尾三条 2026-09-05/06 的条目是格式样板）。仓库 local-only，不加 remote / 不 push / 不走 PR。
- 触及 lifecycle / bootstrap / self-check 后跑 `docs/SMOKE.md`：`### 3. /new claude alpha` 在 **`docs/SMOKE.md:45-51`**（`:48` 是「Workspace directory `$SM_WORKSPACE_ROOT/alpha` is created and git-initialized」、`:51` 是 catalog symlink 那条），方案要求的两条新步骤就插在这一段。
- 活图不在本 worktree：`/Users/LOCAL_USER/SuperMatrix/architecture/map.json`（主 checkout，`git status` 显示 `?? architecture/`，**untracked**）。工具 `/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/jiagou/architecture/bin/livemap`。
- 环境变量改动的生效路径：改 `.env.local` 后必须走 `scripts/safe-reload.sh` / `scripts/platform-maintenance-gate.sh`；**source watcher 只看 `src/`，env 变更不会触发热重载**。

---

## 3. 别重造清单（已存在，直接用；含「同一类逻辑已有几处」）

1. **`WorkspaceFs.symlink` 已齐三处**：port `WorkspaceFs.ts:10` / node adapter `:51` / fake `:46`。不要为 505 扩 port 或另写 symlink helper。
2. **「exists 预检 + 幂等建链」范式**：`sessionLifecycle.ts:214 ensureCatalogSymlink`。旧根兼容链接照抄，别新发明。
3. **可写性探针**：`bootSelfCheck/checks/localDeps.ts:121 ensureWritableDir`（access → mkdir -p → access）。挂载校验的「目录存在且可写」判据直接复用，勿重写。
4. **`statfs` / `st.dev` 先例已在仓内**：`scripts/weekly-cache-cleanup.ts:3356 diskFreeBytes(statfsSync)`、`:1253` `${st.dev}:${st.ino}:...` 身份戳。device-id 比对不是新技术引入。
5. **回滚栈**：`sessionLifecycle.ts:236-246 runRollback`（reverse + 逐步 catch）。双端清理只需再 `push` 一个 step，不要另起清理函数或改回滚机制。
6. **可选 env 三段式**：`SM_MENTION_REGISTRY_PATH` 在 `bootstrap.ts:339/359/154/377` 与 `tests/app/bootstrap.test.ts:305` 有完整样板（schema → 透传 → AppConfig → 用例）。
7. **realpath 归一已做**：`apiServer.ts:290-307` 双端 `realpath`。spawn2.0 的 `execution.workdir` 语义零改动 —— 勘察复核确认方案结论成立。
8. **存量迁移脚本不在本仓**：`workspaces/localgit/scripts/migrate-workspace-to-smc.sh`（两遍 copy + 文件数/字节/HEAD/fsck 校验 + 占用守卫 + symlink 替换）。**不要在 SuperMatrix 仓内复制一份迁移逻辑**，它确立的「实体在 sm-c、旧路径留 symlink」约定就是本轮要对齐的约定。
9. **⚠ `lsof -d cwd` 读进程 cwd 已有两处实现**：`src/adapters/process-lister-ps/index.ts:92-102`（TS）与 `scripts/localwatch.sh:46 localwatch_process_cwd_for_pid`（shell）。两者都是 `lsof -a -p <pid> -d cwd -Fn` 取 `n` 前缀行。**本轮不要写第三份**；localwatch 那份比对的是 SM 仓路径而非 workspaces，不受本轮影响，但改「cwd 前缀假设」时要一并想到。
10. **⚠ `SM_WORKSPACE_ROOT` 已被 6 处独立读取**（同一上游多点消费，改语义时全部要过一遍）：`bootstrap.ts:345`（validateEnv，唯一权威）、`sessionLifecycle.ts:86`（app 层直读）、`spawnPredicate/lint.ts:31`、`selfCheck.ts:143`、`scripts/migrate-to-session-catalog.ts:53`、`scripts/regenerate-catalog.ts:38`。本轮只新增第二个变量，**不要顺手统一这 6 处**（超出 Todo 半径）。
11. **⚠ 创建期 symlink 已有三处调用**：`ensureCatalogSymlink`(:214/:315)、principles 三连（:333-341）、SOP 模板（:358-361）。新增的旧根兼容链接是第四处 —— 它与前三处语义不同（前三处在 workdir *内部*建链，新的是在 workdir *本身*建链），别混进同一个 helper。
12. **UserError → 飞书文案的唯一通道**是 `commandRouter.ts:34`；不要在 lifecycle 里自己拼 `❌` 文案。

---

## 4. 可复用扩展点（加功能优先改这些文件）

| 落点 | 具体行 | 做什么 |
|---|---|---|
| `src/app/sessionLifecycle.ts` | `:34` deps 类型；`:234` 默认路径分支；`:253-262` 新建分支；`:258` rollback push | 方案改动 1 的**全部**落点，无第二处 |
| `src/cli/bootstrap.ts` | `:324` schema；`:342` 透传；`:138` AppConfig；`:646` 注入 | 方案改动 2；校验实现（存在+可写+`st.dev` 不同）放这里，抛 `UserError` |
| `src/app/bootSelfCheck/checks/reconcileBackendProcesses.ts` | `:34-38` | 单 list → 对 `[workspaceRoot, provisioningRoot]` 去重去空后分别 list、按 pid 合并 |
| `src/app/bootSelfCheck/types.ts` | `:18-22` | 加 **可选** `provisioningRoot?: string`（加必填会因下游强转而静默 undefined） |
| `src/cli/selfCheck.ts` | `:91`（validateEnv 造 cfg）与 `:143`（手工字面量 cfg） | **方案未列**：不同步这两处，`npm run self-check` observe 仍只扫旧根，验收的「改动前后对比」会假绿 |
| `tests/fakes/fakeWorkspaceFs.ts` | `:26 rmrf` | 需同时从 `symlinks` map 删除，否则双端 rollback 断言写不干净 |
| `tests/fakes/fakeProcessLister.ts` | `:21-28 list` | 多前缀合并的断言支撑（或按调用次数断言） |
| `tests/app/sessionLifecycle.create.test.ts` | `:14 mkDeps`（加两个可选 dep 的 override）；`:199` rollback 用例 | 方案要求的 4 个新用例 |
| `tests/app/bootstrap.test.ts` | `:305` | 新 env 解析用例 |
| `docs/SMOKE.md` | `:45-51` | 两条新 checklist（sm-c 落盘 + 旧根 symlink 可用；未挂载时 `/new` 显式报错） |
| `/Users/LOCAL_USER/SuperMatrix/architecture/map.json` | 见 §5.1 | 增量加节点/边（**不是新建整张图**） |

---

## 5. 方案 v1（2026-09-03）假设 vs 当前现状（2026-09-09 实勘差异）

> 这些差异不推翻方案，但会改变工作量估计和验收判据的写法。

**5.1 活图已存在 —— 方案第 6 条的前提失效。** 方案写「codexroot 两处都无 `map.json`，获批后按 schema 建最小 map」。实际：`/Users/LOCAL_USER/SuperMatrix/architecture/map.json` 于 **2026-09-04** 建立（`session=codexroot`，`version=1`，**23 nodes / 27 edges，全部 `status=live`**，provenance 均为「2026-09-04 实勘」）。所以本轮是**在既有图上增量加节点/边**。相关既有节点：`codexroot:session-lifecycle`（group=routing，carrier=`sessionLifecycle.ts + sessionRuntimeConfigPolicy.ts`）、`codexroot:boot-recovery`（group=delivery，carrier=`bootSelfCheck/index.ts + codexRuntimeRecovery.ts + bootstrap.ts`）、`codexroot:command-router`、`codexroot:sqlite-store`、`codexroot:spawn-predicate`。既有边：`command-router → session-lifecycle`（会话命令）、`sqlite-store → session-lifecycle`（持久化）、`boot-recovery → sqlite-store`（恢复状态）。**图里没有任何 WorkspaceFs / 文件系统 / 外部卷节点，也没有 processLister 节点** —— 这两类是本轮要新增的。文件在主 checkout 且 **untracked**（`git status` → `?? architecture/`），不在本 worktree。

**5.2 已迁移工作区从 3 个增到 5 个，漏检面已扩大。** 方案记录 `ainotes/copysm/yolo`；现在 `ls -la $SM_WORKSPACE_ROOT` 显示 6 条 symlink，其中 5 条指向 sm-c：`ad-adjust`、`ainotes`、`copysm`、`heartbeat`、`yolo`（第 6 条 `kuisun -> stoploss` 是本地相对链接，与 sm-c 无关，别算进去）。注意 **`heartbeat` 同时是 `bootstrap.ts:890/1236` heartbeat 脚本路径的宿主** —— 那两处经 symlink 解析仍成立，但说明「旧根前缀假设」已经在生产路径上依赖 symlink 透明性。

**5.3 挂载设备号变了：现在是 `/dev/disk7s1`**（方案写 disk5s1）。设备号跨挂载不稳定 → 验收判据必须写成「provisioning root 的 `st.dev` ≠ `SM_WORKSPACE_ROOT` 的 `st.dev`」，**不能写死 `disk5s1`**。这反过来印证方案选 `stat().dev` 比对（而非字符串匹配 `/Volumes`）是对的。

**5.4 `WorkspaceFs.symlink` 已存在**（方案未提）。port / node adapter / fake 三处齐备，改动 1 不需要动 port 层。

**5.5 「不污染依赖方向」是团队约定，不是 lint 闸口。** `scripts/check-deps.ts:58` 只处理相对 import，`node:` 内建一律跳过；`src/app/` 下**已有 14 个文件 import `node:fs*`**（含 `bootSelfCheck/checks/localDeps.ts`、`spawnPredicate/lint.ts`、`cardAskGate.ts` 等）。另外 `sessionLifecycle.ts` 本身已 import `node:child_process`/`node:path` 并在 `:86` 直读 `process.env`。结论：验收里 `grep -n "node:fs" src/app/sessionLifecycle.ts` 为空 **仍可作为判据**（保持该文件干净），但别指望 `npm run lint:deps` 会替你抓这件事。

**5.6 分支干净。** `lgs/todo-505` 与 `main` 无差异，`.env.local` 尚无 `SM_NEW_WORKSPACE_ROOT`（当前 `SM_WORKSPACE_ROOT=/Users/LOCAL_USER/SuperMatrixRuntime/workspaces`，第 4 行）。

---

## 6. 风险 / 波及点（拆解任务时要显式覆盖）

1. **`exists()` 跟随 symlink → 悬空链接报 false。** `NodeWorkspaceFs.exists` 用 `access()`。残留半清理场景（链接在、目标没了）会让双端预检放行，随后 `fs.symlink()` 抛裸 `EEXIST` —— 又退回成「错误不可读」，正是本 Todo 要消灭的症状。双端预检需要 `lstat` 语义或显式吃掉 `EEXIST` 并转 `UserError`。
2. **失败点必须排在 `:257 mkdir` 之前**（因此也在 `:272 createGroup` 之前）。验收明确要求盘未挂时「飞书群未被创建」——这是「不静默落本地盘」的实证。
3. **rollback 顺序天然正确，别手动重排。** `runRollback` 是 reverse 栈：按 `mkdir(physical)` → `symlink(link)` 的顺序 push，回滚时自然先删链接后删实体，与方案要求一致。但**必须 push 两个 step** —— 一个 `rmrf(link)` 删不到物理目录（`fs.rm` 对 symlink 只解链接）。
4. **`src/cli/selfCheck.ts` 的两处 cfg 构造是隐藏同步点。** 只改 bootstrap 不改 `:91`/`:143`，`npm run self-check`（observe）仍只扫旧根，验收里「改动前后各跑一次对比 `reconcile-backend-processes` 候选集」的判据会**假绿**。
5. **`BootCheckConfig` 加字段要用可选。** `types.ts:14-17` 注释说明它靠结构化类型接收 bootstrap 的 `AppConfig`；而 608 行的 reconcile 测试全部用 `as BootCheckContext["cfg"]` 强转 —— 加必填字段不会编译报错，只会在运行时变 `undefined`（静默降级）。
6. **`npm run self-check -- --profile cli-upgrade` 的纯 JSON stdout 契约**（`selfCheck.ts:129-133`）：任何诊断输出只能走 stderr，否则周度兼容闸口的 `JSON.parse(stdout)` 消费方整批炸。
7. **`spawnPredicate/lint.ts` 的「一通一拒」不一致仍在**（方案可选 9，本轮不做）：旧根写法放行、`/Volumes/EXAMPLE_VOLUME/...` 物理写法被拒（除非经 `SM_WATCHER_PATH_ALLOWLIST` 补）。落地后要知道这条边界没变。
8. **`localDeps.ts:51` 只探旧根可写**：provisioning root 掉盘在 `/api/health` 层面不可见，只有有人 `/new` 才暴露（方案可选 10，本轮不做）。
9. **env 生效需要重载，且不是热重载**：source watcher 只看 `src/`，`.env.local` 变更必须经 `scripts/safe-reload.sh` / `platform-maintenance-gate.sh`。方案第 7 条（写 `.env.local`）与代码必须同批落地，否则前 6 条是死代码。
10. **`/clone` 与 `/new --workdir` 不受影响但必须有回归**：两者走 `useExistingWorkdir` 分支（`newSession.ts:73,156`），不经默认路径、不建 symlink。方案第 4 条用例 ④「未配 provisioningRoot 时路径与今天逐字一致」之外，建议同时钉住「配了 provisioningRoot 时 clone 路径仍不变」。
11. **`sessions.workdir` 存旧根 symlink 路径**是全链路透明性的前提：`dispatcher.ts:469`、三个 backend 的 `cwd: session.workdir`、catalog、兄弟会话互查、`scripts/migrate-to-session-catalog.ts:99` 全部依赖它。DB 改存物理路径的备选方案会同时打到这些消费方 —— 方案已否决，不要在实现时"顺手优化"。
12. **worktree 与 npm 依赖**：本轮方案不需要新增 npm 依赖（`statfs`/`stat` 都是 `node:fs` 内建）。若临时引入，merge 回 main **前**必须先在 main 跑 `npm install`。

---

## 附录 A：2026-08-04 `/now` Live Steer 勘察（原档案，本轮未重新核验行号）

> 保留原因：该档案覆盖 backend adapter / dispatcher / 命令注册链路，与 #505 无关但仍是本仓有效勘察成果。
> 原范围：`/now` 落地（Claude stream-json replay ack、Codex per-run app-server turn/steer、Kimi unsupported）。

> 更新日期：2026-08-04（新建）。范围：围绕 `/now` 落地（Claude stream-json replay ack、Codex per-run app-server turn/steer、Kimi unsupported）的现状勘察，非全仓覆盖。
> 方案文档：`docs/superpowers/plans/2026-08-04-now-live-steer.md`（untracked）。
> 版本锁定已核实与本机一致：Claude Code 2.1.220、codex-cli 0.146.0（`codex app-server` 子命令存在，标注 experimental）、kimi 0.30.0。

### 1. 相关现有能力清单（谁已经在做类似的事）

#### 命令路由 / 命令实现
- `src/app/commandRegistry.ts`（746 行）— 声明式命令表（name → Command + placeholderHandler），`buildCommandRegistry()` 末尾强制 `assertCommandRegistryPolicy`。`/next` 声明在 L608-624（scope user、rest 参数 `text`），`/cancel` 在 L147-175。
- `src/app/commandRegistryPolicy.ts` — **硬编码审批白名单**（29 条，name → owner + scopes，双向校验）。`/now` 尚未在表内；不加白名单则 `buildCommandRegistry()` 启动即 throw。
- `src/app/commandRouter.ts`（44 行）— scope 检查（L27-29）+ 调 handler + UserError/SystemError → `❌` 文案统一转换。
- `src/domain/parseCommand.ts` — NFKC、shell tokenize、canonicalizeToken、param scope 消费。
- `src/app/commands/help.ts` — 从 registry 自动渲染 help/签名/notes；新命令写好 description/params/notes 即零额外工作。
- `src/app/commands/next.ts`（40 行）— **与 /now 最接近的样板**：`resolveUserGroupSession(msg.groupId)` 拿绑定 → `findSessionByName` → 拒 deleted/error → **origin 自查 `msg.origin !== "lark_user"` 静默 return**（L26-28）→ enqueuePendingNext → `{ replyText }`。busy 判定只看 `session.status`，不查 message_runs。
- `src/app/commands/cancelSession.ts`（49 行）— user/root 双 scope 参数兼容、`clearPendingNext` + `deps.cancel(session.id)`，无 busy 校验。

#### dispatcher 主链（busy guard / FIFO / run 创建）
- `src/app/dispatcher.ts`（1205 行）`handleInbound` L527 起：
  - **命令分支 L616-668，末尾 L668 `return` —— 任何注册进 registry 的 slash 命令天然在 busy guard 之前路由完毕**；busy guard 在其后：L722 `session.status === "busy"` + L731 `findRunningMessageRunBySession` 双道。`/now` 不需要任何"绕过 busy guard"的新机制。
  - `allowCommandRouting = msg.origin !== "framework_synthetic"`（L572-579）是命令入口的信任门。
  - `EMPLOYEE_BLOCKED_COMMANDS`（L60-76）：员工 category 的命令黑名单，不含 next/cancel；`/now` 是否加入是一个显式决策点。
  - `/next` FIFO：类型/消费端在 dispatcher（`PendingNextStore = {has, shift, restoreFront}` L50-54；`drainPendingNext` L485-525，防重入 + idle 且无 running 行才 drain + `framework_synthetic` 合成消息递归 `handleInbound`），**队列容器在 bootstrap**（L947-981 `pendingNextMap`，enqueue 只属于 handler 侧）。
  - run 创建：L816 `runId = asMessageRunId(idFactory())` → L818 `startMessageRun` → L827 置 busy；RunInput 构造 L869-899。**runId 只流向 replier/tokenUsage/codexRuntimeRecovery，从不进 RunInput。**
- `src/app/runOnSession.ts`（369 行）— 第二个生产 run creator（API 面）。L85-92 busy 双查（明确「refuse rather than queue，API 要 409」）；L114 startMessageRun；**L166-170 RunInput 只有 `{session, prompt, attachments: []}`（连 execution 都不传）**。
- `src/app/childSession.ts`（1350 行）`runPrompt` — 第三个生产 run creator。L832-840 startMessageRun；L847 `runInput = { session, prompt }`；**唯一把 runId 外发的钩子是 `hooks.onRunStarted/onBackendStarted({session, messageRunId})`（L845/L960）**。

#### Port 契约与持久层
- `src/ports/AgentBackend.ts`（42 行，全文即契约）— `RunInput` 字段：session/execution?/prompt/attachments?/systemHint?/answerOnly?/cardAskEnabled?/cardAskChatId?/conversationFork?。**无 messageRunId；`AgentBackend` 只有 kind/run/cancel，无 steer**。方案 Task 1 的两处契约扩展（`RunInput.messageRunId` + `steer?`）都是净新增。
- `src/ports/BindingStore.ts` + `src/adapters/store-sqlite/index.ts`：
  - **`findRunningMessageRunBySession(sessionId)` 已存在**（port L704；sqlite L1472-1505，`status='running' ORDER BY started_at DESC LIMIT 1`，返回完整 MessageRun）。/now 的 running 行查询零新增。
  - `startMessageRun` L1362（硬编码 status="running"）、`finishMessageRun` L1402、`findRunningMessageRuns()` 全库版 L1706（boot reconcile 用）。
  - `RuntimeConfigMutationGuard = {kind:"active-run", messageRunId}`（port L145-147）已是「带 WHERE 当前态的原子守卫」先例。
  - fake：`tests/fakes/fakeBindingStore.ts` 两个方法均已实现（L947/L986）。

#### backend-claude adapter（Task 2 改造对象）
- `commandBuilder.ts`（155 行）— `ClaudeCommand = { args, stdin?: string }`。**`--input-format stream-json` + stdin JSON user envelope 的拼装已存在，但只在有 native image 时启用**（L134-144，单行 `{"type":"user","message":{...}}` + `\n`）；默认路径 prompt 走 argv 尾参。全仓无 `--replay-user-messages`。
- `process.ts`（195 行）— `spawnAndStream`。**stdin 一次性**：无 stdin 串则 fd0=`"ignore"`（连管道都没有）；有则 `child.stdin.end(opts.stdin)` 写完即关（L119-122）。`StreamHandle = {iterable, cancel, pid}`，**不带 session/run 标识、不暴露 stdin writer**。detached 进程组 + SIGTERM→SIGKILL、inactivity/maxRuntime 双 timer、手写 queue+waiter、iterator `return()` 即 cancel。
- `index.ts`（152 行）— `inflight = Map<SessionId, StreamHandle>`（L35，**key 无 runId，resume retry 会覆盖 entry**）；`start()` 注入 `SM_SESSION_NAME` + per-run caller attestation；`runWithResumeRecovery`（L97-141）缓冲 started 事件、thinking-block poison 时以 `backendSessionId: null` 重开 —— 方案要求「注入文本不得从失败 resume 跳进 fresh retry」正是打在这段的换 handle 竞态上。
- `streamParser.ts`（306 行）— `type:"user"` 分支（L144-170）**只认 `tool_result` block，replay 的 text user block 会被静默丢弃**；`AgentEvent` union（`src/domain/events/agentEvent.ts`）只有 started/thinking/tool_call/tool_result/assistant_message/error/completed/usage，无 replay/ack 事件类型。replay ack 的匹配逻辑需在此或 process 层新增。

#### backend-codex adapter（Task 3 改造对象）
- `index.ts`（177 行）— `inflight = Map<SessionId, StreamHandle>`；`run()` 顺序：commandHealthCheck（只探 `--version`）→ card-ask 健康降级 → `preflightCodexState` 改写 input → `start` → finally 清 inflight + revoke attestation。`SM_CODEX_CLI_PATH` env 优先。
- `commandBuilder.ts`（112 行）— `buildCodexArgs`：`exec [resume <id>] --json`、answerOnly→`--sandbox read-only --ephemeral`（且强制不 resume）、否则 `--dangerously-bypass-approvals-and-sandbox`、`--model`、`-c model_reasoning_effort=`（含 effort 归一 evidence 回调）、card-ask 走 4 组 `-c mcp_servers.askserver.*` TOML override、非 resume 才 `--cd`、`--image` 变参 + `--` 终止符、conversationFork 直接 throw。`resolveCodexExecutionModel/Effort` 是 model pin 单一来源（不落库）。
- `process.ts`（259 行）— `stdio: ["ignore","pipe","pipe"]`（**无 stdin 管道**）；`normalizeCodexChildEnv`（proxy 大小写补齐，forkBootstrap 复用）；stderr 已知噪声过滤（stdin-prompt 提示、model_manager 超时正则）与 exec 强绑定；进程组 kill / timer / queue 结构与 claude process.ts 同构。
- `streamParser.ts`（509 行）— exec `--json` **snake_case** 事件全表 → AgentEvent（thread.started/turn.completed/token_count/agent_message commentary/function_call(_output)/item.started|completed/last_assistant_message/error + flush）；usage 归并 `outputTokens = raw - reasoning`、coarse/rich 同 turn 合并。app-server 是 camelCase，这层是纯翻译改写面。
- 周边：`statePreflight.ts`（直读 `~/.codex/state_5.sqlite` 判 resume rollout 有效性，**决定 start vs resume**，answerOnly 跳过）；`forkBootstrap.ts`（独立一次性 `codex exec resume` 子进程，方案明确不扩大 fork 行为，迁移后将是仓内最后一处 exec 调用）；`modelUnavailable.ts`（**对 error message 文本做谓词匹配**——app-server 错误形状变了会断 codexRuntimeRecovery 降级链）；`modelAvailabilityProbe.ts` / `defaultModelResolver.ts` 不在 run 主路径。
- `src/app/codexRuntimeRecovery.ts` — 上游消费者；`createCodexRuntimeRecoveryRun` 的输入已含 `messageRunId`（L86），靠「重开一次 run」做 model 降级重试——迁移后每次重试 = 重开一个 per-run app-server 进程。

#### backend-kimi（unsupported 路径 + JSON-RPC 参考件）
- `src/adapters/backend-kimi/acpClient.ts` — 共享单例 ACP client。**内含手写 stdio JSON-RPC 旁路，是仓内现成的最小 JSON-RPC client 范式**：`sendRawRequest(method, params, timeoutMs)`（L612-625，`sm-raw-<n>` id 命名空间 + `rawPending Map` + 超时 reject）、`routeRawResponse(line)`（L728-748，按 id 前缀截流吞行）、行级预过滤多消费者分发、`state/ensureReady/invalidate/waitForChildExit/dispose` 生命周期。注意语义差异：kimi 是进程级共享单例 + updateRouters 路由；codex app-server 是 per-run 进程，路由表不需要，pending/timeout/liveness 那套可直接借鉴。
- `src/app/kimiAutonomousTurnWatch.ts` / `kimiAutonomousTurnStream.ts` — 从 kimi wire.jsonl 文本扫 `"turn.steer"` 字面量的**同名不同物**，与 Codex app-server 协议无关，勿动勿混。
- Kimi steer 可行性已闭环：`runs/2026-08-04-kimi-steer-probe/`（README + probe-steer.mjs + wire.jsonl 275 帧）证明 ACP 面 mid-turn `session/prompt` 被 `-32600 turn.agent_busy` 立即拒绝、无 `session/steer` 方法、引擎内部 steer 能力未暴露。**方案「Kimi 明确 unsupported」的证据无需重做。**

#### 测试基建
- `tests/adapters/backend-claude/`：`fakeClaude.sh`（scenario case 分发，**只写不读 stdin**）；`process.test.ts` L25-38 已有「断言 stdin 内容」的 `/bin/sh -c read -r line` 模板；`index.test.ts` 用 `buildArgs: () => ["scenario"]` seam（**从不供 stdin**）；`streamParser.test.ts` 无 replay text user 用例；`samples/` 为合成 fixture（re-record 脚本 `scripts/spike-claude-stream.sh`）。
- `tests/adapters/backend-codex/`：`fakeCodex.sh` 13 个 scenario，同样**只写不读，无请求/响应配对能力**——app-server 测试必须新建能按 id 回响应的 fixture。
- `tests/adapters/backend-kimi/fakeAcpServer.ts` — **现成的「读 stdin JSON-RPC 请求、按 id 回响应」fixture 范式**（L86 手写 response、L213 notification），是 codex fake app-server 的直接参照物。
- `tests/app/codexRuntimeRecovery.test.ts`（1212 行）— 不伪造进程，用 `scriptedRun(AgentEvent[][])` 直产事件流；但 import 了 `buildCodexArgs` 和 modelUnavailable 谓词，argv/错误文本变更会打到它。
- `tests/app/commands/`（30 文件）— 无共享 harness；惯例：直接 import handler + 文件内 `makeSession/msg` 工厂 + 内联 deps + 断言 `result.replyText`；共享件仅 `tests/fakes/fakeBindingStore.ts`。registry 层测试在 `tests/app/commandRegistry.test.ts`（含 policy 审批断言）。

### 2. 入口与分层约定

- 六边形分层 `src/domain/ → src/ports/ → src/adapters/ | src/app/ | src/cli/`，`scripts/check-deps.ts`（`npm run lint:deps`）强制方向。新代码落点：
  - `/now` handler → `src/app/commands/now.ts`（新建，仿 next.ts）；声明进 `commandRegistry.ts` + **白名单进 `commandRegistryPolicy.ts`**；handler 绑定在 `src/cli/bootstrap.ts` L837-945 段（`resolveUserGroupSession` 共享 helper 在 L801-806）。
  - 契约扩展 → `src/ports/AgentBackend.ts`（RunInput.messageRunId + steer?）。
  - Claude steer → `src/adapters/backend-claude/{commandBuilder,process,index}.ts`；Codex app-server → `src/adapters/backend-codex/` 新建 `appServerProcess.ts` / `appServerProtocol.ts`。
- backendRegistry 装配在 `bootstrap.ts` L543-565；dispatcher 装配 L1013-1040（`idFactory: "mr_" + uuid.slice(0,8)`）。
- 测试：vitest，**绝不接管道**（`| tail/head/grep` 会 SIGPIPE 孤儿 worker）。焦点跑法 `npx vitest run tests/adapters/backend-claude` 等；提交前 `npm run lint:deps` + `npm run typecheck` + `npm run verify`。
- 触及 lark-cli / apiServer / adapters 的改动，除自动化测试外跑 `docs/SMOKE.md` 对应段（§5 /cancel、§167 Kimi backend 段是 /now checklist 的挂点）。
- 提交前在 `SM-SOURCE-CHANGES.md` 记 Files/Problem/Change/Verification；仓库 local-only，不加 remote/push/PR。
- 激活走 source-watcher 安全 reload（注意：watcher 只看 `src/` 且全项目 tsc 预检，tests-only 修复不重触发）。

### 3. 别重造清单（已存在，直接用）

1. **busy guard 之前的命令路由**：dispatcher 命令分支 L668 提前 return，天然先于 L722/L731 busy 双道。**不需要任何新的"/now 优先路由"机制**，注册即得。
2. **running 行查询**：`findRunningMessageRunBySession` port+sqlite+fake 三处齐备，已被 busy guard、drainPendingNext、runOnSession、kimiAutonomousTurnWatch 四处消费。/now 直接复用，勿新写 SQL。
3. **stdio JSON-RPC client**：`acpClient.ts` 的 sendRawRequest/rawPending/routeRawResponse + `fakeAcpServer.ts` 测试 fixture。codex appServerProtocol 按此范式写 per-run 版，勿引新依赖（方案也禁新 npm 依赖；注意 `@zed-industries/agent-client-protocol` 是 ACP 专用 lib，codex app-server 不能复用它，能复用的是手写旁路的模式）。
4. **Claude stream-json stdin 拼装**：image 路径已有 `--input-format stream-json` + user envelope 序列化（commandBuilder L134-144），Task 2 是把它扩为全路径默认 + 保持 stdin 打开，不是从零写。
5. **stdin 内容断言测试模板**：`tests/adapters/backend-claude/process.test.ts` L25-38。
6. **Kimi unsupported 证据**：`runs/2026-08-04-kimi-steer-probe/` 已完成四种语义判定 + 二进制静态核对，直接引用。
7. **进程组 kill / inactivity/maxRuntime timer / queue+waiter 事件泵**：claude 与 codex 的 process.ts 已各有一份同构实现（既有重复，二处并存是现状）；appServerProcess 应沿用同一形状，不发明第三种生命周期。
8. **caller attestation / SM_SESSION_NAME 注入、card-ask 健康降级、effort 归一 evidence**：两 adapter 的 run() 已有完整链，app-server spawn 必须原样保留（方案 Task 3 lifecycle 第 1 条），不重写。
9. **原子守卫先例**：`RuntimeConfigMutationGuard {kind:"active-run", messageRunId}` + sqlite `EXISTS(... status='running')` 子查询——「带 WHERE 当前态」的写法已有模板。
10. **/next FIFO**：pendingNextMap（bootstrap）+ drainPendingNext（dispatcher）语义保持不变，/now 不碰它、失败不回落到它（方案红线）。
11. **同名陷阱**：`kimiAutonomousTurnWatch/Stream` 里的 `turn.steer` 字符串扫描是 kimi 引擎内部事件，与 codex `turn/steer` RPC 无关；grep 时勿误判"已有实现"。

### 4. 可复用扩展点（加功能优先改这里）

- **契约面**：`src/ports/AgentBackend.ts` 加 `RunInput.messageRunId` + `AgentBackend.steer?`；typecheck 会自动揪出三个 run creator（dispatcher L869 / runOnSession L166 / childSession L847）漏传——三处的 runId 局部变量都现成（L816 / L113-114 / L832-840）。
- **handle 身份**：两 adapter 的 `inflight: Map<SessionId, StreamHandle>` 是 steer 原子比对的挂点——handle 需带 `messageRunId`（codex 另加 threadId/turnId）；claude 侧注意 resume retry 覆盖 entry 的窗口（index.ts L111-125）。
- **Claude replay ack**：streamParser `type:"user"` 分支（L144-170）是 replay 消息唯一落点，当前静默丢弃 text block；ack 匹配可在此挂钩或在 process 层旁路，FIFO 匹配归 handle。
- **Codex 迁移面**：commandBuilder 保留 legacy exec 导出（forkBootstrap 还用）；streamParser 的 snake_case→AgentEvent 映射表是 camelCase 翻译的对照基准；`statePreflight` 输出直接决定 `thread/start` vs `thread/resume`。
- **命令侧**：next.ts 的 deps 形状（store + resolveUserGroupSession + 注入动作闭包）即 /now handler 的模板；bootstrap L837-945 加一行绑定。
- **测试**：fakeAcpServer.ts 范式 → 新建 fake codex app-server fixture；fakeClaude.sh 加"读 stdin 并 replay"scenario；`scriptedRun` 模式覆盖 app 层。

### 5. 已核实的风险 / 波及点（拆解任务时要显式覆盖）

- **argv 形状是外部依赖**：`src/adapters/process-lister-ps/index.ts:12-17` 的 `RESUME_RE` 和 `tests/app/bootSelfCheck/checks/reconcileBackendProcesses.test.ts:349` 匹配字面 cmdline `claude -p --output-format stream-json "processing"`——两端 argv 改动会打到 boot 孤儿 reconcile。
- **modelUnavailable 文本谓词**：app-server JSON-RPC error 的 message 若与 exec 文案不同，`isConfirmedCodexModelUnavailable/isCodexModelAtCapacity` 失效 → codexRuntimeRecovery 降级链断。
- **stderr 噪声过滤**：process.ts 的 codex 噪声正则与 exec 输出强绑定，app-server 的 stderr 语义需重新核。
- **statePreflight 假设 app-server 与 exec 共享 `~/.codex/state_5.sqlite` threads 表**——迁移前需实证。
- **commandHealthCheck 只探 `--version`**，不证明 `app-server` 子命令可用。
- **origin 双门**：dispatcher 层 `framework_synthetic` 不进命令路由 + handler 层 `msg.origin !== "lark_user"` 静默——/now 照抄 next.ts 即两门齐备。
- **员工黑名单决策点**：`EMPLOYEE_BLOCKED_COMMANDS` 是否收 /now 需要显式决定（next/cancel 均不在内）。
- **RunInput 差异**：runOnSession 不传 execution、childSession 只传 `{session, prompt}`——加 messageRunId 时三处形状不同，别只改 dispatcher。
