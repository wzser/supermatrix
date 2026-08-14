# 仓库管理 完整文档（full doc）— owner 维护

> owner：localgit｜模块：repo-management｜section_no：260
> 角色：本文件是该能力的**单一事实源（SSoT）**。FP 从这里蒸馏出十几行 snippet 注入消费方的 CLAUDE.md；CLAUDE.md 用一行指针指回本文件。
> Last verified: 2026-08-11（点名的路径/命令/环境变量请定期校验仍存在）

## 1. 这个能力是什么（一句话）

repo-management 规定 session 完成一段本地仓库工作后，如何自主决定是否创建**本地 git commit**，以及围绕本地提交的状态自检、分支/状态管理、合并冲突处理、提交什么、绝不提交什么、提交信息怎么写、什么时候必须先问人。

这个模块解决的用户可感知问题：agent 干完活后反复问“要不要我 commit”，把一个可规则化的本地耐久化决策推回给人，打断用户流。把规则写成 SSoT 后，普通本地 commit 由 agent 自决；只有高风险、跨边界或意图不明的大改动才问人。

能力边界：

- 只管本地 git commit 决策、提交前状态自检、必要的本地分支/状态管理和合并冲突处理纪律。
- 不管远程 push、发布、打包、部署；这些属于 `gitmaster` 或对应发布 owner。
- 不把即时 repo-management 自决提交和 scheduled daily-commit 巡检混在一起；daily-commit / branch patrol 是 localgit 自己的周期治理子能力，纳入范围由 runtime `sessions` 的治理字段本地只读派生（`status != deleted`、`scope != child`、`affiliated_to = first-principle`、`category` 不为 `外部`/`员工`、`workdir` 非空且为 git repo），不再依赖 Feishu 的 Daily Commit 开关；scheduler 只负责触发。
- daily-commit 先落 manifest 或 behavior-dir fast-path 已判定的安全子集；L2 reviewer 故障时只把灰区留为 `UNREVIEWED` 并记录 localgit-owned failure，不丢弃安全子集。可隔离的非敏感 E3/E5 争议变更可持久化到 `localgit/hold/<repo>/<fingerprint12>`，由 owner 通过 `hold-decision` 选择 `merge`、`archive` 或 `keep_until`；hold 分支不自动合并或强制删除。
- 不替其他 owner 判断业务内容是否正确；只判断当前 session 完成的本地变更是否应形成聚焦 commit。

## 2. 最小用法（消费方最常用的那条路径）

当你完成一个独立逻辑单元，且变更是你本轮为用户请求产生的本地仓库变更时，按下面路径自决提交，不要再问“是否需要提交”：

```bash
git status
git status --short --branch
git diff -- path/to/file.md path/to/other-file.ts
git add -- path/to/file.md path/to/other-file.ts
git diff --cached --stat
git diff --cached --check
<repo verification command>
git commit -m "docs(repo): clarify local commit decisions" \
  -m "Why: keep completed local work durable without asking the user every time." \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

如果仓库没有可用的 git identity，用一次性 `-c`，不要改 `git config`：

```bash
git -c user.name="$SM_SESSION_NAME" \
  -c user.email="${SM_SESSION_NAME:-agent}@supermatrix.local" \
  commit -m "docs(repo): clarify local commit decisions" \
  -m "Why: keep completed local work durable without repeated human prompts." \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

自决提交判定：

- 用户明确说“做完提交 / commit / 留档 / 落 commit”时，完成验证后直接 commit。
- 用户要求你“改 / 修 / 写 / 生成”仓库内代码、测试、文档、配置，并且你已完成一个独立逻辑单元时，默认直接 commit。Why：本地 commit 是可 `git revert` 的耐久检查点，不是远程发布。
- 你只做调查、review、解释、方案、dry run，或用户明确说“先别提交 / 不要改 / 只看”时，不 commit。
- 改动横跨多个 owner、改变跨 session 公共契约、涉及不可逆操作、包含疑似敏感文件、混入他人未提交改动、或是用户没表达过提交意图的大范围重写时，先问人或 spawn 对应 owner。

提交前最小检查：

1. `git status` 看清当前分支、rebase/merge 状态、staged/unstaged/untracked；再用 `git status --short --branch` 做紧凑复核。
2. `git diff -- <file...>` 只审你准备提交的文件。
3. 用文件名精确 `git add -- <file...>`。
4. `git diff --cached --stat` 和 `git diff --cached --check` 确认 staged 集合和基础空白问题。
5. 跑与改动相称的验证命令；没有合适命令时，在 final 里说明“未运行验证及原因”。

