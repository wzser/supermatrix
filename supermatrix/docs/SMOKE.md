# SuperMatrix MVP Smoke Test

> Manual verification after a clean checkout + bootstrap. Run `npm run verify` first for automated gates (lint:deps + typecheck + unit + adapter + e2e tests).

## Prerequisites

1. Node 22+ installed.
2. `npm install` in repo root.
3. `.env.local` (or shell env) set with:
   - `SM_ROOT_GROUP_ID` — the Feishu group id the bot listens in as "root"
   - `SM_ROOT_USER_ID` — the owner's Feishu user id
   - `SM_WORKSPACE_ROOT` — absolute path where session workdirs will live
   - `SM_DB_PATH` — absolute path to the sqlite file
   - `SM_BACKEND` — `claude` or `codex`
   - `SM_LOG_LEVEL` — `debug` / `info` / `warn` / `error`
4. `@larksuite/cli` credentials configured (`LARK_APP_ID`, `LARK_APP_SECRET`) — required by `realClient` once the spike is wired.
5. `claude` (or `codex`) CLI on PATH.

> **Note:** As of this checkout, `src/adapters/lark-cli/realClient.ts` is a stub that throws from every method. Before running the smoke test end-to-end, execute `scripts/spike-lark.ts` against real Feishu credentials and replace `realClient.ts` with the real wiring per the findings recorded in `src/adapters/lark-cli/SPIKE_NOTES.md`.

## Checklist

### 1. Cold start

- [ ] `npm run start`
- [ ] Console prints `supermatrix starting` and subscribes to the root group without error.

### 2. /help in root

- [ ] In root group, send `/help`.
- [ ] Reply lists commands including `/new`, `/delete`, `/list`, `/restart` with Chinese descriptions.

### 3. /new claude alpha

- [ ] In root, send `/new claude alpha`.
- [ ] Workspace directory `$SM_WORKSPACE_ROOT/alpha` is created and git-initialized.
- [ ] A new Feishu user group is created and the owner is invited.
- [ ] Root replies `✓ 已创建 session 「alpha」…`.
- [ ] `session-catalog.json` exists under `$SM_WORKSPACE_ROOT/alpha/` (symlink to global catalog).

### 3a. /new clone alpha kimi alpha-reviewer

- [ ] In root, send `/new clone alpha kimi alpha-reviewer`.
- [ ] A new Feishu group named `alpha-reviewer-kimi` is created and bound to a distinct session.
- [ ] In sqlite, `alpha-reviewer` copies `alpha`'s `workdir`, `purpose`, `category`, `thinking`, `inactivity_timeout_s`, `max_runtime_s`, and `heartbeat_enabled`.
- [ ] In sqlite, `alpha-reviewer.backend='kimi'`; `model`, `effort`, `backend_session_id` are `NULL`; `model_locked=0`, `effort_locked=0`, `alias=''`, and `avatar=''`.
- [ ] In sqlite, `alpha-reviewer.affiliated_to='alpha'`, while `parent_id IS NULL` (governance affiliation is not runtime child ownership).
- [ ] After the authoritative session-table sync, the Feishu `Session` row for `alpha-reviewer` has `附属于='alpha'`.
- [ ] `alpha-reviewer.fp_managed` remains unset until the authoritative Feishu session table sync derives it; main/child runtime model defaults start unconfigured.
- [ ] The existing `alpha` session row and workspace files are unchanged.

### 3b. /clone kimi alpha-short

- [ ] In the existing alpha user group, send `/clone kimi alpha-short`.
- [ ] A new Feishu group named `alpha-short-kimi` is created and bound to a distinct session; the source is inferred from the current group's binding.
- [ ] In sqlite, `alpha-short` has the same clone/reset semantics as step 3a: backend-neutral configuration is copied from `alpha`, while backend, identity, backend context, model/effort defaults and locks, avatar, and alias are initialized for the new Kimi session.
- [ ] In sqlite, `alpha-short.affiliated_to='alpha'`, while `parent_id IS NULL`.
- [ ] After the authoritative session-table sync, the Feishu `Session` row for `alpha-short` has `附属于='alpha'`.
- [ ] The existing `alpha` session row and workspace files are unchanged.

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

