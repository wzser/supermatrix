# Feishu Wiki 目录管理规则 v1.0

> 本规则由 first-principle session 遵循，管理 Supermatrix wiki 目录树。
> 规则根据人工反馈持续优化。

## 目标空间

| 字段 | 值 |
|------|-----|
| space_id | `<MYTHOS_SPACE_ID>` |
| 根节点 token | `UuMCwtd6Li90OPkuStjcSKhjnYf` |
| 根节点标题 | Supermatrix |
| 根节点 URL | https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN> |

## 根下五个固定 Bucket

| Bucket | 用途 |
|--------|------|
| `Agent菜单` | 每个 agent 一页的 hub 入口页。一个 agent 最多一个菜单页 |
| `Supermatrix知识库` | 跨 agent 的知识库 & 标准。含 FP 自己的 Principles（`FirstPrinciple/` 子树）、各 agent 的 KB、共享业务知识 |
| `AgentSOP` | 按 agent 分组的操作型 SOP 集合（runbook / 操作流程） |
| `Agent数据` | 跨 agent 的业务 bitable 库。每个 session 在 `Agent数据/<agent>/` 下放自己的业务表（线索/订单/工单/跟进队列等"活数据"） |
| `agent临时` | 归属不明的待定位文档。由 FP 定期 triage（见 §5） |

新建根下 bucket 属于结构性调整，**必须用户显式授权**，FP 不自行创建。

**`Agent数据` vs `AgentSOP` 的边界**：bitable 既可以 colocate 在自家 SOP 子树里（email-admin 先例），也可以放进 `Agent数据`。判断准则——bitable 仅服务本 session 的 SOP（如 email-admin local records）→ 留在 `AgentSOP/<agent>/`；bitable 是跨 session 可读/可协作的业务数据（如 after-sales follow-up）→ 放进 `Agent数据/<agent>/`。两条路径都合规，按可见性需求选。

## §1. 请求受理

请求通道：
- HTTP spawn（其他 session 调 FP）
- 飞书直接对话 FP（用户或 agent 群）

请求方应提供：
- **文档用途**（SOP / KB / menu / 其他）
- **所属 agent 或主题**（若有）
- **（可选）建议位置**

若缺信息 → 反问一次；仍不清楚 → 先放 `agent临时/` 并附注。

## §2. 归类决策（四分法）

| 用途 | 归属 | 命名前缀 |
|------|------|----------|
| 运营手册 / 操作流程 | `AgentSOP/<agent>/` | `SOP / <name>` |
| 知识 / 资料 / 参考 | `Supermatrix知识库/<agent-or-topic>/` | `KB / Map` / `KB / Sources` / `KB / Charter` 三件套优先；其他主题页直接 `<主题>` |
| Agent 唯一入口页 | `Agent菜单/<agent-name>` | 无前缀，直接 agent 名 |
| 运行记录 / 实例日志 | 与对应 SOP 同级 | `Run <YYYY-MM-DD> <run-id> <suffix>` |
| 不明确 | `agent临时/` 顶层 | `[TBD] <简述>` |

**Agent 名约定**：以 SuperMatrix sessions 表里的 `name` 字段为准（如 `scheduler`、`watchdog`、`ads-master`）。历史遗留的中文别名（如 `广告大师adsmater`）不强制统一，但新建节点用规范名。

## §3. 创建流程

1. **先探查**：`lark-cli wiki nodes list --params '{"space_id":"<MYTHOS_SPACE_ID>","parent_node_token":"<父token>","page_size":50}' --page-all`
2. **查重**：若目标父节点下已有同名或近义节点 → 不新建，返回现有节点 URL
3. **父节点缺失**：
   - 缺一级 agent 节点（如 `AgentSOP/<new-agent>`）→ 先告知用户，等确认后建
   - 父节点已有，只是缺目标叶子 → FP 自行建
4. **创建**：`lark-cli wiki +node-create`（或 `wiki nodes create`），指定 parent_node_token、title、obj_type（默认 docx）
5. **返回**给请求方：
   - `node_token`
   - URL：`https://YOUR_TENANT.feishu.cn/wiki/<node_token>`
   - 完整路径：`<父 bucket> / <... > / <新节点标题>`
   - 选择理由（一句话）
6. **记 changelog**：`target_doc=fp-self`，`trigger_type=request`（来自其他 session） or `user_command`（来自用户），`change_summary` 记"在 X 下建 Y"

## §4. 审批分层

| 动作 | 层级 | 是否需要用户确认 |
|------|------|------------------|
| 建叶子文档节点 | 低 | 否（FP 自行创建） |
| 建一级 agent/主题子节点（例 `AgentSOP/<new-agent>`） | 中 | 是（先 spawn 请求方或告知用户，拿到确认再建） |
| 建根下 bucket（新的一级 Bucket，与 Agent菜单/AgentSOP 等同级） | 高 | 是（必须用户显式授权） |
| 改名 / 移动他 session 已有节点 | 高 | **不代动**，spawn 建议 agent 自改 |
| 删除节点 | 高 | 不删。发现空/废节点先 spawn 所有者，自主删除 |

## §5. `agent临时` Triage

每次周期维护（Phase 1~3）顺便看一眼 `agent临时/`：
- 节点龄 ≤ 7 天 → 跳过
- 节点龄 8–14 天 → spawn 原请求方问"这个还要保留吗 / 要迁到哪里"
- 节点龄 > 14 天且无回应 → changelog 记 `deferred`，继续留着；不删不移

## §6. 已知历史遗留（v1.0 记录，不代动）

- `Agent菜单/ads-master` vs `AgentSOP/广告大师adsmater` vs `Supermatrix知识库/ads-master` — 同一 agent 三处命名不统一。规范名应统一为 session name `ads-master`
- `Supermatrix知识库/ads-master/` 混放 SOP + Run records + 认知。按 §2 SOP 应迁到 `AgentSOP/ads-master/`
- `Supermatrix知识库/ads-master/` 下存在空标题节点 `PNxywqERHiw6ypk3uK5cHfB0nuO`
- `AgentSOP/广告大师adsmater` 子节点为空（内容似乎都到了 `Supermatrix知识库/ads-master` 去了）

这些由所属 agent 自行整理。FP 发现新的违规 → 加进本节并记 `deferred` changelog。

## §7. 与 Principles 同步的边界

本规则**只管建新节点**，不管 Principles 文档同步（那是 `scripts/sync-feishu.sh` 的事）。
Principles 文档自己的存放位置（`Supermatrix知识库/FirstPrinciple/`）已在 sync-feishu.sh 固化，不在本规则动态管理范围内。

## 规则版本

- **v1.0** — 2026-04-20 初版。用户授予新职责后 FP 自行设计，基于当前 wiki 现状（Agent菜单 / Supermatrix知识库 / AgentSOP / agent临时 四分结构）归纳
- **v1.1** — 2026-04-27 新增 `Agent数据` 根桶（after-sales 申请触发，用户授权）。用于承接跨 session 业务 bitable，与 AgentSOP 的边界写入 §"根下…Bucket"
- 根据人工反馈持续调整。每次调整在此记录原因和变更内容。
