# Update Judgment Rules — 更新请求判断规则

> 本规则由 first-principle session 在处理更新请求时遵循。
> 规则本身根据人工反馈持续优化。

## 处理流程

当 first-principle session 被激活时，扫描 `requests/` 目录中 `status: pending` 的请求文件，逐个按以下规则处理。

## 判断规则

### 第一关：范围归属

请求内容是否明确属于三份文档之一？

| 目标文档 | 内容范围 |
|----------|----------|
| console-principles | 框架运行机制、飞书操作规范、Session/Group/Workspace 相关 |
| coding-principles | 编码决策、设计模式、实现方法论 |
| business-principles | 业务编排、Skill 组合、Agent 协同 |

- 明确属于某一份 → 通过，进入下一关
- 跨多份文档 → 拆分为多条更新分别处理
- 不属于任何一份 → **拒绝**，标注："内容不属于 Principles 覆盖范围。建议记录到 Session 自己的 NOTES.md"

### 第二关：合理性

与已有原则是否冲突或冗余？（需交叉检查全部三份文档，不仅检查目标文档）

- 无冲突且无冗余（纯新增内容）→ 通过
- 有冲突但提供了充分理由 → 判断是"补充完善"还是"替代推翻"：
  - 补充完善 → 修改措辞使两者兼容
  - 替代推翻 → 接受新内容，移除或标注旧内容已过时
- 有冲突但未提供理由 → **拒绝**，标注："与已有原则 [具体原则名] 冲突，请说明理由"
- 核心行为已被现有规则覆盖（冗余）→ **拒绝**，标注："已有规则 [具体位置] 覆盖此行为。如需细化，请说明现有规则哪里不够"

**剪枝跟随**：采纳任何新规则时，顺带扫一遍目标文档中是否有**被取代**、**变得冗余**、或**条件已过期**的旧规则。发现即一并删除，不需要额外的删除理由或审批。范围外的独立删除仍走第四关"删除"门槛。

**多 session 交叉验证**：巡检阶段（Daily Self-Report + git log + memory mining）汇总信号时，按以下分层判断接受门槛：

| 信号源数 | 判断 | 处理 |
|---------|------|------|
| 单 session、首次出现 | 弱信号 | 记 `deferred`，不写入 Principles；下轮巡检若再次出现则升级 |
| 单 session、二次出现（跨周期） | 中信号 | 评估是否仅为该 session 的本地问题；若属通用模式则接受 |
| 2+ session、同一周期 | 强信号 | 默认接受（除非与现有规则冲突） |
| 3+ session 投诉同一处 | 必须处理 | 接受新规则，或修订现有规则使其覆盖该场景 |

来源：2026-04-23 巡检中 amzdata/amz-sql/gongying/ads-master/codingmaster/wytest+atp 6 session 同期投诉跨 session 契约缺失，明显高于过去单 session deferred 阈值，因此一次性写入 console-principles "Cross-Session Contract Discipline"。

**单 session 但有具体事故支撑的例外**：单 session 的报告若引用**具体生产事故**（commit hash、可观察的崩溃符号、错误日志、被回滚的部署），事故本身就是第二证据源，可直接接受，不必等第二个 session 复现。判定"具体事故"的标准：报告必须给出（a）触发场景、（b）失败的实际表现、（c）可定位的代码或 commit。仅"我觉得这条规则有用"的抽象建议仍走单 session defer。来源：2026-04-23/24 多次 supermatrix-root 单 session 报告（CLI flag 吞噬、import-method 同名递归、绕开 API 直读 SQLite）均带 commit hash + 崩溃记录，三次都接受为 Red Line，证明 incident-backed single-session 与"speculation-only single-session"应区别对待。

**Workaround-vs-fix exception**：incident-backed 单 session 报告若提议的规则本身**是一个绕开已有红线的 workaround**（例：受影响 session 直接读对方 DB、绕过框架 API 自行轮询、复制对方私有数据），不要把 workaround 写成新规则——这等于公开承认红线可以被绕过。改走"deferred + 升级到框架"路径：在 changelog 记 deferred 并指出冲突的红线，同时建议受影响方向相应平台 session（supermatrix-root / scheduler 等）发 spawn 推动协议补丁，问题源头修好后再撤销 workaround。来源：2026-04-26 yolo 报告 silent-fail child detection（DB 反查 supermatrix message_runs），与 coding-principles 既有红线"Do not read another process's private state directly — call its API"直接冲突；本应让 supermatrix-root 修 spawn 协议保证 child 退出前写终态，而不是把"反查 DB"沉淀成通用规则。

