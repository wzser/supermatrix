# Daily Commit Skip Handling SOP

## problem

This SOP defines what to do when `watchdog-daily-commit` reports skipped repos.

Daily commit is allowed to commit only changes that were reviewed against enough
evidence to classify them as safe. A skipped repo means one of three things:

1. The repo was not reviewed before the loop hit the `time budget`.
2. The repo was reviewed and the content risk was too high for automatic commit.
3. The Feishu-authoritative `Daily Commit` control field could not be read.

Do not treat both cases the same. "Not reviewed" is a process gap. "Reviewed and
unsafe" is a content-control decision.

## inputs

Use these inputs in this order:

1. Console notification from `watchdog-daily-commit`.
2. Ignore ownership policy:

   ```bash
   sed -n '1,220p' <SM_WORKSPACE_ROOT>/watchdog/sop/daily-commit-ignore-policy.md
   ```

3. Local append-only log:

   ```bash
   cd <SM_WORKSPACE_ROOT>/watchdog
   tail -1 data/daily-commits.log
   ```

4. Scheduler run state:

   ```bash
   curl -s 'http://localhost:3500/tasks/185ddf95-3f0e-4b7b-9d11-77028c5d8793/runs?limit=1'
   ```

5. Target repo status:

   ```bash
   git -C <repo> status --short
   git -C <repo> diff --stat
   git -C <repo> diff --check
   ```

6. Feishu session table control state:

   ```bash
   lark-cli base +record-list \
     --base-token "$WATCHDOG_SESSION_BASE_TOKEN" \
     --table-id "$WATCHDOG_SESSION_TABLE_ID" \
     --limit 500 \
     --field-id Session \
     --field-id "Daily Commit" \
     --format json
   ```

7. Full diff for any file that the daily reviewer did not see because of
   truncation:

   ```bash
   git -C <repo> diff -- <path>
   git -C <repo> diff --cached -- <path>
   ```

## processing

### 1. Classify the skipped reason

Read `skipped_reason` exactly.

If it contains:

```text
skipped: daily-commit time budget (18min) exceeded
```

then classify it as `not_reviewed_time_budget`.

If it contains:

```text
daily-commit control fetch failed
```

then classify it as `control_plane_failure`.

If it contains any of these patterns, classify it as `reviewed_content_risk`:

```text
diff was truncated
cannot confirm absence of secrets
runtime artifacts
__pycache__
.db-wal
.db-shm
.DS_Store
conflict detected
unsafe to bulk-commit
manual inspect
permission denied
provided diff was empty
```

If it contains:

```text
processing error:
```

then classify it as `reviewer_or_tool_failure` and inspect the error text.

Independently of the skipped reason, inspect identity-document changes before
deciding whether a direct commit is allowed:

```bash
git -C <repo> diff --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> diff --cached --numstat -- ':(top)CLAUDE.md' ':(top)AGENTS.md'
git -C <repo> status --short -- ':(top)*.md'
```

Classify the dirty set as `identity_doc_major_change` when either condition is
true:

1. `CLAUDE.md` / `AGENTS.md` has `>= 30` changed lines in total, counted as
   additions plus deletions from `git diff --numstat` / `git diff --cached
   --numstat`, excluding context lines.
2. Any new top-level `.md` file appears in `git status --short`.

Exception: if the candidate commit message is already supplied by an
FP-orchestrated rollout and starts with:

```text
identity: FP <rollout-name>
```

then treat the identity-doc change as pre-reviewed by first-principle and allow
the normal daily-commit path regardless of line count. Do not invent this prefix
locally to bypass `identity_doc_major_change`; it must come from the FP rollout
handoff or the daily-commit candidate message.

### 2. Handle `not_reviewed_time_budget`

This reason means the repo was skipped because the daily-commit loop ran out of
wall-clock time. It does not mean the content was unsafe.

For each affected repo:

1. Inspect current status:

   ```bash
   git -C <repo> status --short
   git -C <repo> diff --stat
   ```

2. If the dirty set is only a small synchronized documentation change such as
   `AGENTS.md` / `CLAUDE.md`, first apply the identity-document classification
   from step 1:

   - T1 routine edit: `< 30` changed lines, no new top-level `.md`, clearly
     session-specific, and no FP category-template rule is being rewritten. Run
     `git diff --check` and commit it directly.
   - FP-orchestrated rollout: candidate commit message starts with
     `identity: FP <rollout-name>`. Run `git diff --check` and commit it
     directly, regardless of changed line count.
   - `identity_doc_major_change`: do not commit it directly. Route it to
     `first-principle` using the template in step 2A.

3. If the dirty set contains source code, scripts, Feishu operations, scheduler
   config, credentials-adjacent files, data files, or more than one logical
   change, split it before committing.

4. If the repo is clean by the time you inspect it, record that no action is
   needed.

