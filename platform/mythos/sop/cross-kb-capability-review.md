# SOP: 跨 KB 能力对齐周度 Review

> **触发条件：** scheduler 每周一 09:30 cron，或人工触发。
> **前置要求：** `sop/kb-query-review.md` 已经在跑（同一天 09:00 先跑，避免冲突）；`bootstrap/log.md` 有最新跨 session 推广记录。

## 调度信息

- **scheduler 任务 id**：`6fb99ea4-0574-463d-9807-8d14b6ab2e7b`（owner: mythos）
- **频率**：每周一 09:30 Asia/Shanghai（`30 9 * * 1`）
- **首次首跑**：2026-05-11（query-review cron 30 分钟之后）
- **触发动作**：scheduler spawn mythos，prompt 含本 SOP 路径。
- **手动触发**：

  ```bash
  curl -X POST http://localhost:3500/tasks/6fb99ea4-0574-463d-9807-8d14b6ab2e7b/run
  ```

- **重试策略**：`overlapPolicy: skip_if_running`；spawn dispatch 失败由 scheduler 飞书告警；review 内部失败 mythos 自报 watchdog（异常段约定）。
- **已知 footgun（待统一处理）**：本 cron 与 `mythos-query-review` (`5bc40f59-...`) 都是 `class=sync_job` + 默认 `receiptProof=sqlite{}+pure`，按 scheduler 反馈可能落入 evidence_missing 重试循环。两条 cron 真正的成功凭证是写出报告文件（`logs/reviews/YYYY-MM-DD.md` 与 `logs/capability-reviews/YYYY-MM-DD.md`）。后续应统一 PATCH 两条 cron 的 `overrides.receiptProof` 为 `external_evidence` 指向报告文件 mtime；本 SOP 不在此处修，与 query review 一起改时再动。

---

## 心法

mythos 牵头跨 KB 能力对齐，但**不是把自己的 SOP 强推给所有 session**。本 review 区分两类差异：

- **Gap**（一个落后于其他）→ 推广更新
- **Deliberate divergence**（故意本地化）→ 标 OK 不动

contentious 时（存在把别人故意本地化覆盖的风险）必须**升级用户裁决**，不自动 spawn。

---

## 输入

- mythos 自身的能力（直接读 `kb/CHARTER.md` / `sop/INDEX.md` / `scripts/` / `kb/.feishu-manifest.json` 提取）。
- cm / wt / bk 三个 session 通过 `/api/spawn` 返回的 capability manifest（schema 见下文）。
- `bootstrap/log.md` 最近 4 周条目（看本周 mythos 自身有没有新加能力）。

---

## 输出

- `logs/capability-reviews/YYYY-MM-DD.md`：本周 review 报告（结构见下文）。
- （条件触发）非 contentious 推广 → 直接 spawn 落后 session 落地。
- （条件触发）contentious 推广 → 写到报告 §6 升级清单，**不 spawn**，等用户裁决。

---

## Capability Manifest Schema

每个被 spawn 的 KB session 返回一个结构化 manifest。统一格式如下（Markdown，便于人/agent 双向读）：

```markdown
# Capability Manifest — <session-name>

## charter
- version: v<N>
- last_updated: YYYY-MM-DD

## query_log
- intent_classes: [...]   # e.g. [definition, inventory, comparison, solution, alignment, unknown]
- kb_state_classes: [...]  # e.g. [has, partial, none, out-of-scope]
- log_path: <relative path>
- required_fields: [...]
- write_helper: <script path>

## review_sop
- window_days: 7
- cron_task_id: <uuid>
- report_path_pattern: <relative path pattern>
- triggers_first_principle: yes/no
- triggers_kb_capture_hints: yes/no

## feishu_mirror
- base_token: <token>
- tables:
    - name: Sources
      table_id: <id>
    - name: Queries
      table_id: <id>
- sync_script: <path>
- sync_targets: [charter, map, concepts, sources, queries, ...]

## governance_scripts
- <script>: <one-line purpose>
- ...

## bootstrap_log
- present: yes/no
- last_entry_date: YYYY-MM-DD

## deliberate_divergences
- axis: <e.g., query_log.intent_classes>
  value: <local value>
  reason: <为什么和 mythos 不同>
- ...

## recently_added (last 7 days)
- <axis>: <what was added>
- ...
```

