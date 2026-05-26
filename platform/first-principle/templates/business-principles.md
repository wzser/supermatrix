# Business Principles — Business Operation Guidelines

> This document is managed centrally by the first-principle session. To request updates, submit through the `/first-principle` skill.

## Core Philosophy

**The essence of a business project is orchestration.**

Through orchestrating business workflows, skills and tools are integrated together to achieve the desired business outcomes.

Code is merely the vehicle for orchestration. What truly matters is: whether the workflow design is sound, whether the skill composition is efficient, and whether the end results are achieved.

## Orchestration Patterns

### Workflow Definition

A business workflow consists of the following elements:

- **Input** — The trigger conditions and input data for the workflow
- **Steps** — An ordered sequence of operations, each step invoking one or more skills/tools
- **Branches** — Path selection based on conditions
- **Output** — The deliverables and state changes produced by the workflow

### Skill Composition

- **Single Responsibility** — Each skill does one thing, and does it well
- **Composability** — Skills are combined through explicit input/output interfaces, not internal coupling
- **Idempotency** — Executing the same skill with the same input multiple times should yield consistent results

### Measuring Effectiveness

The success criteria for orchestration is **business outcomes**, not technical metrics:

- Did the workflow achieve the expected business results?
- What is the actual experience for the user/customer?
- How stable is the workflow on repeated execution?

Technical metrics (performance, availability, etc.) are constraints, not goals.

## Collaboration Rules

### Agent Role Positioning

Each business Agent (Session) needs to understand:

- **My position in the orchestration** — Which part of the process do I handle? What does upstream give me? What do I produce for downstream?
- **My boundaries** — What is my responsibility, and what should be delegated to other Agents?
- **My dependencies** — Which skills and tools do I need? Are they ready?

### Cross-Agent Collaboration

**Delegate tasks via HTTP API:**

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target": "<session-name>", "from": "<your-session-name>", "prompt": "<task description>"}'
```

- **`from` is required** — set it to the caller session's name so the framework can attribute the spawn and route async fallback results.
- **`/api/spawn` is synchronous — the caller does not pick a mode.** There is no `mode` field in the request body; every external spawn blocks until the child finishes and the result comes back in the JSON response.
- **Long tasks need no special handling** — if the child outruns the caller's run timeout, the framework auto-switches the spawn to an async fallback, returns a `switched_async` receipt, and the watcher drives it to closure. The caller never selects async or polls a result endpoint itself.
- **"A waits for B to finish before continuing"** — this is just the default behavior: call `/api/spawn` and block. Closure is framework-verified. Details in `console-principles.md` → Cross-Session Coordination Patterns and Spawn Closure.
- **Non-disruptive to the target session** — Creates an independent child session on the target's workspace; the target session's ongoing conversation is unaffected
- **Three communication layers must not be mixed** — HTTP API for coordination, EventBus for observation (logs, notifications), Feishu for human-agent interaction. Do not use Feishu messages for inter-session communication
- **State transfer relies on data, not assumptions** — Do not assume an upstream Agent has already done something. Explicitly require the data you need to be passed
- **Failure handling** — When a dependent Agent or skill fails, an explicit degradation strategy is better than silent failure. HTTP API returns 500 + error message
- **Do NOT impersonate the user** — Sending messages `--as user` (or spawning `user_voice_reporter`) is gated; see `console-principles.md` → user_voice_reporter Authorization Gate. For status reports, notifications, and any cross-session result delivery, use bot identity.
- **Expand abstract dispatch parameters at the dispatch boundary, not at the call site** — When a dispatcher routes work to another agent and the routing references abstract levers (model `tier`, backend `class`, capability bucket), the dispatch script must resolve the abstract value to a concrete identifier (`model_id`, backend version, exact endpoint) *at the moment of dispatch* and pass the concrete value into the spawn payload. Never let the child agent re-resolve the abstract value — its lookup table may diverge from the dispatcher's, and the resulting "child used the wrong model" failure is silent and only surfaces in cost or quality drift weeks later. Keep one resolution point per abstract lever, owned by the dispatcher (yolo `dispatch` translates `(backend, tier)` → concrete `model_id` before spawn, commit `7ccbf1f`, 2026-04-23).
- **Business workflows must not own platform automation infrastructure.** Business sessions own the business predicate, decision, workflow step, output, and domain-specific recovery rule. They may use existing platform interfaces (`/api/spawn`, scheduler APIs, Feishu bot delivery, shared skills), but must not create or own local LaunchAgents, cron daemons, reusable self-heal loops, global registries, webhooks, adapter lifecycle dependencies, cross-session run ledgers, or generic retry/audit/notification mechanisms. When a business workflow needs periodic monitoring or self-healing, submit a platform/tool request with: business predicate, retryable vs manual-review conditions, real failure examples, expected business outcome, required handler/downstream session, and acceptance criteria. Rule of thumb: "how to judge this business failure" is business-layer; "how to keep checking, retrying, registering, observing, and recovering it every N minutes" is platform/tool-layer.
- **High-noise external feeds (newsletter, RSS, Slack firehose, social listening) need a channel-boundary filter SOP — never feed raw into the KB.** When a knowledge / business workflow ingests a high-volume external feed where most items are irrelevant, the ingestion pipeline MUST split into two stages on a clean session boundary: (1) **the channel-owner session** pulls and lands raw items into a local archive directory it owns (auth, dedup, retention live with the credentials); (2) **a separate consumer session** reads only that archive, applies the filter / interest model, and decides what to capture into the KB. Do not let the channel-owner perform business filtering, and do not let the consumer hold the channel credentials — collapsing the two leaks credentials into editorial logic and forces every filter tweak through the auth-gated session. The two-stage pattern also makes the SOP testable: the consumer can be re-run over yesterday's archive without re-pulling the feed. Real incident: mythos `sop/ai-valley-newsletter-intake.md` — `email-admin` pulls the newsletter into an archive, `mythos` reads-only and filters into KB; first iterations that mixed pull + filter into one session bled IMAP credentials into the editorial agent and forced a filter rewrite to require email-admin's permissions. Generalises to RSS / Twitter list / Slack feed / any noisy intake.

### Business Judgment: Consult 阿基米德 First

When facing a business question and unsure how to judge — **ask 阿基米德 first** (session name `business-knowledge`, alias `阿基米德`). 阿基米德 is the curator of our business knowledge base and the authoritative source for domain facts, data definitions, and process conventions.

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target": "阿基米德", "from": "<your-session-name>", "prompt": "<your business question>"}'
```

