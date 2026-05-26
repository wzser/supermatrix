# Super Matrix

**Language:** [中文](README.md) | English

Connect Claude Code, Codex CLI, Kimi, and similar agent CLIs to Feishu/Lark,
with communication between sessions, so local AI tools that used to require
sitting at a terminal become workers you can call from your phone, chat groups,
and team workflows.

You can draft a plan with Codex in Feishu/Lark, send Claude to implement the
code change, then ask Kimi to review it. You do not need to copy and paste
prompts between tools; you can tell session A, in natural language, to ask
session B to handle a problem in B's own workspace.

You can also use Feishu Bitable as the interaction surface for logs, config,
project data, or operational information, so agents become part of your
organization's Feishu workflow like a collaborative local operating system
instead of isolated terminals.

## Why Use It

If you already use Claude Code, Codex CLI, or similar local agents, a few
practical problems show up quickly:

- When you are away from your computer, the agent in that terminal is
  unavailable.
- One terminal per agent works for a while, then you lose track of who is doing
  what, how far each run got, and which workspace has local changes.
- Teams cannot easily send work into the same AI workflow or reuse prompts,
  SOPs, and skills that other people have refined.
- Everyone runs their own agent, but coordination still depends on humans
  manually passing context around.

Super Matrix puts the entry point in Feishu/Lark, keeps execution local, and
turns collaboration rules into sessions, scheduler jobs, watchdog checks, and
shared skills. It is not trying to replace your AI coding tools; it connects
the tools you already use to a manageable, collaborative, auditable operating
surface.

## What You Can Do With It

Super Matrix slash commands are the local control plane. They are not a proxy
for native Claude/Codex slash commands. The point is to make local CLI agents
schedulable members inside Feishu/Lark:

- Call local AI tools from anywhere: send work in Feishu/Lark and let Claude
  Code / Codex CLI run on your machine or server.
- Give every agent a durable identity: each session has a name, alias, chat
  group, workspace, backend CLI, state, and task history.
- Keep work in the right workspace: code edits, scripts, and document reads
  happen in local directories, so you can inspect diffs, run tests, and take
  over manually.
- Manage lifecycle from chat: `/new` creates an agent, `/status` checks state,
  `/cancel` interrupts a run, `/reset` clears context, and `/next` / `/btw`
  handle queued or side-channel work.
- Coordinate multiple agents: the root console can route work to different
  sessions, let them operate in their own workspaces, then bring the results
  back.
- Turn personal know-how into team capability: shared skills, SOPs,
  Principles, and identity templates keep repeatable workflows out of private
  prompts.
- Connect Feishu Bitable and automation: autobitable maps table webhooks to
  local scripts or agent tasks; scheduler, heartbeat, and watchdog handle timed
  work, stuck-run patrols, and daily-commit review.

## Who It Is For

- People already using Claude Code, Codex CLI, Kimi CLI, or similar local
  agents who want to operate them remotely through Feishu/Lark.
- Individuals or teams that need to manage many AI sessions without relying on
  memory and scattered terminal windows.
- Teams that want to grow AI usage from a personal tool into an organizational
  workflow while keeping code, data, and credentials in their own environment.
- Teams that want shared skills, SOPs, patrols, and automation instead of
  rewriting prompts and scripts for every task.

## What It Cannot Do

- It cannot apply for or configure Feishu/Lark enterprise permissions for you.
- It does not replace your Claude, Codex, Kimi, or model-provider account.
- It cannot fix your VPN or network connectivity issues.
- It does not guarantee that every autonomous agent decision is correct.
- It is not an out-of-the-box multi-tenant SaaS deployment.

## System Components

```text
supermatrix/                 Core framework runtime
platform/first-principle/    Principles, identity templates, session metadata, FP SOPs
platform/scheduler/          Scheduled task and task lifecycle service
platform/heartbeat/          Session heartbeat, stuck-run checks, patrol tooling
platform/socail-king/        Cross-session coordination review tooling
platform/mythos/             General local knowledge-base template and knowledge map
platform/autobitable/        Feishu Bitable webhook adapter and ledger sync
platform/watchdog/           Daily-commit patrol, skipped-item handling, repo health checks
platform/skill-master/       Reusable skill registry, distribution, and evaluation tooling
docs/                        Initialization and configuration notes
```

Runtime dependency model:

