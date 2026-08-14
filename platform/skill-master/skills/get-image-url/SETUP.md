# Setup

This skill needs a receiver-local S.EE API token.

## Goal

Allow the installed skill to upload local files to S.EE without storing any secret in the shared repo or installed skill folder.

## Local Dependency

The upload script requires `curl` on `PATH`.

Validation:

```bash
curl --version
```

## Required Config

Create one of these receiver-local inputs:

- `~/.codex/get-image-url.json` with `api_token`
- `SEE_API_TOKEN` in the current process environment

Optional default domain:

- `default_domain` in `~/.codex/get-image-url.json`
- `SEE_DEFAULT_DOMAIN` in the current process environment

Recommended file format:

```json
{
  "api_token": "your-s-ee-token",
  "default_domain": "optional-domain"
}
```

## Local Files

This skill may create or update only these receiver-local files:

- `~/.codex/get-image-url.json`
- uploaded source files that already exist in the current project

Do not place credentials inside the installed skill directory.

## Setup Workflow

1. Write `~/.codex/get-image-url.json` with your S.EE token.
2. Keep the config outside the shared repo.
3. Verify `curl` is available.
4. Run a real upload with a disposable local image.
5. Confirm the response includes `url`, `page`, and `delete_url`.

## Validation

Run:

```bash
python3 scripts/see_upload.py upload /absolute/path/to/image.png
```

The skill is ready when the command returns JSON with `success: true` and at least one object in `uploaded`.

## Feishu Chat Input Note

This skill uploads local files. In the current Feishu Codex console integration, a chat image preview is not enough by itself unless the runtime also exposes a real local file path.

Reliable inputs are:
- a local absolute file path
- a file attachment that the console has already saved under `console/files/`

If a chat message only shows `[Image: ...]` and no local file is available, the upload script cannot run on that image yet.

## Secret Handling

- Store the S.EE token only in `~/.codex/get-image-url.json`, `SEE_API_TOKEN`, or a one-off `--token` flag.
- Never commit the token file.
- Never echo the live token back to the user after writing it.
