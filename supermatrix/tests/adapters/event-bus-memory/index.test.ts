import { describe, expect, test } from "vitest";
import { InMemoryEventBus } from "../../../src/adapters/event-bus-memory/index.ts";
import type { SessionEvent } from "../../../src/domain/events/sessionEvent.ts";
import { asSessionId } from "../../../src/domain/ids.ts";

function sessionCreated(name = "s1"): SessionEvent {
  return {
    kind: "session_created",
    session: {
      id: asSessionId(name),
      name,
      alias: "",
      avatar: "", category: "", fpManaged: null,
      scope: "user",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: `/ws/${name}` as any,
      purpose: "",
      backendSessionId: null,
      chatName: null,
      status: "initializing",
      parentId: null,
      depth: 0,
      inactivityTimeoutS: null,
      maxRuntimeS: null,
      childType: null,
      triggerKind: null,
      postIdentity: null,
      callerInvocation: null,
      continuationHook: null,
      capabilityPayload: null,
      createdAt: 0 as any,
      updatedAt: 0 as any,
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("InMemoryEventBus", () => {
  test("delivers events to matching subscribers", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const received: SessionEvent[] = [];
    bus.subscribe(["session_created"], async (e) => { received.push(e); });

    await bus.publish(sessionCreated());
    await flush();
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("session_created");
  });

  test("filters events by kind", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const received: SessionEvent[] = [];
    bus.subscribe(["session_deleted"], async (e) => { received.push(e); });

    await bus.publish(sessionCreated());
    await flush();
    expect(received).toHaveLength(0);
  });

  test("supports multiple subscribers for the same kind", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe(["session_created"], async () => { a.push("a"); });
    bus.subscribe(["session_created"], async () => { b.push("b"); });

    await bus.publish(sessionCreated());
    await flush();
    expect(a).toEqual(["a"]);
    expect(b).toEqual(["b"]);
  });

  test("unsubscribe removes handler", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const received: SessionEvent[] = [];
    const unsub = bus.subscribe(["session_created"], async (e) => { received.push(e); });

    unsub();
    await bus.publish(sessionCreated());
    expect(received).toHaveLength(0);
  });

  test("handler errors are isolated — other subscribers still receive events", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const received: string[] = [];
    bus.subscribe(["session_created"], async () => {
      throw new Error("boom");
    });
    bus.subscribe(["session_created"], async () => { received.push("ok"); });

    await bus.publish(sessionCreated());
    await flush();
    expect(received).toEqual(["ok"]);
  });

  test("publish returns before handler executes (async drain)", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    let handlerRan = false;
    bus.subscribe(["session_created"], async () => {
      handlerRan = true;
    });

    await bus.publish(sessionCreated());
    // With async drain, handler has NOT run yet at this point
    expect(handlerRan).toBe(false);

    // Flush macrotask queue
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(handlerRan).toBe(true);
  });

  test("stop prevents further delivery", async () => {
    const bus = new InMemoryEventBus();
    await bus.start();
    const received: SessionEvent[] = [];
    bus.subscribe(["session_created"], async (e) => { received.push(e); });

    await bus.stop();
    await bus.publish(sessionCreated());
    expect(received).toHaveLength(0);
  });
});
