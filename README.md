# Super Matrix

**语言：** 中文 | [English](README.en.md)

把 Claude Code、Codex CLI、KIMI等agent cli接到飞书/Lark 上，并支持不同session之间通讯，让本来只能坐在电脑前操作的本地 AI 工具，变成你在手机、群聊和团队流程里随时能叫的执行者。

你可以在飞书里给 Codex 上写好plan，派claude去执行改代码任务，然后使用KIMI来进行review（过程中不需要复制粘贴prompt，可以用自然语言直接命令A session去找B session解决Bsession的问题）。

同时可以把飞书多维表格作为交互界面，展示 log、config、项目数据或运营信息，让你的 agent 深入融入到组织的飞书中，像一个可协作的本地操作系统一样工作。

## 为什么要用

如果你已经在用 Claude Code、Codex CLI 或类似本地 Agent，很快会遇到几个现实问题：

- 人不在电脑前时，终端里的 Agent 就不可用。
- 一个终端一个 Agent，任务多了以后很难知道谁在干什么、跑到哪一步、哪个工作区留下了改动。
- 团队成员很难把任务派给同一套 AI 工作流，也很难复用别人沉淀的提示词、SOP 和 skills。
- 团队每个人使用的都是自己的agent，协同还是靠人来进行沟通

Super Matrix 的做法是：把“入口”放到飞书，把“执行”留在本地，把“协作规则”沉淀成 session、scheduler、watchdog 和共享 skills。它不是再造一个聊天机器人，而是把你已经在用的 CLI Agent 接进一个可管理、可协作、可审计的工作台。

## 你能用它做什么

Super Matrix 的斜杠命令是本地控制面，不是 Claude/Codex 的原生命令代理。真正的价值不是记住命令，而是把本机 CLI Agent 变成飞书里的可调度成员：

- 随时调用本地 AI 工具：在飞书群里发任务，让本机或服务器上的 Claude Code / Codex CLI 接手执行。
- 给每个 Agent 一个长期身份：每个 session 都有名字、别名、群聊、工作区、后端 CLI、状态和任务记录。
- 把任务留在正确的工作区：Agent 改代码、跑脚本、读文档都发生在自己的本地目录里，方便你回来审 diff、跑测试、继续接手。
- 用群聊管理生命周期：`/new` 创建 Agent，`/status` 看状态，`/cancel` 打断当前任务，`/reset` 清空上下文，`/next` 和 `/btw` 处理排队或侧线问题。
- 让多个 Agent 协作：root console 可以把任务派给不同 session，让它们在各自工作区完成，再把结果带回主线。
- 把个人经验变成团队能力：共享 skills、SOP、Principles 和身份模板，让常用流程不再散落在个人提示词里。
- 接入飞书多维表格和自动化：autobitable 可以把表格 webhook 映射到本地脚本或 Agent 任务；scheduler、heartbeat、watchdog 可以做定时任务、卡住巡检和 daily-commit 复核。

## 适合谁

- 已经在用 Claude Code、Codex CLI、Kimi CLI 等本地 Agent，希望通过飞书远程使用它们的人。
- 希望把多个 AI session 管起来，而不是开一堆终端窗口靠记忆维护状态的个人或团队。
- 希望把 AI 协作从“个人工具”扩展到“组织工作流”，但又必须把代码、数据和凭证留在自己环境里的团队。
- 想沉淀共享 skills、SOP、巡检和自动化，而不是每次都重新写提示词和脚本的团队。

## 不能做什么

- 不能替你申请或配置飞书/Lark 企业权限。
- 不能替代 Claude、Codex、Kimi 等模型账号或 CLI 登录。
- 不能帮你解决VPN连接的问题
- 不能保证 Agent 的所有判断自动正确；关键任务仍需要人审查。
- 不能作为开箱即用的多租户云 SaaS 直接部署。

## 系统组成

```text
supermatrix/                 核心框架运行时
platform/first-principle/    Principles、身份模板、session 元数据和 FP SOP
platform/scheduler/          定时任务和任务生命周期服务
platform/heartbeat/          session 心跳、卡住检测和巡检工具
platform/socail-king/        跨 session 协调复盘工具
platform/mythos/             通用本地知识库模板和知识地图层
platform/autobitable/        飞书多维表格 webhook adapter 和台账同步
platform/watchdog/           自动提交巡检、跳过项处理和 repo 健康巡逻
platform/skill-master/       可复用 skill 注册、分发和评估工具
docs/                        初始化和配置说明
```

运行时的主要依赖关系是：

