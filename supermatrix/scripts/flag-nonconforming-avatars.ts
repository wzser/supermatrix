#!/usr/bin/env tsx
// FP v1.0 session-meta contract maintenance helper (read-only).
// Lists user-scope, non-deleted sessions whose `avatar` violates the
// file_token format (per workspaces/first-principle/rules/session-meta-fields.md §1).
// Migration of the offending rows is FP's job — root MUST NOT auto-rewrite.
//
// Usage:
//   SM_DB_PATH=/path/to/supermatrix.db tsx scripts/flag-nonconforming-avatars.ts
//   (or use --db /path/to.db)

import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";

function parseDbPath(argv: string[]): string {
  const flagIdx = argv.indexOf("--db");
  if (flagIdx >= 0 && argv[flagIdx + 1]) return argv[flagIdx + 1]!;
  if (process.env.SM_DB_PATH) return process.env.SM_DB_PATH;
  throw new Error("DB path required: set SM_DB_PATH or pass --db <path>");
}

async function main(): Promise<void> {
  const dbPath = parseDbPath(process.argv.slice(2));
  const store = new SqliteBindingStore(dbPath);
  await store.init();
  try {
    const rows = await store.findNonConformingAvatars();
    if (rows.length === 0) {
      console.log("OK: all user-scope avatars conform to FP v1.0 file_token format.");
      return;
    }
    console.log(`Found ${rows.length} non-conforming avatar row(s):`);
    for (const r of rows) {
      const preview = r.avatar.length > 80 ? `${r.avatar.slice(0, 77)}...` : r.avatar;
      console.log(`  ${r.name}\t(${r.avatar.length} chars)\t${preview}`);
    }
    console.log("");
    console.log("Migration belongs to first-principle per contract §1; root MUST NOT rewrite.");
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error("flag-nonconforming-avatars failed:", (err as Error).message);
  process.exit(2);
});
