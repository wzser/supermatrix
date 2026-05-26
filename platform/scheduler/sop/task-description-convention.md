# 新建定时任务的 description 约定

> 这是 scheduler 的第一份 SOP。短，规模 > 3 步骤再起 `TEMPLATE.md`。

## 规则

**`POST /tasks` 时必须填两个字段：`description`（中文）和 `category`（8 选 1）。**

### category 九选一

`数据采集` / `数据加工` / `报告产出` / `业务巡检` / `跨会话委派` / `平台运维` / `一次性补跑` / `已完成` / `已废弃`

含义：

- **数据采集**：从外部系统拉数据进库（如 lingxing 报表、amzlisting ingest、新闻抓取）
- **数据加工**：清洗 / 汇总 / 算指标，**不**直接出报告（如 amzdata 诊断 S2-S3、forecast 计算、replenishment）
- **报告产出**：生成日报 / 周报 / 看板（如 qc-weekly-inspection、watchdog-weekly-token-report）
- **业务巡检**：业务侧异常探针（如 heartbeat、inventory-monitor、wechat 消息轮询）
- **跨会话委派**：spawn 给 sibling session 干业务活（如 cm-scan、mythos-query-review）
- **平台运维**：scheduler / 框架自身的事（如 daily-bitable-sync、daily-reload、watchdog-daily-commit）
- **一次性补跑**：one-shot 补缺 / 验证 / 回填（如 atp-verify-、verify-recvg）
- **已完成**：跑完了，正常退役。oneshot 成功后自动停 / 项目结束 / nas 视觉打标这种"完成或主进程停止后自动停用"
- **已废弃**：决策上不用了，等删（用户明确说不要的、被新方案替代的）

### lifecycle 行为

- `已完成` / `已废弃` / `一次性补跑`：disabled-warning **跳过**（这三类被 disable 是预期行为，不再骚扰你）
- 其它六类：disabled 时长超过 3× cron 周期会 userDM 提醒

`category` 跟 `class`（sync_job/publication/monitoring/delegation/notification）正交：class 是"调度引擎怎么对待你"，category 是"业务上你解决什么问题"。

## 为什么

当 task 因任何原因被停用且超过 3× cron 周期，`src/notify/disabledWarning.ts` 会给用户发 DM 提醒。那条 DM 把 `task.description` 当作"作用"行直接展示给用户，让他判断要不要重启用 / 转交 / 删除。

`description` 缺失或写英文时，用户面对一堆只有 task name 的提醒挑不出来要处理哪个，决策成本顶天了。这就是 2026-05-05 watchdog-idle-check 那次反馈的来源。

## 写法

> 注：scheduler ≥2026-05-13 起，缺失 / 占位 / 英文 description 在 POST/PATCH 时直接 400 拒绝（lint 规则 description_empty / description_placeholder / description_no_chinese）。autoDescription 兜底已下线。错误码详见 `sop/creation-lint-errors.md`。

1-2 句话，覆盖三个层面：

- **做什么**（动作）：`每 5 分钟扫 idle session 列表`
- **目的**（业务理由）：`用于回收忘关的会话`
- **关键约束**（如果有，可选）：`完成或主进程停止后自动停用`

### 好例子

```
每10分钟汇报 NAS 2025/2026 视觉打标进度；完成或主进程停止后自动停用。
```

```
每 5 分钟检查新的微信消息：真人私聊直接回复，群聊需 @42跨境零号；用 minimax-m2-7 生成并发回回复。
```

```
每隔一天凌晨 4 点全量采集 Amazon 商品 listing 数据，用于价格监控和竞品分析。
```

### 反例（不要这样）

```
Poll every 5 min; when sessions all idle fire safe-reload.sh and notify Console.
```
英文，要翻中文。

```
(empty)
```
必须填，否则 disabled DM 显示 `(无描述 — 建议补一下 description 字段)` 把球反推回 owner。

```
执行命令: python3 /path/to/report.py
```
历史上 scheduler 曾在 description 为空时自动填一个"执行命令: ..."占位（`autoDescription`，已于 2026-05-13 下线）。现在 lint 规则 `description_placeholder` 会直接 400 拒绝以 `执行命令:` / `调用接口:` 开头的 description。

## 修补已存在的 task

```bash
curl -X PATCH http://localhost:3500/tasks/<id> \
  -H 'Content-Type: application/json' \
  -d '{"description": "中文描述..."}'
```

## 检查工具

列出 description 为空 / 英文 / 含"执行命令:"占位的所有 task：

```bash
curl -s http://localhost:3500/tasks | python3 -c "
import json, sys, re
for t in json.load(sys.stdin):
    d = (t.get('description') or '').strip()
    bad = (
        not d
        or d.startswith('执行命令:') or d.startswith('调用接口:')
        or not re.search(r'[一-鿿]', d)
    )
    if bad:
        print(f'{t[\"name\"]:40s}  {d[:80]}')"
```

## 相关代码

- `src/notify/disabledWarning.ts` — 提醒文本里使用 `task.description`
- `src/classes/creationLint.ts` — Rule 7/8 强制 description 非空 / 非占位 / 含中文（≥2026-05-13）
