# Console Principles — SuperMatrix Framework Operating Rules

> This document is managed exclusively by the first-principle session. To request updates, submit via the `/first-principle` skill.

## Operating Rules

### Communication Discipline

Three communication layers with strictly separated responsibilities. Do not mix them:

| Layer | Mechanism | Responsibility | Direction |
|-------|-----------|---------------|-----------|
| **Observation** | EventBus | State change notifications (logs, metrics, audit) | Publish→Subscribe, async, fire-and-forget |
| **Coordination** | HTTP API (`localhost:3501`) | Cross-session task delegation | Request→Response, synchronous |
| **Interaction** | Feishu Messages | Human-agent conversation | User↔Agent |

- EventBus handlers perform side-effect-only operations (logging, notifications). **Do not** modify state, trigger prompts, or create child sessions.
- HTTP API does not send notifications (no Feishu messages, no event triggers).
- Feishu messages are not used for inter-session communication (do not impersonate the user to send messages to other groups). Narrow exceptions are gated — see `--as user` Cross-Session Authorization Gate below.
- **WHY before HOW (change proposal discipline).** Any agent response that contains a fix, change, diff, option list, file edit, recommendation, or proposed action — including bug reports with embedded fixes, analyses with recommendations, and technical answers suggesting what to do — MUST open with these four labeled sections, in order, before the solution body:
  - `Situation:` — one sentence stating the **problem**, not the mechanism: name a consequence the reader can feel — what error fires, what data is wrong, where the user is stuck, what broke, what loss already happened. Pure wiring ("A and B share C", "A calls B", "X and Y are out of sync") is NOT a Situation; it says how things connect, not what is wrong.
  - `Goal:` — one sentence on the target state this change should reach.
  - `我做了什么:` — one sentence on what you actually executed this turn (read / grep / edit / spawn / …). Write `无` or `仅分析` if you have not acted yet.
  - `需要你决策什么:` — one sentence on the explicit decision the user must make next. Write `无，已直接执行` if nothing is open.

  All four sections are mandatory; empty ones must be filled with `无` / `—` rather than silently skipped. "This is a bug report, not a proposal" / "I'm just analyzing" / "the problem is obvious" are failure rationalizations — if your output tells the user what to change, the rule applies. The full text lives in the `claude-md-base.md` / `agents-md-base.md` templates so every session reads it on conversation start; this Principles entry is canonical reference for review and spawn-time enforcement.

  **So-What test** — after writing `Situation:`, ask "so what?": if you cannot name one concrete bad outcome, you hold a code-reading note, not a problem — go find the consequence before proposing anything. This applies to the whole response: any "how it is currently wired" sentence not followed by "...which causes <observable bad outcome>" is noise; cut it or complete it.

### Cross-Session Collaboration Rules

