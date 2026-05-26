# Super Matrix

**语言：** 中文 | [English](README.en.md)

> 个人 Agent 只能替一个人做事；组织 Agent 要能和人一起，在同一套上下文、规则和工作区里接力完成工作。
>
> Super Matrix 把 Claude Code / Codex CLI / Kimi CLI 从“个人终端工具”升级成“组织级 Agent 协作系统”：每个 Agent session 都有自己的群聊、工作区、身份、状态和任务记录；人可以在飞书里派活、追踪、转交和复盘，多个 Agent 也可以在同一框架下协同。
>
> 执行仍留在你的本机，代码、数据、凭证不出本地；入口和协作搬到飞书/Lark，让个人电脑上的 Agent 变成团队可以共同使用、管理和沉淀的组织能力。

## 30 秒了解

- **从个人 Agent 到组织 Agent**：不是把一个终端搬到手机上，而是把多个本地 Agent 接进同一套组织协作框架。
- **人和 Agent 在同一个工作流里**：每个 session 有名字、群聊、工作区、后端 CLI、状态和任务记录，可以被派活、交接、追踪和复盘。
- **入口在飞书，执行在本地**：手机或群里发任务，本机 Claude Code / Codex CLI / Kimi CLI 接手干活，结果回到群里。
- **多 session 协作**：可以让 Codex 写 plan、Claude 执行、Kimi review，全程在飞书里用自然语言派活，不用复制粘贴 prompt。

## 它解决什么问题

如果你已经在用 Claude Code、Codex CLI 或类似本地 Agent，会很快撞到这些现实问题：

- 人不在电脑前时，终端里的 Agent 就不可用。
- 一个终端一个 Agent，任务一多就不知道谁在干什么、跑到哪一步、改动留在哪个工作区。
- 团队成员很难把任务派给同一套 AI 工作流，也很难复用别人沉淀的提示词、SOP 和 skills。
- 每人各自一台电脑各自的 agent，协同还得靠人转述。

Super Matrix 的做法是：**把"入口"放到飞书，把"执行"留在本地，把"协作规则"沉淀成组织能力**。它不是再造一个聊天机器人，而是把你已经在用的 CLI Agent 接进一个可管理、可协作、可审计的组织操作台。

## 适合谁

- **个人**：已经在用 Claude Code / Codex CLI / Kimi CLI，希望通过手机或群聊远程使用它们。
- **小团队**：想把多个 AI session 管起来，而不是开一堆终端窗口靠记忆维护状态。
- **必须本地的团队**：想把 AI 协作从"个人工具"扩展到"组织工作流"，但代码、数据、凭证必须留在自己环境里。
- **想沉淀 SOP 的团队**：希望把好用的 skill、巡检、自动化沉淀下来，而不是每次都重写提示词和脚本。

## 不适合 / 现实约束

在 clone 之前，先确认这些约束你能接受：

- **目前长保活只在 macOS 验证过**。框架本身能在 Linux 跑，但 launchd 长保活脚本是 Mac-only；Linux/Windows 需要你自己接 systemd / 服务管理。
- **公司必须用飞书 / Lark**。机器人入口是飞书，企业微信、钉钉、Slack 不在范围。
- **需要一台机器长期在线**。session 工作区、SQLite、后端 CLI 都跑在你的本地，机器睡着了 session 也就睡着了。
- **不替你解决前置条件**：飞书企业权限、Claude/Codex/Kimi 账号登录、VPN/网络问题都要你自己搞定。
- **关键任务仍需要人审查**。Agent 的判断不会自动正确，可大可小的事情请保留 review 环节。
- **不是开箱即用的多租户 SaaS**。这是给你自己/小团队的本地操作系统，不是云服务。

## 快速开始

### 前置条件

跑 `npm run init` 之前，先确认下面 5 件事都已经就位：

