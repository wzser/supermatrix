---
id: 68dd04
name: repo-branch-merge-patrol
description: 当每日分支巡检 cron 触发、daily-commit 撞到非 trunk 分支或 unmerged/冲突态、或用户要求盘点分支时用；不覆盖 session 自建短分支的完工自合（Repo Management Principle §5.8）与远程分支/push（gitmaster）。
status: active
owner: localgit
created: 2026-07-03
updated: 2026-07-14
---

# SOP: 仓库分支与合并巡检

## 核心目标（一句话）
让所有本地仓的分支分叉状态可见并按风险分级收敛——已合并即清理、可 fast-forward 即合回、干净可合先报告、真冲突只路由绝不自动解——终结「feature 分支常驻 / 未合并工作永久滞留 / 机制对分支无感知」三类事故（实测：SuperMatrix 仓 4 条未合并、after-sales 常驻 feature 分支、amz-radar 无 main）。

## When to Use
每日巡检 cron 触发（`param.patrol_cron`）；daily-commit 判定矩阵 R5 冻结某仓转来；用户要求分支盘点。**不适用**：session 按 Principle §5.8 完工自合自己的短分支；远程分支、push、发布（gitmaster）；worktree 挂载中的分支（本 SOP 只报告不动它）。

## Prerequisites
- git CLI 可用；repo 清单来源同判定矩阵 SOP（sessions.workdir）；`registry/repo-policies/<repo>.json` 可读写（trunk 登记）；`data/branch-patrol.jsonl` 可追加。

## Steps

### Step 1: 枚举与建档（逐仓逐分支）

- **要解决的问题**：机制对分支零感知，分叉拉长无人知道。
- **输入**：repo `{name, path}` 清单。
- **处理**：每仓采集：`git branch --list --format='%(refname:short)|%(objectname)|%(committerdate:iso8601)'`、`git worktree list --porcelain`、current branch、trunk 判定（manifest `trunk_branch` 字段 > 存在 `main` > 存在 `master`，都无 → C7）。每个非 trunk 分支算三个量：age_days（最后 commit 距今天数）、`git merge-base --is-ancestor <branch> <trunk>`（已并判定）、`git rev-list --left-right --count <trunk>...<branch>`（双向领先数）。
- **产物**：branch inventory（每分支一行）。
- **下一步消费方**：Step 2 分级。
- **失败回滚**：单仓 git 命令失败 → 该仓记 `patrol_error` 跳过，不影响其余仓；按异常表 Case-2。

### Step 2: 分级（自上而下首条命中；C1/C2 当场执行，C3-C7 产出待办）

| 级 | 判定条件（可机械执行） | 动作 |
|---|---|---|
| C0 保护 | 分支出现在 `git worktree list`（挂载中） | 不做任何 git 操作；age_days > `param.worktree_stale_days` → 报「疑似遗忘 worktree」进 digest |
| C1 已并未删 | is-ancestor(branch→trunk) 为真 且 非 current 且 非 C0 | `git branch -d <branch>`（只用 `-d`；失败即放弃转 C4 路由，绝不 `-D`） |
| H1 hold 待裁决 | 分支名匹配 `localgit/hold/*`，且无匹配的 `hold_merged` decision；C1 已并判定优先于本级 | 只报告并发 `hold_review`；绝不自动合并或删除，owner 只可选 `merge|archive|keep_until` |
| C2 可 ff 合回 | 普通分支（非 `localgit/hold/*`），is-ancestor(trunk→branch) 为真（trunk 零独有 commit）且 trunk 的 worktree 中脏文件与 branch 变更文件集无交集 | 在 trunk `git merge --ff-only <branch>` → 成功后按 C1 清理；merge 前后 sha 记 evidence |
| C3 干净可合 | 双向都有独有 commit，且临时 detached worktree（`git worktree add --detach`）中 `git merge --no-commit --no-ff <branch>` 无冲突（试完即 `git worktree remove`） | `param.auto_clean_merge=false`（第一阶段）：只报告进周 digest 附文件清单；用户批准翻 true 后才自动产 merge commit（回滚路径 `git revert -m 1`，parents 已入 ledger） |
| C4 真冲突 | C3 的 dry-run 出现冲突文件 ≥1 | 绝不自动解；跑 `references/SOP-repo-branch-merge-patrol-conflict-summary-prompt.md` 产两边 intent 摘要 + 冲突文件清单，owner hint 按 `references/owner-decision-rubric.md` §B/§D 模板附枚举动作与默认建议（fingerprint 去重同现行 notify gate）；owner `param.owner_response_days` 天无动作 → 周 digest 标红升级用户 |
| C5 常驻非 trunk | current ≠ trunk 且 trunk 落后 current 的天数 ≥ `param.parked_days` | 问 owner 一次，按 rubric §B（默认「合回」，仅 main 已事实废弃才「登记 trunk」）+ §D 模板附准则摘要与默认项；答案回写 manifest `trunk_branch`，此后本仓按新 trunk 巡检不再报 |
| C6 无 trunk | 仓内无 main/master 且 manifest 无 `trunk_branch` | 只报告进 digest 请登记 trunk；登记前本仓不执行任何合并/清理动作 |