```text
Feishu/Lark group
  -> Super Matrix API / CLI
  -> local SQLite state
  -> local session workspaces
  -> Claude Code / Codex / Kimi CLI
```

## Quick Start

```bash
git clone https://github.com/wzser/supermatrix.git supermatrix-public
cd supermatrix-public/supermatrix
npm install
npm run init
```

`npm run init` opens the PersonalAgent QR wizard: scan to create or select a
Feishu/Lark app, bind the local lark-cli profile, complete user authorization,
create the `Super Matrix Console` group, write the local root `.env`, create
runtime directories, and run `npm run self-check`.

Load the root `.env` before starting:

```bash
set -a; source ../.env; set +a
npm start
```

After startup, send these in the Feishu/Lark root console group:

```text
/help
/status
/new claude alpha
```

`/new <backend> <name>` creates a session, its Feishu/Lark group, and its local
workspace. `/new claude alpha` creates an `alpha` session backed by Claude Code;
if you use Codex, send `/new codex alpha` instead. After that, normal messages
in the `alpha` group become work for the Claude/Codex/Kimi CLI behind that
session.

To create a Codex session:

```text
/new codex alpha
```

To keep Super Matrix alive with the bundled local supervisor on macOS, install
localwatch:

```bash
./scripts/launchd/install.sh
```

On non-launchd environments, start it directly first:

```bash
./scripts/localwatch.sh
```

## Initialization

Use [docs/SETUP.en.md](docs/SETUP.en.md) as the end-to-end setup guide. It covers:

- local prerequisites: Node.js, npm, Git, Claude Code / Codex / Kimi CLI
- PersonalAgent QR initialization to create/select a Feishu/Lark app and write
  local `.env`
- lark-cli profile binding, user login, scopes, and root console group creation
- generated `.env` values for the root group, owner, workspace, SQLite DB,
  backend, port, and local app config
- first-run validation with `npm run self-check`, `npm start`, optional
  localwatch, `/help`, `/status`, and `/new`
- optional platform component configuration for scheduler, autobitable,
  watchdog, skill-master, and related tools

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full environment
variable index. The core runtime module also keeps a lower-level setup note in
[supermatrix/docs/SETUP.md](supermatrix/docs/SETUP.md).

## First Run

Verify in this order:

1. Run `npm run self-check` to validate local dependencies, ports, and core
   configuration.
2. Run `npm start` to start Super Matrix.
3. Send `/help` in the root console group and confirm the bot responds.
4. Send `/status` and confirm session state is readable.
5. Send `/new claude alpha` or `/new codex alpha` and confirm a session
   workspace, chat group, and backend run are created.
6. Send a normal message in the new session group and confirm it is executed by
   the backend CLI.

Session execution happens under `SM_WORKSPACE_ROOT`. Do not commit private
business repositories or generated runtime data to the public repository.

I recommend creating one root session bound to the Super Matrix source
directory, then using it to create and check the remaining platform groups. Send
one of these in the root console group first:

```text
/new claude supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

If you use Codex:

```text
/new codex supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

Then paste this prompt into the new `Super Matrix Root` group:

```text
You are the Super Matrix initialization assistant. Your current workspace should be bound to the repository's supermatrix/ source directory.

Please create the remaining platform session groups and run a basic setup check:
1. Confirm the current cwd is the supermatrix source directory and ../.env exists; read SM_ROOT_GROUP_ID, SM_BACKEND, and SM_WORKSPACE_ROOT.
2. Use SM_BACKEND as the backend for new sessions by default; if it is empty, use claude. If I explicitly say to use Codex, use codex for all new sessions.
3. Use lark-cli as user to send /new commands to the root console group. Create these platform sessions and bind them to the public directories:
   - first-principle -> ../platform/first-principle
   - scheduler -> ../platform/scheduler
   - heartbeat -> ../platform/heartbeat
   - autobitable -> ../platform/autobitable
   - watchdog -> ../platform/watchdog
   - skill-master -> ../platform/skill-master
4. Each /new command must pass an absolute path with --workdir and a readable --chat-name.
5. Do not create business sessions, and do not write real API keys, Bitable tokens, chat IDs, or private server URLs into tracked files.
6. After creation, run npm run self-check and check whether each directory has README / docs / sop; if config is missing, list the required env vars instead of inventing values.
7. Finish by reporting which groups were created, which items still need my authorization or .env values, and whether localwatch should be enabled.
```

