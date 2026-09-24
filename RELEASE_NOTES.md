# Super Matrix v0.3.3

## Onboarding V1 Framework Fix

The exact final onboarding-v1 repair from source commit `9727a53e0ae34172ab943bf4f951b5dd643c47a8` is included in this sanitized public package. It preserves explicit Lark CLI ok:false failures even when the process exits zero.

## Updated Platform Capabilities

- The public onboarding CLI now preserves valid exit-zero JSON results even when the response has no top-level `ok` field.
- Bot authorization readback accepts the provider's `identities` shape.
- Claude onboarding probes use the bounded `$0.25` budget required for the provider-routed minimal probe.
- The package keeps the existing public provenance, platform manifest, isolated-runtime and installation boundaries.

## Upgrade From v0.3.1

No runtime migration is required. New installations should use the exact v0.3.3 Release assets and verify the published tag, archive digest and `SHA256SUMS` before extraction. Existing installations may remain unchanged until a separately authorized upgrade. Do not mix v0.3.1 and v0.3.3 Release assets.

## Verification Boundary

The package was rebuilt from the v0.3.1 public snapshot plus only the sanitized three-file onboarding-v1 source diff named above. Sanitization, provenance/manifest validation, package tests and archive readback are recorded in `SANITIZATION_REPORT.md` and the private release receipt. No target-device authentication, group creation or service activation is part of this release.
