import type {
  TopicBus,
  TopicHandler,
  TopicPayload,
  TopicSubscribeOptions,
  TopicUnsubscribe,
} from "../../ports/TopicBus.ts";
import type { Logger } from "../../ports/Logger.ts";

export type InMemoryTopicBusOptions = {
  /**
   * Max retained payloads per topic. When the buffer is full the oldest is
   * dropped. Default 64 — high enough for steady burst traffic, low enough
   * that a misbehaving publisher can't blow up memory.
   */
  bufferPerTopic?: number;
  logger?: Logger;
};

export class InMemoryTopicBus implements TopicBus {
  private readonly bufferPerTopic: number;
  private readonly logger?: Logger;
  private readonly subs = new Map<string, Set<TopicHandler>>();
  private readonly buffers = new Map<string, TopicPayload[]>();

  constructor(opts: InMemoryTopicBusOptions = {}) {
    this.bufferPerTopic = opts.bufferPerTopic ?? 64;
    if (opts.logger) this.logger = opts.logger;
  }

  async publish(topic: string, payload: unknown): Promise<void> {
    const msg: TopicPayload = {
      topic,
      payload,
      publishedAtMs: Date.now(),
    };

    // Append to retention buffer FIRST so a subscriber that attaches between
    // this push and the fan-out still sees the event via replay.
    const buf = this.buffers.get(topic) ?? [];
    buf.push(msg);
    if (buf.length > this.bufferPerTopic) {
      buf.splice(0, buf.length - this.bufferPerTopic);
    }
    this.buffers.set(topic, buf);

    const handlers = this.subs.get(topic);
    if (!handlers || handlers.size === 0) {
      this.logger?.debug("topic published with no live subscribers", { topic });
      return;
    }

    // Fan-out. Handler errors are logged, not propagated — one bad subscriber
    // shouldn't block the others (same contract as EventBus).
    for (const handler of handlers) {
      try {
        await handler(msg);
      } catch (err) {
        this.logger?.error("topic handler threw", {
          topic,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  subscribe(topic: string, handler: TopicHandler, options?: TopicSubscribeOptions): TopicUnsubscribe {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(handler);

    const replay = options?.replay ?? true;
    if (replay) {
      const buf = this.buffers.get(topic);
      if (buf && buf.length > 0) {
        // Fire the replay asynchronously so subscribe() returns first (callers
        // routinely assign the unsubscribe return value before expecting the
        // handler to be invoked).
        void (async () => {
          for (const msg of buf.slice()) {
            try {
              await handler(msg);
            } catch (err) {
              this.logger?.error("topic replay handler threw", {
                topic,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        })();
      }
    }

    return () => {
      const cur = this.subs.get(topic);
      if (!cur) return;
      cur.delete(handler);
      if (cur.size === 0) this.subs.delete(topic);
    };
  }

  recent(topic: string): TopicPayload[] {
    return (this.buffers.get(topic) ?? []).slice();
  }
}
