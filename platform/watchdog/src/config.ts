import { z } from "zod";
import { join } from "node:path";

const configSchema = z.object({
  dbPath: z.string(),
  notifyEnabled: z.boolean().default(true),
  larkCliPath: z.string().default("lark-cli"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  bitableBaseToken: z.string().default(""),
  bitableTableId: z.string().default(""),
});

export type Config = z.infer<typeof configSchema>;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return !["0", "false", "no", "off", ""].includes(v.toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse({
    dbPath: env.WATCHDOG_DB_PATH ?? join(process.cwd(), "data", "watchdog.db"),
    notifyEnabled: !truthy(env.WATCHDOG_NOTIFY_DISABLED),
    larkCliPath: env.WATCHDOG_LARK_CLI_PATH,
    logLevel: env.WATCHDOG_LOG_LEVEL,
    bitableBaseToken: env.WATCHDOG_BITABLE_BASE_TOKEN,
    bitableTableId: env.WATCHDOG_BITABLE_TABLE_ID,
  });
}
