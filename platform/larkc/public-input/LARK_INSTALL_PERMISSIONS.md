# Public Lark installation contract

Version: `lark-install-permissions.v1`
Pinned CLI: `lark-cli 1.0.93`
Card callback carrier: `@larksuiteoapi/node-sdk 1.73.3`
Installer model: none. The recipient follows the released Markdown and uses the native commands below.

This is a public input document. Replace every placeholder locally. Do not put app secrets, user names, tenant IDs, chat/resource IDs, private paths, Keychain files, runtime databases, or production records into this directory.

## 1. Permission model

There are four independent gates:

| Gate | What it controls | Who completes it |
|---|---|---|
| User OAuth scope | What the consenting user token may call | Installing user, with tenant-admin approval where the consent page requires it |
| App scope | What the bot/tenant token and SDK app may call | App administrator; publish the app version after changes |
| Console event/callback | Whether the app receives a named event or card callback | App administrator; enable the exact feature and publish |
| Resource share | Whether that identity can touch a particular chat, Base/table, Wiki node/space, Drive file/folder or comment target | Resource owner/admin |

Scopes never grant membership in every resource. A successful OAuth flow or app publication is not resource access. The recipient must record the selected resource owner, identity, role, and read-back evidence locally.

The machine-readable source is [`lark-install-permissions.v1.json`](./lark-install-permissions.v1.json). It keeps the full operation-to-scope mapping and conditional feature gates.

## 2. Scope sets

The core user OAuth set is the sorted union of the core messaging, contact, and Base operations:

```text
base:app:create,base:field:create,base:field:read,base:field:update,base:record:create,base:record:read,base:record:update,base:table:create,base:table:delete,base:table:read,base:table:update,base:view:write_only,contact:user.basic_profile:readonly,contact:user:search,im:chat.members:read,im:chat.members:write_only,im:chat:create_by_user,im:chat:read,im:chat:update,im:message,im:message.send_as_user,im:message:readonly
```

The core app set is the bot equivalent for messaging and Base creation/writeback:

```text
base:app:create,base:field:create,base:field:read,base:field:update,base:record:create,base:record:read,base:record:update,base:table:create,base:table:delete,base:table:read,base:table:update,base:view:write_only,contact:user.basic_profile:readonly,contact:user:search,docs:permission.member:create,im:chat.members:read,im:chat.members:write_only,im:chat:create,im:chat:read,im:chat:update,im:message,im:message.p2p_msg:readonly,im:message:readonly,im:message:send_as_bot,im:message:update
```

These are the complete sets only for the capabilities selected in this document. Add Wiki, Drive metadata, or comment-specific conditional scopes only when that feature is enabled. Never use a wildcard and never union mutually exclusive provider alternatives.

### Conditional additions

| Enabled operation | User OAuth scopes | App scopes | Console/admin action | Resource share |
|---|---|---|---|---|
| Wiki `+node-list` | `wiki:node:retrieve` | `wiki:node:retrieve` | Publish/admin-approve if required | Share the target space/node |
| Wiki `+node-create` | `wiki:node:create`, `wiki:node:read`, `wiki:space:read` | Same | Publish/admin-approve if required | Give create access to target space/parent |
| Drive metadata/download | `drive:drive.metadata:readonly`, `drive:file:download` | Same | Publish/admin-approve if required | Share target folder/file |
| `drive +list-comments` | `docs:document.comment:read`; Wiki target also `wiki:node:retrieve` | Same | Publish/admin-approve if required | Comment-read access on exact target |
| `drive +add-comment` | `drive:drive.metadata:readonly`, `docx:document:readonly`, `docs:document.comment:create`, `docs:document.comment:write_only` | Same | Publish/admin-approve if required | Comment-write access on exact target |
| `drive +add-reply` | `docs:document.comment:create`; Wiki target also `wiki:node:read` | Same | Publish/admin-approve if required | Existing comment and reply access |
| Card callback | none | `im:message:readonly`, `im:message:send_as_bot`, `im:message:update` | Enable card callback configuration and publish | Bot is in the card's chat |
| Message receive event | none | `im:message.p2p_msg:readonly` | Enable `im.message.receive_v1` only if that consumer is enabled | Bot is in the receiving chat |

