import path from "node:path";
import { z } from "zod";

function defaultSupermatrixDbPath(env: Record<string, string | undefined>): string {
  if (env.SCHEDULER_SUPERMATRIX_DB_PATH) return env.SCHEDULER_SUPERMATRIX_DB_PATH;
  if (env.SM_DB_PATH) return env.SM_DB_PATH;
  const runtimeRoot = env.SM_RUNTIME_ROOT ?? path.join(process.cwd(), "..", "SuperMatrixRuntime");
  return path.join(runtimeRoot, "data", "supermatrix.db");
}

const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().default(3500),
  dbPath: z.string().min(1),
  notifyApiUrl: z.string().default("http://localhost:3501/api/notify"),
  larkCliPath: z.string().default("lark-cli"),
  userDmOpenId: z.string().default("LARK_OWNER_OPEN_ID"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  bitableBaseToken: z.string().optional(),
  bitableTableId: z.string().optional(),
  spawnApiUrl: z.string().default("http://localhost:3501/api/spawn"),
  transientRetryCount: z.coerce.number().int().min(0).default(2),
  transientRetryDelayMs: z.coerce.number().int().min(0).default(15_000),
  supermatrixDbPath: z.string().min(1),
  creationReviewBatchThreshold: z.coerce.number().int().min(1).default(5),
  creationReviewMaxAgeMs: z.coerce.number().int().min(0).default(3_600_000),       // 1h
  creationReviewTickIntervalMs: z.coerce.number().int().min(1_000).default(1_800_000), // 30 min
  creationReviewExpireMs: z.coerce.number().int().min(60_000).default(86_400_000),     // 24h
  creationReviewDecisionPollIntervalMs: z.coerce.number().int().min(60_000).default(3_600_000), // 1h
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse({
    host: env.SCHEDULER_HOST,
    port: env.SCHEDULER_PORT,
    dbPath: env.SCHEDULER_DB_PATH,
    notifyApiUrl: env.SCHEDULER_NOTIFY_API_URL,
    larkCliPath: env.SCHEDULER_LARK_CLI_PATH,
    userDmOpenId: env.SCHEDULER_USER_DM_OPEN_ID,
    logLevel: env.SCHEDULER_LOG_LEVEL,
    bitableBaseToken: env.SCHEDULER_BITABLE_BASE_TOKEN,
    bitableTableId: env.SCHEDULER_BITABLE_TABLE_ID,
    spawnApiUrl: env.SCHEDULER_SPAWN_API_URL,
    transientRetryCount: env.SCHEDULER_TRANSIENT_RETRY_COUNT,
    transientRetryDelayMs: env.SCHEDULER_TRANSIENT_RETRY_DELAY_MS,
    supermatrixDbPath: defaultSupermatrixDbPath(env),
    creationReviewBatchThreshold: env.SCHEDULER_CREATION_REVIEW_BATCH_THRESHOLD,
    creationReviewMaxAgeMs: env.SCHEDULER_CREATION_REVIEW_MAX_AGE_MS,
    creationReviewTickIntervalMs: env.SCHEDULER_CREATION_REVIEW_TICK_INTERVAL_MS,
    creationReviewExpireMs: env.SCHEDULER_CREATION_REVIEW_EXPIRE_MS,
    creationReviewDecisionPollIntervalMs: env.SCHEDULER_CREATION_REVIEW_DECISION_POLL_INTERVAL_MS,
  });
}
