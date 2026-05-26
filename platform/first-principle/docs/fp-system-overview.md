# First-Principle 系统运行逻辑总览

> 生成时间：2026-04-28 | 作者：first-principle session

---

## 一、这个系统是什么

First-Principle（FP）是 SuperMatrix 多 Agent 体系的**宪法守护者**。

它做两件事：

1. **维护 Principles 文档**（三份核心行为规范），确保所有 session 遵守同一套规则
2. **为新 session 注入初始配置**（CLAUDE.md / AGENTS.md），让每个 session 一诞生就知道自己是谁、该怎么做事

---

## 二、核心文件结构

```
workspaces/first-principle/
├── templates/                   ← 唯一权威源（只有 FP 可以改）
│   ├── console-principles.md    ← 框架运行规范（三层通信、spawn、飞书操作）
│   ├── coding-principles.md     ← 编码决策框架
│   ├── business-principles.md   ← 业务编排原则
│   ├── claude-md-base.md        ← 新 session CLAUDE.md 公共基础（含自驱初始化流程）
│   ├── agents-md-base.md        ← 新 session AGENTS.md 公共基础（codex backend 用）
│   ├── claude-md-业务.md        ← 业务类 session 专属规则
│   ├── claude-md-知识.md        ├── 知识类
│   ├── claude-md-平台.md        ├── 平台类
│   ├── claude-md-工具.md        ├── 工具类
│   ├── claude-md-外部.md        └── 外部类
│   └── agents-md-{类}.md        ← codex backend 同款五个类目
├── bin/
│   └── fp-generate-init         ← 生成新 session 配置文件的 CLI 工具
├── scripts/
│   ├── sync-feishu.sh           ← 把 templates/ 推送到飞书 Wiki
│   └── sync-session-table.sh    ← 同步 session 元信息到飞书 Bitable
├── rules/
│   └── update-judgment.md       ← 判断更新请求是否接受的规则
├── sop/                         ← 操作手册
│   ├── periodic-review-operation-manual.md
│   └── new-session-init-sync.md
├── requests/                    ← 其他 session 提交的更新申请（pending → archive）
├── data/
│   ├── principles-log.db        ← 所有操作的 SQLite 变更日志
│   └── session-init.ndjson      ← 新 session 初始化记录（含飞书同步状态）
└── CLAUDE.md                    ← FP 自身的行为规范（引用本系统逻辑）
```

---

## 三、新 Session 是怎么注入文档的

### 3.1 整体流程（5 步）

```
用户发 /new 命令
    ↓
SuperMatrix framework 创建 session + workdir
写 SQLite sessions 表（category 为空）
把 claude-md-base.md 放到 workdir/CLAUDE.md（作为临时 stub）
    ↓
新 session 首次激活，读到 stub（CLAUDE.md）
    ↓
【自驱初始化】收集 4 个字段（alias / avatar / category / purpose）
    ↓
调 fp-generate-init CLI，拿到正式模板内容
    ↓
用正式模板覆写 CLAUDE.md（或 AGENTS.md）
写飞书群名 / 群描述 / 群头像
写 sessions 表 category/alias/purpose/avatar
    ↓
FP 巡检时发现 session-init.ndjson 有待同步行
    ↓
FP 把 alias/purpose/分类/头像 补推到飞书 Bitable
回写 ndjson feishu_sync_ok = true
```

### 3.2 stub 阶段：新 session 激活时做什么

SuperMatrix 在 `new` 命令执行时，把 `templates/claude-md-base.md` 的内容写入新 session 的 workdir 作为临时 CLAUDE.md。

这个 stub 的核心内容是**「自驱初始化运行手册」**：

- **第 0 步**：每次激活先检查是否已初始化（查 sessions 表 category 字段 + `.init-state.json`）
- **步骤 1**：从 SQLite 拿自己的飞书 chat_id
- **步骤 2**：主动在群里发第一句话，索要 4 个字段（alias / avatar / category / purpose）
- **步骤 3**：每收到一个字段立即持久化到 `.init-state.json`（中断续传机制）
- **步骤 4**：4 字段校验
- **步骤 5**：调 `fp-generate-init` CLI 拿模板 JSON
- **步骤 6**：覆写 CLAUDE.md 或 AGENTS.md
- **步骤 7**：写 sessions 表
- **步骤 8**：执行飞书同步指令（改群名/群描述/群头像）
- **步骤 9**：回写 ndjson feishu_sync_ok 标记
- **步骤 10**：清理 `.init-state.json`，在群里宣布完成

### 3.3 fp-generate-init：模板生成器

`bin/fp-generate-init` 是一个 bash/python 脚本，接收 5 个参数：

```bash
fp-generate-init \
  --category  业务|知识|平台|工具|外部 \
  --alias     <人类可读名> \
  --avatar    <emoji|URL|路径> \
  --purpose   <一句话职责> \
  --backend   claude|codex \
  --session-name <$SM_SESSION_NAME>
```

