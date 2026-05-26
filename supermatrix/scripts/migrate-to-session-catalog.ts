#!/usr/bin/env tsx
// One-off migration: retire per-session CONSTITUTION.md in favour of the
// single global session-catalog.json.
//
// For every FP-governed (fp_managed != false), non-child, non-deleted session
// it:
//   1. (once) writes the global catalog to SM_WORKSPACE_ROOT/session-catalog.json
//   2. creates a `session-catalog.json` symlink in the workdir -> the global file
//   3. deletes the stale CONSTITUTION.md from the workdir
//   4. commits the swap when the workdir is a git repo under SM_WORKSPACE_ROOT
//      (repos SuperMatrix does not own get the filesystem change but no commit —
//      their own session commits it)
//
// Shared workdirs are de-duplicated, so a workdir reached by several sessions
// is migrated exactly once (this also clears the old "串 CONSTITUTION" file).
//
// Defaults to a dry run. Pass --apply to actually mutate the filesystem.
//
// Usage:
//   SM_DB_PATH=... SM_WORKSPACE_ROOT=... tsx scripts/migrate-to-session-catalog.ts [--apply]

import path from "node:path";
import { lstat, rm, symlink } from "node:fs/promises";
import { SqliteBindingStore } from "../src/adapters/store-sqlite/index.ts";
import { NodeWorkspaceFs } from "../src/adapters/workspace-node/index.ts";
import { createSessionCatalogService } from "../src/app/sessionCatalog.ts";
import { runGit } from "../src/adapters/workspace-node/git.ts";
import { asAbsolutePath, asTimestamp } from "../src/domain/ids.ts";
import type { Clock } from "../src/ports/Clock.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function isUnderRoot(workdir: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : root + "/";
  return workdir === root || workdir.startsWith(normalizedRoot);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const dbPath = requireEnv("SM_DB_PATH");
  const workspaceRoot = requireEnv("SM_WORKSPACE_ROOT");
  const apply = process.argv.includes("--apply");
  const catalogPath = path.join(workspaceRoot, "session-catalog.json");

  console.log(apply ? "MODE: apply (filesystem will be mutated)" : "MODE: dry-run (pass --apply to mutate)");
  console.log(`catalog: ${catalogPath}`);

  const store = new SqliteBindingStore(dbPath);
  await store.init();
  try {
    const clock: Clock = { now: () => asTimestamp(Date.now()) };
    const fs = new NodeWorkspaceFs({
      gitUserName: "root",
      gitUserEmail: "console@supermatrix.local",
    });

    // Step 1: write the global catalog (only on --apply).
    if (apply) {
      const catalogService = createSessionCatalogService({
        store,
        fs,
        catalogPath: asAbsolutePath(catalogPath),
        clock,
      });
      await catalogService.regenerateCatalog("migration: retire CONSTITUTION.md");
      console.log("wrote global catalog");
    }

    // Step 2-4: per workdir. De-duplicate shared workdirs.
    const active = await store.listActiveSessions();
    const managed = active.filter((s) => s.fpManaged !== false);
    const seen = new Set<string>();
    const stats = { linked: 0, cleaned: 0, committed: 0, external: 0, skipped: 0 };

    for (const s of managed) {
      if (seen.has(s.workdir)) continue;
      seen.add(s.workdir);

      if (!(await pathExists(s.workdir))) {
        console.log(`SKIP ${s.name}: workdir missing (${s.workdir})`);
        stats.skipped++;
        continue;
      }

      const linkPath = path.join(s.workdir, "session-catalog.json");
      const oldConstitution = path.join(s.workdir, "CONSTITUTION.md");
      const underRoot = isUnderRoot(s.workdir, workspaceRoot);
      const hasGit = await pathExists(path.join(s.workdir, ".git"));
      const actions: string[] = [];

      const linkExists = await pathExists(linkPath);
      if (!linkExists) {
        actions.push("link session-catalog.json");
        if (apply) await symlink(catalogPath, linkPath);
        stats.linked++;
      }

      const constitutionExists = await pathExists(oldConstitution);
      if (constitutionExists) {
        actions.push("rm CONSTITUTION.md");
        if (apply) await rm(oldConstitution, { force: true });
        stats.cleaned++;
      }

      if (actions.length === 0) {
        console.log(`OK   ${s.name}: already migrated`);
        continue;
      }

      if (underRoot && hasGit) {
        if (apply) {
          // `git add` stages both the new symlink and the CONSTITUTION.md
          // deletion. --ignore-removal is off by default, so a deleted
          // tracked file is staged as a removal.
          await runGit(s.workdir, ["add", "--", "session-catalog.json", "CONSTITUTION.md"]);
          await runGit(
            s.workdir,
            ["commit", "--allow-empty", "-m", "catalog: retire CONSTITUTION.md, link session-catalog.json"],
            { name: "root", email: "console@supermatrix.local" },
          );
        }
        stats.committed++;
        console.log(`MIG  ${s.name}: ${actions.join(", ")} + commit`);
      } else {
        stats.external++;
        const why = !underRoot ? "external repo" : "not a git repo";
        console.log(`MIG  ${s.name}: ${actions.join(", ")} (${why} — no commit)`);
      }
    }

    console.log("");
    console.log("=== migration summary ===");
    console.log(`workdirs linked:        ${stats.linked}`);
    console.log(`CONSTITUTION.md cleaned: ${stats.cleaned}`);
    console.log(`committed:              ${stats.committed}`);
    console.log(`filesystem-only (no commit): ${stats.external}`);
    console.log(`skipped (missing workdir):   ${stats.skipped}`);
    if (!apply) console.log("\n(dry run — re-run with --apply to perform the migration)");
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error("migrate-to-session-catalog failed:", (err as Error).message);
  process.exit(2);
});
