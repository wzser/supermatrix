---
name: web-access
description: Layered web browser access over managed Chrome profiles (CDP proxy), with soft routing to generic/amzlisting/amzh10 packs.
---

## Usage tick (silent, never block)

The very first action on activation — before doing any work — is to fire this command once and ignore any output or failure. It records one line to the local call log. Do not wait on it, do not mention it to the user.

```
bash <SM_WORKSPACE_ROOT>/skill-master/scripts/record-tick.sh web-access
```

Then proceed with the skill as defined below.

# web access

## Overview

This is the top-level entrypoint for routed browser automation over managed Chrome profiles. Use managed Chrome profiles, not the user's default Chrome profile, as the primary runtime. v1 stays on Chrome/CDP: do not launch a separate Chromium/Playwright engine.

This skill soft-routes each request into one of these packs:

- `generic`: general-purpose web tasks.
- `amzlisting`: Amazon retail product listing tasks.
- `amzh10`: Helium 10 members (members.helium10.com) tasks.

Successful browser work should strengthen the repo, not just return data. After a final classified run, write verified site-pattern observations back best-effort for first-class domains and then clean up automation-created tabs by default.

## Core Rules

- Use managed Chrome profiles as the runtime. `defaultProfile` is the fallback browser identity unless the user explicitly requests `--profile <name>` or another named profile.
- Switching profiles replaces the currently managed browser instance; do not silently drift to another browser identity.
- Use the local CDP proxy HTTP API for browser actions in `generic` and `amzh10`. Reference: `references/core/cdp-api.md`.
- Exception: `amzlisting` uses a pack-local direct CDP helper to connect to the selected managed Chrome profile; it also writes captures to a deterministic local capture path. Do not route `amzlisting` through the proxy.
- Tab safety: only reuse tabs that are `automation-created` (created by this skill) or explicitly `user-approved` for automation. Otherwise create a new background tab.
- Be explicit about what you will do before you click/type/upload. Ask before destructive actions (checkout, purchase, account changes).
- If the site requires auth or 2FA, ask the user to complete login inside the current managed profile, then continue using that same browser identity.
- Keep actions deterministic: prefer direct URL navigation and stable selectors; avoid brittle, multi-step UI flows when an equivalent URL exists.

## Routing Priority

Routing is best-effort and is intentionally overridable ("soft routing"):

1. Explicit mode hints in the user's message (highest priority)
2. Explicit URL/domain match (for example, Amazon retail -> `amzlisting`, Helium 10 -> `amzh10`)
3. Raw ASIN-only input routes to `amzlisting` after normalizing the ASIN to the canonical Amazon PDP URL
4. Best-effort heuristics from task wording and page characteristics (may be wrong; ask if ambiguous)
5. Fallback -> `generic`

Details and exact trigger phrases: `references/core/routing-rules.md`.

After selecting a mode, consult the corresponding pack doc and site-pattern notes:

- `references/packs/generic.md`
- `references/packs/amzlisting.md`
- `references/packs/amzh10.md`
- `references/site-patterns/amazon.com.md`
- `references/site-patterns/members.helium10.com.md`

When a run validates stable page characteristics, update the matching first-class site-pattern note best-effort instead of leaving those references static.

## Managed Chrome Core (v1)

Core scripts:

- `scripts/core/browser-profile.mjs`: resolves `defaultProfile`, explicit `--profile`, and the active managed browser state
- `scripts/core/check-deps.mjs`: ensures the selected managed profile and proxy are ready
- `scripts/core/cdp-proxy.mjs`: HTTP API that connects to the active managed Chrome profile via CDP
- `scripts/core/chrome-endpoint.mjs`: low-level endpoint helpers (`DevToolsActivePort`, browser URLs, port checks)

Operational notes:

- Profiles live in the managed profile registry; `defaultProfile` is the default unless the task or script explicitly chooses `--profile`.
- Assume a long-running proxy is available and should be reused if already running.
- Start or refresh the selected managed profile with `node scripts/core/check-deps.mjs --profile <name>` when needed.
- Do not treat the user's default Chrome profile as the automation runtime.

## Tab Lifecycle Rules

- Default: create a new background tab for automation work.
- Reuse policy: only reuse a tab that is `automation-created` or explicitly `user-approved` for automation (the user confirms the target by title/url/targetId).
- Never click/type/navigate in a user-owned tab unless it is explicitly `user-approved` for automation.
- Never close or navigate away a user's active tab without explicit permission.
- Automation-created working tabs should close by default after any terminal state (`ok`, `partial`, `blocked`, `dog`, `error`).
- `--keep-open` is the only explicit override for leaving automation-created tabs open after a final classified run.
- Keep the number of automation tabs small (target: <= 3 at a time).
- Prefer `/click` for normal interactions; use `/clickAt` when a real user-gesture is required; use `/setFiles` for file inputs.

## Mode: `generic`

Use for general websites and unknown domains.

Typical tasks:

- open a URL, extract text/tables, summarize
- take screenshots of key sections
- fill forms and capture confirmation states

Profiles define browser identity and account context; `generic` defines only the business flow.

## Mode: `amzlisting`

Use for Amazon retail product listing pages (amazon.* marketplaces).

Typical tasks:

- extract: title, brand, ASIN, price, images, bullets, variations
- capture screenshots of above-the-fold and key sections
- validate availability and seller context (without purchasing)
- raw ASIN input is case-insensitive and should be normalized to uppercase before navigation to the canonical Amazon PDP URL
- Amazon dog pages are business-status captures: `status = "dog"` and `status_reason = "amazon_dog_page"`, not crawler failures
- item capture paths are deterministic and local: profile/date/uppercase ASIN under the repo-managed capture root
- successful `amzlisting` runs should write verified Amazon observations back into `references/site-patterns/amazon.com.md`
- site-pattern writeback is best-effort and should use the final classified payload, not intermediate guesses
- automation-created tabs close by default after the terminal state unless `--keep-open` is explicitly set

Profiles define browser identity and account context; `amzlisting` defines the Amazon-specific extraction logic.

## Mode: `amzh10`

Use for Helium 10 workflows on `members.helium10.com`.

Typical tasks:

- navigate to tools (e.g., Cerebro/Black Box) and extract results tables
- capture screenshots for key metrics/filters
- export/download flows only with explicit user permission
- successful H10 work should strengthen `references/site-patterns/members.helium10.com.md` when the run validates stable page characteristics
- automation-created working tabs should close by default after the terminal state unless debugging explicitly requires `--keep-open`

Profiles define browser identity and account context; `amzh10` defines the Helium 10-specific business flow.
