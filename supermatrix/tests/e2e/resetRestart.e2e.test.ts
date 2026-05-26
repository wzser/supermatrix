import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { asLarkGroupId, asTimestamp } from "../../src/domain/ids.ts";

describe("e2e /reset and /restart", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ script: () => [] }); });
  afterEach(async () => { await h.cleanup(); });

  it("/reset clears backend session id on idle session", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId, messageId: "m1", userId: "u_owner",
      text: "/new claude alpha", attachments: [], receivedAtMs: 0,
    });
    const session = (await h.store.findSessionByName("alpha"))!;
    await h.store.updateSessionBackendSessionId(session.id, "bks_existing");

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    await h.emitInbound({
      groupId: userGroup, messageId: "m2", userId: "u_owner",
      text: "/reset", attachments: [], receivedAtMs: 0,
    });

    const after = (await h.store.findSessionById(session.id))!;
    expect(after.backendSessionId).toBeNull();
    expect(h.lark.sent.at(-1)?.text).toMatch(/✓|上下文/);
  });

  it("/restart forces reset even when session is busy", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId, messageId: "m1", userId: "u_owner",
      text: "/new claude beta", attachments: [], receivedAtMs: 0,
    });
    const session = (await h.store.findSessionByName("beta"))!;
    await h.store.updateSessionStatus(session.id, "busy", asTimestamp(Date.now()));
    await h.store.updateSessionBackendSessionId(session.id, "bks_existing");

    const userGroup = asLarkGroupId(h.lark.createdGroups[0]);
    await h.emitInbound({
      groupId: userGroup, messageId: "m2", userId: "u_owner",
      text: "/restart", attachments: [], receivedAtMs: 0,
    });

    const after = (await h.store.findSessionById(session.id))!;
    expect(after.status).toBe("idle");
    expect(after.backendSessionId).toBeNull();
    expect(h.lark.sent.at(-1)?.text).toMatch(/✓|重启/);
  });
});
