# SuperMatrix MVP Smoke Test

> Manual verification after a clean checkout + bootstrap. Run `npm run verify` first for automated gates (lint:deps + typecheck + unit + adapter + e2e tests).

## Prerequisites

1. Node 22+ installed.
2. `npm install` in repo root.
3. repository root `.env` (or shell env) set with:
   - `SM_ROOT_GROUP_ID` — the Feishu group id the bot listens in as "root"
   - `SM_ROOT_USER_ID` — the owner's Feishu user id
   - `SM_WORKSPACE_ROOT` — absolute path where session workdirs will live
   - `SM_DB_PATH` — absolute path to the sqlite file
   - `SM_BACKEND` — `claude` or `codex`
   - `SM_LOG_LEVEL` — `debug` / `info` / `warn` / `error`
4. `@larksuite/cli` credentials configured with your local Feishu/Lark app.
5. `claude` (or `codex`) CLI on PATH.

## Checklist

### 1. Cold start

- [ ] `npm run start`
- [ ] Console prints `supermatrix starting` and subscribes to the root group without error.

### 2. /help in root

- [ ] In root group, send `/help`.
- [ ] Reply lists commands including `/new`, `/delete`, `/list`, `/restart` with Chinese descriptions.

### 3. /new claude alpha or /new codex alpha

- [ ] In root, send `/new claude alpha` for Claude Code or `/new codex alpha` for Codex.
- [ ] Workspace directory `$SM_WORKSPACE_ROOT/alpha` is created and git-initialized.
- [ ] A new Feishu user group is created and the owner is invited.
- [ ] Root replies `✓ 已创建 session 「alpha」…`.
- [ ] `session-catalog.json` exists under `$SM_WORKSPACE_ROOT/alpha/` (symlink to global catalog).

### 4. Prompt in user group

- [ ] In the alpha user group, send `ping`.
- [ ] A streaming card appears and is finalized with the assistant's reply.
- [ ] No error card; the message_run in sqlite ends with status `completed`.

### 5. /cancel during a long run

- [ ] In alpha user group, send a long prompt (e.g., `list every file recursively under /`).
- [ ] While it runs, send `/cancel`.
- [ ] Card finalizes with a cancellation note; the message_run row shows `failed` with an error mentioning the process exit.

### 6. /reset on idle

- [ ] After the prompt finishes, in alpha user group send `/reset`.
- [ ] Reply `✓ session 「alpha」上下文已清空`. Backend session id cleared in sqlite.

### 7. /restart on busy

- [ ] Start a long prompt again, then send `/restart`.
- [ ] Backend process is interrupted; session returns to `idle` with no backend session id.
- [ ] Reply `✓ session 「alpha」已强制重启`.

### 8. /list and /status

- [ ] In root, `/list` — alpha listed with `claude`, `idle`, relative creation time.
- [ ] In root, `/status alpha` — full details including workdir, backend session id (none after reset), created timestamp, purpose.

### 9. /delete alpha

- [ ] In root, `/delete alpha`.
- [ ] Alpha user group is dissolved; session row status becomes `deleted`; reply `✓ 已删除 session 「alpha」`.

### 10. Restart survives reboot

- [ ] Ctrl+C the CLI. Run `npm run start` again.
- [ ] Any session that was `busy` at shutdown with a `backend_session_id` should be flipped back to `idle` on boot (resumable via `claude --resume` on the next prompt). Busy sessions with no `backend_session_id` become `error`. Any `running` message_run should have been flipped to `timeout`.
- [ ] `/list` does not include the deleted `alpha`.

## Kimi backend (ACP)

适用：本机已装 kimi-cli 并 `kimi login`。`kimi info` 跑不通则跳过。

1. **基础就位** — `kimi info` 期望版本号。
2. **新建** — `/new test-kimi kimi`，群名以 `-kimi` 结尾。
3. **首轮** — 发问候消息，≤60s 收 final。
4. **多轮接续** — 紧接着问"刚才让你做什么"，验证 ACP session 持续。
5. **/cancel 中途** — 长任务发 `/cancel`，预期：进程 **不死**（`ps aux | grep "kimi acp"` 仍是同一 PID），Lark 卡片 cancelled。
6. **/backend 切换** — 切换 codex / 切回 kimi，群名后缀变化、上下文清空。
7. **重启 reconcile** — `/reload`，重启后 `ps aux | grep "kimi acp"` 应只有一个 PID（旧 ACP 已清理 / 新 ACP 重启）。
8. **共享单进程验证** — 同时打开 2-3 个 kimi session 各发一轮，`ps aux | grep "kimi acp"` 全程只有 1 个 PID。
9. **kimi term 不被误杀** — 在另一个 terminal 跑 `kimi`（交互式），SuperMatrix `/reload`，期望那个交互式 kimi **不被 reconcile 杀**（cmd 不含 acp）。
