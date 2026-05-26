# Skills Index

两端（Claude Code + Codex CLI）所有可自动发现 skill 的登记表。本地维护，飞书 Bitable 做同步（post-commit 自动）。

## Origin 语义

| Origin | 含义 |
|--------|-----|
| `skill-master` | 由 skill-master canonical 池管理（`skills/<name>/` 下有实体），通过 `sync-skills.sh` 建软链到两端 |
| `claude-builtin` | claude 端自动可用、非 skill-master 管理（Anthropic 官方 slash command、SM framework 自定义等）。只登记不部署 |
| `codex-builtin` | codex 端自动可用、非 skill-master 管理（codex 框架自带、CodexSkills 仓库第三方等）。只登记不部署 |

## Scope 语义

| Scope | 软链部署目标 | 适用情况 |
|-------|------------|---------|
| `shared` | `~/.claude/skills/` + `~/.agents/skills/` | Origin=skill-master 且两端语义一致 |
| `claude-only` | `~/.claude/skills/` | 只在 claude 端可见（skill-master 单端部署、或 Origin=claude-builtin） |
| `codex-only` | `~/.agents/skills/` | 只在 codex 端可见（skill-master 单端部署、或 Origin=codex-builtin） |
| `inventory-only` | 不部署 | 登记但不建软链（历史 skill、占位、暂未激活的第三方等） |

**部署规则**：`sync-skills.sh` 只对 `Origin=skill-master` 且 `Scope ∈ {shared, claude-only, codex-only}` 的行建软链。其他行只进飞书登记表，不做文件操作。

**新增 / 迁移 skill**：参考 `sop/add-shared-skill.md`。

**未登记范围**：以下两类框架级 skill 包不进 INDEX.md，也不走 `sync-skills.sh` —— 它们各自有独立的安装/升级机制，强制收编反而会破坏其工具链。

- **superpowers 系列**（含 `superpowers:*` 前缀及无前缀衍生如 `brainstorming` / `dispatching-parallel-agents` / `executing-plans` / `test-driven-development` 等）—— 不进 INDEX 也不走 sync-skills.sh，但 skill-master 可直接编辑其 SKILL.md 内容。
- **gstack 系列**（`gstack` + `gstack-*` 前缀，46+ skill，安装于 `~/.claude/skills/gstack/` 并由其自带 `setup` 脚本软链到 `~/.claude/skills/gstack-*/` 与 `~/.codex/skills/gstack-*/`）—— 用 `cd ~/.claude/skills/gstack && ./setup --host <claude|codex> --prefix` 升级；用其自带 `bin/gstack-uninstall` 卸载。

## Skills

