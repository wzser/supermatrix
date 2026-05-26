# S.EE API Notes

This skill uses the official S.EE file API, not the SM.MS compatibility layer.

## Official Endpoints Used In v1

- upload file:
  `POST https://s.ee/api/v1/file/upload`
- validate auth and discover allowed domains:
  `GET https://s.ee/api/v1/file/domains`

Official docs:

- [API Overview](https://s.ee/docs/developers/api/)
- [Getting Started](https://s.ee/docs/developers/)
- [Upload File](https://s.ee/docs/api/UploadFile/)
- [Get File Available Domains](https://s.ee/docs/api/GetFileAvailableDomains/)

## Upload Fields

The v1 upload script sends:

- `file`
- `domain` when selected
- `custom_slug` when selected
- `is_private=1` when `--private` is used

The script always uploads with `multipart/form-data`.

## Auth Notes

The overview and getting-started docs show the official auth pattern as:

```text
Authorization: Bearer <token>
```

The upload reference examples and SM.MS compatibility examples also show simpler `Authorization` usage without an explicit `Bearer` prefix.

To keep v1 aligned with the official API while tolerating doc inconsistencies, the bundled script:

1. sends `Authorization: Bearer <token>` first
2. retries once with the raw token only if the first auth attempt is rejected
3. uses local `curl` transport because validation showed Python `urllib` requests being blocked by Cloudflare while equivalent `curl` requests succeeded

This retry behavior is an internal compatibility fallback, not a separate public interface.

## Future Expansion Notes

These documented endpoints are intentionally not exposed as first-class commands in v1:

- [Delete File](https://s.ee/docs/api/DeleteFile/)
- [Get Private File Download URL](https://s.ee/docs/api/GetPrivateFileDownloadURL/)
- file upload history endpoint from the developer docs

If the skill expands beyond upload-only behavior, keep the public CLI stable and add separate commands rather than overloading `upload`.
