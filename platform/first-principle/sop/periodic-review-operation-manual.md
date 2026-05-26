# SOP: FP 周期巡检操作手册（Periodic Review Operation Manual）

> Created: 2026-04-18 | Last updated: 2026-05-13

> **v2.0 (2026-05-13) — Token Optimization**: Phase 1.1 加 git prescan(`scripts/fp-git-prescan.sh`)、Phase 1.2 加 self-report rotation(`scripts/fp-self-report-rotation.sh`,默认 3 桶 ≈ 6 天轮一遍)、Phase 3.1 加 conform hash cache(`scripts/fp-conform-cache.sh`)、Phase 2/3 加 child-session isolation(`FP_PATROL_PHASE_ISOLATION=1`,默认开)。所有改动都带 fallback / 紧急逃生开关。
>
> **v2.1 (2026-05-13) — Bitable Patrol Switch**: 新增 Phase 0 Enabled Gate,从飞书 Bitable `FP 巡检配置` 表读 `patrol_enabled` checkbox。关闭则跳过 Phase 1–4 真实工作,**仍 emit `REPORT: ... skipped=true`** 满足 scheduler receiptProof,不刷 `.last-sync-review` 留住"再次开启后自动补跑"通道。表位置:base `<FP_PATROL_BASE_TOKEN>` / table `<FP_PATROL_TABLE_ID>`。Helper:`scripts/fp-patrol-enabled.sh`(fail-open:lark-cli 不可达时按 enabled 处理,避免基础设施故障静默停摆)。
>
> **v3.0 (2026-05-20) — FP-as-primary-owner**: Phase 3 默认动作从 "spawn 通知 session 自改" 翻面成 "FP 直接编辑 + per-session commit + 写 changelog 决策记忆"。决策记忆 schema 见 CLAUDE.md §Sync Review Rules:`changelog(session_name, topic, rule_version)`。Spawn 询问只在(a)drift 涉及 session-owned 业务段、或(b)前一轮 memory 标 `session_override` 时才触发。配套机械分发脚本:`scripts/fp-distribute-<topic>.py`。 **已被 v3.1 撤销 — 见下一行**。
>
> **v3.1 (2026-05-21) — Spawn-confirm-first (v3.0 撤销)**: 用户在 v3.0 上线一天后明确要求废除 FP 直接编辑模式以及 `<!-- BASE:BEGIN/END -->` 强覆盖。Phase 3 全部 4 项检查(对称性 / 模板符合性 / BASE 残留 / 语言合规)统一回到 "spawn 通知 session 自改、不代改" 路径。`fp-distribute-*.py` 机械分发脚本仍保留在 `scripts/` 下作为历史归档但**不再调用**。决策记忆(`changelog (session_name, topic, rule_version)`)继续使用,只是用途从 "授权 FP 直接重写" 收窄到 "下轮巡检前避免重复 spawn 同一个 session 问同一件事"。
>
> **v2.2 (2026-05-13) — Phase 4.3 surface 补漏**: 修 Phase 4.3 "无事项跳过"逻辑,加 "deferred 含求决关键字必须纳入" 例外。Phase 3 systemic drift 报警(如 id 480 "WHY-before-HOW Problem→Situation drift 114 files")曾被静默吞,导致 107 session 文件卡老 phrasing 7 小时无人接住。

## 核心目标（What problem does this SOP solve）

**这是一个什么类型的 SOP**：FP 每天被 scheduler 触发执行的周期性维护总手册。

**它要解决什么问题**：FP 每天被激活后要跑一整套四阶段流程（收集 → 综合 → 对齐 → 同步），涉及多个信息源、多个 session、多个飞书目的地。没有手册时，FP 会漏步骤、乱顺序（比如先检查 session 合规再改 Principles，结果 session 刚按旧模板改完又被打回去）。这份 SOP 固定执行次序、每步的输入/产物/下一步消费方，保证每次巡检都可复现、结果可追溯。

## When to Use

- scheduler 隔日凌晨 01:17（奇数日，cron `17 1 */2 * *`）通过 /api/spawn 触发 FP 时，按这份手册执行
- 用户手动要求「跑一次周期巡检」时
- FP 自己被激活发现 `.last-sync-review` 超过 2 天时（主动补跑）

## Prerequisites

- `$SM_RUNTIME_ROOT/data/supermatrix.db` 可读
- scheduler 服务 (localhost:3500) 和 spawn API (localhost:3501) 在线
- lark-cli 可用（session 表同步 + 飞书 wiki 同步）
- codex 后端可用（Phase 4 collect 会 spawn codex sessions）

## 执行次序（总览）

**关键原则**：**先改内容，再查对齐**。Principles 和分类模板内容若本轮要更新，必须先完成，再用最新内容作为基准去查 session 合规性。否则 session 刚按旧模板改完、FP 紧接着更新模板，下一轮又打回去。

```
Phase 1 — Gather          收集新信息（git log + Daily Self-Report）
  ↓
Phase 2 — Synthesize      综合：内容更新 (2.1) + 判断规则反思 (2.2) + Lint (2.3)
                                + Prune 主动精简 (2.4，v1.6 新增)
  ↓
Phase 3 — Conform         对齐：查 session CLAUDE/AGENTS 是否符合最新模板
  ↓
Phase 4 — Sync            同步：session 表 (4.1) + 飞书 wiki (4.2) + FP 群通知 (4.3)
                                + Scheduler Receipt (4.4，v1.1 新增) — 末次回复以 `REPORT:` 起头
```