For Drive operations, the CLI/provider may expose alternative scopes for different API paths. An alternative is not an additional mandatory scope: choose the scope set returned by the selected `lark-cli` shortcut/schema for the enabled operation.

## 3. Native CLI configuration

Use a new named profile in the recipient's isolated environment. The commands below are the native CLI commands; there is no dedicated installer and no global profile mutation.

```sh
PROFILE=public-install

# Visible help checks; no authorization or remote write.
lark-cli --version
lark-cli config init --help
lark-cli profile --help
lark-cli auth login --help
lark-cli schema --help

# Deterministic sorted comma union for the selected user operations.
REQUIRED_USER_SCOPES=$(node -e 'const m=require("./public-input/lark-install-permissions.v1.json"); process.stdout.write([...new Set(m.identities.user_oauth.required_scopes)].sort().join(","))')
REQUIRED_USER_SCOPES_SPACE=$(printf '%s' "$REQUIRED_USER_SCOPES" | tr ',' ' ')

# Human-visible setup for a new named profile. Run only after the app admin/user agrees.
lark-cli config init --new --name "$PROFILE" --brand feishu

# REQUIRED_USER_SCOPES is the exact sorted comma union for enabled user operations.
lark-cli --profile "$PROFILE" auth login --no-wait --json --scope "$REQUIRED_USER_SCOPES"

# auth check accepts a space-separated scope list; login above intentionally uses one comma union.
lark-cli --profile "$PROFILE" auth check --json --scope "$REQUIRED_USER_SCOPES_SPACE"
lark-cli --profile "$PROFILE" auth scopes --json
```

Build `REQUIRED_USER_SCOPES` from the JSON manifest, sort it bytewise, remove duplicates, and join with commas. Build `REQUIRED_USER_SCOPES_SPACE` from the same sorted items joined with spaces. Do not repeat `--scope`, invent `config`/`schema` subcommands, pass the secret as an argument, or use `--force-init` to overwrite an existing workspace profile. Keep the app secret in a hidden prompt or approved secret manager.

The 1.0.93 help verification used these exact command families: `config init --new`, `profile` (`add/list/remove/rename/use`), `auth login --scope`, `auth check --scope`, `auth scopes`, and `schema <service.resource.method>`. The live verification host may have a later CLI; record its version separately and do not silently substitute it for the pinned release.

## 4. Base schema and writeback contract

The public example is intentionally tenant-neutral:

```json
{
  "table_name": "Example Table",
  "fields": [
    {"name": "Title", "type": "text", "primary": true},
    {"name": "Status", "type": "select", "multiple": false, "options": [{"name": "Todo"}, {"name": "Done"}]},
    {"name": "Notes", "type": "text"}
  ]
}
```

Use the exact operation mapping below. `BASE_TOKEN`, `TABLE_ID`, `FIELD_ID`, `VIEW_ID`, and `RECORD_ID` are local placeholders, never committed resource IDs.

| Operation | Exact CLI command | Required scopes |
|---|---|---|
| Create Base | `base +base-create` | User: `base:app:create`, `base:table:read`, `base:table:create`, `base:table:update`, `base:table:delete`. Bot: same plus `docs:permission.member:create`. |
| Create table | `base +table-create` | `base:table:create`, `base:field:read`, `base:field:create`, `base:field:update`, `base:view:write_only` |
| Create/list/get/update field | `base +field-create`, `+field-list`, `+field-get`, `+field-update` | `base:field:create`, `base:field:read`, `base:field:update` respectively |
| List tables | `base +table-list` | `base:table:read` |
| Read records | `base +record-list`, `+record-get` | `base:record:read` |
| Create records | `base +record-batch-create` | `base:record:create` |
| Update records | `base +record-batch-update` | `base:record:update` |
| Create-or-update | `base +record-upsert` | `base:record:create`, `base:record:update` |

