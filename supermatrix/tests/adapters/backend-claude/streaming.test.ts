import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ClaudeBackend } from "../../../src/adapters/backend-claude/index.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fakeClaudeStream.sh");

function mkSession(): Session {
  return {
    id: asSessionId("s1"),
    name: "foo",
    alias: "",
    avatar: "", category: "", fpManaged: null,
    scope: "user",
    backend: "claude",
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

describe("ClaudeBackend streaming", () => {
  test("first event arrives before process closes", async () => {
    const backend = new ClaudeBackend({ command: FAKE });
    const tStart = Date.now();
    let firstEventAt: number | undefined;
    let totalEvents = 0;
    for await (const e of backend.run({ session: mkSession(), prompt: "hi" })) {
      if (firstEventAt === undefined) firstEventAt = Date.now();
      totalEvents += 1;
      if (e.kind === "completed") break;
    }
    const firstLag = (firstEventAt ?? 0) - tStart;
    expect(totalEvents).toBeGreaterThan(1);
    expect(firstLag).toBeLessThan(1500);
  }, 10_000);
});
