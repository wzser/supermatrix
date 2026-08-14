# Sanitization Report

Release candidate: `v0.2.0`

Date: 2026-08-14

Target repository: `wzser/supermatrix` (public)

Status: current-tree sanitization passed; the approved publication route is a
parentless `v0.2.0` snapshot with an exact-lease rewrite of remote `main`.

## Export Boundary

The candidate was generated from a closed allowlist. Files not selected by an
explicit mapping were not copied.

Included source areas:

- SuperMatrix core, tests, public templates, setup documentation, launchd
  templates, and localwatch public integration.
- Scheduler v2, Heartbeat, Watchdog, Localgit, Gitmaster, Autobitable,
  First-principle, Socail-king, Mythos public knowledge, and the publishable
  Skill-master subset.
- Package manifests and lockfiles needed to reproduce dependency installation
  and audit results.

Excluded classes:

- Source `.git` directories and source commit metadata.
- Local `.env` files, credentials, private keys, deploy keys, tokens, cookies,
  account configuration, and tenant-specific endpoints.
- Runtime databases, logs, ledgers, queues, caches, coverage, generated builds,
  dependency installs, archives, media dumps, and large artifacts.
- Live business records, product records, contact details, internal routing
  registries, private workspaces, recovery bundles, and operator-only evidence.
- Symlinks, binary files, non-UTF-8 files, and files larger than 5 MiB.
- Tests and skills whose required private runtime dependencies are intentionally
  absent from the public snapshot.

## Bilingual Keyword Screening

The private keyword inventory is kept outside this repository. It contains 50
terms: 24 person names, 5 person handles, 3 company terms, 5 brand terms, 9
product terms, 2 contact terms, and 2 private-host terms. The language split is
17 Chinese terms and 33 English terms.

The exporter scans both relative paths and UTF-8 file contents, with
case-insensitive matching for ASCII terms. It also detects credential shapes,
email addresses, mainland phone numbers, Amazon identifiers, Lark/Feishu IDs,
private user paths, denied artifact names, symlinks, binary data, and oversized
files. Evidence stores only counts, categories, hashes, and term fingerprints;
the private terms themselves are never written to this repository.

Build result:

- `build-25`: 1,001 mapped files, 0 post-redaction findings.
- `build-26`: 1,001 mapped files, 0 post-redaction findings.
- A recursive byte comparison between the two independently generated builds
  found no differences.
- Export policy SHA-256:
  `b90d7e452d5a7f95a10d603cae9dfeed1d4558b7572a4325eb8b0ee4680ff1c5`.
- Private keyword inventory SHA-256:
  `ad5624f93439e5be453cdde8cc585dd8776e9cb5da99ebfb80a5341e35055177`.

## Redaction Applied

The build replaced private workspace and home paths, local usernames, selected
people/product/brand terms, contact data, Amazon identifiers, and Lark/Feishu
object IDs with typed placeholders. Synthetic credentials used by security
tests were normalized to explicit test/example values before the final secret
scan.

Representative public placeholders include:

- `<SM_REPO_ROOT>`
- `<SM_RUNTIME_ROOT>`
- `<SM_WORKSPACE_ROOT>`
- `<HOME>`
- `LOCAL_USER`
- `LARK_CHAT_ID`
- `LARK_OWNER_OPEN_ID`
- `LARK_APP_ID`
- `ASIN_REDACTED`

## Verification Evidence

The following checks passed against the sanitized source candidate:

- SuperMatrix: dependency boundary lint and TypeScript typecheck.
- SuperMatrix unit suite: 134 files, 1,647 tests.
- SuperMatrix adapter suite: 63 files, 801 tests.
- SuperMatrix end-to-end suite: 9 files, 28 tests.
- Scheduler: 15 files, 114 tests, TypeScript typecheck, and production build.
- Watchdog: 22 files, 195 tests, and production build.
- Localgit: 19 files, 108 tests, and production build.
- Heartbeat: 280 tests.
- Gitmaster sanitized-release module: 11 tests.
- Skill-master publishable subset: 31 tests.
- Autobitable: 15 tests.
- Socail-king: 32 tests.
- Production dependency audits for SuperMatrix, Scheduler, Watchdog, and
  Localgit each reported 0 known vulnerabilities.
- Generated `node_modules`, `dist`, `__pycache__`, and `.pytest_cache`
  directories were removed after verification.

## Historical Exposure Boundary

The target is already public. All six reachable commits on the existing remote
`main` branch were scanned separately. The initial commit produced 110 privacy
or business-data findings; each of the five later commits produced 114. The
findings include identifiers, contact or tenant metadata, private paths, and
absolute symlinks. No high-confidence raw credential was reported by this scan,
but cleaning only the new tree cannot remove data already present in old
commits, clones, forks, or caches.

Decision recorded on 2026-08-14: rewrite the reachable public branch history.
Before changing any ref, all pre-rewrite refs were saved in a verified,
permission-restricted local bundle outside this repository. No backup ref is
pushed to GitHub. The clean release uses a parentless commit, an explicit
`--force-with-lease` bound to the previously observed remote SHA, and an
annotated `v0.2.0` tag. Existing clones must re-clone or reset to the rewritten
branch.

## Remaining Limits

- The checks above are an AI-assisted first-pass security and privacy review;
  they are not a substitute for a professional security audit.
- No live Feishu/Lark side-effect smoke test was run from the public candidate.
- A zero-finding scanner result means the configured detectors found nothing;
  it does not prove that every possible sensitive value class is known.
- Rewriting Git history cannot revoke copies that were already downloaded or
  retained by third-party caches.