### Phase 0: Enabled Gate (v2.1)

**这是任何 step 之前的第一步**。读飞书 Bitable `FP 巡检配置` 表 `patrol_enabled` 行的 `开关` checkbox:

```bash
if ! bash scripts/fp-patrol-enabled.sh >/dev/null; then
  # disabled — skip Phase 1-4 真实工作,仍 emit REPORT: 满足 scheduler receipt
  sqlite3 data/principles-log.db \
    "INSERT INTO changelog (trigger_type, trigger_source, target_doc, judgment, judgment_reason, change_summary, change_detail, request_file) VALUES ('patrol','scheduler','fp-self','no_action','Bitable patrol_enabled=false','PATROL SKIPPED: Bitable 开关关闭','本轮跳过整套巡检流程;.last-sync-review 不刷新,重新开启后下次激活自动补跑',NULL);"
  # 同步飞书 Bitable changelog mirror(略,按 §「变更日志规范」执行)
  # 末次回复必须以下面这行起头:
  echo "REPORT: FP-PATROL $(date +%F) cycle=N skipped=true reason=patrol_enabled=false — 用户在 Bitable 关闭了巡检总开关,本轮跳过 Phase 1-4 真实工作,.last-sync-review 未刷新。"
  exit 0
fi
# enabled — proceed to Phase 1
```

**关键规则**:
- **关闭时仍 emit `REPORT:` token**(`skipped=true reason=...`),否则 scheduler `receiptProof` 判 `receipt_missing` 会无脑重试 ownerDM
- **关闭时不刷 `.last-sync-review`**,让该文件继续陈旧;user 把开关切回 enabled 后,FP 下次激活检测到 `.last-sync-review` > 2 天会主动补跑
- **fail-open**:`fp-patrol-enabled.sh` 自带 lark-cli 失败时返回 `enabled`(避免飞书 / Bitable 故障导致巡检静默停摆几天)。helper exit 1 = 显式 disabled,exit 0 = enabled 或 fail-open。

### Phase Isolation (v2.0)

**默认 `FP_PATROL_PHASE_ISOLATION=1`(开启)**:主 session 跑 Phase 1 → 把产物落盘 → spawn child 跑 Phase 2 → spawn child 跑 Phase 3 → 主 session 收齐结果跑 Phase 4。每个 child 是新的 `first-principle` session,context 隔离,避免 Phase 1 的 git log 内容拖到 Phase 4 推理里。

```bash
CYCLE_ID="$(date +%Y%m%d-%H%M)"
PATROL_DIR="/tmp/fp-patrol-${CYCLE_ID}"
mkdir -p "$PATROL_DIR"

run_phase_in_child() {
  local phase="$1"; local note="$2"
  curl -s -X POST http://localhost:3501/api/spawn \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg p "$phase" --arg dir "$PATROL_DIR" --arg note "$note" \
      '{target:"first-principle", prompt:("[FP-PATROL-PHASE-"+$p+"] cycle dir="+$dir+". Run sop §Phase "+$p+" only. "+$note+" DO NOT spawn children, DO NOT run other phases, DO NOT emit `REPORT:` token. End with single line: PHASE"+$p+"-DONE: <one-sentence-summary>.")}')"
}

# Phase 1 inline (cheap, mostly bash) → write phase1-candidates.json
# run_phase_in_child 2 "Inputs at phase1-candidates.json."
# run_phase_in_child 3 "Inputs at phase2-modified-templates.json."
# Phase 4 inline in main session (must emit REPORT: token there)
```

**紧急逃生**:`FP_PATROL_PHASE_ISOLATION=0` 切回 inline 模式,全部 4 phase 都在主 session 跑。出 child spawn bug 时用。

**递归保护**:child session 收到 `[FP-PATROL-PHASE-N]` 起头的 prompt 时,**必须按 prompt 内嵌指令执行单一 phase,不得 spawn child、不得跑其它 phase、不得 emit `REPORT:` token**。这条约束镜像写在 FP 的 `CLAUDE.md` / `AGENTS.md` (§Phase Isolation Mode)。

## Steps

### Phase 1: Gather — 收集本周期新信息

#### Step 1.1: Code Change Review — 拉取所有工作区近 2 天代码变更

- **要解决的问题**：哪些地方出现了新的 API / 新事件 / 新通信方式 / 踩坑修复 / 重复 revert——这些是 Principles 可能漏写的信号。
- **输入**：FP 管辖 + 近 2 天有 HEAD commit 的 workspace 列表(由 `fp-git-prescan.sh` 直接产出,合并 fp-managed-list + sessions + git log prescan 三步)
  ```bash
  # v2.0: prescan 只输出 FP管辖=true 且 HEAD commit 在 --days 内的 session
  # 默认 --days 2;输出 tab-separated <session>\t<workdir>\t<head_commit_ts>\t<active>
  bash scripts/fp-git-prescan.sh --days 2
  ```
  FP管辖 取消勾选的 session(如 `zedong`)由用户在 Bitable 维护,prescan 直接过滤掉。HEAD commit > 2 天前的 session(stale)也被过滤,因为对它们跑 `git log --since='2 days ago'` 必然空,徒增 token 成本。
  > **独立 re-query 强制项**:每次执行本 step 都必须重新跑 `fp-git-prescan.sh`,**不允许复用更早 phase 的列表**。Phase 之间用户/init 流程可能新建 session,复用快照会漏掉本轮新加入的对象(2026-05-05 todomaster 等 6 个新 session 即因此漏检)。prescan 内部已包含一次 `fp-managed-list.sh` + sessions 表查询,合规。