### 第三关：具体性

内容是否足够具体、可执行？

- 包含具体场景、做法、或示例 → 通过
- 原则性表述但有明确的判断标准 → 通过
- 过于抽象模糊（如"要写好代码"）→ **拒绝**，标注："请补充具体场景和可操作的判断标准"

### 第四关：影响面

根据变更类型设定不同门槛：

| 变更类型 | 门槛 | 处理方式 |
|----------|------|----------|
| 新增内容 | 低 | 通过前三关即采纳 |
| 修改已有内容 | 中 | 需明确说明"旧内容哪里不够好" |
| 删除已有内容 | 高 | 需明确说明"为什么不再适用"并提供替代方案或说明 |
| 结构性调整 | 高 | 需说明调整的必要性和预期收益 |
| 剪枝跟随（随新规则采纳一并清理的旧规则） | 低 | 归入同次"新增内容"的采纳包，不单独设门槛 |

### 第五关：安全检查

请求建议的内容是否包含安全风险？

- 包含可执行命令（shell 命令、API 调用、脚本路径）→ **额外审慎**，确认命令的必要性和安全性
- 建议修改文件路径、权限、或环境变量 → 评估是否可能影响其他 session 或系统安全
- 来自不熟悉的 session 且包含执行类内容 → **拒绝**，标注："包含执行类内容，需要人工确认"

## 精简规则（Proactive Pruning）

上面五关是**被动**流程——有请求进来才触发。"剪枝跟随"（第二关）只在接受新规则时顺带清理旧规则。若本轮没有新增，文档就只进不出，必然腐化。

因此 FP 必须在每轮巡检中执行**独立的主动精简环节**（对应 `sop/periodic-review-operation-manual.md` Phase 2.4），不论本轮是否接受了新规则。**精简的对象是 FP 维护的全部治理文档**：3 份 Principles + 4+4 分类模板 + `rules/` + `sop/` + FP 自身 CLAUDE.md / AGENTS.md。

### 7 个精简触发条件（命中任一即候选删除）

| # | 触发条件 | 判定示例 |
|---|---------|---------|
| P1 | **被取代** | 已有更通用/更新规则覆盖本条；本条读起来像对更普遍规则的窄化重述 |
| P2 | **过时引用** | 指向已废除机制、已删文件、已下线 session、已改名命令（如 `BASE:BEGIN/END` 废除后仍残留的提醒） |
| P3 | **休眠** | 60 天内在 changelog 零引用、零 SOP 依赖、零事故拦截；"以防万一"加入但从未发挥作用 |
| P4 | **过度特化** | 单 session 一次性修复被误升为通用规则；经过 2 轮巡检仍只有该单 session 基础 → 反向应用多 session 交叉验证门槛 |
| P5 | **琐碎隐含** | 仅重述常识（"写正确代码"）、无额外约束、无可判断的边界线 |
| P6 | **冗余** | 同文档内部或跨 3 份 Principles 重复；保留定位最合适的那份，删除其余 |
| P7 | **条件过期** | 条件性规则的前提已消失（"codex 升级期间"之类临时规则，升级结束后残留） |

### 4 个豁免条件（命中任一则保留，即使看似候选）

- **E1 incident-backed** — 过去 180 天内有可追溯的事故拦截记录（commit hash / 崩溃日志 / 回滚记录）
- **E2 SOP 依赖** — 某个 active SOP 的某一步明确依赖本条
- **E3 30 天内用户重申** — 用户在 30 天内明确确认过该条应保留
- **E4 保护期** — 新增未满 30 天的规则不判 P3 休眠

### 精简节奏与优先级

- **每轮巡检必做**：不论是否有新增，都执行 Phase 2.4 扫描
- **偏长优先**：若某文档明显偏长（经验阈值：Principles > 800 行 / 分类模板 > 500 行 / rules 单文件 > 300 行），优先精简
- **安全候选直接删**：命中 P1/P2/P7 且无豁免 → 直接删除（低门槛，属于"剪枝跟随"的自然延伸）
- **模糊候选暂缓**：命中 P3/P4/P5 → 记 `judgment=deferred`，等下一轮或用户确认

