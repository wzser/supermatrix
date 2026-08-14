# @larksuite/cli Spike Notes

**Status:** Verified end-to-end on 2026-04-11 against app `cli_REDACTEDAPPID` (PERSON_REDACTED). All 9 SDK client methods except `downloadAttachment` are wired. Smoke verified: send text (bot), create group (user, bot auto-invited), WebSocket event subscribe (bot) receiving real messages.

## Key realization

`@larksuite/cli` is **a shell binary**, not a JS module. The adapter shells out to `lark-cli` via `execFile` / `spawn` and parses JSON stdout. See `realClient.ts`.

## Identity model

Two identities, picked per-call via `--as user|bot`:

- `user` (user_access_token) — obtained via `lark-cli auth login` device flow. Scoped per user's granted scopes.
- `bot` (tenant_access_token) — obtained automatically from stored `appId`+`appSecret` (from `config init`). Scoped per app's enabled scopes.

`event +subscribe` supports `--as bot` only. Everything else supports both. Our adapter picks:

| verb | identity | reason |
|---|---|---|
| `subscribeInbound` | bot | only supported mode |
| `sendText` / postCard / updateCard / finalizeCard | bot | so the "voice" in groups is the app's bot |
| `createGroup` | user | `im:chat:create_by_user` scope (user grants interactively); bot-identity needs `im:chat:create` at app level (not enabled here) |
| `inviteUser` | user | matches createGroup's owning identity |
| `dissolveGroup` | user | best-effort bot-leave via raw API; group is NOT deleted (no API exists) |

## Confirmed commands

### 1. Send text message

```
lark-cli im +messages-send --as bot --chat-id oc_xxx --text "hello"
```

Returns:

```json
{"ok": true, "identity": "bot",
 "data": {"chat_id": "oc_...", "create_time": "2026-04-11 19:59:35", "message_id": "om_..."}}
```

