---
id: t0ec7u
name: git-ledger
description: 当要审计 localgit 管理的某仓 commit/skip 历史、或要回滚一笔 daily-commit 产物（含 merge commit）时用；不覆盖写 ledger（daily-commit 脚本自动写）与远程 push / 发布（gitmaster）。
status: active
owner: localgit
created: 2026-06-01
updated: 2026-07-04
---

# SOP: git-ledger 审计与非破坏性回滚

## 核心目标（一句话）
让 localgit 管理的每笔 commit / skip 都能从 append-only 账本查到（谁、哪仓哪支、哪个 sha、动了哪些文件、怎么回滚），回滚一律 `git revert`，绝不 history rewrite。

## When to Use
要审计某仓 daily-commit / 分支巡检的提交历史；repo owner 报仓名 + sha 请求回滚；要确认某 merge commit 的 parent 关系。**不适用**：写 ledger 行（`daily-commit*.ts` / 巡检脚本自动追加）；判定该不该提交（走 `SOP-daily-commit-judgment-matrix-*`）；远程 push / 发布回滚（gitmaster）。

## Prerequisites
- 工作区 `/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit`；账本 `data/git-ledger.jsonl` 存在；`npm run git-ledger` 可用。

## Steps

### Step 1: 查账本定位记录

- **要解决的问题**：先从账本锁定目标记录，不凭记忆猜 sha / 仓。
- **输入**：仓名（session 名）或规范仓路径；可选 `--operation commit|merge_detected|skip`、`--since <ISO时间>`、`--limit N`。
- **处理**：`npm run git-ledger -- --repo <session-name> --limit 50`；只看 merge 加 `--operation merge_detected --limit 20`；多 session 共用同一 workdir 时改用 `--repo-path <绝对路径> --limit 50`（别用 session 别名）。
- **产物**：目标 ledger 行（含 `commit_sha` / `parents` / `changed_files` / `operation`）。
- **下一步消费方**：Step 2 对照真实 Git 对象。
- **失败回滚**：只读查询，无需回滚；查询为空走异常表 Case-1。

### Step 2: 对照真实 Git commit

- **要解决的问题**：ledger 是审计线索不是源码事实，动仓前必须对照 Git 本体。
- **输入**：Step 1 的 `repo_path` + `commit_sha`。
- **处理**：`cd <repo-path> && git show --stat <commit-sha>`；比对 ledger 行的 `changed_files` 与 `parents`。不一致 → 停，按异常表 Case-1 补录后再继续。
- **产物**：已验证的目标 commit（含是否 merge：parents 数 >1）。
- **下一步消费方**：非 merge → Step 3；merge → Step 4。
- **失败回滚**：只读，无需回滚。

### Step 3: 非 merge commit 回滚

- **要解决的问题**：撤销一笔 daily-commit 产物且保留完整历史。
- **输入**：Step 2 验证过的单 parent commit。
- **处理**：`cd <repo-path> && git revert <commit-sha>`（不加 `--no-verify`，不改 hook）。
- **产物**：新的 revert commit sha；ledger 由下轮 daily-commit 记录（或手工 note 关联原 sha）。
- **下一步消费方**：请求方（owner / 用户）确认工作区状态。
- **失败回滚**：revert 冲突走异常表 Case-3（`git revert --abort` 回到干净态）。

### Step 4: merge commit 回滚（先验 parent 再 `-m`）

- **要解决的问题**：merge revert 选错 parent 会把主线撤成分支线。
- **输入**：Step 2 验证过的多 parent commit。
- **处理**：`git show --no-patch --pretty=raw <commit-sha>` 确认 parent 1 是主线（与 ledger `parents[0]`、`branch` 互证）；确认后 `git revert -m 1 <commit-sha>`。parent 关系不清 → 停，问 owning session，不动仓。
- **产物**：revert commit sha。
- **下一步消费方**：请求方确认；ledger 留痕同 Step 3。
- **失败回滚**：同 Case-3；未执行 revert 前停手即零副作用。

## 异常枚举（§5）

| Case | 触发条件（可机械判定） | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|---|
| 1 账本缺目标记录 / 与 Git 不符（上游数据脏） | 查询空但 `git log` 有该 sha，或 `changed_files`/`parents` 与 `git show` 不一致 | Step 1 查询结果 × Step 2 `git show` 比对 | 以 Git 本体为准继续审计；ledger 追加一行补录说明（append-only，不改旧行） | localgit（本地记录即可） | 同类缺录一周 ≥2 次 → 查 `git-ledger*.ts` 写入路径并修复 |
| 2 repo_path 不存在 / 已迁移（下游不符） | `test -d <repo_path>` 非 0 | Bash 探测 | 停；不猜新路径，向 owning session 确认迁移后再继续 | owning session（spawn2.0 inline） | 24h 无回复 → 升级用户绑定群 |
| 3 `git revert` 冲突（自身执行异常） | revert 退出码非 0 且工作区出现冲突标记 | exit code + `git status --short` 含 `U` | `git revert --abort` 回到干净态；把冲突文件清单交 owning session 判断，不用 `--ours/--theirs` 抹一边 | owning session | 24h 无回复 → 记 decision `blocked`，保持未回滚 |
| 4 ledger 行 JSON 损坏（上游数据脏） | 逐行 `JSON.parse` 抛错 | `npm run git-ledger` 报错行号 / jq 校验 | 跳过坏行继续查询；坏行行号记入本地 note，不重写文件 | localgit | 坏行 ≥3 → 查写入端并发 bug 后修复 |

