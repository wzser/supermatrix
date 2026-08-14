# Localgit Governance

## Core Rule

localgit drives managed workspaces toward clean worktrees without sacrificing
either side of a disputed change. Behavior-changing work must not remain only
as an uncommitted local worktree change.

The only successful file-state terminals are `committed_current`,
`committed_hold`, and `ignored`. Sensitive or structurally unsafe changes end
as `blocked_sensitive` or `blocked_conflict`; `pending_owner` is intermediate.

This Git history is local and controlled. Privacy alone is not sensitive for
commit purposes: Feishu group IDs/names, local paths, personal data, and
readable customer/business data are eligible to persist. `blocked_sensitive`
means an actual access credential or an unreadable/structurally unsafe file.

## Priority Classes

### must-commit candidates

These changes affect runtime behavior, shared contracts, or future
reproducibility. localgit must review them and either commit them or record a
specific blocking reason.

- framework source code;
- session source code;
- scripts and CLIs;
- tests and fixtures;
- scheduler, spawn, reload, notification, or routing config;
- package and lock files;
- migrations and schemas;
- AGENTS.md and CLAUDE.md;
- SOPs, Principles, templates, and shared docs that define behavior.

### quiet-defer by default

These changes are usually business/runtime artifacts. If they appear without
any source, config, test, or behavior-document change, localgit records them but
does not wake the user or repo owner.

- raw business exports;
- generated reports;
- captures and screenshots;
- run outputs;
- logs and caches;
- SQLite runtime databases;
- media and binary artifacts;
- temporary files.

Quiet-defer means: do not commit, do not notify daily, keep the record queryable
in localgit logs and ledger.

### blocked

These changes require an owner decision or a different owner session.

- merge conflicts or unmerged paths;
- unreadable files;
- possible access credentials (secrets, tokens, private keys, session cookies);
- mixed source plus data changes that cannot be split safely;
- AGENTS.md / CLAUDE.md major rewrites outside a known stub-to-formal path;
- shared framework behavior changes owned by another platform session.

### isolated hold

Disputed but non-sensitive source or contract changes may be committed to
`localgit/hold/<repo>/<fingerprint12>`. The transaction must restore the
original branch and HEAD, and independently verify the hold ref, commit SHA,
and exact committed file set.

Hold is forbidden for access credentials, unreadable files,
databases, large or opaque binaries, pre-staged files, merge/rebase operations,
or unmerged paths. Hold branches are never force-deleted and never auto-merged.
The owner must choose `merge`, `archive`, or `keep_until`; merge is fast-forward
only and requires a clean original branch at the recorded base.

## Notification Rule

localgit should notify only when there is an actionable event:

1. a commit was made;
2. a must-commit candidate was blocked;
3. localgit itself failed and needs follow-up;
4. another owner session must decide a blocked change.

Artifact-only quiet-deferred repos are intentionally not included in daily
owner notifications.

An unanswered owner decision never becomes permanently quiet. Duplicate hints
are suppressed by fingerprint, but the pending item remains in the weekly
digest; a stated `keep_until` is the only time-bounded quiet period.

Reviewer failures are not quiet when the dirty set contains must-commit
candidates. If source, config, tests, framework files, or behavior docs cannot
be reviewed because Codex times out or the loop budget is exhausted, localgit
records the fingerprint and routes the repo as blocked. The repo owner must
split, verify, and commit, or return a safe action for localgit.

## Full Recovery Backup

The external-disk recovery path is a local persistence control, not a remote
release or a replacement for Git. `scripts/run-supermatrix-recovery-backup.sh`
archives the fixed SuperMatrix/Codex/amzdata source profile, creates
SQLite-consistent snapshots for the configured key active databases, validates
the archive, and normally rotates
only packages marked `COMPLETED`. Scheduler owns the weekly trigger; a
scheduler success is only delivery evidence, while `COMPLETED`, `SHA256SUMS`,
the archive listing, SQLite quick checks, and the local receipt are the
completion proof.

Under the user's explicit capacity policy, if the volume cannot satisfy the
preflight threshold or archive creation returns `ENOSPC`, the task deletes the
oldest direct child matching `SuperMatrix-Recovery-*` and retries. This narrow
capacity path may remove an older direct-copy package without `COMPLETED`; it
never scans other disk directories or the dot-prefixed in-progress directory.
Outside that condition, a completed package is never rotated until the new
archive has been created and verified. The executable procedure, exact weekly
schedule, source profile, receipt sample, post-backup local-copy inventory, and
failure routing live in
`sop/SOP-supermatrix-recovery-backup-active-20260811-b7k2p8.md`.

## Ad-hoc Database Copies

A full local database copy is a temporary rollback artifact, not durable
history. Long-lived business history, migration evidence, and audit state must
live in the active database's audit fields or history tables. An owner may make
one temporary full copy before a destructive operation only when transaction
rollback is insufficient. Before creation, the owner records the source path,
owner, reason, creation time, expiry, and deletion condition; after the
operation is verified, or after the next independently verified external
recovery package covers that source, the owner deletes the copy.

Active databases are never cleanup candidates. localgit inventories suspicious
`.bak`/`backup`/`before`/`snapshot`/`copy` files and routes each item to its
workspace owner; it does not delete another owner's database. A candidate newer
than the latest verified external package remains protected until a fresh
package passes checksum, archive listing, and SQLite quick checks. A newly
created temporary copy must include a concrete reason and expiry time; a legacy
unique rollback point may instead use a mechanically testable deletion
condition. An unmanaged copy without either lifecycle is `pending_owner`, not
quiet-deferred indefinitely.

## Rollback Rule

Git is the code source of truth. localgit's ledger is the audit trail.

When localgit creates a commit, rollback uses `git revert <commit-sha>`.
Destructive history rewrites are not part of the daily-commit path.

## Verification and Branch Patrol

The daily wrapper runs an independent verifier after the executor. Scheduler
success proves only that the script was triggered; localgit completion requires
the verifier to reconcile live Git state with the ledger and run-state receipt.

At 04:00 daily, branch patrol uses the same Feishu allowlist as daily-commit.
It may delete already-merged branches with `git branch -d` and fast-forward
ordinary branches. Divergent, conflicting, mounted-worktree, trunkless, and
undecided `localgit/hold/*` branches are report-only. A separate patrol verifier
checks one evidence row per inventoried branch and validates every applied
C1/C2 mutation against live refs.
