---
name: smallmodel-manager
description: Use when adding a new model endpoint to the local registry, choosing a managed model for an implementation task, or generating a direct connection plan with api_key, base_url, pricing, and network requirements.
---

## Usage tick (silent, never block)

The very first action on activation — before doing any work — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash /Users/LOCAL_USER/SuperMatrixRuntime/workspaces/skill-master/scripts/record-tick.sh smallmodel-manager
```

Then proceed with the skill as defined below.

# Smallmodel Manager

This skill manages a local registry of model endpoints. It does not proxy requests. It tells the caller which model to use and gives them the exact connection parameters they can write directly into code.

## When To Use

- 新增模型到本地目录
- 根据任务推荐模型
- 输出可直接接入代码的模型参数

## Required Sources

Resolve the registry root first. If SMALLMODEL_MANAGER_ROOT is set, use that path; otherwise use `/Users/LOCAL_USER/CodexSkills/smallmodel-manager`.

Read these files before answering:
- `$ROOT/catalog/providers/*.yaml`
- `$ROOT/catalog/models/*.yaml`
- `$ROOT/catalog/secrets.local.yaml`
- `$ROOT/state/verification.local.yaml`

## Intake Flow For 新增模型

1. Ask for the raw materials only if they were not already provided:
   - `API key`
   - official docs link or file
   - optional `base_url` or model name
2. Extract the provider transport, auth method, model name, pricing, recommended use cases, and network requirements from the docs.
3. Write or update:
   - one provider file in `catalog/providers`
   - one model file in `catalog/models`
   - local secrets in `catalog/secrets.local.yaml`
4. If a critical field is still missing after reading the docs, ask exactly for that missing field.
5. Run the real smoke test before marking the model ready for recommendation.

## Recommendation Flow For 推荐模型

1. Read the caller's need and map it to `recommended_for`.
2. Prefer active, verified models with an exact `recommended_for` match. A model that is `supported_agent_verified` (see the special case below) counts as verified for this purpose.
3. If there is no verified exact match, use the model whose `default_for` contains `fallback`.
4. Always provide one primary recommendation and one fallback when available.
5. Surface pricing and network constraints in the final answer. When a price or quota field is tagged UNVERIFIED in `source_notes`, say so instead of quoting it as fact.

## Verification Staleness And Re-Smoke

A `verified: true` record in `state/verification.local.yaml` is only trustworthy while the upstream model is unchanged. Re-run the smoke test (`scripts/run_smoke_tests.py`) and, until it passes, set `verified: false` with a short reason when ANY of these holds:

- the provider renames the model or ships a new generation (e.g. `MiniMax-M2.7` → `MiniMax-M3`);
- the documented `base_url`, auth, pricing tier, or quota window changes;
- the last `checked_at` is older than 90 days.

Do not recommend an unverified model as the verified primary or fallback; record it, flag it as needing a re-smoke, and tell the caller.

## Special Case: supported_agent_only

When `verification.mode` is `supported_agent_only`, do not treat a generic HTTP `403` as proof that the provider is unusable.

- The `403` whitelist applies to the raw OpenAI-compatible HTTP path, NOT to the Anthropic-compatible entrypoint a supported agent uses.
- Verify the model through an officially supported coding agent first.
- For `Kimi`, the accepted agents include `Kimi CLI`, `Claude Code`, `Roo Code`, `Kilo Code`, and `OpenCode`.
- For `Claude Code`, use `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` (the `/coding/` path is not subject to the OpenAI-path whitelist).
- Keep `ENABLE_TOOL_SEARCH=false` for the Kimi Claude Code path.
- The locally verified non-interactive command is:

```bash
ENABLE_TOOL_SEARCH=false \
ANTHROPIC_BASE_URL=https://api.kimi.com/coding/ \
ANTHROPIC_API_KEY="$KIMI_KEY" \
npx -y @anthropic-ai/claude-code \
  --bare \
  --print \
  --output-format json \
  --permission-mode bypassPermissions \
  --tools "" <<'EOF'
Reply with exactly OK and nothing else.
EOF
```

If this path succeeds, record the result in `state/verification.local.yaml` as `supported_agent_verified: true` without flipping the generic `verified` field to `true`.

## Output Contract

Always return:
- `provider`
- `model`
- `base_url`
- `api_key`
- `auth`
- `network`
- `price`
- `why this model`
- `fallback`
- `verification status`

## Guardrails

- Never invent `base_url`, auth headers, or pricing.
- Never recommend a model as the default if its latest verification failed and another verified fallback exists.
- Keep secrets in local files only.
- If the docs conflict with existing catalog data, update the catalog instead of guessing.
- For `supported_agent_only` models, return the agent configuration path instead of pretending the caller can use a normal raw HTTP SDK flow.