## Data And Security Boundary

This repository is the public-safe release of Super Matrix. It contains
sanitized source code, templates, SOPs, tests, and setup docs. It does not
contain API keys, real Feishu/Lark object IDs, chat logs, business repositories,
SQLite databases, logs, or raw session workspaces.

Keep these local-only:

- `.env`, `.env.local`, and secrets
- Feishu/Lark App Secret, tenant token, user token, and app credentials
- Claude, Codex, Kimi, or other model-provider API keys
- SQLite databases
- logs, CSV/JSONL exports, screenshots, media files, and generated reports
- session workspaces and business repositories
- local SSH keys and GitHub deploy keys

The public repository is a publication target for source, templates, and
reusable platform logic; it is not a runtime image. See
[SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) for the publication boundary.

## Platform Sessions

These are not project-execution agents. They are the "platform coworkers" inside
Super Matrix. They do not directly deliver a specific domain outcome for you;
they make multi-agent collaboration manageable: who can change rules, who fires
scheduled work, who notices stuck sessions, who turns Feishu tables into
automation entry points, and who turns local knowledge into callable context.

Important: this public repository ships the code and templates for these
platform sessions, but `npm run init` only initializes the core Super Matrix and
Feishu/Lark connection. To actually run the platform capabilities below, you
usually need extra local `.env` values such as model API keys, the Super Matrix
API base URL, Bitable table IDs, public webhook URLs, or scheduler tasks.

| Name | One-liner | When you use it |
|---|---|---|
| `first-principle` | Turns one-off lessons into Principles and identity templates every session can follow. | A rule should live in Principles / AGENTS / CLAUDE templates instead of only in chat. |
| `scheduler` | Fires the right task to the right session at the right time. | You want a session to run daily, hourly, or on a fixed cadence. |
| `heartbeat` | Finds sessions that should continue but have gone quiet, then nudges them through controlled actions. | You do not want clear work to silently die after a timeout, pending child task, or mechanical confirmation point. |
| `autobitable` | Turns Feishu Bitable into auditable, pausable automation triggers. | A table record, button, or field change should trigger a local script or agent. |
| `watchdog` | Digests low-risk maintenance work and reviews daily-commit skips. | You want small repo noise, automation failures, and known maintenance issues handled without constant human interruption. |
| `skill-master` | Maintains the shared skill registry discoverable by both Claude Code and Codex. | A useful skill should become installable, synced, and evaluated team capability. |
| `socail-king` | Reviews cross-session collaboration and converts exceptions into reusable rules. | Several sessions handed work around and the result, owner, or closure path is unclear. |
| `mythos` | Maintains a customizable local knowledge-base template with sources and confidence for any domain. | You want product, process, research, or automation work to reuse knowledge you have already curated instead of relying on ad hoc model recall. |

### `first-principle`

> "Do not let a lesson from one incident remain trapped in one chat."

It owns the Principles layer: console / coding / business Principles, session
identity templates, category rules, and metadata sync. If a lesson should
affect multiple sessions, it should not remain as a verbal reminder; this
session decides whether to update Principles, templates, or only one session's
local instructions.

What it does:

- Maintains Principles docs and CLAUDE.md / AGENTS.md category templates.
- Reviews major identity-doc changes so no session quietly edits platform
  consensus.
- Runs periodic patrols that sync new collaboration rules, exceptions, and
  incident lessons back into the Principles layer.

Not for:

- Running concrete business tasks.
- Replacing framework owners for core code changes.

### `scheduler`

> "It does not do the work; it makes sure the work reaches the right worker on time."

Scheduler is the timed-task infrastructure. Use it for things like "run
daily-commit at 03:15", "trigger heartbeat every 10 minutes", or "sync the
skill registry weekly". It cares about task definitions, cron, run history,
failure notifications, and receipt proof. It does not care how the target
session performs the actual business work.

What it does:

- Creates, reads, updates, and deletes scheduled tasks.
- Calls `POST /api/spawn` on cron to dispatch work to target sessions.
- Persists run history, `last_success_at`, failure state, and receipt checks.
- Repairs missed fires, stuck runs, and orphaned tasks through SOPs.

Not for:

- Writing business logic.
- Bypassing the target session's ownership and permission boundaries.

### `heartbeat`

> "It does not nag every session; it prevents clearly unfinished work from silently stopping."

