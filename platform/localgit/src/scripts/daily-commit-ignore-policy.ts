import { resolve } from "node:path";
import { LOCALGIT_ROOT } from "./localgit-context.js";

export const DAILY_COMMIT_IGNORE_POLICY_RELATIVE_PATH = "sop/references/daily-commit-ignore-policy.md";
export const DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH =
  resolve(LOCALGIT_ROOT, DAILY_COMMIT_IGNORE_POLICY_RELATIVE_PATH);
export const DAILY_COMMIT_IGNORE_POLICY_SOP = DAILY_COMMIT_IGNORE_POLICY_ABSOLUTE_PATH;

export const DAILY_COMMIT_IGNORE_POLICY_PROMPT = `Daily Commit ignore policy (${DAILY_COMMIT_IGNORE_POLICY_SOP}):

Ownership:
- localgit owns the global daily-commit ignore policy: allowlist, denylist, auto-remediate limits, skip classification, and owner notification wording.
- localgit's priority is not to empty every dirty workspace. It must protect must-commit behavior changes: source, config, tests, scheduler/spawn/reload wiring, AGENTS.md/CLAUDE.md, SOPs, Principles, templates, package files, migrations, and schema changes.
- artifact-only dirty sets are quiet-deferred by default: raw business exports, generated reports, captures, screenshots, run outputs, logs, caches, SQLite runtime databases, media, and temporary files are recorded but should not wake the repo owner.
- stale/inactive gating applies only after localgit has ruled out must-commit paths. Stale source/config/test/SOP/identity-doc changes are localgit-owned must-review backlog, not quiet-deferred.
- repo owner owns repo-local .gitignore entries for business outputs, generated captures, exports, screenshots, media, and data directories when a must-commit change is blocked by domain-specific artifact semantics.
- first-principle owns identity-document governance for CLAUDE.md / AGENTS.md major changes.
- scheduler owns the cron trigger and lifecycle only; it does not own dirty-worktree content decisions.

allowlist / auto-remediate:
- Auto-remediate may add .gitignore entries only for low-risk, reproducible machine noise: dependency folders, build outputs, language caches, test coverage, tool caches, temporary logs, OS/editor files, and clearly disposable runtime scratch directories.
- The entry must be narrow enough to cover the observed noise without hiding source, configs, data deliverables, or review evidence.
- After adding .gitignore entries, re-screen the full dirty set. Commit only if the new dirty set is still one logical, safe change.

denylist / never auto-ignore:
- Never auto-ignore or auto-commit verified access credentials (secrets, tokens, private keys, session cookies, or credential-bearing config), database files, database WAL/SHM files, archives, binaries/media that may be deliverables, or any file the reviewer cannot read.
- Privacy alone is not a deny condition in this local-only Git history: Feishu group IDs/names, local personal data, and readable customer/business data may be committed when their file semantics are otherwise eligible. Artifact paths still use the repo-policy manifest for deliverable/rebuildability judgment.
- Never use .gitignore to hide merge conflicts, branch-divergence symptoms, unclear ownership, or unrelated mixed changes.
- Never approve Feishu routing, scheduler, framework routing, spawn, issue queue, notification, or other shared platform behavior changes without executable verification.

owner-routed:
- artifacts/, outputs/, data/, exports, screenshots, media, capture runs, generated reports, and business evidence are owner-routed by default. In some repos they are trash; in others they are the deliverable.
- Artifact-only owner-routed paths should stay quiet-deferred unless a source/config/doc behavior change is also present.
- Return UNSURE/NO for repo owner only when domain judgment is genuinely required for a must-commit candidate or blocked mixed change: unclear deliverable semantics, verified credential risk, unreadable binaries/databases, mixed changes, or a repo-local ignore rule that cannot be proven narrow from the diff.
- Process failures, Codex timeouts, reviewer stalls, and wall-clock budget skips are localgit-owned. Do not route those to repo owners.`;
