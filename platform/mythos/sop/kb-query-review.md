# SOP: KB 查询日志周度 Review

> **触发条件：** scheduler 的每周一次 cron 任务，或人工触发。
> **前置要求：** `kb-query.md` 已经在用、`logs/queries/queries.jsonl` 有内容。

## 调度信息

- **scheduler 任务 id**：`5bc40f59-953b-45a9-a264-6bf75d37b96d`（owner: mythos）
- **频率**：每周一 09:00 Asia/Shanghai（`0 9 * * 1`）
- **触发动作**：scheduler 到点 spawn mythos，prompt 含本 SOP 路径。
- **手动触发**：

  ```bash
  curl -s -X POST http://localhost:3500/tasks/5bc40f59-953b-45a9-a264-6bf75d37b96d/run
  # 返回 202，异步执行；不影响下次 cron
  ```

- **重试策略**：`overlapPolicy: skip_if_running`；spawn dispatch 失败由 scheduler 飞书告警；review 内部失败 **mythos 自己负责回报**（见下文异常处理）。

## 心法

Review 不是审计每一条答得对不对——那回不去。Review 是看**模式**：
- 我对意图分错的概率有没有上升？
- KB 哪块在反复被问但不在 concept 里？（drift 信号）
- 调用方"怎么提问"有没有可推广到全平台的规律？（→ first-principle 候选）

红线：Review **只读 + 写报告**，不顺手改 SOP，不顺手加 concept；后续动作走对应的 capture / FP 流程。

---

## 输入

- `logs/queries/queries.jsonl`：当前在用的查询日志（含归档前的所有条目）。
- 可选 `logs/queries/queries-YYYY-MM.jsonl`：按月切片归档；review 默认忽略归档。
- `logs/reviews/`：历次 review 报告，用于看趋势。

## 输出

- `logs/reviews/YYYY-MM-DD.md`：本次 review 报告（结构见下文）。
- （条件触发）`spawn first-principle` 一次：仅当本次发现"提问方式"层面可推广的 principle 候选。
- （条件触发）修订 `sop/kb-query.md` Step 0：仅当 intent 类目定义需要调整。

---

## 步骤

### Step 1. 滚出本周窗口

默认窗口：过去 7 天（cron 周一跑就是上周一到上周日）。

```bash
python3 - <<'PY'
import json, datetime
from pathlib import Path

now = datetime.datetime.now(datetime.timezone.utc)
cutoff = now - datetime.timedelta(days=7)

rows = []
for line in Path("logs/queries/queries.jsonl").read_text(encoding="utf-8").splitlines():
    if not line.strip(): continue
    rec = json.loads(line)
    ts = datetime.datetime.fromisoformat(rec["timestamp"])
    if ts >= cutoff:
        rows.append(rec)

print(f"window: {cutoff.date()} .. {now.date()}, count={len(rows)}")
PY
```

如果窗口内 0 条 → 写一份"本周无咨询"的极简 review，仍 commit。**沉默不是好现象**——可能意味着其他 session 不知道可以咨询、或日志没在写——要在报告里 flag。

### Step 2. 分布统计

按以下轴分桶，每桶看绝对数 + 占比：

- `intent`：6 类（5 类 + `unknown`）
- `kb_state`：4 档（has / partial / none / out-of-scope）
- `caller`：哪些 session 在咨询
- `concepts`：触及到的 concept slug（每条 query 可能触多 concept）
- `routing_target`：越界时转给哪些 session

### Step 3. 找意图误判候选

逐条扫，flag 这几类条目：

- `intent: unknown` 或 `notes` 含"intent 模糊"/"按 X 强制归类"等 → 当时分类信心低。
- `notes` 含"调用方修正"/"用户事后说要的不是这个" → 真分错了。
- 同一 caller 短时间内（< 1 小时）spawn 第二次问同一主题 → 第一次大概率没答对类型，调用方在重定位。

如果某一类（比如 alignment 与 solution 互混）反复出现 → 候选**修订 kb-query.md Step 0** 的判定信号。

### Step 4. 找 KB drift 信号

- `kb_state: partial` 或 `none` 在同一主题反复出现 → 该主题应该升级 concept 或新建。
- 同一 concept 在多次 `partial` 中被引用 → concept 深度可能不够。
- 某 source 反复被引但所属 concept 标 low confidence → 应该升级 confidence 或扩源。

这些写到 review 报告里，**不在 review 流程里改 KB**；后续走 `kb-capture.md` 维护流程。

### Step 5. 找路由模式

- 同一类越界问题反复发生 → 调用方不知道有更合适的 session，或 routing 表本身需要扩展。
- 越界后 `routing_target` 反复为空 → 我没给出 routing 建议（违反 Step 6 红线），需要回查具体条目。

### Step 6. 评估"提问方式" principle 候选

只有满足以下全部条件，才算是一条值得推到 FP 的 principle 候选：

1. 至少 **3 次**独立观察到同一现象。
2. 现象**跨 caller** 出现（不是某个 session 的特殊习惯）。
3. 改善它能**降低后续误判 / 倾倒概率**，不是单纯的"建议大家更礼貌"。

