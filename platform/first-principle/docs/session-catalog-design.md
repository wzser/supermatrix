# Session Catalog 设计 — CONSTITUTION.md 彻底退役

> 起草：first-principle，2026-05-18 | 状态：待用户过目 → 确认后 spawn root 实现

## 1. 背景：为什么 markdown CONSTITUTION 是错的底座

scheduler 要路由到「SK」，扫自己的 CONSTITUTION 没能确认 SK 是注册 alias——尽管文件第 216 行就有 `- **socail-king** (alias: SK, ...)`。根因：

- 能力 rollout 后，每个 CONSTITUTION 的「Other Active Sessions」名册从 68 行涨到 ~730 行（每兄弟一个多行 do/don't 块）。
- 路由要找的 `(alias: SK, ...)` 埋在 730 行散文里；"SK" 作为子串又在 `SKU`/`MSKU` 等 do/don't 文本中出现多次，确定性查找不可能。

markdown 散文 + 每 session 一份，对「确定性查找」和「无冗余」两件事都是错的底座。

## 2. 决定

**CONSTITUTION.md 彻底退役。** 旧 CONSTITUTION 拆成两半，分别处置：

| 旧 CONSTITUTION 的部分 | 处置 |
|---|---|
| Other Active Sessions 名册（通讯录） | → `session-catalog.json`，全局**一份**，symlink 进每个 workspace |
| per-session 自述（`# name` / Backend / Workdir / `**Purpose:**` 块） | → **删除**（无功能，见 §3） |
| Coding Principles 段 | 已删（commit 9b5e4c3） |

## 3. per-session 自述为什么可以直接删

session 自己的真实操作身份在 **CLAUDE.md / AGENTS.md**：操作规则全集 + 我们刚 rollout 写进去的 `## 职责边界` 完整段。别的 session 看它，靠 catalog。CONSTITUTION 里那段 per-session 自述（`**Purpose:** <一句话>`）只是 CLAUDE.md 的一个薄回声——没有任何代码解析它、没有任何行为依赖它。session 知道「我是谁」靠框架注入的 `$SM_SESSION_NAME` 环境变量，不靠这段文字。删掉零损失。

## 4. session-catalog.json schema

全局唯一文件。结构：

```json
{
  "generated_at": "2026-05-18T14:21:00Z",
  "sessions": [
    {
      "name": "socail-king",
      "alias": "SK",
      "backend": "claude",
      "category": "平台",
      "status": "busy",
      "fp_managed": true,
      "capability": {
        "定位": "监督多 session 间跨会话沟通质量……",
        "做什么": ["扫 cross_session_log 挑出疑似沟通失败的候选……", "..."],
        "不做什么": ["不做业务任务本身……", "..."]
      }
    }
  ]
}
```

- **能力数据来源**：就是能力 rollout 写进 `sessions.purpose` 的压缩版——rollout 数据原样复用，只是改用 JSON 暴露。
- **路由查找**：`jq '.sessions[] | select(.alias=="SK" or .name=="SK")'`——确定性精确匹配，scheduler 那个 bug 直接消失。
- `fp_managed=false` 的 session 不进 catalog（治理范围外，延续现有规则）。

## 5. 访问 / 生成（机制不重新设计，复用现有）

- **访问**：`session-catalog.json` 像 `console-principles.md` 等一样，symlink 进每个 workspace。一处变更，全体实时同步。
- **生成**：复用现有 CONSTITUTION 生成机制——SM core 在 session 增删 / 状态变 / capability 变时触发，从 `sessions` 表读数据。**唯一变化**：输出从「68 份 per-session markdown」改成「1 份 JSON catalog」。不重新设计触发逻辑。

## 6. CONSTITUTION 退役迁移清单

**SM core（root）**：
- 停 per-session CONSTITUTION.md 渲染；`writeConstitution` / `rerenderAll` 改成 `regenerateCatalog`（生成一份 JSON）。
- 删 CONSTITUTION 模板、`{{...}}` 占位符渲染、`ConstitutionVars`。
- session 创建流程：不再写 CONSTITUTION.md，改为确保 catalog symlink 到位。
- 旧 CONSTITUTION.md 文件清理（含共享 workdir 的串文件）。
- `constitution_updated` 事件 → `catalog_updated`（或保留语义、改 payload）。

**FP**：
- console-principles：「spawn 前重读 CONSTITUTION」规则 → 「查 session-catalog.json / 直接用 spawn API 的 name+alias 解析」。
- 各 category 的 claude-md / agents-md 模板 + 各 session CLAUDE.md/AGENTS.md：「Read CONSTITUTION.md first」引用 → catalog。
- 巡检 SOP：CONSTITUTION 相关检查项 → catalog 检查。

## 7. 分工

- **root**：§5 生成侧改造 + §6 SM core 迁移。
- **FP**：§6 治理规则 / 模板 / 巡检改动；catalog 里 capability 数据的契约（沿用 rollout 的压缩版格式）。

## 8. 顺带解决的存量问题

本设计一次性消除：scheduler 路由 bug、730 行×68 份冗余、共享 workdir 串 CONSTITUTION、rerenderAll 跳过 6 个外部 workdir、外部仓 auto-commit noise——这些全部源于「per-session markdown 文件」这个形态，换成「单份 JSON catalog」后不复存在。