- **处理**:对 prescan 结果的每个 active workspace 执行 `git log --since='2 days ago' --oneline`,重点关注信号:
  - 新 API 端点 / 新事件类型 / 新通信方式 → console-principles 候选
  - 新设计模式 / 踩坑修复 → coding-principles 候选
  - 跨 session 流程变更 → business-principles 候选
  - 重复 revert / hotfix → 红线缺失信号
- **产物**：候选更新清单（哪份 Principles 的哪一段可能要补什么）
- **下一步消费方**：Step 2.1 的综合判断

#### Step 1.2: Daily Self-Report — 让每个活跃 session 自述本周期新特性

- **要解决的问题**：git log 看到的是代码事实，看不到「session 自己意识到的新工作形态」——譬如"我这周发现处理某类请求时必须先 xxx 才行"这种经验。过去只靠 FP 自己看 git log，会遗漏。用户 2026-04-18 明确要求补这条通道。
- **输入**:**本轮要轮到的桶**(由 `fp-self-report-rotation.sh select` 产出),不再是全量 FP管辖 list。
  ```bash
  # v2.0: 把 FP管辖 session 切 3 桶轮询(默认),每轮只问 ceil(95/3) = 32 个
  # 选择策略:least-recently-reported first;新 session(cursor 无记录)被视为 epoch 0,优先选
  bash scripts/fp-self-report-rotation.sh select --bucket-count 3
  ```
  覆盖节奏从 "每 2 天一次" 改为 "每 ~6 天一次",spawn token 直接 /3。新 session 在第一次出现在 rotation 时就会被优先选,不等 6 天。
  > **独立 re-query 强制项**:本 step 必须重新跑 `fp-self-report-rotation.sh select`,**不允许复用 Step 1.1 的 prescan 结果**(prescan 关心 git 活跃,self-report 关心 session 自述节奏,两个维度不同)。
- **处理**:对 rotation 选出的每个 session 发 spawn:
  ```bash
  bash scripts/fp-self-report-rotation.sh select --bucket-count 3 \
  | while read -r session; do
    curl -s -X POST http://localhost:3501/api/spawn \
      -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg s "$session" '{target:$s, prompt:"<daily-self-report-prompt>"}')" \
    && bash scripts/fp-self-report-rotation.sh mark "$session"
  done
  ```
  prompt 模板(保存在 `templates/daily-self-report-prompt.md`):
  > FP 每日巡检:请回顾你本工作区最近 24 小时的工作,报告三个方面(每项 ≤100 字):
  > (1) 新能力/新流程:你新解锁的能力、新沉淀的流程,值得升级到 Principles 或分类模板吗?
  > (2) 踩坑/反模式:你这次踩了什么坑、哪条旧规则需要加强?具体指向 console/coding/business 中的哪一段?
  > (3) 跨 session 协作信号:你与其它 session 配合过程中发现的问题(对方接口变了、协议不清、延迟大),是否值得 FP 关注?
  > 无则写「无」。不要重复昨天已经报过的内容。
  - 并发 max 10,超时 300s/session
  - 结果落盘:`/tmp/fp-daily-selfreport-<YYYY-MM-DD>/<session>.json`
  - spawn 完成后必须 `fp-self-report-rotation.sh mark <session>` 推进 cursor;**spawn 超时跳过 → 不 mark**,下轮 rotation 会优先选(epoch 仍是旧的或 0)
- **产物**:`/tmp/fp-daily-selfreport-<YYYY-MM-DD>/` 下本轮桶内 session 的自述;`data/.fp-self-report-cursor.json` 推进
- **下一步消费方**:Step 2.1 综合判断

### Phase 2: Synthesize — 综合信号，更新内容

#### Step 2.1: 三份 Principles + 四份分类模板的内容更新

- **要解决的问题**：把 Step 1.1（git log）和 Step 1.2（Self-Report）里识别出的候选信号，转成具体的 Principles 或分类模板文字改动。
- **输入**：Phase 1 的候选清单 + self-report 汇总
- **处理**：
  - 明确的新规则 / 新红线 → 直接改 `templates/` 下对应文件
  - 不确定的 → 不改；记 `changelog.judgment = 'deferred'`，等用户或多次重复出现再决定
  - 同一段被多个 session 投诉冲突/冗余 → 提炼为模板修订，做好「是否需要重新分发给该分类所有 session」的判断
  - 每次改动写 changelog：
    ```bash
    sqlite3 data/principles-log.db "INSERT INTO changelog (trigger_type, trigger_source, target_doc, judgment, judgment_reason, change_summary, change_detail, request_file) VALUES ('patrol','scheduler','<doc>','accepted','<reason>','<summary>','<detail>',NULL);"
    ```
  - **v2.0 cache 同步**:若本 step 修改了 `templates/claude-md-<category>.md` 或 `templates/agents-md-<category>.md`,**必须立刻** invalidate conform cache,否则 Phase 3.1 会拿旧 cache skip,漏检本应重扫的 session:
    ```bash
    # 例:刚改了 claude-md-平台.md → 让所有「平台」category session 在 Phase 3.1 重新过 hash 比较
    bash scripts/fp-conform-cache.sh invalidate_category 平台
    ```
    若改的是非分类模板(如 console-principles.md / coding-principles.md / business-principles.md),不需 invalidate(那些不进 Phase 3.1 的 template_sha 计算)。