- **产物**：每分支一个级别 + 已执行动作结果。
- **失败回滚**：C1/C2 均为 git 原子操作，失败时 git 自行 abort，工作区不变；记 evidence 后转待办级别。

### Step 3: evidence 落盘（逐项，§3.1）

- **处理**：每仓每分支写一行 `data/branch-patrol.jsonl`，**幂等键 = `run_id` + `repo` + `branch`**。巡检主程序完成后必须单独运行 `npm run branch-patrol-verify`，按 live git 重新核对每条分支恰有一条 evidence；apply 模式的 C1/C2 还要验证 ref 已删除及 trunk SHA 与 evidence 一致。样本行：`{"run_id":"patrol-2026-07-14T04:00:00.000Z","repo":"amz-sql","branch":"feat/aba-loader-v2","class":"C3","action":"report","age_days":21,"ahead_behind":"2 5","dry_run_conflicts":[],"sha_before":"ab12cd3","sha_after":"ab12cd3","routed_to":"digest"}`
- **产物 / 下一步消费方**：周 digest 从本文件聚合 C0(stale)/C3/C4/C5/C6 待裁决项；`npm run git-ledger` 可按 repo 联查。
- **失败回滚**：写入失败 → 本轮中止并 Console error（evidence 缺失的巡检不算跑过，禁止只做动作不留痕）。

### Step 4: 周 digest 汇总

- **处理**：与判定矩阵 SOP 的 pending_owner 项合并为同一张周裁决卡（周一 `param.digest_time` 发用户绑定群）：每项一行 = repo + 分支/路径 + 级别 + **localgit 按 `references/owner-decision-rubric.md` 预判的默认动作** + 枚举裁决选项（§D 模板，卡内附准则相关段摘要与 rubric 版本号）。用户/owner 只回「默认」或「选 X + 一句理由」；裁决 → 回写 manifest 或触发对应动作；卡片发送与升级线归 `SOP-daily-commit-skip-handling-*` 既有通知规则。H1 未裁决 24h 后合并升级一次，此后保留周 digest，不得变成静默终态。
- **失败回滚**：digest 发送失败按 Console 通知重试语义（500 可隔轮 retry，200 勿重发）。

## 异常枚举

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 1 ff 合并竞态失败 | C2 执行时 `--ff-only` 非 0（巡检间隙有新 commit） | exit code | git 自动 abort；该分支本轮改记 C3/C4 待办 | 无（正常竞态） | 连续 2 轮同分支竞态 → digest 报告 |
| 2 临时 worktree 创建/清理失败 | `git worktree add/remove` 非 0 | exit code + stderr | 跳过该仓 dry-run，C3/C4 无法判定记 `patrol_error`；当日 `git worktree prune` 清残留 | Console（level=warn） | 连续 2 轮同仓失败 → error 级 |
| 3 branch -d 拒绝删除 | C1 判定已并但 `-d` 非 0 | exit code | 立即放弃删除（说明 is-ancestor 判定与 git 结论冲突），重新分级为 C4 路由 owner；绝不改用 `-D` | repo owner（走 C4 hint） | 同 C4 升级线 |
| 4 owner 对 C4/C5 无响应 | hint 发出后 `param.owner_response_days` 天 evidence 无该分支新动作 | branch-patrol.jsonl 按 (repo,branch) 查最近 action | 停止重复 hint，转周 digest 标红 | 用户（digest） | 两轮 digest 仍无裁决 → digest 顶部置顶并附「建议默认动作」 |
| 5 trunk 判定歧义 | manifest trunk 与实际分支都存在但指向不同名 | 字符串比对 | 本仓全部动作冻结，只报告 | Console（level=warn） | 当周 digest 必须含裁决项 |

## 禁用项 (Do NOT during execution)

- **不准 `git branch -D`**。**Why**：强删未合并分支可能直接丢掉别的 session 在途工作（Principle §5.8 红线）。**How to apply**：全 SOP 只出现 `-d`，失败即转路由。
- **不准自动解冲突（含 `--ours`/`--theirs`/`reset --hard` 抹一边）**。**Why**：冲突两边都是有效 intent，机械抹除=静默丢工作（Principle §5.9）。**How to apply**：C4 只产摘要与路由。
- **不准 rebase / history rewrite**。**Why**：破坏 ledger 与真实历史的对应，daily-commit 产物必须可 revert。**How to apply**：合并只有 ff 与 merge commit 两种形态。
- **不准动 C0（worktree 挂载）分支**。**Why**：挂载=可能正在被并行 session 使用。**How to apply**：Step 2 首条即保护级。
- **不准在 dirty trunk 上做 C3 合并**。**Why**：工作区文件与 merge 结果混淆，无法干净回滚。**How to apply**：C3 dry-run 只在临时 detached worktree 做；真合并前置条件 = trunk worktree 干净或经判定矩阵先行提交。
- **不准发不带裁决准则与默认建议的 owner ask**。**Why**：裸问题让各仓 owner 自由发挥，分支处置跨仓五花八门、不可审计不可比。**How to apply**：C4/C5/C6 的 ask 与 Step 4 digest 一律按 `references/owner-decision-rubric.md` §D 模板组装（问题 + 枚举动作 + 准则摘要 + 预判默认项），缺任一要素不发。

