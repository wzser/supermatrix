import { join } from "node:path";

export type Config = {
  port: number;
  host: string;
  dbPath: string;
  smDbPath: string;
  smBaseUrl: string;
  mirrorEnqueueBin: string;
  adminToken?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const runtimeRoot = env.SM_RUNTIME_ROOT;
  const dataRoot = join(runtimeRoot ?? process.cwd(), "data");
  return {
    port: env.SCHEDULER_V2_PORT ? Number(env.SCHEDULER_V2_PORT) : 3502,
    host: env.SCHEDULER_V2_HOST ?? "127.0.0.1",
    dbPath: env.SCHEDULER_V2_DB ?? join(dataRoot, "scheduler-v2.db"),
    smDbPath: env.SM_DB ?? join(dataRoot, "supermatrix.db"),
    smBaseUrl: env.SM_BASE_URL ?? "http://127.0.0.1:3501",
    mirrorEnqueueBin: env.SCHEDULER_MIRROR_ENQUEUE_BIN ?? "feishu-sync-enqueue",
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
