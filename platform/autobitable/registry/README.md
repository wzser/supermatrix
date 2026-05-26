# Bitable Webhook Registry

`registry/bitable-webhooks.json` is the private runtime registry used by
`autobitable`. The public repository intentionally ships only
`registry/bitable-webhooks.example.json`.

## Setup

```bash
cp registry/bitable-webhooks.example.json registry/bitable-webhooks.json
```

Then replace every placeholder locally:

- `DEMO_BASE_TOKEN_ALIAS`
- `tbl_DEMO_TABLE_ID`
- `vew_DEMO_VIEW_ID`
- `REPLACE_WITH_LOCAL_PER_WEBHOOK_SECRET`
- `demo-owner`
- `demo-target`

Do not commit the private `registry/bitable-webhooks.json` after filling real
table IDs, workflow IDs, webhook secrets, or business routing details.

## Rules

- The local registry is the adapter's execution source of truth.
- The Feishu/Lark Bitable ledger is a cross-session governance view only.
- Upsert ledger rows by stable `Webhook ID`; never let the ledger overwrite the
  local registry.
- Each webhook must have its own `security.secret`.
- Store business base tokens by alias only. Do not store real base tokens,
  cookies, Authorization headers, tenant tokens, or app credentials.
- `field_allowlist` should stay empty unless the webhook truly needs business
  fields in the payload.
- `status=active` entries must have passed dry-run.
- Script webhooks must use fixed argv arrays, params schema, idempotency, and
  receipt proof.
- Prompt webhooks must use owner-approved target sessions and receipt proof.

## Optional Ledger Sync

Set these values only in your local shell or untracked `.env`:

```bash
AUTOBITABLE_LEDGER_BASE_TOKEN=YOUR_LEDGER_BASE_TOKEN
AUTOBITABLE_LEDGER_TABLE_ID=YOUR_LEDGER_TABLE_ID
AUTOBITABLE_PUBLIC_WEBHOOK_URL=https://YOUR_PUBLIC_HOST/feishu/bitable/webhook
npm run ledger:sync
```

`AUTOBITABLE_PUBLIC_WEBHOOK_URL` is required for ledger sync because the
generated `POST` configuration and Feishu AI prompt must contain the actual
public webhook endpoint.

This URL must be your own domain/server endpoint. The public repository does
not provide a hosted autobitable ingress and intentionally uses
`https://YOUR_PUBLIC_HOST/...` placeholders only.

To send a generated Feishu AI configuration prompt:

```bash
AUTOBITABLE_PUBLIC_WEBHOOK_URL=https://YOUR_PUBLIC_HOST/feishu/bitable/webhook \
npm run prompt:send -- --webhook-id <webhook_id> --requester-session <source_session>
```

## Runtime History

Webhook run history belongs in local runtime storage such as
`data/webhook-runs.jsonl` or a private SQLite table. It is intentionally not
included in the public repository.
