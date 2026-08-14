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
    expect(await h.store.getSessionRuntimeSettings(session!.id)).toMatchObject({
      mainModelDefault: "claude-opus-4-8",
      mainEffortDefault: "xhigh",
    });
  });

  it("keeps an explicit --model separate from the canonical main defaults", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m-explicit-model",
      userId: "u_owner",
      text: "/new claude pinned-claude --model sonnet",
      attachments: [],
      receivedAtMs: 0,
    });

    const session = await h.store.findSessionByName("pinned-claude");
    expect(session?.model).toBe("claude-sonnet-5");
    expect(await h.store.getSessionRuntimeSettings(session!.id)).toMatchObject({
      mainModelDefault: "claude-opus-4-8",
      mainEffortDefault: "xhigh",
    });
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

  it("clones backend-neutral settings while keeping target identity and backend state independent", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m-clone-source",
      userId: "u_owner",
      text: "/new codex codexroot",
      attachments: [],
      receivedAtMs: 0,
    });

    const sourceBeforeClone = await h.store.findSessionByName("codexroot");
    if (!sourceBeforeClone) throw new Error("source session missing");
    const sourceAvatar = "A".repeat(27);
    h.store.db.prepare(
      `UPDATE sessions
       SET alias = ?, avatar = ?, category = '平台', fp_managed = 1,
           model = 'gpt-5.6-sol', effort = 'max', thinking = 1,
           model_locked = 1, effort_locked = 1,
           purpose = 'source purpose', inactivity_timeout_s = 321,
           max_runtime_s = 654, heartbeat_enabled = 0,
           backend_session_id = 'source-context'
       WHERE id = ?`,
    ).run("T800", sourceAvatar, sourceBeforeClone.id);
    await h.store.updateSessionRuntimeSettings(sourceBeforeClone.id, {
      mainModelDefault: "gpt-5.6-terra",
      mainEffortDefault: "max",
      childBackend: { configured: true, value: "codex" },
      childModel: { configured: true, value: "gpt-5.6-luna" },
      childEffort: { configured: true, value: "high" },
    });

    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m-clone-target",
      userId: "u_owner",
      text: "/new clone codexroot kimi kimi-reviewer",
      attachments: [],
      receivedAtMs: 1,
    });

    const source = await h.store.findSessionByName("codexroot");
    const clone = await h.store.findSessionByName("kimi-reviewer");
    expect(source).not.toBeNull();
    expect(clone).not.toBeNull();
    expect(clone?.backend).toBe("kimi");
    expect(clone?.workdir).toBe(source?.workdir);
    expect(clone?.purpose).toBe("source purpose");
    expect(clone?.category).toBe("平台");
    expect(clone?.thinking).toBe(true);
    expect(clone?.inactivityTimeoutS).toBe(321);
    expect(clone?.maxRuntimeS).toBe(654);
    expect(await h.store.getSessionHeartbeatEnabled(clone!.id)).toBe(false);

    expect(clone?.alias).toBe("");
    expect(clone?.avatar).toBe("");
    expect(clone?.fpManaged).toBeNull();
    expect(clone?.model).toBeNull();
    expect(clone?.effort).toBeNull();
    expect(clone?.modelLocked).toBe(false);
    expect(clone?.effortLocked).toBe(false);
    expect(clone?.backendSessionId).toBeNull();
    expect(clone?.affiliatedTo).toBe("codexroot");
    expect(clone?.parentId).toBeNull();
    expect(clone?.scope).toBe("user");
    expect(clone?.id).not.toBe(source?.id);
    expect(await h.store.getSessionRuntimeSettings(clone!.id)).toMatchObject({
      mainModelDefault: "kimi-code/k3",
      mainEffortDefault: null,
      childBackend: { configured: false, value: null },
      childModel: { configured: false, value: null },
      childEffort: { configured: false, value: null },
    });
    expect(h.lark.createdGroupNames).toEqual([
      "codexroot-codex",
      "kimi-reviewer-kimi",
    ]);
  });

  it("/clone infers the source session from the current user group", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m-short-clone-source",
      userId: "u_owner",
      text: "/new codex source-session source purpose",
      attachments: [],
      receivedAtMs: 0,
    });

    const source = await h.store.findSessionByName("source-session");
    if (!source) throw new Error("source session missing");
    h.store.db.prepare(
      `UPDATE sessions
       SET category = '平台', thinking = 1, inactivity_timeout_s = 120,
           max_runtime_s = 240, heartbeat_enabled = 0
       WHERE id = ?`,
    ).run(source.id);
    const sourceGroup = asLarkGroupId(h.lark.createdGroups[0]);

    await h.emitInbound({
      groupId: sourceGroup,
      messageId: "m-short-clone-target",
      userId: "u_owner",
      text: "/clone claude codexclaude",
      attachments: [],
      receivedAtMs: 1,
    });

    const clone = await h.store.findSessionByName("codexclaude");
    expect(clone).toMatchObject({
      backend: "claude",
      workdir: source.workdir,
      purpose: "source purpose",
      category: "平台",
      thinking: true,
      inactivityTimeoutS: 120,
      maxRuntimeS: 240,
      model: null,
      effort: null,
      backendSessionId: null,
      affiliatedTo: "source-session",
      parentId: null,
      scope: "user",
    });
    expect(await h.store.getSessionHeartbeatEnabled(clone!.id)).toBe(false);
    expect(await h.store.getSessionRuntimeSettings(clone!.id)).toMatchObject({
      mainModelDefault: "claude-opus-4-8",
      mainEffortDefault: "xhigh",
    });
    expect(h.lark.createdGroupNames).toEqual([
      "source-session-codex",
      "codexclaude-claude",
    ]);
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
