# SOP Index

> Local source-of-truth for this session's SOPs.
> Feishu Wiki mirror root: `<root-wiki-url>` *(remove this line if the session does not mirror to Feishu)*

## When to write or update an SOP — event-triggered, not periodic

Wrap-up checklists must hit this rule. Two events force an SOP write **before the current task is finished**:

1. **New business process** — As soon as the process design is confirmed (steps, owner, trigger), create `sop/<name>.md` and register it in this INDEX. Do not run the process even once without an SOP file in place.
2. **Change to any element of an existing process** — If during actual work you change any of the following, write the correction back into the relevant SOP **before finishing the task**:
   - Trigger condition (when the process runs)
   - Input source / data shape / prerequisites
   - Processing logic, judgment rules, or decision branches
   - Output artifact (file path, table, message format)
   - Downstream consumer (which session / human / job picks it up)
   - Verification or rollback step

"I'll write it after" never happens — every later turn has its own next task. The trigger fires inside the same task that introduced the change.

## Sync side-effect (fill in if this session mirrors SOPs externally)

> If this session mirrors `sop/*.md` to Feishu Wiki, Bitable, or any other surface, declare the post-edit hook here so it becomes part of the same wrap-up boundary. Example:
>
> `After any sop/*.md change, run: python3 scripts/sync_sop_to_feishu.py --root-wiki-url '<url>' before finishing the task.`

## SOP list

| SOP | Description |
|-----|-------------|
| [example.md](example.md) | One-line description of what the SOP solves |
