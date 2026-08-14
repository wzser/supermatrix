# Skill 使用完整文档（full doc）— owner 维护

> owner：skill-master｜模块：skill｜section_no：250
> 角色：本文件是该能力的**单一事实源（SSoT）**。FP 从这里蒸馏出十几行 snippet 注入消费方的 CLAUDE.md；CLAUDE.md 用一行指针指回本文件。
> Last verified: 2026-08-10 owner review（Kimi 发现目录已更新：受控 native 目录为 `$KIMI_CODE_HOME/skills`（默认 `~/.kimi-code/skills/`），`~/.kimi/skills/` 降为 legacy mirror；`--skills-dir` 不再作为发现断言依据——ACP 上游实现可能忽略它，必须实测 native 目录；`scripts/sync-skills.sh` 实际软链目标与 `skills/skill-probe/SKILL.md` 的 `link-seen-at` 期望一致（claude→`~/.claude/skills`、codex→`~/.agents/skills`、kimi→`~/.kimi-code/skills` + legacy `~/.kimi/skills`）；`skills/INDEX.md` 5 列 schema、`sop/INDEX.md` active add-shared-skill SOP 指针、gstack 系列 46 目录、当前 Codex 宿主无原生 `skill` 工具按注入清单读 `SKILL.md` 激活——均复核无误）
> Last verified: 2026-07-15 owner review（`skills/INDEX.md` 5 列 schema、`scripts/sync-skills.sh` 目录软链、`sop/INDEX.md` 指向 active add-shared-skill SOP、`~/.claude/skills/skill-probe` + `~/.agents/skills/skill-probe` + `~/.kimi/skills/skill-probe` 软链、Kimi Code CLI 1.37.0 支持 `--skills-dir` 覆盖发现目录、SuperMatrix Kimi backend `kimi-sandbox` 曾从 `~/.kimi/skills/skill-probe/SKILL.md` 激活 `ping skill-probe`，且 `claude-only` skill 未进入 `~/.kimi/skills`；当前 Codex 宿主没有原生 `skill` 工具，按注入的 skill 清单打开并完整读完对应 `SKILL.md` 激活）

## 1. 这个能力是什么（一句话）

「Skill 使用」= 当一个登记过的 skill 跟你手头的活相关时，**先按当前后端的 skill 机制激活它、宣告、按它说的做**，而不是凭记忆即兴发挥——skill 是 skill-master 在 `skills/INDEX.md` 登记、经 `sync-skills.sh` 软链到发现目录（Claude 用 `~/.claude/skills/`，Codex 用 `~/.agents/skills/`，Kimi 用受控原生目录 `$KIMI_CODE_HOME/skills/`，默认 `~/.kimi-code/skills/`，`~/.kimi/skills/` 保留为 legacy mirror）后被后端自动发现的专门化流程；skill-master 管登记与跨端部署（供给侧），消费方的本分是四步闭环：**发现 → 判定相关 → 激活 → 照做**。

## 2. 最小用法（消费方最常用的那条路径）

1. **发现**：skill 以「name + description」出现在你的技能清单里——Claude Code 在 `<system-reminder>` 的 available-skills 段；Kimi Code CLI/ACP 通过原生 skills 机制读取受控目录（native 为 `$KIMI_CODE_HOME/skills/`，默认 `~/.kimi-code/skills/`；`~/.kimi/skills/` 仅 legacy mirror，ACP 上游可能忽略 `--skills-dir`，发现与否以 native 目录实测为准）；Codex 宿主在 session 启动时注入可用 skill 清单与 `SKILL.md` 路径；Gemini 经 `activate_skill` + GEMINI.md 映射。
2. **判定（1% 规则）**：只要有 **1% 的可能**某个 skill 适用，就激活它去确认；激活后发现不对，丢掉即可——漏调的代价远大于错调。
3. **激活**：用当前后端的原生机制，传 skill 名或打开清单给出的 skill 文件——
   - Claude Code / Copilot CLI：`Skill` 工具，`skill: <name>`（带可选 `args`）。
   - Kimi Code：原生 skills 机制；触发条件命中时按 `SKILL.md` 执行。SuperMatrix Kimi backend 的受控发现目录为 `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`），`~/.kimi/skills/` 保留为 legacy mirror；不要只凭 `--skills-dir` 参数断言发现结果，必须实测 native 目录（`claude-only` skill 不会进入 Kimi 链，sync 会清掉 stale link）。
   - Codex 宿主：没有 `skill` 工具；决定使用某个已列出的 skill 后，打开清单给出的对应 `SKILL.md` 并完整读完，再按其中的渐进披露继续读必需的 `references/*` / `scripts/*`。
   - Gemini CLI：`activate_skill` 工具。
   - **NEVER 绕过当前清单去猜路径 / 手动搜 skill / 读不在清单里的 `SKILL.md`**。在有 `Skill`/`activate_skill` 工具的后端，不要用 `Read` 代替工具；在 Codex 宿主，打开清单给出的 `SKILL.md` 本身就是激活动作。
