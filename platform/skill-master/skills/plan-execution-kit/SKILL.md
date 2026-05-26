---
name: plan-execution-kit
description: Use when you have a written implementation plan (typically from superpowers:writing-plans) and want to execute it via SuperMatrix's 4-mode supervisor loop — inline / mixed subagents / all-Codex sub-sessions / all-Claude sub-sessions — with reverse-backend independent verification. Reuses YOLO's plan.json + allocation gate + L1/L2 verifier bins instead of reimplementing them. Skip this skill and use superpowers:executing-plans or superpowers:subagent-driven-development directly if you don't need cross-backend dispatch.
---

# Plan Execution Kit

## Why this exists

`superpowers:executing-plans` and `superpowers:subagent-driven-development` are the standard ways to run a plan, but neither offers a **batch backend preset**: "run every task on Codex" or "run every task on Claude". They also don't ship reverse-backend independent verification.

YOLO already implements both. This skill is a thin wrapper that lets any session reuse YOLO's machinery for plan execution **without** copying code. Zero YOLO-side changes; everything works through YOLO's existing `--workspace` flag on the relevant bin scripts.

## When to use vs not

```
Have a landed plan and need to execute it?
├── Pure inline, single-session, no review checkpoints
│   → use superpowers:executing-plans (don't bother with this skill)
├── Mixed per-task backend, Claude controller, in-session reviewers
│   → use superpowers:subagent-driven-development directly
└── Want batch preset (all-Codex / all-Claude) OR want reverse-backend verifier
    → use THIS skill
```

## Prerequisites

