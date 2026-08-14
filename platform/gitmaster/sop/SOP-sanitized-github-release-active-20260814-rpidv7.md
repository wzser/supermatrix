---
id: rpidv7
name: sanitized-github-release
status: active
owner: gitmaster
created: 2026-08-14
updated: 2026-08-14
description: Build and publish a public-safe Super Matrix snapshot after explicit release authorization; do not use it to restore live runtime or publish business workspaces.
---

# Sanitized GitHub Release

Publish only the configured source allowlist after deterministic redaction, bilingual private-keyword scanning, tests, and remote receipt verification.

## When To Use

Use after the user authorizes a public GitHub snapshot version. Do not use for daily commits, private backups, live-runtime recovery, or business workspace publication.

## Prerequisites

- Read `sop/INDEX.md`, this SOP, and `references/sanitized-github-release-policy.md`.
- Required tools: `git`, Python 3.11+, SSH push access, and a GitHub Release API client or authenticated browser.
- Inputs must match the contract below; unknown source paths are excluded, not inferred.

### Step 1: Freeze the release identity and source receipt

- **Input**: semantic version `vX.Y.Z`, target `wzser/supermatrix:main`, live roots, `config/public-export.json`, and an untracked private keyword JSON.
- **Action**: fetch `origin`; require a clean export repo; create a new release worktree from the fetched `origin/main`; record each source repo HEAD, branch, `git status --short`, and SHA-256 of the private keyword file in a private run directory.
- **Output**: `source-receipt.json` plus an empty build directory created under `mktemp -d`.
- **Gate**: version must not exist in `git tag -l` or `git ls-remote --tags origin`; remote main must equal the fetched `origin/main` before build.
- **Rollback**: if any check fails, remove only the new temporary run directory/worktree registration; do not modify live source or the old local branch.

### Step 2: Build from the closed allowlist

- **Input**: Step 1 receipt and `config/public-export.json`.
- **Action**: run `python3 scripts/sanitized_release.py build` with explicit live roots, fetched public-base worktree, output, keyword file, and evidence path. It reads only tracked or non-ignored files matching the config; all other workspaces and paths are excluded.
- **Output**: a UTF-8-only `supermatrix/` plus `platform/` snapshot and private `build-evidence.json` with one row per copied file.
- **Gate**: build exits 0, `ok=true`, no duplicate destination, no symlink, no file over `max_file_bytes`, no high-confidence secret, and every copied file has source/destination SHA-256 evidence.
- **Rollback**: discard the temporary snapshot; never redact or delete files in live roots.

### Step 3: Curate release documentation

- **Input**: Step 2 snapshot, current `SM-SOURCE-CHANGES.md`, source git logs since the prior public snapshot, and the prior public README.
- **Action**: write Chinese and English README sections named `New Platform Capabilities`, `Updated Platform Capabilities`, and `Upgrade From v0.1.0`; update the exported core manifest version, root `VERSION`, release notes, and `SANITIZATION_REPORT.md`. Summaries must omit internal IDs, incident refs, people, products, customers, and private infrastructure.
- **Output**: reviewable release docs and package metadata matching `vX.Y.Z`.
- **Gate**: README claims map to shipped files or verified core behavior; no internal-only capability is presented as included.
- **Rollback**: revert only release-worktree documentation changes; leave the generated snapshot/evidence for diagnosis.

### Step 4: Run four independent leak gates

- **Input**: complete release worktree after Step 3.
- **Action**: run (1) scanner built-ins, (2) exact private keywords in Chinese and English, (3) repository-wide generic PII/product identifiers, and (4) Git history scan for secret prefixes, private keywords, author names/emails, and removed sensitive blobs. Run focused module tests after scanning.
- **Output**: private `final-scan.json`, test receipts, and an aggregate public sanitization report.
- **Gate**: current tree has zero unwaived findings. Exact waivers require one path, one detector, written reason, and user approval. History findings follow exception E5 and block push until decided.
- **Rollback**: remove the risky file from the public allowlist or replace private literals with public placeholders in the release worktree; rerun all four gates from the beginning.

### Step 5: Review the exact publication diff

- **Input**: clean scan/test receipts and `git status --short` in the release worktree.
- **Action**: inspect untracked files, `.gitignore`, `git diff --stat`, full staged diff, `git diff --cached --check`, and file-size totals. Stage only the intended root docs, `supermatrix/`, and configured `platform/` modules.
- **Output**: one staged release snapshot with no private evidence or keyword file.
- **Gate**: `git ls-files` contains no private run directory, scanner evidence with raw terms, runtime data, database, logs, archive, or media.
- **Rollback**: unstage only this release worktree; fix the build/config and repeat Step 2 rather than hand-editing copied source repeatedly.

### Step 6: Commit, tag, publish, and verify