**Via HTTP API spawn (recommended):**

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{"target": "scheduler", "from": "<caller>", "prompt": "查一下 watchdog-daily-restart 任务的执行记录"}'
```

Returns JSON: `{"ok": true, "finalMessage": "...", "childSessionId": "..."}`

**Execution flow:** SuperMatrix creates a child session on the target session's workspace → the child session executes your prompt → results are returned synchronously → the target session's ongoing conversation is unaffected.

**Synchronous timeout caveat.** `/api/spawn` is **always synchronous** — the caller cannot opt out and does not pick a mode (see *Spawn Closure → the caller does not pick a mode* below). The max sync wait follows the caller's main-session run timeout. When a task runs past that, the framework auto-switches the spawn to the async fallback (`status:"switched_async"`, see Spawn Closure below) rather than erroring, and the watcher drives it to closure from there. Callers do not anticipate long tasks or select async themselves — for known-long work (ATP long runs, framework rewrites, large Feishu resyncs) simply expect a `switched_async` receipt and let the watcher take over. Do not fall back to reading `message_runs` directly; that violates the cross-session red line on direct DB reads.

You can also send `/spawn <target> <prompt>` via the Feishu console group (for manual operations).

**When to use which approach:**

| Scenario | Approach |
|----------|----------|
| Need the target session's agent to understand context and execute | `curl /api/spawn` |
| Only need to read/write files in the target session's workspace | Operate on the filesystem directly (workspace paths are in `session-catalog.json`) |
| Caller-owned batch / parallel work that does not need a session's identity | Local backend exec worker pool (see "Execution Surface Selection" below) |
| Submit a Principles update | `/first-principle` skill |

#### Execution Surface Selection: spawn vs local backend exec

`/api/spawn` is a **coordination boundary**, not the platform's generic process pool. A spawned child session carries session semantics — ownership, workspace identity, backend conversation state, result sinks, cross-session attribution, and a permanent `sessions` row. Using it as a hidden batch-worker primitive creates orphan session rows, confused ownership, and harder capacity control. SuperMatrix exposes three explicit execution surfaces; pick the smallest one that fits.

**Use `/api/spawn` (child session)** when **any** of these hold:
- The work belongs to another session's ownership boundary, needs that session's workspace, or must preserve cross-session attribution.
- The result must be a session-level reply (Feishu-visible agent persona, accountable identity, owner-visible chat log).
- The task needs multi-turn clarification, persistent memory, or user-facing collaboration.
- The task itself is a handoff to another agent — not just background computation.
- The child must independently communicate back to Feishu or maintain its own lifecycle.

**Use a local backend exec worker pool** (`codex exec`, `claude -p`, or equivalent backend CLI in non-interactive mode) when **all** of these hold:
- Bounded, idempotent, machine-checkable: the task has a clear input and an artifact / exit code / structured JSON / test pass-fail as output.
- No need to join another session's conversation; no need for a persistent agent identity or Feishu-visible persona.
- The caller owns the queue, retry policy, idempotency key, and result sink.
- Workdir is explicit (isolated workdir, tmp dir, or dedicated git worktree) with explicit env, timeout, and log capture.
- Verification is deterministic: the parent controller can confirm success via files, exit code, JSON, tests, or status checks.

Typical good fits for local exec workers: codebase search, log triage, smoke checks, test runs, lint/typecheck, batch prompt evaluation, model comparison, document summarization, static analysis, backend adapter probes, image/file batch processing, narrow implementation subtasks with a clear verification command.

**Use direct shell / scripts** for deterministic non-agent work where no model loop is needed at all (CLI calls, SQL, file moves). Don't wrap them in a worker just because the caller happens to be an agent.

**Do not use a local exec pool to bypass ownership.** If the work mutates another session's source-of-truth, requires that session's domain judgment, or changes a contract owned by another session, coordinate via `/api/spawn` and let the owner decide. The exec pool is an implementation detail under the caller; spawn is a coordination boundary across sessions.

**Operational constraints for any local backend exec pool** (caller's responsibility — the framework will not enforce these for you):
- Per-parent concurrency cap. Start conservatively (e.g. 2–3 active Codex jobs per parent) and raise only with evidence; uncapped fan-out is the dominant cause of Codex websocket `Broken pipe` and stream-disconnect symptoms (incident: 2026-05-06 codexroot reported `Reconnecting... stream disconnected before completion: failed to send websocket request: IO error: Broken pipe (os error 32)` traced to a parent thread fan-out without a per-parent cap).
- Queue + idempotency keys, bounded retry count, exponential backoff, per-job timeout, cancellation, and a loop-level wall-clock budget.
- Workdir isolation, git-worktree allocation, or write locks — never let two jobs share an unprotected workdir.
- Structured output parsing (`codex exec --json`, `claude -p --output-format stream-json`, or equivalent); capture stdout/stderr/JSONL into per-job log files, **not** into the user-facing Final Message card.
- Collapse transient reconnect / progress messages into status metadata. Do not leak stream-progress text to the parent's Feishu thread.
- Persist per-job state (queued / running / done / failed + run id + log path) so an interrupted controller can be diagnosed without replaying the parent session.
- Keep cwd, model, approval/sandbox mode, and environment explicit per job — never inherit ambiently from the parent.

**Decision rule:** if the desired output is an artifact, exit status, or structured report that the parent can verify, use the local exec pool. If the desired output is a responsible agent / session with its own context, ownership, or conversation, use `/api/spawn`.

**Change propagation notifications:** When your changes affect other sessions, you must proactively notify the affected parties. Notification method: send a notification to the relevant session via `/api/spawn`. The responsibility lies with the party making the change, not the affected party.

**Default-value changes broadcast must include the affected-task inventory.** When the change flips a default flag, default config value, or default routing/proof choice on a shared system (scheduler class defaults, framework env defaults, lark-cli credential defaults), the change-broadcast must enumerate the **specific tasks/sessions/records the new default touches**, not a generic heads-up. Without the inventory, downstream owners discover the impact one-by-one through silent failures: each owner thinks "this is a fresh edge case" instead of "the central change just hit me." Real incident: scheduler 2026-04-22 switched `sync_job` class default `receiptProof` to `external_evidence`; the broadcast did not list the 6+ concrete tasks whose receiptProof was empty and would silently fail verification, so each owner session (amzdata, email-admin, future-teller, dataquery, ads-master, gongying) tripped the same failure mode independently over the next two cycles.

**Class-default invariant: zero-override registration must already be safe.** When a platform session (scheduler, watchdog, FP, root) publishes a *class default* for downstream consumers (receiptProof engine + target, retry policy, timeout, identity) the default value must be runnable end-to-end **without any caller override**. Translation: if a new task registers under the class with no extra fields, the default must either (a) pick a verifier/policy that needs no class-instance data, or (b) self-detect the missing data and fall back to a safe verifier (e.g. `exit_zero`) instead of erroring on every run. Treating "caller must override the default" as the happy path is a footgun — the next class consumer reproduces the same incident. Real incident: scheduler `sync_job` class default `receiptProof.engine=sqlite_recent_writes` requires a per-task `target` row that newcomers had never seen; 2026-05-12 watchdog landed `f850ea2 fix(receiptProof): fall back to exit_zero when class default sqlite proof has no target` to convert the missing-target case from "verification error every cron" into a benign no-op, after the same hole burned 6 task owners over two cycles. Rule applies to any session that owns a class registry / default schema shared across other sessions.

**Distribute by path, not by summary.** When the notification is backed by a document (design spec, decision log, new mechanism, SOP change):

- The source document must live at a stable canonical path *before* you spawn — not `.attachments/`, not a scratch location, not a freshly-written "handoff summary" doc that is itself a lossy derivative of the real source.
- The spawn prompt must contain the **absolute path** plus the **required action** (what to read, what to do next, what to confirm back). Do not paste multi-paragraph mechanism recaps into the prompt body.
- A 1–2 sentence framing of relevance is acceptable ("this affects how you spawn long tasks and use `/btw`"); a full summary is not.
- Rationale: summaries cause two layers of loss. First, the writer compresses the doc and inevitably distorts or drops facts. Second, receivers read the spawn text and skip the path, so any distortion in the summary becomes their working mental model — and stays stale when the source evolves. Forcing them to open the path is the whole point.
- If a condensed "handoff" doc exists alongside the raw source (e.g. `foo-handoff.md` vs `foo-decisions.md`), pick one canonical doc per audience and link *that*. Do not paste the handoff content into the spawn prompt on top of linking it.

**Prohibited practices:**
- Sending messages to another session's group with `--as user` — this impersonates a human identity and disrupts the target session's conversation flow. Only the callers listed in `--as user` Cross-Session Authorization Gate below may bypass this, and only inside their declared guardrails.
- Triggering cross-session operations via EventBus handlers — EventBus is a pure observation layer
- Pasting document contents into spawn prompts instead of linking the source path (see "Distribute by path, not by summary" above)

#### Cross-Session Contract Discipline

When two sessions exchange events, payloads, or task delegations, the contract must be explicit. "Assume the other side knows" is the dominant cause of cross-session breakage in this system.

- **Producer emits complete, self-describing payload.** Any event you publish about your own state changes (table created, schema changed, run finished, snapshot ready) must carry the full information a downstream consumer needs to act — not just a "something changed" pulse. `schema_change` carries the field list; `new_table` carries the column schema; `data_range_update` references the `(snapshot_dt, data_cutoff, run_id)` it covers. Real incident: amz-sql pushed `data_range_update` before the `new_table` event for `dwd.dashenlin_quote_current` landed, leaving amzdata blocked because it could not resolve the unknown table.
- **Causal order matters.** Producers must emit dependent events in causal order, or include enough metadata for the consumer to reorder safely (sequence number, parent event id). When the order constraint is hard to enforce on the producer side, document the consumer's tolerance window in the contract.
- **Consumer-required identifiers travel explicitly.** Cross-session deliverables (dataset snapshots, run outputs, generated artifacts) must carry the identifiers the downstream needs to reason about freshness and lineage: `snapshot_dt`, `data_cutoff`, `run_id`, source `session_name`, plus a fallback path when the expected snapshot is missing. amzdata-vs-gongying same-day-snapshot misses surfaced this gap.
- **Long-running child tasks need an SLA and a canonical output path.** When a session spawns a long task into another session's workspace (e.g. ads-master → amz-radar capture run), the spawn prompt must declare: expected wall-clock SLA, the canonical `run_root` for outputs, and what the parent will treat as a no-reply timeout. Silent stalls (6-min no-output without timeout) leave the parent guessing.
- **Distinguish "spec verification" from "capability probe" requests.** A verification request runs against a known contract and returns pass/fail. A probe request asks "can we use feature X" and needs different inputs: which Feishu app to test against, whether disturbing live subscribers is allowed, what scope changes are in/out of the test surface. ATP and probe-style work must spell these out — atp 2026-04-22 lost ~50% of production `im.message.receive_v1` events because a probe spawn used `--force` against the live subscriber without permission to disturb.
- **Dispatcher proposes, owner decides.** Mirroring the scheduler rule above: if you are routing or wrapping another session's work (dispatcher, supervisor, scheduler), parameters owned by the executor (idempotency, retry policy, expected runtime, group identity) are propose-only on your side. Patch by spawning the owner with a proposal, not by silently flipping the value.
- **Spawn callers must guarantee one-spawn-per-logical-task.** Before issuing a retry / re-dispatch / "nudge" spawn to the same target for the same logical task (same issue id, same run id, same queue item), verify whether a prior child for that key is still in flight — either by remembering the returned `childSessionId` and polling `GET /api/sessions/:id/result`, or by maintaining a `(target, logicalKey) → childSessionId` map on the caller side. Duplicate spawns within the retry window put two children in the target session's workspace, interleaving their side effects and corrupting downstream bucketing. Real incident 2026-04-24: watchdog re-dispatched ATP twice within 62 seconds on issue `0c3f7260` (10:37 + 10:38); both ATP children bounced through the same Console group toggling `wzpwzpwzp`, contaminating Scenario 4 results. A framework-level `clientRequestId` on `/api/spawn` is proposed by watchdog (supermatrix-root issue `4fe45f43`); until it ships, the discipline sits with the caller.
- **Owner ACK on a heal/migration proposal must verify the PATCH actually mutates state.** When a session receives a heal_proposal or migration_proposal spawn from the scheduler (or any dispatcher) and replies `ACTION: ADJUST <key=value>` / `ACTION: MODIFY <key=value>`, the owner is obligated to confirm the proposed value differs from the current DB value before sending the ACK. A reflexive ACK whose PATCH equals the existing config is a no-op on the data side but still consumed as a positive ACK by the dispatcher — the dispatcher then enters retry mode (one cron run snowballs into N retries against an unchanged config). Required check before sending the ACTION line: read the current task config, diff against the proposed values, only send the ACTION if at least one field would actually change; otherwise reply `ACTION: SKIP` (or `LATER` for migration proposals). Real incident: socail-king `judg-2026-04-30-003` reflexively returned `ACTION: ADJUST` with `expectedDuration` matching the DB value; scheduler treated it as a fresh fix, fired `retryTaskFn`, and one nominal cron tick became 5 consecutive retries before the loop self-broke.
- **Platform→root delegation prompt must declare no-cascade scope.** When a platform session (watchdog, scheduler, FP) spawns `supermatrix-root` for an action it cannot perform itself (commit on the SM repo, lark-cli signing, etc.), the spawn prompt MUST include an explicit no-cascade clause: "do not spawn any session, do not call ATP / scheduler, do not modify anything outside `<this repo>`; reply when done." Without it, root may fan out further spawns to "be helpful," and the platform→root single-hop delegation degrades into a multi-hop tree that nobody supervises. The rule is structural: every platform→root prompt is a leaf delegation by contract, and the prompt enforces that contract on the receiving side. Real incident: watchdog `weekly-upgrade.requestRootReview` 2026-05 prompt explicitly forbids root from spawning further sessions or touching ATP / scheduler / framework state, restricting the delegation to a single-repo commit; earlier drafts that omitted the clause produced cascaded spawns that consumed scheduler quota and tripped probe alerts. Apply to any platform-tier session delegating to root.
- **Batch spawns exceeding 8 concurrent targets must be split and throttled.** When a session fans out to more than 8 spawns in a single logical operation (batch creative runs, parallel review requests, bulk delegation), the fan-out must be split into batches of ≤8 with a minimum 30 s gap between batches. The framework's per-parent concurrency cap (5 children, see the exec pool rule above) bounds active children at any moment, but HTTP 500 errors are possible when the request fan-out to the API layer exceeds platform capacity. Each batch should also implement at least one retry attempt with exponential backoff on 500/503. Without batching, runs silently fail at the API boundary with no child session created and no error visible in the caller's log — the spawn appears to succeed from the caller's perspective. Real incident: writer batch run spawned 12+ sessions in rapid succession; 4 consecutive spawns (series ranks 13–16) returned HTTP 500, producing no child sessions and no visible error until the caller noticed missing outputs (writer 2026-05).
- **Card-callback and other inbound protocols dispatch fire-and-forget into `/api/spawn`.** Feishu interactive-card callbacks (and any future inbound async protocol surfaced by the framework) arrive as text-encoded events (e.g. `CARD_ACTION:<json>`) that platform sessions decode and route into `/api/spawn`. Two non-negotiables: (a) the call must be `fire_and_forget` (or `async_kickoff`) — the inbound transport already has its own ACK semantics and **must not** be held open by a synchronous spawn; (b) the spawn `target` must come from the decoded payload (`value.target_session`), not inferred from the originating chat or session — the routing intent belongs to the publisher, not the channel. Real incident: supermatrix-root 2026-04 wired the `card.action.trigger` subscriber → dispatcher → `/api/spawn` in one commit; an early draft used `sync_inline` + chat-derived target and the card UI froze waiting on the child's reply while the routing diverged from the publisher's `target_session` field.
- **Knowledge session queries must carry structured metadata.** When spawning a knowledge or KB session (e.g. `business-knowledge`) to answer a question, the prompt must explicitly state: `topic` (concept area), `question` (precise ask), `purpose` (what the caller will do with the answer), expected answer type (`definition` / `process` / `module` / `comparison` / `decision` / `routing`), and execution boundaries (whether real-time data is allowed, whether the answer must be KB-only, whether a routing recommendation is needed). Omitting these fields forces the knowledge session to guess intent, producing misclassification and incomplete routing suggestions. Observed pattern: 5 distinct callers across one week all left intent-type and execution boundary unspecified; 11 out of 11 logged queries returned `kb_state: partial` with no routing recommendations recorded (business-knowledge review 2026-05-11).
  - **Layer-tag the inputs (`decision` / `process` asks especially).** Beyond the metadata above, the caller must separate the prompt into three explicit layers, and the KB session must keep the same three layers separate in its **answer**: (1) the *question for the KB to verify* — what the caller does not know and is asking; (2) *caller-side facts* the caller already holds and supplies as given — external facts, real-time data, owner/human confirmations, caller-local rules or thresholds the KB does not own; (3) the *requested output form* — whether the caller wants a judgment framework, a KB fact citation, or a routing lead. The KB answer must echo layer-2 facts as caller-provided ("per your input …"), never restate them as KB-sourced fact, and must label which layer-3 form it is delivering. Blending caller facts into KB facts produces false-authority answers; leaving the output form implicit produces mismatched replies. Follow-up evidence: `decision`-class queries repeatedly depended on un-tagged caller facts — owner ("增长天王") confirmations, `product-tracker` new-product thresholds, AMZData table/field mappings the KB has no SSOT for — all logged `partial` (business-knowledge review 2026-05-18 §5).

### Console Group Notifications

Console-group status notifications must go through root's `POST /api/notify`, not direct `lark-cli` calls.

**Why:** When each session shells out its own lark-cli card, card style / error handling / degradation logic each diverge. A template tweak needs N edits; one session silently swallowing a lark-cli error drops the alert without trace.

**How to send:**

```bash
curl -s -X POST http://localhost:3501/api/notify \
  -H "Content-Type: application/json" \
  -d '{"source":"<session-name>","title":"<short title>","body":"<markdown>","level":"info","metadata":{"key":"value"}}'