The safe preparation/readback sequence is:

```sh
lark-cli --profile "$PROFILE" base +base-create --as user --name "Example Base" \
  --table-name "Example Table" \
  --fields '[{"name":"Title","type":"text"},{"name":"Status","type":"select","multiple":false,"options":[{"name":"Todo"},{"name":"Done"}]}]' \
  --dry-run

lark-cli --profile "$PROFILE" base +table-list --as user --base-token "$BASE_TOKEN"
lark-cli --profile "$PROFILE" base +field-list --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID"
lark-cli --profile "$PROFILE" base +field-get --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" --field-id "$FIELD_ID"
lark-cli --profile "$PROFILE" base +record-list --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID"
lark-cli --profile "$PROFILE" base +record-batch-create --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
  --json '{"create_records":[{"Title":"Public example","Status":["Todo"]}]}' --dry-run
lark-cli --profile "$PROFILE" base +record-batch-update --as user --base-token "$BASE_TOKEN" --table-id "$TABLE_ID" \
  --json '{"update_records":{"RECORD_ID":{"Status":["Done"]}}}' --dry-run
```

The last two commands are preview examples. A real recipient must first obtain explicit ownership/resource access and then use the native write command, save returned IDs, and read back the semantic table/field/record state with the intended identity. An exit code, queued request, or changed remote hash is not sufficient. `+record-upsert` chooses create versus update by `record_id`, not by a business key.

## 5. Card callback and SDK WS contract

The existing `card-callback/` broker is an HTTP-only carrier. The public allowlist is in [`card-callback-public-manifest.json`](./card-callback-public-manifest.json), with placeholders in [`card-callback.env.example`](./card-callback.env.example). The dependency is exactly `@larksuiteoapi/node-sdk@1.73.3`; do not publish private e2e tests or copy local tool paths.

The framework owner (`codexroot`) must integrate the callback into the existing shared SDK `WSClient`:

1. Register `card.action.trigger` as a callback and return a valid provider response for every card action within the ACK window, including ordinary card actions.
2. Parse the SDK event's action value and route only `value.__ask_user === true` with a string token to `POST http://127.0.0.1:${BROKER_PORT:-8787}/click` as `{ "token": "...", "value": "..." }`.
3. Keep the broker HTTP-only. Do not start a second `lark-cli event consume` process for the same app; the provider marks this callback single-consumer.
4. Enable callback configuration in the developer console, publish the app version, add the bot to the destination chat, and perform a real click round-trip before calling the feature complete.

`card.action.trigger` is a callback, not the ordinary `im.message.receive_v1` event. The latter is conditional and requires `im:message.p2p_msg:readonly` only when its consumer is enabled. No default contract requests a comment event subscription; comment read/write is an operation-level feature above.

## 6. Acceptance commands

Run the static/public-input checks from the checkout containing this directory:

```sh
node public-input/verify-public-input.mjs
(cd card-callback && npm ci --ignore-scripts && npm test)
(cd card-callback && npm_config_registry=https://registry.npmjs.org npm audit --omit=dev)
```

For a pinned CLI installation, run the help checks in §3 and record the exact `lark-cli --version` output. For authenticated acceptance, run `auth scopes --json`, `auth check --json`, then the selected read/list commands, followed by one explicitly authorized write and semantic readback. Do not include live output in a public commit.

## 7. Official references

- [lark-cli v1.0.93 Base shortcuts](https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/base)
- [lark-cli v1.0.93 Wiki shortcuts](https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/wiki)
- [lark-cli v1.0.93 Drive shortcuts](https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/drive)
- [lark-cli v1.0.93 IM shortcuts](https://pkg.go.dev/github.com/larksuite/cli@v1.0.93/shortcuts/im)
- [Official card callback guidance](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-card-action-reply.md)
