# SOP: 新增一个 shared / claude-only / codex-only skill

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP：** 平台基础设施操作 —— skill 登记 / 部署 / 跨后端（Claude Code + Codex CLI）同步。

**它要解决什么问题：** 新建或迁移一个 skill 进入 skill-master 的 canonical 池时，若跳过规定步骤（INDEX 登记、软链部署、双端发现验证、飞书 Bitable 同步），会直接破坏"两端 auto-discover 一致"这一框架不变式，导致 skill 单端失效、重名、或飞书登记表与代码真相漂移。按本 SOP 走完五步，skill 将在两个后端都可被自动发现，且飞书登记表与 `INDEX.md` 保持一致。

新增或迁移一个 skill 到 skill-master 管理的 canonical 池（Origin=`skill-master`）。Scope 四种：

| Scope | 部署位置 | 适用 |
|-------|---------|------|
| `shared` | `~/.claude/skills/` + `~/.agents/skills/` | 两端语义一致、不依赖后端特有工具 |
| `claude-only` | `~/.claude/skills/` | 依赖 claude 特有机制（Agent 子代理、某个 MCP） |
| `codex-only` | `~/.agents/skills/` | 依赖 codex 特有机制（`multi_agent` 等） |
| `inventory-only` | 不部署 | 只登记不建链（历史 skill、占位） |

> 登记外部 skill（Origin=`claude-builtin` / `codex-builtin`）只需在 INDEX.md 加一行，无需走下面的 canonical 目录 / 软链流程。

## 前置决策

1. **Scope 怎么定？** 审查 SKILL.md 正文：是否引用了某端独有的工具名或机制？有 → 单端；无 → shared
2. **已有 skill 想迁进来？** 先确认原持有方（比如 amzdata、ads-master）是否同意迁移到 skill-master 管理。不要擅自迁别的 session 在用的 skill
3. **Name 唯一性：** `Name` 是飞书 Bitable 的 upsert 唯一键，跨 scope / 跨 Origin 全局唯一。不要跟现有 `skills/INDEX.md` 或 `~/.codex/skills/`、`~/.claude/skills/` 里的已有 skill 重名

## 步骤

### 1. 创建 canonical skill 目录

```bash
cd <SM_WORKSPACE_ROOT>/skill-master
mkdir -p skills/<skill-name>
```

写入 `skills/<skill-name>/SKILL.md`，frontmatter 最小格式：

```markdown
---
name: <skill-name>
description: Use when [触发条件] — [做什么]
---

# <Skill 名>

正文...
```

**注意**：`name` 字段必须和目录名一致；`description` 是两端自动发现的触发依据，写清楚"什么时候用"。

### 2. 在 INDEX.md 登记

打开 `skills/INDEX.md`，在 `## Skills` 表格里追加一行（5 列：Name / Origin / Scope / Owner / Purpose）：

```markdown
| <skill-name> | skill-master | shared | <owner-session> | <一句话说明> |
```

外部 skill（Origin=`claude-builtin` / `codex-builtin`）同样一行，Scope 写 `claude-only` / `codex-only`，但跳过下面的目录 / 软链 / 双端发现验证步骤。

### 3. 部署软链

```bash
./scripts/sync-skills.sh
```

脚本幂等，会按 `scope` 自动建 `~/.claude/skills/<name>` 和/或 `~/.agents/skills/<name>` 软链指向 canonical。

**⚠️ 关键坑位：软链的是目录（`skills/<name>/`），不是文件（`skills/<name>/SKILL.md`）。** 只软链 SKILL.md 文件的话，codex 可以读到内容但不会进 system prompt / 技能列表（无法 auto-discover）。`sync-skills.sh` 已经做对了，不要手动改成文件软链。

### 4. 双端发现验证

```bash
# Claude 端（选一个 claude session）
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target":"atp-automated-testing-platform","prompt":"列出你当前所有自动发现的 skills，按字母序每行一个 name。"}'

# Codex 端
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target":"codexroot","prompt":"列出你当前所有自动发现的 skills，按字母序每行一个 name。"}'
```

