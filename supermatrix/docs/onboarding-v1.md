# SuperMatrix terminal onboarding V1

This is one onboarding path. It creates a new runtime namespace, a new SQLite
database, a new workspace root, fresh control/platform groups, and a resumable
state file. It never copies `.env.local`, `supermatrix.db`, session metadata,
OAuth files, Keychain material, or private business configuration.

## Entry point

Run the single command below from the distributed `supermatrix` directory. It
resolves and records absolute pinned `node`/`npm`/Python/Lark/backend entrypoints, creates the named isolated `lark-cli`
profile when absent, requests only the manifest scopes, generates the Lark
URL/QR in the terminal, probes the selected backend, deploys bundled public
modules/templates/skills, and writes the isolated service launcher. It never
switches or reads the global profile.

```sh
npm run onboard -- \
  --apply \
  --profile xj-onboarding-v1 \
  --backend codex \
  --source-root "$PWD" \
  --runtime-root "$HOME/SuperMatrixRuntime-xj-onboarding-v1" \
  --port 3511 \
  --scheduler-port 3512
```

When the named profile is absent and `--app-id` was not supplied, the wizard
invokes `lark-cli config init --new --name <profile>` so the native CLI opens its
browser flow to create the isolated app. Because that command does not expose
the new app secret to SuperMatrix's SDK handoff, the same wizard then asks for
that secret once with echo disabled (or accepts the explicit
`SM_ONBOARD_APP_SECRET` input). If `--app-id` is supplied, the manual fallback
uses `lark-cli profile add --app-secret-stdin`. The secret is stored only in a
mode-0600 runtime file for the Node SDK; it is never put in the generated env,
command line, log, or receipt. Lark browser/QR approval and tenant/admin
approval are the only other human-only steps. Production profiles and
credentials are rejected by the path/profile ownership checks.

If user authorization is missing, the command itself runs
`lark-cli auth login --no-wait --json --scope <comma-separated-sorted-scope-list>`
with the deduplicated, sorted user-scope list from the versioned permission
manifest, prints its verification URL and generated ASCII QR, and
continues the device flow after Enter. Bot/application scopes are read back
separately from the same manifest and API. In a non-interactive terminal it
prints only the URL (never the device code); open it and rerun the same command.

`auth status --verify` proves the user token only. `whoami --as bot` and the
read-only bot probes are separately required; user OAuth is never treated as
tenant/admin approval. The onboarding command reports the missing side and
stops rather than claiming success.

## What apply does

1. Checks source readability, canonical non-symlink isolated paths, and an
   unused loopback port. It never accepts a source/runtime overlap or a path
   outside the runtime namespace.
2. Checks lark-cli version, user verification, bot/application availability,
   user-granted scopes, read-only application scope grants, and the selected
   backend's version/auth status.
3. Creates `onboarding-v1/state.json` and mode `0600` secrets outside the
   source tree. State is atomically rewritten after each group/session and
   startup-artifact boundary; corrupt or inaccessible state is an error, never
   a new install.
4. Resolves one child environment and persists its absolute paths in
   `state.json`: `runtime/home`, `runtime/xdg-config`, `runtime/codex-home`,
   the exact pinned executables, and PATH. Auth, backend probes, provisioning,
   startup, resume, verify, and rollback reuse that receipt; unsafe or changed
   paths fail closed. Credentials are never copied into the child environment.
5. Searches each deterministic group name before creating it, then reuses the
   existing group on resume. It calls the existing `createSessionLifecycle`,
   so workspace scaffolding, binding, catalog linking, and category metadata
   use the framework's normal mechanism.
6. Copies only public-export modules whose manifest entry has a runnable source
   path, installs only a module root's dependencies (`npm ci` when locked), and writes a profile-bound
   `.env.local.generated`, `scheduler-start.sh`, `service.json`, and `start.sh`.
   `start.sh` invokes the existing `scripts/localwatch.sh` with the onboarding
   runtime's environment, log, lock, scheduler launcher, and PID paths. The
   supported LocalWatch mechanism then manages only SuperMatrix and the
   isolated scheduler-v2 instance; onboarding does not install a second
   supervisor, revive retired launchd paths, or touch the production runtime.
   Onboarding waits for both isolated health endpoints before reporting
   `ready`.

Resume the same command after an interrupted run. Inspect without mutation:

```sh
npm run onboard -- --verify --profile xj-onboarding-v1 \
  --runtime-root "$HOME/SuperMatrixRuntime-xj-onboarding-v1" \
  --port 3511
```