## 禁用项 (Do NOT during execution)

- **不准 history rewrite（`reset --hard` / rebase / amend 已记账 commit）**。**Why**：会破坏 ledger 与真实 Git 历史的对应关系，审计线索作废。**How to apply**：Step 3/4 只允许 `git revert`。
- **不准手工编辑 / 重写 `data/git-ledger.jsonl` 既有行**。**Why**：append-only 是审计可信的前提。**How to apply**：更正一律追加新行（Case-1 / Case-4）。

## Inputs & Outputs 契约（§3）

- **Input**：查询参数。样本：`npm run git-ledger -- --repo ziniao --operation skip --limit 20`（`--repo` 取 session 名；共用 workdir 用 `--repo-path /Users/LOCAL_USER/SuperMatrix`）。
- **Output — ledger 行**样本（真实，节选）：`{"recorded_at":"2026-07-03T02:20:42.746Z","run_id":"daily-2026-07-03T02:20:03.532Z","repo":"hrhrhrhrhr","repo_path":"/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/hrhrhrhrhr","branch":"main","actor":"localgit","operation":"commit","head_before":"e691a91c...","head_after":"5c781514...","commit_sha":"5c781514..."}`；skip 行另含 `skipped_reason` 与 `dirty_fingerprint`。
- **Output — 回滚产物**：revert commit sha（`git revert` 标准 message 自带 `This reverts commit <sha>`，即回滚与原 commit 的关联键）。
- **幂等键**：ledger 行 = `(run_id, repo, operation)`（写入端保证）；回滚 = 原 `commit_sha`——revert 前先 `git log --oneline --grep "This reverts commit <sha>"` 查重，已有 revert 就不再执行第二次。
- **Receipt / 验证 token**：见 Verification 探针；无独立 token，由 revert commit 存在性间接证明。

## Companion Files

- 无（查询实现见 `src/scripts/git-ledger-query.ts`，写入实现见 `src/scripts/git-ledger*.ts`）。

## Common Pitfalls

- 拿 ledger 当源码事实——它是审计线索，动仓前必须 Step 2 对照 `git show`。
- merge revert 不验 parent 直接 `-m 1`——parent 1 不一定是主线，必须与 ledger `parents` 互证。

## Verification

- 回滚闭环探针：`cd <repo-path> && git log --oneline -3 | grep -q "Revert"` 且 `git status --short` 为空。
- 账本可查探针：`cd /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/localgit && npm run git-ledger -- --repo <repo> --limit 5` 返回含目标 sha 的行。

## Examples (Worked Cases)

- **Case A — 典型路径（审计 + 回滚）**：owner 报「hrhrhrhrhr 仓 5c781514 要撤」→ Step 1 `--repo hrhrhrhrhr` 命中 `operation:"commit"` 行 → Step 2 `git show --stat 5c781514` 与 `changed_files` 一致 → Step 3 `git revert 5c781514` 产出 revert sha，探针通过。
- **Case B — 非平凡分支（merge parent 不清 → 停）**：`--operation merge_detected` 命中一条 parents=[a,b] 记录，`git show --pretty=raw` 显示 parent 1 与 ledger `branch` 主线对不上 → 按 Step 4 停手，spawn owning session 确认；留给下一轮的是 Case-3 升级时限计时与未动的工作区。

## 提交前自检（Definition of Done）

- [x] **§9 渐进披露**：Step 1 于第 24 行可达。
- [x] **§5 异常枚举**：4 行五要素齐（上游脏 ×2 / 下游不符 / 自身异常）。
- [x] **§1-2 自由度全锁**：命令 / 判定条件 / 升级阈值全部写死，无模糊词。
- [x] **§3 样本行**：查询样本 + 真实 ledger 行 + 幂等键（含 revert 查重命令）。
- [x] **§8 命名 + INDEX**：`SOP-git-ledger-active-20260704-t0ec7u.md` 四件套一致，INDEX 六列已登记。
- [x] **§3.1**：非批量 SOP（单笔审计/回滚），SOP 级 receipt 即足。
