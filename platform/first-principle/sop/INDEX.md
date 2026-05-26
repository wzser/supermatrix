# SOP Index

| SOP | Description |
|-----|-------------|
| [category-template-distribution.md](./category-template-distribution.md) | 分类模板（claude-md-{category} / agents-md-{category}）的 bottom-up 调研 → 起草 → 带明确要求分发 → 验收归档的全流程 |
| [periodic-review-operation-manual.md](./periodic-review-operation-manual.md) | FP 每天被 scheduler 触发的四阶段周期巡检总手册：Gather → Synthesize → Conform → Sync |
| [new-session-init-sync.md](./new-session-init-sync.md) | 新 session 创建后把 alias/purpose/分类/头像 推到飞书 Bitable + 回写 `data/session-init.ndjson` 的 `feishu_sync_ok` 兜底流程；触发：ndjson 出现 `feishu_sync_ok != true` 行 |
| [create-base-for-session.md](./create-base-for-session.md) | 帮 session 代建 Feishu Bitable 的 5 步流程：建 base → 建 table/字段 → **加 SuperMatrix bot 为 full_access 协作者（强制）** → bot 身份验证读写 → 推 base_token 回请求方；触发：session 请求新建 base 或 FP 自身需要新治理表 |
| [session-purpose-update.md](./session-purpose-update.md) | 当某个 session 的职责边界发生迁移（能力转入/转出、服务归属变更）需要更新其在 session-catalog.json 里的 capability 描述时使用；不覆盖 alias/头像/分类等其它 session-meta 字段的修改，也不覆盖业务 session 自行改 CLAUDE.md 职责段。 |
| [identity-doc-major-change-review.md](./identity-doc-major-change-review.md) | 当 watchdog 通过 /api/spawn 把 identity_doc_major_change（CLAUDE.md/AGENTS.md ≥30 净行 或 新增 top-level .md）路由给 FP 时使用；不覆盖 reviewer/tool 故障引起的纯 retry 场景（仍是 watchdog 自己 bounded retry），也不覆盖日常 T1 routine edit（watchdog 直接 commit）。 |