5. If any repo is skipped by time budget, inspect the reviewer dependency before
   closing the incident:

   ```bash
   codex --version
   codex exec --model "${WATCHDOG_DAILY_COMMIT_CODEX_MODEL:-gpt-5.4}" \
     --sandbox read-only \
     'Reply with exactly OK'
   ```

6. If Codex is rate-limited or stalled, retry the skipped set instead of
   accepting the skip as final. The retry must be bounded:

   - wait until the rate-limit reset time if the CLI reports one;
   - retry only the repos that were skipped by time budget;
   - keep a per-repo timeout and an overall retry-loop budget;
   - preserve the original skipped record in `daily-commits.log`;
   - write a second result record or issue note for the retry outcome.

7. Do not simply increase the scheduler task timeout. The 18 minute loop budget
   exists so the script still reaches log, notification, Bitable sync, and reload
   before scheduler hard-kill.

8. For repeated time-budget incidents, file a watchdog issue. Acceptable
   remediation options are:

   - resume skipped repos in a second bounded retry pass;
   - reduce per-repo reviewer timeout;
   - switch to a smaller approved Codex model for the first-pass reviewer;
   - batch or parallelize reviewer calls with a small concurrency cap;
   - pre-commit trivial synchronized doc-only changes before invoking LLM review.

Any remediation must preserve the red line: skipped repos are reported, never
silently swallowed.

### 2A. Route `identity_doc_major_change`

This classification means the change may be T2 large self-evolution, T3 baseline
drift, or T4 new identity file. Daily-commit does not own that judgment.

Do not leave the repo skipped with no owner. Spawn `first-principle` and make the
ownership decision explicit:

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{
    "target":"first-principle",
    "from":"watchdog",
    "prompt":"[verification: comm_identity_doc_major_<yyyymmddHHMMss>] Daily-commit found identity_doc_major_change in <repo>. Read <SM_WORKSPACE_ROOT>/first-principle/templates/console-principles.md section \"Session Identity Document Change Discipline\", then inspect <repo> identity-doc diff. Acceptance: decide whether this is T2 session-owned self-evolution, T3 baseline-template change request, T4 forbidden new identity doc, or FP-orchestrated rollout; either commit with the correct identity prefix or tell watchdog the exact safe next action. Watchdog must not auto-commit this dirty set without your decision.",
    "verification_predicate":{
      "type":"inbox-message",
      "session_name":"first-principle",
      "field":"prompt",
      "contains_all":["comm_identity_doc_major_<yyyymmddHHMMss>"],
      "expected_window_sec":600
    }
  }'
```

If FP confirms the change is an FP-orchestrated rollout, the commit message must
start with `identity: FP <rollout-name>`. If FP confirms it is T2
session-owned self-evolution, the owning session commits it with an `identity:`
prefix. If FP identifies T3/T4, follow FP's template-change or relocation
instructions instead of committing from daily-commit.

Time-budget handling remains separate: still inspect the reviewer dependency and
use the bounded retry/degradation path from step 2. `identity_doc_major_change`
only changes who owns the dirty identity-doc diff; it does not turn a
time-budget skip into a silent manual skip.

### 3. Handle `reviewed_content_risk`

This reason means the reviewer saw enough evidence to decide automatic commit is
not safe, or did not see enough evidence to safely approve the change.

Do not commit the whole working tree.

Use this checklist:

1. Identify the risky files named in `skipped_reason`.
2. Inspect the full diff for those files.
3. Separate safe low-risk changes from risky changes.
4. Commit safe changes only when they stand alone.
5. Spawn a watchdog child session to handle the risk review and follow-up work.

Use the local coordination API:

```bash
curl -s -X POST http://localhost:3501/api/spawn \
  -H "Content-Type: application/json" \
  -d '{
    "target":"watchdog",
    "from":"watchdog",
    "prompt":"[verification: comm_daily_commit_skip_<yyyymmddHHMMss>] Review daily-commit skipped repo <repo>. Reason: <skipped_reason>. Inspect full diff, split safe changes from risky changes, commit only reviewed safe changes, and report risky leftovers with acceptance criteria.",
    "verification_predicate":{
      "type":"inbox-message",
      "session_name":"watchdog",
      "field":"prompt",
      "contains_all":["comm_daily_commit_skip_<yyyymmddHHMMss>"],
      "expected_window_sec":600
    }
  }'