Note: `+messages-send` does **not** accept a `--format` flag (it's JSON by default).

### 2. Create a private group with the bot auto-invited

```
lark-cli im +chat-create --as user --name "SuperMatrix Console" --type private --bots cli_REDACTEDAPPID
```

Returns:

```json
{"ok": true, "identity": "user",
 "data": {"chat_id": "oc_...", "chat_type": "private",
          "owner_id": "ou_...", "name": "SuperMatrix Console",
          "share_link": "https://applink.feishu.cn/..."}}
```

Required scope: `im:chat:create_by_user` (user grants via `auth login --scope "im:chat:create_by_user"`). The app itself does not need `im:chat:create`.

### 3. Subscribe to inbound messages (WebSocket, long-running, NDJSON)

```
lark-cli event +subscribe --as bot --event-types im.message.receive_v1 --compact --quiet
```

Each event line (with `--compact`):

```json
{"type": "im.message.receive_v1",
 "chat_id": "oc_...",
 "chat_type": "group",
 "content": "hello",
 "create_time": "1775908935152",
 "id": "om_...",
 "message_id": "om_...",
 "message_type": "text",
 "sender_id": "ou_...",
 "timestamp": "1775908935456"}
```

`--compact` strips the raw `content` wrapper (`{"text": "hello"}`) into the plain string `"hello"`. Attachments are NOT surfaced in compact mode — if we later need attachments we switch to non-compact and parse ourselves.

**Single-instance lock:** `event +subscribe` allows only one connection per app. Competing instances cause server-side event splitting. Our adapter takes the lock when `subscribeInbound` is called; `--force` is avoided.

### 4. Invite user to group

```
lark-cli api POST /open-apis/im/v1/chats/<chat_id>/members \
  --params '{"member_id_type":"open_id"}' \
  --data '{"id_list":["ou_..."]}' \
  --as user
```

### 5. Bot-leave (our `dissolveGroup` fallback)

```
lark-cli api DELETE /open-apis/im/v1/chats/<chat_id>/members \
  --params '{"member_id_type":"app_id"}' \
  --data '{"id_list":["cli_REDACTEDAPPID"]}' \
  --as user
```

Feishu API does **not** expose a chat-delete endpoint. The closest approximation is having the bot leave the group — it stops receiving events from that group, and our sqlite marks the session `deleted`. The group itself stays visible to the user in Feishu.

### 6. Download attachment (NOT WIRED in MVP)

```
lark-cli im +messages-resources-download --as bot --type file|image \
  --message-id om_... --file-key img_... --output <relative_path>
```

`--output` must be a relative path (no `..`). The MVP does not handle attachments — `subscribeInbound` uses `--compact` which strips attachment metadata. `realClient.downloadAttachment` currently throws. Re-enable by:

1. Removing `--compact` from subscribe (or dual-subscribing)
2. Parsing raw `content` JSON for `<image .../>`, `<file .../>` tags (see old project's `extractManagedAttachment`)
3. Plumbing `message_id` into `LarkSdkClient.downloadAttachment` signature

## Card UX simplification

`LarkSdkClient` exposes `postCard` / `updateCard` / `finalizeCard` for streaming card-based replies. The MVP does **not** use real interactive cards. Instead:

- `postCard` → sends a plain text message, returns the message_id as the `CardId`
- `updateCard` → throttled to at most one send per 60s per card (prevents flooding during long runs)
- `finalizeCard` → sends one final plain text message

This means each run produces 2-3 bot messages rather than one updating card. Clean enough for MVP; upgrade to real `msg_type: interactive` cards later.

## Config init (already done)

```
appId:       cli_REDACTEDAPPID
userOpenId:  ou_REDACTEDOPENID
userName:    PERSON_REDACTED
identity:    user (device flow)
tokenStatus: valid (refresh weekly)
config file: ~/.lark-cli/config.json
```

## Scopes granted

User token currently has 127 scopes. Relevant ones:

- `im:message` / `im:message.send_as_user` — send text
- `im:message:readonly` / `im:message.group_msg:get_as_user` — read messages
- `im:chat:read` / `im:chat:update` / `im:chat.members:read` / `im:chat.members:write_only`
- `im:chat:create_by_user` — granted 2026-04-11 for `/new`
- `docs:document.media:download` / `drive:file:download` — media download

Not granted (would need Feishu dev-console approval):

- `im:chat:create` (bot-identity group creation)

## Environment variables the adapter cares about

| var | source | example |
|---|---|---|
| `LARK_APP_ID` | `.env.local` | `cli_REDACTEDAPPID` |
| `SM_ROOT_GROUP_ID` | `.env.local` | `oc_REDACTEDCHATID` |
| `SM_ROOT_USER_ID` | `.env.local` | `ou_REDACTEDOPENID` |
| `SM_LARK_CLI_PATH` | optional | defaults to `node_modules/.bin/lark-cli` |
| `LARK_CLI_NO_PROXY` | set by adapter | silences stderr proxy warnings |

## Proxy warning

If `https_proxy` is set in shell, `lark-cli` prints a warning to stderr about credentials transiting via the proxy. Not a functional issue. The adapter sets `LARK_CLI_NO_PROXY=1` in subprocess env by default to mute it (override via `noProxy: false` in `RealLarkClientConfig`).

## Root group for SuperMatrix

- **chat_id:** `oc_REDACTEDCHATID`
- **name:** `SuperMatrix Console`
- **owner:** PERSON_REDACTED
- Bot `cli_REDACTEDAPPID` is a member.
- Bot has verified ability to send and receive in this group.

## Retired from this machine

- `com.LOCAL_USER.feishu-console` launchd agent was unloaded 2026-04-11 so SuperMatrix can own the single-instance event subscriber. Plist kept at `~/Library/LaunchAgents/com.LOCAL_USER.feishu-console.plist` — reload with `launchctl load <plist>` to resurrect.
