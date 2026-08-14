# Troubleshooting

## Feishu/Lark Does Not Reply

Check these first:

1. `lark-cli` is logged in.
2. The bot is in the root console group or target session group.
3. WebSocket event subscription is enabled.
4. `SM_ROOT_GROUP_ID` is the correct `chat_id`.
5. The Super Matrix process is running and can read `.env`.

## A Session Only Responds When the Bot Is @ Mentioned

Super Matrix defaults to plain-message handling for normal session groups. Only
sessions with `category = '外部'` intentionally require explicit bot mentions.

Check the session category and binding:

```bash
sqlite3 "$SM_RUNTIME_ROOT/data/supermatrix.db" \
  "SELECT s.name,s.category,s.status,b.group_id
   FROM sessions s JOIN bindings b ON b.session_id=s.id
   WHERE s.name='<session-name>' OR b.group_id='<chat-id>';"
```

Interpretation:

- If `category` is `外部`, mention-only behavior is expected.
- If it should be an internal session but is marked `外部`, fix the session
  metadata first.
- If it is not `外部` and still only receives mentioned messages, check whether
  the Feishu/Lark app subscribes to `im.message.receive_v1`, whether the bot is
  in the group, and whether message/chat/member read scopes are granted.
- After scope changes, re-run lark-cli authorization and restart Super Matrix.

Relevant code paths:

- `supermatrix/src/app/dispatcher.ts`
- `supermatrix/src/adapters/lark-cli/realClient.ts`
- `supermatrix/src/adapters/lark-cli/index.ts`

## `npm run self-check` Fails

Fix the first reported error before continuing. Common causes:

- Node.js version is too old.
- The configured port is already in use.
- `.env` is missing required values.
- SQLite path is not writable.
- The selected backend CLI is not installed or not logged in.

## `/new` Creates a Session but Work Does Not Run

Check:

- `SM_WORKSPACE_ROOT` exists and is writable.
- The backend CLI works in a normal terminal.
- The selected model is available to your account.
- The session group is bound to the expected session in the database.