Heartbeat periodically scans sessions with heartbeat enabled. It first applies
deterministic local prefilters, then sends only candidate states to the
controller model. It acts only when there is clear evidence: a failed run, a
timeout, a child task pending too long, or a session with a clear next step that
is stuck at a mechanical confirmation point.

Before enabling it, configure:

- Super Matrix local API: `SM_API_BASE`, default `http://localhost:3501`.
- Super Matrix main database: `SM_DB_PATH`, used to read session / run /
  heartbeat state.
- The heartbeat session itself: default `HEARTBEAT_SESSION=heartbeat`; the
  matching session and workspace should exist.
- Controller model API: default `HEARTBEAT_CONTROLLER_PROVIDER=minimax`, which
  needs `HEARTBEAT_MINIMAX_API_KEY` or `MINIMAX_API_KEY`.
- Scheduled trigger: usually scheduler calls
  `platform/heartbeat/scripts/heartbeat-patrol` every 10 minutes.
- Optional Feishu log table: set `HEARTBEAT_LOG_FEISHU_BASE_TOKEN` and
  `HEARTBEAT_LOG_FEISHU_TABLE_ID` to sync triggered events.

What it does:

- Patrols failed, timed-out, stale-running, child-pending, and error states.
- Maintains a per-session todo pool with batching and recovery todos.
- Alerts the user when parameters or real human decisions are missing.
- Uses `user_resume`, `spawn_collect`, or `spawn_execute` for recoverable
  interruptions.

Not for:

- Making business judgments for business sessions.
- Resurrecting completed or normal idle sessions without clear evidence.

### `autobitable`

> "Turn Bitable from a record panel into an operations panel that can trigger agents."

Autobitable connects Feishu Bitable record, button, or field changes to
reusable, auditable, pausable Super Matrix automation. For example, a record can
move to "todo" and spawn a session, or a button can trigger a local script and
write the result back to a ledger.

What it does:

- Reviews webhook integration requests and clarifies owner, target, trigger,
  side effects, and success proof.
- Generates `webhook_id`, secret, registry records, and the minimum POST
  contract.
- Runs dry-run / live smoke checks for endpoint, secret, idempotency, and
  receipt proof.
- Manages pause, resume, deprecation, secret rotation, and re-acceptance after
  changes.

Before using it, you need:

- Your own public domain and server / reverse proxy.
- A Super Matrix runtime on your local machine or server.
- Real webhook secrets, base tokens, table IDs, and server addresses kept out
  of the repository.

### `watchdog`

> "If a small safe thing can be closed without a human round-trip, do not make it interrupt someone."

Watchdog owns low-risk maintenance issues, daily-commit follow-up, skipped-item
review, and repo health patrols. Its value is not to make business decisions
for other sessions. It moves clear, low-risk, verifiable maintenance work to
closure and preserves evidence when real owner judgment is required.

What it does:

- Maintains the issue queue: intake, claim, acceptance criteria, verification,
  archival, and notification.
- Handles daily auto-commit success, failure, skipped repos, and time-budget
  issues.
- Separates repo-local noise from source, config, data, and credential risk.
- Delegates work owned by other sessions through `/api/spawn` and tracks the
  result.

Not for:

- Directly changing high-risk business repository logic.
- Hiding source, config, data, or credential problems with `.gitignore`.

### `skill-master`

> "Before a skill becomes team capability, someone has to own discovery, installation, and evaluation."

Skill-master maintains the canonical skill pool and cross-backend registry so
Claude Code and Codex can discover the same shared skills. The content of each
skill belongs to its author or owner; skill-master owns registration, symlink
deployment, backend visibility, usage tracking, evaluation, and Feishu Bitable
sync.

What it does:

- Maintains `skills/INDEX.md` and the `skills/<name>/` canonical directories.
- Syncs shared skills into Claude and Codex skill directories according to
  Scope.
- Checks SKILL.md frontmatter, INDEX schema, and symlink targets.
- Records skill calls and periodically evaluates which skills are useful, stale,
  or ready to retire.

Not for:

- Writing the business content of a specific skill for you.
- Moving another session's private skill into the shared pool without owner
  approval.

### `socail-king`

> "Multi-agent collaboration is not about calling more agents; it is about knowing what happened when coordination fails."

Socail-king reviews cross-session collaboration paths. If a task was spawned
several times, the result did not reach the caller, ownership was unclear, or
sessions disagreed on the same issue, it helps turn that collaboration pattern,
exception, or failure into a reusable rule.

