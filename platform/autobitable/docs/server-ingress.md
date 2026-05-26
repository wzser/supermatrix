# Autobitable Server Ingress

`autobitable` is a local adapter. Feishu/Lark Bitable automation needs a public
HTTPS endpoint, but Super Matrix core and private runtime ports must remain
local-only.

This repository does not include a hosted ingress service and must not expose
any private Super Matrix server address. If you enable this feature, you need to
bring your own public domain and server/reverse proxy, then point
`AUTOBITABLE_PUBLIC_WEBHOOK_URL` at that address.

## Recommended Shape

```text
Feishu/Lark Bitable
  -> https://YOUR_PUBLIC_HOST/feishu/bitable/webhook
    -> reverse proxy on public server
      -> private tunnel
        -> local autobitable adapter 127.0.0.1:<AUTOBITABLE_PORT>
```

Do not expose Super Matrix core ports such as `SM_API_PORT` directly to the
public internet.

## Local Adapter

```bash
AUTOBITABLE_PORT=3510 \
AUTOBITABLE_WEBHOOK_SECRET=REPLACE_WITH_LOCAL_SECRET \
SM_API_BASE=http://127.0.0.1:3501 \
npm run dev
```

The adapter exposes:

- `GET /health`
- `POST /feishu/bitable/webhook`
- `POST /webhooks/bitable`

## Public Proxy

Before configuring Feishu/Lark automation, prepare:

- A domain you control, such as `https://YOUR_PUBLIC_HOST`.
- A small public server, reverse proxy, or managed tunnel endpoint that can
  terminate HTTPS.
- A private tunnel from that public endpoint to the machine running Super
  Matrix.

Use one of these patterns:

- Private overlay network such as Tailscale or WireGuard.
- SSH reverse tunnel to a public reverse proxy.
- A dedicated small server that terminates TLS and forwards only the
  autobitable webhook path.

The proxy should forward only the webhook and health endpoints required for
operations. Keep all other local Super Matrix services inaccessible from the
public internet. Do not publish or reuse someone else's server address in
examples, registry files, Feishu workflow prompts, or documentation.

## Security Requirements

- Use HTTPS for the public endpoint.
- Validate a per-webhook `X-SM-Webhook-Secret` or equivalent Feishu signature.
- Keep webhook secrets out of committed files.
- Bind tunnel listener ports to the public server's loopback interface when
  possible.
- Use a dedicated tunnel key; do not reuse personal SSH keys.
- Limit request body size and request duration.
- Do not log webhook secrets, bearer tokens, cookies, Authorization headers, or
  full business payloads.
- Health checks must not expose private session state.

## Smoke Test

```bash
curl -i https://YOUR_PUBLIC_HOST/health
curl -i -X POST https://YOUR_PUBLIC_HOST/feishu/bitable/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-SM-Webhook-Secret: REPLACE_WITH_LOCAL_PER_WEBHOOK_SECRET' \
  -d '{"webhook_id":"wh_demo_button_to_prompt","table_id":"tbl_DEMO_TABLE_ID","view_id":"vew_DEMO_VIEW_ID","record_id":"rec_DEMO_RECORD_ID","dry_run":true}'
```

Expected result:

- `/health` returns `200`.
- webhook dry-run reaches the local adapter.
- requests with the wrong secret return `401`.
- `SM_API_PORT` and other Super Matrix internal ports are not reachable from
  the public internet.