```text
飞书/Lark 群
  -> Super Matrix API / CLI
  -> 本地 SQLite 状态库
  -> 本地 session 工作区
  -> Claude Code / Codex / Kimi CLI
```

## 快速开始

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public/supermatrix
npm install
npm run init
```

`npm run init` 会进入 PersonalAgent 二维码向导：扫码创建/选择飞书/Lark 应用，自动绑定 lark-cli profile，完成用户授权，创建 `Super Matrix Console` 群，写入仓库根目录本地 `.env`，创建本地运行目录，并执行 `npm run self-check`。

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

`/new <backend> <name>` 会创建一个 session、对应飞书群和本地工作区。`/new claude alpha` 表示创建一个使用 Claude Code 的 `alpha` session；如果你使用的是 Codex，就改成 `/new codex alpha`。之后在 `alpha` 群里发送普通消息，就是给这个 session 背后的 Claude/Codex/Kimi CLI 派任务。

如果要创建 Codex session：

```text
/new codex alpha
```

如果希望 Super Matrix 由本机守护进程长期保活，macOS 可以安装 localwatch：

```bash
./scripts/launchd/install.sh
```

非 launchd 环境可以先直接运行：

```bash
./scripts/localwatch.sh
```

## 如何初始化配置

按 [docs/SETUP.md](docs/SETUP.md) 完成端到端初始化。它覆盖：

- 本机依赖：Node.js、npm、Git、Claude Code / Codex / Kimi CLI。
- PersonalAgent 二维码初始化：扫码创建/选择飞书/Lark 应用，并写入本地 `.env`。
- lark-cli 初始化：profile 绑定、用户授权、scope、root console 群创建。
- `.env`：自动生成 root group、owner、workspace、SQLite、backend、端口和本地 app 配置。
- 第一次启动：`npm run self-check`、`npm start`、可选 localwatch、`/help`、`/status`、`/new` 验证。
- 平台组件：scheduler、autobitable、watchdog、skill-master 等可选配置入口。

全部环境变量索引见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。核心运行时的模块级 setup 也保留在 [supermatrix/docs/SETUP.md](supermatrix/docs/SETUP.md)。

## 第一次使用

建议按这个顺序验证：

1. `npm run self-check` 确认本机依赖、端口和基础配置。
2. `npm start` 启动 Super Matrix。
3. 在 root console 群发送 `/help`，确认机器人能收到消息并回复。
4. 发送 `/status`，确认 session 列表和运行状态可读。
5. 发送 `/new claude alpha` 或 `/new codex alpha`，确认工作区、飞书群和后端 CLI 可以正常创建 session。
6. 进入新建的 session 群发送一条普通消息，确认它会作为任务交给后端 CLI 执行。

session 的代码执行发生在 `SM_WORKSPACE_ROOT` 下。不要把私有业务仓库或运行中产生的数据提交到公开仓库。

建议再创建一个绑定到 Super Matrix 源码目录的根目录 session，用它自动完成剩余平台群的创建和检查。先在 root console 群发送其一：

```text
/new claude supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

如果用 Codex：

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

## 数据和安全边界

这个仓库是 Super Matrix 的公开安全版本，只包含脱敏后的源码、模板、SOP、测试和初始化文档；不包含 API key、真实飞书/Lark 对象 ID、聊天记录、业务仓库、SQLite 数据库、日志或原始 session 工作区。

这些内容必须只留在本机：

- `.env`、`.env.local` 和所有 secrets
- 飞书/Lark App Secret、tenant token、user token 和 app credentials
- Claude、Codex、Kimi 或其它模型供应商 API key
- SQLite 数据库
- 日志、CSV/JSONL 导出、截图、媒体文件和生成报告
- session 工作区和业务仓库
- 本地 SSH key 和 GitHub deploy key

公开仓库是源码、模板和可复用平台逻辑的发布目标，不是 runtime 镜像。发布边界见 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md)。

## 平台型 session

这些不是具体项目的执行 agent，而是 Super Matrix 里的“平台同事”。它们不直接替你完成某个领域交付，而是负责把多 Agent 协作这件事管起来：谁有权限改规则，谁负责定时点火，谁盯住卡住的任务，谁把飞书表格接成自动化入口，谁把本地知识沉淀成可调用的上下文。

注意：这个公开仓库包含这些平台 session 的代码和模板，但 `npm run init` 只会完成核心 Super Matrix 与飞书/Lark 的基础初始化。下面这些平台能力要真正跑起来，通常还需要在本机 `.env` 里补额外配置，例如模型 API key、Super Matrix API 地址、Bitable 表 ID、公网 webhook 地址，或者由 scheduler 创建定时任务。

