export type NotifyLevel = "info" | "warn" | "error";

export type NotifyParams = {
  title: string;
  body: string;
  level: NotifyLevel;
  metadata?: Record<string, unknown>;
};

type ConsoleNotifyConfig = {
  apiUrl: string;
  logger?: { error: (obj: object, msg: string) => void };
};

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export type ConsoleNotifier = {
  notify(params: NotifyParams): Promise<void>;
  notifyOrThrow(params: NotifyParams): Promise<void>;
  notifyFailure(taskName: string, error: string, metadata?: Record<string, unknown>): Promise<void>;
};

export function createConsoleNotifier(
  config: ConsoleNotifyConfig,
  fetchFn: FetchFn = fetch,
): ConsoleNotifier {
  const logErr = (err: unknown, ctx: object, msg: string) => {
    if (config.logger) config.logger.error({ err, ...ctx }, msg);
    else console.error(msg, err);
  };

  async function notifyOrThrow(params: NotifyParams): Promise<void> {
    const payload = {
      source: "scheduler",
      title: params.title,
      body: params.body,
      level: params.level,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };

    const res = await fetchFn(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`console notify HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  async function notify(params: NotifyParams): Promise<void> {
    try {
      await notifyOrThrow(params);
    } catch (err) {
      logErr(err, { title: params.title }, "console notify failed");
    }
  }

  return {
    notify,
    notifyOrThrow,
    notifyFailure(taskName, error, metadata) {
      return notify({
        title: `任务失败: ${taskName}`,
        body: error,
        level: "error",
        metadata: { taskName, ...metadata },
      });
    },
  };
}
