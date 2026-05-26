import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";
import { asLarkGroupId } from "../../src/domain/ids.ts";

describe("e2e /new", () => {
  let h: Harness;
  beforeEach(async () => { h = await createHarness({ script: () => [] }); });
  afterEach(async () => { await h.cleanup(); });

  it("creates a session and opens a user group bound to it", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m1",
      userId: "u_owner",
      text: "/new claude alpha",
      attachments: [],
      receivedAtMs: 0,
    });

    const session = await h.store.findSessionByName("alpha");
    expect(session).not.toBeNull();
    expect(session?.backend).toBe("claude");
    expect(h.lark.createdGroups).toHaveLength(1);
    expect(h.lark.sent.some((m) => m.text.includes("alpha"))).toBe(true);

    // A user binding should exist for the created group
    const createdGroup = h.lark.createdGroups[0];
    const binding = await h.store.findByGroup(asLarkGroupId(createdGroup));
    expect(binding?.sessionId).toBe(session?.id);
  });

  it("applies --chat-name as a prefix on the feishu group name", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m3",
      userId: "u_owner",
      text: "/new claude gamma --chat-name 研发-项目组",
      attachments: [],
      receivedAtMs: 0,
    });

    // --chat-name is a group alias/prefix; final name = `{prefix}-{name}-{backend}`.
    expect(h.lark.createdGroupNames).toEqual(["研发-项目组-gamma-claude"]);
    const session = await h.store.findSessionByName("gamma");
    expect(session).not.toBeNull();
  });

  it("falls back to default group name when --chat-name is omitted", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m4",
      userId: "u_owner",
      text: "/new claude delta",
      attachments: [],
      receivedAtMs: 0,
    });

    expect(h.lark.createdGroupNames).toEqual(["delta-claude"]);
  });

  it("rejects /new in a non-root group", async () => {
    await h.emitInbound({
      groupId: asLarkGroupId("g_other"),
      messageId: "m2",
      userId: "u_owner",
      text: "/new claude beta",
      attachments: [],
      receivedAtMs: 0,
    });
    const last = h.lark.sent.at(-1)?.text ?? "";
    expect(last).toMatch(/❌|未知|仅|root/);
    expect(await h.store.findSessionByName("beta")).toBeNull();
  });
});