- **产物**:更新后的 `templates/*.md`;若有分类模板修订,同时写入「本轮是否需要重新分发」的决策 + cache 已 invalidate
- **下一步消费方**:Step 2.2(判断规则反思)和 Phase 3(对齐检查)

#### Step 2.2: Reflection — 提炼新的判断规则

- **要解决的问题**：除了具体的 Principles 内容，判断「哪些请求该接受/拒绝/拆分/暂缓」的元规则也需要演进。
- **输入**：`data/principles-log.db` 近期记录
  ```bash
  sqlite3 data/principles-log.db "SELECT * FROM changelog ORDER BY timestamp DESC LIMIT 50;"
  ```
- **处理**：
  - 多次拒绝同类请求 → 是否该把该类别明确写进 `rules/update-judgment.md` 的 reject 规则？
  - 多次巡查修复同类漂移 → 是否要加一条「遇到这类提示直接改」的明文？
  - 多次 deferred 最后人工介入接受/拒绝 → 能否抽象成一条新规则减少未来 deferred？
- **产物**：更新 `rules/update-judgment.md`（若需要）
- **下一步消费方**：下一轮巡检的判断

#### Step 2.3: FP 自身文档 Lint

- **要解决的问题**：三份 Principles + 四份分类模板 + FP 的 sop/ 之间是否自洽；各工作区 sop/ 是否健康。
- **输入**：`templates/*.md`、各 session 的 `<workdir>/sop/`
- **处理**：
  - Principles 之间：矛盾规则、失效引用（文件路径/session 名/命令）、冗余、缺交叉引用
  - 四份分类模板相互：应各自独立，不出现交叉矛盾或通用规则重复
  - 各 session sop/：是否存在、INDEX.md 是否一致、每个 SOP 是否符合 `templates/sop-template.md`（有「核心目标」段、长流程 5 段式、无失效引用）
  - 发现问题：FP 自己模板/Principles → 直接改；session sop/ 不合规 → spawn 通知 session 自改，记 patrol/deferred
- **产物**：修订后的 templates/Principles + spawn 通知记录
- **下一步消费方**：Step 2.4 和 Phase 3

#### Step 2.4: Prune — 主动精简所有治理文档

- **要解决的问题**：Step 2.1 的"剪枝跟随"只在接受新规则时顺带清理。若本轮没新增，文档就只进不出，必然腐化。Phase 2.4 作为独立环节，**不论本轮是否有新增都必须执行**。用户 2026-04-24 反馈明确"现在越加越长"、"治理规则需要有精简过程"。
- **输入**：
  - 精简规则详细定义：`rules/update-judgment.md` §精简规则（v1.6 起，7 个触发条件 P1-P7 + 4 个豁免 E1-E4）
  - 扫描对象（FP 维护的全部治理文档）：3 份 Principles + 4+4 分类模板 + `rules/*.md` + `sop/*.md` + FP 自身 `CLAUDE.md` / `AGENTS.md`
- **处理**：
  1. **选目标**：优先偏长文档（Principles > 800 行 / 分类模板 > 500 行 / rules 单文件 > 300 行）；其余至少各扫一遍。可用 `wc -l` 快速定位。
  2. **逐条过滤**：对每条规则/要点问两次——"命中 P1-P7 中的哪条？" + "有无 E1-E4 豁免命中？"
  3. **分级处理**：
     - 安全候选（命中 P1 被取代 / P2 过时引用 / P7 条件过期 且无豁免）→ **直接删除**，`judgment=accepted`，`change_summary` 以 `PRUNE:` 前缀开头
     - 模糊候选（命中 P3 休眠 / P4 过度特化 / P5 琐碎隐含）→ **记 `judgment=deferred`**，下一轮再判或请用户确认
     - P6 冗余 → 比较几份重复项，保留定位最合适的一份，其余删（按安全候选走）
  4. **净增长跟踪**：统计本轮 Phase 2.1 新增行 vs 本步骤删除行；若差值持续为正且连续 3 轮无精简记录 → Phase 4.3 发 FP 群告警
  5. **零可删也要留痕**：若确实没有可删候选（例：全部命中豁免），仍写一条 `judgment=no_action, change_summary=PRUNE: 本轮无可删候选, judgment_reason=<简述查过的文档>`。**不允许静默放过。**
- **产物**：
  - 更新后的 `templates/*.md` / `rules/*.md` / `sop/*.md` / FP 自身 CLAUDE+AGENTS
  - 每次删除 1 条 changelog（带 PRUNE: 前缀）
  - 本轮净增长数字（新增 vs 删除）
- **下一步消费方**：Phase 4 同步（飞书 wiki 反映精简后的版本）

#### Step 2.5: Doc-vs-Code Drift Check — 文档自洽 + 对外部代码引用一致性

