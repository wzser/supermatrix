# Judgment contract

The primary row is a claim supported by a source communication and two
first-hand interview summaries. A radar hit alone is not evidence.

Sample (synthetic, not a real record):

```json
{
  "id": "judg-2099-01-02-001",
  "judgment_id": "judg-2099-01-02-001",
  "kind": "primary",
  "theme": "communication_gap",
  "user_visible_symptom": "One request was repeated twice because the caller could not tell whether the requested answer had been delivered.",
  "function_loss": "The caller spent time repeating the request and the original work remained blocked.",
  "evidence": {
    "source": "cross_session_log",
    "source_comm_id": "comm_stub_001",
    "interview_a": "A expected a concrete completion answer and had to ask again.",
    "interview_b": "B understood the request as a status note and did not know a completion answer was required."
  },
  "interview_a": "A expected a concrete completion answer and had to ask again.",
  "interview_b": "B understood the request as a status note and did not know a completion answer was required.",
  "confidence": "high",
  "gray_zone_hit": "none",
  "applied_to_rule": null,
  "status": "pending"
}
```

`id` and `judgment_id` are equal. The journal may later append status,
revision, feedback, and receipt events that point to the same ID. It never
rewrites the primary row. The table projection is narrower than the journal:
it contains only program-authoritative fields from `CONFIG.md`.
