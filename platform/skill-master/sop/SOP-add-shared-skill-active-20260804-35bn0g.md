---
id: 35bn0g
name: add-shared-skill
description: 新增或迁移单个 shared / claude-only / codex-only canonical skill；不覆盖外部托管升级。
status: active
owner: skill-master
created: 2026-06-26
updated: 2026-08-04
---

# SOP: 新增一个 shared / claude-only / codex-only skill

目标：把一个 skill 纳入 skill-master canonical 池，并让 INDEX、三端软链、发现验证和飞书登记保持一致。

## When to Use

适用：新增或迁移单个 `Origin=skill-master` 的 canonical skill，Scope 为 `shared` / `claude-only` / `codex-only`。不适用：外部 GitHub skill 托管升级，改走 `SOP-skill-hosting-upgrade-active-20260711-skup26.md`。

## Prerequisites

- 工作目录：`/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master`
- 真相源：`skills/INDEX.md`；部署脚本：`scripts/sync-skills.sh`
- 前置判定：原 owner 同意迁移；`Name` 未出现在 `skills/INDEX.md`、`~/.claude/skills/`、`~/.agents/skills/`、`~/.kimi/skills/`、`$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`）
### Step 1: 创建 canonical skill 目录

```bash
mkdir -p skills/<skill-name>
```

写入 `skills/<skill-name>/SKILL.md`，frontmatter 最小格式：

```markdown
---
name: <skill-name>
description: "Use when [触发条件] -- [做什么]"
---
```

`name` 必须等于目录名。`description` 必须写成可触发的路由句；不要只写能力名。整个 description 用引号包住，避免正文里的 `: ` 被 YAML 解释成嵌套映射。

### Step 2: 在 skills/INDEX.md 登记

在 `skills/INDEX.md` 的 5 列表格追加一行：

```markdown
| <skill-name> | skill-master | <scope> | <owner-session> | <一句话说明> |
```

`<scope>` 只允许：

| Scope | 部署位置 | 适用 |
|---|---|---|
| `shared` | `~/.claude/skills/` + `~/.agents/skills/` + `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`；另镜像到 legacy `~/.kimi/skills/`） | 三端语义一致、不依赖后端特有工具 |
| `claude-only` | `~/.claude/skills/` | 依赖 Claude Code 特有机制 |
| `codex-only` | `~/.agents/skills/` | 依赖 Codex 特有机制 |

`inventory-only` 只登记不部署；不属于本 SOP 的 canonical 上线路径。

### Step 3: 部署软链

```bash
python3 scripts/validate-skill-frontmatter.py --canonical skills --index skills/INDEX.md
./scripts/sync-skills.sh
```

判定：validator 必须用真 YAML safe parser（优先 PyYAML `yaml.safe_load()`；当 macOS 临时 HOME 下用户级 PyYAML 不可见时等价回退 Ruby/Psych `safe_load`）成功解析每个待部署 skill 的完整 frontmatter，并确认 `name` / `description` 是非空字符串、`name` 与目录名一致；失败时 `sync-skills.sh` 必须在改动任何发现链接前退出。sync 输出中 `<skill-name>` 的 symlink target 必须是目录 `skills/<skill-name>/`，不是 `skills/<skill-name>/SKILL.md` 文件。若 scope 从 shared 改为单端，脚本必须清掉不该存在的 stale link。

### Step 4: 跨后端发现验证

用 spawn2.0 分别请求 Claude、Codex、Kimi 代表 session 列出自动发现的 skills；`client_request_id` 必须形如 `$(date +%F):skill-master:<target>:discover-<skill-name>`。

```bash
curl -s -X POST http://localhost:3501/api/spawn2.0 \
  -H "Content-Type: application/json" \
  -d '{"from":"skill-master","target":"codexroot","prompt":"列出你当前所有自动发现的 skills，按字母序每行一个 name。","client_request_id":"2026-07-11:skill-master:codexroot:discover-<skill-name>","closure":{"kind":"message","target":{"type":"inline"}}}'
```

判定：`shared` 必须三端都出现 `<skill-name>`；`claude-only` 只在 Claude 出现；`codex-only` 只在 Codex 出现。Kimi 发现列表是 session 级快照：新增或改名后必须新建 Kimi session 验证，存量 session 需用户自行 `/reset` 重建；不得重启共享 Kimi ACP。必须实测 native `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`）读取成功，同时保留 SuperMatrix 仍显式使用的 `~/.kimi/skills/` legacy mirror；两者都是受管目录，不能删其一或仅凭启动参数断言成功。

### Step 5: 迁移老 skill 时清理旧入口

新建 skill 跳过本步。迁移已有 skill 时，按顺序执行：

1. 把老 `SKILL.md` 放入 `skills/<skill-name>/SKILL.md`。
2. 老位置目录临时改成指向 canonical 的 symlink，保持旧调用链不断。
3. 重跑 `./scripts/sync-skills.sh`。
4. 清理 `~/.codex/skills/<skill-name>` 等遗留单端旧链，避免同名双发现。
5. 重跑 Step 4 发现验证。

