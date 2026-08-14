import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOCALGIT_ROOT = resolve(import.meta.dirname, "../..");
export const SM_RUNTIME_ROOT = process.env.SM_RUNTIME_ROOT ?? resolve(LOCALGIT_ROOT, "../..");
export const SM_REPO_ROOT = process.env.SM_REPO_ROOT ?? resolve(SM_RUNTIME_ROOT, "../SuperMatrix");
export const SM_DB_PATH = process.env.LOCALGIT_DB_PATH ?? join(SM_RUNTIME_ROOT, "data", "supermatrix.db");
const DAILY_COMMIT_SESSION_QUERY = [
  "SELECT name, workdir, status, scope, affiliated_to, category",
  "FROM sessions",
  "WHERE status != 'deleted'",
  "AND scope != 'child'",
  "AND affiliated_to = 'first-principle'",
  "AND category NOT IN ('外部', '员工')",
  "AND workdir != ''",
  "ORDER BY name;",
].join(" ");

export type RepoRef = { name: string; path: string };
export type DailyCommitSessionRow = RepoRef & {
  status: string;
  scope: string;
  affiliatedTo: string | null;
  category: string;
};

export type LocalgitContextDeps = {
  fetchSessionRows?: () => DailyCommitSessionRow[];
  isGitRepo?: (path: string) => boolean;
};

export function businessDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function resolveSopById(root: string, id: string): string {
  const matches = readdirSync(root)
    .filter((name) => name.startsWith("SOP-") && name.endsWith(`-${id}.md`))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`expected exactly one SOP id=${id}, found ${matches.length}`);
  }
  return join(root, matches[0]);
}

export function isDailyCommitGovernedSession(row: DailyCommitSessionRow): boolean {
  return row.status !== "deleted"
    && row.scope !== "child"
    && row.affiliatedTo === "first-principle"
    && row.category !== "外部"
    && row.category !== "员工";
}

export function selectGovernedRepos(
  rows: DailyCommitSessionRow[],
  isGitRepo: (path: string) => boolean,
): RepoRef[] {
  const repos: RepoRef[] = [];
  const seenWorkdirs = new Set<string>();
  for (const row of rows) {
    if (!isDailyCommitGovernedSession(row)) continue;
    if (seenWorkdirs.has(row.path)) continue;
    if (!isGitRepo(row.path)) continue;
    seenWorkdirs.add(row.path);
    repos.push({ name: row.name, path: row.path });
  }
  return repos;
}

function defaultFetchSessionRows(): DailyCommitSessionRow[] {
  const out = execFileSync(
    "sqlite3",
    [
      "-readonly",
      SM_DB_PATH,
      "-separator",
      "\t",
      DAILY_COMMIT_SESSION_QUERY,
    ],
    { encoding: "utf-8", timeout: 10000 },
  ).trim();
  if (!out) return [];
  return out.split("\n").flatMap((line) => {
    const [name, path, status, scope, affiliatedTo, category, ...extra] = line.split("\t");
    if (!name || !path || !status || !scope || !affiliatedTo || category === undefined || extra.length > 0) {
      throw new Error("invalid governed session row returned by sqlite3");
    }
    return [{ name, path, status, scope, affiliatedTo, category }];
  });
}

export function loadDailyCommitGovernedRepos(deps: LocalgitContextDeps = {}): {
  governedSessionCount: number;
  repos: RepoRef[];
} {
  const rows = (deps.fetchSessionRows ?? defaultFetchSessionRows)();
  const governedRows = rows.filter(isDailyCommitGovernedSession);
  const repos = selectGovernedRepos(
    rows,
    deps.isGitRepo ?? ((path) => existsSync(join(path, ".git"))),
  );
  return { governedSessionCount: new Set(governedRows.map((row) => row.name)).size, repos };
}