Only escalate to the human user after 阿基米德 confirms the knowledge gap is genuinely missing from the knowledge base.

## Direct Message Notification Capability

amn-automatedmessagenotifications provides the notify tool for sending direct Feishu notifications to users within business workflows.

**Tool path**: `<SM_WORKSPACE_ROOT>/amn-automatedmessagenotifications/bin/notify` (not in PATH — call by absolute path or alias the path first).

**Usage** (replace `<NOTIFY>` with the absolute path above, or `alias notify=<path>` once per shell):
```bash
<NOTIFY> --to <name> --text <plain text>
<NOTIFY> --to <name> --markdown <Markdown>
<NOTIFY> --to <name> --file <file path>
<NOTIFY> --to <name> --image <image path>
```

**Name matching**: Supports full name or the latter part of a name (e.g., "泽康" matches "刘泽康"). Reports an error when multiple people match; use a more precise name in that case.

**Registered users**: YOUR_NAME、叶华琳、刘泽康、王禹、王环

**Applicable scenarios**: Task completion notifications, scheduled reminders, anomaly alerts, cross-session collaboration result delivery, and other workflow steps that require notifying an individual.

## Feishu Bitable Sync Direction

每张飞书 Bitable 必须显式声明同步方向，三种典型模式：

- **本地权威（push-only）**——本地 SQLite / 代码 / JSON 是 primary，飞书 Bitable 是只读镜像。例：执行 log、聚合结果表。
- **飞书权威（pull-only）**——飞书 Bitable 是 primary（人工在线编辑），本地代码 / SQLite 是只读副本。例：业务参数、阈值、人工审批白名单。
- **混合 per-column**——同一张表里部分字段本地权威、部分字段飞书权威，**逐列声明方向，禁止整表统一**。例：FP 维护的 `sessions` 表（Backend / Status / Workdir 本地→飞书 push；别称 / Purpose / 分类 / 头像 飞书→本地 pull）。

同步脚本**只能沿权威方向写**，反向写入是 bug（会产生 lost update）。

## Feishu Bitable Field Documentation

字段名用中文；description 必填——让人**不用翻代码**就知道这数据从哪来、怎么算的。
**参数 / 配置类字段**额外要写清：这值被谁读、走哪条代码路径、改了之后会改变哪个 downstream 行为。
**触发**：建表 / 加字段 / 改字段语义 / 上游 source 改路径或口径 → 在同一个任务里补完 description。

数据字段示例：

```bash
lark-cli base +field-create --base-token <t> --table-id <tbl> --json '{
  "field_name": "今日销量", "type": 2,
  "description": {"disable_sync": true, "text":
    "本地映射 amzdata/sqlite:orders.units_shipped\nPT 时区当天 FBA 发货件数（不含退货 / FBM）\nSUM(orders.units_shipped) WHERE ship_date=today_pt AND channel=FBA"}
}'
```

参数字段示例：