| 项 | 要求 | 怎么验证 |
|---|---|---|
| 操作系统 | macOS（首选）/ Linux（核心 OK，守护进程自理） | `uname -s` |
| Node.js | ≥ 20 | `node -v` |
| 飞书 | 企业管理员权限，能创建内部应用 | 登录 [open.feishu.cn](https://open.feishu.cn/) 看是否能进开发者后台 |
| 后端 CLI | 至少装好并登录 1 个：Claude Code / Codex CLI / Kimi CLI | 各自 `claude --version` / `codex --version` |
| 网络 | 能稳定访问飞书 OpenAPI 和你选用的模型 API | 自己 ping 一下 |

### 三条命令

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public/supermatrix      # 进入框架本体（顶层是 monorepo：supermatrix/ + platform/ + docs/）
npm install
npm run init
```

`npm run init` 会进入 PersonalAgent 二维码向导：扫码创建/选择飞书/Lark 应用，自动绑定 lark-cli profile，完成用户授权，创建 `Super Matrix Console` 群，写入仓库根目录本地 `.env`，创建本地运行目录，并执行 `npm run self-check`。

### 启动

启动前加载根目录 `.env`：

```bash
set -a; source ../.env; set +a
npm start
```

启动后，在飞书/Lark root console 群里发送：

```text
/help
/status
/new claude alpha
```

`/new <backend> <name>` 会创建一个 session、对应飞书群和本地工作区。`/new claude alpha` 表示创建一个使用 Claude Code 的 `alpha` session；用 Codex 就改成 `/new codex alpha`。之后在 `alpha` 群里发普通消息，就是给这个 session 背后的 CLI 派任务。

如果希望 Super Matrix 长期保活，macOS 可以安装 localwatch：

```bash
./scripts/launchd/install.sh        # 装 launchd 守护
# 或临时前台跑：
./scripts/localwatch.sh
```

## 数据和安全边界

> 在你 clone 之前先看这段——这是最常被问的问题。

这个仓库是 Super Matrix 的**公开安全版本**，只包含脱敏后的源码、模板、SOP、测试和初始化文档。**不**包含 API key、真实飞书/Lark 对象 ID、聊天记录、业务仓库、SQLite 数据库、日志或原始 session 工作区。

这些内容只留在你的本机，永远不会通过这个仓库泄露出去：

- `.env`、`.env.local` 和所有 secrets
- 飞书/Lark App Secret、tenant token、user token、app credentials
- Claude / Codex / Kimi 或其它模型供应商 API key
- SQLite 数据库
- 日志、CSV/JSONL 导出、截图、媒体文件和生成报告
- session 工作区和业务仓库
- 本地 SSH key 和 GitHub deploy key

公开仓库是源码和可复用平台逻辑的**发布目标**，不是 runtime 镜像。完整脱敏边界见 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md)。

## 第一次使用：5 步验证

跑通核心闭环只需要 5 步——其他平台 session、scheduler、watchdog、autobitable 全部都是**可选**的，等你确实有痛点了再开。

1. `npm run self-check` 确认本机依赖、端口和基础配置。
2. `npm start` 启动 Super Matrix。
3. root console 群发 `/help`，确认机器人收得到消息也能回复。
4. 发 `/status`，确认 session 列表可读。
5. 发 `/new claude alpha`（或 `/new codex alpha`），然后进入新建的 `alpha` 群发一条普通消息，看 CLI 是否被正常派活。

> ⚠️ session 的代码执行发生在 `SM_WORKSPACE_ROOT` 下。不要把私有业务仓库或运行中产生的数据提交到公开仓库。

<details>
<summary>进阶：批量创建其余平台 session 群（可选）</summary>

> 这一步**不是首次使用必需**。你只在确认上面 5 步全部走通、并且确实想启用 scheduler / heartbeat / autobitable 等平台能力时再做。

建议再创建一个绑定到 Super Matrix 源码目录的根目录 session，让它自动完成剩余平台群的创建和检查。先在 root console 群里发：

```text
/new claude supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

用 Codex：

```text
/new codex supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

进入新建的 `Super Matrix Root` 群后，粘贴这段 prompt：

```text
你是 Super Matrix 初始化助手，当前工作区应绑定到仓库的 supermatrix/ 源码目录。

请自动完成剩余平台 session 群的建立和基础检查：
1. 先确认当前 cwd 是 supermatrix 源码目录，且 ../.env 存在；读取 SM_ROOT_GROUP_ID、SM_BACKEND、SM_WORKSPACE_ROOT。
2. 默认使用 SM_BACKEND 作为新 session backend；如果 SM_BACKEND 为空，用 claude。若我后续明确说使用 Codex，则全部改用 codex。
3. 通过 lark-cli 以 user 身份向 root console 群发送 /new 命令，创建这些平台 session，并绑定到对应公开目录：
   - first-principle -> ../platform/first-principle
   - scheduler -> ../platform/scheduler
   - heartbeat -> ../platform/heartbeat
   - autobitable -> ../platform/autobitable
   - watchdog -> ../platform/watchdog
   - skill-master -> ../platform/skill-master
4. 每条 /new 命令使用 --workdir 传绝对路径，使用 --chat-name 设置可读群名。
5. 不要创建业务 session，不要写入真实 API key、Bitable token、chat_id 或私有服务器地址。
6. 创建后运行 npm run self-check，并检查每个目录是否存在 README / docs / sop；缺少运行所需配置时只列出待补变量，不要编造值。
7. 最后回复我：创建了哪些群、哪些需要我手动授权或补 .env、localwatch 是否建议启用。
```

</details>

## 常用命令

斜杠命令是 Super Matrix 的本地控制面，不是 Claude/Codex 的原生命令代理。下面是日常 90% 会用到的几条：

| 命令 | 什么时候用 | 例子 |
|---|---|---|
| `/new <backend> <name>` | 创建一个新 session（同时开飞书群和本地工作区） | `/new claude alpha` |
| `/status` | 看全部 session 的状态 | 在 root console 群发 |
| `/cancel` | 打断当前 session 正在做的事 | session 跑偏了 / 想换方向 |
| `/reset` | 清空 session 的上下文重新开始 | session 已经被自己绕糊涂了 |
| `/next` | 排队一个下一步任务（等当前的做完再做） | 想让它做完手上的再处理新事 |
| `/btw` | 插入一句"顺便说一下"（不打断当前任务） | 给点上下文 / 提个小修正 |
| `/help` | 看完整命令列表 | 忘了具体语法 |

完整命令清单和参数见 [docs/COMMANDS.md](docs/COMMANDS.md)。

## 系统组成

```text
supermatrix/                 核心框架运行时（必装）
platform/first-principle/    Principles、身份模板、session 元数据和 FP SOP（可选）
platform/scheduler/          定时任务和任务生命周期服务（可选）
platform/heartbeat/          session 心跳、卡住检测和巡检工具（可选）
platform/socail-king/        跨 session 协调复盘工具（可选）  ← 注意：目录名暂时拼写为 socail-king
platform/mythos/             通用本地知识库模板和知识地图层（可选）
platform/autobitable/        飞书多维表格 webhook adapter 和台账同步（可选）
platform/watchdog/           自动提交巡检、跳过项处理和 repo 健康巡逻（可选）
platform/skill-master/       可复用 skill 注册、分发和评估工具（可选）
docs/                        初始化和配置说明
```

运行时主链路：

```text
飞书/Lark 群
  → Super Matrix API / CLI
  → 本地 SQLite 状态库
  → 本地 session 工作区
  → Claude Code / Codex / Kimi CLI
```

## 平台 session 八件套（全部可选）

> 这八个**都不是核心必装**——上面的 5 步验证只依赖核心 `supermatrix/`。下面这些是「平台同事」，等你撞到具体痛点（比如想做定时任务、想盯住卡住的 session、想把多维表格接成触发器）再开对应那一个就够了。
>
> 它们要真正跑起来通常还需要在 `.env` 里补额外配置（模型 API key、Bitable 表 ID、公网 webhook 地址等）。

| 名字 | 一句话 | 你会在什么时候用到 |
|---|---|---|
| `first-principle` | 把一次经验沉淀成所有 session 都能遵守的原则和身份模板。 | 你发现一条规则不应该只靠口头提醒，而应该写进 Principles / AGENTS / CLAUDE 模板。 |
| `scheduler` | 按 cron 在正确时间把任务点火给正确 session。 | 你想每天、每小时或按固定节奏让某个 session 自动执行一件事。 |
| `heartbeat` | 盯住"应该继续但停住了"的 session，并用受控方式推回正轨。 | 你不想一个明确任务因为超时、子任务 pending 或等待机械确认而静默烂尾。 |
| `autobitable` | 把飞书多维表格变成可审计、可暂停恢复的自动触发器。 | 你希望表格的一条记录、按钮或字段变化能触发本地脚本或某个 Agent。 |
| `watchdog` | 消化低风险维护事项，处理 daily-commit 和跳过项复核。 | 你希望小的 repo 噪音、自动提交异常、已知维护 issue 不再每次都打断人。 |
| `skill-master` | 维护 Claude Code / Codex 都能发现的共享 skill 注册表。 | 你想把一个好用 skill 从个人工作区变成团队可安装、可同步、可评估的能力。 |
| `socail-king` | 复盘跨 session 协作，把例外、失败和配合方式沉淀成可复用规则。 | 多个 session 接力后结果不清楚，或者协作链路出了问题，需要有人判定怎么收口。 |
| `mythos` | 维护可自定义的本地知识库模板，为任意领域的判断提供引用、来源和置信度。 | 你希望构建产品、写方案、做研究时，调用自己沉淀的本地知识，而不只是模型临场发挥。 |

### `first-principle`（原则管理员）

> "别让一次踩坑只停留在一次聊天里。"

负责 Super Matrix 的原则层：console / coding / business Principles、session 身份模板、类别规则和元数据同步。一个经验如果会影响多个 session 的行为，就不应该只写在某个对话里，而应该由它判断是更新原则、更新模板，还是只保留在某个 session 本地。

会做：管理 Principles 文档与 CLAUDE.md / AGENTS.md category 模板；评审 identity doc 的大改；周期性巡检，把新出现的协作规则、例外和事故教训同步回原则层。
不适合：执行具体业务任务；代替 framework owner 改核心代码。

### `scheduler`（定时点火器）

> "它不干活，它只负责准时把活交给该干的人。"

定时任务基础设施。"每天 03:15 跑 daily-commit"、"每 10 分钟触发 heartbeat"、"每周同步一次 skill 清单"这类事情交给它。它只关心任务定义、cron、执行历史、失败通知和 receipt proof，不关心目标 session 具体怎么完成业务。

会做：创建 / 查询 / 更新 / 删除 scheduled tasks；按 cron 调 `POST /api/spawn` 派发任务；持久化 run history、`last_success_at`、失败状态和收据校验；按 SOP 修复漏火、卡住 run 或孤儿任务。
不适合：写业务逻辑；绕过目标 session 的权限边界。

### `heartbeat`（防烂尾巡检）

> "不是催所有人干活，而是防止已经明确要做的事静默停住。"

Heartbeat 定时扫描开启心跳的 session，本地规则预筛后由控制模型判断，只在有明确证据时采取动作。

会做：巡检失败、超时、stale running、child pending 和 session error；维护 per-session todo pool；缺参数或需要真人选择时提醒用户，而非擅自推进；对可恢复中断发起 `user_resume` / `spawn_collect` / `spawn_execute`。
启用前需要额外配置 `SM_API_BASE`、`SM_DB_PATH`、`HEARTBEAT_SESSION`、控制模型 API key 等——详见 [Heartbeat 配置说明](docs/CONFIGURATION.md#heartbeat)。
不适合：替业务 session 做判断；在无证据时强行把已完成或正常 idle 的 session 拉起来。

### `autobitable`（飞书表格自动化入口）

> "把多维表格从记录面板，变成能触发 Agent 的操作台。"

把飞书多维表格里的记录、按钮或字段变化，接成可复用、可审计、可暂停恢复的 Super Matrix 自动触发链路。

会做：评审 webhook 接入需求；生成 `webhook_id` / secret / registry 记录和最小 POST contract；dry-run / live smoke 验证 endpoint / secret / 幂等 / receipt proof；管理 webhook 的暂停、恢复、废弃、secret 轮换。
使用前你需要准备：自己的公网域名和服务器 / 反向代理；本机或服务器上的 Super Matrix runtime。不要把真实 webhook secret / base token / table ID / 服务器地址写进仓库。

### `watchdog`（维护事项消化器）

> "能安全自己收掉的小事，就不要每次都把人叫回来。"

会做：维护本地 issue 队列（新增、领取、补齐验收、验证、归档、通知）；处理 daily auto-commit 的成功、失败、跳过和时间预算问题；区分 repo-local 噪音、源码风险、配置风险、数据风险和凭证风险；对属于其他 session 的问题用 `/api/spawn` 明确委派。
不适合：直接改业务仓库的高风险逻辑；用 `.gitignore` 掩盖源码 / 配置 / 数据 / 凭证问题。

### `skill-master`（共享 skill 注册表）

> "一个 skill 真正变成团队能力之前，得有人管它怎么被发现、安装和评估。"

会做：维护 `skills/INDEX.md` 和 `skills/<name>/` canonical 目录；按 Scope 同步到 Claude / Codex 两端的 skills 目录；检查 SKILL.md frontmatter / INDEX schema / 软链目标；记录 skill 调用并周期性评估。
不适合：替你写某个业务 skill 的正文；未经 owner 同意把别的 session 私有 skill 擅自迁入共享池。

### `socail-king`（跨 session 协作复盘）

> "多 Agent 协作不是喊人越多越好，关键是出问题后知道为什么。"

会做：分析 cross-session handoff / spawn 结果 / 异常闭环；把协作失败归因到 owner 边界、收据缺失、任务描述不清或平台规则缺口；给出下次委派 / 验证 / 收口的规则建议。
不适合：当普通执行 worker；绕过真正的业务 / 平台 owner。

### `mythos`（通用知识库模板）

> "把资料变成可调用的本地知识，而不是只存在聊天记录里。"

通用知识库模板。你可以自己定义主题、资料来源、概念结构和输出格式；其他 session 在做判断、生成内容或搭自动化时，可以从它这里取带来源和置信度的本地知识。

会做：捕获并归档资料 / 链接 / 文档 / 本地笔记；按主题维护综述、索引和引用；接受其他 session 查询，返回可追溯来源、摘要、置信度。
不适合：当唯一事实源（重要事实仍需人工或权威核验）；直接执行外部系统操作 / 改代码 / 高风险动作。

## 如何初始化配置（深入文档）

按 [docs/SETUP.md](docs/SETUP.md) 完成端到端初始化。它覆盖：

- 本机依赖：Node.js、npm、Git、Claude Code / Codex / Kimi CLI。
- PersonalAgent 二维码初始化：扫码创建/选择飞书/Lark 应用，并写入本地 `.env`。
- lark-cli 初始化：profile 绑定、用户授权、scope、root console 群创建。
- `.env`：自动生成 root group、owner、workspace、SQLite、backend、端口和本地 app 配置。
- 第一次启动：`npm run self-check`、`npm start`、可选 localwatch、`/help`、`/status`、`/new` 验证。
- 平台组件：scheduler、autobitable、watchdog、skill-master 等可选配置入口。

全部环境变量索引见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。核心运行时的模块级 setup 在 [supermatrix/docs/SETUP.md](supermatrix/docs/SETUP.md)。

## 常见问题

### 飞书/Lark 群里没有回复

先检查 lark-cli 是否登录、机器人是否在 root console 群里、应用是否启用了 WebSocket 事件订阅，以及 `SM_ROOT_GROUP_ID` 是否是正确的 `chat_id`。

### 为什么某个 session 只有 @ 机器人才响应？

Super Matrix 默认行为是：**普通 session 群可以直接发消息；只有 `category` 为 `外部` 的 session 才要求 @ 机器人**。

最常见的情况是 session 元数据被标成了 `外部`，把 category 改回内部即可，不要先去改飞书权限。如果它确实是内部 session 但仍然只有 @ 才响应，再依次检查飞书应用是否订阅了 `im.message.receive_v1`、机器人是否在群里、消息相关 scope 是否开通——权限变更后记得重做 lark-cli 授权。

详细排查步骤（含 SQL 查询）见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

### `npm run self-check` 失败

通常是 Node 版本、端口占用、`.env` 缺项、SQLite 路径不可写，或后端 CLI 未登录。先修 self-check 报出的**第一项**错误，再继续。

### `/new` 创建 session 后没有执行

检查 `SM_WORKSPACE_ROOT` 是否存在且可写、后端 CLI 是否能单独运行、当前选择的模型是否对你的账号可用。

### Codex 或 Claude 模型不可用

模型可用性取决于本机 CLI 版本、账号权限和配置。先用对应 CLI 做最小验证，再设置 `SM_CODEX_DEFAULT_MODEL` 或 `SM_CLAUDE_DEFAULT_MODEL`。

### 飞书权限报错

确认内部应用已经开通对应 scope，并重新执行 lark-cli auth。权限变更后通常需要重新授权。

### 公开仓库为什么没有我的 session 工作区

这是**设计边界**。session 工作区可能包含私有代码、业务数据、日志和凭证，只应保留在本机。

## 开发者入口

常用命令：

```bash
cd supermatrix
npm run typecheck
npm run test:unit
npm run test:adapters
npm run test:e2e
npm run verify
```

`src/` 是正式框架源码，`scripts/` 是本地操作、维护、迁移、验收和探测工具。`scripts/` 可以调用 `src/` 的模块；`src/` 不应把 `scripts/` 当作运行时依赖。

发布公开快照前，按 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) 的边界检查 secrets、私有链接、数据库、日志、大文件、媒体文件和生成产物。

## 关于

我是 Nacle，微信 `AtThePinnacle`，公众号「硅基山」，跨境 AI 人，实体和虚拟产品都做过，**不是程序员**。

Super Matrix 已经成为我们公司层面的操作系统，我们在上面构建了大量业务流程进行协同，并持续迭代。开源出来如果对你有帮助，给个 ⭐ 就行。有问题或建议，欢迎在 Issues / Discussions 里说一声。