## localwatch managed macOS services (manual, approval-gated)

适用：改动触及 `scripts/localwatch.sh`、`scripts/localwatch-managed-services.ts` 或 live `localwatch-services.json`。helper 的 `check` 可能发出真实 `open -g` / Clash 优雅退出，**不能在 busy session、未批准的维护窗口或只做源码验证时手工运行**。首次源码接入需在安全窗口重启 localwatch 一次；busy 非零时等待 watchdog 判定 idle 后再上线。

1. 先跑离线 gates：
   ```sh
   npx vitest run tests/scripts/localwatch.test.ts tests/scripts/localwatch-managed-services.test.ts
   npm run typecheck
   npm run lint:deps
   bash -n scripts/localwatch.sh
   ```
2. 只读核对 live registry（不得用 `check` 代替）：`jq . /Users/LOCAL_USER/SuperMatrixRuntime/config/localwatch-services.json`。确认 Clash Verge 是 `io.github.clash-verge-rev.clash-verge-rev`、`primaryProcess=/Applications/Clash Verge.app/Contents/MacOS/clash-verge`、`requiredProcesses=[/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo]`、`127.0.0.1:7897`、`relaunch-on-unhealthy`、threshold=2/cooldown=120；紫鸟是 `com.ziniao.fzzixun`、`primaryProcess=/Applications/ziniao.app/Contents/MacOS/ziniao`、空 `requiredProcesses`、`127.0.0.1:9481`、`launch-if-absent`。
3. 仅在确认所有目标 session idle、获得维护窗口批准后，经既有 terminal-launcher/localwatch 链路重启一次。记录旧/新 localwatch PID 和新启动时间；不得另起第二个 supervisor。
4. 新 localwatch 的下一轮 30s tick 后，检查 `logs/localwatch.log` 是否有 structured helper 结果或明确的 config error；同时确认 heartbeat 若含 managed app 异常，文本为 `异常：…`，不是 `一切正常`。
5. 不人为关闭 Clash 或紫鸟来做生产演练。状态文件仅在 helper 跑过后才会出现；读取 `/Users/LOCAL_USER/SuperMatrixRuntime/data/localwatch-managed-services.state.json` 时，检查 `consecutiveFailures`、`cooldownUntil`、`startupGraceUntil`、`lastStatus` 与 `lastRecoveredAt`。`open` 事件本身不能作为 recovered 证据。

## System child defaults (manual, approval-gated)

适用：改动触及 `global child` defaults、共享 child 创建路径、root-console `/spawn` 或 `/api/spawn2.0` tuple selection、child-default migration/store，且已取得明确的 live Feishu smoke 批准。**这是一份人工操作配方；不要由脚本、agent 或自动化流程执行。** 它会发送真实命令并创建真实 child，但 child prompt 不读写文件、不调用工具。

1. 先取得 `global child` defaults 的**独占操作权**：明确通知其他 operator 在本 smoke 结束前不得发送任何 `/backend global child`、`/model global child` 或 `/effort global child` 命令；无法确认没有并发变更时，不要开始。然后在 root console 选择一个已知 idle 的目标 session，记为 `<target-session>`；发送以下只读命令并逐字记录三行返回值，作为恢复基线：
   - `/backend global child`
   - `/model global child`
   - `/effort global child`
2. 在同一 root console 依次发送：
   - `/backend global child codex`
   - `/model global child gpt-5.5`
   - `/effort global child xhigh`
   - `/backend global child`
   记录最后一条 receipt 的 `backend: codex`、`model: gpt-5.5`、`effort: xhigh`，以及「已有 child 均未调整」/锁定 child 列表。
