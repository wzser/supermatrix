# NAS Sucai Setup

The skill is ready when the runtime can probe the NAS over explicit FTPS,
verify the pinned cert fingerprint, and authenticate using the configured
account from a local secret source.

## Required Config

Create `~/.codex/nas-sucai.json` with the business-named schema:

```json
{
  "transport": "ftps",
  "lan_host": "192.168.31.67",
  "lan_port": 21,
  "username": "ftt-codex-1",
  "remote_root": "/",
  "passive_mode": true,
  "timeout_seconds": 8.0,
  "certificate_sha256": "REPLACE_WITH_PINNED_SHA256",
  "keychain_service": "codex-nas-sucai",
  "validation_directory": "/2026产品图片/codex-smoke",
  "control_encoding": "gb18030",
  "password_file": "/Users/your-user/.codex/nas-sucai.secret",
  "password_env_var": "NAS_SUCAI_PASSWORD"
}
```

## Secret Source

Provide the password in exactly one local-only place. The runtime probes them
in this order:

1. `NAS_SUCAI_PASSWORD` environment variable.
2. Local secret file (default path `~/.codex/nas-sucai.secret`).
3. macOS Keychain service `codex-nas-sucai` keyed on the `username`.

Recommended local-file setup:

```bash
printf '%s\n' '<password>' > ~/.codex/nas-sucai.secret
chmod 600 ~/.codex/nas-sucai.secret
```

Keychain alternative:

```bash
security add-generic-password -U -a 'ftt-codex-1' -s 'codex-nas-sucai' -w '<password>'
```

Never commit secrets, certificate material, or passwords. Do not echo the
password back into documentation or commit messages.

## Legacy Migration

If `~/.codex/nas-sucai.json` does not yet exist but `~/.codex/nas-ftps.json`
does, the runtime falls back to the legacy file. Operators migrating from the
personal `nas-ftps` bundle can either copy in place or rely on the fallback:

```bash
test -f ~/.codex/nas-sucai.json   || cp ~/.codex/nas-ftps.json   ~/.codex/nas-sucai.json
test -f ~/.codex/nas-sucai.secret || cp ~/.codex/nas-ftps.secret ~/.codex/nas-sucai.secret
```

Public docs and examples should only advertise the `nas-sucai` names.

## Validation

```bash
cd ~/.claude/skills/nas-sucai           # or ~/.agents/skills/nas-sucai
python3 scripts/probe_nas_sucai.py
```

A ready setup prints JSON with `"status": "ok"` and the configured LAN
endpoint. Inside sandboxed runners, escalate shell permissions before running
probe or any action script. Without escalation the scripts still return
structured JSON errors (`password_unavailable`, `permission_required`, ...)
instead of Python tracebacks.

## Smoke Run (optional but recommended)

```bash
python3 scripts/list_nas_sucai.py   --path /2026产品图片
python3 scripts/search_nas_sucai.py --path /2026产品图片 --query codex-smoke
```

Write smoke uses the configured `validation_directory`; small artifacts may
remain there because delete is out of scope for v1.
