import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { asLarkGroupId } from "../../src/domain/ids.ts";

describe("e2e prompt run", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({
      script: () => [
        { kind: "started", backendSessionId: "bks_1" },
        { kind: "thinking", text: "Hmm" },
        { kind: "assistant_message", text: "Hello world", final: true },
        { kind: "completed", finalMessage: "Hello world" },
      ],
    });
  });
  afterEach(async () => { await h.cleanup(); });

  it("streams backend events into a card and marks run completed", async () => {
    // Create alpha first
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_new",
      userId: "u_owner",
      text: "/new claude alpha",
      attachments: [],
      receivedAtMs: 0,
    });

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    await h.emitInbound({
      groupId: userGroup,
      messageId: "m_prompt",
      userId: "u_owner",
      text: "say hello",
      attachments: [],
      receivedAtMs: 0,
    });

    // At least one finalized card containing the final message
    expect(h.lark.cards.some((c) => c.status === "final" && c.body.includes("Hello world"))).toBe(true);

    const session = await h.store.findSessionByName("alpha");
    expect(session).not.toBeNull();
    // No running message run after completion
    const running = await h.store.findRunningMessageRunBySession(session!.id);
    expect(running).toBeNull();
  });
});