字段级规则：
- 不知道 / 不适用的字段写 `n/a`，不要省略。
- `deliberate_divergences` 即使为空也要写 `(none)`，避免 review 误判为"未声明"。
- `recently_added` 是上周对比基线，0 个也要写 `(none)`。

---

## 步骤

### Step 1. 自检 mythos 自身能力（不 spawn 自己）

直接读本 workspace 的 CHARTER / sop/INDEX / scripts / .feishu-manifest，按 manifest schema 构造 mythos 的 manifest，存到本次 review 报告作为对比基线。

### Step 2. Spawn cm / wt / bk 收集 manifest（并行）

```bash
for target in codingmaster wytest business-knowledge; do
  curl -s http://localhost:3501/api/spawn -X POST -H "Content-Type: application/json" -d "{
    \"target\": \"$target\",
    \"prompt\": \"按 mythos 的 sop/cross-kb-capability-review.md §Capability Manifest Schema 返回你当前的能力 manifest。要求 Markdown 格式、字段齐全（不知道写 n/a）、deliberate_divergences 段必须列出与 mythos 不一致且故意为之的项（即使为空也写 (none)）。回复仅含 manifest 文本，不要其它解释。\"
  }" 2>&1 &
done
wait
```

收回的 manifest 落到 `/tmp/capability-review-YYYY-MM-DD/<session>.md`，便于后续 diff 与回查。

**异常**：某 session spawn 失败 / 返回不符合 schema → 报告 §异常段标记，本周不 propagate 该 session 的 axis（避免基于残缺信息推广）。

### Step 3. 构造能力矩阵

axis × session 矩阵。axes 至少覆盖：

- charter.version
- query_log.intent_classes (count + values)
- query_log.kb_state_classes
- query_log.required_fields
- review_sop.window_days
- review_sop.cron_task_id (是否注册)
- review_sop.triggers_first_principle
- feishu_mirror.tables (含哪些)
- feishu_mirror.sync_targets
- governance_scripts (列举)
- bootstrap_log.present

每个 axis 在每个 session 上的取值用一行表示；空白用 `—`。

### Step 4. 分类差异：gap vs deliberate divergence

逐 axis 看：

- 4 个 session 全一致 → no diff，不写。
- 3 个一致、1 个不同：
  - 那 1 个的 `deliberate_divergences` 段声明了该 axis → **deliberate**，写入 §3。
  - 没声明 → **gap**（落后或 drift），写入 §2。
- 2-2 分裂或 4 个全不同 → **可能 contentious**，写入 §6。
- 多个 session 一致地落后于一两个『先行者』 → **propagation candidate**，写入 §4。

### Step 5. Contentious 检测

某 axis 标 contentious 当且仅当**任一**条件满足：

1. 至少 1 个 session 在 `deliberate_divergences` 显式声明该 axis
2. 该 axis 属于"领域语义敏感"列表：
   - `query_log.intent_classes`（每个 session 应按自己业务领域定义）
   - `feishu_mirror.base_token`（base 拓扑是各 session 自主决策）
   - 任何带『业务领域命名』的字段
3. propagation 一旦执行会覆盖另一个 session 的 `deliberate_divergences`

contentious 项**绝不直接 spawn 推广**，写到报告 §6 升级用户清单。

### Step 6. 起草 propagation 计划

非 contentious gap → 准备 spawn prompt：

```
target: <落后 session>
prompt: "跨 KB 能力对齐 review 发现你 {axis} 落后：mythos / 其他 sessions 已经有 X，你这边没有。建议落地 X，参考实现见 mythos {path}。如果你这边是故意不做，回执说明，下周 review 会标 deliberate divergence 不再推。"
```