4. **照做**：激活后宣告一句「Using `<skill>` to `<purpose>`」；若 skill 带 checklist，每条建一个 todo；rigid 类（TDD / debugging）逐字照做，flexible 类（模式类）按情境改编。
5. **顺序**：**process skill 先于 implementation skill**。「帮我建 X / 加个功能」→ 先 `brainstorming`，再实现类 skill；「修这个 bug」→ 先 `systematic-debugging` / `diagnose`，再领域 skill。

最小可抄形态（Claude 端激活一个 skill）：

```
Skill(skill="brainstorming")          # 无参
Skill(skill="skill-probe")            # 用户说了 "ping skill-probe" 时
Skill(skill="gstack-ship", args="...")# 带参
```

Codex 端等价动作不是调用 `skill` 工具，而是：从当前注入的 skill 清单里确认 name 命中 → 打开该条给出的 `SKILL.md` 路径并完整读完 → 按正文执行；不要自己构造未列出的路径。Kimi 端按 Kimi 原生 skills 机制触发，受控路径应从 `$KIMI_CODE_HOME/skills/<name>/SKILL.md`（默认 `~/.kimi-code/skills/`）加载。

## 3. 最容易踩的坑（高频 failure mode）

1. **混淆后端激活机制** → 现象：Claude 端直接 `Read SKILL.md` 导致 checklist / 渐进披露 / usage tick 失效；Codex 端反过来寻找不存在的 `skill` 工具而卡住。原因：把某一端的激活方式误套到另一端。正确做法：Claude / Kimi / Gemini 等有原生 skill 机制的后端按 name 触发；Codex 宿主只打开当前清单给出的 `SKILL.md` 并完整读完，正文里的 `references/*` 再按 skill 要求跟读。

2. **给自己找借口跳过 skill**（"这只是个简单问题" / "我先探一下代码" / "我先问清楚需求"）→ 现象：即兴开干，绕过本该用的纪律。原因：把 skill-check 排在澄清 / 探索之后。正确做法：**skill-check 在澄清提问和代码探索之前**——skill 恰恰告诉你「该怎么探、怎么问」。

3. **凭训练记忆猜 / 编一个 skill 名** → 现象：调一个不存在的 name 报错，或调错近名 skill。原因：把记得的概念当成在册 skill。正确做法：**只调出现在你当前技能清单里、或用户亲手敲了 `/<name>` 的 skill**；拿不准就先看清单，绝不臆造。

4. **把用户指令「加个 X / 修个 Y」当成可以跳过工作流的许可** → 现象：略过 brainstorming / TDD 直接写代码。原因：混淆了 WHAT 与 HOW。正确做法：**指令说的是 WHAT，skill 管的是 HOW**；要建东西仍先 brainstorming，要进 plan mode 前先确认已 brainstorm 过。

5. **skill 在某一端发现不了就硬扛或手动复制** → 现象：codex 端看不到某 shared skill。原因：这是**供给侧部署问题**（INDEX scope 写错、软链指到了文件而非目录、单端死链没清），不是消费方该自己绕的。正确做法：发现端不一致 → 经 `/api/spawn2.0` 路由给 **skill-master** 修；机制见 §5 指针。

