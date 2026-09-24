# Super Matrix v0.3.4

## Onboarding V1 Framework Fix

The exact onboarding-v1 repair from source commit `8541537c37a49b4940ddf92f257a9e87866cecd2` is included in this sanitized public package. It makes exit-zero parseable Lark CLI JSON successful, preserves explicit CLI failures, accepts the returned bot identity shape, and raises the bounded Claude probe budget for provider-routed probes.

## Updated Platform Capabilities

- The public onboarding CLI now preserves valid exit-zero JSON results even when the response has no top-level `ok` field, while retaining explicit `ok:false` failures.
- Bot authorization readback accepts the provider's `identities` shape.
- Claude onboarding probes use the bounded `$0.25` budget required for the provider-routed minimal probe.
- The package keeps the existing public provenance, platform manifest, isolated-runtime and installation boundaries.

## Upgrade From v0.3.2

No runtime migration is required. New installations should use the exact v0.3.4 Release assets and verify the published tag, archive digest and `SHA256SUMS` before extraction. Existing installations may remain unchanged until a separately authorized upgrade. Do not mix v0.3.1 and v0.3.4 Release assets.

## Verification Boundary

The package was rebuilt from the v0.3.2 public snapshot plus only the sanitized two-file public onboarding-v1 diff from source commit `8541537c37a49b4940ddf92f257a9e87866cecd2`. Sanitization, provenance/manifest validation, package tests and archive readback are recorded in `SANITIZATION_REPORT.md` and the private release receipt. No target-device authentication, group creation or service activation is part of this release.
