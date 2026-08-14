export type Config = {
  port: number;
  host: string;
  dbPath: string;
  smDbPath: string;
  smBaseUrl: string;        // spawn2.0 endpoint host, 3501
  adminToken?: string;      // write-lock token; absent → boot refuses to start
};

const DEFAULT_DB = "/Users/LOCAL_USER/SuperMatrixRuntime/data/scheduler-v2.db";
const DEFAULT_SM_DB = "/Users/LOCAL_USER/SuperMatrixRuntime/data/supermatrix.db";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const runtimeRoot = env.SM_RUNTIME_ROOT;
  return {
    port: env.SCHEDULER_V2_PORT ? Number(env.SCHEDULER_V2_PORT) : 3502,
    host: env.SCHEDULER_V2_HOST ?? "127.0.0.1",
    dbPath: env.SCHEDULER_V2_DB ?? DEFAULT_DB,
    smDbPath: env.SM_DB ?? (runtimeRoot ? `${runtimeRoot}/data/supermatrix.db` : DEFAULT_SM_DB),
    smBaseUrl: env.SM_BASE_URL ?? "http://localhost:3501",
    adminToken: env.SCHEDULER_ADMIN_TOKEN,
  };
}

export function assertAdminToken(config: Config): void {
  if (!config.adminToken) {
    throw new Error(
      "SCHEDULER_ADMIN_TOKEN is required: the write-lock cannot be enforced without it",
    );
  }
}
