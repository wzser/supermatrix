---
id: skup26
name: skill-hosting-upgrade
status: active
owner: skill-master
updated: 2026-07-11
---

# SOP: Skill 托管、自动升级、飞书登记

目标：把 skill-master 管理的 skill 从“可发现”推进到“可盘点、可升级、可回滚、可在飞书里正确查看”。

## When to Use

适用：盘点所有可用 skill、把外部 GitHub skill 纳入每周升级、修复飞书 Skill Registry 表、或把该表交给表格王登记托管。不适用：新增单个 canonical skill，改走 `SOP-add-shared-skill-active-20260711-35bn0g.md`。

## Prerequisites

- 工作目录：`/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master`
- 真相源：`skills/INDEX.md`、`config/skill-upgrade-sources.json`
- 执行脚本：`scripts/weekly-skill-upgrade.py`、`scripts/skill-upgrade-rollback.py`、`scripts/sync-skills-to-feishu.py`
- 飞书表：`F9F9bncWwaVzlRsZYs8csffQnB3` / `tblREDACTEDTABLEID`，唯一键 `Name`

## Step 1: 先分类每个 skill 的来源

读取 `skills/INDEX.md` 和 `config/skill-upgrade-sources.json`，按 `Name` 得到四类：

| 类别 | 判定方式 | 处理 |
|---|---|---|
| 外部 GitHub 且有 mapping | `packages[].mappings[].local == Name` | 纳入每周自动升级 |
| 外部 GitHub 但 unmatched | `packages[].unmatched_local[] == Name` | 暂不自动升级，保留人工判断 |
| skill-master 自建 / 业务 owner | `Origin=skill-master` 但不在 mapping/unmatched | 不自动升级 |
| builtin / 独立包 | `Origin!=skill-master`，或 `superpowers/gstack` 不在 INDEX | 只登记或走独立升级机制 |

## Step 2: 更新外部源登记

只改 `config/skill-upgrade-sources.json`。新增外部包必须写：

- `id`：包名，稳定不改
- `repo`：GitHub HTTPS URL
- `policy`：`baseline-three-way`、`rebase-local-patches`、`reset-and-setup` 三选一
- `mappings`：每条含 `local` 和 `source`
- `unmatched_local`：能确认来自该上游但暂不自动合并的本地 skill

样本行：

```json
{"local":"diagnose","source":"skills/engineering/diagnosing-bugs"}
```

## Step 3: 建 baseline 与回滚点

升级前必须先跑：

```bash
scripts/skill-upgrade-rollback.py snapshot --reason weekly --label before-weekly-skill-upgrade
```

首次接入 `baseline-three-way` 包时允许只初始化 baseline，不覆盖本地目录。后续升级用 baseline/local/upstream 三方比较；无法自动合并的文件保留本地并在 report 中标为 `conflict`。

## Step 4: 执行与验证每周升级

手动演练：

```bash
scripts/weekly-skill-upgrade.py do
scripts/weekly-skill-upgrade.py report
scripts/skill-upgrade-rollback.py verify-current --json --no-report
```

定时入口由 scheduler 托管：

| 任务 | cron | 命令 |
|---|---|---|
| `skill-master-weekly-skill-upgrade` | `30 6 * * 4` | `scripts/weekly-skill-upgrade.py do --apply-gstack` |
| `skill-master-weekly-skill-upgrade-report` | `0 7 * * 4` | `scripts/weekly-skill-upgrade.py report --notify` |

`--apply-gstack` 仅为兼容旧入口；实际包清单以 `config/skill-upgrade-sources.json` 为准。

## Step 5: 同步飞书 Skill Registry

飞书表必须至少有这些字段：

| 字段 | 类型 | 来源 |
|---|---|---|
| `Name` | text | `skills/INDEX.md` |
| `Origin` | select | `skills/INDEX.md` |
| `Scope` | select | `skills/INDEX.md` |
| `Owner` | text | `skills/INDEX.md` |
| `Purpose` | text | `skills/INDEX.md` |
| `Calls` | number | `metrics/call-log.jsonl` |
| `Updated` | datetime | 同步时间 |
| `AutoUpgrade` | text | `config/skill-upgrade-sources.json` |
| `UpgradePolicy` | text | `config/skill-upgrade-sources.json` |
| `GitHubRepo` | text | `config/skill-upgrade-sources.json` |
| `UpstreamPath` | text | `config/skill-upgrade-sources.json` |
| `UpgradeState` | text | 本 SOP 分类结果 |
| `RegistrySource` | text | `skills/INDEX.md` + source registry |
| `HostedBy` | text | `skill-master`, `skill-master + wendangwang-pending-receipt`, or `skill-master + wendangwang` |

