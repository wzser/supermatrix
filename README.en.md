# Super Matrix

**Language:** [中文](README.md) | English

Super Matrix connects local CLI agents to Feishu/Lark. Each session keeps its own chat, workspace, context and runtime state. Users manage their own machine, accounts and credentials.

Product version: `v0.3.0`. Runbook version: **Agent Installation 1.2.0**. These are separate versions: this is not GitHub `v1.0.0` or a complete copy of the maintainers' private platform.

## Installation Entry

Give your own agent [AGENT_INSTALL.md](AGENT_INSTALL.md) and the matching code archive from the [v0.3.0 Release](https://github.com/wzser/supermatrix/releases/tag/v0.3.0). The runbook verifies the exact Release, tag, asset digests and `SHA256SUMS` first. Do not substitute `main`, GitHub's automatic source archive or an existing installation.

There is one installation path. The agent uses existing CLIs, configuration and native OS services; it does not need to create another installer. **Every error, uncertainty, interruption or agent handover returns to section R of that document.** Checks cannot be bypassed by copying a maintainer's configuration.

The first pilot targets macOS Apple Silicon with a Codex runtime backend. The installing agent may be a different product. The runbook fixes dependency versions, isolated paths, ports, permissions and commands. Account login, tenant approval, public-endpoint authorization and reboot require the user; an installation message cannot substitute for them.

## New Platform Capabilities in v0.3.0

- **Agent-operated installation contract:** 57 checks with configuration, access, observed results, recovery and evidence for the control chat, 12 public roles, required tables, card interaction, LocalWatch and live acceptance.
- **Public Lark support:** a per-operation user/application permission plan, separate tenant/resource checks, and installation-bound card MCP/callback paths without a second event connection.
- **Table queue and provisioning contracts:** field and unique-key definitions, native schema steps and existing queue interfaces. Writes require terminal proof and ID-bound readback; repeated requests must not execute twice. Users create or explicitly adopt their own tables.
- **Self-contained static platform inputs:** public identity/principle inputs, three approved skills, and complete public knowledge seeds with upstream licenses instead of private runtime dependencies.

## Updated Platform Capabilities in v0.3.0

- **Isolation and recovery:** fixed HOME, profile, backend, executables, databases and ports using the existing LocalWatch. Start, recovery and rollback verify actual process ownership, not only a live PID.
- **Scheduler, Heartbeat, Watchdog and Localgit:** explicit public dependencies and configuration. Triggering, enqueueing or launching a shell is not delivered-result evidence. Each mirror retains its existing transport and acceptance contract.
- **Autobitable:** a restricted fixed-target prompt workflow through the user's HTTPS ingress and private tunnel to the local adapter. The agent's terminal result is verified; arbitrary scripts, dynamic targets and maintainer business routes are not public features.
- **Sanitized publication:** closed mappings, required-file checks, bilingual private keywords, escaped-text detection, remote-resource checks and Git-history scanning over exact approved inputs.
- **Dependency fixes:** approved lockfile updates for the core, Scheduler and card module. Exact versions, tests and production audits are recorded in the [sanitization report](SANITIZATION_REPORT.md), not presented as a permanent security guarantee.

## Upgrade From v0.1.0 / v0.2.0

Use a **new isolated installation**. This release does not provide in-place runtime migration. Retain the old installation and private backups, then create a new app/profile, state and resources using the runbook. Do not import old environment files, credentials, databases, production table rows or subscriptions. Validate the new instance before a separately authorized shutdown or cleanup of the old one.

This release replaces the public history and removes the old `v0.2.0` tag/Release under owner authorization. Existing users should obtain the new repository in a separate directory, without merging the old history back into public `main`. Keep local work intact. History rewriting cannot recall downloaded copies or third-party caches.

## Included Modules and Limits

`supermatrix/` contains the core. `platform/` includes identity/principles, Scheduler v2, Heartbeat, Watchdog, Autobitable, Skill-master, Localgit, coordination review, public knowledge, Gitmaster and Lark support. A table-queue support module does not create another chat. The exact inventory, inputs and acceptance are in runbook sections M/B/N/L.

S5 starts only its declared core/scheduler services; copying a module does not enable every capability. Conditional mirrors and external services need explicit configuration and real tests, not silent exclusion after failure. Full business dashboards, device maintenance, private knowledge, complete governance and other runtime backends are outside this installation guarantee.

This is a bounded first-pilot release, not a multi-tenant SaaS. Software tests, archive checks, clean-environment preparation and live checks under the user's account are distinct evidence. The receiving agent may report `VERIFIED` only after the platform checks and all six live acceptance checks pass. Missing authorization and unverified behavior must remain explicit.

## Data and Security

The package excludes credentials, private people/contact/product information, real tenant resources, runtime databases, business logs, installed dependencies and private workspaces. Public examples, knowledge sources and static JSON are explicitly admitted and contain no production records. See [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) for source/output hashes and scan boundaries.

Zero findings means the configured detectors found nothing; it is not an absolute privacy guarantee. Revoke or rotate suspected credentials. Removing Git history does not replace credential handling.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for this version. Developers can run `npm run typecheck`, `npm run lint:deps` and layered tests under `supermatrix/`; these do not replace the runbook's live acceptance.
