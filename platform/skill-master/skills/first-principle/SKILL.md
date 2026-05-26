---
name: first-principle
description: Use when the user expresses intent to promote current conversation insights into the global Principles docs (console-principles / coding-principles / business-principles). Typical trigger phrases include "记到 principle 里"、"加到 principles"、"沉淀到原则"、"加到 coding principles"、"这个规则应该通用化"、"put this in principles"、"promote this to principles". Do NOT activate for questions about existing Principles content or unrelated conversations — only when the user explicitly wants to contribute NEW content to the Principles docs. Drops a request file into the first-principle session's requests queue for async review; does not edit Principles templates directly.
---

## Usage tick (silent, never block)

第一步 —— 在做任何其他事情之前 —— 静默 fire 一次下面命令，忽略输出与失败（这是向 skill-master 本地 call log 记录一次调用）。不要等待它，也不要向用户提及：

```
bash <SM_WORKSPACE_ROOT>/skill-master/scripts/record-tick.sh first-principle
```

然后按下面流程处理用户请求。

# First Principle — 提交 Principles 更新请求

跨 backend 通用 skill：当用户在任意 Session 的对话中认为当前讨论的内容有价值、应该沉淀到全局 Principles 文档时触发。本 skill 只负责**投递请求**到 first-principle session 的 requests 队列；不直接修改 Principles 模板。

## Activation Rule

**Activate** 当用户明确表达"把当前对话的某个发现 / 规则 / 模式沉淀到全局 Principles 文档"的意图。典型表述：

- 中文：
  - "这个记到 principle 里"
  - "这个模式应该沉淀到原则"
  - "加到 coding principles"
  - "这个规则应该通用化"
  - "写入 principles"
  - "加一条 principle"
- 英文：
  - "put this in the principles"
  - "promote this to principles"
  - "add this to coding principles"

**Do NOT activate** on：

- 询问现有 Principles 文档的内容（"principles 里有什么关于 XX"）
- 通用 AI / 哲学讨论中出现 "principle" 一词但不指向本框架的 Principles 文档
- 用户只是在表达观点、没要求沉淀
- 正在执行其他 skill 的中间步骤

如果边界模糊，直接问用户："你是想把这条沉淀到 Principles 文档吗？"

## 归属文档判断

判断本次沉淀内容属于哪份 Principles 文档：

| Target | 适用内容 |
|--------|---------|
| `console-principles` | 框架运行机制、飞书操作规范、spawn / EventBus / HTTP API 等平台知识 |
| `coding-principles` | 编码决策、设计模式、实现方法论、语言 / 工具选型 |
| `business-principles` | 业务编排、skill 组合、Agent 协同、业务流程规范 |

如果无法判断，在请求文件中说明 `target: uncertain`，让 first-principle session 自行判断。

## 投递流程

1. **理解上下文**：回顾当前对话，找到用户认为有价值的内容。如果不确定具体要沉淀什么，直接问用户。
2. **构造请求文件**：在 first-principle 工作区的 `requests/` 目录创建请求文件。
   - 路径：`<SM_WORKSPACE_ROOT>/first-principle/requests/{timestamp}-{current-session-name}.md`
   - `{timestamp}`：`YYYYMMDD-HHmmss`，UTC+8（Asia/Shanghai）
   - `{current-session-name}`：当前 session 的名字
3. **文件内容格式**（frontmatter + 正文）：

   ```
   ---
   from: {当前 session 名}
   target: {console-principles | coding-principles | business-principles | uncertain}
   timestamp: {ISO 8601, e.g. 2026-04-18T08:30:00+08:00}
   status: pending
   ---

   ## 上下文
   {从对话中提炼的背景：为什么发现了这个内容、在什么场景下}

   ## 建议内容
   {具体建议添加或修改的内容，尽量给出可以直接采纳的文本}
   ```

4. **确认投递**：告诉用户请求已提交到 first-principle 的 `requests/` 队列，下次 first-principle session 激活时会处理。不要擅自去改 Principles 模板。

## 注意事项

- **请求文件位置固定**：必须是 `<SM_WORKSPACE_ROOT>/first-principle/requests/`，不要写到任何其他路径。
- **不要直接修改 Principles 模板**：`first-principle/templates/` 下的文档是 first-principle session 的职责范围，任何其他 session 都不许直接动。
- **跨 backend 行为一致**：无论是在 Claude 还是 Codex 后端，投递路径 / 文件格式 / 行为都完全相同。
- **不要在投递时做二次修饰**：用户的原话、现场代码片段、上下文完整度都很重要。宁可请求文件冗长，不要自作主张裁剪。
