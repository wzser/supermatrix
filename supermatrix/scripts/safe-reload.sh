#!/bin/zsh
# Internal reload executor: check policy-approved session state, claim the
# relevant dedup window, then trigger the private /reload source.
#
# Exit codes:
#   0 — handled successfully (reload fired OR busy-skip OR dedup-skip OR claim-contended;
#       all valid no-fault terminals). Disambiguate via stdout markers, not exit code:
#         "[reload-fired]"        → /reload was dispatched to the root group
#         "[busy-skip] count=N"   → N busy sessions, no action taken this tick
#         "[busy-window-expired]" → scheduled window ended while sessions stayed busy
#         "[dedup-skip] age=Ns"   → reload was already fired within the dedup window
#         "[claim-contended]"     → a concurrent tick owns the claim; it dispatches, not us
#   2 — policy/env/config error, or an ambiguous dispatch (real failure; safe to alert).
#       "[dispatch-ambiguous]" on stderr means the /reload may already have been
#       delivered; the claim is retained so no later tick re-sends it.
#
# Why exit 0 on busy terminals: scheduler proofs (exit_zero) and idempotent retry models
# treat non-zero as "did not handle, retry/heal." A busy-skip handled the tick
# correctly — the answer was just "not now." Returning non-zero makes every direct
# caller wrap the script to absorb it (see watchdog/src/scripts/safe-reload-watch.sh
# for the historical wrapper). Lifting the absorption into the script itself keeps
# future consumers from re-discovering this footgun.
#
# Policy: this is an internal executor. Only platform-maintenance-gate.sh may
# call it after resolving the current run to codexroot and applying the operation
# policy. Environment approval is a same-uid policy marker, not an OS security
# boundary; the gate exists to close official and accidental paths.
# MAINTAINER WARNING: do not replace this flow with kill -9/SIGKILL, pkill, or
# launchctl. Those bypass drain checks and can terminate unrelated sessions.
#
# Why dedup: scheduled-daily uses a 24h claim; codexroot-maintenance uses a
# separate five-minute claim. A manual operation can never consume or reuse the
# daily permit.
#
# Usage:
#   ./scripts/safe-reload.sh
#
# Designed to be called only by platform-maintenance-gate.sh.

set -eu

SCRIPT_DIR="$(cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ missing $ENV_FILE" >&2
  exit 2
fi

set -a
source "$ENV_FILE"
set +a

DB_PATH="${SM_DB_PATH:?SM_DB_PATH not set}"
ROOT_GROUP="${SM_ROOT_GROUP_ID:?SM_ROOT_GROUP_ID not set}"
LARK_CLI="${SM_LARK_CLI_PATH:-$REPO_DIR/node_modules/.bin/lark-cli}"
API_BASE="${SM_API_BASE:-http://127.0.0.1:3501}"

if [[ "${SM_MAINTENANCE_GATE_APPROVAL:-}" != "platform-maintenance-gate-v1" ]]; then
  echo "[policy-deny] missing maintenance gate approval" >&2
  exit 2
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "❌ database not found: $DB_PATH" >&2
  exit 2
fi

RELOAD_SOURCE="${SM_RELOAD_SOURCE:-}"
case "$RELOAD_SOURCE" in
  scheduled-daily|codexroot-maintenance) ;;
  *)
    echo "[policy-deny] source=${RELOAD_SOURCE:-unset} allowed=scheduled-daily,codexroot-maintenance" >&2
    exit 2
    ;;
esac

RELOAD_FORCE="${SM_MAINTENANCE_FORCE:-false}"
if [[ "$RELOAD_FORCE" != "true" && "$RELOAD_FORCE" != "false" ]]; then
  echo "[policy-deny] invalid maintenance force flag" >&2
  exit 2
fi
if [[ "$RELOAD_FORCE" == "true" && "$RELOAD_SOURCE" != "codexroot-maintenance" ]]; then
  echo "[policy-deny] force is only available to codexroot-maintenance" >&2
  exit 2
fi

# Re-resolve the live per-run attestation at the executor boundary. The shell
# approval marker is intentionally insufficient: a direct caller that merely
# exports the documented values must not reach the /reload dispatch.
CALLER_SESSION_ID="${SM_MAINTENANCE_CALLER_SESSION_ID:-}"
CALLER_ATTESTATION="${SM_CALLER_ATTESTATION:-}"
if [[ -z "$CALLER_SESSION_ID" || ! "$CALLER_SESSION_ID" =~ '^[A-Za-z0-9_-]+$' \
  || ! "$CALLER_ATTESTATION" =~ '^smca_[A-Za-z0-9_-]+$' ]]; then
  echo "[policy-deny] caller attestation is not live codexroot provenance" >&2
  exit 2
