# Get Image URL

Reusable S.EE upload skill for turning local images into public links with complete upload metadata.

## Includes

- `curl`-backed upload transport for Cloudflare-compatible requests
- receiver-local token setup guidance
- a bundled Python upload script
- structured JSON output with direct URL, page URL, delete URL, file ID, hash, and source path

## Receiver Setup

After installation, read `SETUP.md` and create `~/.codex/get-image-url.json`.

## Feishu Console Limitation

In the current Feishu Codex console runtime, this skill works with:
- local absolute file paths
- files that were uploaded as file attachments and saved into `console/files/`

It does not currently work with inline chat images that only arrive as `[Image: ...]` references, because those image messages are not automatically materialized into local files for the agent.
