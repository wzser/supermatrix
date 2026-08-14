# Sanitized GitHub Release Policy

This companion file fixes publication choices that must not be improvised during a release.

## Publication Boundary

- Target: `wzser/supermatrix`, default branch `main`, public visibility.
- Live sources: `/Users/LOCAL_USER/SuperMatrix` and explicit workspace mappings in `config/public-export.json`.
- Publication shape: core framework under `supermatrix/`; reusable platform modules under `platform/`; root documentation and release metadata.
- Never publish an unlisted workspace. Adding a mapping is a policy change that requires reviewing its full selected file inventory before build.
- Read live working-tree content but never mutate it. Tracked plus non-ignored files may be candidates; config includes remain the final authority.

## Version Policy

- Tag format: `vMAJOR.MINOR.PATCH`.
- `PATCH`: sanitization/docs/test-only correction without new user-facing behavior.
- `MINOR`: backward-compatible platform capability, command, adapter, or module addition.
- `MAJOR`: public setup/API contract intentionally breaks.
- Root `VERSION`, exported `supermatrix/package.json`, exported lockfile root version, annotated tag, README upgrade heading, and release title must agree.

## Private Keyword Contract

The keyword JSON is runtime-private and must live outside every Git repository. Schema:

```json
{
  "version": 1,
  "keywords": [
    {"category": "person", "language": "zh", "term": "PRIVATE_VALUE", "replacement": "PERSON_REDACTED"},
    {"category": "product", "language": "en", "term": "PRIVATE_VALUE", "replacement": "PRODUCT_REDACTED"}
  ]
}
```

Required categories: `person`, `person_handle`, `company`, `brand`, `product`, `contact`, and `private_host`. Required languages: at least one `zh` and one `en` entry for people and product/brand terms when such terms exist. A term must be at least two Unicode characters; ASCII terms must be at least four characters. The public report records only file SHA-256, term count, language/category counts, and replacement totals.

Keyword discovery sources, in order:

1. Public-tree history authors/contact sections and previous sanitization findings.
2. Selected source files containing employee/person maps, contact fields, product/brand/ASIN/SKU contexts, or private hostnames.
3. Exact user-provided Chinese and English variants, abbreviations, transliterations, handles, and known misspellings.
4. A post-build broad scan for emails, phones, WeChat/contact phrases, ASINs, Feishu IDs, private paths, and unknown proper nouns; confirmed terms return to the private list and force a full rebuild.

## Closed Source Mappings

`config/public-export.json` is the machine authority. The intended capability boundary is:

- Core Super Matrix runtime, public docs, tests, templates, and operational scripts.
- Launchd templates come only from the fetched prior public snapshot because their live equivalents contain machine-specific labels and paths; the final scanner still revalidates every preserved template.
- First Principle templates/governance mechanics without live audit/data/inbox content.
- Scheduler v2 plus its current public contracts; scheduler v1 is not shipped.
- Heartbeat, Autobitable, Watchdog, Social King, and Mythos reusable source/templates with runtime stores and incident evidence removed.
- Skill Master framework plus an explicit generic-skill allowlist; business/operator credentials and data skills are not shipped.
- Localgit and Gitmaster publication/maintenance mechanics without repository inventories, ledgers, private keywords, or runtime data.

## Current-Tree Detectors

Every selected file must be UTF-8 text, at most 5 MiB, and not a symlink. A literal NUL is blocked except in JavaScript/TypeScript source, where build normalizes it to the equivalent `\\0` source escape before the final scan. The scanner blocks:

- credential filenames and extensions: `.env*` except curated root `.env.example`, private keys, keystores, credential/token/cookie files, databases/WAL/SHM, archives, media, office files, and compiled binaries;
- runtime paths: `data`, `logs`, `runs`, `outputs`, `reports`, `captures`, `screenshots`, `media`, `archive`, caches, dependency installs, worktrees, incoming/raw/private evidence;
- high-confidence secret forms: private-key blocks, AWS/GitHub/Slack/OpenAI/Anthropic/Google prefixes, bearer JWTs, and long credential assignments;
- secret-shaped unit-test fixtures must carry `TEST_` inside the token. Build inserts that marker only for the fixed ascending fixture bodies covered by scanner tests; arbitrary matching tokens remain blocked.
- PII/business forms: non-placeholder email, mainland phone, WeChat/contact handle, private absolute path, long Feishu/Lark IDs, Bitable object IDs, ASINs, and every private keyword in both languages;
- source-control residue: nested `.git`, conflict markers, macOS resource forks, and private evidence/keyword files.

False-positive waivers are exact-path plus exact-detector only. Glob waivers are forbidden. A waiver requires a written public-safe reason and user approval; test/example placeholders should instead use `example.com`, `example.test`, `YOUR_*`, `REDACTED`, or `supermatrix.local`.

## Git History Gate

Scan all reachable commits and tag targets for secret prefixes and private keywords. Enumerate author/committer names and emails. A current-tree cleanup does not remove history exposure. Any real sensitive history hit is exception E5 and requires one of:

1. Preserve history and explicitly accept the residual exposure.
2. Rewrite the public repository history and force-update refs after backup and user approval.
3. Publish the clean snapshot into a new repository and retire the old one.

The SOP never selects among these automatically.

For route 2, the exact safety sequence is fixed: record `refs/heads/main` from `git ls-remote`; create a local `git bundle create <private-run-dir>/pre-rewrite.bundle --all` and SHA-256 receipt; create a parentless sanitized commit; then push only with `git push --force-with-lease=refs/heads/main:<recorded-sha> origin <clean-commit>:refs/heads/main`. Do not publish a backup branch or tag because that keeps the old objects reachable. A force-with-lease rejection is a remote-moved failure, never permission to retry with plain `--force`.

## README And Release Contract

Chinese and English README files each contain standalone sections for:

1. `New Platform Capabilities`: newly shipped user-visible commands/modules with exact paths.
2. `Updated Platform Capabilities`: changed behavior and semantics, especially receipts/failure handling.
3. `Upgrade From <previous version>`: prerequisites, config/schema changes, retired behavior, and verification commands.

Release notes summarize the same facts and include security-boundary changes. Internal incident IDs, session/user names, customer/product examples, real counts from private runtime, and absolute local paths are forbidden.