```bash
lark-cli base +field-create --base-token <t> --table-id <tbl> --json '{
  "field_name": "缺货预警天数", "type": 2,
  "description": {"disable_sync": true, "text":
    "本地映射 replenishment/config.yaml:low_stock_alert_days\n库存预测剩余天数 < 此值即触发预警\n被补货 daily 巡检读取；改大→预警更早触发，改小→更晚；不影响补货下单（由 reorder_threshold 控制）"}
}'
```

`+field-update` 同 schema 用于已有字段。

## Knowledge Workspace Governance

Knowledge workspaces (e.g., business-knowledge) curate raw sources into actionable outputs. Follow these structural principles:

### Three Work-Product Views

All knowledge workspace outputs must be classified into one of three views:

| View | Purpose | Examples |
|------|---------|----------|
| **Facts** | Verified information for analysis and decision-making | Compiled docs, data analyses, metadata inventories |
| **Procedures** | Step-by-step operating instructions for humans or agents | SOPs, runbooks, checklists |
| **Automation** | Executable scripts and tools | Data pipelines, inventory scripts, sync jobs |

This classification ensures every output has a clear consumption mode: read (facts), follow (procedures), or run (automation).

### Writing Procedures (SOPs)

Every SOP must open with a **核心目标 (Core Goal)** section that states what type of SOP it is and what problem it solves. Without this, readers cannot decide whether the SOP applies to their situation.

For any workflow longer than 3 steps, document each step with the following 5-section structure:

- **要解决的问题（Problem）** — What specific pain point or blocker does this step address? Why must this step exist in the flow? (Branch conditions, if any, go here.)
- **输入（Input）** — What data / prior state / trigger this step needs
- **处理（Processing）** — What actions to take — operations, tools, key decisions
- **产物（Output）** — Data / files / state changes produced
- **下一步消费方（Next）** — Which step / agent consumes the output, and how

The fixed structure lets downstream takers (human or agent) quickly locate upstream/downstream dependencies, decide whether a step can be skipped or re-run, and pinpoint which step's input or output is broken when debugging. Use `first-principle/templates/sop-template.md` as the starting template.

### When to Write or Update an SOP

SOP write/update is **event-triggered, not periodic** — wrap-up checklists must hit this rule. Two events force an SOP write **during the work itself, before the task is finished**:

1. **Building a new business process** — As soon as the process design is confirmed (steps, owner, trigger), create `sop/<name>.md` and register it in `sop/INDEX.md`. Do not run the process even once without an SOP file in place. A new session that bootstraps many SOPs at once is normal; the discipline is to keep adding/updating as the process catalog grows.
2. **Adjusting any element of an existing process** — If during actual work you change any of the following, write the correction back into the relevant SOP **before finishing the task**:
   - Trigger condition (when the process runs)
   - Input source / data shape / prerequisites
   - Processing logic, judgment rules, or decision branches
   - Output artifact (file path, table, message format)
   - Downstream consumer (which session / human / job picks it up)
   - Verification step or rollback procedure

"I'll write it after" never happens — every later turn has its own next task. The trigger fires inside the same task that introduced the change. If a session mirrors SOPs to Feishu Wiki / Bitable, the post-edit sync command is part of the same wrap-up boundary (see the session's `sop/INDEX.md` header).

### Structural Change Logging

Every structural change to a knowledge workspace (adding asset classes, reorganizing directories, evolving the schema) must be logged in `bootstrap/log.md` with:
- What changed and why
- Version identifier (e.g., v1.0, v1.1)

This creates a decision trail that makes the workspace's evolution understandable to any agent or human who encounters it later.

## Knowledge Base

### LingXing（领星）Help Center

Local knowledge base for LingXing ERP — data definitions, feature documentation, and operational guides.

- **Path**: `<SM_WORKSPACE_ROOT>/business-knowledge/lingxing_help/`
- **Format**: ~600 Markdown files, one per topic
- **Content**: Data field definitions（数据口径）, feature guides, authorization flows, report explanations
- **When to use**: Any task involving LingXing data, metrics, or operations. Search by keyword in filenames or grep content before asking the user.

```bash
# Find relevant docs by keyword
ls <SM_WORKSPACE_ROOT>/business-knowledge/lingxing_help/ | grep -i <keyword>
# Or search content
grep -rl "<keyword>" <SM_WORKSPACE_ROOT>/business-knowledge/lingxing_help/
```

## Business Development Checklist

Before starting a new business project, confirm:

1. [ ] What is the expected business outcome? What are the success criteria?
2. [ ] What steps need to be orchestrated? Is the workflow diagram clear?
3. [ ] What skills/tools does each step require? Are they all available?
4. [ ] Are the collaboration interfaces between Agents clearly defined? Which tasks are delegated via HTTP API spawn?
5. [ ] What is the failure handling strategy? How to degrade when spawn returns an error?
