---
id: a1b2c3
name: judgment-via-interview
status: active
owner: receiving-agent
created: 2026-09-14
updated: 2026-09-14
description: When a communication signal suggests caller outcome loss, interview both sides and append one evidence-backed judgment; do not use for J-class Spawn2 exception adjudication.
---

# SOP: judgment via interview

## Use

Use for one suspected communication failure. Do not use for a J-class async
exception, a routine business task, or a report-only scan. The first executable
step is below; full field and table details are in `references/judgment-contract.md`.

## Step 1: capture one candidate

Read one candidate from the local radar. Record its source communication,
caller, target, prompt, and returned message. Do not classify it yet. If no
candidate has a source communication, stop as `pending_interview`.

## Step 2: interview A and B immediately

Use the exact templates in `references/interview-prompts.md`. Send two
Spawn2.0 requests with `from=$SM_SESSION_NAME`, a date-prefixed stable
`client_request_id`, and `closure.kind=message` with `target.type=inline`.
Wait for both terminal results. A transport receipt, `queued`, or process-alive
signal is not a terminal result.

## Step 3: write one judgment

Continue only when both interview results are terminal `completed` and contain
non-empty answers. Build one row that satisfies
`schemas/judgment.schema.json`. State the visible symptom and actual loss in
plain language; put the source communication and both interview summaries in
`evidence`. If the two accounts conflict, use `confidence=low` and keep the
case open; do not force a category.

## Step 4: append and project

Check that no primary row already has the same `judgment_id`. Append the row
through the local journal command, which stamps its own time. Project only the
program-authoritative fields listed in `CONFIG.md` and upsert by `judgment_id`
through the host's existing sync command. Never include `user_verdict` or
`user_note` in that payload. A queue acceptance is not a write/read-back
receipt; real sync is complete only after the host receipt says
`read_back_verified=true`.

## Step 5: close or hold

If evidence is complete, leave the judgment in the local append-only journal
and follow the host's existing closure check. If either interview, append, or
read-back receipt is unavailable, append a `pending` event with the reason and
do not invent a judgment. A later correction is a new append event, never an
in-place edit.

## Exceptions

| Case | Mechanical trigger | Action | Terminal state |
|---|---|---|---|
| source missing | candidate has no source communication | append `pending_interview`; request the missing locator through the host path | pending |
| A or B non-terminal | result status is `queued`, `running`, `failed`, or absent | retain the original request; do not judge or blindly retry | pending |
| conflicting accounts | both terminal, but intent or outcome differs | append evidence with `confidence=low`; escalate for review | awaiting_verdict |
| invalid row | schema validation fails | do not append the primary row; fix the row and validate again | pending |
| table sync unknown | no `read_back_verified=true` receipt | keep local row; retry only the failed sync step using the same key | pending |

## Prohibitions

Do not infer a judgment from `status=completed`, a radar field alone, a draft,
or one side's account. Do not use the retired report runner. Do not write
human-authoritative table fields.
