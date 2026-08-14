# SuperMatrix localwatch launchd agent

Single-user macOS launchd agent that keeps `scripts/localwatch.sh` running.
localwatch starts the Super Matrix runtime, optionally starts Scheduler, runs
health checks, and writes logs to `logs/` under `supermatrix/`.

## Setup

1. Make sure the repository root `.env` exists. The normal path is:
   ```
   cd supermatrix
   npm run init
   ```
2. Make sure node_modules is installed: `npm install`.
3. Install the agent:
   ```
   ./scripts/launchd/install.sh
   ```
4. Tail logs:
   ```
   tail -f logs/localwatch.log logs/supermatrix.stdout.log logs/sm-crash.log
   ```

## Uninstall / stop

```
./scripts/launchd/uninstall.sh
```

## Manual control

```
# stop it (launchd will NOT restart — use unload)
launchctl unload ~/Library/LaunchAgents/com.supermatrix.localwatch.plist

# start it
launchctl load ~/Library/LaunchAgents/com.supermatrix.localwatch.plist

# list / status
launchctl list | grep com.supermatrix.localwatch
```

## Notes

- **KeepAlive=true** + **ThrottleInterval=30**: launchd restarts the launcher
  when it exits, but waits between restarts to avoid a crash loop.
- **PATH**: the launch script prepends `$HOME/.local/bin` and
  `node_modules/.bin` so `claude`, `tsx`, and `lark-cli` are all
  reachable.
- **Single-instance event subscribe**: only one SuperMatrix agent can
  own the Feishu/Lark event subscriber at a time. Stop any other local
  Super Matrix process that uses the same app before installing this agent.
- **Logs rotation**: not handled automatically yet. `logs/*.log` grows
  unbounded. Use `logrotate` or rotate manually with `truncate -s 0
  logs/supermatrix.*.log` when they get too large.

## Architecture: Terminal.app + launchd

Claude Code 使用 macOS login keychain 存储 OAuth 凭证，只有交互式终端
session 才有权限读取。因此 **SM 主进程必须跑在 Terminal.app 里**。

launchd 的角色是保活：

```
launchd → terminal-launcher.sh → 打开 Terminal.app → localwatch.sh → SM
```

- `terminal-launcher.sh` 通过 osascript 打开 Terminal.app 运行 localwatch
- 然后监控 localwatch 进程是否存活
- 如果 localwatch 挂了，launcher 退出 → launchd 重拉 → 重新打开终端

这样 SM 始终在交互式 session 里运行，有 keychain 访问权限。
