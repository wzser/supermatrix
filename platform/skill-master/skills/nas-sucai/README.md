# NAS Sucai

`nas-sucai` is the SuperMatrix-wide shared capability for bounded file IO
against the company NAS material library. Other sessions should reach for it
directly instead of routing through a dedicated NAS helper session.

## Six Business Actions

| Action     | Purpose                                       | Required args                          |
|------------|-----------------------------------------------|----------------------------------------|
| `list`     | List a remote directory                       | `--path`                               |
| `search`   | Recursive name search under a remote root     | `--path`, `--query`                    |
| `download` | Download one remote file to a local path      | `--remote`, `--local`, `--overwrite`   |
| `upload`   | Atomically upload a local file to a remote    | `--local`, `--remote`                  |
| `mkdir`    | Create one remote directory                   | `--path`                               |
| `rename`   | Rename / move one remote path                 | `--src`, `--dst`                       |

A separate `probe` script is provided for setup / smoke checks only.

Delete is intentionally **out of scope** for v1. Whole-directory mirroring,
NAS administration, and higher-level asset intelligence (OCR, tagging,
semantic search) are also out of scope.

## Output Contract

Every script prints exactly one JSON object on stdout with a stable envelope:

- `status`: `ok` or `error`
- `action`: which action this is (`list`, `search`, `download`, ...)
- on success: `endpoint` (label/host/port/fingerprint) and `result`
- on failure: stable `code` and human `message`

This lets upstream callers consume results programmatically without parsing
prose.

## Dependencies

- Python 3 standard library only (`ftplib`, `ssl`, `json`, ...).
- Local config at `~/.codex/nas-sucai.json`.
- One local secret source: `~/.codex/nas-sucai.secret`, environment variable
  `NAS_SUCAI_PASSWORD`, or macOS Keychain service `codex-nas-sucai`.
- Reachable FTPS endpoint on the company LAN.

See `SETUP.md` for one-time configuration and `SKILL.md` for the activation
contract.
