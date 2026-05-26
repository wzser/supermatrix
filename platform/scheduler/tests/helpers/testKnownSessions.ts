// Test-only helper. Production code wires src/classes/knownSessions.ts (added in Task 9).
//
// Task 0 (2026-05-13): This helper is staged but NOT YET passed to createApp.
// Task 9 of the lint-layer1 plan will change createApp's signature to accept a
// knownSessionsLoader argument. At that point, every createApp(...) call site
// listed below must be patched to pass `createTestKnownSessionsLoader()` (in
// test code) or the production loader (in src/main.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// createApp(...) call sites — Task 9 must patch every one of these
// ─────────────────────────────────────────────────────────────────────────────
// Production (skip in Task 0; src is out of scope for fixture migration):
//   src/main.ts:503
//     createApp(store, engine, trackTask, sync, conflictCheck,
//               healStoreForApi, migrationStoreForApi)
//
// Tests (will need the test loader as the 8th arg in Task 9):
//   tests/api/routes.test.ts:18              (describe-level beforeEach)
//   tests/api/routes.test.ts:552             (POST /tasks: class missing → 400)
//   tests/api/routes.test.ts:574             (POST /tasks: expectedDurationMs missing → 400)
//   tests/api/routes.test.ts:596             (POST /tasks: ownerSession missing → 400)
//   tests/api/routes.test.ts:619             (POST /tasks: full classed-lifecycle sanity check → 201)
//   tests/integration/e2eLegacyTaskRejected.test.ts:16
//   tests/integration/e2eProposalApi.test.ts:40
//   tests/integration/e2eProposalApi.test.ts:74
//   tests/integration/e2eProposalApi.test.ts:89
//
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEST_OWNERS = new Set([
  // Plan-listed defaults
  "test-owner",
  "tester",
  "owner",
  "stale-owner",
  "owner-a",
  "owner-b",
  // Discovered by Step 1 grep on tests/ (2026-05-13)
  "amz-radar",
  "amz-sql",
  "amzdata",
  "ghost-owner",
  "me",
  "missing",
  "my-owner",
  "nas",
  "new-valid-owner",
  "o",
  "o1",
  "o2",
  "owner-abc",
  "owner-c",
  "owner-d",
  "owner-sess",
  "owner-session",
]);

export function createTestKnownSessionsLoader(extra: string[] = []): () => Set<string> {
  const all = new Set([...DEFAULT_TEST_OWNERS, ...extra]);
  return () => all;
}
