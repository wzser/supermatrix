#!/usr/bin/env bash
# Derive the canonical judgment RECORD snapshot from the append-only judgments.jsonl.
#
# Why this exists: judgments.jsonl is an append-only EVENT log (primary judgments +
# status-transition / feishu-record-bind / revision / verdict / status-correction rows),
# so line-count != record-count. The `kind` field is historically inconsistent
# (BARE / "primary" / "judgment" all mean "a primary judgment"), so kind-based counting
# is fragile. The robust record definition is CONTENT-based: a judgment record = the
# latest-state row per `id` that carries substantive fields (theme + user_visible_symptom).
#
# Output: a JSON array with exactly one element per distinct judgment id (latest state:
# confidence / status / user_verdict / applied_to_rule / bound record_id merged forward).
# This array's length is what the wendangwang freshness audit compares against the Feishu
# judgment table (Plan A, 2026-07-04). Regenerate it after every judgment落表 so it stays fresh.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
J="$DIR/state/judgments.jsonl"
OUT="$DIR/state/judgments-snapshot.json"

jq -s '
  def lastnn(rows; f): (rows | map(f) | map(select(. != null)) | last);
  # Group by (.id // .judgment_id): some substantive rows historically carry only
  # `judgment_id` and no top-level `id` (e.g. an abbreviated daily-review write emitted
  # before the primary row). Grouping on `.id` alone bucketed such a row under the `null`
  # id and emitted a phantom null-id "record", inflating the count by 1 vs Feishu
  # (reconcile rcpt_98c0086f82738a70: local 71 vs Feishu 70 on judg-2026-07-29-001).
  group_by(.id // .judgment_id)
  | map(
      . as $rows
      | ($rows | map(select((.theme // null) != null and ((.user_visible_symptom // "") | length) > 0)) | last) as $base
      | select($base != null)
      | $base
        | .judgment_id     = (.id // .judgment_id)
        | .confidence      = (lastnn($rows; .confidence)      // $base.confidence)
        | .status          = (lastnn($rows; .status)          // $base.status)
        | .user_verdict    = (lastnn($rows; .user_verdict)    // $base.user_verdict)
        | .applied_to_rule = (lastnn($rows; .applied_to_rule) // $base.applied_to_rule)
        | .record_id       = (lastnn($rows; .record_id)       // null)
    )
  | sort_by(.id)
' "$J" > "$OUT"

echo "wrote $OUT ($(jq 'length' "$OUT") records)"
