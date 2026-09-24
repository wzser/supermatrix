# Sanitization Report: v0.3.3

Date: 2026-09-24. Product version: `v0.3.3`. Agent installation contract: `1.2.0`.

## Scope

The closed export selected 951 source files from 13 exact source commits, then replaced only the two public onboarding-v1 files from the exact repair commit. The final tree contains 958 regular UTF-8 files after adding seven public release files. It contains no symlinks, installed dependencies, runtime databases, logs, caches, archives, media, credentials, private workspaces, or private evidence.

This patch starts from the published v0.3.1 public snapshot and adds only the exact onboarding-v1 repair plus release-layer version and installation metadata. All other platform bytes remain from the v0.3.1 public snapshot; no live runtime or unreviewed workspace content was imported.

| Source | Approved commit |
| --- | --- |
| Core | `9727a53e0ae34172ab943bf4f951b5dd643c47a8` |
| First Principle | `b23981b2433698ab8ea79c69a93c717203a22caa` |
| Scheduler | `2138bd3934689f5ce08d95170e51a7f58e275fc0` |
| Heartbeat | `1b7c4390376da000a9a0999219cd18f5d33e7a93` |
| Watchdog | `ce4b923eef9e4cb8638c0ed101367eff4f6baefa` |
| Autobitable | `4ce4592d9ba18b756a66b12ef353bc3e2b1f9f65` |
| Skill Master | `ebbe7c45d2e410c62ab951cd6284bf7efa11bbf5` |
| Localgit | `cd6fe3018f644f1c9e55998b355c48372b115708` |
| Social coordination | `72a8f168b13d1d701221907bb67968a32312f28b` |
| Public knowledge | `a29638922f59a1e047f565a3c7f34a04d0c2a7de` |
| Lark support | `57cf7c6c9d7fdcb0a0053b0500196ceec5e1400c` |
| Table queue | `10e5a00d6d15333458dcb213391872b32fa5e0cb` |
| Gitmaster | `4ef7c2f07e9cdeaecf2dc794f0ec9b360c692c78` |

Source commits are provenance records, not instructions to fetch private repositories. Install only the uploaded public archive. Raw source paths, private review logs, raw scan findings, and private keyword values remain outside this repository.

## Scan Gates

The private bilingual list contains 52 terms: 35 English/transliterated and 17 Chinese. It covers people, handles, company, brand, product, contact, private host, resource, and workflow references. Individual terms and fingerprints are not published.

Publication requires zero unwaived findings from all of the following:

1. Current-tree credential, path, binary, cache, dependency-install, and remote-resource detectors.
2. Exact private keywords in Chinese and English, including filenames.
3. Generic contact, product, resource, and decoded escaped-text checks.
4. Reachable public commit contents, removed blobs, author/committer metadata, and annotated-tag metadata.

Build evidence SHA-256: `c3e0fe112694c05f592c756f77482ab6c207c92cc7036949fcd8e3c0cedce9c9`.
Frozen-input receipt SHA-256 is retained in the private release receipt; the exact source receipt covers the commit, parent, dirty-source status and closed three-file diff.
Final-tree scan: 958 files, 0 findings; its exact digest is retained only in the private release receipt to avoid self-referential report hashing.

The v0.3.3 patch preserves the v0.3.1 public snapshot as its publication base and carries only the exact onboarding-v1 repair scope: `src/cli/onboardingV1.ts`, `tests/cli/onboardingV1.test.ts`, and the source ledger `SM-SOURCE-CHANGES.md` (the ledger remains outside the closed public export allowlist). It does not rewrite history or delete public refs. Previously downloaded copies and third-party caches remain outside this repository's control.

## Verification

- A clean isolated package install used npm from the verified package lock; `npm ci` completed successfully.
- The package passed the focused onboarding-v1 tests, typecheck, dependency lint and build against the rebuilt public tree. Archive member, provenance/manifest and final archive scan readbacks are recorded in the private release receipt.
- The exact source onboarding regression passed `33/33`; the package verification includes the focused suite, typecheck, dependency lint, manifest readback, archive member checks and final-tree scan. Gitmaster export tests and the final archive scan are retained in the private release receipt.
- Production audits are point-in-time checks, not a permanent security guarantee. The installation runbook remains the authority for recipient-side package integrity, authorization, infrastructure, and live acceptance.

## Acceptance Boundary

This is a bounded pilot, not a claim of full private-platform parity or stable `v1.0.0`. The package does not supply recipient credentials, tenant approval, public relay authorization, real group interaction, or reboot evidence. The recipient agent may report `VERIFIED` only after completing the distributed installation checklist and its live acceptance checks.

Zero findings means the configured detectors found no match. It is not a guarantee that no sensitive content can exist. Suspected disclosures require prompt credential rotation or other appropriate remediation.