3. 在 root console 发送以下 no-write prompt（把占位符替换为第 1 步的 session 名）：
   - `/spawn <target-session> Reply with exactly CHILD_DEFAULTS_SMOKE_OK. Do not inspect, create, modify, delete, or write files. Do not run commands or tools.`
4. 记录 root-console 返回的完整 completion 或 queued receipt、child 名称/`ref`，以及 receipt 中的实际 `backend`、`model`、`effort`；它们应为 `codex`、`gpt-5.5`、`xhigh`。在目标群记录最终文本 `CHILD_DEFAULTS_SMOKE_OK`。若 child 被排队，等待其完成后再记录最终 receipt/结果，不重发 `/spawn`。
5. 使用同一个已知 caller session，在本机 loopback 调用既有 `/api/spawn2.0`，**不要传 `execution`、`backend`、`model` 或 `effort`**；`<caller-session>`、`<target-session>` 和 request id 均替换为本次 smoke 的真实值：
   ```sh
   curl -sS -X POST http://127.0.0.1:3501/api/spawn2.0 \
     -H 'Content-Type: application/json' \
     -d '{"from":"<caller-session>","target":"<target-session>","prompt":"Reply with exactly CHILD_DEFAULTS_SMOKE_OK. Do not inspect, create, modify, delete, or write files. Do not run commands or tools.","client_request_id":"YYYY-MM-DD:manual-smoke:child-defaults:spawn2","closure":{"kind":"message","target":{"type":"inline"}}}'
   ```
   记录响应、child 名称和 sessions 行的 backend/model/effort 三列；同样必须为 `codex`、`gpt-5.5`、`xhigh`。这一步证明 API 入口在没有显式 request override 时也走全局 child 默认。
6. **恢复前先作并发保护检查：**再次发送 `/backend global child`、`/model global child`、`/effort global child`，并将三行当前值逐项与第 2–5 步写入的准确 smoke tuple `backend: codex`、`model: gpt-5.5`、`effort: xhigh` 比较。仅当三项都完全相等时，才按第 1 步记录的基线人工恢复：若三项基线都是 `inherit`，发送 `/backend global child inherit`；否则按 `backend`、`model`、`effort` 的顺序重放记录的值（`default` 与 `inherit` 保持原样）。若任一当前值不同，立即停止，**不要恢复**；记录当前三条 receipt，并与做出并发变更的 operator 协调，由其决定后续配置。仅在成功恢复后记录最终的三条只读查询结果。不要为了此 smoke 改动已有 child session。

## Conversation branches

适用：改动触及 `/branch`、backend adapter、dispatcher、replier、reset/restart 或 `session_branches` migration 后执行。

1. **Claude inherited branch**
   - [ ] In a Claude session user group, send a normal prompt and wait for final.
   - [ ] Send `/branch plan-a`; expect `✓ 已创建并切换到 branch「plan-a」（from main）`.
   - [ ] Send another normal prompt; the card title shows `<session>@plan-a`, and the run completes without changing the workdir.
   - [ ] Check sqlite: `session_branch_state.active_branch_name='plan-a'`; `message_runs.branch_name='plan-a'`; main `sessions.backend_session_id` is unchanged.
2. **Switch back and resume main**
   - [ ] Send `/branch main`; expect `✓ 已切换到 branch「main」`.
   - [ ] Send `/branch plan-a`; expect `✓ 已切换到 branch「plan-a」`.
   - [ ] Send `/branch main`; expect `✓ 已切换到 branch「main」`.
   - [ ] Send a follow-up prompt that depends on main history; card title either shows `<session>@main` or the session name with main semantics, and the backend resumes the main backend session id.
   - [ ] Send `/branch`; output marks exactly one active branch with `*`.
