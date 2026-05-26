# 任务创建 Lint 错误代码 → 修复手册

POST /tasks 或 PATCH /tasks 返回 400 + `{error, errors: [{code, field, message, hint}]}` 时，按下表自助修复。

| code | 触发条件 | 修复 |
|---|---|---|
| `sqlite_target_incomplete` | overrides.receiptProof = external_evidence + sqlite，但 target 缺 db 或 sql | `target: { db: '/abs/path.db', sql: 'SELECT COUNT(*) FROM ... WHERE ...' }`。注：runtime 有 exit_code==0 兜底但 lint 主动收紧 |
| `classed_receipt_must_be_explicit` | class=sync_job/publication 但 overrides.receiptProof 缺失 | 显式设 overrides.receiptProof (示例见错误 hint)；不需要 evidence 校验就改用 monitoring class |
| `file_target_incomplete` | external_evidence + file 但 target.path 缺 | `target: { path: '/abs/path' }` |
| `http_get_target_incomplete` | external_evidence + http_get 但 target.url 缺 | `target: { url: 'http://...' }` |
| `receipt_kind_unknown` | overrides.receiptProof.kind 不在已知集合 | 用 exit_zero / http_2xx / session_reply_present / session_reply_content_check / external_evidence |
| `engine_unknown` | external_evidence.engine 不在已知集合 | 用 sqlite / http_get / file (bitable 也已知但被 engine_deferred 拒) |
| `expectation_invalid_for_engine` | expectation 字面量与 engine 期望不符 | sqlite/http_get: 数值比较 `'>= N'` 等；file: 数值（比 size）或 `'mtime > trigger'`（比 mtime） |
| `engine_deferred` | overrides.receiptProof.engine = bitable | runtime 是占位 stub 永远 fail。改用其他 engine |
| `kind_executor_mismatch` | class 默认 kind 与 executor 不匹配 | (1) 改 executor (script-kind→shell, session-kind→http); (2) overrides.kind 显式翻转 |
| `session_reply_json_path_unsupported` | session_reply_content_check + patternType=json_path | runtime 直接判 fail。改用 contains 或 regex |
| `owner_unknown` | ownerSession 不在 supermatrix.db 已知 session 列表（且 DB 可读） | 查 `sqlite3 ~/SuperMatrixRuntime/data/supermatrix.db "SELECT DISTINCT name FROM sessions"` 然后排除 child_/sess_ 前缀 |
| `description_empty` | description 为空 | 1-2 句中文：做什么/目的/约束 |
| `description_placeholder` | description 以 `执行命令:` 或 `调用接口:` 开头 | 替换成正式中文描述 |
| `description_no_chinese` | description 不含 CJK 字符 | 翻成中文 |
| `hard_constraint_violation` | 违反 class 硬约束 (e.g. delegation + exit_zero) | 见 `src/classes/hardConstraints.ts` |
| `classed_task_missing_expected_duration` | PATCH 后 merged classed task 的 expectedDurationMs 为 null | PATCH 时一并补上 `expectedDurationMs` |

**Grandfather:** 旧 task 不回溯，**但** PATCH 一个已 classed 的旧 task 时，merged 后的字段会全量过 lint。要 PATCH 一个旧 task，先准备好合法 description / ownerSession / etc。Legacy 非 classed task PATCH 时跳过 lint。
