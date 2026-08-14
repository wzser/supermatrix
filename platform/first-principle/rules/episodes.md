# Episodes — 请求处理记录（archived 2026-04-14）

> **STATUS: ARCHIVED.** 自 2026-04-14 起，所有 request / 巡检 / user_command / event 处理记录改写到 `data/principles-log.db` 的 `changelog` 表（同时镜像到 Feishu Bitable，规则见 `CLAUDE.md` → "Changelog Recording Rules"）。
>
> 本文件保留下面 5 条历史 entry 以便追溯，**不再追加新内容**。要写新 episode，请去 changelog（命令模板在 CLAUDE.md）。

## 记录格式

每条 episode 包含：
- **日期**
- **请求来源**（哪个 session）
- **目标文档**
- **处理结果**（accepted / rejected / split）
- **原因**（为什么接受/拒绝，简要说明）
- **学到了什么**（如果有的话）

## Episodes

### 2026-04-13 — 用户直接要求添加单聊通知能力章节

- **请求来源**: 用户（直接指令）
- **目标文档**: `templates/business-principles.md`
- **处理结果**: accepted
- **原因**: 用户直接要求更新，内容为 amn session 提供的 notify 工具说明，属于业务编排工具范畴，放在 business-principles 合理
- **学到了什么**: notify 工具是新增的跨 session 能力，属于业务工具层。base 模板无需修改——具体工具信息通过引用 business-principles.md 获取即可

### 2026-04-14 — watchdog 请求：文档产出通知规则

- **请求来源**: watchdog（request）
- **目标文档**: `templates/console-principles.md`
- **处理结果**: rejected
- **原因**: coding-principles 已有"必须通过飞书发给用户"规则，console-principles 已有"通知→bot 身份"规则。请求核心行为已被覆盖。Superpowers 路径模式属 session 特有内容，不适合放入全局 Principles
- **学到了什么**: 处理请求前要交叉检查三份文档，避免重复。具体路径模式属于 session CLAUDE.md 内容

### 2026-04-14 — watchdog 请求：lark-cli 路径约束扩展

- **请求来源**: watchdog（request）
- **目标文档**: `templates/console-principles.md`
- **处理结果**: accepted
- **原因**: 现有规则仅覆盖 `--file`，请求补充了 `--output`/`--image` 和静默失败行为描述。两次踩坑经历提供了充分理由
- **学到了什么**: 实际操作中反复踩的坑优先级高，应积极收录。"静默失败"类行为尤其需要明确记录

### 2026-04-14 — stuck-session 分析请求：运行时超时分层设计

- **请求来源**: stuck-session-analysis（request）
- **目标文档**: `templates/coding-principles.md`
- **处理结果**: accepted
- **原因**: 新增设计模式，来源于实际 stuck session 问题分析。三层超时设计原则（默认值+可覆盖+分层防护）结构清晰，可操作
- **学到了什么**: 从故障分析中提炼的设计原则往往质量高，因为有真实场景验证

### 2026-04-14 — amzdata 请求：飞书多维表格同步策略

- **请求来源**: amzdata（request）
- **目标文档**: `templates/coding-principles.md`
- **处理结果**: accepted
- **原因**: 新增设计模式，覆盖三种同步模式（全量重写/Upsert/Search+Diff）的选择依据。解答了增量 vs 全量、是否本地缓存 record_id 等具体问题。现有文档无冲突无冗余
- **学到了什么**: 多个 session 遇到同一工具的不同使用场景时（sync-session-table 用全量、amzdata 需增量），适合提炼为统一的选择框架
