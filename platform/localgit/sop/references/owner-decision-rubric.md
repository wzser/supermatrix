# Owner 裁决准则（rubric v1）

> 消费方：`SOP-daily-commit-judgment-matrix`（周 digest、R1/R4 owner 告警）与 `SOP-repo-branch-merge-patrol`（C3-C6 ask、周 digest）。
> 用途：**所有发给 repo owner 的裁决请求必须附带本准则的相关段摘要 + localgit 按准则预判的默认项**。owner 在准则框架内做 repo-local 判断、只从枚举动作中选择；不同意默认项时附一句理由。目的 = 同类内容跨仓同判，裁决可审计、可比对。
> 版本：v1（2026-07-03）。修订本文件必须 bump 版本号；裁决消息与 manifest 回写引用的版本以本文件为准。

## A. 文件/目录处置：答案只能是 `commit` / `ignore` / `keep_dirty`

（R1 secrets 误报另有精确路径豁免通道，见 `SOP-daily-commit-judgment-matrix-secret-patterns.md` §3。）

按顺序回答，第一条命中即得默认动作：

1. **含真实访问凭据**（secret / token / 私钥 / session cookie / password）？→ 不 commit 也不 ignore（ignore = 掩盖）；选 `keep_dirty`，并尽快把文件移出仓或脱敏。
2. **删掉后能从源头重建**（平台导出 / 缓存 / 下载 / 运行产物）？→ `ignore`。
3. **是事后要复查的审计线索或交付物证据**，且单文件 ≤10MB、不随天数线性增长？→ `commit`。

飞书群 ID / 名称、人员名称、本地路径、私有客户数据与业务数据在本地受控仓中不是敏感阻断项；继续按第 2–3 条的可重建性与交付语义决定。
4. **拿不准** → `keep_dirty`（合法终态，localgit 不再重复问；之后想改随时改 manifest）。

常见类型默认表（与上面四问冲突时以四问为准）：

| 类型 | 默认动作 | 理由 |
|---|---|---|
| 业务数据导出 / 报表（csv/xlsx/json dump） | ignore | 可从数仓或平台重建 |
| 抓取截图 / 网页快照 / capture runs | ignore | 体积线性增长；要留证据走外部归档再 ignore |
| 运行日志 `*.log` / 缓存 | ignore | 机器噪音 |
| runtime SQLite / `*.db` | ignore | 运行态不进 git；schema fixture 例外 → commit |
| append-only 台账 / ledger / receipt jsonl | commit | 审计线索，正是该持久化的东西 |
| prompt 文件 / 配置样本 / SOP 引用的证据文件 | commit | 行为语义的一部分 |
| 媒体交付物（视频 / 成品图 / 压缩包） | keep_dirty | git 不适合存；转 NAS/云盘后可改 ignore |

## B. 分支处置：答案只能是 `合回` / `删除` / `挂起(附期限)` / `登记 trunk`

- **C3 干净可合**：默认 `合回`。仅两种例外：分支是未完成实验 → `挂起` 并给预计完成日期；分支已废弃 → `删除`（由 localgit 用 `-d` 安全删，删不掉会转回路由）。
- **C4 真冲突**：先看摘要里每个文件的 `essence`：`mergeable` → 你按 Repo Management Principle §5.9 逐块合并（禁止 `--ours`/`--theirs` 一把抹）；`decision_needed` → 回复保留哪边意图 + 一句为什么，合并动作仍按 §5.9 执行。
- **C5 常驻非 trunk**：默认 `合回` main。仅当 main 已事实废弃、当前分支就是本仓长期主线时才选 `登记 trunk`。
- **C6 无 main**：默认 `登记当前分支为 trunk`。
- 不接受「以后再说」——那等于 `挂起`，请显式选它并给期限。

## C. owner 也不能越的红线

- 不得用 ignore 掩盖 secrets、数据库、混合行为变更（ignore-policy denylist 对 owner 同样生效）。
- 不得要求 localgit 执行 rebase、`branch -D`、自动解冲突。
- 不回复：两轮周 digest 后升级用户，由用户按本准则代裁，结果同样回写 manifest。

## D. 裁决消息模板（localgit 侧义务，缺一不发）

每条 owner ask / digest 行必须包含：

1. 一句话问题（哪个仓、哪个路径或分支、卡在哪）；
2. 枚举动作清单及各自后果（§A 或 §B 的答案空间，不给自由文本空间）；
3. 本准则**相关段摘要 ≤8 行** + 本文件绝对路径 + 版本号；
4. **localgit 按本准则预判的默认项 + 一句理由**——owner 只需回「默认」或「选 X，理由一句」。

裁决回写 manifest 时在 rule 里记录 `"rubric":"v1"`；答案不在枚举内的回复不回写，追问一次后仍无效 → 按未响应走 §C 升级线。
