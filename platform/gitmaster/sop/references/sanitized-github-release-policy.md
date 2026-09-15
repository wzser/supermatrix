# Sanitized GitHub Release Policy

This companion file fixes publication choices that must not be improvised during a release.

## Publication Boundary

- Target: `wzser/supermatrix`, default branch `main`, public visibility.
- Live sources: `/Users/LOCAL_USER/SuperMatrix` and explicit workspace mappings in `config/public-export.json`.
- Publication shape: core framework under `supermatrix/`; reusable platform modules under `platform/`; root documentation and release metadata.
- Never publish an unlisted workspace. Adding a mapping is a policy change that requires reviewing its full selected file inventory before build.
- Read live working-tree content but never mutate it. Tracked plus non-ignored files may be investigated; final inputs are selected files frozen from exact independently reviewed owner commits. Record each source Git blob and SHA-256 before redaction. A dirty owner worktree or self-reported review is not a frozen release input.
- Every mapping is required. The builder rejects an empty mapping set, a mapping selecting zero files, and missing or excluded `required_files` before copying. Required files are exact paths relative to the mapping subpath, not globs. Evidence must include nonzero counts and per-file source/output hashes for every mapping; these checks do not replace owner review or installation tests.

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
- LocalWatch, its tests, the three retired lifecycle entrypoints and `terminal-launcher.sh` come from the explicitly reviewed current framework source. No executable or template is inherited from an older public snapshot. Native OS autostart is configured by the recipient agent from the reviewed lifecycle contract; inclusion does not authorize activation or a second supervisor.
- First Principle templates/governance mechanics come from its closed public input export plus the four separately anchored onboarding templates, without live audit/data/inbox content.
- Scheduler v2 plus its current public contracts; scheduler v1 is not shipped.
- Heartbeat's new-install entrypoints, not historical cleanup/migration operations; Watchdog's issue CLI and import closure, not private fleet upgrades or incident evidence.
- Autobitable preserves its existing owner adapter and the public profile, not a replacement webhook service. Social King's closed public input includes the existing interview and exception contracts. Runtime stores are never shipped.
- Mythos preserves its `public/` seed prefix and four existing carriers, including source hashes and redistribution notices. Only the two exact static source/fixture JSONL paths are permitted; generated indexes and query logs remain excluded.
- Skill Master includes exactly `diagnose`, `improve-codebase-architecture` and `tdd`, their owner manifest, seven portable entrypoints, Python metadata and focused public tests. Other skills, live registries and private upgrade configuration are not shipped.
- Lark permission/card-callback is the twelfth public role; the minimal Bitable row-data queue is a support module without an extra group. Preserve the Lark `public-input/` and `card-callback/` layout; ship no second SDK event consumer, production registry or schema mutation service.
- Localgit and Gitmaster publication/maintenance mechanics without repository inventories, ledgers, private keywords, or runtime data.

Static installation metadata stored under a source `data/` directory requires an exact destination path in `allowed_static_paths`, a closed source include, and reviewed static provenance. This narrow allowance accepts only UTF-8 `.json` files; it never permits another denied directory, credentials, databases, logs, or a glob. Content, secret, size, and keyword checks remain mandatory in both build and independent scan. Runtime state must be created in the recipient's private namespace, not exported.

## Current-Tree Detectors

Every selected file must be UTF-8 text, at most 5 MiB, and not a symlink. A literal NUL is blocked except in JavaScript/TypeScript source, where build normalizes it to the equivalent `\\0` source escape before the final scan. The scanner blocks:

- credential filenames and extensions: `.env*` except curated root `.env.example`, private keys, keystores, credential/token/cookie files, databases/WAL/SHM, archives, media, office files, and compiled binaries;
- runtime paths: `data`, `logs`, `runs`, `outputs`, `reports`, `captures`, `screenshots`, `media`, `archive`, caches, dependency installs, worktrees, incoming/raw/private evidence;
- high-confidence secret forms: private-key blocks, AWS/GitHub/Slack/OpenAI/Anthropic/Google prefixes, bearer JWTs, and long credential assignments;
- secret-shaped unit-test fixtures must carry `TEST_` inside the token. Build inserts that marker only for the fixed ascending fixture bodies covered by scanner tests; arbitrary matching tokens remain blocked.
- PII/business forms: non-placeholder email, mainland phone, WeChat/contact handle, private absolute path, long Feishu/Lark IDs, Bitable object IDs, ASINs, and every private keyword in both languages;
- remote resource forms: Feishu/Lark tenant hostnames, object tokens in Wiki/Base/Docs URLs, short field/view IDs, and unprefixed Base/table/node/space identifiers in configuration assignments or schema defaults. Check host and object value independently: a placeholder URL path never permits a private hostname, and a placeholder hostname never permits a real object token. Field/view replacements retain the type prefix and a stable redacted fingerprint so distinct fixture references do not collapse. These are not usable remote IDs. Preserve documented public service hosts and explicit example values; do not classify resource identifiers as login credentials;
- source-control residue: nested `.git`, conflict markers, macOS resource forks, and private evidence/keyword files.

False-positive waivers are exact-path plus exact-detector only. Glob waivers are forbidden. A waiver requires a written public-safe reason and user approval; test/example placeholders should instead use `example.com`, `example.test`, `YOUR_*`, `REDACTED`, or `supermatrix.local`.

## Git History Gate

Scan all reachable commits and tag targets for secret prefixes, private keywords, and the current-tree remote-resource detectors, including removed blobs. Enumerate author/committer names and emails. A current-tree cleanup does not remove history exposure. Any real sensitive history hit is exception E5 and requires one of:

1. Preserve history and explicitly accept the residual exposure.
2. Rewrite the public repository history and force-update refs after backup and user approval.
3. Publish the clean snapshot into a new repository and retire the old one.

The SOP never selects among these automatically.

For route 2, the exact safety sequence is fixed: record `refs/heads/main` from `git ls-remote`; create a local `git bundle create <private-run-dir>/pre-rewrite.bundle --all` and SHA-256 receipt; create a parentless sanitized commit; then push only with `git push --force-with-lease=refs/heads/main:<recorded-sha> origin <clean-commit>:refs/heads/main`. Do not publish a backup branch or tag because that keeps the old objects reachable. A force-with-lease rejection is a remote-moved failure, never permission to retry with plain `--force`.

An old release tag can keep the old history reachable after `main` is replaced. Inventory all remote refs and Release metadata/assets before the rewrite, and explicitly include affected tag/Release removal in the user's authorization. Back up that metadata privately, remove only the named refs/releases, then read back both Git refs and the Release API. Never claim that rewriting refs also erases caches, forks, or copies already downloaded by others.

## README And Release Contract

Chinese and English README files each contain standalone sections for:

1. `New Platform Capabilities`: newly shipped user-visible commands/modules with exact paths.
2. `Updated Platform Capabilities`: changed behavior and semantics, especially receipts/failure handling.
3. `Upgrade From <previous version>`: prerequisites, config/schema changes, retired behavior, and verification commands.

Release notes summarize the same facts and include security-boundary changes. Internal incident IDs, session/user names, customer/product examples, real counts from private runtime, and absolute local paths are forbidden.