同步命令：

```bash
python3 scripts/sync-skills-to-feishu.py
```

样本记录：

| Name | AutoUpgrade | UpgradePolicy | GitHubRepo | UpstreamPath | UpgradeState |
|---|---|---|---|---|---|
| diagnose | yes | baseline-three-way | https://github.com/mattpocock/skills.git | skills/engineering/diagnosing-bugs | enabled |

## Step 6: 交给表格王登记托管

当表结构、字段、菜单名变更后，必须用 spawn2.0 找 `wendangwang` 登记该飞书资产。请求里必须包含：

- base URL / app token / table id
- 唯一键：`Name`
- 同步方向：local-to-remote
- 冲突策略：local-wins
- 字段清单与样本记录
- 业务归类：platform directory / skill registry
- 证据要求：返回登记 receipt、字段映射、是否已有托管记录

登记请求已发但未拿到 receipt 时，`HostedBy` 写 `skill-master + wendangwang-pending-receipt`; 登记完成后写 `skill-master + wendangwang`。

## Step 7: 回滚

若升级后任一 skill 使用异常，先列快照：

```bash
scripts/skill-upgrade-rollback.py list --limit 10
```

恢复上一个快照：

```bash
scripts/skill-upgrade-rollback.py restore <snapshot-id>
scripts/skill-upgrade-rollback.py verify-current --json --no-report
python3 scripts/sync-skills-to-feishu.py
```

恢复成功判据：`verify-current` 返回 `ok: true`，相关 skill 在两端发现路径仍指向预期目录，飞书记录 `Updated` 被刷新。

## Evidence

| 证据 | 路径 / 位置 | 判定 |
|---|---|---|
| 每周执行日志 | `data/skill-upgrades/weekly-skill-upgrade.log` | 每个 package 有 result/status |
| 回滚快照 | `data/skill-upgrades/snapshots/` | 每次升级前存在 snapshot manifest |
| report | `data/skill-upgrades/reports/` | 包含 package、policy、变更与冲突 |
| 飞书行 | Skill Registry 表按 `Name` 搜索 | `AutoUpgrade/UpgradeState` 与 registry 一致 |
| 表格王 receipt | spawn2.0 closure / async ref | 返回 asset registration receipt |

## Exceptions

| 触发条件 | 判定方式 | 应对动作 | 通知对象 | 升级时限 |
|---|---|---|---|---|
| GitHub 拉取失败 | package result `ok=false` 且 error 含 fetch/clone | 不改本地 skill，report 标红，保留上一版 | skill-master | 当日 |
| 三方合并冲突 | result 包含 `conflict` 或本地文件未被替换 | 保留本地版本，记录冲突文件，不声称已升级该 skill | skill-master + 原 Owner | 2 个工作日 |
| superpowers 自定义检查失败 | preserve check 缺 `SuperMatrix` / `spawn2.0` 等关键字 | 立即用最近 snapshot rollback，不发布升级完成结论 | skill-master + codexroot | 当日 |
| 飞书字段缺失 | `sync-skills-to-feishu.py` 返回 lark field/record error | 先补字段再同步；不得手填数据替代脚本 | skill-master + wendangwang | 当日 |
| 表格王登记失败 | spawn2.0 返回非 ok 或无 receipt | 保持 `HostedBy=skill-master`，重发登记请求并附错误 | wendangwang | 1 个工作日 |

## Completion Checklist

- [ ] `config/skill-upgrade-sources.json` 通过 `python3 -m json.tool`
- [ ] `scripts/weekly-skill-upgrade.py` 与 rollback 脚本通过 `py_compile`
- [ ] `scripts/skill-upgrade-rollback.py verify-current --json --no-report` 返回 ok
- [ ] 飞书表名是 `Skill Registry`，主视图名是 `All Skills`
- [ ] 飞书记录按 `Name` upsert 后无重复空名记录
- [x] `wendangwang` 返回登记 receipt（2026-06-27，`wendangwang.takeover.skill-master.registry.技能清单.2026-06-27`）