- **要解决的问题**：Step 2.1-2.4 只审"该不该收 / 该不该删"，不查"文档自身数字 / Removed-claim / API 表 / 引用对象是否还存在"。结果是已经写进文档的旧措辞和被代码淘汰的引用悄悄过期，巡检永远不会接住。2026-05-13 用户一次 review 就抓出 5 处（"Five presets" 但只剩 4 个 / HTTP API 表漏 `/api/notify` / 三处 `event_awaited_worker | continuationHook | parent_continuation_inject` 标 Removed 但 SM 源码还在）。本步骤即针对这类 drift 立独立检查环节。
- **输入**：FP 自管全部治理文档（3 份 Principles + 8 份分类模板 + `rules/*.md` + `sop/*.md` + FP `CLAUDE.md` / `AGENTS.md`），以及对照的 SM 源码（`<SM_REPO_ROOT>/src/`）。
- **处理**（6 项自洽检查，每项扫一遍全部输入文档；第 6 项另抽样业务 SOP）：
  1. **计数自洽** — 文档里凡是写"N 个 / Five / Four / 五种"的数词，紧随其后的列表项数必须一致。`grep -nE '\b(Five|Four|Three|Two)\b|[一二三四五六七八九]种|[0-9]+ 个'` 抓位置，逐条人工核对。
  2. **Removed / Deprecated claims vs 源码** — 抓所有"Removed (date)" / "Deprecated"声明，对每条提到的符号（类型名 / 字段名 / endpoint / sink kind）跑 `grep -rn <symbol> <SM_REPO_ROOT>/src`。若代码还在，要么改措辞（"contract-removed, code retained" 之类）、要么 spawn 对应 owner（多数是 supermatrix-root）确认下一步处置。
  3. **API / endpoint 表完整性** — `console-principles.md` 的 HTTP API 表 vs `src/cli/apiServer.ts` 实际注册的所有路由（`grep -n "url.pathname ===" src/cli/apiServer.ts`），少则补、多则核实是否已下线。
  4. **日期戳保鲜期** — `(YYYY-MM-DD+)`、`(自 YYYY-MM-DD 起)` 这种时效注释，超过 30 天默认去掉（变常规要求），≤30 天且仍处过渡期的保留。
  5. **session 名引用存在性** — 文档点名的具体 session（spawn 示例、incident attribution），跑 `sqlite3 $SM_RUNTIME_ROOT/data/supermatrix.db "SELECT name FROM sessions WHERE status != 'deleted'"` 比对；已删除的 session 改成通指表述（"某业务 session"），或加注"历史 session（已删）"。
  6. **SOP trigger 合规扫描**（新增 — 业务 / 知识 category SOP）— 对所有业务/知识 category session 的 `sop/*.md`，逐份检查：(a) 是否有 YAML frontmatter 且含 `name` + `description` 两个键；(b) 是否有 `## When to Use` 段，且段下含"不适用场景 / Do NOT use when"子块（至少 1 条反触发）；(c) `sop/INDEX.md` 是否登记本 SOP；(d) frontmatter `description` 与 INDEX 条目是否一致。每条缺失记 `DRIFT-FIX:` 直接改（FP 自己维护的 SOP）或 spawn 通知 session 自改（业务 session 维护的 SOP）。零 finding 也要写一行 `DRIFT: SOP trigger 合规扫描本轮无问题`。
- **分级处理**：
  - 自洽错误（数字 / 日期戳 / 多列少列）→ **直接改**，`judgment=accepted`，`change_summary` 以 `DRIFT-FIX:` 前缀。
  - Removed-claim vs 代码 / 涉及外部 owner 决定的 → spawn owner 核实（同步等回包，能等就等；不能等就记 `deferred`），回包后再修。
  - 零 finding 的检查项也写一条 `judgment=no_action, change_summary=DRIFT: <检查项> 本轮无问题`。**不允许静默跳过任何一项。**
- **产物**：
  - 修订后的文档（带 `DRIFT-FIX:` 前缀的 changelog 行）
  - spawn 给 owner 的 deferred 项（带 `change_detail` 描述代码符号 + 文档位置）
- **下一步消费方**：Phase 4 同步（含本步骤产生的所有修订）

### Phase 3: Conform — 对齐 session 的 CLAUDE/AGENTS

> **为什么放在 Phase 2 之后**：Phase 2 可能更新了分类模板。若先做 Phase 3 再更新模板，session 刚改完又要被打回。**先定内容，再查对齐**。

#### Step 3.1: CLAUDE.md / AGENTS.md 四项合规检查

- **要解决的问题**：session 的核心操作文档是否还符合最新的分类模板 + 硬性规则。
- **输入**:活跃 + **FP 管辖**的 session 列表(用 `bash scripts/fp-managed-list.sh` 取,再与本地活跃集合做交集;FP管辖=false 的 session 一律跳过) + 每个 session 的 workdir 下 CLAUDE.md/AGENTS.md
  > **独立 re-query 强制项**:本 step 必须重新跑 `fp-managed-list.sh` + 本地 `sessions` 查询,**不允许复用 Phase 1 的列表**。Phase 1 → Phase 3 期间常有新 session init 或 FP管辖 切换,复用快照会漏检。
- **v2.0 hash cache 短路**:对每个 session 先 hash 比较,**unchanged 则直接 skip 不读全文**:
  ```bash
  while read -r name; do
    workdir=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" "SELECT workdir FROM sessions WHERE name='$name';")
    category=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" "SELECT category FROM sessions WHERE name='$name';")
    if bash scripts/fp-conform-cache.sh should_skip "$name" "$workdir" "$category" >/dev/null; then
      continue  # CLAUDE.md / AGENTS.md / template 三 sha 都没变,本轮无事可做
    fi
    # ↓ 全文检查 (a)(b)(c)(d) ...
    # ↑ 检查完后,根据结论写 cache:
    bash scripts/fp-conform-cache.sh update "$name" "$workdir" "$category" "<clean|no_action|deferred|accepted>"
  done < <(bash scripts/fp-managed-list.sh)
  ```
  cache miss(hash 变了或首次)才走全文检查;**skip 路径不写 changelog**(没事就别加噪音);全文检查路径按结果照写 changelog,**完成后必须 `fp-conform-cache.sh update` 写回新 hash**,否则下轮还会重扫。
  > **重要**:Phase 2.1 修改 category 模板时已经在那一步调用 `invalidate_category <cat>`(见 §Step 2.1 v2.0 cache 同步段),所以 Phase 3.1 时同 category 的 cache 已被清空,会走全文路径。**不要在 Phase 3.1 再补 invalidate**。