```

Returns `{messageId}` on card success, `{messageId, degraded:true, error}` on card-failure→text fallback.

**Input schema:**

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `source` | yes | string | Sender session name |
| `title` | yes | string | Card header text |
| `body` | yes | string | Card body, markdown |
| `level` | no | `info` \| `warn` \| `error` | Default `info` |
| `metadata` | no | object | Key→value, rendered as a labeled list |

**Card template (root-rendered, version-controlled in root):**
- Header: title + color bar by level (`info`=blue, `warn`=orange, `error`=red)
- Body: markdown div
- Optional metadata list
- Footer: `<source> · YYYY-MM-DD HH:mm:ss CST` (Asia/Shanghai)

**Degradation policy:** Card render failure → plain-text fallback:
```
[<level>] <source>: <title>
<body>
<metadata key>: <value>
...
```
Fallback returns `{messageId, degraded:true, error}`. The endpoint **never silently drops a message** — total failure returns 500 with the upstream error. Callers must not retry on `degraded:true` (the message already landed).

**Identity & security:**
- root sends as bot identity
- Endpoint is loopback-only (`127.0.0.1:3501`), no auth — same security model as `/api/spawn`
- Target Console group id is configured in root (`SM_ROOT_GROUP_ID` env); callers do not pick the destination

**Migration:** New notifications go through `/api/notify`. Existing direct `lark-cli` sites remain as a fallback path and should migrate opportunistically. Do not re-implement the card structure in caller code — fix it in root and every caller benefits.

### Feishu Operations Guide

- **Message identity rules:**
  - Notifications, status reports → bot identity (`--as bot`), to avoid confusion with user messages
  - Triggering session processing (requires framework routing to a session) → user identity (`--as user`)
  - Debugging/testing → user identity may be used to simulate real input
- **File path restrictions:** lark-cli's `--file`, `--output`, `--image`, and other local file parameters **must use relative paths**. Absolute paths fail silently (empty file or failed send, no error message). Correct approach: `cd` to the target directory first, then use relative paths. Example: `cd /path/to/dir && lark-cli im +messages-send --file ./report.md`
- **Programmatic reads must pass `--format json`.** lark-cli's read commands (`base +record-list`, `base +record-search`, `im +messages-list`, etc.) default to **markdown** output for human eyeballing. Any script that pipes the output into `jq` / `python -c 'json.load(sys.stdin)'` / similar parsers MUST add `--format json` explicitly. The default-markdown behavior is silent: the parser sees plain text and either errors out (`Expecting value: line 1 column 1`) or — worse — extracts nothing and the script proceeds as if the table were empty. Real incidents (multiple sessions in one cycle, 2026-05-08~09): FP `scripts/fp-managed-list.sh`, `gongying` (`fix: request json from lark record lists`), `qc-master` (`fix: request json from lark record reads`) all hit the same parse failure independently. When writing or reviewing any lark-cli pipe to a parser, grep for the `--format json` flag — its absence is the bug.
- **Document updates:** `lark-cli docs +update --doc <url> --markdown @file.md --mode overwrite`
- **Sending files / images as a chat message:** Use `lark-cli im +messages-send --as bot --chat-id <id>` with `--file ./<path>` (file message) or `--image ./<path>` (image message). lark-cli auto-uploads and resolves `file_key` / `image_key` — no separate upload call needed, no `--msg-type` flag either (inferred from which of --text/--markdown/--file/--image is given). Path must be relative (see the File path restrictions bullet above). Distinct from the raw Open API, which is two-step (upload → send with key); and distinct from the **group avatar** flow below (avatar is a chat property, not a message — requires explicit `im images create --data '{"image_type":"avatar"}'` + PUT `/chats/<id>`). Do not confuse `file_key` with the `file_token` returned by the cloud-document API.
- **Session identity resolution (CRITICAL for shared workdirs):** When resolving "my own chat_id" to send a message to *your own bound group*, **never hard-code the session name** in the lookup query. A workdir may be bound to multiple sessions (e.g. `amzdata`+`dataquery` share `<HOME>/amzdata`, `supermatrix-root`+`codexroot` share `<SM_REPO_ROOT>`) — all such sessions read the same `CLAUDE.md`/`AGENTS.md`, so workspace files cannot distinguish them. Always resolve identity via the framework-injected env var `$SM_SESSION_NAME`:
  ```bash
  CHAT_ID=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
    "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id WHERE s.name='$SM_SESSION_NAME' LIMIT 1;")
  cd <dir> && lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --file ./<filename>
  ```
  `SM_SESSION_NAME` is set by the framework at session spawn (both claude + codex backends). If it is empty, the session was started before this was introduced — restart it to pick up the env var. Real incident (2026-04-21): `dataquery` sent a file to `amzdata`'s chat because its query hard-coded `WHERE s.name='amzdata'`.
- **Sync surface selection:** When syncing data to Feishu, pick the target surface based on the source format — do not default to a single surface:
  - Tables / JSON / SQLite / structured logs → **bitable (多维表格)** — row-column structure, filterable views, typed fields
  - Markdown / process docs / SOPs / knowledge base articles → **Wiki document** — rich-text rendering optimized for reading
  - Simple 2D numeric tables / formula-driven stats → **sheet (电子表格)** — not forbidden; fits lightweight reconciliation or calculation
  - Raw files (PDF, images, Excel attachments) → **IM file message** or **cloud doc attachment**
  Picking the wrong surface causes: bitable typed fields being misused as long text, huge JSON pasted into Wiki breaking filtering, semi-structured data in sheet drifting on every update. Before choosing, inspect the source: is it row-column or document, machine-readable or human-readable.
- **Group avatar update:** Two-step process. First upload the image to get an `image_key` (PNG/JPG only; convert SVG first via `qlmanage -t -s 512 -o /tmp <svg>`):
  ```bash
  cd <image-dir> && lark-cli im images create --as bot \
    --data '{"image_type":"avatar"}' --file "image=<filename>"
  ```
  Then apply it: `lark-cli api PUT /open-apis/im/v1/chats/<chat_id> --as bot --data '{"avatar":"<image_key>"}'`. Look up `chat_id` via the Session identity resolution pattern above (`$SM_SESSION_NAME` env var, not a hard-coded name).
- **New Bitable creation: grant SuperMatrix bot `full_access` immediately.** When any session (or FP on its behalf) creates a Feishu Bitable that will be accessed programmatically, the very next step MUST be granting the SuperMatrix bot (`appid=LARK_APP_ID`) `full_access` on the base. lark-cli `--as bot` calls use this app's tenant_access_token; if the bot is not on the share list, every base operation returns `91403 you don't have permission`. `--as bot` is the default identity for agent reads/writes (per the Message identity rules above) — the `--as user` workaround is reserved for rare admin moves like the share grant itself, since the bot cannot add itself. Real incident (2026-05-07): writer's 莎士比亚 base was created without bot share; all `--as bot` upserts failed 91403 until FP granted full_access. Command:
  ```bash
  lark-cli drive permission.members create --as user \
    --params '{"token":"<base_token>","type":"bitable","need_notification":false}' \
    --data '{"member_type":"appid","member_id":"LARK_APP_ID","perm":"full_access"}' \
    --yes
  ```

