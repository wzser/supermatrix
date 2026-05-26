# Gray Zones — 跨 session 沟通的结构性高混淆区

这张表记录已知的"找错人/职责重叠/语义撞车"高发区。每天扫 `cross_session_log` 时优先审查这些目标的请求。

**判断知识，不是事实**——append-only 演化，发现新混淆就追加，原有条目用反馈修订。

格式：

```
## #N <灰区名>
- 涉及 session: <list>
- 容易出现的错配: <一句话>
- 当前 confidence: high|medium|low
- 来源 / 最后校验: <来源 + YYYY-MM-DD>
- 反馈记录: <verdict / 修订历史，append>
```

---

## #1 "查 Amazon 经营数据" 三国

- **涉及**：amzdata（增长天王）/ amz-sql（数据天王）/ dataquery（查数）
- **错配**：amzdata = 分析+解读；amz-sql = 拉原始数据；dataquery = 查 amzdata 的库。三者 purpose 都带"亚马逊数据"，调用方常把"我要看数"无差别甩给随便一个。
- **confidence**: high
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #2 "知识库" 三国

- **涉及**：business-knowledge（阿基米德）/ codingmaster（sm 知识库）/ wytest（拆解器）
- **错配**：business-knowledge = 业务知识；codingmaster = SM 自身代码知识；wytest = 拆解外部代码包入库。"我想查个知识"——三个都可能被找上。
- **confidence**: high
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #3 SM 自身改造 三国

- **涉及**：supermatrix-root（550w）/ watchdog（WD）/ codexroot（T800）
- **错配**：supermatrix-root = 大迭代（claude 后台）；watchdog = 小修小补；codexroot = codex 侧 SM 管理。小问题甩到 root、大改动甩到 watchdog 都会错位。
- **confidence**: medium-high
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #4 listing 读 vs 写

- **涉及**：amz-radar（爬亚马）/ listing-editor（内容天王）
- **错配**：radar 抓内容（读）、editor 改 listing（写）。purpose 都含"亚马逊 listing"，关键字撞车。
- **confidence**: medium
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #5 补货流水线相邻

- **涉及**：gongying（补点货）/ budiansha（下单王）
- **错配**：gongying 算需求并聚合货件 → budiansha 实际下单。流程相邻，"创建货件"听起来两边都沾。
- **confidence**: medium
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #6 AI/方向类讨论

- **涉及**：mythos（广目天王）/ supermatrix-root（550w）
- **错配**：mythos 讨论"SM 未来方向"，supermatrix-root 也"iterate on SuperMatrix itself"。一个想方向、一个动手改，但用户问"SM 该怎么演化"两个都会接。
- **confidence**: medium
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #7 yolo 是元工具，不是终点

- **涉及**：yolo
- **错配**：yolo 的 purpose 是"以 user 身份驱动另一个 session"——它本身不是终点 session。如果日志里看到 yolo 主动找人，一般是它代理某个真实任务，要解析它真正在替谁说话。
- **confidence**: high
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

## #8 scheduler 是触发器，不是执行者

- **涉及**：scheduler
- **错配**：scheduler 只 cron 触发别人，不应该被当成业务执行端找。看到调用方甩活给 scheduler 多半是错配。
- **confidence**: high
- **来源**：first-principle, 2026-04-25
- **反馈记录**：

---

## 系统级噪声（要从沟通问题里扣除）

不是沟通失败，是系统状态导致的"看似沟通失败"。识别时先过滤。

- **codex backend（执行后端）异常证据**：看到"A 调 B 没回复 / 超时"时，先查当次是否有 codex 错误、超时、空输出或运行中断证据。不要只因为 B 是 codex 就把沟通问题过滤掉；只有有当次运行证据时才按系统噪声处理。
- **alias 也参与路由**：`findSessionByName` 同时匹配 name 和 alias，spawn 时传 `查数` 和 `dataquery` 都命中同一个 session。判断"找错人"时 name 列不是唯一锚点。
- **`sess_child_*` 是临时子会话**：判断"谁找谁"时要先把 child id 解析回 parent（用 `scripts/lookup-session.sh resolve-child`）。