## Inputs & Outputs 契约

- **Inputs**：repo 清单（同判定矩阵 SOP 样本）；触发事件样本：scheduler v2 任务 `localgit-branch-patrol`（`cron: 0 4 * * *`，type=script，command=`env LOCALGIT_BRANCH_PATROL_MODE=apply bash /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit/scripts/run-branch-patrol.sh`，cwd=`/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit`，timeout=1200000）。scheduler success 只证脚本被触发；业务完成只认独立 verifier 退出 0。
- **Outputs**：`data/branch-patrol.jsonl` 逐分支行（样本见 Step 3，幂等键 `run_id+repo+branch`）；manifest `trunk_branch` 增量；周 digest 卡片（样本行：`amz-sql · feat/aba-loader-v2 · C3 干净可合 · 默认:合回(rubric v1 §B) · [默认/删除/挂起+期限]`）。
- **Receipt / 验证 token**：`tail -20 data/branch-patrol.jsonl` 含本 run_id 行；C1/C2 动作可由 `git -C <repo> reflog -5` 与 sha_before/after 对账。
- **批量 evidence（§3.1）**：jsonl 每分支一行即逐项 evidence；只看该行能判「这条分支按哪级规则、执行了什么、落到谁手里」。

## Companion Files

- `references/SOP-repo-branch-merge-patrol-conflict-summary-prompt.md`：C4 冲突 intent 摘要 prompt 唯一权威。
- `references/owner-decision-rubric.md`：owner 裁决准则与消息模板唯一权威（与判定矩阵 SOP 共用；owner 按它判，不自由发挥）。
- 巡检不解决「文件该不该提交」——那是 `SOP-daily-commit-judgment-matrix-*` 的事；两者共用每周 digest、manifest 与 owner 裁决准则。

## 参数表

| param | 值 | 说明 |
|---|---|---|
| patrol_cron | `0 4 * * *`（每日 04:00） | 巡检触发；建任务走 spawn scheduler 正道 |
| digest_time | 周一 09:30 | 与判定矩阵 pending 项合并同卡 |
| auto_clean_merge | false | C3 第一阶段只报告；用户书面批准后翻 true |
| worktree_stale_days | 30 | C0 报「疑似遗忘」阈值 |
| parked_days | 7 | C5 常驻判定：trunk 落后天数 |
| owner_response_days | 1 | C4/C5/H1 首次合并升级时限；之后周 digest 保留 |

## Common Pitfalls

- 把 C2 的「trunk 零独有 commit」误算成「分支零独有」——方向反了会把落后分支当可 ff。
- dry-run 后忘记 `git worktree remove`——残留 worktree 会把该分支升为 C0 保护级，下轮全被跳过。
- 对同一分支反复发 C4 hint——必须走 fingerprint 去重与 Case-4 停发线。

## Verification

- 跑一轮后：`jq -r 'select(.run_id=="<本轮>") | [.repo,.branch,.class,.action] | @tsv' data/branch-patrol.jsonl | column -t` 覆盖 Step 1 枚举出的全部非 trunk 分支（数量对账），C1/C2 行的 sha_after 可在对应仓 `git log` 验证。

## Examples (Worked Cases)

- **Case A — 已并未删（典型路径）**：SuperMatrix 仓 `feat/spawn-closure-0.1`（未挂 worktree、is-ancestor 真）→ C1 `git branch -d` 成功 → jsonl 记 `{"class":"C1","action":"deleted"}`，仓库分支数 8→7。
- **Case B — 常驻分支（非平凡分支）**：after-sales 停在 `feat/step1-read-archive`、main 落后 ≥7 天 → C5 问 owner → owner 选「登记 trunk」→ manifest 写 `"trunk_branch":"feat/step1-read-archive"` → 下轮巡检本仓不再报，daily-commit 判定矩阵照常在该分支提交。

## 提交前自检（Definition of Done）

- [x] §9 渐进披露：文件顶到 Step 1 ≤ 25 行
- [x] §5 异常枚举：5 行，五要素齐
- [x] §1-2 自由度全锁：阈值全入参数表；trunk 判定、分级条件均可机械执行；prompt 下沉单文件
- [x] §3 样本行：Inputs/Outputs/evidence 均有真实样本 + 幂等键写死
- [x] §8 命名 + INDEX：文件名/frontmatter 一致，INDEX 六列已登记
- [x] §3.1 逐项 evidence：branch-patrol.jsonl 每分支一行
