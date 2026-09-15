# SOP Index

> Naming follows SOP Principle section 8: `SOP-<topic>-<status>-<YYYYMMDD>-<id>.md`. Update the filename, frontmatter, and this table in one commit; never change the stable ID.

| SOP file | Status | Updated | Owner | When to use | Upstream / downstream |
|---|---|---|---|---|---|
| [SOP-sanitized-github-release-active-20260814-rpidv7.md](SOP-sanitized-github-release-active-20260814-rpidv7.md) | active | 2026-08-14 | gitmaster | Build and publish a public-safe Super Matrix snapshot after explicit release authorization; do not use it to restore live runtime or publish business workspaces. | <- live SuperMatrix + approved platform workspaces; -> public GitHub main/tag/release |
| [SOP-agent-install-draft-20260914-83e8f1.md](SOP-agent-install-draft-20260914-83e8f1.md) | draft | 2026-09-14 | gitmaster | Guide a recipient's own agent through existing-tool deployment and per-platform acceptance; do not create a new installer or claim missing capabilities are ready. | <- AGENT_INSTALL.md + reviewed public package; -> recipient agent + C/M/B/N/L/V/H evidence |
