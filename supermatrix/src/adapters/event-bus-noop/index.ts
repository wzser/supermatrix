import type { SessionEvent } from "../../domain/events/sessionEvent.ts";
import type { EventBus, EventHandler, Unsubscribe } from "../../ports/EventBus.ts";
import type { Logger } from "../../ports/Logger.ts";

export class NoopEventBus implements EventBus {
  constructor(private readonly logger?: Logger) {}

  async publish(event: SessionEvent): Promise<void> {
    this.logger?.debug("event published (noop)", { kind: event.kind });
  }

  subscribe(_kinds: SessionEvent["kind"][], _handler: EventHandler): Unsubscribe {
    void _kinds;
    void _handler;
    return () => {};
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