Rollback is exact-state scoped: it deletes only resources marked as created by
this install, checks group names before dissolution, and leaves adopted groups,
historical installations, and production paths alone:

```sh
npm run onboard -- --rollback --profile xj-onboarding-v1 \
  --runtime-root "$HOME/SuperMatrixRuntime-xj-onboarding-v1"
```

Feishu does not expose a true chat-delete operation through the existing
adapter; rollback removes the onboarding sessions/bindings and makes the bot
leave the onboarding groups. The group records remain visible in Feishu.

## Permission evidence

`config/onboarding-v1/permissions.json` is V1's reviewed union. It is derived
from the current adapter call sites and the larkc owner evidence. It separates
user grants from bot/application use, marks drive-comment subscription as
conditional, and explicitly excludes unrelated calendar, mail, approval, OKR,
VC, slides, mindnote, wiki, and broad Bitable write permissions.

The V1 path does not create event subscriptions. A clean managed-device test
must use an isolated app/profile and must not start a second production event
consumer. Drive-comment subscription reconciliation is disabled by default;
it requires the explicit runtime switch `SM_DRIVE_COMMENT_SUBSCRIPTION_ENABLED=1`.

## Platform bootstrap inventory

The manifest is derived from the public-export mappings, not a private session
catalog. V1 provisions only entries with an explicit runnable module path; each
gets a real session, copied module, binding, and group rather than an empty
placeholder.

The manifest contains only the canonical public roles from
`gitmaster/config/public-export.json@c944c60`, plus `wendangwang` as a support
export. Private source roster, aliases, and experiments stay in gitmaster's
private release receipt and are not repeated in this public manifest.

The exact allowed public skill set is copied from the public distribution's
`platform/skill-master/skills` tree and checked against the owner commit and
per-file `{bytes,sha256}` values in `config/onboarding-v1/asset-provenance.json`.
Those existing file digests describe the approved sanitized/public bytes that
onboarding reads. Sanitization is allowed to change bytes: gitmaster retains the
original source hash in its private provenance, then refreshes only the existing
public `bytes` and `sha256` fields for the approved sanitized bytes and freezes
the archive digest from those same bytes. The release metadata fields allowed by
this manifest are the existing source/module commit, review-status, archive
digest, and per-file byte/hash fields; no installer edit and no second
runtime-derived replacement hash is part of acceptance.
Shared host skill pools and canonical private templates are never read. The
allowed set is recorded in `config/onboarding-v1/skills.json`: `diagnose`,
`improve-codebase-architecture`, and `tdd`.

The public layout must also contain `platform/first-principle/templates` and
the Python modules must contain `pyproject.toml`, `.python-version` set to
`3.11.15`, and `requires-python` metadata. Onboarding creates each module's
`.venv` and runs its declared Python `--help` contract before provisioning.
Support-module materialization is copy-only. The `larkc` nested card-callback
and queue Python closure is not claimed as automatically installed; its owner
entrypoint and existing tool configuration remain the closure boundary.

Release-owner handoff: gitmaster's public mapping must carry the exact files
listed by the public manifest. No private catalog or host workspace is a
runtime fallback.

The public onboarding surface reuses the existing single `scripts/localwatch.sh` and
its identity helper. Only the minimum path/configuration seams are exposed:
the source/runtime roots, generated environment, onboarding log and lock
locations, isolated scheduler launcher/port, and scheduler PID receipt. The
generated environment restores the recorded `HOME`, `XDG_CONFIG_HOME`,
`CODEX_HOME`, pinned executable paths, and exact PATH, while ports, databases,
state, logs, and locks remain under the
selected runtime root. These files do not carry credentials, tenant
identifiers, remote resource IDs, or host-specific paths.

`service.json` is the native-OS service handoff: `nativeOS.autoStart` is true,
its command points to the generated `start.sh`, and its persistence list names
the isolated databases. The onboarding command records this configuration but
does not install or resurrect a retired launchd job; the host's supported
service manager must register this handoff for mandatory boot startup.

### macOS lifecycle handoff contract (L/R07)

The public handoff has one owner path. `service.json` is the mechanical source
of truth for the external LaunchAgent registration:

