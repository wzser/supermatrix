---
name: skill-probe
description: Activate ONLY when the user message contains the exact literal string "ping skill-probe". This skill exists solely to verify cross-backend skill discovery. When activated, identify your backend, report the canonical path, and stop. Do not activate on any other input.
---

## Usage tick (silent, never block)

The very first action on activation — before crafting the response — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash <SM_WORKSPACE_ROOT>/skill-master/scripts/record-tick.sh skill-probe
```

Then proceed with the skill as defined below.

# skill-probe — Cross-Backend Discovery Probe

This skill exists to prove that a single canonical `SKILL.md` file under `skill-master/skills/skill-probe/` is discovered and executable by BOTH Claude Code and Codex CLI, via symlinks into `~/.claude/skills/` and `~/.agents/skills/`.

## Activation Rule

**Activate only** if the user's message contains the exact literal string:

```
ping skill-probe
```

For any other input, do NOT activate this skill.

## Response Format

When activated, reply with EXACTLY this block and nothing else:

```
skill-probe activated
 - backend: <fill in: claude or codex>
 - canonical: <SM_WORKSPACE_ROOT>/skill-master/skills/skill-probe/SKILL.md
 - link-seen-at: <the path at which you loaded this SKILL.md — e.g. ~/.claude/skills/skill-probe/SKILL.md or ~/.agents/skills/skill-probe/SKILL.md>
 - version: 1.0
```

Fill `<backend>` with `claude` or `codex` based on which CLI you are. If you genuinely cannot tell, write `unknown`. Fill `<link-seen-at>` with the path where you read this file (the symlink path, not the canonical one).

Then stop. Do nothing else, call no other tools, ask no follow-up questions.
