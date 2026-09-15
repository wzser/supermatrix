import type { SessionEvent } from "../../domain/events/sessionEvent.ts";
import type { EventBus, EventHandler, Unsubscribe } from "../../ports/EventBus.ts";
import type { Logger } from "../../ports/Logger.ts";

type Subscription = {
  kinds: Set<SessionEvent["kind"]>;
  handler: EventHandler;
};

export class InMemoryEventBus implements EventBus {
  private readonly subs: Set<Subscription> = new Set();
  private readonly queue: SessionEvent[] = [];
  private draining = false;
  private running = false;

  constructor(private readonly logger?: Logger) {}

  async publish(event: SessionEvent): Promise<void> {
    if (!this.running) return;
    this.logger?.debug("event published", { kind: event.kind });
    this.queue.push(event);
    if (!this.draining) void this.drain();
  }

  subscribe(kinds: SessionEvent["kind"][], handler: EventHandler): Unsubscribe {
    const sub: Subscription = { kinds: new Set(kinds), handler };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue.length = 0;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    await new Promise<void>((r) => setTimeout(r, 0)); // defer to macrotask so publish() returns first
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        for (const sub of this.subs) {
          if (!sub.kinds.has(event.kind)) continue;
          try {
            await sub.handler(event);
          } catch (err) {
            this.logger?.error("event handler threw", {
              kind: event.kind,
              err: (err as Error).message,
            });
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