**输出一个 JSON**，包含：

| 字段 | 内容 |
|------|------|
| `ok` | 成功标志 |
| `config_md_filename` | `CLAUDE.md` 或 `AGENTS.md` |
| `config_md_content` | `base 模板 + 类目模板` 拼合后的完整内容，占位符已替换 |
| `feishu_sync_instructions` | 3 条飞书同步指令（改群名/改群描述/改群头像） |

**拼合逻辑**：
```
config_md_content = claude-md-base.md（去掉 stub 初始化说明部分）
                  + claude-md-{category}.md
```
占位符替换：`{{name}}` / `{{alias}}` / `{{purpose}}` / `{{category}}` / `{{backend}}`

同时，CLI 会向 `data/session-init.ndjson` 追加一行记录（`feishu_sync_ok: null`），供 FP 后续巡检发现并补推飞书。

### 3.4 为什么这样设计

- **stub 在本地直接执行**：不需要 FP 在线，也不依赖 spawn，降低失败面
- **中断续传**：`.init-state.json` 保存已收到的字段，激活一次不够时下次继续
- **FP 兜底**：即使 stub 的飞书同步步骤失败，FP 在下次激活时扫 ndjson 补推（SOP: new-session-init-sync.md）

---

## 四、Principles 文档的更新机制

### 4.1 更新来源

| 来源 | 方式 |
|------|------|
| 其他 session 被用户纠正后 | 用 `/first-principle` skill 自动提交请求文件到 `requests/` |
| 用户直接告诉 FP | user_command，FP 直接编辑 templates/ |
| FP 自己巡检发现问题 | patrol，FP 直接编辑 |
| 定时巡检周期 | scheduler 每隔一天触发 FP，走四阶段：Gather → Synthesize → Conform → Sync |

### 4.2 判断规则（三关）

FP 扫 `requests/` 下 `status: pending` 的文件，按以下三关决定是否写入：

1. **第一关：范围归属** — 内容是否属于三份文档之一？跨多份则拆分处理；不属于则拒绝
2. **第二关：合理性** — 与已有原则是否冲突或冗余？冲突需说明理由；冗余直接拒绝
3. **第三关：具体性** — 是否足够具体可执行？过于抽象则退回补充

**多 session 交叉验证**：单 session 首次出现 → `deferred`；2+ session 同一周期 → 直接接受。但有具体事故（commit hash + 崩溃记录）支撑的单 session 报告可直接接受。

### 4.3 变更后的同步链

```
编辑 templates/*.md
    ↓
git commit（小步提交）
    ↓
./scripts/sync-feishu.sh
（把每个文档推到对应的飞书 Wiki 页面）
    ↓
写 data/principles-log.db（SQLite changelog）
    ↓
同步一行到飞书 Bitable changelog 表（镜像留痕）
    ↓
把处理完的 requests/ 文件移到 requests/archive/
```

---

## 五、FP 每次激活做什么

FP 是一个事件驱动 session，每次被激活（用户消息 / scheduler spawn）时按顺序执行：

1. **扫 `requests/`**：处理所有 `status: pending` 的更新请求
2. **扫 `session-init.ndjson`**：发现 `feishu_sync_ok != true` 的行，补推飞书元信息
3. **CLAUDE.md / AGENTS.md 巡检**（每 2 天一次，检查 `.last-sync-review` 时间戳）：
   - 走遍所有 active workspace，检查 CLAUDE.md / AGENTS.md 是否与对应类目模板对齐
   - 发现问题 → spawn 到目标 session 通知（不强制覆写）
   - 完成后 `date > .last-sync-review`
4. **定时周期巡检**（scheduler 触发）：四阶段 Gather → Synthesize → Conform → Sync（详见 `sop/periodic-review-operation-manual.md`）

---

## 六、关键约束

| 约束 | 原因 |
|------|------|
| 只有 FP 可以编辑 `templates/` | 保持单一权威源，其他 session 必须通过 `/first-principle` skill 提交申请 |
| 每次改动必须记 changelog（SQLite + Bitable 双写） | 审计追踪，判断路径可复盘 |
| 巡检不强制覆写其他 session 的文件 | Session 自治原则；FP 只建议，目标 session 自己决定是否采纳 |
| Session 名通过 `$SM_SESSION_NAME` 获取，不硬编码 | workdir 可能被多个 session 共享 |
| 每次 edit + 每次巡检都要问「能删什么」 | 防止文档只增不减导致规则膨胀（doc rot） |

---

## 七、一句话总结

> **FP 是一个「文档注射器 + 守法巡检员」**：新 session 诞生时它负责把量身定制的 CLAUDE.md 装进去；日常它负责收集各 session 的行为纠偏、判断是否写入 Principles、并定期巡检全系统的 CLAUDE.md 是否还和模板对齐。