### Principles Document System

Three globally shared Principles documents, injected into each workspace via symlinks:

| Document | Content |
|----------|---------|
| `console-principles.md` | This document. Framework operating rules and architecture |
| `coding-principles.md` | Coding decision framework and design pattern library |
| `business-principles.md` | Business orchestration principles and collaboration rules |

- **Sole writer: the first-principle session**
- Other sessions submit update requests via the `/first-principle` skill
- **Workspace sync** — symlinks, zero cost. Modify the source files under templates/ and all workspaces are updated immediately
- **Feishu sync** — After document updates, content is automatically pushed to Feishu Wiki pages for manual review
- **CLAUDE.md / AGENTS.md distribution** — Category reference templates live at `templates/claude-md-{category}.md` / `agents-md-{category}.md`. Each session owns its own CLAUDE.md/AGENTS.md; FP does not force-overwrite (the former `<!-- BASE:BEGIN/END -->` mechanism is abolished). During the periodic review, FP diffs each session against the category template and spawns self-amend notices for drift

**Relationship with native memory:** Native memory records "what happened" (personal notes). Principles define "what to do" (team handbook). Do not store content that belongs in Principles in native memory, and do not put personal context into Principles.

### SOP Discipline

SOPs are this system's **skill catalog** — every SOP is a routable unit that an agent picks up based on a description, just like an Anthropic Skill. The rules below enforce that routability.

- **Start every new SOP from `first-principle/templates/sop-template.md`.** Do not write a SOP from scratch. The template encodes the section skeleton (frontmatter / 核心目标 / When to Use / Prerequisites / Steps / Common Pitfalls / Verification) and, for any flow with more than 3 steps, the per-step 5-段式 (要解决的问题 / 输入 / 处理 / 产物 / 下一步消费方). Sessions on every category (业务 / 平台 / 工具 / 知识 / 外部) are bound by this rule; the prior business-only mention in `business-principles.md` is the same rule, kept there for context.
- **Every SOP MUST carry a YAML frontmatter with `name` and `description`.** The `description` is a single-sentence trigger statement that an agent reads (via `sop/INDEX.md` or the frontmatter directly) to decide whether to expand the SOP at all — mirror of Anthropic Skill's `description` field. Recommended phrasing: `当 <触发条件> 时使用；不覆盖 <反触发场景> 。`. If the description does not let a fresh agent tell two adjacent SOPs apart, it is not specific enough — rewrite.
- **The body's "不适用场景 / Do NOT use when" block is REQUIRED, not optional.** It must list at least one anti-trigger scenario, especially scenarios where a nearby SOP in the same session might be confused with this one. Anti-triggers are the routing complement of triggers — without them, two SOPs that share keywords compete silently and the agent has no signal to break the tie. (`gollum/` got this right across all 5 of its SOPs and is the reference pattern.)
- **`## See Also` (optional) for cross-SOP disambiguation.** When this SOP has known overlap with another SOP — either inside the same session (e.g. `check-account-health-risk.md` ↔ `check-account-health-detail.md`) or upstream/downstream across sessions (e.g. `christopher-nolan/product-video-pipeline.md` → `bresson/nolan-video-generation-request.md`) — declare the relationship explicitly so the agent can route correctly.
- **Long-chain pipeline documents may legitimately diverge from the structured 5-段式** — multi-actor / multi-day workflows that read more like project narratives than reusable runbooks should declare `type: long-chain` in the frontmatter to opt out of the per-step 5-段式 check, but still must carry the top-level skeleton (frontmatter / 核心目标 / When to Use / Prerequisites / Verification).
- **Index registration is non-negotiable.** Every new SOP must be registered in the session's `sop/INDEX.md` before it ships. INDEX entries should reuse the frontmatter `description` verbatim (one-line entry per SOP) so the catalog stays in sync. Periodic audits cross-reference `sop/*.md` against `INDEX.md`, plus check that each SOP has frontmatter + anti-trigger block; surfaces orphans and drift.

### Session Identity Document Change Discipline

A session's **identity documents** are a closed set: `CLAUDE.md` / `AGENTS.md` (session-owned = FP category-template baseline + session-specific content) and `NOTES.md` (scratch). **There is no third identity document.** (The global `session-catalog.json` is a SuperMatrix-core-generated roster, not a per-session identity doc.) Changes to `CLAUDE.md` / `AGENTS.md` fall into four tiers:

- **T1 — routine edit.** Small session-specific edits within the category-template structure. The session edits and commits it itself with a clear message; `watchdog-daily-commit` may auto-commit it if left uncommitted. FP periodic review checks for drift.
- **T2 — large self-evolution.** A session substantially rewrites its own `CLAUDE.md` / `AGENTS.md` (≥30 net lines changed, or section restructuring) where the changed content is **session-specific**. The session commits it itself with a `identity:` message prefix. This is the session's own content — FP does **not** gate it; FP visibility + periodic-review Phase 3 is the backstop. If left uncommitted, `watchdog-daily-commit` must **not** auto-commit it — it routes to `first-principle` (see below).
- **T3 — baseline change.** The change edits or removes a rule that originated from the FP category template (`claude-md-<category>` / `agents-md-<category>`). A session must **not** silently rewrite baseline rules. If a baseline rule looks wrong, submit via the `/first-principle` skill so FP decides whether to change the category template (the template update flow). The distinguishing question between T2 and T3 is always: *is the changed content session-specific, or shared baseline?*
- **T4 — new identity file.** Creating any **new** document that asserts identity or governance authority is forbidden. Such content belongs in `CLAUDE.md` (operating rules), `sop/` (a procedure), or `NOTES.md` (scratch). `watchdog-daily-commit` flags any new top-level governance-looking `.md` and escalates to `first-principle`. **Disambiguation:** first-time creation of `CLAUDE.md` / `AGENTS.md` / `NOTES.md` themselves is **not T4** — those three are the canonical identity-document set, so a session that initialises one of them is doing T2 (session-owned self-evolution), not violating T4. T4 covers governance-looking `.md` files **outside** that closed set.

**FP-orchestrated exemption.** When a session changes its identity docs because it was spawned by `first-principle` as part of a governance rollout, the change is pre-reviewed by definition. The session commits it immediately with message prefix `identity: FP <rollout-name>`; `watchdog-daily-commit` treats that prefix as pre-approved and may auto-commit it regardless of size.

**`watchdog-daily-commit` auto-approval boundary.** Daily-commit may auto-commit only T1 (and FP-orchestrated commits). A `CLAUDE.md` / `AGENTS.md` diff of ≥30 net lines, or any new top-level `.md`, is classified `identity_doc_major_change`: daily-commit does **not** auto-commit it and routes it to `first-principle` via `/api/spawn` — not "skip and leave for manual", which leaves the change with no owner. Time-budget skips remain a separate retry path. FP's receiving-side runbook for this handoff is `first-principle/sop/identity-doc-major-change-review.md` (classify T2/T3/T4 → spawn-confirm-first action → reply with `comm_identity_doc_major_*` token preserved).

