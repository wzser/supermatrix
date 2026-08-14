# Caller provenance boundary

Owner: codexroot (SuperMatrix runtime). Consumers: wendangwang queue enqueue, and
anything else that records "which session did this".

Run the evidence for everything claimed here:

```
npx tsx scripts/verify-caller-provenance.ts
```

## The problem

A local CLI that writes on behalf of a session takes the caller's name as an
argument (`feishu-sync-enqueue --from <session>`). That field is self-reported.
Receipts, drift routing and misroute attribution are all booked against it, so a
wrong value writes responsibility onto an innocent owner.

The original problem is **attribution**. The token mechanism below introduced a
confidentiality assumption — that one session could keep an env value from a
same-uid sibling — and that assumption is false on this host.

## What already existed, and its exact limit

wendangwang `636e542` compares `--from` against the runtime's `SM_SESSION_NAME`
and refuses to build a job on mismatch. That closes the confused-agent case: an
agent that has drifted into believing it is `first-principle` now gets stopped.

It closes nothing beyond that, because **a session name is public** — it is in
`session-catalog.json`. Anyone who wants to be recorded as `first-principle`
exports `SM_SESSION_NAME=first-principle`. Measured on 2026-07-22 against the
live CLI:

| case | result |
|---|---|
| real env, `--from first-principle` | rejected, exit 1, no job |
| `SM_SESSION_NAME=first-principle`, `--from first-principle` | **passed the identity gate**, stopped later only by an unrelated unknown-asset error |

Call it a misattribution gate. It is not authentication.

## What SuperMatrix now provides — provenance only

The runtime mints an unguessable per-run token, injects it into the backend
process, and maps a presented token back to the run that received it:

- `src/domain/callerAttestation.ts` — mint / resolve / rotate / revoke. One live
  attestation per session; re-minting invalidates the previous one.
- `src/adapters/backend-codex`, `src/adapters/backend-claude` — inject
  `SM_CALLER_ATTESTATION` alongside `SM_SESSION_NAME` at run start, revoke at run
  end.
- `POST /api/caller-identity` on the existing loopback API server — body is
  `{"token": "..."}` and nothing else (`.strict()`); the **runtime** answers with
  `sessionName` / `ownerSessionName`. A resolved-token response and an
  unknown-token response both explicitly carry `ownerAuthority: false`.

The gain over the name check is limited but useful: the token is injected by the
runtime and catches accidental name drift without asking the caller to type its
identity. It is unguessable, but it is **not confidential from same-uid sibling
processes**. On this machine, `ps -Ewww -p <node-pid>` exposes the Node process's
environment, including an injected probe token.

A caller therefore **can claim to be another owner through the official path**:
harvest the victim's `SM_CALLER_ATTESTATION`, submit it to
`POST /api/caller-identity`, and the runtime returns the victim mapping. The
endpoint knows which token was presented, not which process presented it.

This is why `attested` means only "a live runtime token resolved". It must not be
read as caller-bound identity or authorization.

## Executable evidence and the corrected E1

`scripts/verify-caller-provenance.ts` runs seven claims:

| check | fact established |
|---|---|
| E1 | a same-uid sibling can read a backend-shaped Node process env with explicit `ps -Ewww -p <pid>` argv |
| E2 | a live token resolves, and the response says `ownerAuthority: false` |
| E3 | `ps` harvests a live registry token from a victim Node, then an independent Node sibling replays it and reaches the victim mapping through the official endpoint |
| E4 | guessing a token from a public session name still fails |
| E5 | extra caller-supplied identity fields are rejected |
| E6 | scheduler / kimi / human no-token traffic remains explicitly unattested |
| E7 | a token stops resolving after its run is revoked |

The old E1 used `/bin/sleep`. That is a SIP platform binary and its environment
is hidden by the kernel on this host, so it produced a false PASS for a Node
backend. The corrected probe uses `process.execPath`. It also passes each `ps`
argument separately; zsh does not word-split an unquoted scalar by default, so
packing the flags into one variable can otherwise turn a usage error into a
false negative.

## Why this is not a true same-UID security boundary

