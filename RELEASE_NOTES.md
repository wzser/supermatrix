# Super Matrix v0.3.5

## Onboarding V1 Package Rebuild

The sanitized onboarding-v1 package was rebuilt from the exact framework source commit `543c765986c17df82ffec023426d590eb3757a80`. This is a patch-level publication correction: it preserves the runtime behavior from v0.3.4 and carries the isolated bot-identity contract test change from that source commit.

## Updated Platform Capabilities

- The package and lockfile are versioned `0.3.5`, and the installation contract is bound to the matching tag, archive, checksum manifest and extraction prefix.
- The public provenance manifest remains closed to the reviewed platform inputs and records the exact gitmaster publication input used for this rebuild.
- The package excludes credentials, runtime state, private evidence, device authentication, group creation and service activation.

## Upgrade From v0.3.4

No runtime migration is required. New installations must use the exact v0.3.5 Release assets and verify the tag, archive digest and `SHA256SUMS` before extraction. Do not mix assets from other releases. Existing installations remain unchanged until a separately authorized upgrade.

## Verification Boundary

The release passed the configured sanitization scan, archive member/readback checks and package-level validation. These checks do not constitute target-device authentication, group creation, service activation or live acceptance.