contentious / 复杂多向差异 → 进 §6 升级清单，不发任何 spawn。

### Step 7. 写报告

文件：`logs/capability-reviews/YYYY-MM-DD.md`，结构：

```markdown
# Cross-KB Capability Review YYYY-MM-DD

参与 session：mythos / codingmaster / wytest / business-knowledge

## 1. 能力矩阵
（4 sessions × N axes 表格 / 列表）

## 2. Gap（一个落后，需推广）
- {axis}: {落后 session} 缺；其他 N 个已有；建议 spawn {落后} 落地
- ...

## 3. Deliberate Divergence（故意本地化，不动）
- {axis}: {session} 用 X，原因 Y；OK
- ...

## 4. 本周新增能力（升级窗口）
- mythos: {axis} 新加 X，影响 cm/wt/bk 是否采纳
- {session}: {axis} 新加 Y，影响 mythos 等是否反向采纳
- ...

## 5. 收 manifest 异常
- {session} spawn 失败 / 返回缺字段：本周 propagation 跳过该 session
- 无：本周 4 manifest 齐

## 6. 升级用户裁决（contentious）
- {axis}: 多向差异 / 覆盖风险描述
- 建议：{推广 vs 不推广 vs 等更多数据}
- ...

## 7. 本周已自动 spawn 的 propagation
- spawn {target}: {axis} → {prompt 摘要}
- ...

## 8. 沉默告警
- 0 gap + 0 divergence 的周也写"本周无差异"
- 4 manifest 全收齐 vs 部分缺失
```

### Step 8. 触发非 contentious propagation（条件）

报告 §7 列的 spawn 计划，逐个执行（并行可以，每个 prompt 自包含 axis + 落地参考路径）。

```bash
curl -s -X POST http://localhost:3501/api/spawn -d '{ ... }'
```

spawn 回执（如有）写回报告 §7 末尾。

### Step 9. 同步飞书（兜底）

```bash
./scripts/sync-kb.sh charter   # 如果本次 review 改了 CHARTER
./scripts/sync-kb.sh queries   # 顺便兜底（与 query review 一致）
```

capability review 报告本身**不进飞书**（暂时；如果用户要求看可以另开 wiki node）。

---

## 红线

- Step 5 contentious 检测必须前置——任何怀疑覆盖『故意本地化』的 propagation 都不自动跑。
- 不删除 / 不重写 manifest 收回的临时文件，便于回查。
- 不在 review 流程里改其他 session 的文件——所有改动走 spawn。
- mythos 自身能力升级不藏在本 review 里偷偷做——CHARTER / SOP 改动走独立流程 + bootstrap log 显式记录，本 review 只检测和推广。
- Contentious 标记只能用户解除，下次 review 看到用户已写入新 `deliberate_divergence` 声明再放过。

---

## 异常处理

- **某 session spawn 失败**：报告 §5 标记，本周不 propagate 该 session 的 axis；下周再试；连续 2 周失败 spawn watchdog。
- **某 session 返回 manifest 不符合 schema**：当作 spawn 失败处理（标 §5），不强推格式纠正；可在 review 报告 §6 提示用户『session X 的 manifest 格式漂移』。
- **本周 mythos 没有新加能力 + 4 个 session 全部对齐**：写"沉默告警"——可能是真稳定，也可能是 review 漏检了。在报告末尾要求用户看一眼是否合理。
- **review 流程内部失败**（脚本 / 步骤卡死）：spawn watchdog，prompt 含 task id 和失败步骤。
- **spawn 推广执行失败**：报告 §7 末尾标失败原因，下周 review 自然重试（仍然 gap）。

---

## 与 query review 的边界

- **kb-query-review** 关心『被咨询时答得是否合适』——周一 09:00 跑。
- **cross-kb-capability-review** 关心『四个 KB 自身的工程机制是否对齐』——周一 09:30 跑。
- 两者**关注点正交**——前者看 query log（content level），后者看 SOP/scripts/charter（mechanism level）。
- 失败互不影响（不同 cron）。