- **Input**: approved staged snapshot and version `vX.Y.Z`.
- **Action**: commit `release: vX.Y.Z sanitized public snapshot`; create an annotated tag; recheck remote main has not moved; push commit and tag without force; create a GitHub Release from `RELEASE_NOTES.md`. The only alternate action is an E5 rewrite explicitly selected by the user: first write and hash a local private `git bundle`, create a parentless sanitized release commit, then update `main` with `--force-with-lease=refs/heads/main:<step-1-remote-sha>`; never push the backup bundle or a backup ref.
- **Output**: commit SHA, tag object, GitHub Release URL/API id, and final remote refs.
- **Gate**: `git ls-remote origin refs/heads/main refs/tags/vX.Y.Z refs/tags/vX.Y.Z^{}` matches local commit/tag; GitHub Release is published, non-draft, and points to the same tag.
- **Rollback**: before push, delete only the local tag. After a normal push, never rewrite/delete public refs without a new explicit user decision; publish a corrective patch release instead. After an approved E5 rewrite, do not restore the old public ref because that republishes the sensitive history; retain the private bundle as the recovery receipt.

## Exceptions

| Case | Mechanical trigger | Detection | Action | Notify | Escalation |
|---|---|---|---|---|---|
| E1 dirty or ambiguous source | selected source path is binary, ignored, outside allowlist, or has unclear ownership | build candidate/evidence mismatch | exclude it; do not infer intent or copy a parent directory | user only when exclusion changes a requested public capability | before Step 3 |
| E2 secret or private keyword | any current-tree detector has one or more unwaived hits | `final-scan.json.ok=false` | block release; remove the file or redact in release worktree; rerun all gates | user for any match whose public value is genuinely ambiguous | immediate, no push |
| E3 tests or build fail | any required command exits non-zero | test receipt | block release; report exact module and failure; do not label the snapshot usable | owner of failing platform module if code repair is required | same run |
| E4 remote moved or release API unavailable | remote main differs, tag exists, or GitHub Release cannot be created | `ls-remote`/API response | do not force; rebuild from new remote or leave the pushed tag explicitly incomplete | user if auth/browser action is required | before any irreversible action |
| E5 sensitive content exists in published history | history scan finds real person/contact/product/credential data in reachable commits | history detector with commit/path evidence | stop before new push; offer preserve-history, rewrite-history, or new-repository routes with consequences | user via finite decision card | no release until answered |

## Inputs And Outputs Contract

- **Input sample**: `{"version":"v0.2.0","remote":"wzser/supermatrix","branch":"main","config":"config/public-export.json","keyword_file":"<SM_RUNTIME_ROOT>/data/gitmaster/private-release-keywords.json"}`.
- **Input idempotency key**: `<remote>:<version>`; an existing local/remote tag is a hard duplicate, not a retry target.
- **Output sample**: `{"version":"v0.2.0","commit":"<40-hex>","tag":"v0.2.0","remote_main":"<40-hex>","scan_ok":true,"release_url":"https://github.com/wzser/supermatrix/releases/tag/v0.2.0"}`.
- **Receipt**: private run directory contains source/build/final-scan/test JSON; public `SANITIZATION_REPORT.md` contains only aggregate counts and hashes, never raw private keywords.
- **Per-file evidence**: every copied file records mapping name, relative source/destination, byte count, source/output SHA-256, and redaction counts; `ok` alone is invalid evidence.

## Forbidden During Execution

- Never edit, redact, clean, reset, stash, or commit the live source repos.
- Never add a broad workspace, runtime directory, source git history, or ignored file to make a missing dependency disappear.
- Never auto-waive a real email, phone, person/product keyword, Feishu ID, ASIN, credential-shaped value, binary, or absolute symlink.
- Never force-push, delete a remote tag/release, or rewrite history without a new user decision naming that consequence.
- Never claim completion from local commit or push exit code; remote branch, tag, and Release receipts are all required.

## Verification

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/sanitized_release.py scan --root <release-worktree> --keyword-file <private-keywords.json> --evidence <private-final-scan.json>
git -C <release-worktree> diff --cached --check
git -C <release-worktree> ls-files | rg '(^|/)(data|logs|runs|outputs|reports|archive|media)/|\.(db|sqlite3?|log|zip|tar|gz)$'
git -C <release-worktree> ls-remote origin refs/heads/main refs/tags/<version> 'refs/tags/<version>^{}'
```

## Companion Files

- `references/sanitized-github-release-policy.md`: fixed publication boundary, detectors, keyword contract, version policy, and public documentation contract.
- `../config/public-export.json`: machine-readable source and path allowlist.
- `../scripts/sanitized_release.py`: deterministic build and current-tree scanner.

## Pre-Commit Self Check

- [x] Step 1 is reachable within 25 lines after frontmatter.
- [x] Five mechanically testable exception cases cover source, scanner, test, remote, and history failures.
- [x] Source paths, version rule, allowlist, thresholds, and receipts are explicit or referenced.
- [x] Input/output samples and idempotency key are concrete.
- [x] Filename, frontmatter, stable ID, and six-column INDEX row agree.
- [x] Per-file evidence is required for the batch copy.
