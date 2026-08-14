# Coding Principles

> This document is managed exclusively by the first-principle session. To request updates, submit via the `/first-principle` skill.

Behavioral guidelines to reduce common coding mistakes. These bias toward caution over speed — for trivial tasks, use judgment.

## 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

Every proposal carries a recommendation, not just options — the user can override, but the agent must not lack judgment. Transparency is the flip side: surface the assumptions you are tempted to hide, and when the request is genuinely ambiguous, name it instead of silently picking one reading. Opinion without transparency is guessing with extra steps.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- Three lines of duplicated code beats one hard-to-understand abstraction. Reuse when clean; don't force it.
- If you write 200 lines and it could be 50, rewrite.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

**Version 1.0 corollary** — When building the first version of anything, run the critical path end-to-end and validate architecture fitness. Skeleton first, flesh later. 80% of what you imagine "might be needed" on day one either never happens or happens in a form different from what you predicted. Leave empty extension points; don't stuff speculative features.

**Decoupling is optimization, not starting posture** — The signal to decouple is when the same coupling point forces a system-wide change for the second time. Don't anticipate; don't trade delivery speed for hypothetical cleanliness.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code or bugs, **mention them** — don't silently delete or rewrite.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked — it may be load-bearing in ways the diff does not reveal.

The test: every changed line should trace directly to the user's request. Scope bloat makes diffs unreviewable and turns a two-line bugfix into a twenty-line merge conflict for the next person.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with numbered steps, verification points, and success checks. Strong success criteria enable independent iteration; vague criteria ("make it work") require repeated clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Red Lines (Distilled from Severe Bugs)

The following rules come from real production incidents. Every single one has a story of system outage or data loss behind it.

### Process and Lifecycle

- **Entry files must not import uncommitted modules** — Every file in the bootstrap/entry chain must be git-tracked. If an uncommitted file is lost, the process crashes immediately and the dev-loop cannot self-heal
- **Waiting on external subprocesses requires timeouts** — All spawned subprocesses must have an inactivity timeout and a max runtime timeout. On timeout, actively kill and restore state to idle. Never wait indefinitely
- **Graceful shutdown must release network resources** — All listening servers must `await close()` in the shutdown path. Otherwise port leaks cause crash-loops on next startup
- **After introducing a safety guard, eliminate all legacy bypass paths** — When adding guard/lifecycle mechanisms, audit every path that triggers exit/restart (signal handlers, commands, error handlers). Leave no gaps
- **Long-running subprocesses must not use `stdio:'pipe'`** — A subprocess that may run longer than ~30 s must use `stdio:'ignore'` or `stdio:'inherit'`, never `stdio:'pipe'`. The pipe buffer fills once the child writes more than ~65 KB without the parent draining, causing the child to block on write and the parent to block on close — a classic buffer deadlock. The deadlock is invisible in short runs and shows up only under real load. `stdio:'ignore'` is the safe default when output is not needed; `stdio:'inherit'` when output should stream to the terminal. Real incident: watchdog `weekly-upgrade` called the upgrade CLI with `stdio:'pipe'`, the child filled the buffer, hung, and had to be SIGTERM-killed after a timeout (commit `2af7b0b`, watchdog 2026-05).
- **Shell executor must force-resolve after SIGKILL when grandchild holds stdio** — When a shell child spawns grandchildren that inherit stdio FDs, SIGKILL on the child does NOT close the FDs held by grandchildren — the `close` event on the stdio stream never fires and any `exitPromise` that waits on it hangs indefinitely, consuming grace-period budget across multiple verify ticks. Fix: after issuing SIGKILL, set a hard 10 s timer; if the stream has not closed by then, call `safeResolve(-1)` unconditionally and proceed. An `exitCode` of -1 is unambiguous evidence of force-resolution and downstream logic must treat it as `retriable:false`. Real incident: scheduler `trigger.ts` verify loop burned 3×30 min grace periods because grandchild processes kept the stdio pipe open after SIGKILL (commit `7698431`, scheduler 2026-05).
- **Stateful external-process backends must apply identical initialization on resume as on new-session creation** — When a backend adapter (Kimi ACP, Codex exec, any long-running external process) wraps an external process that holds session state, the "resume existing session" path and the "start new session" path must run the same initialization sequence. Skipping steps on resume (e.g. omitting `loadSession()` because "the process is already running") leaves the external process side without its required state context, producing undefined behavior that passes unit tests and fails only under real session history. Pin the invariant at design time: the resume-path entry point is a required caller of the same setup function as the new-path entry point. Real incident: KimiBackend's resume path did not call `acp.loadSession()`, causing ACP to process prompts without its persisted conversation context (commit `88b6ccb`, supermatrix-root 2026-05).

### State and Concurrency

- **SQL UPDATE for state transitions must include a WHERE on the current state** — `UPDATE ... SET status='done' WHERE id=? AND status='running'` — prevents races from overwriting terminal states
- **No unprotected concurrent access to shared mutable state** — If message processing modifies session state, it must be serialized or locked
- **Bulk state cleanup must distinguish subtypes** — Do not uniformly degrade to the worst case. Sessions with recoverable backend handles and sessions without must be handled separately
- **Do not use a global singleton to hold per-entity resources** — If a resource is per-session or per-request, use a registry/factory pattern to create on demand

### Data and Messages

- **Never remove a message from the queue before confirming successful processing** — Follow the "process first, acknowledge second" pattern. If you dequeue before processing, there must be a restore/requeue path to guarantee no data loss on failure
- **Do not use closure-local state inside streaming callbacks** — Streaming parser state must be created externally and reused across chunks. Callbacks must not assume they are invoked only once

### Runtime Robustness

These rules come from the 2026-04 rounds of patrol — every one has a real incident behind it within the last few cycles.

