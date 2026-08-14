# SOP Index

> 命名规范：`SOP-<topic>-<status>-<YYYYMMDD>-<id>.md`。修订时同步重命名、frontmatter 与本表；稳定 ID 不可改。

| SOP 文件 | 状态 | 更新日期 | Owner | 何时用（一句话路由） | 上下游 |
|---|---|---|---|---|---|
| [SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md](SOP-daily-commit-ignore-policy-active-20260713-lmcms8.md) | 生效中 | 2026-07-13 | watchdog | 当 daily-commit 需要判断 dirty path 能否自动忽略、修复或提交时使用；不处理 scheduler 点火与业务 owner 的领域判断。 | ←daily-commit reviewer/git diff；→skip handling/repo owner/first-principle |
| [SOP-daily-commit-skip-handling-active-20260713-lawfm2.md](SOP-daily-commit-skip-handling-active-20260713-lawfm2.md) | 生效中 | 2026-07-13 | watchdog | 当 watchdog-daily-commit 留下 skipped repo 时使用；不把 process failure 伪装成 owner 内容风险，也不替业务 owner 作领域判断。 | ←daily-commits.log/scheduler run/ignore policy；→watchdog issue/owner/Console |
| [SOP-weekly-review-watchdog-active-20260717-hpd1pw.md](SOP-weekly-review-watchdog-active-20260717-hpd1pw.md) | 已暂停 | 2026-07-23 | watchdog | 用户指令暂停；weekly review 与 standing sweep 仅在新的明确恢复指令后，才可经 scheduler 重新启用。 | ←scheduler-v2/codexroot reviewers；→watchdog verifier/issue/群通知 |
| [SOP-weekly-cli-upgrade-kimi-patch-active-20260806-kd7m2q.md](SOP-weekly-cli-upgrade-kimi-patch-active-20260806-kd7m2q.md) | 生效中 | 2026-08-06 | watchdog | 当任何 watchdog kimi-code installer 完成后恢复并验证 SM-PATCH；不处理补丁脚本实现本身。 | ←weekly-upgrade.ts/kimi installer；→audit/receipt/codexroot T800 |
