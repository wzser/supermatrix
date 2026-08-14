import type { SessionEvent } from "../domain/events/sessionEvent.ts";

export type EventHandler = (event: SessionEvent) => Promise<void>;

export type Unsubscribe = () => void;

export type EventBus = {
  publish(event: SessionEvent): Promise<void>;
  subscribe(kinds: SessionEvent["kind"][], handler: EventHandler): Unsubscribe;
  start(): Promise<void>;
  stop(): Promise<void>;
};
