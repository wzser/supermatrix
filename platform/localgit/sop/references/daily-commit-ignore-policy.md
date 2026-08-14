# Daily Commit Ignore Policy（类目目录 / 参考附录）

> 定位（2026-07-04 重分类）：本文件是 ignore **类目目录**——allowlist / denylist /
> artifact-first / must-commit 清单与 auto-remediate 边界，供判定矩阵 R6/R8、
> reviewer prompt（`src/scripts/daily-commit-ignore-policy.ts`）和 skip 处置 SOP 引用。
> 它不是流程 SOP：逐文件提交判定流程见 `../SOP-daily-commit-judgment-matrix-active-*.md`，
> skip 后路由与 owner hint 见 `../SOP-daily-commit-skip-handling-active-*.md`。
> 改类目只改本文件，改判定流程别改这里。

## problem

Daily commit touches many repos. The goal is not to make every workspace clean.
The goal is to prevent behavior-changing work from remaining only as an
uncommitted local worktree change.

Business/runtime artifacts are usually not worth daily owner attention. If a
dirty set contains only such artifacts, localgit records it and quietly defers
it. Source, config, test, scheduler, identity-doc, SOP, or framework changes are
`must-commit candidates`: localgit must review them and either commit them or
record a specific blocking reason.

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

`localgit owns` the global daily-commit ignore policy:

- the allowlist of low-risk noise classes;
- the denylist of files that must never be hidden automatically;
- the `auto-remediate` prompt and safety limits;
- skip classification and owner-notification wording;
- the tests that prove daily-commit reviewer prompts reference this policy.

`owner handoff is a last resort`: localgit should resolve about 90% of
daily-commit skips itself through one of these localgit-owned outcomes:

- `deferred`: artifact-only or owner-routed dirty sets are recorded without
  waking the repo owner;
- `must-review backlog`: inactive/stale dirty sets that include source, config,
  tests, SOP, identity docs, package files, migrations, schema, or shared
  platform behavior are recorded as localgit-owned follow-up, not
  quiet-deferred;
- `auto-remediated`: narrow allowlisted machine noise is fixed with `.gitignore`
  and re-screened;
- `committed`: readable, one-logical-unit low-risk changes are reviewed and
  committed;
- `issue filed`: process failures, Codex timeouts, reviewer stalls, and
  wall-clock budget skips stay with localgit.

`repo owner owns` repo-local ignore decisions:

- business outputs and evidence;
- generated reports or exports;
- screenshots, media, and capture artifacts;
- data directories whose files might be either throwaway cache or user-facing
  deliverables;
- repo-specific tool outputs not already covered by localgit's allowlist.

Repo owner handoff happens only after localgit rules out safe self-resolution.

`first-principle` owns identity-document governance. Large or novel
`CLAUDE.md` / `AGENTS.md` changes are not ignore-policy decisions.

`scheduler` owns the daily trigger and lifecycle only. It does not own dirty
working-tree content decisions.

### 1.5. Must-commit priority

These paths are behavior-changing by default and must not be hidden by
artifact-only deferral:

```text
src/
server/
scripts/
tests/
test/
sop/
docs/
templates/
skills/
config/
migrations/
bin/
lib/
principles/
package.json
package-lock.json
pnpm-lock.yaml
tsconfig.json
AGENTS.md
CLAUDE.md
.gitignore
```

If any changed file falls in this class, localgit must review the repo. If the
change is safe, commit it. If it is blocked, record the concrete reason and
route only when another owner must decide.

`Behavior fast path` (2026-08-04): a file whose first path segment is one of the
must-commit directories above, that is readable text (content-sampled, not
binary, not a symlink), and that passes the R1 secret name/content screen,
commits directly without L2 reviewer spend. These files are the durability
target itself; L2 review is reserved for gray-zone residue outside both this
list and the artifact-first list. Root-level files stay on the L2 path.

These paths are artifact-first by default:

```text
data/
raw/
output/
outputs/
runs/
reports/
captures/
screenshots/
media/
artifacts/
archive/
diagnostics/
exports/
logs/
downloads/
payloads/
metrics/
snapshots/
backups/
lark-im-resources/
deepthink-runs/
tmp/
temp/
```

If every dirty file is artifact-first or low-risk machine noise, localgit should
quietly defer it: no daily owner notification, no reviewer spend, no commit.
The result still goes to `data/daily-commits.log` and `data/git-ledger.jsonl`.

### 2. allowlist for localgit auto-remediate

localgit may add `.gitignore` entries only when all conditions are true:

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
verified access credentials (secrets / tokens / private keys / session cookies)
.env
.env.*
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

Privacy alone is not a deny condition in this local-only Git history. Feishu
group IDs/names, local personal data, and readable customer/business data may
be committed. Raw exports still use the artifact/manifest flow because their
rebuildability and deliverable semantics—not their privacy—need a repo-local
decision.

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
first prefer localgit-owned outcomes:

1. defer artifact-only or owner-routed dirty sets without waking the repo owner;
2. auto-remediate clearly disposable allowlisted noise;
3. safe-commit readable one-logical-unit changes that do not contain verified
   access credentials, databases, archives, or unverified shared-platform behavior;
4. file a localgit-owned issue for process failures, Codex timeouts, reviewer
   stalls, and wall-clock budget skips.

Notify the repo owner only when domain judgment is genuinely required for a
must-commit candidate or blocked mixed change:

1. unclear deliverable semantics;
2. verified credential risk;
3. unreadable binaries/databases;
4. mixed changes that need repo-local split judgment;
5. a repo-local ignore rule that cannot be proven narrow from the diff.

If an owner-routed path is transferred, notify the repo owner with:

1. the changed path;
2. why localgit could not self-resolve it safely;
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
2. `auto-remediated`: localgit added narrow `.gitignore` entries, re-screened,
   and committed the result.
3. `owner-routed`: the repo owner was notified to decide the local ignore rule.
4. `fp-routed`: identity-document ownership was routed to first-principle.
5. `quiet-deferred`: artifact-only dirty set was recorded without owner
   notification.
6. `must-review backlog`: stale/inactive source, config, test, SOP,
   identity-doc, package, migration, schema, or platform behavior change was
   recorded for localgit review instead of being quiet-deferred.
7. `localgit-owned`: process/tooling failure remains with localgit instead of
   waking the repo owner, and is reported separately from content `skipped`.

## downstream consumer

The downstream consumers are:

1. daily-commit reviewer prompts, which need the policy embedded in every safety
   decision;
2. repo owner sessions, which need to know when `.gitignore` is their job;
3. first-principle, which owns identity-document exceptions;
4. localgit maintainers, who must update this policy whenever a repeated
   ignored-file class appears or an auto-remediate decision is corrected.
