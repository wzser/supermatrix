import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOCALGIT_ROOT = resolve(import.meta.dirname, "../..");

type LocalgitRoleContract = {
  managed: boolean;
  affiliation: string;
  eligible_repository_rule: {
    status: string;
    scope: string;
    affiliated_to: string;
    category_excludes: string[];
    workdir: string;
  };
};

function loadRoleContract(): LocalgitRoleContract {
  const path = join(LOCALGIT_ROOT, "config/localgit-role.json");
  const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<LocalgitRoleContract>;
  const rule = value.eligible_repository_rule;
  if (
    value.managed !== true
    || typeof value.affiliation !== "string"
    || !rule
    || rule.status !== "not-deleted"
    || rule.scope !== "not-child"
    || rule.affiliated_to !== value.affiliation
    || !Array.isArray(rule.category_excludes)
    || rule.workdir !== "existing-git-repository"
  ) {
    throw new Error("invalid localgit role contract");
  }
  return value as LocalgitRoleContract;
}

export const LOCALGIT_ROLE = loadRoleContract();

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function resolveRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.SM_RUNTIME_ROOT?.trim() || resolve(LOCALGIT_ROOT, "../..");
}

export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALGIT_DB_PATH?.trim()
    || env.SM_DB_PATH?.trim()
    || join(resolveRuntimeRoot(env), "data", "supermatrix.db");
}

export const SM_RUNTIME_ROOT = resolveRuntimeRoot();
export const SM_REPO_ROOT = process.env.SM_REPO_ROOT ?? resolve(SM_RUNTIME_ROOT, "../SuperMatrix");
export const SM_DB_PATH = resolveDbPath();

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.LOCALGIT_API_BASE?.trim()
    || env.SM_API_BASE?.trim()
    || `http://127.0.0.1:${env.SM_API_PORT?.trim() || "3501"}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`invalid localgit API base: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`localgit API base must use http or https: ${value}`);
  }
  return trimTrailingSlash(value);
}

export function resolveNotifyEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALGIT_NOTIFY_ENDPOINT?.trim()
    || `${resolveApiBase(env)}/api/notify`;
}

export function resolveSpawn2Endpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALGIT_SPAWN2_ENDPOINT?.trim()
    || `${resolveApiBase(env)}/api/spawn2.0`;
}
const DAILY_COMMIT_SESSION_QUERY = [
  "SELECT name, workdir, status, scope, affiliated_to, category",
  "FROM sessions",
  `WHERE status != ${sqlString(LOCALGIT_ROLE.eligible_repository_rule.status === "not-deleted" ? "deleted" : "__invalid__")}`,
  `AND scope != ${sqlString(LOCALGIT_ROLE.eligible_repository_rule.scope === "not-child" ? "child" : "__invalid__")}`,
  `AND affiliated_to = ${sqlString(LOCALGIT_ROLE.affiliation)}`,
  `AND category NOT IN (${LOCALGIT_ROLE.eligible_repository_rule.category_excludes.map(sqlString).join(", ")})`,
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
  const rule = LOCALGIT_ROLE.eligible_repository_rule;
  return LOCALGIT_ROLE.managed
    && (rule.status !== "not-deleted" || row.status !== "deleted")
    && (rule.scope !== "not-child" || row.scope !== "child")
    && row.affiliatedTo === rule.affiliated_to
    && !rule.category_excludes.includes(row.category);
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
