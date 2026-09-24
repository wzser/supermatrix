# Super Matrix

**语言：** 中文 | [English](README.en.md)

Super Matrix 将本地 CLI Agent 接入飞书/Lark，为每个会话保留独立群聊、工作区、上下文和运行状态。代码与凭据由使用者自己的机器和账号管理。

产品版本：`v0.3.2`。安装文档版本：**Agent Installation 1.2.0**。两者是不同版本号；这不是 GitHub `v1.0.0`，也不代表维护者整套私有平台均已开源。

## 安装入口

把 [AGENT_INSTALL.md](AGENT_INSTALL.md) 和 [v0.3.2 Release](https://github.com/wzser/supermatrix/releases/tag/v0.3.2) 中的同版本代码归档交给你自己的 agent。文档要求先核对 Release、tag、资产 digest 与 `SHA256SUMS`，再安装；不要以 `main`、GitHub 自动源码包或旧安装目录代替。

只有这一条安装路径。Agent 使用已有 CLI、配置文件与系统服务完成工作，不需要再开发安装器。**任何报错、疑问、中断或换 agent，都先回到该文档的 R 节处理；不得跳过检查或从维护者机器复制配置。**

首轮支持范围为 macOS Apple Silicon、Codex 运行后端。安装者自己的 agent 可以使用其他产品。具体依赖版本、隔离目录、端口、权限和命令由安装文档锁定。账号登录、租户审批、公网入口授权及重启仍需要本人配合，不能由一个“已安装”提示替代。

## 许可证

除 [NOTICE](NOTICE) 或各文件自身许可证另有说明的第三方材料外，本仓库的项目自有代码和文档按 **MIT OR Apache-2.0** 双授权发布。可任选适用 [MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)；根 [LICENSE](LICENSE) 说明此选择。第三方材料继续适用其原有许可证和 notices。

## 新增的平台能力

v0.3.2 修复 onboarding-v1 的 Lark CLI exit-zero JSON 判定、bot 身份读回和 provider-routed Claude 探针预算；不新增平台、安装器或授权能力。

## 更新的平台能力

- **发布合同**：安装文档继续保持 57 项检查和 Agent Installation 1.2.0 合同，但明确绑定同版本的 `v0.3.2` tag、归档、校验清单和解压前缀。
- **公开包边界**：根目录与 `platform/gitmaster/public-release/` 都携带 MIT、Apache-2.0 和第三方 notices 输入，构建器用精确 allowlist 与回归测试校验这两处字节闭合。
- **脱敏发布**：本补丁从已发布的 v0.3.1 快照出发，只纳入指定 onboarding-v1 三文件修复及发布层版本/安装元数据；其他平台文件保持原字节。

## 从 v0.3.1 升级

已完成的 v0.3.1 隔离安装不需要 runtime 迁移或重新授权。新安装必须使用 v0.3.2 的 `AGENT_INSTALL.md`、`supermatrix-v0.3.2.tar` 和 `SHA256SUMS`；不要混用旧 Release 资产。继续保留既有凭据、数据库、生产表记录和事件订阅，任何清理都需要单独授权。

从更早版本首次迁入时，仍采用新的隔离安装：不得复制旧 `.env`、凭据、数据库、生产表记录或事件订阅。先按安装文档验证新实例，再另行决定是否停止或清理旧实例。

## 公开模块与边界

核心位于 `supermatrix/`。`platform/` 包含身份/原则、Scheduler v2、Heartbeat、Watchdog、Autobitable、Skill-master、Localgit、协作复盘、公共知识库、Gitmaster 和 Lark 支撑模块；另有不建额外群的表格队列支撑模块。准确清单、每项入口和验收见安装文档 M/B/N/L。

S5 只负责核心及调度器等已声明启动项，不会因为复制了模块就自动启用所有功能。条件镜像或外部服务必须明确配置和实测，不能因配置失败就悄悄跳过。完整业务看板、设备维护、私有知识、全量治理和其他运行后端不属于本次安装保证。

这是受约束的首轮发布，不是多租户 SaaS。软件测试、归档校验、干净环境准备与本人账号下的真实验收是不同证据。只有安装文档规定的各平台检查和六项 live 验收均完成，接收方 agent 才能报告 `VERIFIED`；缺授权或未验证的能力必须明确报告。

## 数据与安全

发行包排除凭据、私人姓名/联系方式/产品信息、真实租户资源、运行数据库、业务日志、依赖缓存和私有工作区。保留的例子、公共知识与静态 JSON 均来自精确准入，不包含生产数据。源/目标哈希及扫描范围见 [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md)。

扫描零发现只说明所用检测规则未发现问题，不是绝对无泄漏保证。疑似凭据应立即撤销或轮换；删除 Git 历史不能替代凭据处理。

版本详情见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。开发者可在 `supermatrix/` 运行 `npm run typecheck`、`npm run lint:deps` 及分层测试；这些命令不能替代安装文档中的现场验收。
