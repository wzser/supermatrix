export type InitEnvInput = {
  appId: string;
  appSecret: string;
  tenant: string;
  operatorOpenId?: string;
  rootGroupId?: string;
  repoRoot: string;
};

export type EnvUpdates = Record<string, string>;

export function buildEnvUpdates(input: InitEnvInput): EnvUpdates {
  const supermatrixRoot = `${input.repoRoot.replace(/\/+$/u, "")}/supermatrix`;
  const updates: EnvUpdates = {
    LARK_APP_ID: input.appId,
    LARK_APP_SECRET: input.appSecret,
    LARK_TENANT: input.tenant,
    SM_WORKSPACE_ROOT: "$HOME/SuperMatrixWorkspaces",
    SM_RUNTIME_ROOT: "$HOME/SuperMatrixRuntime",
    SM_DB_PATH: "$HOME/SuperMatrixRuntime/data/supermatrix.db",
    SM_BACKEND: "claude",
    SM_LOG_LEVEL: "info",
    SM_API_PORT: "3501",
    SM_LARK_CLI_PATH: `${supermatrixRoot}/node_modules/.bin/lark-cli`,
    SM_API_BASE: "http://localhost:3501",
    SM_REPO_ROOT: supermatrixRoot,
  };
  if (input.operatorOpenId) updates.SM_ROOT_USER_ID = input.operatorOpenId;
  if (input.rootGroupId) updates.SM_ROOT_GROUP_ID = input.rootGroupId;
  return updates;
}

export function mergeEnvText(existing: string, updates: EnvUpdates): string {
  const lines = existing.length > 0 ? existing.split(/\r?\n/u) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/u);
    if (!match) return line;
    const key = match[1];
    if (!pending.has(key)) return line;
    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  if (pending.size > 0) {
    if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    out.push("# Added by Super Matrix init");
    for (const [key, value] of pending) {
      out.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  return out.join("\n").replace(/\n*$/u, "\n");
}

export function parseAuthStatusOpenId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return findStringField(parsed, ["userOpenId", "user_open_id", "open_id"]);
  } catch {
    return undefined;
  }
}

function findStringField(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].length > 0) {
      return obj[key];
    }
  }
  for (const child of Object.values(obj)) {
    const found = findStringField(child, keys);
    if (found) return found;
  }
  return undefined;
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:$-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}
