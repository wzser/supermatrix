# Super Matrix

**Language:** [中文](README.md) | English

Super Matrix connects local CLI agents to Feishu/Lark. Each session keeps its own chat, workspace, context and runtime state. Users manage their own machine, accounts and credentials.

Product version: `v0.3.2`. Runbook version: **Agent Installation 1.2.0**. These are separate versions: this is not GitHub `v1.0.0` or a complete copy of the maintainers' private platform.

## Installation Entry

Give your own agent [AGENT_INSTALL.md](AGENT_INSTALL.md) and the matching code archive from the [v0.3.2 Release](https://github.com/wzser/supermatrix/releases/tag/v0.3.2). The runbook verifies the exact Release, tag, asset digests and `SHA256SUMS` first. Do not substitute `main`, GitHub's automatic source archive or an existing installation.

There is one installation path. The agent uses existing CLIs, configuration and native OS services; it does not need to create another installer. **Every error, uncertainty, interruption or agent handover returns to section R of that document.** Checks cannot be bypassed by copying a maintainer's configuration.

The first pilot targets macOS Apple Silicon with a Codex runtime backend. The installing agent may be a different product. The runbook fixes dependency versions, isolated paths, ports, permissions and commands. Account login, tenant approval, public-endpoint authorization and reboot require the user; an installation message cannot substitute for them.

## License

Except for third-party material identified by [NOTICE](NOTICE) or its own license file, project-owned code and documentation are dual licensed under **MIT OR Apache-2.0**. You may choose [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE); the root [LICENSE](LICENSE) records that choice. Third-party material remains under its original licenses and notices.

## New Platform Capabilities

v0.3.2 fixes onboarding-v1 handling of exit-zero Lark CLI JSON, bot identity readback and the provider-routed Claude probe budget; it adds no platform, installer or authorization capability.

## Updated Platform Capabilities

- **Publication contract:** the 57-check Agent Installation 1.2.0 contract remains unchanged, but is bound to the matching `v0.3.2` tag, archive, checksum manifest and extraction prefix.
- **Public-package boundary:** the root and `platform/gitmaster/public-release/` both carry MIT, Apache-2.0 and third-party-notice inputs. The builder uses an exact allowlist and regression tests to close both byte paths.
- **Sanitized publication:** this patch starts from the published v0.3.0 snapshot and changes only licenses, the installation contract, version metadata and release documentation. All other platform files retain their prior bytes.

## Upgrade From v0.3.1

An already completed v0.3.1 isolated installation needs no runtime migration or new authorization. New installations must use the v0.3.2 `AGENT_INSTALL.md`, `supermatrix-v0.3.2.tar` and `SHA256SUMS`; do not mix Release assets. Keep existing credentials, databases, production table records and event subscriptions. Any cleanup needs separate authorization.

For a first move from older versions, continue to use a new isolated installation. Do not import old environment files, credentials, databases, production table rows or subscriptions. Validate the new instance through the runbook before any separately authorized shutdown or cleanup.

## Included Modules and Limits

`supermatrix/` contains the core. `platform/` includes identity/principles, Scheduler v2, Heartbeat, Watchdog, Autobitable, Skill-master, Localgit, coordination review, public knowledge, Gitmaster and Lark support. A table-queue support module does not create another chat. The exact inventory, inputs and acceptance are in runbook sections M/B/N/L.

S5 starts only its declared core/scheduler services; copying a module does not enable every capability. Conditional mirrors and external services need explicit configuration and real tests, not silent exclusion after failure. Full business dashboards, device maintenance, private knowledge, complete governance and other runtime backends are outside this installation guarantee.

This is a bounded first-pilot release, not a multi-tenant SaaS. Software tests, archive checks, clean-environment preparation and live checks under the user's account are distinct evidence. The receiving agent may report `VERIFIED` only after the platform checks and all six live acceptance checks pass. Missing authorization and unverified behavior must remain explicit.

## Data and Security

The package excludes credentials, private people/contact/product information, real tenant resources, runtime databases, business logs, installed dependencies and private workspaces. Public examples, knowledge sources and static JSON are explicitly admitted and contain no production records. See [SANITIZATION_REPORT.md](SANITIZATION_REPORT.md) for source/output hashes and scan boundaries.

Zero findings means the configured detectors found nothing; it is not an absolute privacy guarantee. Revoke or rotate suspected credentials. Removing Git history does not replace credential handling.

See [RELEASE_NOTES.md](RELEASE_NOTES.md) for this version. Developers can run `npm run typecheck`, `npm run lint:deps` and layered tests under `supermatrix/`; these do not replace the runbook's live acceptance.
