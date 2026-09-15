# Autobitable public-safe profile

This directory is a public-safe configuration profile for the existing
`autobitable` owner. It is not a second adapter, queue, supervisor, reverse
proxy, or settlement service.

`public-safe/src/server.mjs` is an entry-point-only facade. It imports the
owner implementation from `../../src/server.mjs` and enables its
`publicSafeProfile` parameter. Therefore ingress, registry loading, secret
verification, idempotency, concurrency claims, Spawn2.0 dispatch, settlement,
run-ledger persistence, and restart recovery have one source of truth.

The owner profile admits only fixed-target prompt delegation with:

- strict HTTP payload keys: `webhook_id`, `table_id`, `view_id`, `record_id`,
  optional `triggered_at`, and optional allowlisted `fields`;
- a per-webhook `security.secret_sha256`, never a plaintext registry secret;
- a record-bound idempotency key;
- no dynamic target, notify-card route, writeback implementation, or
  post-dispatch notification route.

The profile keeps the owner's concurrency, idempotency, queue-ref, settlement,
and restart-recovery paths. `settlement_mode=dispatch_only` means only that
Spawn2.0 accepted dispatch; it never treats `ok: true` in a transport response
as business completion. Receipt verification remains the owner's
`fetchChildSessionResult` plus `verifyPromptResult` path.

## Local verification

From this directory, run:

```bash
npm run verify
```

The tests use local HTTP fixtures only. They cover facade lineage, profile
gating, idempotent duplicate admission, a cross-day retry identity derived
from persisted `triggered_at`/`idempotency_key`, and real Spawn2.0 result shapes:
`commStatus=failed` with transport `ok:true`, `waiting_child`, and a completed
result with a null reply. None is accepted as business success without the
owner's actual receipt proof.

## Configuration inputs

Copy `registry/bitable-webhooks.empty.json` to `registry/bitable-webhooks.json`
(ignored locally) and use `examples/webhook.prompt.json` as a shape example.
`config/` contains templates only. Secret generation is a local utility; the
secret stays in an untracked env file and only its SHA-256 belongs in the
registry.

Run the existing owner entry point or this facade from the repository checkout.
Use absolute paths for tenant state so a copied profile cannot silently read or
write another checkout's registry or run ledger:

```bash
AUTOBITABLE_REGISTRY_PATH=/absolute/path/to/private-autobitable/registry/bitable-webhooks.json \
AUTOBITABLE_RUN_STORE_PATH=/absolute/path/to/private-autobitable/data/webhook-runs.jsonl \
node /absolute/path/to/platform/autobitable/public-safe/src/server.mjs
```

The facade accepts only fixed-target prompt delegation. The child session owns
the business work; if that work has an approved table result writeback, it uses
the existing `feishu-sync-enqueue` queue and its terminal read-back contract.
This profile adds no writeback implementation and does not treat dispatch
acceptance as business completion.

Native OS process management and the existing tunnel own startup persistence
and ingress transport. Configure those in the host environment; do not copy
production adapter, supervisor, or tunnel scripts into this profile.

The facade is intentionally repository-bound. It must not be copied as an
independent installable adapter, because doing so would recreate the lifecycle
mechanisms this profile is required to reuse.