两边列表里都能看到 `<skill-name>` → 验证通过。

### 4.5. 迁移已有 skill 时的额外清理

**只有把已存在于 `~/.codex/skills/`、`~/CodexSkills/*/skills/`、`~/amzdata/skills/` 等位置的 skill 搬入 canonical 时才需要。** 新建 skill 跳过本步。

迁移流程：

1. **把 SKILL.md 搬入 canonical**：`cp <老路径>/SKILL.md skills/<name>/SKILL.md`
2. **老位置目录 → 改成回指 canonical 的 symlink**（保持老调用链不断）：
   ```bash
   rm -rf <老 skill 目录>
   ln -s $(pwd)/skills/<name> <老 skill 目录>
   ```
3. **跑 `./scripts/sync-skills.sh`** 建标准软链 (`~/.claude/skills/` + `~/.agents/skills/`)
4. **清理遗留的单端专属软链**（重要——避免 codex 双发现同名 skill）：
   ```bash
   # 如果 ~/.codex/skills/<name> 是指向老位置的旧链，现在有 ~/.agents/skills/<name> 顶上了，必须清掉旧链
   rm -f ~/.codex/skills/<name>
   # 顺带清掉上一步创建的 backlink（老位置那条回指链）——如果老位置不再被任何代码引用
   rm -f <老 skill 目录>
   # 若老父目录 skills/ 因此空了，一并 rmdir
   rmdir <老 skill 父目录>/skills 2>/dev/null
   ```
5. **双端 spawn 验证**（见步骤 4）——清理后必须重测一遍，确认两端仍能发现

**为什么要清 `~/.codex/skills/<name>`：** codex 同时扫 `~/.codex/skills/` 和 `~/.agents/skills/`，老链没清会在 skill 列表里产生同名双份（实测会 dedupe，但行为不保证；宁可清干净）。已验证清干净后两端仍能发现，以此为准。

### 5. 提交 + 自动同步飞书

```bash
git add skills/<skill-name>/ skills/INDEX.md
git commit -m "skills: add <skill-name> (<scope>)"
```

`.githooks/post-commit` 检测到 INDEX.md 改动，自动在后台跑 `sync-skills-to-feishu.py`，把新 skill 推到 Bitable。查日志：`scripts/.sync.log`。

如果需要手动重跑：

```bash
python3 scripts/sync-skills-to-feishu.py
```

## 移除 skill

1. 从 `skills/INDEX.md` 删行
2. `./scripts/sync-skills.sh`（会清理 scope 不再匹配的死链）
3. 可选：删 `skills/<skill-name>/` 目录（也可保留备查）
4. commit → post-commit hook 自动从 Bitable 删除孤儿记录

## 排错

| 现象 | 原因 | 解决 |
|------|-----|------|
| 一端能发现，另一端看不到 | INDEX.md 里 scope 写错（比如 shared 写成 claude） | 改 INDEX.md 重跑 sync-skills.sh |
| 两端都看不到 | 软链指向了 SKILL.md 文件（而非目录） | 删链重跑 sync-skills.sh（脚本做的是目录软链） |
| 飞书表里有重复行 | 直接在飞书 UI 手工加过记录 | 手工在飞书 UI 清理，或重跑 `sync-skills-to-feishu.py`（会孤儿清理） |
| post-commit hook 没跑 | `core.hooksPath` 没配 | 在 workspace 内执行 `git config core.hooksPath .githooks` |

## 参考

- `coding-principles.md` §Symlink Sync Pattern、§Feishu Bitable Sync Strategy
- `skill-master/skills/INDEX.md`（登记表）
- `skill-master/scripts/sync-skills.sh`（本地软链部署）
- `skill-master/scripts/sync-skills-to-feishu.py`（飞书同步）
- 飞书表：https://YOUR_TENANT.feishu.cn/wiki/<WIKI_NODE_TOKEN>