## 4. 最佳案例参考（canonical worked example）

**Case A — `skill-probe`：跨后端发现探针（线上真实 skill，确定性输出）**

这是验证「一份 canonical `SKILL.md` 同时被 Claude Code、Codex CLI、Kimi Code 发现并执行」的标准探针，输入输出完全确定，最适合当 canonical 例子。

输入（用户消息，逐字命中）：

```
ping skill-probe
```

agent 实际发生的事（输出）：

1. **判定**：消息含精确字面量 `ping skill-probe` → 命中 `skill-probe` 的 description 激活条件。Claude 端调起 `Skill(skill="skill-probe")`；Kimi 端经原生 skills 机制加载 `~/.kimi-code/skills/skill-probe/SKILL.md`；Codex 端打开当前清单给出的 `skill-probe/SKILL.md`（通常经 `~/.agents/skills/skill-probe/SKILL.md` 指到 canonical）。
2. **激活第一动作（静默 tick）**：按 SKILL.md 要求先 fire-and-forget 跑一次 `bash /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master/scripts/record-tick.sh skill-probe`，不等待、不向用户提、失败也忽略——给 `metrics/call-log.jsonl` 追一行调用记录。
3. **照做**：按 SKILL.md 的 Response Format 回复**且仅回复**这个块——

```
skill-probe activated
 - backend: claude
 - canonical: /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master/skills/skill-probe/SKILL.md
 - link-seen-at: ~/.claude/skills/skill-probe/SKILL.md
 - version: 1.0
```

4. **停**：不调其他工具、不追问。Kimi 端跑同一份 canonical 时，`backend: kimi`、`link-seen-at: ~/.kimi-code/skills/skill-probe/SKILL.md`；Codex 端跑同一份 canonical 时，`backend: codex`、`link-seen-at: ~/.agents/skills/skill-probe/SKILL.md`——三端都能正确回填，即证明跨后端发现链通畅。

要点：消费方做的全部就是「认出触发词 → 按本后端机制激活 → 照 SKILL.md 照做」，发现与部署（哪份文件、软链到哪）由 skill-master 在供给侧保证。

**Case B — 非平凡分支：process skill 先于 implementation（建东西前先 brainstorming）**

输入（用户消息）：

```
帮我给 skill 评估脚本加个「按 owner 分组的调用排行榜」功能
```

agent 实际发生的事（输出）：

1. **判定优先级**：这是「建一个新功能」的创造类任务 → 命中 process-skill-first 规则：**先 `brainstorming`，不是直接动 implementation skill / 不是直接 EnterPlanMode**。
2. **激活 + 宣告**：按本后端机制激活 `brainstorming`，宣告一句「Using brainstorming to 厘清排行榜的口径与边界」。
3. **照做**：按 brainstorming 探清意图（排行榜按调用次数还是去重 session 数？时间窗多长？输出去哪）——**澄清提问发生在 skill 内部，而不是跳过 skill 先问**。
4. **才进下一层**：意图对齐后再 EnterPlanMode / 调实现类 skill（写代码走 TDD 则先 `tdd`/`test-driven-development`）。

要点：同一条「加功能」指令，错误路径是「读懂需求→直接改 `evaluate-skills.py`」；正确路径是「**先 process skill 定 HOW**，再落地」。指令给的是 WHAT，skill 决定 HOW。

## 5. 完整契约 / API / 报错排查（细节区）