## 3. 最容易踩的坑（高频 failure mode）

**现象：agent 干完小改后问“要不要我 commit？”**

原因：把本地 commit 当成需要人确认的发布动作。正确做法：如果这是用户要求的仓库变更，已经完成一个独立逻辑单元，且没有触发先问条件，直接本地 commit。Why：本地 commit 可审计、可 revert，比未提交 worktree 更安全。

**现象：commit 里混入 `.env`、缓存、临时输出或大二进制。**

原因：用了 `git add -A` 或 `git add .`。正确做法：NEVER 用 `git add -A` / `git add .`；只用 `git add -- path/to/file` 精确 stage 已审过的文件。删除文件也按文件名处理：`git add -- deleted/path` 或在确认删除是目标行为时 `git rm -- deleted/path`。

**现象：把用户原本在工作区里的改动一起提交了。**

原因：没有区分“我本轮改的文件”和“已有脏文件”。正确做法：提交前看 `git status --short`；只 stage 本轮负责的文件。若同一个文件里混有用户改动和你的改动，能安全拆分时用 `git add -p`；不能安全拆分时先问人，不要整文件提交。

**现象：遇到陌生分支、lock 文件或奇怪 staged 状态后直接继续操作。**

原因：把 git 状态当成噪音。正确做法：任何 commit、切分支、merge/rebase、reset/clean/restore 前先 `git status`。陌生状态先调查归属；它可能是用户或另一个 session 的在途工作。`.git/index.lock` 先查持有进程，不要直接删除。

**现象：为绕过 commit 失败直接用了 `--no-verify`、`--no-gpg-sign` 或改了 git config。**

原因：把 hook / 签名 / identity 问题当成噪音。正确做法：NEVER 用 `--no-verify` 或 `--no-gpg-sign` 跳过仓库保护；NEVER 改 `git config`。先报告失败原因。identity 缺失时只用 `git -c user.name=... -c user.email=... commit` 做一次性提交。

## 4. 最佳案例参考（必填 — canonical worked example）

**Case A — 典型路径：干完一段文档工作后自主提交**

输入：

> “把本地 git 提交的决策规则写清楚，产出 full doc，写到 `fp-modules/repo-management-full.md` 并在你的仓 git commit。”

决策：

- 这是明确的仓库内文档产出请求，用户还明确要求 commit。
- 变更是一个独立逻辑单元：新增 repo-management full doc。
- 不涉及 push、发布、打包，也不是 scheduled daily-commit 巡检场景。
- staged 集合只应包含 `fp-modules/repo-management-full.md`。

命令：

```bash
mkdir -p fp-modules
git status --short
git diff -- fp-modules/repo-management-full.md
git add -- fp-modules/repo-management-full.md
git diff --cached --stat
git diff --cached --check
git -c user.name="$SM_SESSION_NAME" \
  -c user.email="${SM_SESSION_NAME:-agent}@supermatrix.local" \
  commit -m "docs(repo): add repo management full doc" \
  -m "Why: define when sessions should create local commits without asking the user." \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

输出：

- 一个本地 commit。
- final 只报告文件路径和 commit hash；不再问“还要不要提交”。

**Case B — 非平凡分支：判断该先问人而不是自决**

输入：

> “顺手把这几个 repo 乱七八糟的改动都清一下，能 commit 的都 commit。”

现场：

```bash
git status --short
 M src/spawn/dispatcher.ts
 M AGENTS.md
