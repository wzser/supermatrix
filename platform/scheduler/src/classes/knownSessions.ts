import Database from "better-sqlite3";
import fs from "node:fs";

const PSEUDO_OWNERS = ["supermatrix-root", "codexroot"];

export type KnownSessionsLoader = () => Set<string>;

export function createKnownSessionsLoader(
  dbPath: string,
  opts: { ttlMs?: number } = {},
): KnownSessionsLoader {
  const ttlMs = opts.ttlMs ?? 60_000;
  let cached: Set<string> | null = null;
  let loadedAt = 0;

  return () => {
    const now = Date.now();
    if (cached && now - loadedAt < ttlMs) return cached;

    const set = new Set<string>(PSEUDO_OWNERS);
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
          // Pull all then filter in-process. Avoids SQL LIKE `_` wildcard
          // gotcha (NOT LIKE 'child_%' would also exclude "childcare").
          const rows = db.prepare(`SELECT DISTINCT name FROM sessions`).all() as { name: string }[];
          for (const r of rows) {
            if (!r.name) continue;
            if (r.name.startsWith("child_") || r.name.startsWith("sess_")) continue;
            set.add(r.name);
          }
        } finally {
          db.close();
        }
      } catch {
        // swallow — fall back to pseudo-owners only
      }
    }
    cached = set;
    loadedAt = now;
    return set;
  };
}

// Used by creationLint rule 6 — when the DB is unreachable we only see
// pseudo-owners and can't safely distinguish "ghost" from "freshly created".
export const KNOWN_SESSIONS_PSEUDO_ONLY_THRESHOLD = 2;
