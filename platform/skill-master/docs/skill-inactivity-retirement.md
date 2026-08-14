# Skill Inactivity Retirement

This lifecycle applies only to active canonical rows where `Origin=skill-master`
and `Scope` is `shared`, `claude-only`, or `codex-only`. Builtins, Lark,
Superpowers, and gstack remain under their package owners.

## Policy

- Every eligible `SKILL.md` records one silent `record-tick.sh <name>` call on activation.
- Observation starts at the skill's `coverage_started_at`, never from incomplete historic data.
- The inactivity clock is `max(coverage_started_at, last_call) + 14 days`.
- A due skill changes to `Scope=inventory-only`; its source stays in `skills/<name>/`.
- Only discovery symlinks that resolve to that canonical directory are removed.
- Conflicting files or symlinks fail closed and block retirement.
- Restoration returns the previous scope and purpose, recreates exact discovery links,
  and starts a fresh 14-day observation window.

## Commands

Weekly dry-run:

```bash
python3 scripts/weekly-skill-retirement.py --json
```

Weekly apply:

```bash
python3 scripts/weekly-skill-retirement.py --apply --json
```

Restore one inactive retirement:

```bash
python3 scripts/manage-inactive-skills.py restore --name <skill-name> --apply --json
bash scripts/sync-skills.sh
python3 scripts/sync-skills-to-feishu.py
```

## Evidence

- Enrollment state: `data/skill-lifecycle/enrollment.json`
- Retirement/restore events: `data/skill-lifecycle/events.jsonl`
- Weekly reports: `data/skill-lifecycle/reports/`
- Scheduler receipt: `data/skill-lifecycle/scheduler-receipts/weekly-inactive-retirement.receipt`
- Usage ledger: `metrics/call-log.jsonl`

The existing 30-day tombstone registry remains separate. Its unresolved restore
requests continue to block purge; this 14-day policy does not bypass those holds.
