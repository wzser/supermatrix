---
id: d4e5f6
name: spawn-exception-transaction
status: active
owner: receiving-agent
created: 2026-09-14
updated: 2026-09-14
description: When the host watcher hands over one J-class stalled Spawn2.0 item, adjudicate its immutable snapshot and write one authoritative verdict; do not process D-class retries.
---

# SOP: Spawn2 exception transaction

## Use

Use only when the host watcher supplies one J-class async reference and its
communication ID. Do not use for D-class deterministic redelivery, daily
interviews, or original business execution. Full samples are in
`references/exception-contract.md`.

## Step 1: freeze one snapshot

Read the supplied async item, its same-communication evidence, and the three
available delivery/execution checks. Write one `status=open` event containing
the complete snapshot to the local exception ledger. Do not refresh the
evidence after the snapshot is frozen.

## Step 2: classify one outcome

Classify only from snapshot evidence: `b_fault`, `contract_fault`,
`business_satisfied_elsewhere`, `false_alarm`, or `suspended`. The last two
require explicit reasons. `business_satisfied_elsewhere` additionally requires
proof that the original communication failed, an equivalent/redrive result was
delivered, and the caller can retrieve it.

## Step 3: record intent and act once

Append one `status=intent` event before the action. Redrive only when the host
owner contract proves that it is safe and idempotent; otherwise park or
escalate. Patch at most one contract in this transaction. Do not send a bare
control message to the target and do not create a local watcher.

## Step 4: close both ledgers

Append one `status=closed` event with the final verdict and reason. The host
owner must write the same verdict and reason to the authoritative async item;
the local ledger is detail, not a substitute. Verify the host read-back before
calling the transaction closed.

## Exceptions

| Case | Mechanical trigger | Action | Terminal state |
|---|---|---|---|
| incomplete snapshot | async item or same-communication evidence is missing | append `suspended`; request evidence from the host watcher | parked |
| still running | child/run is not terminal | append `intent` for wait; use the host heartbeat path | pending |
| safe B fault | terminal evidence shows target work did not execute and idempotent redrive is proven | use the existing owner redrive path once; write `retrying` | re-driving |
| contract fault | target/schema/permission evidence is invalid | park and identify the one contract repair; do not redrive | parked |
| delivery already proven | result and target delivery evidence both exist | record `false_alarm`; write back verdict | closed |
| writeback unknown | host verdict read-back is absent or ambiguous | retain local closed-intent evidence but do not claim closure | pending |

## Prohibitions

One `ref` per transaction. One snapshot per transaction. No batch stop-storm
unless the user explicitly authorizes same-chain containment. Never treat
`queued`, `accepted`, HTTP success, or a live process as business completion.