fi
identity_json=$(curl --noproxy '*' -fsS \
  -X POST "$API_BASE/api/caller-identity" \
  -H 'Content-Type: application/json' \
  --data-binary "{\"token\":\"$CALLER_ATTESTATION\"}") || {
  echo "[policy-deny] caller attestation is not live codexroot provenance" >&2
  exit 2
}
if ! node -e '
  const value = JSON.parse(process.argv[1]);
  const expectedSessionId = process.argv[2];
  if (value?.ok !== true || value?.attested !== true ||
      value?.ownerSessionName !== "codexroot" || value?.sessionId !== expectedSessionId) process.exit(2);
' "$identity_json" "$CALLER_SESSION_ID"; then
  echo "[policy-deny] caller attestation is not live codexroot provenance" >&2
  exit 2
fi

# Dedup: if we already fired /reload within the dedup window, skip this tick.
# Marker lives next to scheduler.db / supermatrix.db in SuperMatrixRuntime/data so
# it survives logs/ rotation.
#
# The marker is a CLAIM, written before the lark-cli dispatch — not a receipt
# written after it. Writing it after left a window where a delivered /reload was
# never recorded: lark-cli exiting non-zero after the send, an unparseable result,
# or the process dying between send and touch all left the marker absent,
# so a later caller could re-send /reload and the box entered a reload loop
# (incident watchdog-kimi-acp-982f503). Claiming first makes dispatch at-most-once:
# once a tick owns the window, every later ambiguity fails CLOSED (exit 2, claim
# retained) instead of handing the next tick a fresh permit.
if [[ "$RELOAD_SOURCE" == "scheduled-daily" ]]; then
  RELOAD_DEDUP_WINDOW_SEC="${SM_RELOAD_DEDUP_WINDOW_SEC:-86400}"
  RELOAD_MARKER="$(dirname "$DB_PATH")/.last-reload-fired"
else
  RELOAD_DEDUP_WINDOW_SEC="${SM_MAINTENANCE_RELOAD_DEDUP_WINDOW_SEC:-300}"
  RELOAD_MARKER="$(dirname "$DB_PATH")/.last-maintenance-reload-fired"
fi
RELOAD_CLAIM_LOCK="${RELOAD_MARKER}.claim.lock"
# The claim critical section is a stat plus a write, so it never legitimately
# spans minutes; a lock older than this can only be a crashed section. Without the
# breaker a single SIGKILL would wedge safe reload permanently.
RELOAD_CLAIM_LOCK_STALE_SEC="${SM_RELOAD_CLAIM_LOCK_STALE_SEC:-300}"

file_mtime() {
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0
}

# Exits the script on a live claim; returns 0 when this tick may claim the window.
dedup_skip_if_claimed() {
  [[ -f "$RELOAD_MARKER" ]] || return 0
  local marker_age
  marker_age=$(( $(date +%s) - $(file_mtime "$RELOAD_MARKER") ))
  if (( marker_age < RELOAD_DEDUP_WINDOW_SEC )); then
    echo "[dedup-skip] age=${marker_age}s window=${RELOAD_DEDUP_WINDOW_SEC}s"
    exit 0
  fi
  return 0
}

# Fast path: answer the common "already reloaded today" tick without taking the
# lock or querying sqlite. Re-checked under the lock before claiming.
dedup_skip_if_claimed

# The scheduler starts a codexroot child whose sole job is to evaluate this
# gate. Exclude only that server-resolved child from the DB busy count; the
# runtime lifecycle still keeps the eventual /reload queued until it returns.
busy_query="SELECT COUNT(*) FROM sessions WHERE status = 'busy'"
if [[ -n "$CALLER_SESSION_ID" ]]; then
  busy_query+=" AND id != '$CALLER_SESSION_ID'"
fi
read_busy_count() {
  sqlite3 "$DB_PATH" "${busy_query};"
}

