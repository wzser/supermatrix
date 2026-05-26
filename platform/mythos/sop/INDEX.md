# SOP Index

本目录存放 mythos session 的标准作业流程。开始任务前先按触发条件查对应 SOP。

## 全局约定：响应必须以请求类型标签开头（红线）

所有面向用户/调用方的响应，**第一行必须**是 `[<类型>·<sub-intent>·<具体 SOP 或动作>]` 标签。三类请求：

- `[查询]` 走 `kb-query.md`，不改 KB，写 query log
- `[维护]` 走 `kb-capture.md` / `ai-valley-newsletter-intake.md` / `using-holmes-deep-research.md`，改 KB，不写 query log
- `[元层]` 改 SOP / cron / 协议本身，不改 KB（除 charter / index 时）

详细判定优先级 + 例子见 `sop/kb-query.md` Step -1（共享约定，`sop/kb-capture.md` Step -1 镜像）。判错或漏标 = 红线违反。

---

## 知识库管理（KB）

- [`kb-capture.md`](kb-capture.md) — 用户发来新链接/文本时，抓取并纳入知识库
- [`kb-query.md`](kb-query.md) — 回答 KB 问题 / 应答跨 session 咨询：先识别 5 类 intent → MAP → concept → 三态 KB 状态（has/partial/none）→ 越界路由 → 写日志
- [`kb-query-review.md`](kb-query-review.md) — 每周 review `logs/queries/queries.jsonl`，调整 intent 类目 / 提交 FP principle 候选 / 标 KB drift
- [`cross-kb-capability-review.md`](cross-kb-capability-review.md) — 每周牵头跨 KB 能力对齐：spawn cm/wt/bk 收 manifest → 矩阵 diff → gap / deliberate divergence 分类 → 非 contentious 直接推广，contentious 升级用户
- [`ai-valley-newsletter-intake.md`](ai-valley-newsletter-intake.md) — 每天 10:30 cron 拉 mailbox-0008 archive，按 v1.1 A/B/C 规则筛 newsletter 内的 story；INCLUDE 直接捕获，MARGINAL 走质量闸，B 类（名人八卦）静默丢
- [`using-holmes-deep-research.md`](using-holmes-deep-research.md) — 主动取源：spawn `deepautosearch`（福尔摩斯，GPT Pro 研究级模式，≥10 分钟、按次烧钱）拿综合答案 + 引用 URL 列表，逐条走 kb-capture 入库；区别于柯南（deepsearch 普通深搜）

## 待启用（blocked）

- [`ai-valley-newsletter-intake.md`](ai-valley-newsletter-intake.md) — `blocked_on_mailbox_onboarding`：等 email-admin 接管 `ai-valley-newsletter` 邮箱并产出 `archive/ai-valley-newsletter/` 后启用；按筛选规则把命中 agent 工程化主题的 item 走 `kb-capture` 入库。

**根指引：** `kb/CHARTER.md`（任何 KB 操作前必读）

---

## 使用规则

- 触发任务前，先扫本 INDEX，确认是否有匹配 SOP。
- 完成第二次同类任务时，回头写一份 SOP 并在此登记。
- 被用户纠正时，立刻把纠正内容补进对应 SOP。