例（合格的 candidate）：

> 多个 caller 在 spawn mythos 时只发主题词不发 context，被强制按 `definition` 答，但实际想要 `solution`。建议 FP 加：spawn 知识 session 时 prompt 应包含一句"我目前的状态 / 我打算做的事"，否则被消费方按最保守 intent 处理。

例（**不合格** 的 candidate，不要推）：

- "希望 caller 提问更清楚一点" —— 不可执行。
- "建议都用英文提问" —— 没有数据支撑。
- "希望 mythos 答案再短一点" —— 关于答方，不是关于"提问方式"。

### Step 7. 写 review 报告

文件：`logs/reviews/YYYY-MM-DD.md`，结构：

```markdown
# Query Review YYYY-MM-DD

窗口：YYYY-MM-DD ~ YYYY-MM-DD　 共 N 条

## 1. 分布
- intent: definition X (Y%) / inventory ... / unknown ...
- kb_state: has X / partial Y / none Z / out-of-scope W
- caller: ...
- concepts touched: ...
- routing targets: ...

## 2. 意图误判候选
- {具体条目 timestamp + 现象 + 是否需要修订 Step 0}

## 3. KB drift 信号
- {主题 + 反复出现次数 + 建议动作（升级 concept / 新建 concept / 扩源）}

## 4. 路由模式
- {observed pattern}

## 5. FP principle 候选
- {满足 Step 6 三条件的现象描述 + 建议的 principle 表述}
- 若无：本周无候选。

## 6. 后续动作
- [ ] 修订 sop/kb-query.md Step 0：{是 / 否 + 具体改什么}
- [ ] spawn first-principle：{是 / 否 + 候选清单}
- [ ] KB capture：{建议 capture 哪些主题，记到 MAP "尚未成文"}
- [ ] 沉默告警：{本周窗口内 0 条 → 是 / 否}
```

### Step 8. 触发后续动作（条件）

- 若报告 §6 第 1 项打勾 → 直接编辑 `sop/kb-query.md`，git commit。
- 若报告 §6 第 2 项打勾 → spawn first-principle：

  ```bash
  curl -s -X POST http://localhost:3501/api/spawn -d '{
    "target": "first-principle",
    "prompt": "mythos 提交 principle 候选：基于 logs/reviews/YYYY-MM-DD.md §5。建议补充到 console-principles 关于「跨 session 咨询的提问方式」段。具体候选见 review 报告。"
  }'
  ```

- 若报告 §6 第 3 项打勾 → 在 `kb/MAP.md` "尚未成文的概念" / "待处理"段补条目；下次 capture 时优先处理。
- 若沉默告警 → 提醒用户 review 机制可能漏掉了什么（写到当周 review 末尾，不 spawn 任何人）。

### Step 9. 同步飞书 Queries 表（兜底）

```bash
./scripts/sync-kb.sh queries
```

把 `logs/queries/queries.jsonl` 整体推到飞书 bitable Queries 表（删完重灌）。这是周度兜底——平时不做实时 push，只靠 review 这一刀。失败不阻断 review 报告产出，但要在异常处理段记一条。CHARTER §8 是 sync 真相源；本步骤只调脚本。

---

## 红线

- Review 是只读分析 + 写报告 + 触发条件后续动作。**不在 review 流程里改 KB / 改 concept / 改 SOP**——所有修订走对应专用流程，避免 review 变成 mega-task。
- 不删 / 不重写 `queries.jsonl`——日志是 append-only 历史，包括失败案例。
- 不替 first-principle 决定要不要采纳 principle 候选；只提交，由 FP 自己排期。
- 0 条窗口要写"沉默告警"，不可静默跳过——零数据是值得被注意的信号。

---

## 异常处理

- **`logs/queries/queries.jsonl` 不存在**：说明 SOP `kb-query.md` Step 7 没在跑。报告写"日志缺失"，本周不做后续动作；提醒用户检查 SOP。
- **同一条 query 出现两次**（并发 spawn 写日志竞争）：dedupe 时按 `timestamp + prompt` 去重；报告里 flag。
- **scheduler cron 失败 / 漏跑一周**：下次跑时把窗口扩到上次 review 之后到现在；报告标"补滚 N 天"。
- **review 流程内部失败**（脚本异常 / SOP 步骤卡住）：scheduler 是 fire-and-forget 不会感知，mythos 必须自报——失败时直接 spawn `watchdog`，prompt：`"mythos 查询日志 review 失败：{失败步骤} {错误摘要}。task id 5bc40f59-...，请评估是否需要人工介入。"` 不允许静默失败。
- **Step 9 飞书 sync 失败**（lark-cli 报错 / 网络 / 限流）：不阻断 review 报告产出。报告末尾追加"飞书 Queries sync 失败：{错误摘要}"；下次 review 跑时会自然兜底（删完重灌全量数据，没有累积漏推问题）。如连续 2 周失败，spawn watchdog 评估。