3. **Branch-scoped reset/restart**
   - [ ] Switch to `plan-a`, then send `/reset`; only `plan-a` loses its backend session id. Main keeps its backend session id.
   - [ ] Start a long prompt on `plan-a`, send `/restart`; process is cancelled and only `plan-a` loses its backend session id.
4. **Codex inherited branch**
   - [ ] In a Codex session that already has a backend session id, send `/branch plan-a`.
   - [ ] Expect `✓ 已创建并切换到 branch「plan-a」（from main, codex ready）`.
   - [ ] Send `/branch`; output includes `* plan-a (ready)`.
   - [ ] Send `Reply with exactly CODEX_BRANCH_SMOKE_OK.`; expect final reply `CODEX_BRANCH_SMOKE_OK`.
   - [ ] Check sqlite: `session_branches.name='plan-a'` has non-empty `backend_session_id`, non-empty `source_backend_session_id`, and `fork_pending=0`.

## `/now` live steer (manual, isolated canary)

适用：改动触及 `/now` command routing 或 Claude/Codex steer adapter。真实 canary **必须新建并只使用隔离 session**，名称带本次唯一 nonce（例如 `now-canary-claude-<nonce>`）；不得复用、发消息到、取消或修改任何既有 session。busy prompt 必须无持久副作用（不读写仓库文件、不触网、不写 DB、只在临时 cwd 内活动）且时长有界；具体 busy 形态按各后端条目要求，不要一律套用纯推理 prompt。记录 nonce、Lark message id 和唯一 message_run id，完成后删除 canary session。

1. **Claude acknowledgement + same turn** — 新建 Claude canary，busy prompt 必须是 **agentic busy step**：在一次性临时 cwd 内逐步执行若干无持久副作用、有限时长的步骤（例如 `sleep 4 && echo step1` … `step4`，不写仓库文件、不触网、不写 DB，跑完删除临时目录）。卡片仍在 streaming 时发送 `/now 最终回复必须包含 NOW_CLAUDE_<nonce>`。确认只有 backend acknowledgement 返回后才出现 `✓ 已注入当前正在执行的任务`，同一张卡片的最终回复含完整 nonce，且 sqlite 中没有第二条 message_run。
   - 为什么必须 agentic：Claude backend 的 `/now` 走 `--replay-user-messages`，`steer()` 只在 CLI 把注入的 user envelope **回放**出来时才 resolve；CLI 只在 turn/step 边界读下一条 stream-json stdin 消息，所以工具步骤之间的边界就是唯一的 **replay-consumption boundary**。上面的 `sleep`+`echo` 步骤存在的唯一目的就是制造这个边界。
   - 纯 **single-shot** 推理 turn（无工具调用）是一次原子模型调用，没有 replay-consumption boundary：CLI 永不回放注入消息，`steer()` 会在 `result` 时被拒（实测 claude CLI 2.1.220，final 文本为「本轮没有收到额外用户指令」）。因此若本步是在 single-shot turn 上跑的，结果必须在 receipt 里标记为 **unconfirmed**（既不是 pass 也不是 fail：它只证明 single-shot turn 没有 boundary，没证明 steer 路径坏了），不得当作成功验收；只有重跑一次带 agentic busy step 的 canary 并拿到 `steer.replay_ack` 才算确认。
   - 真实 receipt：`runs/2026-08-05-now-claude-canary.md`（含时间线：stdin 写入 5001ms、step1 `tool_result` 10202ms、`steer.replay_ack` 10203ms）。
2. **Codex acknowledgement + same turn** — 在全新的 Codex canary 重复上一步，nonce 改为 `NOW_CODEX_<nonce>`。确认成功回复晚于匹配当前 turn/message_run 的 `turn/steer` acknowledgement；原卡片最终回复含 nonce，没有新 turn、cancel 或第二条 message_run。
3. **Kimi exact rejection** — 新建 Kimi canary 并使其保持 busy，发送 `/now NOW_KIMI_<nonce>`。回复必须逐字等于 `❌ kimi 暂不支持 /now，请使用 /next 或 /cancel`；原任务继续，nonce 不进入回复，并且没有 `/next` 排队、cancel 或第二条 message_run。
4. **失败不退化** — 仅在上述隔离 canary 内覆盖 idle 或让当前 run 正常结束后再发 `/now`；确认返回明确失败，随后观察到没有自动执行该文本。不得为了制造 stale race 操作既有或 live 业务 session。