Asked directly: can SuperMatrix, within its existing architecture, make caller
identity unforgeable between sessions? No. The reasons are structural, not
effort:

1. **No per-session OS principal.** Every session runs as uid 501. The kernel
   draws no line between them, so nothing below the application layer can
   distinguish them.
2. **No peer PID on the existing transport.** `/api/caller-identity` uses
   loopback TCP. Its Node request socket exposes an address and port, not the
   caller's OS PID. Adding `pid` to the JSON body would not help: the attacker can
   copy the victim PID at the same time as the token. A caller PID becomes useful
   only when the kernel supplies it for the accepted peer.
3. **kimi cannot be attested per session.** kimi runs as *one* shared ACP
   process for every kimi-backed session (`AcpClient`, lazy-spawned on first
   use). There is no per-session process to inject a per-session identity into. Handled by
   making it honestly unattested: `buildKimiChildEnv` strips `SM_SESSION_NAME`
   and `SM_CALLER_ATTESTATION` from the shared child, so a kimi session inherits
   no identity instead of silently inheriting the *parent's* — which would have
   been misattribution. The 2026-07-22 downstream check found that this had **not
   happened** in the live daemon: PID 87749 had no `SM_SESSION_NAME`, so kimi was
   already unnamed and the `636e542` gate stayed fail-open. The strip remains
   necessary defense for a future daemon restart from an agent shell that does
   carry a session name. Evidence:
   `/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/wendangwang/data/receipts/2026-07-22-caller-provenance-notification-verification.json`.
4. **The unattested path must stay open.** Scheduler script tasks, human
   terminals and kimi hold no attestation. Failing closed would sever them. The
   downstream 14-day sample records 29,378 scheduler enqueues, 81% of the queue,
   on this no-token path. An open path is therefore always available, and
   anything reachable without an attestation is reachable by a determined
   forger too.

The open unattested path explains why provenance cannot be fail-closed for the
current queue. It does not make the replayable token safe for a narrower owner
authorization check. Those are separate decisions.

## Consumer contract

The rule consumers must implement:

1. **Attested** — a token that `POST /api/caller-identity` resolves. Record this
   as provenance and use the returned mapping for accidental mismatch detection.
   It is replayable by a same-uid sibling, so the response says
   `ownerAuthority: false`. Do not use it to authorize writes to an owner's
   registered asset.
2. **Unattested** — no token, or a token that does not resolve (403). Legitimate
   and must keep working, but it is *not* an identity. It must be recorded as
   `unattested`, must not be upgraded to a claimed owner, and must not be
   silently rendered as one downstream.
3. **Mismatch** — a self-reported `--from` that disagrees with a resolved
   token mapping. Refuse before creating work. This catches drift; it is not an
   authorization decision because a stolen victim token makes the values agree.

Neither state carries owner authority. Any owner-scoped write needs a separate,
independently verified authorization mechanism.

Consumers must not read `SM_CALLER_ATTESTATION` and decide for themselves what
it means, and must not accept an identity from any caller-supplied field. Ask
the runtime, then honor `ownerAuthority: false`.

## What would be required for owner authority

If attested provenance is ever promoted to owner authorization, the credential
must be bound to the actual caller rather than merely presented by it. The
minimum credible design is:

1. move resolution to a Unix-domain socket;
2. obtain the accepted peer PID from the kernel through a native macOS adapter;
3. bind each run record to its backend PID and verify that peer PID's ancestry
   reaches that backend PID;
4. fail the authorization check when peer PID or ancestry cannot be verified.

A Unix socket path alone is insufficient, because all sessions share the same
uid. A caller-supplied PID is also insufficient. This change requires a native
peer-credential adapter plus consumer transport rollout, so it is intentionally
not hidden inside this corrective patch.

## Separate bypasses

The same-uid env harvest is **not** in this list; E1/E3 treat it as an official
path break. Separate bypasses that avoid the endpoint entirely still include:

- writing the queue SQLite DB directly;
- calling `lark-cli` directly, bypassing the queue;
- attaching a debugger to another session's process.

Do not describe the current endpoint as authentication, authorization, an
unforgeable identity, or an authoritative owner write path.