| 名字 | 一句话 | 你会在什么时候用到 |
|---|---|---|
| `first-principle` | 把一次经验沉淀成所有 session 都能遵守的原则和身份模板。 | 你发现一条规则不应该只靠口头提醒，而应该写进 Principles / AGENTS / CLAUDE 模板。 |
| `scheduler` | 按 cron 在正确时间把任务点火给正确 session。 | 你想每天、每小时或按固定节奏让某个 session 自动执行一件事。 |
| `heartbeat` | 盯住“应该继续但停住了”的 session，并用受控方式推回正轨。 | 你不想一个明确任务因为超时、子任务 pending 或等待机械确认而静默烂尾。 |
| `autobitable` | 把飞书多维表格变成可审计、可暂停恢复的自动触发器。 | 你希望表格的一条记录、按钮或字段变化能触发本地脚本或某个 Agent。 |
| `watchdog` | 消化低风险维护事项，处理 daily-commit 和跳过项复核。 | 你希望小的 repo 噪音、自动提交异常、已知维护 issue 不再每次都打断人。 |
| `skill-master` | 维护 Claude Code / Codex 都能发现的共享 skill 注册表。 | 你想把一个好用 skill 从个人工作区变成团队可安装、可同步、可评估的能力。 |
| `socail-king` | 复盘跨 session 协作，把例外、失败和配合方式沉淀成可复用规则。 | 多个 session 接力后结果不清楚，或者协作链路出了问题，需要有人判定怎么收口。 |
| `mythos` | 维护可自定义的本地知识库模板，为任意领域的判断提供引用、来源和置信度。 | 你希望在构建产品、流程、研究或自动化时，快速调用自己沉淀的本地知识，而不是只靠模型临场发挥。 |

### `first-principle`（原则管理员）

> “别让一次踩坑只停留在一次聊天里。”

它负责 Super Matrix 的原则层：console / coding / business Principles、session 身份模板、类别规则和元数据同步。一个经验如果会影响多个 session 的行为，就不应该只写在某个对话里，而应该由它判断是更新原则、更新模板，还是只保留在某个 session 本地。

它会做什么：

- 管理 Principles 文档和 CLAUDE.md / AGENTS.md category 模板。
- 评审 identity doc 的大改，避免某个 session 偷偷改掉平台共识。
- 做周期性巡检，把新出现的协作规则、例外和事故教训同步回原则层。

不适合：

- 让它执行具体业务任务。
- 让它代替 framework owner 改核心代码。

### `scheduler`（定时点火器）

> “它不干活，它只负责准时把活交给该干的人。”

它是定时任务基础设施。你可以把“每天 03:15 跑 daily-commit”“每 10 分钟触发 heartbeat”“每周同步一次 skill 清单”这类事情交给它。它关心的是任务定义、cron、执行历史、失败通知和 receipt proof，不关心目标 session 具体怎么完成业务。

它会做什么：

- 创建、查询、更新、删除 scheduled tasks。
- 按 cron 调 `POST /api/spawn`，把任务派发给目标 session。
- 持久化 run history、`last_success_at`、失败状态和收据校验。
- 发现漏火、卡住 run 或孤儿任务时按 SOP 修复。

不适合：

- 让它写业务逻辑。
- 用它绕过目标 session 的权限和职责边界。

### `heartbeat`（防烂尾巡检）

> “不是催所有人干活，而是防止已经明确要做的事静默停住。”

Heartbeat 会定时扫描开启心跳的 session。它先用本地规则预筛，再把候选状态交给控制模型判断，只在有明确证据时采取动作。比如 run 失败、超时、子任务挂太久、原 session 已经有清晰下一步但卡在机械确认点，它会提醒、收集证据、注入恢复待办或推动 session 继续。

启用前需要额外配置：

- Super Matrix 本地 API：`SM_API_BASE`，默认 `http://localhost:3501`。
- Super Matrix 主库：`SM_DB_PATH`，用于读取 session / run / heartbeat 状态。
- heartbeat 自身 session：默认 `HEARTBEAT_SESSION=heartbeat`，需要存在对应 session 和工作区。
- 控制模型 API：默认 `HEARTBEAT_CONTROLLER_PROVIDER=minimax`，需要 `HEARTBEAT_MINIMAX_API_KEY` 或 `MINIMAX_API_KEY`。
- 定时触发：通常由 `scheduler` 每 10 分钟调用 `platform/heartbeat/scripts/heartbeat-patrol`。
- 可选飞书日志表：如果要同步触发事件，需要配置 `HEARTBEAT_LOG_FEISHU_BASE_TOKEN` 和 `HEARTBEAT_LOG_FEISHU_TABLE_ID`。

