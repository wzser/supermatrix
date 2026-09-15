export type NotifyLevel = "info" | "warn" | "error";

export type NotifyRequest = {
  source: string;
  title: string;
  body: string;
  level?: NotifyLevel;
  targetChatId?: string;
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

export type NotifyClientOptions = {
  endpoint?: string;
  apiBase?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_API_BASE = "http://127.0.0.1:3501";

function endpointFromApiBase(apiBase: string): string {
  return `${apiBase.replace(/\/+$/u, "")}/api/notify`;
}

export function createNotifyClient(opts: NotifyClientOptions = {}): NotifyClient {
  const endpoint = opts.endpoint ?? endpointFromApiBase(
    opts.apiBase ?? process.env.SM_API_BASE ?? DEFAULT_API_BASE,
  );
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