### Session Meta Source-of-Truth Contract

The sessions bitable (`<FP_SESSION_TABLE_ID>`) is bidirectional. Each column has exactly one authoritative side; the sync script must respect that direction or it will silently destroy data.

| Field | Authority | Direction | Notes |
|-------|-----------|-----------|-------|
| `Session` | SM DB | identity (used to match rows, never re-keyed) | Primary join key |
| `Backend`, `Scope`, `Status`, `Model`, `Workdir`, `Group ID`, `Created`, `Updated` | SM DB | **push** (DB → Feishu) | Framework state — humans never edit on Feishu |
| `Purpose`, `别称` (alias), `头像` (avatar), `分类` | Feishu | **pull** (Feishu → DB) | Humans annotate on Feishu; DB caches the latest value |

**Mechanism rules:**

1. **Per-row upsert, never delete + batch-create.** Resolve `name → record_id` from one online list, then call `+record-upsert` (with `--record-id` for updates, without for new rows). Re-creating rows wipes attachments (头像 file_token, links, comments) and rotates record_ids — both break human-side bookmarks.
2. **Push payload must omit pull-direction fields.** Never include `Purpose`, `别称`, `头像`, or `分类` in the push payload — even setting them to their last-known value risks clobbering a concurrent human edit.
3. **"Online non-empty → empty" is an anomaly, not a signal.** If a pull-direction field was non-empty locally and the online value comes back empty (deleted attachment, accidental clear), the sync **must not** propagate the deletion to DB. Log it to stderr and leave the local cache intact; a human will re-confirm.
4. **No silent error swallowing.** No `2>/dev/null`, no `|| true`, no `|| echo "errors, continuing"` in the sync path. A failed lark-cli call must abort the run and surface the response body — partial syncs hide schema drift and rate-limit issues.

**Bitable attachment download note:** 头像 file_tokens are scoped to the bitable, not Drive. Downloading them via `lark-cli drive +download` returns HTTP 403. Use `lark-cli api GET /open-apis/drive/v1/medias/{token}/download --params '{"extra":"{\"bitablePerm\":{\"tableId\":...,\"baseToken\":...}}"}'` instead.

Reference implementation: `first-principle/scripts/sync-session-table.sh`.

**Session category enum:** `分类` is a closed enum: `业务 / 平台 / 工具 / 知识 / 外部`. The exact field contract lives in `rules/session-meta-fields.md`. `外部` sessions are bound to external groups: non-owner senders receive answer-only public/general Q&A, with no company information disclosure, no SuperMatrix operations, and no file/code landing. Owner exception is allowed only when the sender open_id equals the configured owner identity.

---

## Architecture Reference

> The following is a detailed description of the system architecture. Consult as needed. You do not need to read this proactively during daily work — refer to it when encountering relevant issues.

### System Naming

| Official Name | Alias | Definition |
|--------------|-------|------------|
| **SuperMatrix** | SM | AI Agent collaboration platform |
| **SuperMatrix Runtime** | Runtime | Runtime environment hosting workspaces and databases (path: `SuperMatrixRuntime/`) |

### Feishu Groups

| Group Name (Feishu display) | Alias | Group ID | Bound Session | Purpose |
|---------------------------|-------|----------|--------------|---------|
| SuperMatrix Console | Console | `LARK_CHAT_ID` | None (framework listens directly) | System command entry point (/new, /list, etc.) |
| supermatrix root | Root Work Group | `LARK_CHAT_ID` | `supermatrix-root` | Framework development and infrastructure tasks |
| first-principle | FP Group | `LARK_CHAT_ID` | `first-principle` | Principles document management, manual review feedback |
| Company All-hands | 全员群 | `LARK_CHAT_ID` | None (broadcast only) | Company-wide announcements — use this group when notifying all colleagues about new SuperMatrix features or major updates |
| (same as session name) | — | (assigned at creation) | Worker Sessions | Business task communication |

**Common points of confusion:**
- Console vs Root Work Group — Console is the system command entry point (not bound to any session), Root Work Group is the dedicated work channel for `supermatrix-root`
- Root Session vs FP Session — Root manages code and infrastructure, FP manages documents and principles. Responsibilities do not overlap

### Session System

A Session is the basic work unit of SuperMatrix. Each session represents an independent AI Agent work environment.

**Attributes:** name (unique identifier), scope (user/root/child), backend (claude/codex), category, purpose, status, parentId, depth

**Lifecycle:**
```
initializing → idle ⇄ busy → deleted
                ↓
              error
```

**Creation flow:** Create workspace → Initialize git → Write .gitignore → Create Feishu group → Create Principles symlinks → Symlink `session-catalog.json` → Regenerate the global catalog

### Child Sessions (scope: child)

Lightweight execution units for cross-session task delegation.

| Dimension | Regular Session | Child Session |
|-----------|----------------|--------------|
| Feishu group | Yes | No |
| workdir initialization | git init + symlinks (Principles + catalog) | Uses existing workdir |
| Lifecycle | Manual /delete | Auto-cleanup after 60 minutes of inactivity |

Creation method: `childSession.spawnChild()`. Safeguards: max nesting depth of 3, max 5 concurrent children per parent, auto-cleanup after 60 minutes idle. Parent deletion cascades to its children. `/list` / `/status` / `/api/health` hide children by default — query the `sessions` table directly (or `listAllSessions()`) to see them.

#### Child Types (spawn-time preset)

Every spawn must declare a `type` (enforced by `spawnChild`). Four presets:

| Type | Use case | Key capability |
|------|----------|----------------|
| `one_shot_delegation` | One-off task, return and done | One run, result returned to the caller |
| `ephemeral_conversation` | Short multi-turn side-conversation with a session | Multi-run, idle TTL (~10 min). Used by `/btw` |
| `user_voice_reporter` | After finishing, post a message to a group **as user** (to trigger another session / human) | `postIdentity: 'user'` + `chat_post` sink |
| `event_publisher` | Produce a structured event on TopicBus; no reply expected | `eventbus_publish` sink; no reply returned to the caller |

> **Not accepted by current `/api/spawn` contract (2026-05-06; verified with supermatrix-root 2026-05-13):** `event_awaited_worker` is implemented in `childSessionPolicy.ts` / `childSession.ts` (including the `waiting`-state hand-off path) but `/api/spawn` hard-codes the request `type` to `one_shot_delegation` and does not parse `eventBusContract.subscribe` / `subscribeGatesCompletion` / `callerInvocation` — external callers cannot pick this type today, and any companion fields are silently dropped. Code is retained for the eventual spawn-contract extension; do not write new external callers against it.

**Deprecated**: the old `keepAlive: true` flag is removed. `keepAlive=true` → migrate to `type: 'ephemeral_conversation'`; `keepAlive=false` → `type: 'one_shot_delegation'`. Free-text `purpose` inference is gone; `type` is explicit.

#### Result Sinks (where the output goes)

Every spawn must declare at least one `resultSinks` entry. Each sink is a tagged union:

| Sink kind | Meaning |
|-----------|---------|
| `http_response` | Return the result to the HTTP caller — `/api/spawn` is synchronous, so this is always the spawn-result path |
| `pollable_endpoint` | Caller polls `GET /api/sessions/{childSessionId}/result` |
| `chat_post` | Post final message to a Feishu group. Needs `chatRef` + `identity: 'bot'\|'user'` |
| `eventbus_publish` | Publish a structured event to TopicBus `topic` |
| `parent_continuation_inject` | Synthesize a system event for the parent session — parent gets woken up as if it received a new message |
| `audit_only` | Only write to `cross_session_log`; no real delivery |

**Sink dispatch under synchronous `/api/spawn`**: `/api/spawn` is synchronous-only — there is no caller `mode` field (see Spawn Closure below). Every spawn result is delivered straight back to the HTTP caller via the `http_response` path. The old guidance — "`sync_inline` short-circuits sinks, so pick `async_kickoff` / `fire_and_forget` to exercise `chat_post` / `eventbus_publish` / `parent_continuation_inject`" — is **retired**: callers can no longer pick an invocation mode. How the non-`http_response` sinks dispatch under the always-synchronous path is owned by socail-king's 2026-05-18 spawn-closure redesign and is not yet specified here — do not assume the old "sync bypasses sinks" behavior still holds.

**Not yet wired**: `chat_post` with `chatRef.kind='requester'` or `'reply_to'` logs a warning and skips. Use `chatRef.kind='parent'` or `'explicit'` with an explicit `chatId` for now.