它会做什么：

- 巡检失败、超时、stale running、child pending 和 session error。
- 维护 per-session todo pool，支持合批和恢复型待办。
- 在缺参数或需要真人选择时提醒用户，而不是擅自推进。
- 对可恢复的中断发起 `user_resume`、`spawn_collect` 或 `spawn_execute`。

不适合：

- 替业务 session 做判断。
- 在没有明确证据时强行把已完成或正常 idle 的 session 拉起来。

### `autobitable`（飞书表格自动化入口）

> “把多维表格从记录面板，变成能触发 Agent 的操作台。”

它负责把飞书多维表格里的记录、按钮或字段变化，接成可复用、可审计、可暂停恢复的 Super Matrix 自动触发链路。比如一条表格记录状态变成“待处理”，自动 spawn 某个 session；或者一个按钮触发本地脚本，把结果写回台账。

它会做什么：

- 评审 webhook 接入需求，明确 owner、target、触发条件、副作用和成功证明。
- 生成 `webhook_id`、secret、registry 记录和最小 POST contract。
- 做 dry-run / live smoke，验证 endpoint、secret、幂等和 receipt proof。
- 管理 webhook 的暂停、恢复、废弃、secret 轮换和变更后重新验收。

使用前你需要准备：

- 自己的公网域名和服务器 / 反向代理。
- 本机或服务器上的 Super Matrix runtime。
- 不要把真实 webhook secret、base token、table ID 或服务器地址写进仓库。

### `watchdog`（维护事项消化器）

> “能安全自己收掉的小事，就不要每次都把人叫回来。”

Watchdog 负责低风险维护 issue、daily-commit、跳过项复核和 repo 健康巡逻。它的价值不是替业务 session 作决策，而是把明确、低风险、可验证的小维护推进到闭环，并把真正需要 owner 判断的东西留下证据后再转派。

它会做什么：

- 维护本地 issue 队列：新增、领取、补齐验收、验证、归档和通知。
- 处理 daily auto-commit 的成功、失败、跳过和时间预算问题。
- 区分 repo-local 噪音、源码风险、配置风险、数据风险和凭证风险。
- 对属于其他 session 的问题，用 `/api/spawn` 明确委派并跟踪结果。

不适合：

- 让它直接改业务仓库的高风险逻辑。
- 用 `.gitignore` 掩盖源码、配置、数据或凭证问题。

### `skill-master`（共享 skill 注册表）

> “一个 skill 真正变成团队能力之前，得有人管它怎么被发现、安装和评估。”

它维护 canonical skill 池和跨后端注册表，让 Claude Code 与 Codex 都能发现同一批共享 skills。单个 skill 的内容归原作者或 owner，skill-master 负责登记、软链部署、双端可见性、使用记录、评估和飞书多维表格同步。

它会做什么：

- 维护 `skills/INDEX.md` 和 `skills/<name>/` canonical 目录。
- 按 Scope 同步到 Claude / Codex 两端的 skills 目录。
- 检查 SKILL.md frontmatter、INDEX schema 和软链目标。
- 记录 skill 调用，周期性评估哪些 skill 真有用、哪些该下线或调整。

不适合：

- 让它替你写某个业务 skill 的正文。
- 未经 owner 同意，把别的 session 私有 skill 擅自迁入共享池。

### `socail-king`（跨 session 协作复盘）

> “多 Agent 协作不是喊人越多越好，关键是出问题后知道为什么。”

它负责复盘跨 session 协作链路。比如一个任务被多次 spawn、结果没有回到调用方、某个 owner 边界不清，或者几个 session 对同一个问题给出冲突判断，它会帮你把协作模式、例外和收口规则沉淀下来。

它会做什么：

- 分析 cross-session handoff、spawn 结果和异常闭环。
- 把协作失败归因到 owner 边界、收据缺失、任务描述不清或平台规则缺口。
- 给出下次应该怎么委派、怎么验证、怎么收口的规则建议。

不适合：

- 让它当普通执行 worker。
- 用它绕过真正的业务 owner 或平台 owner。

### `mythos`（广目天王 / 通用知识库模板）

> “把资料变成可调用的本地知识，而不是只存在聊天记录里。”

