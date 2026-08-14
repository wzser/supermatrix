# SOP Index

> 命名规范见 SOP Principle §8：`SOP-<topic>-<status>-<YYYYMMDD>-<id>.md`。改 SOP 同步重命名 + 改本表对应行；ID 不可改。

| SOP 文件 | 状态 | 更新日期 | Owner | 何时用（一句话路由） | 上下游 |
|---|---|---|---|---|---|
| `SOP-judgment-via-interview-active-20260731-gq1fni.md` | 生效中 | 2026-07-31 | socail-king | scheduler 06:00 日常复盘 / 扫 `cross_session_log` 命中沟通失败信号时，访谈双方出人话 judgment 并追到闭环 | ←`cross_session_log`；→`state/judgments.jsonl`、飞书 `socail-king.judgment.判断记录` |
| `SOP-spawn-exception-transaction-active-20260711-6pbj96.md` | 生效中 | 2026-07-11 | socail-king | watcher 把 J 类卡住 async spawn 唤起 SK 时，单条裁决 B 的锅/约定的锅/误报/挂起并写回 verdict | ←watcher `spawn_async_items`；→`spawn_async_items.verdict`、`state/exception-transactions.jsonl` |
| `SOP-daily-cross-session-review-deprecated-20260711-39lfuc.md` | 已废弃 | 2026-07-11 | socail-king | 【勿用】旧 PMO 七问八答报告流程，光扫字段不访谈双方做不出真判断；仅留反思材料 | 迁至 `SOP-judgment-via-interview-active-20260731-gq1fni.md` |
