# Super Matrix Source Changes

## v0.2.0 - 2026-08-14

### Core Runtime

- Added message-run-scoped `/now` injection for Claude and Codex, including explicit unsupported and closed-window outcomes.
- Added persistent session conversation branches with backend-specific fork/resume behavior.
- Added explicit Spawn2.0 result consumption, caller-consumed state, by-communication lookup, boot recovery, and read-only GET semantics.
- Added safe quota-snapshot rendering for `/usage`.
- Expanded backend runtime-default handling, Kimi model/effort validation, restart provenance, and process observation.
- Updated public localwatch and launchd templates; Scheduler health now targets port `3502`.

### Platform Modules

- Replaced the public scheduler tree with Scheduler v2 source, tests, and API documentation.
- Added `platform/localgit` for daily commit review, hold decisions, Git ledger queries, and branch patrols.
- Added `platform/gitmaster` with the sanitized release SOP, closed export policy, scanner, and scanner tests.
- Retained the previously published generic Autobitable adapter instead of exporting live business-specific workflow routes.
- Tightened platform allowlists to omit runtime state, internal rollout evidence, recovery database inventories, business-specific registries, and generated outputs.
- Refreshed production dependency locks: Lark SDK/HTTP and Scheduler Hono were upgraded, while unused Anthropic SDK declarations were removed from localgit and Watchdog.

### Documentation and Release Engineering

- Added separate README sections for new platform capabilities, updated capabilities, and the v0.1.0-to-v0.2.0 upgrade.
- Replaced stale QR-wizard setup instructions with a verified manual lark-cli flow.
- Updated the minimum Node.js version to 22 and documented Scheduler v2 configuration.
- Added `VERSION`, `RELEASE_NOTES.md`, a current sanitization report, and source receipts.
- Added deterministic bilingual private-keyword redaction and full-tree release scanning.