| Name | Origin | Scope | Owner | Purpose |
|------|--------|-------|-------|---------|
| skill-probe | skill-master | shared | skill-master | 跨后端 skill 自动发现机制的探针；触发词 `ping skill-probe` |
| smallmodel-manager | skill-master | shared | skill-master | 本地模型 endpoint 注册表，为任务选型并输出直连参数（api_key/base_url/pricing/network） |
| email-admin | skill-master | shared | skill-master | 通过 IMAP/SMTP 管理托管邮箱：按项目路径鉴权、本地归档 .eml、受控收发 |
| web-access | skill-master | shared | skill-master | 基于托管 Chrome profile (CDP) 的分层浏览器自动化：soft-routing 到 generic / amzlisting / amzh10 |
| sorftime-amazon-data | skill-master | shared | amzdata | Sorftime MCP：Amazon / TikTok / 1688 市场数据查询（42 工具，商品 / 关键词 / 类目 / 竞品 / 选品），合并自 codex sorftime-mcp |
| lingxing-openapi | skill-master | shared | skill-master | 领星 OpenAPI 客户端：ABA 下载、广告报表、ASIN 诊断、listing 发布，走白名单 server / HTTPS relay |
| excalidraw-diagram | skill-master | shared | skill-master | Excalidraw JSON 生成：把工作流 / 架构 / 概念做成会"论证"的可视化图，含 Playwright 渲染回环 |
| get-image-url | skill-master | shared | skill-master | S.EE 图床上传：本地文件 → 公开 URL + metadata（page / delete_url / file_id / hash），供 lingxing-openapi 等 skill 复用 |
| first-principle | skill-master | shared | skill-master | 把当前对话中有价值的内容沉淀到 Principles 文档，投请求到 first-principle session requests 队列（跨 claude / codex） |
| nas-sucai | skill-master | shared | nas | 通过 FTPS 访问公司 NAS 素材库：列目录、搜素材、下载、上传、建目录、改名 |
| ziniao-assistant | skill-master | shared | ziniao | 通过本地 ZClaw / Ziniao bridge 操作紫鸟浏览器：店铺打开、页面访问、内容读取、点击输入、截图和自动化 |
| plan-execution-kit | skill-master | shared | skill-master | 把已落地的 plan 通过 SuperMatrix 4-模式（inline/混选/全 Codex/全 Claude）跑起来，桥接复用 yolo 的 allocation gate + 反向 backend verifier，零 yolo 侧改动 |
| claude-api | claude-builtin | claude-only | anthropic | Claude API / Anthropic SDK 开发辅助（prompt caching、模型迁移等） |
| init | claude-builtin | claude-only | anthropic | 初始化当前项目的 CLAUDE.md |
| review | claude-builtin | claude-only | anthropic | Review 一个 pull request |
| security-review | claude-builtin | claude-only | anthropic | 针对当前 branch 的待提交改动做安全评审 |
| update-config | claude-builtin | claude-only | anthropic | 调整 claude code settings.json（hooks / permissions / env） |
| less-permission-prompts | claude-builtin | claude-only | anthropic | 扫描转录，给项目 .claude/settings.json 加只读工具白名单以减少权限弹窗 |
| keybindings-help | claude-builtin | claude-only | anthropic | 自定义 `~/.claude/keybindings.json` |
| loop | claude-builtin | claude-only | anthropic | 周期性跑某个 prompt / slash command |
| schedule | claude-builtin | claude-only | anthropic | 基于 cron 的远程 agent 触发器 |
| simplify | claude-builtin | claude-only | anthropic | 对改动过的代码做复用、质量、效率维度的评审并修复 |
| amz-sql | codex-builtin | codex-only | CodexSkills/amz-sql | codex-only 占位 skill，正文空壳，未接入跨端同步 |
| feishu-bitable | codex-builtin | codex-only | CodexSkills/feishu-bitable | codex-only lark-cli 包装层，依赖上游 lark-* skill 生态，暂不跨端同步 |
| imagegen | codex-builtin | codex-only | codex | codex 框架自带：图像生成 |
| openai-docs | codex-builtin | codex-only | codex | codex 框架自带：OpenAI 相关文档查询 |
| plugin-creator | codex-builtin | codex-only | codex | codex 框架自带：插件创建脚手架 |
| skill-creator | codex-builtin | codex-only | codex | codex 框架自带：skill 创建脚手架 |
| skill-installer | codex-builtin | codex-only | codex | codex 框架自带：skill 安装器 |
| diagnose | skill-master | shared | mattpocock | 硬 bug / 性能回归的纪律化诊断循环：repro → minimise → hypothesise → instrument → fix → regression-test |
| grill-with-docs | skill-master | shared | mattpocock | 把 plan 跟项目 CONTEXT.md / ADR 对齐,边追问边沉淀决策 |
| improve-codebase-architecture | skill-master | shared | mattpocock | 基于 CONTEXT 语言与 ADR 决策，发现重构 / 深化 / AI 导航性改进机会 |
| prototype | skill-master | shared | mattpocock | 写一次性 prototype 探设计：终端 app 验证 state/logic 或多 UI 变体并排 |
| setup-matt-pocock-skills | skill-master | shared | mattpocock | 初始化 issue tracker / triage labels / 文档布局，作为 mattpocock 其余 skill 的前置 |
| tdd | skill-master | shared | mattpocock | red-green-refactor 测试驱动开发循环 |
| to-issues | skill-master | shared | mattpocock | 把 plan / PRD 切成可独立认领的 issues（tracer-bullet 垂直切片） |
| to-prd | skill-master | shared | mattpocock | 把当前对话上下文凝练成 PRD 并发到 issue tracker |
| triage | skill-master | shared | mattpocock | 用状态机 + triage 角色处理 issue |
| zoom-out | skill-master | shared | mattpocock | 让 agent 退到大局视角，解释当前代码段如何嵌入全局 |
| caveman | skill-master | shared | mattpocock | 超压缩通信模式（节省 ~75% token），保留技术准确性 |
| grill-me | skill-master | shared | mattpocock | 把 plan / design 追问到共同理解，逐分支推进决策树 |
| handoff | skill-master | shared | mattpocock | 把当前对话压成 handoff 文档供下一个 agent 接手 |
| write-a-skill | skill-master | shared | mattpocock | 创建新 skill：结构、渐进披露、资源打包 |
| git-guardrails-claude-code | skill-master | claude-only | mattpocock | 装 Claude Code hooks 拦截危险 git 命令（push / reset --hard / clean / branch -D 等） |
| migrate-to-shoehorn | skill-master | shared | mattpocock | 把测试里的 `as` 断言迁移到 @total-typescript/shoehorn |
| scaffold-exercises | skill-master | shared | mattpocock | 搭课程练习目录（sections / problems / solutions / explainers） |
| setup-pre-commit | skill-master | shared | mattpocock | 装 Husky pre-commit hooks：Prettier / 类型检查 / 测试 |
| weread | skill-master | shared | skill-master | 微信读书助手：搜书 / 书架 / 笔记划线 / 书评 / 阅读统计 / 推荐，走 Agent API Gateway（需 WEREAD_API_KEY 环境变量） |
