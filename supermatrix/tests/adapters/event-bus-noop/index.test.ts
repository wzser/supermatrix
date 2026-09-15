import { describe, test } from "vitest";
import { NoopEventBus } from "../../../src/adapters/event-bus-noop/index.ts";
import { asSessionId } from "../../../src/domain/ids.ts";

describe("NoopEventBus", () => {
  test("publish and subscribe are no-ops that don't throw", async () => {
    const bus = new NoopEventBus();
    await bus.start();
    const unsub = bus.subscribe(["session_created"], async () => {});
    await bus.publish({ kind: "session_deleted", sessionId: asSessionId("s1") });
    unsub();
    await bus.stop();
  });
});