## Kimi backend (ACP)

适用：本机已装 Kimi Code 并 `kimi login`。`kimi --version` 跑不通则跳过。

1. **基础就位** — `kimi --version` 期望版本号。
2. **新建** — `/new kimi test-kimi`，群名以 `-kimi` 结尾。
3. **首轮** — 发问候消息，≤60s 收 final。
4. **多轮接续** — 紧接着问"刚才让你做什么"，验证 ACP session 持续。
5. **/cancel 中途** — 长任务发 `/cancel`，预期：进程 **不死**（`ps aux | grep "kimi acp"` 仍是同一 PID），Lark 卡片 cancelled。
6. **/backend 切换** — 切换 codex / 切回 kimi，群名后缀变化、上下文清空。
7. **重启 reconcile** — `/reload`，重启后 `ps aux | grep "kimi acp"` 应只有一个 PID（旧 ACP 已清理 / 新 ACP 重启）。
8. **共享单进程验证** — 同时打开 2-3 个 kimi session 各发一轮，`ps aux | grep "kimi acp"` 全程只有 1 个 PID。
9. **kimi term 不被误杀** — 在另一个 terminal 跑 `kimi`（交互式），SuperMatrix `/reload`，期望那个交互式 kimi **不被 reconcile 杀**（cmd 不含 acp）。
10. **受控 skill discovery** — 以全新 `client_request_id` 调 `/api/spawn2.0`，target=`kimi-sandbox`、`execution.backend="kimi"`、prompt=`ping skill-probe`。期望结果明确 `backend=kimi`，且 `link-seen-at` 为 `~/.kimi/skills/skill-probe/SKILL.md`；出现 `.agents/skills` 说明 ACP 未把顶层 `--skills-dir` 传入 Kimi harness。

## Kimi card-ask + /branch + /model alignment

适用：本机已装 Kimi Code 并 `kimi login`。card-ask broker 健康（`curl http://127.0.0.1:8787/health` 返 `ok`）。上一节 9 步基础就位。

1. **Card-ask MCP 端到端** — 在 kimi session 群组发消息触发 ask_user，例：`请帮我决定下一步是 A 还是 B，A=立即执行，B=先确认再执行；用 ask_user 工具问我选哪个`。期望：≤30s 内群组出现飞书卡片，包含问题文本 + 2 个选项按钮（A/B）+ 自动追加的红色"都不合适（停下等我输入）"拒绝按钮。点击其中一个选项（如 A），kimi 代理继续处理、最终发出最终回复。负路径：若 log 出现 `[card-ask broker unhealthy]` 或卡片形式改为纯文本选项列表，broker 故障——验证 broker 健康状态（`curl http://127.0.0.1:8787/health`）并重试。

2. **上下文存在时 /branch 拒绝 + /reset 绕过** — 同一 kimi session，至少已完成一轮会话（sessions.backend_session_id 非空）。发 `/branch test-fork`。期望：错误回复含 `Kimi backend 暂不支持基于现有对话的 branch fork（ACP 协议未提供 fork RPC）` 及建议 `请先 /reset 清空当前对话，然后 /branch 创建`。随后发 `/reset`，期望 `✓ session「<name>」上下文已清空`；再发 `/branch test-fork`，期望 `✓ 已创建并切换到 branch「test-fork」（from main）`。切回主分支 `/branch main`，期望 `✓ 已切换到 branch「main」`。切回新分支 `/branch test-fork`，期望 `✓ 已切换到 branch「test-fork」`。