#### New Session Status: `waiting`

`SessionStatus` schema has six values: `initializing | idle | busy | waiting | error | deleted`. The `waiting` state belongs to `event_awaited_worker` (not pickable from `/api/spawn` today — see Child Types above). Public spawn callers will never produce a `waiting` row; internal code paths could in principle, but no production path currently does. If you see a `waiting` row from a spawn-triggered session it's stale data — safely treat as `error` or `deleted`.

#### `cross_session_log.kind` Expanded

Previously only `'spawn'`. Now also `'continuation'` — emitted when a child uses `parent_continuation_inject` to notify parent. Historical queries filtering `WHERE kind='spawn'` remain correct.

| kind | `from_session_id` | `to_session_id` | `message_run_id` | Meaning |
|------|-------------------|------------------|------------------|---------|
| `spawn` | requester | target (= parent) | child's run id | "who spawned a child" |
| `continuation` | child | parent | parent's run id | "child finalized and notified parent" |

#### Cross-Session Coordination Patterns

When a session needs another session's result to continue, the patterns are:

- **A triggers B, A blocks waiting for B's reply** — call `/api/spawn`. A's HTTP call doesn't return until B finishes; the framework verifies closure before returning (see Spawn Closure below). The max sync wait follows A's main-session run timeout — on timeout the framework switches the spawn to the async fallback rather than erroring. This is the **only** caller-facing behavior of `/api/spawn` — A does not pick it.
- **A triggers B, B is expected to run long** — A still just calls `/api/spawn` synchronously; there is no caller-pickable async mode. If B outruns A's timeout, the framework auto-registers the spawn as an async-fallback item, A gets a `switched_async` receipt and stops blocking, and the watcher drives it to closure — re-waking A with the result later (see Spawn Closure). A does not poll `/api/sessions/{id}/result` itself.
- **A fans out a structured event, many consumers** — `event_publisher` + `eventbus_publish` sink. TopicBus keeps a 64-entry ring buffer per topic with `replay=true` by default, so subscribers that attach late still see recent events.

> **Not pickable from `/api/spawn` today (2026-05-06; verified with supermatrix-root 2026-05-13):** "A waits for an external event" via `event_awaited_worker` + `eventBusContract.subscribe` + `subscribeGatesCompletion`, and the spawn-time `continuationHook` field that toggles "A continues after B is done" — `/api/spawn`'s body parser does not read these fields, so external callers cannot opt in. Code and schema are retained for the eventual spawn-contract extension.
>
> **Not removed:** The `parent_continuation_inject` *sink* is a separate mechanism and is fully working — `apiServer.ts` accepts it on `callerSinks`, `resultSinkEngine.ts` dispatches it, and `cross_session_log.kind='continuation'` is emitted normally (see Result Sinks above). Do not conflate the working sink with the contract-closed `continuationHook` field.

**Cross-layer continuation is not automatic.** A spawns B spawns C: C completes → only B is notified. B has to run again and decide whether to notify A. SM does not propagate across layers.

#### Spawn Closure (framework-verified sync, auto-fallback to async)

A cross-session spawn can be marked `completed` while the caller never actually got what it asked for — a "false success" (a plausible-looking final message while the real side effect — commit, DB row, file, reply token — never landed). Since the 2026-05-18 redesign the framework closes this gap itself: every `sync_inline` `/api/spawn` is verified by the framework the moment the child finishes, and a spawn that does not verifiably close is **switched to an async fallback** rather than silently returned. The caller never implements or evaluates predicates — it gets either a verified result or a "switched to async" receipt.

**The closure model:**

1. **The caller does not pick a mode.** `/api/spawn` does not read a `mode` field from the request body — every external spawn runs **synchronously**, and the caller blocks and waits. Async is **not a caller-selectable option**; it is purely the framework's automatic fallback when the sync path fails or times out (steps 4–5 below). Rationale: letting callers choose async forces each one to judge *when* to go async and *how* to correctly collect an async result — an unstable burden the framework must absorb instead. The caller only declares *who to spawn and what to ask*; closure reliability is the framework's job. A `mode` value sent by an older caller is **ignored (with a warning logged), not rejected**, so legacy call sites do not break. Framework-internal async paths (the failure auto-fallback below, `event_awaited_worker`, dispatcher/watcher routing) still exist — they are simply not reachable through a public `mode` parameter.
2. **`from` is required.** Every `/api/spawn` request body must include `from`, set to the caller's own session name. Missing `from` returns HTTP 400 with `from is required in /api/spawn requests; set it to the caller session name`. Rationale: `from` is the attribution key in `cross_session_log` and the return address for async fallback; without it, the closure watcher cannot assign responsibility or route a late result.
3. **The framework runs a three-phase check the moment the child finishes** — three machine-checkable criteria, in order:
   - **Communication** — the child session actually started.
   - **Execution** — run status is healthy and the output is non-empty.
   - **Delivery** — the delivery actions the caller declared (posted to which group / written to which table / image sent) actually happened.
   All three pass → closed; the response carries `closure:"verified"` and the verified result.
4. **One synchronous retry.** Any phase fails → the framework first re-runs the check (guards against a transient flap), then re-spawns the whole child once.
5. **Auto-fallback to async.** Retry still fails, the call times out, or the caller's HTTP connection disconnects before the child finishes → the framework registers the spawn in the `spawn_async_items` table and returns `{ok:false, status:"switched_async", ref:"<id>"}` when a response channel still exists. Caller disconnects are recorded as `failed_phase=delivery` and `failure_kind=late_result`, so the completed child is not orphaned in `cross_session_log`; the watcher can later route the late result back through the caller's heartbeat pool. **The caller side never needs to understand predicates** — it gets either a verified result or a "已转异步" receipt.
6. **Watcher fallback.** Async items are taken over by the watcher (a socail-king scheduler task). It triages `spawn_async_items`: anything fixable by a pure re-drive goes to the heartbeat todo pool; anything needing a judgment call gets a socail-king adjudication child session.
7. **Checkability is a hard gate.** The caller's "counts as success" contract (`delivery_checks`) must be expressible as objectively checkable facts; an unverifiable declaration is rejected with HTTP 400 at admission. The check judges **behavior and existence only** (sent or not, landed or not, empty or not) — **never content quality.**
8. **Throttle queue (FIFO, not hard-reject).** When the spawn admission layer hits capacity, incoming requests enter a persistent FIFO queue rather than being rejected with HTTP 429. Requests drain from the queue as capacity frees up; the caller's HTTP connection is held open (long-poll) until the request is admitted or a timeout expires. This replaces the earlier hard-reject model, which forced callers to implement retry logic and caused cascading failures during load spikes.

**`delivery_checks` field** — optional; omit it and the framework degrades gracefully to the implicit minimum ("output non-empty"). If given, each entry must be one of the checkable shapes (`inbox_message` / `db_row` / `file`); a malformed or unverifiable entry → HTTP 400. There is **no "missing predicate → reject" admission gate** — the old strict-admission model and its five `verification_predicate` templates are retired (see History below).

```bash
curl -s -X POST http://localhost:3501/api/spawn -H 'Content-Type: application/json' -d '{
  "target": "<target>", "from": "<caller>",
  "prompt": "...",
  "delivery_checks": [
    { "kind": "inbox_message", "session_name": "<target>", "contains": "TOKEN-ABC123" }
  ]
}'
```

**Trust the check, not the status.** This mechanism deliberately does not trust `status=completed` — `status` lies, and the "false success" it reports is exactly the disease being treated.

**Observability.** Every key step — the three-phase check, the sync retry, the async switch, watcher triage, the adjudication verdict — writes a structured log line, all joined by a single `comm_id`, so the full lifecycle of any one spawn can be reconstructed after the fact.

> **History:** This replaces the earlier `verification_predicate` mechanism (spawn-closure 0.1→1.0). The 1.0 cutover on 2026-05-15 flipped admission to strict (HTTP 400 on a missing predicate) before callers had migrated — 21 un-migrated call sites were silently rejected and the watcher produced a ~230-message retry storm in 12h, rolled back the same day. The redesign removes the hard admission gate entirely: a missing `delivery_checks` degrades gracefully instead of being rejected, so that failure class cannot recur.

#### `--as user` Cross-Session Authorization Gate

Sending Feishu messages as the **human user identity** (`--as user`) into another session's group is powerful — downstream sessions cannot tell it apart from real human input, which is exactly the point (used to drive another session from a child or a patrol). But it also creates impersonation risk, so the privilege is gated by *caller pattern*, not by sink name. A caller is authorized only if it satisfies all of: platform-tier ownership, an explicit narrow trigger, stable dedup keying, a constrained composer, and an escape hatch that routes real user-choice gates to `alert` / the human user instead of impersonation.

