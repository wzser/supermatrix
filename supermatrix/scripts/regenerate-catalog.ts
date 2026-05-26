#!/usr/bin/env tsx
// One-off operational helper: rebuild the single global session-catalog.json
// from the live sessions table, exactly as SuperMatrix does on the
// create / delete / setBackend paths (sessionLifecycle.ts).
//
// Why this exists: regenerateCatalog only fires on create / delete / backend
// switch. A pure purpose change — FP editing sessions.purpose — does not touch
// any of those, so the catalog's `capability` field (which carries
// sessions.purpose verbatim) goes stale until the next unrelated lifecycle
// event. Run this to flush a purpose backfill into the catalog immediately
// without restarting the live process.
//
// Minimal by design: it only rewrites the JSON content. The symlinks into each
// workspace are already in place (migrate-to-session-catalog.ts built them) —
// this script does not touch symlinks, delete files, or commit.
//
// Usage:
//   SM_DB_PATH=... SM_WORKSPACE_ROOT=... npx tsx scripts/regenerate-catalog.ts "<reason>"
//
// Mirrors the bootstrap.ts wiring (NodeWorkspaceFs identity, clock,
// catalogPath = SM_WORKSPACE_ROOT/session-catalog.json).

import path from "node:path";
import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../src/adapters/workspace-node/index.ts";
import { createSessionCatalogService } from "../src/app/sessionCatalog.ts";
import { asAbsolutePath, asTimestamp } from "../src/domain/ids.ts";
import type { Clock } from "../src/ports/Clock.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const dbPath = requireEnv("SM_DB_PATH");
  const workspaceRoot = requireEnv("SM_WORKSPACE_ROOT");
  const reason = process.argv[2] ?? "manual regenerate: purpose backfill";
  const catalogPath = path.join(workspaceRoot, "session-catalog.json");

  console.log(`catalog: ${catalogPath}`);
  console.log(`reason:  ${reason}`);

  const store = new SqliteBindingStore(dbPath);
  await store.init();
  try {
    const fs = new NodeWorkspaceFs({
      gitUserName: "SuperMatrix Console",
      gitUserEmail: "console@supermatrix.local",
    });
    const clock: Clock = { now: () => asTimestamp(Date.now()) };

    const catalogService = createSessionCatalogService({
      store,
      fs,
      catalogPath: asAbsolutePath(catalogPath),
      clock,
    });

    await catalogService.regenerateCatalog(reason);

    const sessions = await store.listActiveSessions();
    console.log(`regenerated catalog: ${sessions.length} active session(s)`);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error("regenerate-catalog failed:", (err as Error).message);
  process.exit(2);
});
