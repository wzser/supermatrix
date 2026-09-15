---
id: 83e8f1
name: agent-install
status: draft
owner: gitmaster
created: 2026-09-13
updated: 2026-09-14
description: Guide a recipient's own agent through existing-tool deployment and per-platform acceptance; do not create a new installer or claim missing capabilities are ready.
---
# Agent Installation Contract 1.2.0

## Step 1. Open the Execution Contract

Read [AGENT_INSTALL.md](../AGENT_INSTALL.md) in full before any write. It is the single maintained execution contract and includes the fixed prompts; this SOP registers its routing and review boundary, not a second installation path.

## Step 2. Execute Its Gates in Order

Initialize C and inventory M/B/N/L before authorization. Separate supported configuration work from missing public code/contracts. Follow S1's exact document/package verification, then S2-S5, dependent platform configuration and V/H. The recipient's agent uses existing native commands and configuration; no purpose-built installer is required. Any error, uncertainty, interruption or lost context returns to R. Repair supported configuration within authorization; preserve ownership/checkpoints and do not invent an interface or modify framework behavior. A blocked capability does not prevent independent safe inspection/preparation.

## Inputs and Outputs

- Input: AGENT_INSTALL.md version 1.2.0; the v0.3.0 pilot must pass S1 with matching published metadata and assets. Do not pair this revision with the old 1.0.1 candidate. Sample: `{"document_version":"1.2.0","release_tag":"v0.3.0","backend":"codex","package_status":"awaiting_S1_verification"}`.
- Output: H's report with every C row and M capability/subfeature. Sample: `{"document_version":"1.2.0","verdict":"BLOCKED","capabilities":{"autobitable":{"gap_kind":"package","status":"blocked"}},"next_action":"Obtain a supported public adapter; continue independent configuration inventory"}`.
- Idempotency: use P's install_key formula and saved resource/operation IDs. A repeated communication or unknown result must be read back, not redriven under a new ID.
- Per-role and per-test evidence follows V/H. Transport closure, package install and core health do not substitute for live acceptance.

## Locked Decisions

| Decision | Single source |
|---|---|
| Document/package/platform identity | AGENT_INSTALL.md S1 |
| Paths, profile, ports, tool versions, retries and input examples | P, S3 and R |
| Human effects and auth boundaries | S1/S4 and R05/R08/R10 |
| Installation/resume argv and environment | S5 |
| All mandatory checks and per-item evidence | C and H |
| Every platform, local versus remote subfeatures and reference differences | M; no role-count or health-only parity claim |
| Table inventory, native creation, permissions, binding and readback | B; missing static schema/consumer blocks the affected write |
| HTTPS relay, private tunnel, automation security and terminal result | N; public exposure/spending remain explicit human decisions |
| LocalWatch, autostart, recovery and lifecycle ownership | L/R07; configure existing support, never invoke retired installers |
| Fixed smoke-test requests and evidence | V |
| Error routing, escalation and rollback | R |
| Verdicts and report examples | H |

## Exceptions

| Case | Trigger / detection | Action | Notify | Deadline |
|---|---|---|---|---|
| Upstream package defect | Archive digest/layout differs from S1 | R01; no package execution | Package supplier through user's existing contact | Immediately |
| Downstream unavailable | Provider timeout or uncertain task delivery | R06/R09; bounded read-only retries or original-ID readback, no blind write replay | Installing user, then supplier | R retry/observation deadline |
| Own execution mismatch | Saved inputs, state or identity disagree | R03; preserve state, stop mutations, retain reproduction | Package supplier | Immediately |
| Uncovered case | No matching R row or document/code conflict | R00 diagnosis; repair supported config, retain reproduction for an actual package gap | Supplier only when the agent cannot resolve a supported setting | Immediately for safety/ownership conflict; otherwise bounded diagnosis |

## Validation and Publication Boundary

- Draft SOP registration is intentional while full live acceptance remains unverified. Document 1.2.0 is a versioned agent-operated runbook for the v0.3.0 pilot. Earlier 1.0.1 approval does not certify these inputs; require this version's package report and S1 readback.
- gitmaster owns the contract and public package handoff. Framework defects return to the framework owner; managed-device changes remain with the device/deployment owners.
- Do not publish a new product tag, push, replace a candidate, install on a device or activate a service merely to register this document.
- The closed export mapping includes AGENT_INSTALL.md with this SOP so its relative link stays valid. This admission change does not rebuild the paired archive or authorize publication. Future packaging must retain the document/package binding and pass the normal explicit release gates.
