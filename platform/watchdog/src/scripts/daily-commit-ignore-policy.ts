export const DAILY_COMMIT_IGNORE_POLICY_RELATIVE_PATH = "sop/daily-commit-ignore-policy.md";
export const DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH =
  process.env.WATCHDOG_DAILY_COMMIT_IGNORE_POLICY_PATH ?? DAILY_COMMIT_IGNORE_POLICY_RELATIVE_PATH;
export const DAILY_COMMIT_IGNORE_POLICY_SOP = DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH;

export const DAILY_COMMIT_IGNORE_POLICY_PROMPT = `Daily Commit ignore policy (${DAILY_COMMIT_IGNORE_POLICY_SOP}):

Ownership:
- watchdog owns the global daily-commit ignore policy: allowlist, denylist, auto-remediate limits, skip classification, and owner notification wording.
- owner handoff is a last resort; watchdog should resolve about 90% of daily-commit skips itself by deferring inactive/stale repos, auto-remediating narrow machine noise, safe-committing reviewed low-risk changes, or filing watchdog-owned process issues.
- repo owner owns repo-local .gitignore entries for business outputs, generated captures, exports, screenshots, media, and data directories only after watchdog has ruled out safe self-resolution.
- first-principle owns identity-document governance for CLAUDE.md / AGENTS.md major changes.
- scheduler owns the cron trigger and lifecycle only; it does not own dirty-worktree content decisions.

allowlist / auto-remediate:
- Auto-remediate may add .gitignore entries only for low-risk, reproducible machine noise: dependency folders, build outputs, language caches, test coverage, tool caches, temporary logs, OS/editor files, and clearly disposable runtime scratch directories.
- The entry must be narrow enough to cover the observed noise without hiding source, configs, data deliverables, or review evidence.
- After adding .gitignore entries, re-screen the full dirty set. Commit only if the new dirty set is still one logical, safe change.

denylist / never auto-ignore:
- Never auto-ignore or auto-commit secrets, tokens, credential-adjacent config, private customer/business data, raw exports, database files, database WAL/SHM files, archives, binaries/media that may be deliverables, or any file the reviewer cannot read.
- Never use .gitignore to hide merge conflicts, branch-divergence symptoms, unclear ownership, or unrelated mixed changes.
- Never approve Feishu routing, scheduler, framework routing, spawn, issue queue, notification, or other shared platform behavior changes without executable verification.

owner-routed:
- artifacts/, outputs/, data/, exports, screenshots, media, capture runs, generated reports, and business evidence are owner-routed by default. In some repos they are trash; in others they are the deliverable.
- Owner-routed is not automatic handoff. First prefer watchdog-owned outcomes: defer quiet/stale repos, auto-remediate clearly disposable allowlisted noise, or safe-commit readable one-logical-unit changes that do not contain private data, secrets, raw exports, databases, archives, or shared-platform behavior.
- Return UNSURE/NO for repo owner only when domain judgment is genuinely required: unclear deliverable semantics, private/customer data, credential risk, unreadable binaries/databases, mixed changes, or a repo-local ignore rule that cannot be proven narrow from the diff.
- Process failures, Codex timeouts, reviewer stalls, and wall-clock budget skips are watchdog-owned. Do not route those to repo owners.`;
