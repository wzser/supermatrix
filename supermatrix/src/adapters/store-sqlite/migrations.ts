import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type MigrationResult = {
  degraded: Array<{ version: number; file: string; error: string }>;
};

const ALREADY_APPLIED_PATTERNS = [
  /duplicate column name:/i,
  /table .+ already exists/i,
];

function isAlreadyApplied(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? "";
  return ALREADY_APPLIED_PATTERNS.some((p) => p.test(msg));
}

export async function applyMigrations(db: Db): Promise<MigrationResult> {
  ensureVersionTable(db);
  const appliedVersions = new Set(
    db
      .prepare("SELECT version FROM schema_version")
      .all()
      .map((row) => (row as { version: number }).version)
  );

  const allFiles = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const critical = allFiles.filter((f) => !f.endsWith(".opt.sql"));
  const optional = allFiles.filter((f) => f.endsWith(".opt.sql"));
  const degraded: MigrationResult["degraded"] = [];

  // Pass 1: critical — failure = throw (boot terminates, correct behavior)
  for (const file of critical) {
    runOne(db, file, appliedVersions);
  }

  // Pass 2: optional — failure = degrade, don't throw
  for (const file of optional) {
    try {
      runOne(db, file, appliedVersions);
    } catch (err) {
      const version = parseVersion(file);
      const msg = (err as Error).message;
      degraded.push({ version, file, error: msg });
    }
  }

  return { degraded };
}

function runOne(db: Db, file: string, appliedVersions: Set<number>): void {
  const version = parseVersion(file);
  if (appliedVersions.has(version)) return;

  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

  try {
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(version, Date.now());
    });
    tx();
  } catch (err) {
    if (isAlreadyApplied(err)) {
      // Schema is already at target state, just missing version record — backfill
      db.prepare(
        "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)"
      ).run(version, Date.now());
      return;
    }
    throw err;
  }
}

function ensureVersionTable(db: Db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
}

function parseVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/u);
  if (!match) throw new Error(`migration filename must start with \\d+_: ${filename}`);
  return Number.parseInt(match[1], 10);
}