3. **本地分支列表不被拦** — 在上面的 kimi session 上（fresh 或已有多个 branch），发 `/branch`（无参数）。期望：输出分支列表，用 `* <active>` 标记当前活跃分支。guard MUST NOT 在列表操作上触发。

4. **/model 模型校验** — 同一 kimi session 或任意 kimi 会话。发 `/model <session> gpt-5.5`（显然的 codex 模型）。期望：错误回复 `gpt-5.5 是 codex 模型，不能用于 kimi session`。发 `/model <session> opus`（claude 模型）。期望：`opus 是 claude 模型，不能用于 kimi session`。发 `/model <session> nonsense-model`（未知）。期望：`未知 kimi 模型 "nonsense-model"。SuperMatrix 当前已验证模型：kimi-code/kimi-for-coding / kimi-code/kimi-for-coding-highspeed / kimi-code/k3 / kimi-code/k3-256k；未验证模型不会被接受。`。发 `/model <session> k3`（别名）。期望：`✓ session「<name>」模型已切换为 kimi-code/k3`。发 `/model <session> fast`（highspeed 别名）。期望：切换为 `kimi-code/kimi-for-coding-highspeed`。发 `/model <session> default`。期望：`✓ session「<name>」已恢复默认模型`。

5. **/model 真实生效（set_model 端到端）** — kimi session 设 `/model <session> k3` 后发一条消息：`发 /status 给你的 runtime，把输出原样贴给我`（kimi 的 `/status` 会报当前 Model）。期望回复中 `Model: kimi-code/k3`，且 Lark 卡片标题为 `<session> | K3 · done | HIGH | mr_…`（模型显示名对齐 claude/codex 卡片，不再是笼统的 "Kimi"；K3 默认 effort 解析为原生 high 并显示在标题）。改回 `/model <session> coding` 再问一轮，期望 `Model: kimi-code/kimi-for-coding`、卡片标题显示 `K2.7 Coding` 且 effort 档显示 `DEFAULT`（K2.7 thinking 固定 on，无档位）。负路径：若 kimi CLI 升级后模型 id 变更，运行会直接报 `kimi session/set_model 失败（model=…）`，此时更新 `src/ports/KimiModelCatalog.ts` 后重试。

6. **/effort 档位（kimi-code 0.30.0 model-aware）** — 对 K2.7 模型的 kimi session（默认模型或 highspeed）发 `/effort high`。期望：错误回复含 `thinking 固定为 on`。对 K3 模型的 kimi session 发 `/effort low`。期望（单 session 回复，非批量口径）：`✓ session「<name>」effort 已切换为 low`，随后发一条消息，Lark 卡片标题显示 `LOW`（K3 原生档位经 `session/set_config_option` 下发）；发 `/effort medium` 期望回复 `✓ session「<name>」effort 已调整：medium→high`（官方兼容映射 medium→high，clamp）。发 `/effort ultracode`。期望：错误回复含 `ultracode`（claude-only token）。发 `/effort default`。期望：`✓ session「<name>」已恢复默认 effort`（K3 下一轮执行仍显式下发原生 high，防止复用的 ACP session 残留旧档位）。批量口径 `/effort all-kimi low` 才是 `✓ 已更新 N 个 session（backend=kimi）→ low` 形式，两者不要混用。

7. **图片附件原生化** — 向 kimi session 群发一张小图 + 文字「这张图主色是什么，一个词回答」。期望：回复描述图片真实颜色（说明 image block 送达，而非文件路径文字描述）。

8. **外部 × kimi 拦截** — 对 category=外部 的 session 发 `/backend <session> kimi`。期望：错误回复 `外部 session 不支持 kimi backend：kimi 无 answer-only 只读安全模式，请使用 claude 或 codex`。

## Kimi ACP boot self-check (RTT probe)

适用：同上，Kimi backend 就位；本节验证冷启动期间的 ACP 健康探针行为。

