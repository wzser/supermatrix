import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("e2e /delete", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ script: () => [] }); });
  afterEach(async () => { await h.cleanup(); });

  it("deletes session, dissolves user group, and acknowledges", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId, messageId: "m1", userId: "u_owner",
      text: "/new claude gamma", attachments: [], receivedAtMs: 0,
    });
    const session = (await h.store.findSessionByName("gamma"))!;

    await h.emitInbound({
      groupId: h.rootGroupId, messageId: "m2", userId: "u_owner",
      text: "/delete gamma", attachments: [], receivedAtMs: 0,
    });

    const after = await h.store.findSessionById(session.id);
    expect(after?.status).toBe("deleted");
    expect(h.lark.dissolvedGroups).toHaveLength(1);
    expect(h.lark.sent.at(-1)?.text).toMatch(/✓|已删除/);
  });

  it("rejects /delete without a name", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId, messageId: "m1", userId: "u_owner",
      text: "/delete", attachments: [], receivedAtMs: 0,
    });
    expect(h.lark.sent.at(-1)?.text).toMatch(/❌|用法/);
  });
});