**Authorized callers (use freely within their declared guardrails):**
- **`user_voice_reporter` child sink** — the child acts on an explicit human directive delegated through a platform session (e.g. scheduler → dispatcher → user_voice_reporter → target business session). Type is for *triggering the next step* in a deterministic pipeline, not general-purpose messaging.
- **`heartbeat` patrol's `user_resume` decision** — the controller emits `user_resume` for a mechanical continuation checkpoint (stale evidence collection, explicit reversible next step, continuation of an already-approved plan). Required guardrails encoded in heartbeat:
  - dedup on `(user_resume, target_session, logical_key)` recorded in local `action_claims` so the same nudge is not resent every patrol;
  - the child composer must return only the message body and **must not** introduce new requirements, parameters, approvals, or business choices;
  - true user choice gates (new product / business / parameter / approval decisions) must use `alert` instead — never impersonate the user to manufacture consent;
  - every send writes `user_resume_sent` / `_failed` / `_skipped_duplicate` into local `heartbeat_events` for audit.
  Reference: `workspaces/heartbeat/docs/rollouts/2026-05-08-heartbeat-trigger-log.md` §User Resume.
- **Debugging / integration testing** where the session operator has control of the group.

**Preflight membership before `--as user` to an external group.** When the target chat is an **external** Feishu group (`分类=外部`, i.e. the human user is not guaranteed to be a member), preflight with `lark-cli im chats members get --as user` (or any read that requires user identity) before the real send. If the user open_id is not on the member list, abort with an explicit `skipped: user_not_in_external_group` annotation and return control to the caller — do not call the send and catch `230027 Permission denied` after the fact. Failing this preflight pushes the failure into mid-flow and breaks the calling task's contract; three sessions hit it in one 24h window (atp / yolo / makelove all blocked on xjbc external group sends, 2026-05-12). lark-cli auth-scope errors are silent until the actual send, so the only safe gate is an explicit preflight.

**NOT authorized (use `bot` identity, or escalate via `alert` / human user):**
- Status reports, notifications, periodic summaries — always bot.
- Any message going to groups outside SM's workspace system.
- New product / business / parameter / approval decisions for the target session — those are user choice gates and must escalate, never be impersonated.
- Adding a new authorized caller of this gate without first updating this section — silent expansion of impersonation surface is forbidden.
- When in doubt: default to `bot`. `--as user` cross-session is for *triggering the next deterministic step*, not general-purpose messaging.

### Session Reasoning Effort (`/effort`)

Each session has an optional `effort` attribute that overrides the backend's default reasoning effort. Stored in the `sessions.effort` column and passed to the backend on every run of that session.