?? .env.local
?? data/prod.sqlite
?? captures/run-20260601.mov
```

决策：

- `.env.local` 是疑似凭证文件，必须跳过并提示。
- `data/prod.sqlite` 和 `captures/*.mov` 是 runtime / 大二进制 artifact，默认不提交。
- `src/spawn/dispatcher.ts` 改变跨 session 调度行为，属于公共契约风险；如果不是本 session 本轮明确完成的改动，应先问 owner 或 spawn 对应 owner。
- `AGENTS.md` 是行为指令，可能能提交，但若和 dispatcher 改动耦合且无法拆清 intent，先问人。

正确输出：

> 我不会自动把这组变更打包提交：里面混有疑似凭证、本地数据库、大二进制和跨 session 调度源码。可自决跳过 `.env.local` / `data/prod.sqlite` / `captures/run-20260601.mov`；`src/spawn/dispatcher.ts` 需要 owner 确认或明确任务背景后再提交。

错误做法：

```bash
git add -A
git commit -m "update files"
```

**Case C — 合并冲突：先看懂两边，再合并，不抹掉任何一边**

输入：

> “你在 feature 分支上补了文档，现在合回 `main`。”

现场：

```bash
git switch main
git merge localgit/repo-management-scope2-20260601
# Auto-merging fp-modules/repo-management-full.md
# CONFLICT (content): Merge conflict in fp-modules/repo-management-full.md
```

正确路径：

```bash
git status
git diff -- fp-modules/repo-management-full.md
sed -n '1,220p' fp-modules/repo-management-full.md
# 逐个读取 <<<<<<< / ======= / >>>>>>> 冲突块
# 判断 main 一边保留了哪些既有提交纪律，feature 一边新增了哪些分支/冲突/状态自检规则
# 编辑文件，把两边有效内容合并成同一个段落，而不是整块选择 ours 或 theirs
git diff -- fp-modules/repo-management-full.md
git add -- fp-modules/repo-management-full.md
git status
git merge --continue
```

决策：

- 默认目标是解决冲突并保留两边有效 intent，不是让冲突标记消失。
- 冲突块里如果一边是本轮新增规则，另一边是已有红线，通常应合并成一条更完整的规则。
- 如果冲突牵涉跨 session 公共契约、owner 边界，或看不懂哪边代表最新真实意图，暂停并问人或 spawn owner；不要赌。

错误做法：

```bash
git checkout --ours fp-modules/repo-management-full.md
git add -- fp-modules/repo-management-full.md
git merge --continue
```

这会把另一边的改动整块抹掉；除非用户明确要求丢弃某一边，否则不属于 repo-management 的默认冲突处理。

## 5. 完整契约 / API / 报错排查（细节区）

### 5.1 自主提交 vs 先问人的判定表

判定信条：本地 commit 是持久化检查点，不是发布、不是质量背书。代码疑似有缺陷、实现未完成不构成拒绝本地提交的理由（commit 可 `git revert`，worktree 丢失不可逆）；拒绝自动/自主提交的理由收敛为：真实访问凭据、运行库与大二进制、跨 owner 契约未验证、身份文档大改、冲突态。飞书群 ID/名称与本地私有数据不是阻断理由。逐文件判定矩阵见 `sop/SOP-daily-commit-judgment-matrix-active-20260805-1a186q.md`。

| 场景 | 决策 |
|---|---|
| 用户明确要求 commit / 留档 | 完成验证后自决 commit |
| 完成一个用户要求的独立代码、测试、文档、配置变更 | 自决 commit |
| 只做调查、解释、review、方案、dry run | 不 commit |
| 用户明确说不要提交 | 不 commit |
| 当前改动尚未形成可独立审计、可 `git revert` 的逻辑单元 | 不 commit；说明与后续变更不可拆分的边界 |
| 已形成独立逻辑单元，但验证失败或仍是 WIP | 不以质量/WIP 为由拒绝本地 commit；如不触发其他先问条件，commit 并在 final 与 commit body 如实注明失败或 WIP，不把它表述为完成或发布 |
| 同一 commit 会混入无关改动 | 拆成小 commit；拆不了就先问 |
| 同一文件混有用户改动和 agent 改动 | 能安全 `git add -p` 才拆；否则先问 |
| 当前 git 状态陌生：陌生分支、陌生脏文件、merge/rebase 中、lock 文件、奇怪 staged 集合 | 先调查状态来源；不要先 commit / 切分支 / 删除 |
| 触及跨 session 公共契约、shared infra、owner 边界 | 先确认 owner / spawn owner；不要静默提交 |
| 需要 push、发布、打包、部署 | 不属于本模块；转 gitmaster / 发布 owner |
| 涉及 reset、clean、checkout 覆盖、amend 已发布提交、改 git config | 必须先问人并拿到明确同意 |

### 5.2 本地 git 红线

- MUST keep commits small and focused：一个 commit 只表达一个逻辑单元。
- MUST 默认在 `main` 干活；除非任务明确要求隔离或仓库已有流程要求分支。
- MUST 让自动化提交机制（localgit daily-commit）同样受本节全部红线约束：其提交动作走判定矩阵 SOP 的逐文件选择性 staging，机制自身也 NEVER `git add -A`。
- NEVER push 远程，除非用户明确要求。
- NEVER 用 `git add -A` 或 `git add .`。
- NEVER 自动提交真实访问凭据：`.env`、凭证、密钥、token、证书、cookies、私钥、password 或其实际承载文件；这不包括飞书群 ID/名称、人员名称、本地路径、PII、私有客户/业务数据等仅因私有而被标记的内容。
- NEVER 提交缓存、依赖目录、临时文件、日志、coverage、runtime SQLite、构建残留、大二进制 artifact，除非用户明确要求且仓库本来就把该类文件作为 source。
- NEVER 用 `--no-verify` 或 `--no-gpg-sign` 绕过 hook / 签名。
- NEVER amend 已发布或可能已被别人依赖的提交；本地未分享 commit 的 amend 也只有在用户要求整理历史时才做。
- NEVER 改 git config，包括 `user.name`、`user.email`、hook、signing、remote。需要临时 identity 时用 `git -c ... commit`。
- NEVER 未经用户明确同意执行 `git reset --hard`、`git clean -f`、`git checkout .`、`git restore .`、`git restore --staged .` 这类会丢改动或大范围改 staged 状态的命令。
- NEVER 用 `git branch -D` 删除分支，除非用户明确要求；陌生分支可能是别人的在途工作。
- NEVER 在合并冲突中用 `git checkout --ours` / `git checkout --theirs` 或 `reset --hard` 一把抹掉某一边，只为“让冲突消失”。

### 5.3 提交什么

提交可追溯、可复现、对行为或知识源有价值的文件：

- source code、tests、fixtures；
- package / lock files；
- schema、migration、typed config；
- AGENTS.md / CLAUDE.md；
- SOP、Principles、templates、owner full doc、shared docs；
- 为完成任务必要且仓库已有惯例追踪的静态资产。

状态自检和 stage 规则：

```bash
git status
git status --short
git diff -- file1 file2
git add -- file1 file2
git diff --cached --name-status
```

如果文件名包含空格，用引号：

```bash
git add -- "docs/My Report.md"
```

如果需要交互拆分同一文件：

```bash
git add -p -- path/to/file
git diff --cached -- path/to/file
```

### 5.4 绝不提交什么

遇到以下真实访问凭据或运行噪音，默认跳过并在 final 里提示：

- `.env`、`.env.*`、`.npmrc`、`.netrc`、credential 文件、API key、token、cookies；
- `*.pem`、`*.key`、`*.p12`、`id_rsa*`、SSH / TLS 私钥或证书；
- `.aws/`、浏览器 profile、会话导出中实际承载凭据的部分；
- `node_modules/`、`.venv/`、`__pycache__/`、`.pytest_cache/`、`.cache/`；
- `*.log`、coverage、tmp、`.DS_Store`；
- runtime DB：`*.sqlite`、`*.db`，除非仓库明确把 schema fixture 作为 source；
- 大二进制、视频、截图、导出包、压缩包，除非用户明确要求作为交付物提交。

飞书群 ID/名称、人员名称、本地路径、PII、私有客户/业务数据不因“私有”而跳过；它们按文件可读性、真实凭据命中、大小与仓库交付语义判定。

尊重 `.gitignore`。不要用 `git add -f` 绕过 ignore；只有用户明确要求提交某个 ignored source 文件，且你确认不是敏感文件时，才可按文件名 `git add -f -- path`。

### 5.5 提交信息约定

写 commit message 时先看 `git log --oneline -8`，遵守本仓既有风格。没有明显风格时，用短 subject + Why body：

```bash
git commit -m "fix(spawn): prevent duplicate child dispatch" \
  -m "Why: retries must dedupe one logical task to avoid interleaved side effects." \
  -m "Co-Authored-By: Codex <noreply@openai.com>"
```

要求：

- subject 简洁，描述行为结果，不堆文件名。
- body 聚焦 why：这个 commit 防止什么坏结果、保存什么契约、修复什么用户可感知问题。
- 遵守本仓的前缀习惯，例如 `fix:`、`feat:`、`docs:`、`sop:`、`principles:`。
- backend 溯源用 `Co-Authored-By`：Codex 用 `Codex <noreply@openai.com>`，Claude 用 `Claude <noreply@anthropic.com>`。

反例：

```bash
git commit -m "update"
git commit -m "changes"
git commit -m "fix files"
```

### 5.6 验证和失败处理

验证强度跟风险匹配：

- 文档-only：至少跑 `git diff --cached --check`，必要时检查链接 / 文件路径存在。
- 代码改动：跑该仓实际 test / typecheck / lint；先确认命令存在，不要照搬其他仓模板。
- shared infra 或跨 session contract：除了测试，还要确认受影响 owner，并按对应原则通知或请求确认。

commit 失败时：

- hook 失败：读错误，修复后重跑；不要跳 hook。
- identity 失败：用一次性 `git -c user.name="$SM_SESSION_NAME" -c user.email=... commit`；不要写 git config。
- 签名失败：不要 `--no-gpg-sign`；报告签名失败和未提交状态，让用户决定。
- staged 集合不对：用文件名精确 unstage，例如 `git restore --staged -- path/to/file`。不要 `git restore --staged .`。

### 5.7 git 状态自检

本模块的贯穿纪律：先自检，调查后再决定是否覆盖、删除、切换或提交。`git status` 不是形式动作；它决定你是否正在踩到用户或另一个 session 的在途工作。

任何 commit、切分支、merge/rebase、reset/clean/restore、删除分支或其它破坏性操作之前，先跑：

```bash
git status
git status --short --branch
```

要分清三类状态：

- 我本轮为了用户请求改的文件：可以继续 diff、stage、验证、commit。
- 已有脏文件 / 在途工作：默认不是我的，不 stage、不覆盖、不删除；同文件混合时用 `git add -p` 拆，拆不清就问。
- git 操作中间态：merge/rebase/cherry-pick 正在进行、staged 集合已存在、branch 不是预期、存在 lock 文件；先完成诊断，不要继续叠操作。

常用调查命令：

```bash
git branch --show-current
git status
git diff --name-status
git diff --cached --name-status
git ls-files --others --exclude-standard
git log --oneline --decorate -8
```

撞到意料之外的状态时：

- 陌生文件：先看路径、文件类型、mtime、diff；疑似敏感文件或 runtime artifact 默认跳过。
- 陌生分支：先看它是什么、谁可能在用、和 `main` 差什么；不要假设它过时。
- 奇怪 config：不要改 `git config`；只读确认，例如 `git config --show-origin --get user.name`，需要身份时用一次性 `git -c`。
- lock 文件：先查进程，例如 `lsof .git/index.lock` 和相关 `git` 进程；不要直接删。只有确认没有持有进程、没有正在运行的 git 操作，并且用户明确同意或仓库 owner SOP 允许时，才处理 stale lock。

### 5.8 分支策略

默认在 `main` 干活并提交。这个仓库的本地 commit 是耐久检查点，不是远程发布；无必要勿增分支。

适合创建隔离 / feature 分支的情况：

- 用户明确要求分支、隔离实验、或要求不要影响 `main` 当前状态。
- 任务大、跨多步、可能需要多次中间 commit，短时间内不应阻塞 `main` 的其它工作。
- 需要和另一个 session 并行改同一仓，分支能降低 worktree 状态互相污染。
- 需要试验高风险方案，但还不能确认最终会保留。

不该新建分支的情况：

- 小而聚焦的代码、测试、文档、配置改动，能在一轮内验证并提交。
- 只是在当前文件上补一条规则、改一个 bug、更新一个 SOP。
- 创建分支只是为了“显得像 PR 流程”；本地仓没有远程 review 流程，不需要模拟。

自建分支命名：

```bash
git switch -c "${SM_SESSION_NAME:-localgit}/repo-management-scope2-20260601"
```

约定：

- 前缀用 session 名，便于追踪归属。
- topic 用小写短横线，描述用户可感知的工作单元。
- 日期用 `YYYYMMDD`；不要用空格、中文标点或含糊名字如 `test` / `tmp` / `new-branch`。

完成后合回 `main`：

```bash
git status
git branch --show-current
git switch main
git status
git merge --ff-only "${SM_SESSION_NAME:-localgit}/repo-management-scope2-20260601"
```

如果不能 fast-forward，先看清原因：

```bash
git log --oneline --decorate --graph --all -20
git merge "${SM_SESSION_NAME:-localgit}/repo-management-scope2-20260601"
```

出现冲突就按 §5.9 解决。合回后如果要清理分支，只能清理你自己创建且已合并的分支，优先用安全删除：

```bash
git branch -d "${SM_SESSION_NAME:-localgit}/repo-management-scope2-20260601"
```

NEVER 用 `git branch -D`，除非用户明确要求。`-D` 会强制删除未合并分支，可能直接丢掉别人或另一个 session 的在途工作。

撞到不是你创建的分支 / 陌生分支：

- 先调查：`git branch --show-current`、`git branch --all --verbose --no-abbrev`、`git log --oneline --decorate --graph --all -20`。
- 不要假设它过时，不要擅自切走后改状态，不要 merge/rebase/reset/delete。
- 如果必须在它上面继续，先确认这是用户要你接手的分支；否则回到 `main` 或问人。

跨仓的分支收敛（已合并分支清理、fast-forward 合回、干净可合报告、真冲突路由 owner）由 localgit 每日巡检执行，规则见 `sop/SOP-repo-branch-merge-patrol-active-20260714-68dd04.md`；本节只约束单 session 自己的分支操作，两者共用 owner 裁决准则 `sop/references/owner-decision-rubric.md`。

### 5.9 合并冲突处理

默认是解决冲突，而不是丢弃改动。冲突表示两边都改了同一语义区域；repo-management 的目标是保留两边有效 intent，并形成一个可读、可验证的新结果。

红线：

- 不用 `git checkout --ours <file>` / `git checkout --theirs <file>` 当通用解法。
- 不用 `git reset --hard`、`git restore .`、`git checkout .` 抹掉一边来“让冲突消失”。
- 不为了赶进度删除冲突块里的陌生内容；先确认它代表什么。

解决前先看懂三件事：

1. 当前处于什么操作：`git status` 会显示 merge / rebase / cherry-pick / revert。
2. 哪些文件冲突：`git status` 和 `git diff --name-only --diff-filter=U`。
3. 冲突两边各自代表什么 intent：读冲突标记，必要时看 stage 版本。

有用命令：

```bash
git status
git diff --name-only --diff-filter=U
git diff -- path/to/conflicted-file
git show :1:path/to/conflicted-file  # common base
git show :2:path/to/conflicted-file  # ours
git show :3:path/to/conflicted-file  # theirs
```

逐文件处理：

1. 打开文件，逐个处理 `<<<<<<<` / `=======` / `>>>>>>>`。
2. 判断保留 ours、保留 theirs，还是把两边合并成第三版；默认优先合并有效内容。
3. 删除冲突标记，保留最终文本。
4. `git diff -- <file>` 复核最终结果。
5. `git add -- <file>` 标记已解决。
6. 所有冲突解决后，按当前操作续：`git merge --continue` 或 `git rebase --continue`。

拿不准时先问人：

- 哪边对依赖业务判断或用户意图。
- 冲突牵涉跨 session 公共契约、Principles、AGENTS.md / CLAUDE.md、调度 / spawn / runtime 行为。
- 冲突两边都像是有效改动，但无法安全合并。

### 5.10 回滚和本地结束态

- 回滚已提交工作优先用 `git revert <commit>`。不要用 history rewrite 当日常回滚。
- 未提交改动只有在确认它属于本轮且用户明确同意丢弃时，才可用 reset/clean/restore 类破坏性命令。
- 不 push，所以本模块完成后只报告本地 commit hash。

## 6. 外部依赖

- `git` CLI。
- `$SM_SESSION_NAME`：框架注入的 session identity；用于一次性 commit identity 和审计归属。
- 仓库本身的 hook / test / typecheck / lint 命令。
- `session-catalog.json`：只在需要判断 owner 边界或 spawn owner 时使用。
- `gitmaster`：远程 push / 发布 / 打包 owner；本模块不接管。
- localgit daily-commit 子能力：脏工作区 scheduled 巡检、逐文件提交判定矩阵（`sop/SOP-daily-commit-judgment-matrix-active-20260805-1a186q.md`）、分支合并巡检（`sop/SOP-repo-branch-merge-patrol-active-20260714-68dd04.md`）、ignore policy、owner 裁决准则与 hint 去重、hold review / `hold-decision`、ledger / dispatch / decision log；本模块只定义单个 session 完工后的即时本地 commit 决策。
