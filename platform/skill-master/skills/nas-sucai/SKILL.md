---
name: nas-sucai
description: Use when SuperMatrix needs to browse, search, download, upload, create directories for, or rename files in the company NAS material library.
---

# NAS Sucai

Use this skill for bounded NAS material-library file IO. The capability is the
standard answer for asks like "find 素材", "search 图片/视频", "download 素材
to local", "upload final assets back to the library", "create a sub-directory",
or "rename a remote file or directory".

## Boundary

- Six business actions only: `list`, `search`, `download`, `upload`, `mkdir`,
  `rename`. Plus an operator-only `probe` for setup/smoke validation.
- Delete is intentionally not implemented in v1.
- This is bounded file IO, not a general NAS administration tool. No mirror
  sync, no NAS web-UI automation, no asset OCR / tagging.

## Workflow

1. Run `python3 scripts/probe_nas_sucai.py` to confirm the endpoint is
   reachable and the cert fingerprint matches.
2. If probe succeeds, run one bounded action script (`list`, `search`,
   `download`, `upload`, `mkdir`, `rename`).
3. Prefer `search` and `list` before `download` or any write action so the
   caller works with stable remote paths.
4. Download files locally before asking Claude or Codex to inspect content.
5. Keep config in `~/.codex/nas-sucai.json`. Keep the password in one local
   secret source — `~/.codex/nas-sucai.secret`, `NAS_SUCAI_PASSWORD`, or the
   macOS Keychain service `codex-nas-sucai`.

## Output Contract

Each action prints exactly one JSON object on stdout and exits `0` on success
or `1` on failure.

Success envelope:

```json
{
  "status": "ok",
  "action": "<action>",
  "endpoint": {"label": "lan", "host": "...", "port": 21, "fingerprint": "..."},
  "result": { ... }
}
```

Failure envelope:

```json
{
  "status": "error",
  "action": "<action>",
  "code": "<stable code>",
  "message": "<human-readable message>"
}
```

Stable error codes upstream callers can branch on include
`password_unavailable`, `permission_required`, `endpoint_unreachable`,
`certificate_fingerprint_mismatch`, and `unexpected_error`.

## Validation

`python3 scripts/probe_nas_sucai.py` is the canonical readiness check. Inside
sandboxed runners, escalate shell permissions before running probe or any
action script. Without escalation, the scripts still return structured JSON
errors (no Python tracebacks).

## See Also: Material Index (separate `nas` capability)

For tag / product / visual-content search across already-scanned NAS roots,
the `nas` session maintains a separate index operator (NOT part of this
skill's six FTPS actions). It complements `search` / `list` here when callers
want to find assets by product name, deterministic path tags, or
OpenAI-derived visual tags rather than by FTPS path traversal.

- Canonical doc: `<SM_WORKSPACE_ROOT>/nas/docs/superpowers/notes/2026-05-04-nas-sucai-index-operator.md`
- Read-only CLI (other sessions may call directly):
  `python3 <SM_WORKSPACE_ROOT>/nas/scripts/nas_index.py query --product <name> | --tag <tag> | --text <kw>`
- Stats / coverage check: `... nas_index.py stats`
- Business-level lookup: spawn the `nas` session via `/api/spawn` (it owns
  scan scheduling, visual sampling cost, and result curation).

This skill itself stays bounded FTPS IO — index ops live in `nas` workspace
and use SQLite + amzdata + optional OpenAI, which is out of this skill's
scope by design.
