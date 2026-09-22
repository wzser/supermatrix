# Super Matrix v0.3.1

## Agent Installation 1.2.0

The product release is `v0.3.1`; the agent-run installation document remains version `1.2.0`. Use the exact uploaded `AGENT_INSTALL.md`, `supermatrix-v0.3.1.tar` and `SHA256SUMS` together. Verify their GitHub asset digests before extraction or execution.

This patch does not change installation behavior, runtime activation, user authorization, live-acceptance requirements or the 57-item checklist. It updates the package identity that S1 verifies.

## License

Project-owned code and documentation are available under **MIT OR Apache-2.0**. The root `LICENSE`, `LICENSE-MIT` and `LICENSE-APACHE` provide the applicable texts. [NOTICE](NOTICE) is reserved for third-party notices; third-party materials keep their own licenses and notices.

## New Platform Capabilities

None. v0.3.1 is a licensing and publication-metadata patch; it adds no platform runtime behavior, command, adapter, service or installer.

## Updated Platform Capabilities

- The exact installation contract now verifies the v0.3.1 tag, archive name, asset manifest and extraction prefix while retaining Agent Installation 1.2.0.
- The public export independently includes license inputs at the release root and under `platform/gitmaster/public-release/`, with required-file and byte-closure tests.
- The patch derives from the published v0.3.0 snapshot and preserves all unrelated platform bytes.

## Upgrade From v0.3.0

No runtime migration is required. Existing v0.3.0 installations keep their isolated identity, credentials, database, tables and subscriptions. For new installations, obtain the exact v0.3.1 Release assets and follow S1 before execution. Do not mix v0.3.0 and v0.3.1 assets or perform cleanup without separate authorization.

## Verification Boundary

Exact package tests, sanitization scope, dependency audits and source provenance are recorded in `SANITIZATION_REPORT.md`. This bounded pilot does not claim full private-platform parity or substitute local fixtures for actual account authorization, group interaction, external relay delivery or reboot acceptance. Only the runbook's completed checklist permits an installation verdict of `VERIFIED`.