- `<SM_WORKSPACE_ROOT>/yolo/` must exist (this skill calls its bins by absolute path)
- SuperMatrix `/api/spawn` must be reachable on `http://localhost:3501`
- You know your own session name (the value you'd put in `target` when spawning to yourself) — typically discoverable from `CONSTITUTION.md` or env

## The workflow

### Step 1 — Bootstrap

Pick a workdir where `runs/` will be created (typically your current workspace). Run:

```bash
RID=$(<SM_WORKSPACE_ROOT>/skill-master/skills/plan-execution-kit/bin/sp-plan-bootstrap \
  --plan path/to/your-plan.md \
  --workspace . \
  --target-session "<your-session-name>")
echo "run_id=$RID"
```

Parses every `### Task N: <title>` block in the plan, writes `runs/<RID>/plan.json` and `runs/<RID>/tasks/T<NNN>/prompt.md` per task. Sequential `deps` by default (T002 depends on T001, etc.). Returns the RID on stdout.

### Step 2 — Pick execution mode (4-way menu)

Render the allocation menu:

```bash
YOLO=<SM_WORKSPACE_ROOT>/yolo
$YOLO/bin/yolo-allocation-render --workspace . --run-id "$RID"
```

YOLO's menu wording uses backend × tier (A/B/C/D = Claude strong / Codex strong / Claude weak / Codex weak). The choice maps to the user's 4-mode ask as follows:

| User-facing mode | Map to YOLO letter | Notes |
|---|---|---|
| Inline (single session, no spawn) | none — bail out | Use `superpowers:executing-plans` instead |
| Mixed subagents (per-task choice) | none — bail out | Use `superpowers:subagent-driven-development` |
| All Codex sub-sessions | B (strong) or D (weak) | Tier choice up to user |
| All Claude sub-sessions | A (strong) or C (weak) | Tier choice up to user |

Show the user the menu, take their letter, apply it:

```bash
$YOLO/bin/yolo-allocation-apply --workspace . --run-id "$RID" --reply "<A|B|C|D>" \
  --now-iso "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
```

If user wanted mode 1 or 2 in step 2, **stop here** and hand off to the appropriate superpowers skill.

### Step 3 — Dispatch loop

For each task in topological order (deps satisfied → ready):

```bash
TID="T001"   # iterate
PROMPT=$(cat runs/$RID/tasks/$TID/prompt.md)
BACKEND=$(python3 -c "
import json
d = json.load(open('runs/$RID/plan.json'))
t = next(x for x in d['tasks'] if x['id'] == '$TID')
print(t.get('backend') or '')
")

# Mark dispatched
$YOLO/bin/yolo-plan-update --workspace . --run-id $RID set-status \
  --task-id $TID --status dispatched \
  --dispatched-at "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"

# Build spawn body. target = your session (so child gets your workdir),
# backend = the per-task override from allocation.
BODY=$(python3 -c "
import json
print(json.dumps({
  'target': '<your-session-name>',
  'from': '<your-session-name>',
  'backend': '$BACKEND' or 'claude',
  'prompt': open('runs/$RID/tasks/$TID/prompt.md').read(),
}))")

RESP=$(curl -s -X POST http://localhost:3501/api/spawn \
  -H 'Content-Type: application/json' -d "$BODY")

echo "$RESP" > runs/$RID/tasks/$TID/dispatch.json
echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin,strict=False); print(d.get("finalMessage",""))' \
  > runs/$RID/tasks/$TID/result.md

CSID=$(python3 -c 'import json; d=json.load(open("runs/'"$RID"'/tasks/'"$TID"'/dispatch.json"),strict=False); print(d.get("childSessionId",""))')

$YOLO/bin/yolo-plan-update --workspace . --run-id $RID set-status \
  --task-id $TID --status returned --returned-at "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" \
  --child-session-id "$CSID"
```

### Step 4 — L1 review (BASH evidence — optional, skipped in v1 unless plan uses prefixes)

If your `prompt.md` has acceptance criteria like:

```
## Acceptance Criteria
- [ ] BASH: pytest tests/test_new_feature.py
- [ ] LLM: code follows repo's naming conventions
- [ ] REPORT: implementer must list files changed
```

then L1 BASH validation runs automatically:

```bash
$YOLO/bin/yolo-review-evidence --workspace . --run-id $RID --task-id $TID
```

Outputs JSON with `all_bash_pass`. If `false`, set status `rejected`.

LLM/REPORT criteria go to the LLM judge:

```bash
$YOLO/bin/yolo-review-judge --workspace . --run-id $RID --task-id $TID
```

If the plan has no acceptance criteria at all, L1 short-circuits to accept — fine for v1.

### Step 5 — L2 reverse-backend verifier

For each task that passed L1, run an independent verifier on the **opposite** backend:

```bash
PLAN=$($YOLO/bin/yolo-verifier plan --workspace . --run-id $RID --task-id $TID)
SKIP=$(echo "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("skip", False))')

if [ "$SKIP" != "True" ]; then
  VSESS=$(echo "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verifier_session"])')
  VPROMPT=$(echo "$PLAN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["prompt"])')
  DISPATCHED=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)

  RESP=$(curl -s -X POST http://localhost:3501/api/spawn \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,os; print(json.dumps({'target': os.environ['VSESS'], 'prompt': os.environ['VPROMPT']}))" )")
  RETURNED=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)

  FM=/tmp/sp-verifier-$RID-$TID.txt
  echo "$RESP" | python3 -c 'import json,sys; d=json.load(sys.stdin,strict=False); sys.stdout.write(d.get("finalMessage","") if d.get("ok") else "")' > "$FM"

  $YOLO/bin/yolo-verifier submit --workspace . --run-id $RID --task-id $TID \
    --dispatched-at "$DISPATCHED" --returned-at "$RETURNED" \
    --final-message-file "$FM"
fi
```

Routing is automatic per YOLO's `_BACKEND_ROUTING`: Claude-side tasks get verified by Codex (target=`codexroot`), Codex-side tasks get verified by Claude (target=`yolo`). If you don't want this, add `# skip_verifier` to the top of `prompt.md`.

### Step 6 — Finalize

When all tasks are `accepted`:

```bash
$YOLO/bin/yolo-plan-update --workspace . --run-id $RID set-run-status --status done
```

Print a one-line summary to the user. Done.

## Failure handling (v1 cut)

v1 has **no automatic replan**. On any task rejection (L1 fail / L2 reject), set the task `status=rejected`, set run `status=paused`, surface the rejection reason from `tasks/<TID>/review.md` or `tasks/<TID>/verifier.md` to the user, and stop. The user decides whether to fix the task manually, re-dispatch, or revise the plan.

v1.1 will add YOLO's `replan_policy.py` (N-strike → replan → contract revision).

## What v1 explicitly does NOT support

- **Heartbeat / async self-spawn** — long runs (> 30 min) can hit context overflow. Workaround: split the plan, finish in multiple sessions.
- **Pre-flight conditions** — no `[check: ...]` env-var validation. Caller must verify deps manually before calling Step 1.
- **Contract reverse reconciliation** — no `@contract:N` annotation linking back to a mission. Plan is the contract; we trust it.
- **Mode 1 (inline) and Mode 2 (mixed)** — bail out and call the existing superpowers skills.

## Integration with superpowers

- `superpowers:writing-plans` — produces the input plan.md
- `superpowers:executing-plans` — Mode 1 fallback
- `superpowers:subagent-driven-development` — Mode 2 fallback
- `superpowers:finishing-a-development-branch` — call after run_status=done

## Files

- `bin/sp-plan-bootstrap` — Python helper, plan.md → YOLO runs/ layout (the only new code in this skill; everything else is shell calls to existing YOLO bins)

## Owner / source of truth

skill-master owns this skill. YOLO owns the underlying bins; reuse, do not fork.
