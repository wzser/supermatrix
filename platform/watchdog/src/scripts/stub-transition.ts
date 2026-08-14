// Detects a legitimate stub→formal CLAUDE.md / AGENTS.md transition produced by
// first-principle's `fp-generate-init` flow. Without this whitelist, the daily-commit
// reviewer treats watchdog modifying CLAUDE.md/AGENTS.md as suspicious and escalates
// to FP for human confirmation — a false positive on every newly-initialized session
// (daily-data + tag-manager hit it on 2026-05-04). Spec confirmed by FP commit c3b54df.

// Marker present in the deletion side: line 3 of templates/claude-md-base.md.
const STUB_MARKER = '首次激活说明 — 这是临时的"上线初始化运行手册"';

// Cat-only formal template starts with one of these blockquote headers.
// Strict form: '> **Reference template for <category>-category session CLAUDE.md.**'
// Lenient form (future variants): '> **<Category>-category ...**'
const REF_FORMAL_RE = /^\s*>\s*\*\*Reference template for ([a-z-]+)-category session (CLAUDE\.md|AGENTS\.md)/;
const CAT_FORMAL_RE = /^\s*>\s*\*\*([A-Z][a-z-]+)-category/;

export type StubTransitionMatch =
  | { match: true; category: string; backend?: string }
  | { match: false; reason: string };

// Pure function: takes the diff text and the list of changed files, returns whether
// it's a legitimate stub→formal transition. Kept side-effect free so tests can replay
// captured diffs (see tests/scripts/stub-transition.test.ts).
export function detectStubToFormalTransitionFromDiff(
  diffOutput: string,
  changedFiles: string[],
): StubTransitionMatch {
  if (changedFiles.length === 0) return { match: false, reason: "no changed files" };
  // Whitelist scope: only when the dirty set is limited to CLAUDE.md / AGENTS.md.
  // If the session also touched code/data/binaries, fall through so risk signals
  // (.pyc, secrets, large binaries) in those files still get caught by the normal reviewer.
  const scopeOk = changedFiles.every((f) => f === "CLAUDE.md" || f === "AGENTS.md");
  if (!scopeOk) return { match: false, reason: "diff includes files outside CLAUDE.md/AGENTS.md" };

  let hasStub = false;
  let category: string | undefined;
  let backend: string | undefined;

  for (const raw of diffOutput.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    if (raw.startsWith("-") && raw.includes(STUB_MARKER)) {
      hasStub = true;
      continue;
    }
    if (raw.startsWith("+")) {
      const body = raw.slice(1);
      const m1 = body.match(REF_FORMAL_RE);
      if (m1) {
        category = m1[1];
        backend = m1[2];
        continue;
      }
      if (!category) {
        const m2 = body.match(CAT_FORMAL_RE);
        if (m2) category = m2[1].toLowerCase();
      }
    }
  }

  if (!hasStub) return { match: false, reason: "stub marker not found in deletions" };
  if (!category) return { match: false, reason: "formal cat-template marker not found in additions" };
  return { match: true, category, backend };
}

// Threshold for "substantial rewrite": +/- lines in the CLAUDE.md/AGENTS.md diff.
// 30 picks up section reorganizations and category-switch rewrites while still
// ignoring small wording / link tweaks that don't warrant FP governance review.
const NOVEL_IDENTITY_CHANGE_LINE_THRESHOLD = 30;

// Decides whether a daily-commit rejection should escalate the .md change to
// first-principle for governance review. Pure function so it can be replayed
// against captured diffs in tests.
//
// Returns true ONLY when the diff actually contains a *novel* identity-level
// change to CLAUDE.md/AGENTS.md:
//   - a brand-new untracked CLAUDE.md/AGENTS.md (identity creation outside fp-generate-init), OR
//   - a substantial rewrite (>= NOVEL_IDENTITY_CHANGE_LINE_THRESHOLD +/- lines)
//     that does NOT match the stub→formal pattern FP already governs.
//
// Returns false when:
//   - no CLAUDE.md/AGENTS.md in the changed-file set (e.g. .pyc / secrets / pipeline-product flags), OR
//   - the .md change matches stub→formal markers (already covered by fp-generate-init contract,
//     even if the overall commit was rejected for other-file reasons), OR
//   - the .md change is small (a wording tweak, link bump, etc.).
export function isNovelClaudeMdIdentityChange(
  diff: string,
  changedFiles: string[],
  untrackedFiles: string[],
): boolean {
  const targets = changedFiles.filter((f) => f === "CLAUDE.md" || f === "AGENTS.md");
  if (targets.length === 0) return false;

  // Brand-new identity file appearing without going through fp-generate-init —
  // a novel pattern FP should be aware of, regardless of its size.
  if (targets.some((t) => untrackedFiles.includes(t))) return true;

  // The stub→formal pattern is already governed by FP. Pass only the .md targets so the
  // detector's scope check ignores other dirty files (which are handled separately by the
  // owner-session notification).
  if (detectStubToFormalTransitionFromDiff(diff, targets).match) return false;

  let changedLines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) changedLines++;
  }
  return changedLines >= NOVEL_IDENTITY_CHANGE_LINE_THRESHOLD;
}