- **处理**(v3.1 spawn-confirm-first):对每个 cache miss 的 session,**先查 changelog 决策记忆**,再走统一的 spawn-confirm 路径——**所有 4 项检查都不再代改**。

  **Step 3.1.0 — 决策记忆查询**:本步骤识别出的 topic 集(如 `constitution_ref` / `spawn_from_field` / `why_before_how` / `symmetry` / `base_markers` / `language_english` / …),先 query:
  ```sql
  SELECT judgment, rule_version FROM changelog
  WHERE session_name = '<session>' AND topic = '<topic>'
  ORDER BY id DESC LIMIT 1;
  ```
  - `judgment=accepted` 且 `rule_version` 等于当前模板对应规则 commit → 已对齐,无操作
  - `judgment=session_override` 且 `rule_version` 匹配 → 尊重 carve-out,跳过
  - `rule_version` 落后或无记录 → 进入 Step 3.1.1

  **Step 3.1.1 — 四项检查(全部 spawn-confirm-first)**:发现下列任一 drift 时,**FP 不代改**,而是用 `/api/spawn` 通知 session 自改,把绝对路径 + 具体段 + 目标终态明确写入 prompt,并记 `judgment=deferred`(配 topic),等下一轮再核验。

  - **(a) 对称性**:CLAUDE.md ↔ AGENTS.md 框架段不一致 → spawn,prompt 注明哪两段不一致 + 期望终态(通常以 CLAUDE.md 为准),topic=`symmetry`。
  - **(b) 分类模板符合性**:与 `templates/claude-md-{category}.md` / `agents-md-{category}.md` 对比,框架级冲突 / 冗余 / 缺关键规则 → spawn 通知 session 自改,topic 用对应模板章节名。session-owned 业务段(capability paragraph / session-local SOP 引用 / 外部 API wiring)同样 spawn。
    - **(b1) lark-cli 子命令真实性**:`lark-cli <module> +<subcommand>` 对照 `--help` 验存在性。不存在 → spawn 告知正确命令,topic=`larkcli_cmd_<module>`。
    - **(b2) doc 路径引用真实性**:反引号路径引用,验存在性,不存在 → spawn 提示更新或删除,topic=`doc_path_ref`。
  - **(c) BASE 标记残留**:grep `BASE:BEGIN` / `BASE:END`(机制已废除)→ spawn 通知 session 删除整个 BASE 区块,topic=`base_markers_strip`。
  - **(d) 语言合规**:CLAUDE.md / AGENTS.md 必须英文,大段中文 → spawn 通知 session 整篇英文 rewrite,允许中文仅限飞书表/群名 / 中文身份别名 / 中文工具名等专有名词,topic=`language_english`。
  - **(e) T2 大幅自演进兜底**:体量 ≥30 净行变动或段落重构 → 扫一遍,确认大改没有顺带改动模板基线规则(T3,须走 `/first-principle`)或体外新建身份文件(T4)。仅 T2 本身不拦截;夹带 T3/T4 → spawn 询问。

  **每次 spawn 之后必须:** (1) 写 changelog 行 `(session_name, topic, rule_version, judgment=deferred)`,`change_detail` 注明 spawn 的 finalMessage 摘要或 timeout/declined 状态;(2) 不直接刷 Feishu Bitable,聚合到 Phase 4.3 看是否需要群通知;(3) 下一轮巡检读 cache + memory 时若 session 已自改并 `accepted`,topic 状态推进。

  **批量分发(同一 topic 跨多 session)**:**不再使用** `scripts/fp-distribute-<topic>.py` 机械重写。改为 for-loop 并发 spawn(参考 Phase 1.2 self-report 并发模式),每 session 单独 prompt + 单独 changelog 行。`fp-distribute-*.py` 留在 `scripts/` 仅作历史归档。
- **产物**：违规清单 + 已发出的 spawn 通知
- **下一步消费方**：Phase 4 + 下一轮巡检追踪

### Phase 4: Sync — 同步到下游

#### Step 4.1: Session 表同步 + Purpose 三方一致性 diff

- **要解决的问题**：
  1. 飞书多维表的 sessions + bindings 视图需要和本地数据库对齐。
  2. 同一份 Purpose（session 用途）在三个地方存在：本地 `sessions.purpose`、Bitable `Purpose` 列、飞书 chat description；任何一处漂移会导致用户在不同入口看到不一致的语义。
- **输入**：无（`sync-session-table.sh` 自查 + 三方读取）
- **处理**：
  1. `./scripts/sync-session-table.sh`（先把别称/头像/分类/群名/群头像推平）
  2. **3-way Purpose diff**：对每个 active 且 `FP管辖=true` 的 session，读取
     - DB：`sqlite3 $SM_RUNTIME_ROOT/data/supermatrix.db "SELECT purpose FROM sessions WHERE name='<n>';"`
     - Bitable：从 session 表对应行的 `Purpose` 字段
     - Feishu chat：从 bindings 表拿 `group_id` 后 `lark-cli im chats get --as user --params '{"chat_id":"<id>"}' -q '.data.description'` 读 `description`
     - 三方 trim 后逐对比较；任何不一致**不自动修**，列入 `judgment=deferred` 的 changelog 行（`change_summary` 注明 "PURPOSE 3-way drift: <session>"），等用户裁决。
  3. 可选 helper：`scripts/audit-purpose-3way.sh`（输入 session 名，输出三方值与 diff 状态）。
