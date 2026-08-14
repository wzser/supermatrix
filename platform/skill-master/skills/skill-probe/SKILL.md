---
name: skill-probe
description: Activate ONLY when the user message contains the exact literal string "ping skill-probe". This skill exists solely to verify cross-backend skill discovery. When activated, identify your backend, report the canonical path, and stop. Do not activate on any other input.
---

## Usage tick (silent, never block)

The very first action on activation — before crafting the response — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master/scripts/record-tick.sh skill-probe
```

Then proceed with the skill as defined below.

# skill-probe — Cross-Backend Discovery Probe

This skill exists to prove that a single canonical `SKILL.md` file under `skill-master/skills/skill-probe/` is discovered and executable by Claude Code, Codex CLI, and Kimi Code. Claude Code discovers it via `~/.claude/skills/`; Codex discovers it via `~/.agents/skills/`; managed Kimi Code discovers it via `$KIMI_CODE_HOME/skills` (normally `~/.kimi-code/skills/`). `~/.kimi/skills/` remains a legacy mirror for direct-CLI compatibility.

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
 - backend: <fill in: claude, codex, or kimi>
 - canonical: /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master/skills/skill-probe/SKILL.md
 - link-seen-at: <the path at which you loaded this SKILL.md — e.g. ~/.claude/skills/skill-probe/SKILL.md, ~/.agents/skills/skill-probe/SKILL.md, or ~/.kimi-code/skills/skill-probe/SKILL.md>
 - version: 1.0
```

Do not rename the keys, reorder the lines, or replace this block with a summary. Fill `<backend>` with `claude`, `codex`, or `kimi` based on which CLI you are. If you genuinely cannot tell, write `unknown`.

Fill `canonical` with the exact canonical path shown above. Fill `<link-seen-at>` with the path where you read this file (the symlink path, not the canonical one). For managed Kimi Code, the expected `link-seen-at` is normally `~/.kimi-code/skills/skill-probe/SKILL.md`; raw Kimi CLI without a controlled native directory may use `~/.agents/skills/skill-probe/SKILL.md`.

Then stop. Do nothing else, call no other tools, ask no follow-up questions.
