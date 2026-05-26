export type NotifyLevel = "info" | "warn" | "error";

export type NotifyRequest = {
  source: string;
  title: string;
  body: string;
  level?: NotifyLevel;
  metadata?: Record<string, string | number>;
};

export type NotifyResponse = {
  messageId: string;
  degraded?: boolean;
  error?: string;
};

export type NotifyClient = {
  notify(req: NotifyRequest): Promise<NotifyResponse>;
};

type NotifyClientOptions = {
  endpoint?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_ENDPOINT = "http://localhost:3501/api/notify";

export function createNotifyClient(opts: NotifyClientOptions = {}): NotifyClient {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async notify(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`notify HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return (await res.json()) as NotifyResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