### Step 6: 提交并同步飞书

```bash
git add skills/<skill-name>/ skills/INDEX.md
git commit -m "skills: add <skill-name> (<scope>)"
```

`.githooks/post-commit` 仅在 `skills/INDEX.md` 变更时自动跑 `scripts/sync-skills-to-feishu.py`。手动补同步命令：

```bash
python3 scripts/sync-skills-to-feishu.py
```

## Exceptions

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 上游数据脏 / 缺 | 真 YAML safe parser 解析失败，`SKILL.md` 缺字符串 `name` / `description`，或 `name` 与目录名不一致 | 跑 `python3 scripts/validate-skill-frontmatter.py --canonical skills --index skills/INDEX.md`，退出码非 0 即命中 | 停止部署且不改发现链接；修复 frontmatter 后从 Step 1 重跑 | skill-master + 原 owner | 当日未补齐则退回迁移请求 |
| 下游不响应 | 任一代表 session 的 spawn2.0 返回非 2xx，或 30 分钟内无 inline closure | spawn 返回体无 `ok`，或 closure 缺发现列表 | 重发 1 次；仍失败则不合入 shared，记录目标端失败证据 | 对应后端 owner：codexroot / supermatrix-root | 重发仍无响应则 1 工作日内升级 first-principle |
| 自身执行异常 | `scripts/sync-skills.sh` 输出 target 非目录、stale link 未清，或脚本非 0 退出 | `readlink ~/.agents/skills/<skill-name>` / `readlink ~/.claude/skills/<skill-name>` / `readlink ~/.kimi/skills/<skill-name>` / `readlink ${KIMI_CODE_HOME:-$HOME/.kimi-code}/skills/<skill-name>` | 删除错误 link，重跑 sync；仍失败则回滚 INDEX 行 | skill-master | 当日 |
| 飞书同步失败 | `scripts/sync-skills-to-feishu.py` 返回 lark field/record error 或 `scripts/.sync.log` 有 error | 查看脚本退出码和 `scripts/.sync.log` 最新段 | 不手填飞书；先修字段或同步脚本，再重跑同步 | skill-master + wendangwang | 1 工作日 |

## Inputs & Outputs

- Inputs：skill 目录名 + owner + scope。样本行：`{"skill_name":"diagnose","owner":"skill-master","scope":"shared","source_path":"skills/diagnose/SKILL.md"}`。
- Outputs：`skills/INDEX.md` 一行 + canonical skill 目录 + 三端 symlink。样本行：`{"Name":"diagnose","Origin":"skill-master","Scope":"shared","Owner":"skill-master","Purpose":"Systematic debugging with root cause"}`。
- 幂等键：`Name`，跨 Origin / Scope 全局唯一；飞书 Skill Registry 也按 `Name` upsert。
- Receipt / 验证 token：三端发现列表都包含 `<skill-name>`，且 `scripts/sync-skills-to-feishu.py` 完成后 Skill Registry 可按 `Name` 搜到一行。
- 批量 evidence：不适用，本 SOP 每次只处理单个 skill。

## Do NOT During Execution

- 不准把 symlink 指向 `SKILL.md` 文件。Why：Codex / Kimi 的自动发现按目录级 skill 读取。How to apply：Step 3 必须用 `readlink` 验证 target。
- 不准为刷新 skill 重启共享 Kimi ACP。Why：Kimi 以 session 为发现快照，重启 ACP 会扩大影响面但不是生效条件。How to apply：Step 4 只新建 Kimi session；存量 session 由用户自行 `/reset`。
- 不准删除 `~/.kimi/skills/` legacy mirror。Why：Kimi native 目录是 `~/.kimi-code/skills/`，但 SuperMatrix 仍显式传 legacy 目录。How to apply：Step 3 的 sync 与 Step 4 的验证都保留并核对两条链接。
- 不准擅自迁移别的 session 正在维护的 skill。Why：canonical 池只接收 owner 同意的 skill。How to apply：Prerequisites 要保留原 owner 同意证据。
- 不准手填飞书替代脚本同步。Why：代码真相源会和展示面 drift。How to apply：Step 6 只跑同步脚本或修同步脚本。

## Verification

```bash
python3 scripts/validate-skill-frontmatter.py --canonical skills --index skills/INDEX.md
./scripts/sync-skills.sh
python3 scripts/sync-skills-to-feishu.py
```

验证通过判据：INDEX 有唯一 `Name` 行；scope 对应的发现目录 symlink 指向 `skills/<skill-name>`；目标后端发现列表符合 Step 4；飞书 Skill Registry 按 `Name` 只有一行。

## References

- `skills/INDEX.md`
- `scripts/sync-skills.sh`
- `scripts/sync-skills-to-feishu.py`
- `SOP-skill-hosting-upgrade-active-20260711-skup26.md`

## Completion Checklist

- [x] Step 1 在文件前 25 行内可达
- [x] Exceptions 至少 3 行且包含五要素
- [x] Inputs / Outputs 有样本行、幂等键和 receipt
- [x] 文件名、frontmatter、INDEX 六列同步
- [x] 批量 evidence 不适用