if [[ "$RELOAD_SOURCE" == "scheduled-daily" && "$RELOAD_FORCE" != "true" ]]; then
  # A 03:50 tick must not be lost because another session finishes seconds later.
  # Retry only inside the already-authorized 03:45-04:10 window; never create a
  # pending reload that could surprise unrelated sessions after the window.
  while true; do
    now_hhmm=$(date +%H%M)
    if [[ ! "$now_hhmm" =~ '^[0-9]{4}$' ]]; then
      echo "❌ could not resolve the local maintenance time" >&2
      exit 2
    fi
    now_number=$(( 10#$now_hhmm ))
    busy_count=$(read_busy_count) || {
      echo "❌ sqlite3 query failed" >&2
      exit 2
    }
    if (( now_number < 345 || now_number > 410 )); then
      echo "[busy-window-expired] count=$busy_count"
      echo "⏳ scheduled window ended; no reload was queued"
      exit 0
    fi
    [[ "$busy_count" -gt 0 ]] || break
    echo "[busy-wait] count=$busy_count"
    sleep 30
  done
else
  busy_count=$(read_busy_count) || {
    echo "❌ sqlite3 query failed" >&2
    exit 2
  }
  if [[ "$busy_count" -gt 0 && "$RELOAD_FORCE" != "true" ]]; then
    echo "[busy-skip] count=$busy_count"
    echo "⏳ $busy_count busy session(s), skipping reload"
    exit 0
  fi
fi
if [[ "$RELOAD_FORCE" == "true" ]]; then
  echo "[force-authorized] busy=$busy_count source=$RELOAD_SOURCE"
fi

# Claim the window. The lock only serializes check-and-claim so two ticks that both
# saw an aged-out marker cannot both dispatch; it is released before the send, so a
# dispatcher killed mid-send cannot wedge later ticks. What suppresses them is the
# claim, not the lock.
if [[ -d "$RELOAD_CLAIM_LOCK" ]]; then
  lock_age=$(( $(date +%s) - $(file_mtime "$RELOAD_CLAIM_LOCK") ))
  if (( lock_age > RELOAD_CLAIM_LOCK_STALE_SEC )); then
    echo "⚠️ breaking stale claim lock (age=${lock_age}s)" >&2
    rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true
  fi
fi

if ! mkdir "$RELOAD_CLAIM_LOCK" 2>/dev/null; then
  echo "[claim-contended] another safe-reload tick is claiming this window"
  exit 0
fi
trap 'rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true' EXIT

# Whoever held the lock may have just claimed the window under us.
dedup_skip_if_claimed

# Persist the claim BEFORE the side effect. Write-then-rename so a torn write can
# never surface as a valid-looking marker; flush so a crash cannot resurrect the
# permit and let the next tick re-send.
claim_tmp="${RELOAD_MARKER}.claim.$$"
printf 'claimed_at=%s source=%s\n' "$(date +%s)" "$RELOAD_SOURCE" > "$claim_tmp"
mv -f "$claim_tmp" "$RELOAD_MARKER"
sync 2>/dev/null || true

rmdir "$RELOAD_CLAIM_LOCK" 2>/dev/null || true
trap - EXIT

# All idle and window claimed — mint a one-shot permit named by a random nonce.
# The reload handler atomically renames this exact file before validating it, so
# a copied command cannot be replayed and a wrong nonce cannot consume the real
# permit. This closes direct root-group --source forgery while preserving the
# documented same-uid boundary.
PERMIT_NONCE=$(node -e 'process.stdout.write("smrp_" + require("node:crypto").randomBytes(16).toString("hex"))') || {
  echo "[permit-error] could not generate reload permit nonce" >&2
  exit 2
}
PERMIT_PATH="$(dirname "$DB_PATH")/.supermatrix-reload-permit.${PERMIT_NONCE}.json"
PERMIT_TMP="${PERMIT_PATH}.tmp.$$"
node -e '
  const fs = require("node:fs");
  const [path, nonce, source, force, callerSessionId, callerAttestationToken] = process.argv.slice(1);
  fs.writeFileSync(path, JSON.stringify({
    version: 1,
    operation: "reload-supermatrix",
    nonce,
    requestedAtMs: Date.now(),
    source,
    force: force === "true",
    actorSessionName: "codexroot",
    callerSessionId,
    callerAttestationToken,
  }) + "\n", { mode: 0o600 });
' "$PERMIT_TMP" "$PERMIT_NONCE" "$RELOAD_SOURCE" "$RELOAD_FORCE" "$CALLER_SESSION_ID" "$CALLER_ATTESTATION" || {
  echo "[permit-error] could not write reload permit" >&2
  exit 2
}
mv -f "$PERMIT_TMP" "$PERMIT_PATH" || {
  echo "[permit-error] could not publish reload permit" >&2
  exit 2
}

# Send /reload to the root group. From here on every failure keeps both the
# dispatch claim and permit because the message may already have been delivered.
if [[ "$RELOAD_FORCE" == "true" ]]; then
  reload_command="/reload force --source $RELOAD_SOURCE --permit $PERMIT_NONCE"
else
  reload_command="/reload --source $RELOAD_SOURCE --permit $PERMIT_NONCE"
fi
echo "✓ maintenance gate passed, triggering private reload source=$RELOAD_SOURCE force=$RELOAD_FORCE"
result=$("$LARK_CLI" im +messages-send --as user --chat-id "$ROOT_GROUP" --text "$reload_command") || {
  echo "[dispatch-ambiguous] lark-cli exited non-zero; the message may already be delivered" >&2
  echo "❌ lark-cli send failed; claim retained, no tick will re-send this window" >&2
  exit 2
}

# Verify the JSON contract rather than depending on lark-cli whitespace/formatting.
if ! node -e '
  const value = JSON.parse(process.argv[1]);
  if (value?.ok !== true) process.exit(2);
' "$result"; then
  echo "[dispatch-ambiguous] lark-cli did not return ok; the message may already be delivered" >&2
  echo "❌ claim retained, no tick will re-send this window: $result" >&2
  exit 2
fi

echo "[reload-fired]"
echo "✓ reload triggered"
exit 0