1. **健康守护进程冷启** — `npm run start` 冷启。在 boot 自检阶段，期望日志含行 `kimi-acp-health: ok, version=<kimi --version>, rttMs=<n>`（n 通常在 100-800ms 范围）。无告警。

2. **缓慢响应输出 info** — 若 ACP RTT 超出 1500ms 阈值（健康硬件少见，但冷启可能），期望 `kimi-acp-health: info, kimi ACP 响应缓慢：<n>ms > 1500ms`。启动继续进行，不中断。

3. **挂起守护进程冷启捕捉** — 合成测试：临时将 `SM_KIMI_CLI_PATH` 指向 wrapper；它收到 `--version` 时输出 `0.20.1` 并退出，收到 `acp` 时保持无响应。冷启。期望 `kimi-acp-health: warn, kimi ACP 协议层无响应：ACP initialize timeout after 5000ms`。启动继续进行（warn 等级，非 fail）。测试后重置 env。

4. **缺失 CLI 干净短路** — `SM_KIMI_CLI_PATH=/nonexistent/kimi`。冷启。期望 `kimi-acp-health: warn, kimi CLI 不可用：...`。ACP initialize 探针 MUST NOT 被触发（不启动任何 spawn 尝试）。启动继续进行。

## Global lark-cli as-user marker shim

适用：改动触及 `scripts/shims/lark-cli`、shim installer、`agent-lark-cli-shim` boot check、bootstrap PATH 或 localwatch PATH 后执行。

1. **安装并确认全局解析顺序**
   - [ ] 在仓库根目录执行 `./scripts/install-lark-cli-shim.sh`，返回的 target 是 `~/.local/bin/lark-cli`，source 是本仓 `scripts/shims/lark-cli`。
   - [ ] 执行 `zsh -lic 'which -a lark-cli'`，第一条必须是 `/Users/LOCAL_USER/.local/bin/lark-cli`；后续仍能看到真实 npm/repo CLI。
2. **dry-run 对照**
   - [ ] 以下命令都先在 subshell 内执行 `set -a; source .env.local; set +a`，使用真实格式的 `$SM_ROOT_GROUP_ID` 通过 CLI 参数校验；`--dry-run` 不发送消息。不要使用字面量 `dry-run` 作为 chat id，CLI 会在生成 payload 前拒绝它。
   - [ ] 执行 `zsh -lic 'set -a; source .env.local; set +a; lark-cli im +messages-send --as user --chat-id "$SM_ROOT_GROUP_ID" --text hi --dry-run'`，输出请求的 text content 以 `Δhi` 开头。
   - [ ] 执行 `zsh -lic 'set -a; source .env.local; set +a; lark-cli im +messages-send --as bot --chat-id "$SM_ROOT_GROUP_ID" --text hi --dry-run'`，输出请求的 text content 保持 `hi`，不得出现 `Δhi`。
   - [ ] 执行 `zsh -lic 'set -a; source .env.local; set +a; lark-cli im +messages-send --as user --chat-id "$SM_ROOT_GROUP_ID" --text Δhi --dry-run'`，输出仍只有一个 `Δ`。
3. **boot guard 与 live 装载**
   - [ ] 重启前记录 SuperMatrix PID 与启动时间；通过 `scripts/localwatch.sh` 的既有监督链路重启，不另起第二个主进程。
   - [ ] 新 PID 启动时间晚于包含 shim wiring 的 commit；startup report 中 `agent-lark-cli-shim` 为 `ok`。
   - [ ] `curl -s http://127.0.0.1:${SM_API_PORT:-3501}/api/health | jq .` 返回业务 JSON 且 `.status == "ok"`；HTTP 200 或进程存在本身不算验证完成。
4. **回滚**
   - [ ] 删除 `~/.local/bin/lark-cli` symlink 后，恢复代码与 localwatch PATH；不得修改或删除上游 `~/.npm-global` 包内容。