```

Do not use ATP for this content-risk review. ATP is for real user-environment
behavior verification after an implementation path is chosen, not for deciding
whether a dirty git working tree is safe to commit.

Common safe split:

```text
AGENTS.md + CLAUDE.md synchronized T1 wording change
FP-orchestrated identity rollout with commit message prefix "identity: FP ..."
```

Common risky split:

```text
identity_doc_major_change without FP-orchestrated commit prefix
Feishu sender / notification module
scheduler task registration
framework dispatcher or spawn path
database schema or migration
bulk generated data
runtime logs
credential-bearing config
binary or compressed artifacts
```

For Feishu routing, notification, group naming, `/new`, `/backend`, card
rendering, spawn flow, or other real-Feishu behavior, the watchdog child session
must inspect and split the change first. If that child lands code that changes
real Feishu behavior, it may then request the proper downstream verification
path as part of the implementation result.

### 4. Content-risk rules for automatic commit

Apply `<SM_WORKSPACE_ROOT>/watchdog/sop/daily-commit-ignore-policy.md`
first. Ignore decisions are not local taste: watchdog owns the global
allowlist/denylist and auto-remediate limits; the repo owner owns repo-local
`.gitignore` entries for business outputs, captures, exports, screenshots,
media, reports, and data directories.

Automatic commit is allowed only when all of these are true:

1. The reviewer saw the relevant diff, not just a truncated prefix.
2. The change is a single logical unit.
3. No secrets, tokens, private customer data, database WAL/SHM files, caches, or
   runtime artifacts are included.
4. The change does not silently alter shared platform behavior.
5. The commit message describes the actual changed behavior.
6. Required verification is either unnecessary for doc-only changes or has run
   successfully for code changes.
7. `CLAUDE.md` / `AGENTS.md` changes are T1 routine edits, or are explicitly
   FP-orchestrated with commit message prefix `identity: FP <rollout-name>`.
8. Any `.gitignore` change is allowed by the daily-commit ignore policy and is
   narrow enough not to hide source, config, data deliverables, or evidence.

Automatic commit must skip when any of these are true:

1. The diff is truncated before showing the important file.
2. The change touches Feishu, scheduler, framework routing, spawn, issue queue,
   or notification code and no executable verification is available.
3. The repo contains untracked bulk output, generated captures, `.pyc`,
   `.DS_Store`, `*.db-wal`, `*.db-shm`, archives, media outputs, or raw business
   data.
4. The change may include secrets or credential-adjacent config.
5. The working tree mixes unrelated changes that need separate commits.
6. The reviewer cannot read the file content.
7. There are merge-conflict markers or branch-divergence symptoms.
8. `identity_doc_major_change` is detected and no FP-orchestrated commit prefix
   is present; route it to `first-principle` instead.
9. The proposed ignore entry targets an owner-routed path such as `artifacts/`,
   `outputs/`, `data/`, `exports/`, screenshots, media, capture runs, generated
   reports, or business evidence, and watchdog cannot prove a safe self-owned
   outcome.

Owner handoff is a last resort. Before transferring a skipped repo to its owner,
classify the skip:

1. `watchdog-owned`: process errors, Codex timeouts, reviewer stalls, wall-clock
   budget skips, and control-plane failures. File/fix in watchdog; do not wake
   the repo owner, and do not count these as content `skipped` in the Console
   summary.
2. `self-resolvable`: inactive/stale dirty state, narrow allowlisted machine
   noise, or readable one-logical-unit low-risk changes. Defer, auto-remediate,
   or commit with verification.
3. `owner-required`: unclear deliverable semantics, private/customer data,
   credential risk, unreadable binaries/databases, mixed changes needing
   repo-local split judgment, or an ignore rule that cannot be proven narrow
   from the diff. Only this class gets an owner hint.

### 5. Commit procedure after manual review

For a safe manual follow-up commit:

1. Stage only the files for one logical change:

   ```bash
   git -C <repo> add <file1> <file2>
   ```

2. Run the lightest relevant verification:

   ```bash
   git -C <repo> diff --cached --check
   ```

   For code changes, run the repo's actual test command.

3. Commit with the session name as git author when acting as that session:

   ```bash
   git -C <repo> -c user.name=<session-name> -c user.email=<session-name>@local commit -m "<message>"
   ```

4. If the change belongs to another session and requires domain judgment, send a
   handoff instead of committing it yourself.

5. If the daily-commit script itself needs behavior changes, make the change in
   watchdog, verify, commit, and let the next scheduled run prove it.

## outputs

Every skipped repo follow-up must end in one of these outputs:

1. `committed`: a focused commit hash and the verification used.
2. `clean`: no dirty files remain when inspected.
3. `delegated`: owner session was notified with the risky paths and acceptance
   criteria.
4. `issue filed`: watchdog issue exists for a script/process failure.
5. `left uncommitted intentionally`: reason is documented in the user reply or
   queue issue.

For daily-commit process failures, include:

```text
date
task run id
number committed
number skipped
first skipped repo
dominant skipped reason
whether reviewer CLI was healthy
```

## downstream consumer

The downstream consumers are:

1. Repo owner sessions, who need actionable instructions for their skipped
   working trees.
2. The human operator, who needs to know whether skipped means unsafe or merely
   not reviewed.
3. Scheduler, which needs the task to finish with logs and notification instead
   of being hard-killed.
4. Watchdog, which owns the daily-commit script and must improve repeated
   failure patterns without weakening automatic commit safety.

This SOP must be updated whenever a new skipped-reason category appears more
than once or when a correction during handling changes the intended procedure.