**Command scope:**
- From Console or the root work group: `/effort <session-name> <level>`
- From a session-bound group: `/effort <level>` (applies to that group's bound session)
- `default` clears the override (column set to NULL — backend's built-in default is used)

**Valid levels:** `low`, `medium`, `high`, `xhigh`, `max`, `default`

**Backend mapping — the two backends use different flags and different value semantics:**

| Level | Codex (backend-codex) | Claude (backend-claude) |
|-------|----------------------|------------------------|
| `low` | `-c model_reasoning_effort=low` | `--effort low` |
| `medium` | `-c model_reasoning_effort=medium` | `--effort medium` |
| `high` | `-c model_reasoning_effort=high` | `--effort high` |
| `xhigh` | `-c model_reasoning_effort=xhigh` | `--effort xhigh` |
| `max` | `-c model_reasoning_effort=xhigh` (aliased — `xhigh` is Codex's highest supported level) | `--effort max` (passed through verbatim) |
| `default` | No flag passed (Codex built-in default) | No flag passed (Claude built-in default) |

**Key differences:**
- **Codex** sets reasoning effort via a `-c` config override (`model_reasoning_effort=<value>`). Its highest native level is `xhigh`, so the framework normalizes `max` → `xhigh` before forwarding.
- **Claude** sets effort via the `--effort` flag. No normalization — whatever value is stored is forwarded as-is (including `max`).
- **Scope**: The `effort` attribute is per-session, not per-run. It persists until changed via `/effort` and applies to every subsequent run of that session.

Implementation references: `src/app/commands/setEffort.ts`, `src/adapters/backend-codex/commandBuilder.ts`, `src/adapters/backend-claude/commandBuilder.ts`.

### Session Backend Hot-Swap (`/backend`)

A session's `backend` attribute (claude/codex) is no longer immutable after creation. Use `/backend` to swap the backend engine without deleting and re-creating the session. The session must be `idle` or `error` — `busy` sessions are rejected.

**Command scope:**
- Console or root work group: `/backend <session-name> <claude|codex>`
- Session-bound group: `/backend <claude|codex>`

**Swap sequence:**
1. Check status (reject if busy).
2. Clear `backendSessionId` (resume tokens are not compatible across backends).
3. Reset `model` to `NULL` (model IDs are not portable across backends).
4. Update the `backend` field.
5. Update the Feishu group name suffix (failure does not block the swap).

**Side effects:** Equivalent to `/reset` plus backend change — conversation context is lost and `model` reverts to the backend default. Reversible, but prior context cannot be recovered.

**Group name suffix:** If the group name ends with `-claude` or `-codex`, that suffix is replaced; otherwise the new suffix is appended.

**New Lark capabilities:** `renameGroup(groupId, name)` and `getGroupName(groupId)` wrap Feishu `PUT` / `GET /open-apis/im/v1/chats/{chatId}`.

### Workspace

Path: `$SM_WORKSPACE_ROOT/{session-name}/`. Each workspace is an independent git repository.

```
{session-name}/
├── CLAUDE.md / AGENTS.md        # Backend instruction document (core rules + session-specific content)
├── session-catalog.json         → symlink → global session roster (SM-core generated)
├── console-principles.md        → symlink → first-principle/templates/
├── coding-principles.md         → symlink → first-principle/templates/
├── business-principles.md       → symlink → first-principle/templates/
├── NOTES.md                     # Session work notes
└── ...
```

### Session Catalog

`session-catalog.json` is the **global session roster** — one JSON file listing every active session as `{name, alias, backend, category, status, fp_managed, capability}`. SuperMatrix core regenerates it on session creation / deletion / status change / backend swap, and symlinks the single file into every workspace. Sessions must not hand-edit it. Routing / alias lookup is a deterministic query — `jq '.sessions[] | select(.alias=="SK")'` — not a prose scan. (Replaces the retired per-session `CONSTITUTION.md`, 2026-05-19: per-session markdown identity docs were dropped; a session knows "who am I" from `$SM_SESSION_NAME` and its own `CLAUDE.md`.)

### EventBus Event Types

| Event | Trigger Condition |
|-------|-------------------|
| `session_created` | Session creation complete (including child sessions) |
| `session_deleted` | After session deletion |
| `session_status_changed` | Status change (idle↔busy, etc.) |
| `catalog_updated` | After `session-catalog.json` is regenerated |

### HTTP API

SuperMatrix exposes a local HTTP API on `127.0.0.1:3501` (`SM_API_PORT`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | System status (session count, busy count, uptime). Hides children. |
| `/api/spawn` | POST | Cross-session task delegation (creates a child session to execute) |
| `/api/run` | POST | Run a prompt on an existing user-scope session, resuming its main backend session — equivalent to "user typed in chat" without posting. v1 supports `sync_inline` only. Distinct from `/api/spawn` which always creates a fresh child. |
| `/api/sessions/{id}/result` | GET | Polls a child's final result; used by the framework's async-fallback / watcher path — no longer a caller pattern (`/api/spawn` is sync-only, see below) |
| `/api/notify` | POST | Console-group status notifications (root renders card; see "Console Group Notifications" above) |

Listens on 127.0.0.1 only. Internally calls `childSession.spawnChild()`.

**`/api/spawn` is synchronous-only — there is no caller `mode` field.** Since the 2026-05-18 spawn-closure redesign the request body's `mode` is **no longer read**: every `/api/spawn` call runs synchronously, the framework verifies closure, and on failure/timeout it auto-switches to the async fallback itself (see *Spawn Closure* above). A `mode` value sent by an older caller is ignored with a warning logged — not rejected, so legacy call sites do not break. The earlier caller-pickable modes (`async_kickoff` for "don't block, poll later", `fire_and_forget` for produce-and-go) are retired as **public** options; `async_kickoff` / `fire_and_forget` survive only as framework-internal mechanisms and are not reachable through `/api/spawn`.

| Returns | Status | Response body |
|---------|--------|---------------|
| Verified close | 200 | `{ok:true, childSessionId, childSessionName, finalMessage, backendSessionId, closure:"verified"}` |
| Switched to async fallback | 200 | `{ok:false, status:"switched_async", ref}` — the framework took over; the watcher drives it to closure |

```bash
# /api/spawn — always synchronous, no `mode` field
curl -s -X POST http://localhost:3501/api/spawn -H 'Content-Type: application/json' \
  -d '{"target":"<session>","from":"<caller>","prompt":"<request>"}'
```

### Scheduled Tasks (scheduler session)

The scheduler session provides cron-based scheduled task services for other sessions and external scripts.

**Core capabilities:**
- Standard 5-field cron expression scheduling
- Two executors: `shell` (run commands) and `http` (send HTTP requests)
- **Task class declaration** — Every task declares one of 5 classes (`sync_job` / `publication` / `monitoring` / `delegation` / `notification`). Class supplies defaults for idempotency, receipt-proof kind, notify routing, and overlap policy; owner may override per task
- **Task category declaration (required)** — Every task must declare one of 8 业务功能 categories (single-select enum). Missing or invalid `category` on `POST /tasks` returns HTTP 400 with an enum hint; old tasks created before the field was added need a backfill PATCH. Category is orthogonal to `class` — `class` describes lifecycle (sync_job / delegation / …), `category` describes the business surface the task serves. Look up the live enum via `GET /tasks/categories` or by reading scheduler's `sop/task-description-convention.md`
- **Two-axis lifecycle** — trigger success (executor exited cleanly) and verify success (business outcome proven) are tracked separately; `last_success_at` advances only on verify. One of 5 receipt-proof kinds — `exit_zero` / `http_2xx` / `session_reply_present` / `session_reply_content_check` / `external_evidence` (sqlite / file / http_get queries against downstream state) — runs during the verify window
- **Three-tier self-heal** — `pure`-idempotency failures are auto-retried once; other failures raise a heal proposal to the owner session via spawn (ACTION protocol below); owner-unreachable falls back to user DM
- **Notify v2 channels** — `ownerDM` (to owning session's group) / `userDM` (to the human) / `customChat` (explicit chat id). Class-default routing, per-task override. Class constraints apply (see Red Lines in coding-principles)
- **Overlap policy** — Per task, declares how scheduler behaves when cron fires before the previous run completes (typically `skip_if_running` for long tasks like 24h crawls)
- One-shot tasks (auto-disabled after successful execution)
- SQLite persistence + execution history

**API (runs within the scheduler workspace):**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /tasks` | POST | Create a scheduled task |
| `GET /tasks` | GET | List all tasks. Supports query params: `createdBy=<session>` filters by creator, `enabled=true/false` filters by status. Can combine: `?createdBy=me&enabled=true` |
| `GET /tasks/:id` | GET | View task details |
| `PATCH /tasks/:id` | PATCH | Update a task |
| `DELETE /tasks/:id` | DELETE | Delete a task |
| `POST /tasks/:id/run` | POST | Manually trigger execution |
| `GET /tasks/:id/runs` | GET | View execution history |

**Relationship with the SuperMatrix API:** The scheduler is an independent service and does not go through `localhost:3501`. Other sessions delegate scheduler operations via spawn, or call the scheduler's API directly.

#### Lifecycle and Failure Contract

These rules apply to every scheduled task — both creators (the session that owns the task) and the scheduler itself must honor them.

- **Two-axis lifecycle: trigger success ≠ business success.** Scheduler tracks two independent axes: (a) the executor returned (shell `exit 0` / HTTP 2xx) and (b) the verifier confirmed the business outcome. `last_success_at` is set by axis (b), not axis (a). A task whose executor reports success but whose verifier never ran is **not** done — leaving `last_success_at` unset surfaces the gap to monitoring. Real incident: `amzdata-daily-inspection` swallowed exceptions with `|| echo FAILED:` and the legacy single-axis logic still bumped `last_success_at`.
- **Cross-session proposal uses the ACTION-line protocol.** When scheduler escalates via spawn (heal proposal after a failed run, or migration proposal to move an existing task onto the new class/lifecycle), the prompt must carry: task id, current config snapshot, last N run trace, the exact ask, and the allowed ACTION set. The owning session must reply with a line starting `ACTION: <NAME>` (optionally followed by `key=value` args); natural-language prose before/after is allowed — the parser takes the **last** `ACTION:` line in the reply. Free-text replies without an ACTION line break the loop.
  - Heal proposals (a run failed) accept: `ACTION: RETRY` (re-run once) · `SKIP` (mark known-failed, wait for next cron) · `DISABLE` (flip enabled=false) · `ADJUST` (change expectedDuration / receiptProof / overrides).
  - Migration proposals (move an existing task onto the new class/lifecycle) accept: `ACTION: CONFIRM [expectedDuration=<ms>]` · `MODIFY class=<X> expectedDuration=<ms>` · `LATER` (defer) · `DISABLE` (task obsolete).
  - **24h no-reply → class default applied.** Heal default is `RETRY` for `pure` idempotency / `SKIP` otherwise. Migration default is `LATER`; repeated `LATER`s will eventually escalate past the owner to userDM (scheduler never auto-DISABLEs on silence, but the human user will get pinged). Not replying is a real choice with real consequences.
- **Idempotency dictates the fix path.** Each task declares `idempotency: pure | non | conditional` (class-default at creation, owner may override). `pure`: scheduler may auto-re-trigger on transient failure (three-tier self-heal step 1). `non` / `conditional`: scheduler escalates to the owner via heal proposal; never auto-re-trigger without explicit owner approval. Missing the declaration → treat as `non` (safer default).
- **Owner-authoritative migration.** Scheduler does **not** silently change task parameters that the owning session declared (cron, expectedDuration, retry policy, idempotency flag). When scheduler observes a parameter mismatch (e.g. tasks consistently exceed `expectedDuration`), it raises a proposal to the owner; the owner accepts, rejects, or counter-proposes. Same rule applies to any cross-session metadata: dispatchers propose, owners decide.
- **Notification dedup against open root cause.** Before sending a failure notification or dispatching a fix spawn, scheduler must check whether the same root-cause notification is already open against the same task within the suppression window (default 24h). Re-firing the same alert / re-dispatching the same fix produces alert fatigue and parallel patches — both observed in production. Dedup key: `(taskId, errorSignature)`; closing the loop happens when verifier confirms success.
- **Run evidence is mandatory.** Every notification (success summary, failure alert, escalation) must carry: `taskId`, `taskName`, `created_at`, `runs.id`, last `exit_code` / status. Notifications without the evidence triple cannot be triaged and have caused dispatchers to misattribute failures across tasks.
- **Heartbeat auto-pause on provider rate limits.** When the AI provider returns rate-limit errors, heartbeat enters a pause state rather than retrying immediately — the pause is recorded in a local ledger and heartbeat resumes processing once the provider's rate-limit window clears. This prevents a stuck retry loop from burning the caller's rate-limit quota and masking the real issue. Callers (watchdog, scheduler) can also programmatically request a pause via the heartbeat pause controls. While paused, pending items stay queued; nothing is skipped or lost.
- **Disabled / suspended tasks need a deadlined heartbeat — silent decay is a real failure mode.** A scheduled task in `enabled=false` (or any "suspended / paused / on hold" state owned by the scheduler) must surface a recurring reminder to the owner if it stays disabled past `N × cron_period` (default 3 cron periods, with 48h floor and 30d ceiling, deduped per 7 days). "Disable for now" must imply "ping me on the new cadence" — without that, a 5-day pause on a daily job means 5 missed runs and zero alerts, and the work it was supposed to do silently rots downstream. Alongside cron tasks this rule applies to any owner-driven suspend lever (manual `enabled=false`, paused subscriptions, throttled fan-outs). Real incident: scheduler 2026-04-29 found `amzlisting-even-day-ingest` had been disabled 5 days with no acknowledgement; fix wired startup `process.kill(0)` orphan detection plus the disabled-too-long DM described above.
- **Delegation-target reply contract — finalMessage MUST end with `REPORT: <summary>`.** When a `class=delegation` task spawns a target session, the target's `finalMessage` is consumed by `session_reply_content_check` to verify the work landed. The verifier looks for the literal token `REPORT:` followed by a one-sentence summary on the last line. Two concrete obligations: (1) the target session must end its final message with that line — applies to scheduled reviews, daily-inspection delegations, any spawn whose `receiptProof.kind` is `session_reply_content_check`. (2) When the *task creator* migrates a task to `class=delegation` (or creates a new one), they must patch the `prompt` so the target is told to end with `REPORT:` — class migration alone does NOT rewrite the prompt, and the target session has no other way to know the verifier needs that token. Real incident: `scheduler-daily-review` migrated to delegation 2026-04-26 with the old prompt; two consecutive runs (`3f7150d2`, `56e63bf8`) silently produced `evidence_missing` because the child finalMessage carried no `REPORT:` line, while `last_success_at` stayed unchanged and no alert fired.