- **激活工具契约**：Claude Code / Copilot CLI 用 `Skill(skill, args?)`——`skill` 是清单里的精确 name（无前导 `/`；plugin 命名空间用 `plugin:skill` 全限定形）；Kimi Code 用原生 skills 机制；Gemini 用 `activate_skill`。当前 Codex 宿主没有同形 `skill` 工具，激活契约是打开当前 skill 清单给出的 `SKILL.md` 路径、完整读完并按正文执行。非 CC 平台的工具名映射见 superpowers `references/copilot-tools.md` / `references/codex-tools.md`（Gemini 经 GEMINI.md 自动注入）。
- **发现来源**：Claude Code = 每轮 `<system-reminder>` 的 available-skills 列表；Kimi Code = CLI/ACP 原生 skills 发现，受控 native 目录为 `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`），`~/.kimi/skills/` 仅 legacy mirror——`--skills-dir` 可能被 ACP 上游忽略，发现结果以 native 目录实测为准；Codex = session 启动注入的 available skills 列表与本地路径；只有出现在清单里的 name 才可调，**清单外的名字一律不臆造**。
- **skill ≠ deferred tool**：清单里的 skill 直接可调；而 `<system-reminder>` 里只给名字的 deferred 工具（CronCreate / WebFetch 等）必须先 `ToolSearch` 取 schema 才能调，直接调报 `InputValidationError`——两套机制别混。
- **skill 类型**：rigid（TDD / systematic-debugging / diagnose —— 逐字照做，别把纪律改没）vs flexible（模式 / 设计类 —— 按情境改编）。skill 正文自己会声明属哪类。
- **指令优先级**：用户显式指令（CLAUDE.md / AGENTS.md / GEMINI.md / 直接请求）> superpowers skill > base prompt。CLAUDE.md 说「别用 TDD」而 skill 说「永远 TDD」→ 听用户的。
- **不在 canonical 池但同样按 skill 机制激活的家族**：`superpowers:*` 系列（含无前缀衍生 `brainstorming` / `executing-plans` / `dispatching-parallel-agents` / `test-driven-development` 等）与 `gstack` 系列（46+，装在 `~/.claude/skills/gstack/` 由其自带 `setup` 软链）——**不进 `skills/INDEX.md`、不走 `sync-skills.sh`**，但消费方仍按本后端的 skill 激活方式调用它们。
- **供给侧机制指针**（消费方一般不用读，发现端不一致时排查用）：登记表 `skills/INDEX.md`（5 列 `Name/Origin/Scope/Owner/Purpose`，部署规则：只对 `Origin=skill-master` 且 `Scope∈{shared,claude-only,codex-only}` 建软链）；部署脚本 `scripts/sync-skills.sh`（**软链的是目录不是 `SKILL.md` 文件**——只链文件会让 codex 读得到却进不了技能列表）；新增/迁移流程以 `sop/INDEX.md` 指向的 active add-shared-skill SOP 为准；排错表见该 SOP «排错» 段（某端看不到→scope/后端发现目录不匹配；各端都看不到→软链指到了文件；飞书表重复行→UI 手工加过）。
- **发现失败 = 部署问题，路由给 owner**：某 skill 在任一后端不出现，是 INDEX scope、软链目标或单端死链的供给侧故障，经 `/api/spawn2.0` 报 **skill-master**，不要消费方自己手动 cp / 建链绕过。

## 6. 外部依赖

- **后端原生 skill 激活面**：Claude Code `Skill` / Kimi Code native skills / Copilot CLI `skill` / Gemini CLI `activate_skill`；当前 Codex 宿主通过注入的 skill 清单 + 本地 `SKILL.md` 路径激活，并要求完整读完 `SKILL.md`。激活 skill 本身**无需任何第三方凭证**。
- **跨后端软链部署面**：`~/.claude/skills/` + `~/.agents/skills/` + `$KIMI_CODE_HOME/skills/`（默认 `~/.kimi-code/skills/`）+ `~/.kimi/skills/` legacy mirror，由 skill-master `scripts/sync-skills.sh` 从 `skills/INDEX.md` 维护；Kimi 使用独立受控 native 目录以避免继承 `claude-only` skill（sync 会清掉 Kimi 两目录里的 `claude-only`/`codex-only` stale link）——这是「某 skill 能不能被发现」的唯一故障面。
- **usage tracking（skill 内部可选）**：`scripts/record-tick.sh` 静默追加到 `metrics/call-log.jsonl`，供 `scripts/evaluate-skills.py` 周期评估；不影响 skill 是否可用。
- **下游 owner session**：每个 skill 的业务正文由 `INDEX.md` 的 `Owner` 列所指 session 维护（如 mattpocock / amzdata / ziniao），skill-master 只是登记与部署的门，不是内容作者。