- **产物**：飞书多维表刷新；deferred 清单（若有 drift）
- **下一步消费方**：用户在飞书看最新 session 状态；下轮 FP 巡检追踪 deferred 行
- **lesson**：2026-05-05 巡检发现 32 个 group description 一直为空，原 SOP 只对齐 Bitable 行不查 chat description，盲了半年。

#### Step 4.2: templates/ 和 rules/ 同步到飞书 Wiki

- **要解决的问题**：若 Phase 2 改了内容，飞书 wiki 需要刷新。
- **输入**：Phase 2 的改动
- **处理**：`./scripts/sync-feishu.sh`（同步 3 Principles + 4 分类模板 + rules/update-judgment.md）
- **产物**：飞书 wiki 刷新
- **下一步消费方**：其它 session / 用户查阅

#### Step 4.3: 更新巡检时间戳 + FP 群通知

- **要解决的问题**：
  - 刷 `.last-sync-review` 让下一轮巡检识别本轮已跑
  - 把"需用户介入"事项明确告知；**无事项不发空通知**（commit + changelog 已承担例行汇总，重复发飞书 = 信息污染）

- **输入**：本轮 4 阶段产生的"需用户裁决"事项清单，来自——
  - Phase 2.1 中标 `deferred` 的请求（同一规则连续 ≥3 轮 deferred 必须升级）
  - Phase 2.3 自身 lint 发现的红线矛盾
  - Phase 3 中 spawn 后 session 明确拒绝或超时未响应的对齐请求
  - **(v2.2 新增)** Phase 3 中本轮新增的 conform `deferred`，且 `change_detail` 含 "Surface to FP group" / "user decision" / 涉及多 session systemic drift 等明文求决信号 → **必须纳入**，不被 Step 2 的"清单为空"误吞。lesson:2026-05-13 01:44 id 480 "WHY-before-HOW Problem→Situation drift across 114 files" 因 Phase 2.1/2.3 都干净、本轮 changelog 看起来"已结清"，被静默跳过 step 3，导致 107 session 文件卡在老 phrasing 7 小时无人接住。

- **处理**：
  1. 刷时间戳：`date > .last-sync-review`
  2. 聚合本轮"需用户介入"事项；**清单为空 → 直接跳过 step 3，不发通知**。**(v2.2 关键)** "聚合"必须实际 query 本轮所有 `judgment IN ('deferred', 'rejected')` 的 changelog 行,并对 `change_detail` 做关键字扫描("Surface to FP group" / "user decision" / "broadcast" / "fan-out" / "drift"):凡命中关键字的 deferred,**即使别的 phase 都干净也必须纳入清单**。SQL 示例:
     ```sql
     SELECT id, target_doc, change_summary, change_detail
     FROM changelog
     WHERE date(timestamp) = date('now')
       AND trigger_type = 'patrol'
       AND judgment IN ('deferred','rejected')
       AND (change_detail LIKE '%Surface to FP group%'
            OR change_detail LIKE '%user decision%'
            OR change_detail LIKE '%broadcast%'
            OR change_detail LIKE '%fan-out%'
            OR change_detail LIKE '%drift%');
     ```
     这条查询的 result 行 ≥1 → 不允许走"清单为空"分支。
  3. 有事项 → 按以下模板发：

     ```bash
     FP_CHAT_ID=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
       "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id WHERE s.name='first-principle' LIMIT 1;")

     # 通知正文：第一行 summary，每个事项独立一行
     BODY="巡检 $(date +%F)：N 项需介入
     - <类别>: <一句话描述>（<changelog row id 或 commit hash>）
     - ..."

     lark-cli im +messages-send --as bot --chat-id "$FP_CHAT_ID" --text "$BODY"
     ```

     正文超过 1500 字 → 写临时文件用 `--file <path>` 发，并保证文件**第一行**是 summary。

- **产物**：`.last-sync-review` 已刷；若有事项则 FP 群有结构化通知，否则群里无新消息

- **下一步消费方**：Step 4.4 末次回复

#### Step 4.4: Scheduler Receipt — 末次回复以 `REPORT:` 起头

- **要解决的问题**：scheduler 任务 `fp-daily-sync-review`（class=delegation）默认 receiptProof 是 `session_reply_content_check`，pattern `REPORT:` (contains)。验证器去拉 `/api/sessions/<childId>/result` 的 `finalMessage` 看是否包含 `REPORT:`。若末次 assistant 回复不带这行 token → scheduler 判 `receipt_missing` 并发 ownerDM 重试。**2026-05-05 02:17 / 04:17 实际连发两轮 receipt_missing**（runs `62d24aba` 与 `8ae4362b`，FP 当时只回了"已完成 4 阶段"自然语言、缺 token），上一轮一度被错误回应为"改 scheduler exit_zero"，已被 heal 还原（commit d5049a8e）。**正确修法是这一步：把 token emit 写进 SOP，不是改 scheduler 判定**。

- **输入**：本轮 Phase 1–4.3 实际产物
  - changelog 新增行数（`SELECT COUNT(*) FROM changelog WHERE date(timestamp)=date('now')`）
  - 本轮 PRUNE 净增长（Phase 2.1 新增行 vs Phase 2.4 删除行）
  - Phase 4.3 是否发了用户介入通知