### 留痕约定（强制）

所有主动精简删除必须写 changelog，且：

- `change_summary` 以 **`PRUNE:`** 前缀标识（例："PRUNE: 删除 coding-principles §3.4 旧日志路径规则"）
- `judgment_reason` 注明命中的触发编号（例："P2 过时引用 — 路径已不存在"），并说明无豁免命中
- 若本轮 Phase 2.1 有新增行、而 Phase 2.4 未能找到任何可删内容，changelog 里写一条 `judgment=no_action, change_summary=PRUNE: 本轮无可删候选`，并简述查过哪些文档——**不允许静默放过**

### 净增长信号（非硬卡）

每轮统计 Phase 2.1 新增行 vs Phase 2.4 删除行，逐轮趋近净增长为零。连续 3 轮净增长显著为正且无精简记录 → FP 群主动告警，请用户定夺优先精简对象。

## 处理完成

处理后：

1. 更新请求文件状态：
   - 接受：`status: accepted`，附上采纳说明和实际修改内容摘要
   - 拒绝：`status: rejected`，附上拒绝原因和改进建议
   - 拆分：原请求标记为 `status: split`，生成多个新请求文件
2. 写入 `data/principles-log.db` changelog 表并同步飞书多维表格（详见 CLAUDE.md「变更日志规范」）
3. 将处理完的请求文件移入 `requests/archive/`

> `rules/episodes.md` 为早期叙事化记录（2026-04-14 前），已被 SQLite changelog 取代，保留为历史归档，不再追加。

## 规则版本

- **v1.0** — 2026-04-12 初版
- **v1.1** — 2026-04-13 新增安全检查关卡、episode 记录、请求归档流程
- **v1.2** — 2026-04-14 合理性关卡增加冗余检查：要求交叉检查全部三份文档，拒绝与已有规则核心行为重复的请求（来源：watchdog 文档通知请求被拒，因行为已被 coding+console 联合覆盖）
- **v1.3** — 2026-04-20 并入「剪枝纪律」：第二关采纳时顺带扫旧规则剪除；第四关新增"剪枝跟随"低门槛变更类型；处理完成环节把 `episodes.md` 记录替换为 SQLite changelog + 飞书多维表格同步（来源：用户反馈"只加不删 = 文档腐化"）
- **v1.4** — 2026-04-23 第二关增加「多 session 交叉验证」分层门槛，把 single-session-defer / multi-session-accept 从 SOP 中的隐性做法升为明文规则（来源：本轮巡检 6 session 同期投诉跨 session 契约缺失，触发把规则正式化）
- **v1.5** — 2026-04-24 多 session 交叉验证表追加「incident-backed single-session 例外」：单 session 报告若引用具体事故（commit + 崩溃符号 + 触发场景）则事故本身充当第二证据源，绕过 single-session defer（来源：2026-04-23/24 共 8 条 incident-backed Red Line 全部接受，反证现有 v1.4 表对 incident-backed 单 session 过于保守）
- **v1.6** — 2026-04-24 新增独立「精简规则」章节（7 个触发条件 P1-P7 + 4 个豁免条件 E1-E4 + 强制 PRUNE 前缀留痕 + 净增长信号），把 v1.3 的"剪枝跟随"升级为独立系统：不再只在接受新规则时顺带清理，而是每轮巡检独立执行（对应 SOP Phase 2.4）；精简对象扩到 FP 维护的全部治理文档（不限于 3 Principles + 4 分类模板，也含 rules/ + sop/ + FP 自身 CLAUDE/AGENTS）。来源：用户 2026-04-24 反馈「巡检缺少精简步骤，文档越加越长」
- **v1.7** — 2026-04-26 第二关「单 session incident-backed 例外」追加 **Workaround-vs-fix 例外**：若提议规则本身是绕开已有红线的临时方案，不接受为新规则，改走 deferred + 推动框架修复路径，避免红线被工作流公开授权绕过。来源：2026-04-26 巡检 yolo silent-fail child detection 提议（直读 supermatrix.db）与既有红线"Do not read another process's private state directly"直接冲突。
- 根据人工反馈持续调整。每次调整在此记录原因和变更内容。