```json
{
  "nativeOS": {
    "registration": "external",
    "command": "<runtime>/onboarding-v1/start.sh",
    "cwd": "<source-root>",
    "launchAgent": {
      "label": "com.supermatrix.onboarding.<installId>",
      "programArguments": ["/bin/sh", "<runtime>/onboarding-v1/start.sh"],
      "runAtLoad": true,
      "keepAlive": true,
      "workingDirectory": "<source-root>",
      "standardOutPath": "<runtime>/onboarding-v1/service.log",
      "standardErrorPath": "<runtime>/onboarding-v1/service.log"
    }
  },
  "ownerReceipt": {
    "path": "<runtime>/onboarding-v1/owner-receipt.json",
    "format": "localwatch-owner-v1"
  }
}
```

The registration owner may materialize those fields in a user LaunchAgent
plist. This repository does not add an installer or write launchd state. The
registration/readback anchors are:

```sh
jq '.nativeOS,.ownerReceipt' "$RUNTIME/onboarding-v1/service.json"
launchctl print "gui/$UID/com.supermatrix.onboarding.$INSTALL_ID"   # readback only
jq . "$RUNTIME/onboarding-v1/owner-receipt.json"
```

Every external command receives the persisted child environment: the runtime
HOME/XDG/Codex directories, the recorded absolute tool paths, and the
recorded PATH. The child environment carries only locale, temporary-directory,
CI, and test-fixture variables from the parent; credentials and parent
authentication paths are not inherited or copied.

`owner-receipt.json` is the lifecycle authority, never `state.servicePid` or
`service.pid`. Each S5 start, LocalWatch successor, and native-OS start writes
the same readable receipt path. A valid active receipt has exactly these
identity fields: `version=1`, `kind=localwatch-owner`, `status=active`, `pid`,
`processStart`, `bootId`, `repoDir`, `scriptPath`, `cwd`,
`installationNamespace`, `launcherPath`, and
`healthEndpoints.api`/`healthEndpoints.scheduler`. The verifier compares all
of them with the current process and this install's paths, then probes both
health URLs. A missing, contradictory, or reused PID is a hard failure; it is
never repaired by editing `state.json`.

The lifecycle order is:

1. S5 writes the generated env, `start.sh`, `service.json`, and the receipt
   path, then starts the existing LocalWatch through `start.sh`. The first
   LocalWatch publishes the active receipt before health is accepted.
2. A successor or native OS start acquires the existing LocalWatch lock,
   publishes a new receipt with its own PID/process-start/boot identity, and
   takes over the same health endpoints. Consumers reread the receipt; they do
   not carry the previous supervisor PID forward. This is the only handoff
   from S5's existing supervisor.
3. On an ambiguous or failed restart, do not start a second supervisor. Read
   `service.json`, the receipt, `ps -p <pid> -o lstart=,command=`, and both
   health endpoints. If the receipt is missing or identity does not match,
   stop and escalate; no broad `kill`, `pkill`, or port-owner kill is allowed.
4. To stop/unregister/rollback, first unregister the external LaunchAgent,
   then reread the receipt. Signal only the exact active owner whose PID,
   process-start, boot identity, command, and cwd still match; wait for its
   process tree and both health endpoints to terminate. If the owner is already
   stopped, use only the persisted last receipt and do not signal a reused PID.
   Finally run the exact `--rollback` command. Rollback preserves the state and
   last-owner receipts for audit and removes only this install's resources.

`service.log` is the bounded onboarding supervisor log and must be retained for
at least 14 days (and through an incident closeout); rotation is an external
host policy, not a second watcher or installer. After every boot, the
registration owner must read back the LaunchAgent, the active owner receipt,
and both loopback health endpoints within 120 seconds. Failure to meet that
deadline is `runtime-pending`, not a healthy onboarding result.

## Maintainer acceptance receipts

Live validation is a maintainer-only acceptance activity; it is not an
external owner-session prerequisite for an ordinary user's first install. The
ordinary path is the command above, which starts the generated launcher and
waits for isolated health. A managed-device test must still preserve the
historical installation and use only the fresh namespace.

The generated launcher keeps the existing single SDK WebSocket callback path;
comment subscription is disabled by default. Process-tree ownership is
recorded before health probing, and resume reuses the same service identity so
it cannot create a duplicate supervisor.

The live acceptance checklist is deliberately explicit: inbound/outbound group
message, selected-backend task, context continuation, inter-session delegation,
scheduled task with delivered result, and restart persistence. Health or a
trigger exit code alone is not acceptance. Any missing human approval, app
scope, user grant, managed-device connection, or production-event isolation remains a
blocked item in the handoff.
