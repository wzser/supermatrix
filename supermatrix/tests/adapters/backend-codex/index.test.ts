import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CodexBackend } from "../../../src/adapters/backend-codex/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeCodex.sh");

function mkSession(): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "idle",
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
  };
}

describe("CodexBackend", () => {
  test("happy run yields events via AsyncIterable", async () => {
    const backend = new CodexBackend({ command: FAKE, buildArgs: () => ["happy"] });
    const events: string[] = [];
    for await (const e of backend.run({ session: mkSession(), prompt: "hi" })) {
      events.push(e.kind);
    }
    expect(events).toContain("started");
    expect(events).toContain("completed");
  });

  test("injects SM_SESSION_NAME env var from session.name", async () => {
    const backend = new CodexBackend({ command: FAKE, buildArgs: () => ["env"] });
    const session = mkSession();
    let finalMessage = "";
    for await (const e of backend.run({ session, prompt: "hi" })) {
      if (e.kind === "completed") finalMessage = e.finalMessage;
    }
    expect(finalMessage).toBe(`SM_SESSION_NAME=${session.name}`);
  });

  test("cancel terminates the iteration", async () => {
    const backend = new CodexBackend({ command: FAKE, buildArgs: () => ["slow"] });
    const collected: string[] = [];
    const iter = backend.run({ session: mkSession(), prompt: "hi" })[Symbol.asyncIterator]();
    const firstP = iter.next();
    await new Promise((r) => setTimeout(r, 100));
    await backend.cancel(asSessionId("s1"));
    while (true) {
      const { value, done } = await (collected.length === 0 ? firstP : iter.next());
      if (done) break;
      collected.push(value.kind);
      if (collected.length > 10) break;
    }
    expect(collected.length).toBeGreaterThan(0);
  }, 10_000);
});
