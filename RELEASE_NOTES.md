# Super Matrix v0.2.0

Release date: 2026-08-14

`v0.2.0` expands runtime control, makes asynchronous delivery consumption explicit, completes the public Scheduler v2 cutover, and adds dedicated local Git and sanitized GitHub release modules.

## Highlights

- Added `/now` live steering for active Claude and Codex runs with honest accepted/unconfirmed/closed-window results.
- Added `/branch` conversation-context branches without creating Git branches or copying workspaces.
- Added explicit Spawn2.0 asynchronous result consumption through the returned `resultUrl` and `POST .../take`.
- Published Scheduler v2 as the only scheduler implementation on port `3502`.
- Added `platform/localgit` for daily commits, hold/ledger decisions, and branch convergence.
- Added `platform/gitmaster` with a reusable sanitized GitHub release SOP and deterministic scanner.
- Restricted `/usage` to safe quota projection fields.
- Added backend runtime-default, model/effort, restart-provenance, and process-observation improvements.
- Upgraded the core Lark SDK/HTTP and Scheduler Hono dependency chains, removed unused Anthropic SDK dependencies from localgit and Watchdog, and cleared production dependency audits for the four published Node modules.

## Upgrade Notes

- Node.js `>=22.0.0` is required.
- The obsolete `npm run init` QR wizard is not shipped. Follow `docs/SETUP.md` or `docs/SETUP.en.md` for manual lark-cli setup.
- Scheduler v2 uses port `3502`; port `3500` is retired.
- Configure `SCHEDULER_ADMIN_TOKEN` before using Scheduler mutation endpoints.
- Move daily commit automation from Watchdog to `platform/localgit` and remove duplicate legacy triggers.
- Back up local `.env`, SQLite databases, and session workspaces before upgrading. None of these belong in Git.

## Security and Publication

This release is built from a closed allowlist rather than a copy-and-delete workflow. The release scan covers:

- high-confidence credentials and private-key blocks;
- real Feishu/Lark/Bitable identifiers;
- emails, mainland phone numbers, ASIN-shaped product identifiers, and private absolute paths;
- a private bilingual keyword dictionary for employee names, handles, company names, brands, products, contacts, and private hosts;
- databases, logs, exports, archives, media, symlinks, oversized files, runtime state, and generated artifacts.

The private keyword dictionary is not committed. The public report contains only category counts, language counts, hashes, replacement totals, and scan results.

## Verification

Final verification results are recorded in `SANITIZATION_REPORT.md`. A scheduler or transport success remains a trigger receipt, not proof of downstream business completion.
