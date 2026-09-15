import type { SessionEvent } from "../../src/domain/events/sessionEvent.ts";
import type { EventBus, EventHandler, Unsubscribe } from "../../src/ports/EventBus.ts";

export function createFakeEventBus(): EventBus & {
  published: SessionEvent[];
} {
  const published: SessionEvent[] = [];

  return {
    published,
    async publish(event: SessionEvent): Promise<void> {
      published.push(event);
    },
    subscribe(_kinds: SessionEvent["kind"][], _handler: EventHandler): Unsubscribe {
      return () => {};
    },
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
  };
}
