# SOP Index

> 命名规范见 SOP Principle §8：`SOP-<topic>-<status>-<YYYYMMDD>-<id>.md`。改 SOP 同步重命名 + 改本表对应行；ID 不可改。

| SOP 文件 | 状态 | 更新日期 | Owner | 何时用 | 上下游 |
|---|---|---|---|---|---|
| [SOP-daily-commit-judgment-matrix-active-20260805-1a186q.md](SOP-daily-commit-judgment-matrix-active-20260805-1a186q.md) | active | 2026-08-05 | localgit | 判定「某仓某文件该不该被 daily-commit 自动提交」；本地私有数据与飞书标识可提交，可隔离的 E3/E5 分歧提交到 hold 分支 | 上游：runtime sessions 治理选择 / daily-commit 主循环 / skip-handling 人工补提交；下游：git-ledger、hold_review、repo-policies manifest；类目目录引用 references/daily-commit-ignore-policy.md |
| [SOP-repo-branch-merge-patrol-active-20260714-68dd04.md](SOP-repo-branch-merge-patrol-active-20260714-68dd04.md) | active | 2026-07-14 | localgit | 每日分支巡检 / 未合并分支、hold 待裁决与真冲突的分级收敛（C0-C6/H1） | 上游：scheduler 每日 04:00 script / 判定矩阵 R5；下游：branch-patrol.jsonl、独立 verifier、周裁决 digest |
| [SOP-daily-commit-skip-handling-active-20260805-3wa4uu.md](SOP-daily-commit-skip-handling-active-20260805-3wa4uu.md) | active | 2026-08-05 | localgit | daily-commit 后分类 skipped、处理 hold_review、抑制重复 hint 并记录 owner 裁决 | 上游：daily-commit 运行结果 / committed_hold；下游：dispatches / decisions、hold-decision、FP escalation、周裁决 digest |
| [SOP-git-ledger-active-20260704-t0ec7u.md](SOP-git-ledger-active-20260704-t0ec7u.md) | active | 2026-07-04 | localgit | 查询 append-only 提交账本、审 merge commit、非破坏性回滚（git revert） | 上游：daily-commit / 分支巡检写入；下游：回滚操作、判定矩阵判决缓存 |
| [SOP-supermatrix-recovery-backup-active-20260811-b7k2p8.md](SOP-supermatrix-recovery-backup-active-20260811-b7k2p8.md) | active | 2026-08-11 | localgit | 建立并核验外置盘完整恢复包；新包通过后协调各 owner 收敛零散数据库副本 | 上游：用户明确备份授权 / scheduler 周日 10:00 script trigger；下游：外置盘恢复包、关键 SQLite 一致快照、SHA256、capacity rotation record、local receipt、owner cleanup inventory |

> 参考附录（非流程 SOP，不占上表）：[references/daily-commit-ignore-policy.md](references/daily-commit-ignore-policy.md) — ignore 类目目录（allowlist / denylist / artifact-first / must-commit 清单与 auto-remediate 边界），被判定矩阵 R6/R8 与 reviewer prompt（`src/scripts/daily-commit-ignore-policy.ts`）引用；2026-07-04 从流程 SOP 重分类。
