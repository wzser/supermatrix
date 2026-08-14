# Super Matrix Commands

Super Matrix slash commands are sent in the Feishu/Lark root console group or a
bound session group. They control local session lifecycle and routing; they are
not pass-through commands for Claude Code or Codex.

## Common Commands

| Command | Purpose | Typical place |
|---|---|---|
| `/help` | Show available commands. | Root console or session group |
| `/status` | Show session list, backend, and run state. | Root console |
| `/new <backend> <name>` | Create a session, workspace, and Feishu/Lark group. | Root console |
| `/cancel` | Interrupt the current run for the bound session. | Session group |
| `/reset` | Clear the bound session context. | Session group |
| `/next <text>` | Queue a follow-up task after the current run. | Session group |
| `/now <text>` | Inject context into the active Claude/Codex run. | Session group |
| `/btw <text>` | Add side-channel context without interrupting the current run. | Session group |
| `/branch [name]` | List, create, or switch conversation branches. | Session group |
| `/usage` | Show a security-filtered provider quota snapshot. | Root console |

## Examples

Create a Claude Code session:

```text
/new claude alpha
```

Create a Codex session:

```text
/new codex alpha
```

Create a Kimi session:

```text
/new kimi alpha
```

Steer an active Claude/Codex run and create a context branch:

```text
/now keep the public API backward compatible
/branch experiment
```

Bind a session to the Super Matrix source directory:

```text
/new codex supermatrix-root --workdir /ABS/PATH/TO/supermatrix-public/supermatrix --chat-name "Super Matrix Root" Super Matrix framework root maintainer
```

## Notes

- Backend names depend on your local configuration and installed CLIs.
- `/now` does not start an idle session and is not supported by Kimi in v0.2.0.
- `/branch` changes backend conversation context only; it does not create a Git branch.
- Work happens under `SM_WORKSPACE_ROOT` unless `--workdir` is provided.
- Do not put API keys, real Bitable tokens, chat IDs, or private server URLs in
  slash-command text that will be committed or copied into public docs.