- **Long flows must collapse to a terminal state on abort** — Any orchestration that writes intermediate state (`status='running'`, `phase='in-progress'`) must have an outermost abort/crash handler that moves that state to a terminal value (`aborted`, `failed`). Rows stuck in `running` forever are a silent-failure mode — retries, dashboards, and watchdog logic all lie. If the orchestrator can die uncatchable, wire a recovery SOP that sweeps stale rows (atp 2026-04-21 orphan run).
- **Declaration is a contract — runtime short-circuits must be loud** — When a runtime path bypasses a feature that the caller explicitly declared (e.g., `sync_inline` skipping declared `resultSinks`, a dry-run skipping side effects), it must warn or error at the boundary, not silently drop. Silent short-circuits turn configuration into a lie, and debugging becomes archaeology (spawn v2 sink-skip footgun, 2026-04-21).
- **Parallelize fan-out IO over N** — Any scheduler-triggered or periodic task that performs IO (Feishu, LLM, HTTP, subprocess) across N sessions / repos / items must default to `Promise.all` or a bounded concurrent worker pool. Serial fan-out is a time-bomb: it works at N=5 and crashes at N=25 against an external 300s ceiling. Pick an upper-bound parallelism that respects downstream rate limits; do not rely on N staying small (watchdog idle-check serial→parallel, 2026-04-21).
- **Verification commands must match the target repo's actual test runner** — When writing a verify command that runs in another repo (cross-repo bugfix verification, spawned child's self-check), first confirm the target's runner: `vitest` vs `jest` vs `pytest` vs `go test` vs `npm test`. Never copy a template from your own repo — a mismatched command is a silent no-op, and any preceding `grep` / `ls` check will let the verify "pass" on unrelated grounds (watchdog `/btw` verify miss, 2026-04-21).
- **Observability hooks travel with new entry points** — Every new entry point that produces runs (CLI command, HTTP handler, scheduler task, new dispatch path) must be wired into every existing run-level observability hook (run ledger, metric recorder, audit log, cross-session log) in the same commit. A new entry point without its observer is an instant blind spot; "I'll add metrics later" means "I'll notice the gap after the next incident" (yolo `yolo-run-resume` missed `observer.record_run`, 2026-04-21).
- **Empty aggregate output is a warning, not success** — Scripts that aggregate, index, audit, or build summaries must emit at least one diagnostic line when their output is empty. `0 links / 0 entries / 0 warnings` looks healthy but almost always means a regex missed, a glob went stale, or an upstream pipeline broke silently. Make empty = noisy, so the silent-success failure mode becomes visible (mythos `build-index.py` silent-empty concept graph, 2026-04-22).
- **Executor exit code is trigger evidence, not business proof** — A successful exit code, a `200 OK`, or a `success: true` from the runner only tells you the executor did not crash. Whether the business outcome happened must be confirmed by a separate verifier reading the produced state (DB rows, file presence, downstream API) — not asserted by the same process that ran the action. Tasks that conflate the two will silently report success while the work is broken (scheduler `amzdata-daily-inspection` swallowed exceptions with `|| echo FAILED:` yet bumped `last_success_at`, 2026-04-22).
- **On-disk fix ≠ runtime is verified — confirm the live process picked up the new code** — A green test suite, a merged commit, and an updated source file together prove only that the desired behavior exists *on disk*. Long-running daemons, subscribers, schedulers, and worker pools may still be executing the pre-commit binary in memory — restart hooks fail silently, file-watchers miss the event, container reload loops stall. Before declaring a runtime change verified, run all three checks: (a) `git log` / file mtime confirms the new code is present; (b) `ps -o lstart,pid,command` (or systemd `ActiveEnterTimestamp` / k8s pod creationTimestamp / pm2 uptime) confirms the live process started **after** the commit landed; (c) a real production-shape input flowed through the new code path and the downstream artifact reflects the new behavior. Skipping (b) is the dominant runtime-vs-disk gap. Real incident: atp 2026-05-06 `merge-forward-001` verified commit `aa087ff` for lark-cli realClient `merge_forward` expansion — the unit-test PASS plus file mtime check would have read green even if the long-running event subscriber daemon was still on the prior binary; the explicit `ps -o lstart` check vs commit time was what turned "merged" into "verified."
- **External protocol values can be `None`/empty/wrong-type** — Anything that crosses a process boundary (IMAP headers, HTTP responses, third-party SDK return values, Feishu fields, file timestamps) can be missing, null, or come back in an unexpected type. Every parse path must handle the absent / null / unexpected-type case explicitly — `int(value)` on `None`, `JSON.parse(text)` on empty, `len(rows)` on `None` all crash. Add a defensive cast at the boundary, not deep inside business logic (email-admin IMAP `UIDVALIDITY=[None]` crashed with `int('None')`, 2026-04-22).
- **Permanent failures must isolate, not retry forever** — Retry loops that don't distinguish transient errors (network blip, rate limit) from permanent errors (validation refused, content blocked, unsupported format) will pile up the same failing item on every cycle and starve the queue. After N attempts on the same item with the same error signature, mark it `quarantined` and skip — surface the quarantine count separately so it stays visible (business-knowledge OCR backfill blocked the queue with 48 retries on a sensitive-image rejection, 2026-04-22).
- **Don't display values you guessed** — If a value (model context limit, supported feature flag, downstream version) is not authoritatively known, omit the row or label it `unknown`. Never substitute a plausible-looking constant. A guessed default that turns out wrong is worse than blank space because consumers anchor on it. Only show what you can verify (supermatrix-root reverted hardcoded `MODEL_CONTEXT_LIMIT` Claude/GPT family table after producing misleading observation, 2026-04-22).
- **Verify deliverables against the real entry point** — When a task's success criterion is "URL works / port responds / endpoint serves the right content," the verification step must hit the actual deployed entry — not the assumed default port, not the expected pattern, not "I configured it correctly." Read the live process state (running port, mounted route, served response) before declaring done. Real incident: business-screen 2026-04-22 reported a service on port 4321 (the framework default) when it was actually hosted on 4322 — a one-second `curl` would have caught it.
- **CLI flag parsers must reject the next token if it begins with `--`** — When a parser consumes `--flag <value>` by reading `tokens[i+1]`, it must check that the next token is not itself a flag. Otherwise `--a --b` silently makes `--a` swallow `--b`, and `--b`'s effect is lost without any error. This is one of the most common silent-misconfiguration footguns. Add the check at the parsing boundary, not inside each handler (supermatrix-root parseCommand `--flag`-eats-next-flag bug, 2026-04-23).
- **Imported function names must not collide with method names that wrap them** — `import { copyFile } from 'fs/promises'` plus `class Workspace { async copyFile(src, dst) { await copyFile(src, dst); } }` resolves the inner call to `this.copyFile` → unbounded recursion → stack overflow. Either alias the import (`import { copyFile as fsCopyFile }`) or rename the wrapper. Pin this at code-review time; runtime catches it only via crash, not test (workspace-node `copyFile` infinite recursion, 2026-04-23).
- **Do not read another process's private state directly — call its API** — When session A needs data owned by session B (cross-session DB rows, in-memory state, run records), A must call B's published API or the framework's coordination API (`/api/spawn`, `/api/sessions/:id/result`, scheduler endpoints), never `sqlite3 path/to/B.db` from A's shell. Direct DB reads pin A to B's schema; the moment B migrates a column or moves a file, A breaks silently and the dependency is invisible at design time. Same rule for filesystem state files in another workspace (watchdog `weekly-review-watchdog.sh` was reading SQLite by path to find child sessions, switched to spawn-polling protocol after `/api/spawn` started returning `childSessionId` synchronously — supermatrix-root 2026-04-23).
- **Delegation tasks must prove completion by a session reply — nothing else counts** — When a task's class is `delegation` (scheduler spawns a target session to do work and waits for its reply), its `receiptProof.kind` must be one of the `session_reply_*` variants (`session_reply_present` / `session_reply_content_check`). Picking `exit_zero`, `http_2xx`, or `external_evidence` for a delegation is a category error: the delegation exists *to capture a reply*, and "executor returned" only proves scheduler dispatched, not that the target session answered. Scheduler enforces this as a hard constraint at task creation (`src/classes/hardConstraints.ts`); crossing it is a task-creation error, not a lint. Rule authored from scheduler's 2026-04-25 class redesign — see console-principles' "Scheduled Tasks > Lifecycle and Failure Contract" for the full class matrix.
- **`monitoring`-class tasks must not route failure alerts to the owner session** — Tasks whose class is `monitoring` (probes that watch external state: data freshness, URL liveness, pipeline progress) cannot set `notify.receipt_missing` to `ownerDM`. Business-level alerting is the monitored script's own responsibility; scheduler's notify channel for a monitoring probe is reserved for "the probe itself is broken," and that must route to `userDM` so a human can intervene. Mixing the two floods the owner session with alerts they can't action and buries real probe breakage. Hard-enforced at task creation alongside the delegation rule above.
- **Cross-module status requires a single authoritative source** — When a semantic field (run status, card phase, task outcome, notification verdict) is produced by one module and consumed by several, the producer writes one authoritative value; downstream modules read that field and must not re-derive it from indirect signals (title suffix, ❌ emoji sniff, `completedCleanly` heuristic, column-based guesses). Three independent judgers of "the same" status will disagree whenever one branch is missed, and the visible artifact (card, bitable row, log line) will contradict itself for the same run. Real incidents in the 2026-04-25 cycle: supermatrix-root card drift where `replier.suffix` + `realClient`'s ❌-prefix sniff + `!completedCleanly` gate each judged terminal state and diverged (fixed by routing all consumers through `runStatus`); `/api/spawn` final status collapsing `quota_denied` / `empty_result` / `business_done` into one "completed" bucket, leaving socail-king's daily-review and PMO unable to distinguish real success from provider-rejected runs. Downstream reads; upstream publishes; no re-derivation.
- **External API shape must be grounded in the live response or the owner's source schema, not memory** — Before writing integration code against another session's API / a third-party SDK / a CLI wrapper, fetch the real response body once (or read the owner's `zod` / `pydantic` / JSON schema / route definition). Do not write from "I remember the shape." Typical fallout: one field name or nesting level off → the code compiles locally, type-checks pass, and the integration fails at runtime the first time it sees a real payload — then ships as a hot-patch days later. Real incidents in the 2026-04-25 cycle: scheduler wrote `data.messages[]` against SM poll when the response carries `finalMessage`/`errorMessage` at the top level (fix f66ad0e); scheduler called `lark-cli bitable +ensure-fields` with the wrong params shape (fix d091fc6); yolo heartbeat payload was written from memory and mismatched scheduler's `routes.ts` zod (fix f46c583). Three sessions paid the same cost in the same cycle — always ground.
- **Symmetric same-file audit when fixing input recognition** — When you patch one branch of a character / prefix / token recognizer (NFKC-normalize, suppress, strip, route), grep the same file for every adjacent recognizer doing the same kind of check (other `startsWith`, other char-class table, other route-prefix branch) and decide point-by-point whether each needs the same treatment. The asymmetric fix (one branch of an obvious pair patched, the cousin left untouched) leaves a window where the cousin (full-width `／` after fixing `/`, full-width `～` after fixing `~`) still bypasses the new logic. Real incident: dispatcher fix `cc07339` NFKC-normalized the command path for full-width `／` but missed the adjacent `~` echo-prefix suppression branch; `0028b80` had to come back the next day and patch the symmetric `～` (supermatrix-root 2026-04-26).
- **Per-iteration timeout does not replace loop-level wall budget** — When a scheduled job runs an external CLI / subprocess in a loop over N items (per-repo daily commit, per-session daily inspection), the per-call timeout bounds one iteration but does NOT bound the loop. A loop of 30 repos at 90s each can wall-clock-exceed any 30-min scheduler hard-kill even if every single call returns cleanly. Layer two timeouts: per-call (kills a stuck child) AND loop-level wall budget (aborts remaining iterations, emits a partial log + skipped count, exits non-null) — otherwise the scheduler kills the parent with `output: null` and the failure is undiagnosable. Real incident: watchdog `daily-commit` added per-element try/catch + git `maxBuffer` in `68c6737`; the next morning's run still got wall-clock-killed at 30 min because total iteration time wasn't bounded — `b540b0c` had to add an overall budget and pull the repo list dynamically so the loop could give up gracefully (watchdog 2026-04-26).
- **Symptom-layer fix does not close the incident — root-cause must follow** — When a hotfix only suppresses the *visible* symptom (display value, card phase, log line, status flag) but the underlying state machine / counter / data is still wrong, the incident is **not** closed. Filing a follow-up root-cause task is mandatory; "ship the patch and call it done" produces silently-bad data that compounds across every later run. Hard rule: any hotfix that touches a presentation/display layer without correcting the source-of-truth must (a) annotate the commit with `WORKAROUND: <root-cause-task-ref>` and (b) leave the bug ticket open until the data layer is fixed. Real incident: supermatrix-root `b671adb` made the watermark card use the latest snapshot to mask token-usage *display* doubling, but `token_usage` rows kept accumulating Codex's cumulative `turn.completed.usage` as if it were per-run increments — billing/aggregation queries stayed dirty; only the next day's normalization fix corrected the source data (supermatrix-root 2026-04-29).
- **Mutator endpoints share the creator's schema validator** — When a system has a creation endpoint (`POST /tasks`) that validates a payload against `class` / `executor` / contract rules, the corresponding update endpoints (`PATCH`, `PUT`, `DELETE` flips that change the same fields) must run the **same** validator on the post-mutation state — not a subset, not a different code path. Otherwise the system accepts via PATCH a configuration it would reject via POST, and the broken state lives until something else reads it. The bug class is silent — types pass, request returns 200, downstream blows up days later. Real incident: scheduler PATCH allowed flipping `executor` type without re-running the executor-config validation that POST enforces; broken configs persisted for months until a real run hit them — fixed by routing PATCH through the same creation validator (scheduler 2026-04-29). Apply at every endpoint pair: POST↔PATCH, PUT↔PATCH, create↔update.
- **Boot-time sweep recovery must skip records missing the new metadata** — When a process adds a new lifecycle invariant (e.g. "every running task has a non-null pid") and writes a startup recovery sweep that uses the invariant to mark stale state failed, that sweep cannot be applied retroactively to records created before the invariant existed. Hitting `status='running' AND pid IS NULL` from legacy data and marking it `failed` will kill in-flight legitimate work that the framework has no way to verify is dead. Guard rule: the sweep predicate must require **both** the staleness condition *and* the presence of the new metadata field; missing-metadata rows are skipped and logged for manual triage. Real incident: scheduler boot orphan-recovery marked all `status=running` rows failed after adding pid-tracked liveness check; legacy runs (`amzlisting-even-day-ingest`) with pid=null had real shells 69934/69951 still executing and were spuriously closed (scheduler 2026-04-29).
- **External-CLI subprocesses (`npx`, `pipx`, `uvx`, etc.) need explicit timeout + maxBuffer set at the call site** — Default Node `execSync`/`execFileSync` give 30s timeout and 1MB maxBuffer. `npx` (or any wrapper that fetches+runs a remote tool) routinely needs both: package download dwarfs the 30s budget on cold cache, and stdout often exceeds 1MB on report-style commands. Worse, an outer scheduler timeout does **not** propagate as a SIGKILL down to the wrapped child — the parent script must set both bounds itself, AND wire its own top-level kill (`AbortController` + an outer `setTimeout(killAll, MAX_MS)`) so a hung child cannot outlive the parent. Don't trust the supervisor's timeout to traverse three layers of process wrappers. Real incidents in 2026-04-29 cycle: watchdog `weekly-token-report` had to override `npx ccusage` defaults to avoid silent buffer truncation; the same day `watchdog-idle-check` (run `0781b920`) hung 2.5+ hours with `exitCode=null` because `Promise.all([lark-cli, claude -p])` only used inner timeouts, lacking a top-level self-kill, while the scheduler's 300s `task.timeout` only marked it `evidence_missing` rather than killing the child.
- **Truncate inside the producer, never via `| head` under `pipefail`** — Under `set -o pipefail`, a pipeline like `producer | head -c N` propagates SIGPIPE back to the producer when `head` closes its read end after N bytes; the entire pipeline exits non-zero (typically 141) and the calling script aborts. This is **structural**: it bites every shell+jq/awk/curl pipeline that grew past a threshold size, not just one tool. Whenever the producer's output may exceed the truncation budget, do the slicing inside the producer — `jq '(.field // "") | .[0:N]'` instead of `jq -r '.field' | head -c N`, `awk 'NR<=N'` instead of `cmd | head -n N`, `sqlite ... LIMIT N` instead of `sqlite ... | head`, `curl --max-filesize` instead of `curl | head -c`. Real incidents: supermatrix-root `scripts/sync-bitable.sh` `jq -r ... | head -c 2000` exited 141 on a 408KB record under `pipefail`, fixed by switching to internal `jq` slicing (commit on 2026-05-02); codexroot independently reported the same `jq | head -c` SIGPIPE pattern same cycle; scheduler `daily-bitable-sync` task silently failed two consecutive days from this exact failure mode before anyone noticed.
- **Routing fields are read from the data, never inferred from class defaults** — When a record carries both an explicit field (`executor`, `kind`, `mode`, `transport`) and a class/type default that suggests one, the dispatcher MUST route on the explicit field. Inferring from a class default ("class=delegation defaults to kind=http, so I'll fetch the http URL") silently mis-routes any record whose explicit field disagrees with the class default — the executor reads from the wrong branch, gets `undefined`, and emits a generic `trigger_failed` with no useful trace. Make the explicit field the only routing input; if a record predates the field, treat that as the real fix (fill the field) rather than re-deriving at dispatch time. Real incident: scheduler `src/main.ts:76` routed shell/http executor by `effective.kind` (class default), ignoring the task's explicit `executor:"shell"` + `config.command` — class=delegation defaulted to kind=http, http branch read undefined URL, every shell-mode delegation silently failed (scheduler 2026-05-04, memo `project_dispatch_kind_vs_executor.md`).
- **Derived state is computed from the consumer's view, not the raw rows** — When you derive a status / counter / flag / "latest" from upstream data and the consumer (UI, report, dashboard) reads a transformed view (deduped, filtered, joined, ordered), the derivation MUST run over the same transformed view — not the raw table. `ORDER BY date_iso DESC LIMIT 1` against the raw table will return rows the consumer cannot see, and the resulting status will contradict what the consumer is actually looking at. Identify the canonical view-builder (`build_unified_timeline()`, `render_*()`, the materialized SQL view) and feed the derivation off its output. The trap is most acute when the dedup/filter is content-based (identical-text dedup, near-duplicate suppression) — DB last-row stops being view last-row even though both sort by the same key. Real incident: after-sales `render_review.py` phase 5 derived `issues.follow_up_state` from `emails ORDER BY date_iso DESC LIMIT 1` while phase 4 had already deduped repetitive ack texts ("okay, thank you") out of the rendered timeline — the derived state pointed at the dropped customer ack while the rendered view showed our reply as the last item, so the follow-up flag and the visible thread disagreed (after-sales 2026-05-04).
- **Boot-time external probes must be warn-and-fallback, never fail-fast or silent overwrite** — When startup auto-detects external state (latest model id, account capability, license tier, downstream version) to populate a config knob, the probe MUST treat its own failure as a warning + fallback to a hardcoded default, AND MUST NOT overwrite a value the user explicitly pinned. `catalog visible ≠ account runnable`: a model that lists in `--debug models` but is not entitled to your account, an account-capability flag that the SaaS lazy-evaluates only on first call, a downstream service that throttles probe traffic — all return shapes that will look "successful" to a naive probe and produce a config that crashes on the next real run. Three invariants every boot probe owes its caller: (a) probe failure → log a single warn line and use the documented fallback; never `exit 1`; (b) explicit user config (env var, `--model X` CLI flag, persisted setting) is not eligible for overwrite — the probe only fills the field when no explicit pin exists; (c) the probe's chosen value is logged once at boot so a stale autodetect can be diagnosed without reading source. Real incident: supermatrix-root `defaultModelResolver` + `codexDefaultModelCheck` initially treated `codex debug models` as authoritative; the catalog included entries the running account could not actually invoke, and an early draft would have failed startup or silently overwritten the user's pinned model. Final shape: best-effort detect → warn-and-fallback to hardcoded default → never touch an explicit user pin (commits `4766479` 2026-05-04).
- **Evidence collection cannot be deferred — first-hand capture happens at the signal, not the next morning** — When an investigation/judgment process has a "radar" signal (cross_session_log entry, alert, hint trigger) and an "evidence" signal (the actual session reply, log content, screenshot, DB row), the radar MUST trigger immediate first-hand evidence capture (spawn the involved sessions, snapshot logs, read the live DB) — batching radar hits into a "next cycle" review window means the evidence is gone or rewritten by the time you look. `cross_session_log` is the radar, not the evidence; an overnight queue of radar hits decays into untestable speculation. Build the investigation flow so a radar trigger fires the evidence-collection spawn synchronously (or within minutes, not hours), even if the judgment writeup happens later. Real incidents: socail-king judgments `judg-2026-04-29-001` / `-04-30-001` / `-05-01-003` / `-05-03-001` / `-05-04-001` — five consecutive same-class incidents where the trigger fired, evidence collection was deferred to a daily review, and by the time the reviewer pulled the involved sessions the message_runs / Feishu transcripts had rolled or the sessions had moved on; the rule and the supporting jsonl were captured in `judgments.jsonl` and the `rules/judgment-thresholds.md` cutover (socail-king 2026-04-29 → 2026-05-04). Generalises to any debug / incident-review / cross-session-arbitration workflow: the moment the radar lights up, the evidence call goes out.
- **Three-tier automation (cheap → deep → cheap-fix) keeps cost and reliability balanced** — When an automation pipeline has both a "judgment" step (does anything need attention?) and an "act" step (apply the fix), splitting the model/cost tier across three rungs beats either "always cheap" (false-negatives leak) or "always deep" (cost blows up): (a) **cheap pre-screen** — Haiku-class model classifies whether a deeper look is needed, runs every cycle; (b) **deep judge** — Opus-class model runs only on items the pre-screen flagged, produces the verdict + rationale; (c) **cheap auto-remediate** — Haiku-class model executes only the **scoped, reversible** subset of fixes the deep step authorized (e.g. add a `.gitignore` line, never edit source). The discipline is to keep the auto-remediate scope narrow enough that a wrong call costs only a `git revert` — anything ambiguous escalates to a human spawn, not a deeper auto-fix. Real incident: watchdog `daily-commit` runs Haiku triage → Opus review → Haiku-only `.gitignore` self-heal; the cheap pre-screen drops 80%+ of repos before they hit Opus, and the cheap fix tier auto-resolves the most common Opus complaint (untracked artifact noise) without re-spawning the expensive judge. Apply when: cost differs by 5×+ between tiers AND the cheap tier has a usable signal AND the auto-act subset is narrowly bounded (watchdog 2026-05-04).
- **Skill = atomic capability; cross-capability composition goes through spawn, not skill widening** — A skill (or library, or wrapped CLI) owns one IO surface and stops there; the moment a skill's docs grow a "see also" pointer to a different session's files or a different skill's internals, the skill is being stretched past its boundary. The right move is to keep the skill atomic and let the *caller* compose it with another session via `/api/spawn`, not to have skill A bake a hardcoded path to skill B's internals. Concrete failure mode: skill A's docs reference `<WORKSPACE_ROOT>/<other-session>/scripts/foo.py` as a follow-on step — the moment session B renames or relocates, A's reference is silent dead text and there is no contract to hold B to. Pin at design time: each skill's SKILL.md describes only its own IO; "if you also need X, spawn the X session and ask" replaces the hardcoded path. Real incident: skill-master 2026-05 noted `skills/nas-sucai/SKILL.md` had a "See Also: Material Index" tail listing absolute paths into the `nas` session's repo; the right shape is "for index/business queries, spawn the `nas` session" — same content, but routed through a stable API instead of a fragile filesystem assumption.
- **Treat live-table schema changes as ALTER, never delete-then-recreate** — When syncing a typed external table (Feishu Bitable, Notion DB, Airtable schema, BigQuery view) and the field type or shape needs to evolve, every change MUST be expressed as an in-place mutation (`+field-update`, `ALTER COLUMN`) — not "drop the field then add it again." Recreate destroys all existing cell data, all formula references, all view filters that pointed at that field, and any downstream cache keyed on field-id; the visible symptom is "the table looks empty / the view filter is dead / the formula shows #REF" *after* a successful sync run, with no error in logs because the destructive step succeeded. Even when the framework-level helper offers a "recreate" path as syntactic sugar, the calling code must check whether the field already exists and prefer the update path; recreate is only acceptable on a brand-new field. Real incident: qc-master `1dd4cbc fix: avoid destructive review tag field recreation` — review-tag multi-select sync initially recreated the field on schema change, wiping all existing tag assignments on the row; fix was to detect existing field id and route through `+field-update` instead (qc-master 2026-05-04).

## Git Workflow

SuperMatrix workspaces are local git repos with no remote — no PR workflow needed.

- **Default to working on the main branch** — Unless a task explicitly requires isolation (e.g., large-scale refactoring), commit directly on main
- **If you used a feature branch, merge it back to main when done** — Do not ask the user whether to merge/PR/keep/discard. Just merge. This is a local repo with no review process
- **Do not push to remote** — Workspaces have no remote. No push needed
- **Keep commits small and focused** — Each commit does one thing. The message explains why
- **Use the session name as git user.name for commits** — Whichever session made the commit uses its own session name, making it easy to trace who produced the change
- **Tag the backend source in commits** — Use `Co-Authored-By` to indicate which backend produced the code, for traceability. Claude uses `Co-Authored-By: Claude <noreply@anthropic.com>`, Codex uses `Co-Authored-By: Codex <noreply@openai.com>`

## Document Review Flow

After producing specs, plans, or other documents that need review, **you must send them to the user via Feishu** — do not just say "it's been written." The user will not proactively dig through files.

```bash
CHAT_ID=$(sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT b.group_id FROM bindings b JOIN sessions s ON b.session_id=s.id WHERE s.name='$SM_SESSION_NAME' LIMIT 1;")
cd {document directory} && lark-cli im +messages-send --as bot --chat-id "$CHAT_ID" --file "./{filename}"
```

Notes:
- `--file` only accepts relative paths — `cd` to the file's directory first.
- Resolve `CHAT_ID` via `$SM_SESSION_NAME` (framework-injected env var), **not a hard-coded session name**. See console-principles' Session identity resolution rule — workdir may be shared between sessions, so hard-coding the name sends to the wrong group.

## CLAUDE.md and AGENTS.md Synchronization

Each workspace maintains both `CLAUDE.md` (for the Claude backend) and `AGENTS.md` (for the Codex backend), because a single workspace may switch between or simultaneously run both backends.

- **When updating one, check the other** — When you modify per-session content in CLAUDE.md, check whether AGENTS.md needs a corresponding update, and vice versa
- **Content must align; formatting may differ** — The intent and information in both files should be consistent, but the writing style may adapt to each backend's conventions
- **Keep the base template section identical** — The header with document guidance and cross-session collaboration comes from the same template set and must not diverge

## Design Pattern Library

A continuously growing collection of validated design patterns. Each pattern documents: when to use it, how to use it, and why it works.

### Symlink Sync Pattern

- **When** — Multiple directories on the same machine need to share the latest content of a single file
- **How** — Maintain the source file in one place only. Create symlinks at all other locations pointing to the source
- **Why it works** — Zero sync cost. Editing the source takes effect everywhere instantly. No push mechanism, no hash comparison, no event triggers needed
- **Preconditions** — All consumers are on the same machine; file content does not require per-consumer customization
- **Real-world usage** — Principles documents are injected from first-principle/templates/ into each workspace via symlinks

### User Identity Simulation Testing Pattern

- **When** — You need to test message processing pipelines (e.g., Feishu message routing, session response flow) without manual operation
- **How** — Send Feishu messages using `--as user` identity to simulate real user input and trigger the full processing chain
- **Why it works** — Covers the real chain with no mocks, catching integration issues. Closer to production behavior than unit tests
- **Preconditions** — Testing and debugging scenarios only. In non-test scenarios, always use bot identity to avoid confusion with real user messages
- **Real-world usage** — When testing SuperMatrix message dispatch, use `lark-cli im +messages-send --as user` to send messages to the target group and verify end-to-end flow

### Async Fire-and-Forget Event Pattern

- **When** — System state changes need to notify multiple observers (logging, metrics, notifications) without blocking the main flow
- **How** — `publish()` enqueues the event and returns immediately. Drain runs asynchronously in a background macrotask. Handler exceptions are caught and isolated
- **Why it works** — The caller (e.g., dispatcher processing a user prompt) is never affected by handler latency or errors. Event delivery overhead approaches zero
- **Preconditions** — Handlers perform side-channel operations only (logging, notifications) and do not modify shared state. For coordination or state changes, use explicit service calls instead of events
- **The persistence test** — Before applying fire-and-forget anywhere (EventBus handler, CLI tail call, request hook, response post-write), ask: does this async write to durable state (DB, file, external API, Feishu record, mapping table)? If yes, it is **not** fire-and-forget — you must `await` it before tearing down any resource it depends on (DB connection, file handle, process exit). The failure mode is silent partial success: the visible side effect lands, the bookkeeping side effect is dropped, and the next run sees an inconsistent world (typical symptom: duplicate records, orphan rows, "row exists in A but not B")
- **Real-world usage** — SuperMatrix EventBus's `InMemoryEventBus.publish()` uses `void this.drain()` to implement fire-and-forget; watchdog's `bitable.syncIssue().catch(()=>{})` before `db.close()` was a violation that produced duplicate Bitable records (fixed in `f07699d`)

### Local HTTP API Coordination Pattern

- **When** — Multiple independent processes (agent sessions, scheduler, external scripts) need to coordinate, but the network messaging channel (Feishu) is not appropriate
- **How** — The host process (SuperMatrix) exposes a JSON API via Node `http.createServer` on `127.0.0.1`. Callers use `curl` or `fetch` to send requests and receive synchronous responses
- **Why it works** — Zero network latency, no authentication needed (localhost only), clean synchronous request-response semantics. Agents can `curl` directly from bash without SDK or special tooling
- **Preconditions** — All participants are on the same machine; structured request-response is needed (not one-way notifications)
- **Not for** — Pure notification scenarios (use EventBus); human-agent interaction scenarios (use Feishu messages)
- **Real-world usage** — SuperMatrix exposes `/api/spawn` on `localhost:3501`. Session agents call it via curl for cross-session task delegation

### Child Session Isolation Pattern

- **When** — Session A needs to perform a task in Session B's repo without interrupting B's ongoing conversation
- **How** — Spawn a child session (scope: child) that uses B's workdir but has an independent backend conversation. After execution, the result returns to A, and B is completely unaffected
- **Why it works** — Child session shares the filesystem with the parent but isolates conversation context. No need to inject messages into the target session's conversation flow, avoiding the complexity of "idle does not mean free"
- **Safeguards** — Maximum nesting depth (prevents infinite loops), maximum concurrency (prevents resource exhaustion), idle timeout with auto-cleanup (prevents zombie sessions)
- **Real-world usage** — `childSession.spawnChild()` creates a child session with a declared `type` (four spawn-time presets) and at least one `resultSinks` entry; for continuing a multi-turn side-conversation, use `type: 'ephemeral_conversation'` (replaces the old `keepAlive=true` flag). For framework-level spawn semantics and the child types see the "Child Sessions" section in `console-principles.md`.

### Inheritance with Explicit Override Pattern

- **When** — A derived entity (child session, sub-process, cloned config) inherits attributes from its parent, but some call sites need to deviate
- **How** — Default to inheriting the parent's value; expose an explicit override parameter in every entry point (CLI flag, HTTP field, SDK option). Omitting the parameter preserves old behavior for backwards compatibility
- **Why it works** — Inheritance keeps the common case zero-config; explicit override unblocks the long tail of deviation cases (e.g. a codex session spawning a claude child for reasoning-heavy work) without forcing every caller to restate defaults
- **Preconditions** — The inheritable attribute must be well-defined on the parent, and the override must be a value the derived entity can legally take on its own
- **Avoid** — Silent divergence (changing a default without versioning), or adding override parameters that can be set but have no effect (dead knob)
- **Real-world usage** — `/spawn --backend claude|codex` and the HTTP spawn API's optional `backend` field both override the parent's backend when set; unset means "inherit parent"

### SQLite Database Placement Convention

- **When** — A session needs SQLite databases for data persistence
- **Two types of databases, two placement strategies:**

| Type | Path | Description |
|------|------|-------------|
| Cross-session shared | `$SM_RUNTIME_ROOT/data/{name}.db` | Data that multiple sessions need to read and write. E.g., `supermatrix.db` (session/binding core metadata) |
| Session-private | `{workspace}/data/{name}.db` | Data used only by this session. Placed in the session's own workspace, managed with the session lifecycle |

- **Naming** — Database filenames should clearly express their purpose, using lowercase with hyphens (e.g., `task-queue.db`, `cache.db`)
- **Why the distinction** — Cross-session databases go in the unified Runtime directory so sessions don't need to know each other's workspace paths. Private databases go in the workspace so they can be cleaned up when the session is deleted
- **Caveat** — SQLite has limitations under high-concurrency writes (single-writer lock). For frequently written cross-session databases, configure WAL mode and implement retry strategies

### Runtime Timeout Layered Design

- **When** — Designing watchdogs, heartbeat detection, process guardians, or anything that needs timeout mechanisms
- **How** — Provide three layers simultaneously: (1) reasonable global defaults covering normal scenarios (e.g., inactivity 15 min, max runtime 60 min); (2) per-session overridable parameters allowing specific tasks to adjust (e.g., crawler tasks set to 18 hours); (3) layered protection — inactivity timeout and max runtime are two independent dimensions, never collapsed into a single timeout value
- **Why it works** — Defaults protect the majority of scenarios from zombie processes; parameter overrides protect special scenarios from false kills. Both are essential: defaults alone will kill legitimate long-running tasks; manual-only configuration leaves new sessions unprotected
- **Preconditions** — Any design involving process lifecycle management, task scheduling, or background job timeout
- **Real-world usage** — SuperMatrix backend watchdog's inactivity timeout + max runtime dual-dimension protection

### Tiered Fallback Pattern

- **When** — A delivery has multiple potential failure modes (rich payload too large, primary channel rejecting, downstream filter triggering) and you need the message to land in *some* form rather than disappear
- **How** — Order the fallbacks from "lose the least" to "lose the most" and try them in that order. Within the rich-payload channel: first reduce payload (drop optional fields, strip styling, collapse to plain summary) and re-attempt the same channel. Only after the in-channel degradations exhaust do you switch to a coarser channel (rich card → plain text; structured push → log line). Every degradation step records what was dropped and why, so the loss is visible
- **Why it works** — Most "primary failed" cases are payload-shape problems (one field too long, one styling token rejected) rather than channel-wide outages. Jumping straight to the coarse channel discards information that the primary could still have carried after a small fix. Tiered fallback keeps the most semantically rich delivery the receiver can still accept
- **Anti-pattern** — `try { send_card(payload) } catch { send_text(plain) }`. The card might have failed because of one field; sending plain text loses everything else and leaves the card forever stuck in `running` state because the channel-of-record was never updated
- **Real-world usage** — `replier.finalizeCard` first strips `processLog` and re-PATCHes the card, only falling back to text after the second card attempt also fails (supermatrix-root 2026-04-22, fixes the "card stuck running" symptom)

### Feishu Bitable Sync Strategy

- **When** — Local data (SQLite, JSON, etc.) needs to be synced to a Feishu Bitable
- **Three modes, chosen by data scale and scenario:**

| Mode | Use Case | Approach |
|------|----------|----------|
| **Full Rewrite** | Few records (<100), no need to preserve record_id, no manual edits in the table | Delete all records → `record-batch-create` to rebuild |
| **Upsert (Recommended)** | Natural unique key exists (e.g., session name, table name), record_id stability needed | Use `record-upsert` with the unique key per record; clean orphans via search + delete |
| **Search + Diff** | Large datasets, fine-grained change control needed | `record-search` to fetch existing records → diff against local → create/update/delete separately |

- **Selection criteria:**
  - Full rewrite is simplest, but has costs: the table is briefly empty during deletion, record_id changes every time (breaks cross-table references), and deletion is per-record API calls (O(n))
  - When record count exceeds ~100, or Feishu-side manual edits must be preserved, or other tables reference this table by record_id, use upsert mode
  - `record-upsert` requires specifying one field as the upsert key; that field's values must be unique within the table

- **Full rewrite is only safe on read-only push-only mirrors.** Match the rewrite mode against the table's declared sync direction (see business-principles.md → "Feishu Bitable Sync Direction"). Full rewrite is acceptable **only** when the table is `本地权威 (push-only)` AND no human edits the table on Feishu. As soon as the table flips to mixed per-column or pull-only, full rewrite destroys human-edited fields silently. Real incident: knowledge sessions (mythos, business-knowledge, wytest, codingmaster) initially mirrored their `Queries` log table via delete+rebatch — fine for the read-only log case, but the same pattern applied to a session-meta table with human-curated `Purpose`/`别称` would clobber edits. The classification boundary lives in business-principles, not in code: before picking the mode, look up the table's column-level sync direction.
- **Do not cache record_id locally** — record_id is generated by Feishu. Caching it locally goes stale when the table is rebuilt or manually edited, creating local-vs-Feishu state drift. Use business fields as upsert keys and let Feishu manage record_id
- **Real-world usage** — `sync-session-table.sh` uses full rewrite (few sessions, no cross-table references); amzdata field sync uses upsert mode (412 records, unique key on table name + field name)

### Human Checkpoint with Reviewable Artifact

- **When** — A long autonomous loop (orchestrator, supervisor, scheduler) needs explicit human approval before entering an expensive or hard-to-revert phase, and you want the approval to be auditable later
- **How** — Write the proposed plan into a structured on-disk artifact (JSON / table / signed doc), expose a CLI or HTTP command that *only* mutates a `<phase>_approved_at` timestamp on that artifact (never both edits and approves in one step), and gate the next phase on the timestamp's presence. The artifact is the single source of truth — the approval command does not re-read intent from arguments
- **Why it works** — Separating "propose" from "approve" keeps the approval atomic and visible. Anyone can `cat` the artifact later and see exactly what was approved and when. If the upstream plan changes, auto-invalidate the timestamp on structural mutation so a stale approval cannot leak through
- **Preconditions** — The phase being gated has high blast radius (model dispatch, financial commit, irreversible delete) and a small fixed number of decision points; cheap inner steps should not be gated
- **Real-world usage** — `yolo` supervisor: `yolo-allocation-render` produces the dispatch plan, `yolo-allocation-apply` writes user override syntax, `set-default-tier` / `clear-allocation-approval` mutate timestamps, the §0.6 main loop refuses to advance without `allocation_approved_at` set; structural plan edits auto-clear the timestamp (commit `5933179`, 2026-04-23)

### Deterministic-First with LLM Fallback

- **When** — A judgment step is "almost always trivial, occasionally subtle" — most cases match a clear rule but a long tail needs semantic reasoning
- **How** — Run the cheap deterministic check first (regex, keyword whitelist, schema validate, allow/deny list). On a clear hit, accept and exit. Only on ambiguous misses fall through to an LLM judge with a tight prompt. Record which path decided so you can audit drift later
- **Why it works** — LLM calls are expensive, slow, and non-deterministic — running them on the 95% trivial cases burns budget and adds variance for no gain. Running deterministic-only loses the long tail. Two-stage keeps the cost concentrated on actual ambiguity. Treat the deterministic layer as the source of truth and the LLM as a tiebreaker, never the reverse
- **Preconditions** — The deterministic rule must be conservative (false-positives accepted into the LLM stage are fine; false-positives passed straight through skip the safety check). Log both layers' votes for at least the first N decisions to confirm the deterministic layer is calibrated
- **Anti-pattern** — "LLM first, regex fallback when LLM is down" — inverts the cost model and degrades quality on the easy cases
- **Real-world usage** — `yolo-clarify-judge` (commit `4c42cdd`, 2026-04-23): keyword-whitelist confirmation gate first, LLM semantic check only when the user reply is neither obvious yes nor obvious no

### Self-Serve Legacy Cleanup

- **When** — A cleanup / deprecation phase reveals the remaining legacy set is already sparse (zero to low single digits of *enabled* items) by cutover time, owners are reachable and still present, and the migration is not irreversible
- **How** — Instead of building migration machinery (proposal flow, T+N upgrade ladder, per-owner pacing, reconciliation state), publish a short self-serve doc that walks owners through the new entry points, and surface it on the owner's necessary trigger path: API error bodies carrying a `hint` field referencing the doc, CLI `--help` marking deprecated flags with a doc pointer, log warnings on deprecated call sites. Leave the old code as bottom fallback — don't force-migrate, don't chase owners
- **Why it works** — Migration machinery carries fixed maintenance cost (code, tests, DB tables, per-owner bookkeeping) that only amortizes when the legacy set is large. For sparse sets, doc + error-path hint lets each owner rebuild themselves in minutes without the system owner paying ongoing maintenance. Owners hit the hint at the exact moment they need it — strictly better than a passive README and less noisy than broadcasting a proposal to every owner proactively
- **Preconditions** — Inventory-first check: **measure the actual enabled-legacy count at the moment you're about to commit to the mechanism**, not when planning started. If the count is large, owners are offline/unknown, or the cutover is irreversible, build the machinery instead
- **Anti-pattern** — Designing a migration system against an *estimated* inventory at plan-writing time, then shipping it without re-measuring at cutover. The machinery lands against a near-empty set and becomes pure maintenance debt. Re-measure inventory is the first and cheapest guard against over-engineering here. Equally anti-pattern: burying the deprecation notice in a README the owners never open, or actively broadcasting to every owner (noise floods, the signal dies)
- **Real-world usage** — scheduler 2026-04-25 arch upgrade: 28 legacy tasks planned for the migration ladder ended at enabled-count 0 by cutover, so the planned 12-file + 11-test + 3-table migration system was replaced with `docs/migrating-from-legacy.md` + a `hint` field on the POST /tasks 400 response pointing to the doc when `class` / `expectedDurationMs` / `ownerSession` are missing. Old `src/migration` module left untouched as bottom fallback