What it does:

- Analyzes cross-session handoff, spawn results, and closure failures.
- Attributes collaboration failures to owner boundaries, missing receipts,
  unclear task descriptions, or platform-rule gaps.
- Suggests how to delegate, verify, and close similar work next time.

Not for:

- Acting as a normal execution worker.
- Bypassing the real business owner or platform owner.

### `mythos`

> "Turn material into callable local knowledge, not just chat history."

Mythos is a general knowledge-base template. You define the topics, source
types, concept structure, and output format. It can archive papers, docs, repos,
web pages, SOPs, product material, or any other domain material, then provide
local knowledge with sources and confidence when other sessions build products,
write plans, make judgments, generate content, or automate workflows. An
AI / agent engineering knowledge base is only one possible use case.

What it does:

- Captures and archives user-specified material, links, docs, and local notes.
- Maintains summaries, indexes, and citations by user-defined topic, concept, or
  collection.
- Answers other sessions with traceable sources, summaries, confidence, and
  reusable judgments.
- Injects domain knowledge as context into product, process, research, or
  automation work.

Not for:

- Treating it as the only source of truth; important facts still need human or
  authoritative-source verification.
- Directly operating external systems, editing code, or performing high-risk
  actions.

## FAQ

### The Feishu/Lark group does not receive replies

Check that lark-cli is logged in, the bot is in the root console group,
WebSocket event subscription is enabled, and `SM_ROOT_GROUP_ID` is the correct
`chat_id`.

### Why does a session only respond when the bot is @ mentioned?

First separate framework filtering from Feishu/Lark event delivery.

By default, normal session groups can receive plain messages. Only sessions with
`category` set to `外部` intentionally require an explicit bot mention. The
historical fix Kakashi located is in `supermatrix/src/app/dispatcher.ts`: the
mention gate applies to `外部` sessions. The lark-cli adapter detects mentions in
`supermatrix/src/adapters/lark-cli/realClient.ts` through `eventMentionsBot()` and
`messageMentionsBot()`.

Use this order:

```bash
sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT s.name,s.category,s.status,b.group_id
   FROM sessions s JOIN bindings b ON b.session_id=s.id
   WHERE s.name='<session-name>' OR b.group_id='<chat-id>';"
```

- If `category` is `外部`, this is expected: messages without a bot mention are
  ignored.
- If the session should be internal but is marked `外部`, fix the session
  metadata before changing Feishu permissions.
- If `category` is not `外部` and only mentioned messages work, check the
  Feishu/Lark entrypoint: the app should subscribe to `im.message.receive_v1`,
  the bot should be in the group, and message send/read, chat read, and chat
  member scopes should be granted. Re-run lark-cli authorization after scope
  changes.
- If there is no inbound log at all, inspect Feishu event subscription and bot
  permissions first. If inbound exists but no reply is sent, inspect dispatcher
  and session state.

### `npm run self-check` fails

Common causes are Node version mismatch, port conflict, missing `.env` values,
unwritable SQLite paths, or a backend CLI that is not logged in. Fix the first
reported self-check failure before continuing.

### `/new` creates a session but nothing runs

Check that `SM_WORKSPACE_ROOT` exists and is writable, the selected backend CLI
works by itself, and the configured model is available to your account.

### Codex or Claude model is unavailable

Model availability depends on your local CLI version, account access, and
configuration. Validate the model with the backend CLI before setting
`SM_CODEX_DEFAULT_MODEL` or `SM_CLAUDE_DEFAULT_MODEL`.

### Feishu permissions fail

Confirm that the internal app has the required scopes, then re-run lark-cli
authorization. Scope changes usually require re-authorization.

### Why are my session workspaces missing from the public repository?

That is intentional. Session workspaces may contain private code, business data,
logs, and credentials; they should remain local-only.

## Developer Notes

Common commands:

```bash
cd supermatrix
npm run typecheck
npm run test:unit
npm run test:adapters
npm run test:e2e
npm run verify
```

`src/` is the formal framework source. `scripts/` contains local operation,
maintenance, migration, acceptance, and probe tooling. Scripts may call modules
from `src`; `src` should not depend on `scripts` as runtime code.

Before publishing a public snapshot, follow the boundary in
[SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) and scan for secrets, private
links, databases, logs, large files, media files, and generated artifacts.
