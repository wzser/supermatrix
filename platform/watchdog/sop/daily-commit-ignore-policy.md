# Daily Commit Ignore Policy

## problem

Daily commit touches many repos, so ignore decisions must be explicit rather
than left to each reviewer prompt. This policy defines which ignore decisions
watchdog may automate, which ones belong to the repo owner, and which files must
never be hidden by `.gitignore`.

## inputs

Use these inputs before deciding whether to commit, skip, or auto-remediate a
dirty repo:

1. The changed-file list:

   ```bash
   git -C <repo> status --short
   ```

2. The diff summary shown to the daily-commit reviewer:

   ```bash
   git -C <repo> diff --stat
   git -C <repo> diff --cached --stat
   git -C <repo> ls-files --others --exclude-standard
   ```

3. The full diff for any candidate source/config/doc file:

   ```bash
   git -C <repo> diff -- <path>
   git -C <repo> diff --cached -- <path>
   ```

4. The target repo's existing `.gitignore`, if present.

5. The owner session's stated deliverable conventions when the changed path is
   a business output, generated capture, export, media file, or evidence file.

## processing

### 1. Ownership

`watchdog owns` the global daily-commit ignore policy:

- the allowlist of low-risk noise classes;
- the denylist of files that must never be hidden automatically;
- the `auto-remediate` prompt and safety limits;
- skip classification and owner-notification wording;
- the tests that prove daily-commit reviewer prompts reference this policy.

`owner handoff is a last resort`: watchdog should resolve about 90% of
daily-commit skips itself through one of these watchdog-owned outcomes:

- `deferred`: inactive/stale repos are recorded and reported without waking the
  repo owner;
- `auto-remediated`: narrow allowlisted machine noise is fixed with `.gitignore`
  and re-screened;
- `committed`: readable, one-logical-unit low-risk changes are reviewed and
  committed;
- `issue filed`: process failures, Codex timeouts, reviewer stalls, and
  wall-clock budget skips stay with watchdog.

`repo owner owns` repo-local ignore decisions:

- business outputs and evidence;
- generated reports or exports;
- screenshots, media, and capture artifacts;
- data directories whose files might be either throwaway cache or user-facing
  deliverables;
- repo-specific tool outputs not already covered by watchdog's allowlist.

Repo owner handoff happens only after watchdog rules out safe self-resolution.

`first-principle` owns identity-document governance. Large or novel
`CLAUDE.md` / `AGENTS.md` changes are not ignore-policy decisions.

`scheduler` owns the daily trigger and lifecycle only. It does not own dirty
working-tree content decisions.

### 2. allowlist for watchdog auto-remediate

watchdog may add `.gitignore` entries only when all conditions are true:

1. The dirty files are clearly low-risk machine noise.
2. The proposed ignore entry is narrow enough to cover the observed files
   without hiding future source, config, data deliverables, or evidence.
3. The dirty set remains one logical change after the `.gitignore` edit.
4. A second reviewer pass approves the resulting dirty set.

Allowed low-risk classes:

```text
node_modules/
dist/
build/
.next/
.turbo/
.cache/
coverage/
__pycache__/
*.pyc
.pytest_cache/
.mypy_cache/
.ruff_cache/
.DS_Store
*.log
tmp/
temp/
```

Path-specific allowlist entries are preferred over broad globs. For example,
`runs/tmp/` is better than `runs/` when only temporary scratch files are noisy.

### 3. denylist and never auto-ignore

Never auto-ignore or auto-commit:

```text
secrets
tokens
credential-adjacent config
.env
.env.*
private customer data
raw business exports
*.db
*.sqlite
*.sqlite3
*.db-wal
*.db-shm
archives
large binaries
media deliverables
files the reviewer cannot read
```

Never use `.gitignore` to hide:

- merge-conflict markers;
- branch-divergence symptoms;
- unrelated mixed changes;
- unclear ownership;
- Feishu routing, scheduler, framework routing, spawn, issue queue, or
  notification behavior changes without executable verification.

### 4. owner-routed paths

These paths are `owner-routed` by default:

```text
artifacts/
outputs/
data/
exports/
screenshots/
captures/
reports/
media/
```

In one repo these may be disposable runtime products; in another they may be the
actual deliverable. Owner-routed is not automatic handoff. Daily commit must
first prefer watchdog-owned outcomes:

1. defer quiet/stale repos without waking the repo owner;
2. auto-remediate clearly disposable allowlisted noise;
3. safe-commit readable one-logical-unit changes that do not contain private
   data, secrets, raw exports, databases, archives, or shared-platform behavior;
4. file a watchdog-owned issue for process failures, Codex timeouts, reviewer
   stalls, and wall-clock budget skips.

Notify the repo owner only when domain judgment is genuinely required:

1. unclear deliverable semantics;
2. private/customer data or credential risk;
3. unreadable binaries/databases;
4. mixed changes that need repo-local split judgment;
5. a repo-local ignore rule that cannot be proven narrow from the diff.

If an owner-routed path is transferred, notify the repo owner with:

1. the changed path;
2. why watchdog could not self-resolve it safely;
3. the expected owner action: add a repo-local `.gitignore`, split a safe
   commit, or leave the file intentionally tracked.

### 5. Enforcement

Daily commit enforces this policy in three places:

1. First-pass reviewer prompt: decide YES / UNSURE / CONFLICT using this policy.
2. Deep-review prompt: decide YES / NO using this policy.
3. `auto-remediate` prompt: add `.gitignore` entries only for allowlisted noise,
   then re-screen before committing.

The skip-handling SOP must reference this policy before manually committing any
previously skipped repo. Tests must fail when `daily-commit.ts` stops referencing
the canonical policy prompt.

## outputs

Every ignore-related daily-commit result must end in one of these states:

1. `committed`: the dirty set was approved and committed as one logical change.
2. `auto-remediated`: watchdog added narrow `.gitignore` entries, re-screened,
   and committed the result.
3. `owner-routed`: the repo owner was notified to decide the local ignore rule.
4. `fp-routed`: identity-document ownership was routed to first-principle.
5. `left uncommitted intentionally`: the reason is recorded in the skip result
   or follow-up issue.
6. `watchdog-owned`: process/tooling failure remains with watchdog instead of
   waking the repo owner, and is reported separately from content `skipped`.

## downstream consumer

The downstream consumers are:

1. daily-commit reviewer prompts, which need the policy embedded in every safety
   decision;
2. repo owner sessions, which need to know when `.gitignore` is their job;
3. first-principle, which owns identity-document exceptions;
4. watchdog maintainers, who must update this policy whenever a repeated
   ignored-file class appears or an auto-remediate decision is corrected.
