/**
 * Named-topic pub/sub for cross-session payload delivery.
 *
 * Kept separate from {@link EventBus}: EventBus carries internal session
 * lifecycle events (session_created, session_status_changed) with a closed
 * kind-enum and subscribers that care about specific kinds. TopicBus carries
 * arbitrary domain payloads on named topics that callers invent at runtime
 * (e.g. `"coding.result.ticket-42"`), which is what the `eventbus_publish`
 * resultSink + `event_awaited_worker` child type need.
 *
 * Recent-buffer semantics: in fire_and_forget flows the publisher often
 * finishes before any subscriber attaches. Implementations MUST retain a
 * bounded ring of recent publishes per topic; `subscribe()` replays any
 * matching buffered payloads to the new subscriber before going live.
 */

export type TopicPayload = {
  topic: string;
  /** Arbitrary JSON-serialisable object supplied by the publisher. */
  payload: unknown;
  /** Epoch millis when the publish was accepted by the bus. */
  publishedAtMs: number;
};

export type TopicHandler = (msg: TopicPayload) => Promise<void>;

export type TopicSubscribeOptions = {
  /**
   * When true, replay retained payloads from this topic to the handler
   * before subscribing to future publishes. Defaults to true — the whole
   * point of the retention buffer is to close the publish-before-subscribe
   * race for event_awaited_worker / event_publisher coordination.
   */
  replay?: boolean;
};

export type TopicUnsubscribe = () => void;

export type TopicBus = {
  publish(topic: string, payload: unknown): Promise<void>;
  subscribe(topic: string, handler: TopicHandler, options?: TopicSubscribeOptions): TopicUnsubscribe;
  /** Inspect recent payloads on a topic (for audit / debugging). */
  recent(topic: string): TopicPayload[];
};
