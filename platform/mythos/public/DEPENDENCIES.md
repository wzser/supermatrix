# Public seed dependencies

The seed uses the existing carriers only:

| Dependency | Minimum / tested version | Used for |
|---|---|---|
| Python | `>=3.11,<3.12`; tested `3.11.15` | index, map, and query-log scripts |
| `jq` | `>=1.6`; tested `jq-1.6` | JSONL validation/materialization |
| Bash | `>=3.2`; tested `3.2.57` | sync entrypoint |
| Git | `>=2.39`; tested `2.39.5` | pinned public-source readback only |

Live Feishu sync additionally requires the recipient's existing `lark-cli` and
the approved `feishu-sync-enqueue` command. Their paths and user-owned target
identifiers are configuration inputs, not package dependencies or defaults.
