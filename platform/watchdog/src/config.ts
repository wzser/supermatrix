import { z } from "zod";
import { join } from "node:path";

const configSchema = z.object({
  dbPath: z.string(),
  notifyEnabled: z.boolean().default(true),
  larkCliPath: z.string().default("lark-cli"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  apiBase: z.string().url(),
  notifySource: z.string().min(1),
  notifyTargetChatId: z.string().min(1).optional(),
  bitableBaseToken: z.string(),
  bitableTableId: z.string(),
  bitableSyncEnabled: z.boolean(),
});

export type Config = z.infer<typeof configSchema>;

function truthy(v: string | undefined): boolean {
  if (!v) return false;
  return !["0", "false", "no", "off", ""].includes(v.toLowerCase());
}

function optionalNonEmpty(v: string | undefined): string | undefined {
  const value = v?.trim();
  return value || undefined;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const bitableBaseToken = optionalNonEmpty(env.WATCHDOG_BITABLE_BASE_TOKEN);
  const bitableTableId = optionalNonEmpty(env.WATCHDOG_BITABLE_TABLE_ID);
  if ((bitableBaseToken && !bitableTableId) || (!bitableBaseToken && bitableTableId)) {
    throw new Error(
      "Bitable sync requires WATCHDOG_BITABLE_BASE_TOKEN and WATCHDOG_BITABLE_TABLE_ID together",
    );
  }

  const apiBase = optionalNonEmpty(env.SM_API_BASE) ?? "http://127.0.0.1:3501";
  const notifySource =
    optionalNonEmpty(env.WATCHDOG_NOTIFY_SOURCE) ??
    optionalNonEmpty(env.SM_SESSION_NAME) ??
    "watchdog";
  const notifyTargetChatId = optionalNonEmpty(env.WATCHDOG_NOTIFY_TARGET_CHAT_ID);

  return configSchema.parse({
    dbPath: env.WATCHDOG_DB_PATH ?? join(process.cwd(), "data", "watchdog.db"),
    notifyEnabled: !truthy(env.WATCHDOG_NOTIFY_DISABLED),
    larkCliPath: env.WATCHDOG_LARK_CLI_PATH,
    logLevel: env.WATCHDOG_LOG_LEVEL,
    apiBase,
    notifySource,
    notifyTargetChatId,
    bitableBaseToken: bitableBaseToken ?? "",
    bitableTableId: bitableTableId ?? "",
    bitableSyncEnabled: !truthy(env.WATCHDOG_DISABLE_SYNC) &&
      Boolean(bitableBaseToken && bitableTableId),
  });
}
