# Public SOP Principle

Every reusable procedure identifies its inputs, outputs, decisions, idempotent
key, evidence and at least three mechanically distinguishable failure cases.
Parameters belong in configuration; examples must be safe public examples.

Each stage records evidence that can be checked independently. A pending,
queued, accepted or process-alive state is not terminal completion. External
writes use the registered owner and queue entrypoint, require terminal
read-back, and remain fail-closed when that evidence is unavailable.

Verify a change with lint, the smallest relevant test, and an idempotent
rerun. Do not introduce a watcher, retry layer or alternate writer merely to
hide a defect in the owner mechanism.
