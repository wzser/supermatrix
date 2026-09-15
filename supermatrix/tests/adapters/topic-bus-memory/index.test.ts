import { describe, expect, test } from "vitest";
import { InMemoryTopicBus } from "../../../src/adapters/topic-bus-memory/index.ts";

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe("InMemoryTopicBus", () => {
  test("delivers published messages to live subscribers", async () => {
    const bus = new InMemoryTopicBus();
    const received: unknown[] = [];
    bus.subscribe("t1", async (msg) => {
      received.push(msg.payload);
    });
    await bus.publish("t1", { hello: "world" });
    expect(received).toEqual([{ hello: "world" }]);
  });

  test("isolates subscribers per topic", async () => {
    const bus = new InMemoryTopicBus();
    const t1: unknown[] = [];
    const t2: unknown[] = [];
    bus.subscribe("t1", async (m) => void t1.push(m.payload));
    bus.subscribe("t2", async (m) => void t2.push(m.payload));
    await bus.publish("t1", 1);
    await bus.publish("t2", 2);
    expect(t1).toEqual([1]);
    expect(t2).toEqual([2]);
  });

  test("replays buffered payloads to late subscribers (closes publish-before-subscribe race)", async () => {
    const bus = new InMemoryTopicBus();
    await bus.publish("t1", "first");
    await bus.publish("t1", "second");

    const received: unknown[] = [];
    bus.subscribe("t1", async (m) => {
      received.push(m.payload);
    });
    await flushMicrotasks();
    expect(received).toEqual(["first", "second"]);
  });

  test("replay=false skips the retention buffer", async () => {
    const bus = new InMemoryTopicBus();
    await bus.publish("t1", "old");
    const received: unknown[] = [];
    bus.subscribe(
      "t1",
      async (m) => {
        received.push(m.payload);
      },
      { replay: false },
    );
    await flushMicrotasks();
    expect(received).toEqual([]);
    await bus.publish("t1", "new");
    expect(received).toEqual(["new"]);
  });

  test("retention ring buffer drops oldest beyond bufferPerTopic", async () => {
    const bus = new InMemoryTopicBus({ bufferPerTopic: 2 });
    await bus.publish("t1", "a");
    await bus.publish("t1", "b");
    await bus.publish("t1", "c");
    expect(bus.recent("t1").map((m) => m.payload)).toEqual(["b", "c"]);
  });

  test("unsubscribe stops further deliveries", async () => {
    const bus = new InMemoryTopicBus();
    const received: unknown[] = [];
    const off = bus.subscribe("t1", async (m) => void received.push(m.payload));
    await bus.publish("t1", 1);
    off();
    await bus.publish("t1", 2);
    expect(received).toEqual([1]);
  });

  test("handler errors are isolated — other subscribers still get delivered", async () => {
    const bus = new InMemoryTopicBus();
    const good: unknown[] = [];
    bus.subscribe("t1", async () => {
      throw new Error("bad subscriber");
    });
    bus.subscribe("t1", async (m) => {
      good.push(m.payload);
    });
    await bus.publish("t1", "payload");
    expect(good).toEqual(["payload"]);
  });

  test("publish with zero subscribers retains for future subscribers", async () => {
    const bus = new InMemoryTopicBus();
    await bus.publish("t1", "early");
    const received: unknown[] = [];
    bus.subscribe("t1", async (m) => void received.push(m.payload));
    await flushMicrotasks();
    expect(received).toEqual(["early"]);
  });
});