Mythos 是一个通用知识库模板。你可以自己定义主题、资料来源、概念结构和输出格式；它可以归档论文、文档、repo、网页、SOP、产品资料或任何领域素材，并在其他 session 构建产品、写方案、做判断、生成内容或搭自动化时，提供带来源和置信度的本地知识。AI / agent 工程知识库只是其中一种用法，不是唯一用途。

它会做什么：

- 捕获并归档用户指定的资料、链接、文档和本地笔记。
- 按用户定义的主题、概念或 collection 维护综述、索引和引用。
- 接受其他 session 查询，返回可追溯来源、摘要、置信度和可复用判断。
- 把某一领域的知识作为上下文，注入产品、流程、研究或自动化任务。

不适合：

- 把它当唯一事实源；重要事实仍需要人工或权威来源核验。
- 让它直接执行外部系统操作、改代码或处理高风险动作。

## 常见问题

### 飞书/Lark 群里没有回复

先检查 lark-cli 是否登录、机器人是否在 root console 群里、应用是否启用了 WebSocket 事件订阅，以及 `SM_ROOT_GROUP_ID` 是否是正确的 `chat_id`。

### 为什么某个 session 只有 @ 机器人时才响应？

先判断这是“被框架过滤”还是“飞书没有把普通消息投递过来”。

Super Matrix 的默认行为是：普通 session 群可以直接发消息；只有 `category` 为 `外部` 的 session 会要求明确 @ 机器人。卡卡西定位过的修复点在 `supermatrix/src/app/dispatcher.ts`：`外部` session 的 mention gate 会忽略未 @ 消息；lark-cli 侧则在 `supermatrix/src/adapters/lark-cli/realClient.ts` 里通过 `eventMentionsBot()` / `messageMentionsBot()` 判断消息是否 @ 了机器人。

排查顺序：

```bash
sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT s.name,s.category,s.status,b.group_id
   FROM sessions s JOIN bindings b ON b.session_id=s.id
   WHERE s.name='<session-name>' OR b.group_id='<chat-id>';"
```

- 如果 `category` 是 `外部`，这是预期行为：未 @ 的消息会被静默忽略。
- 如果它应该是内部 session，但被标成了 `外部`，先修 session 元数据，不要优先改飞书权限。
- 如果 `category` 不是 `外部` 仍然只有 @ 才响应，再检查飞书/Lark 入口：应用是否订阅 `im.message.receive_v1`，机器人是否被加入对应群，是否已开通消息发送/读取、群信息读取、群成员读取等权限，并在权限变更后重新执行 lark-cli 授权。
- 如果日志里完全没有 inbound，优先查飞书事件订阅和机器人权限；如果有 inbound 但无回复，再查 dispatcher 和 session 状态。

### `npm run self-check` 失败

通常是 Node 版本、端口占用、`.env` 缺项、SQLite 路径不可写，或后端 CLI 未登录。先修复 self-check 报出的第一项错误。

### `/new` 创建 session 后没有执行

检查 `SM_WORKSPACE_ROOT` 是否存在且可写，后端 CLI 是否能单独运行，以及当前选择的模型是否对你的账号可用。

### Codex 或 Claude 模型不可用

模型可用性取决于本机 CLI 版本、账号权限和配置。先用对应 CLI 做最小验证，再设置 `SM_CODEX_DEFAULT_MODEL` 或 `SM_CLAUDE_DEFAULT_MODEL`。

### 飞书权限报错

确认内部应用已经开通对应 scope，并重新执行 lark-cli auth。权限变更后通常需要重新授权。

### 公开仓库为什么没有我的 session 工作区

这是设计边界。session 工作区可能包含私有代码、业务数据、日志和凭证，只应保留在本机。

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

`src/` 是正式框架源码，`scripts/` 是本地操作、维护、迁移、验收和探测工具。`scripts` 可以调用 `src` 的模块；`src` 不应把 `scripts` 当作运行时依赖。

发布公开快照前，按 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) 的边界检查 secrets、私有链接、数据库、日志、大文件、媒体文件和生成产物。

🌟 关于
我是Nacle，WX：AtThePinnacle，公众号「硅基山」、跨境AI人。大厂商分出身，实体虚拟产品都做过，不是程序员。

Supermatrix已经成为我们公司层面的操作系统，我们在上面构建了大量的业务流程，进行协同，并持续进行迭代。开源出来如果对你有帮助，给个 ⭐ 就行。有问题或建议，欢迎在 Issues / Discussions 里说一声。
