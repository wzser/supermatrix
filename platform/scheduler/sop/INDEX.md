# scheduler SOP 索引

新增 SOP 必须在本文件登记一行；登记之前 SOP 视为未发布。

| SOP | 适用场景 |
|---|---|
| [task-description-convention.md](task-description-convention.md) | 新建 task 时 `description`（中文 1-2 句覆盖做什么/目的/约束）与 `category`（九选一）的字段约定。 |
| [creation-lint-errors.md](creation-lint-errors.md) | `POST /tasks` / `PATCH /tasks` 返回 400 时，按 lint error code 自助修复的对照手册（L1 机械校验层）。 |
| [creation-review-decisions.md](creation-review-decisions.md) | 任务创建异步 review（L2 语义层）被批量 spawn 时，scheduler session 走的 8 项语义判断 + approve/patch/reject/escalate 决策流程。 |

## 登记规则

- 新 SOP 落盘的同一次提交里追加本表一行；不允许只交 SOP、不交 INDEX。
- 一句话描述要回答"读者什么场景下应该打开它"，不是抄标题。
- SOP 被废弃时整行删除，不要留 `~~删除线~~` 残留。
