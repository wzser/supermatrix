# Sanitization Report: v0.3.0

Date: 2026-09-15. Product version: `v0.3.0`. Agent installation contract: `1.2.0`.

## Scope

The closed export selected 943 source files from 13 exact source commits. The final tree contains 950 regular UTF-8 files after adding seven public release files. It contains no symlinks, installed dependencies, runtime databases, logs, caches, archives, media, credentials, private workspaces, or private evidence.

All files were frozen from exact Git commits and copied with per-file source/output SHA-256 evidence. No executable or template was inherited from an earlier public release. Only public release metadata, versions, and the existing provenance byte/hash entries were refreshed after sanitization.

| Source | Approved commit |
| --- | --- |
| Core | `0307c29b75908ab8a4dd21b37c5f0ad103eea89c` |
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
| Gitmaster | `030ed022f8295d77d8e5e9373c956efb657c9888` |

Source commits are provenance records, not instructions to fetch private repositories. Install only the uploaded public archive. Raw source paths, private review logs, raw scan findings, and private keyword values remain outside this repository.

## Scan Gates

The private bilingual list contains 83 terms: 66 English/transliterated and 17 Chinese. It covers people, handles, company, brand, product, contact, private host, resource, and workflow references. Individual terms and fingerprints are not published.

Publication requires zero unwaived findings from all of the following:

1. Current-tree credential, path, binary, cache, dependency-install, and remote-resource detectors.
2. Exact private keywords in Chinese and English, including filenames.
3. Generic contact, product, resource, and decoded escaped-text checks.
4. Reachable public commit contents, removed blobs, author/committer metadata, and annotated-tag metadata.

Build evidence SHA-256: `7ed30708bdb29268797f73c413f4c8e8f9f01a580c610107572b16bc5970754b`.
Frozen-input receipt SHA-256: `b4610d830844f0baadc0885ad34fb306906f802ea55f9fe33b3ba6e59083e16f`.
Final-tree scan: 950 files, 0 findings; its exact digest is retained only in the private release receipt to avoid self-referential report hashing.

The new public snapshot is parentless. Authorized release work removes the legacy public branch ancestry and old release ref without publishing a backup ref. This cannot retract previously downloaded copies, forks, caches, or exposed credentials.

## Verification

- A clean isolated package install used Node `v24.14.1` and npm `11.11.0`; `npm ci` completed successfully.
- The same final package passed dependency lint, typecheck, build, unit `2005/2005`, adapters `858/858`, end-to-end `31/31`, and an official-registry production dependency audit with zero vulnerabilities.
- First Principle and table-queue public-contract verifiers were independently reviewed after their respective scan fixes. All source inputs are represented in a private frozen-input receipt.
- Production audits are point-in-time checks, not a permanent security guarantee. The installation runbook remains the authority for recipient-side package integrity, authorization, infrastructure, and live acceptance.

## Acceptance Boundary

This is a bounded pilot, not a claim of full private-platform parity or stable `v1.0.0`. The package does not supply recipient credentials, tenant approval, public relay authorization, real group interaction, or reboot evidence. The recipient agent may report `VERIFIED` only after completing the distributed installation checklist and its live acceptance checks.

Zero findings means the configured detectors found no match. It is not a guarantee that no sensitive content can exist. Suspected disclosures require prompt credential rotation or other appropriate remediation.
