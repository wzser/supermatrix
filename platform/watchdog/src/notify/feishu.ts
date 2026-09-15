import { createNotifyClient, type NotifyClient } from "./console.js";

export type Notifier = {
  notifyDone(title: string, result: string): Promise<void>;
};

type NotifierConfig = {
  enabled: boolean;
  apiBase?: string;
  source?: string;
  targetChatId?: string;
};

export function createNotifier(
  config: NotifierConfig,
  client: NotifyClient = createNotifyClient({ apiBase: config.apiBase }),
): Notifier {
  return {
    async notifyDone(title, result) {
      if (!config.enabled) return;
      try {
        await client.notify({
          source: config.source ?? "watchdog",
          title: `问题已解决：${title}`,
          body: result || "(无补充说明)",
          level: "info",
          ...(config.targetChatId ? { targetChatId: config.targetChatId } : {}),
          metadata: {
            问题: title,
            时间: new Date().toISOString(),
          },
        });
      } catch (err) {
        console.error("Failed to send notification:", err);
      }
    },
  };
}