- **处理**：在 4.3 全部副作用跑完之后，**最后一次 assistant 回复必须以下面这行单独成行的 token 起头**（不要嵌在代码块里、不要前置叙述、不要分多条消息）：

  ```
  REPORT: FP-PATROL <YYYY-MM-DD> cycle=<n> changelog_rows=<N> prune_delta=<+/-N> notify=<sent|skipped> — <一句话本轮总结>
  ```

  字段说明：
  - `cycle`：当日第几轮跑（首跑 1；catch-up 触发会有 ≥2）
  - `changelog_rows`：本日新增的 changelog 行数（含 PRUNE no_action）
  - `prune_delta`：本轮净增长，正数表示文档变长、负数变短
  - `notify`：4.3 是否发了 FP 群通知（`sent` 或 `skipped`）

  实际示例(明早 02:17 那轮若一切顺利应当长这样):

  ```
  REPORT: FP-PATROL 2026-05-06 cycle=1 changelog_rows=4 prune_delta=-3 notify=skipped — 4 阶段全过,无 deferred 升级、无介入事项。
  ```

  **Bitable 开关关闭的 skipped 路径**(v2.1 新增,见 §Phase 0 Enabled Gate)使用不同字段格式:

  ```
  REPORT: FP-PATROL <YYYY-MM-DD> cycle=<n> skipped=true reason=<patrol_enabled=false|...> — <一句话原因>
  ```

  skipped 路径下 `changelog_rows / prune_delta / notify` 字段不参与本行(Phase 0 已写一行 PATROL SKIPPED no_action 进 changelog,但 Phase 1-4 都没跑,无需再统计)。

- **产物**：scheduler `session_reply_content_check` 返回 `passed=true`，`last_success_at` 推进；下一轮 02:17 不会再补发 receipt_missing。

- **下一步消费方**：scheduler heal/notify；SOP 结束。

## Common Pitfalls

- **顺序搞反**：先做 Phase 3 对齐再改模板 → session 白改一轮。严格 Gather → Synthesize → Conform → Sync。
- **Daily Self-Report prompt 太开放**：若只问「你有什么新发现」，session 会长篇大论漫谈。必须三段固定结构 + 每段字数上限。
- **不可达 session 跳过别强推**：spawn 多次超时（无论是 backend 升级、session 长期未激活、还是其它原因）就记 deferred 下轮重来，不要试图绕过。
- **把 Self-Report 写入 principles-log.db**：Self-Report 本身是原始输入，Phase 2 的判断才是 changelog 事件。Self-Report 保留在 `/tmp/fp-daily-selfreport-<date>/` 即可。
- **过度依赖 `/first-principle` push 通道**：见 memory `feedback_push_channel_inactive.md`——这条路径实践中极少触发，不要把它当主流。
- **(v3.1) 重复 spawn 同一 session 同一 topic**：v3.1 下 FP 全部 conform 路径都走 spawn,更加要事先 query `changelog (session_name, topic, rule_version)`;命中且 rule_version 匹配 → 套用旧决策,不要重复打扰对方。
- **(v3.1) 漏写决策记忆行**:spawn 完成(无论 accepted / declined / timeout)都必须写一行 changelog,否则下轮巡检 cache miss 时会重复同样的 spawn——浪费 token + 骚扰对方。`accepted` / `session_override` / `deferred` 三种 judgment 都要落 row。
- **Phase 4.3 通知占位符当真实内容**：2026-05-05 02:40 实际发生（msg `om_x100b50bacc6598a4c2d04d994af611c`），原 SOP 只写 `<通知内容>` 占位，agent 直接把"@notify.txt"作为消息体发出去。Step 4.3 已给完整命令模板 + "无事项跳过"规则，避免再犯。
- **末次回复忘了 emit `REPORT:` token**：2026-05-05 02:17 / 04:17 两轮 receipt_missing 即源于此（runs `62d24aba`、`8ae4362b`）。scheduler 用 `contains` 校验，token 必须真实出现在 `finalMessage`。一旦发现 receipt_missing 通知，**第一反应是检查自己上轮末次回复有没有 `REPORT:`，不是去 PATCH scheduler 的 `receiptProof`**。改 scheduler 判定属于绕过验证（commit d5049a8e 已示警并被 heal 还原）。

## Verification

- [ ] `.last-sync-review` 时间戳为今日
- [ ] changelog 至少有一条「patrol」trigger_type 的记录（即使是 no_action）
- [ ] 飞书多维表 changelog 表镜像本轮所有 patrol 记录
- [ ] 若 Phase 2 改了 templates 或 rules → 飞书 wiki 对应页已刷新
- [ ] Daily Self-Report 至少覆盖所有活跃 session（spawn 多次超时的允许 deferred）
- [ ] **Phase 2.4 Prune 已执行**：changelog 至少有一条 `PRUNE:` 前缀记录（若确无可删，也必须有 `PRUNE: 本轮无可删候选` 的 no_action 行）
- [ ] **Phase 2.5 Doc-vs-Code Drift 已执行**：6 项检查（计数 / Removed-claim / API 表 / 日期戳 / session 名 / SOP trigger 合规）每项至少一条 changelog 记录（`DRIFT-FIX:` 或 `DRIFT: <检查项> 本轮无问题`）
- [ ] **Phase 4.4 Scheduler Receipt 已 emit**：末次 assistant 回复包含单独成行的 `REPORT: FP-PATROL <date> cycle=…` token（不在代码块/引用块里、不被后续段落覆盖）
