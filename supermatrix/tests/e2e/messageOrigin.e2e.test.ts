import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asLarkGroupId } from "../../src/domain/ids.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("e2e message origin admission", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({
      script: () => [
        { kind: "started", backendSessionId: "bks_origin" },
        { kind: "completed", finalMessage: "done" },
      ],
    });
  });

  afterEach(async () => { await h.cleanup(); });

  it("persists lark user synthetic provenance through dispatcher admission and SQLite readback", async () => {
    await h.emitInbound({
      groupId: h.rootGroupId,
      messageId: "m_origin_new",
      userId: "u_owner",
      text: "/new claude origin-target",
      attachments: [],
      receivedAtMs: 0,
    });
    const session = await h.store.findSessionByName("origin-target");
    if (!session) throw new Error("origin-target session missing");

    await h.emitInbound({
      groupId: asLarkGroupId(h.lark.createdGroups[0]),
      messageId: "m_origin_synthetic",
      userId: "u_owner",
      text: "ΔLGS failure notice",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 1,
    });
    await h.emitInbound({
      groupId: asLarkGroupId(h.lark.createdGroups[0]),
      messageId: "m_origin_synthetic_slash",
      userId: "u_owner",
      text: "/status",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 2,
    });
    await h.emitInbound({
      groupId: asLarkGroupId(h.lark.createdGroups[0]),
      messageId: "m_origin_synthetic_next_without_delta",
      userId: "u_owner",
      text: "/next ordinary synthetic prompt",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 3,
    });
    await h.emitInbound({
      groupId: asLarkGroupId(h.lark.createdGroups[0]),
      messageId: "m_origin_synthetic_next_with_leading_space",
      userId: "u_owner",
      text: " Δ/next not exact",
      origin: "lark_user_synthetic",
      attachments: [],
      receivedAtMs: 4,
    });
    await h.emitInbound({
      groupId: asLarkGroupId(h.lark.createdGroups[0]),
      messageId: "m_origin_framework_slash",
      userId: "u_owner",
      text: "/help",
      origin: "framework_synthetic",
      attachments: [],
      receivedAtMs: 5,
    });

    expect(h.runInputs.map((input) => input.prompt)).toEqual([
      "ΔLGS failure notice",
      "/status",
      "/next ordinary synthetic prompt",
      " Δ/next not exact",
      "/help",
    ]);
    expect((await h.store.listRecentMessageRuns(session.id, 5)).map((run) => ({
      prompt: run.prompt,
      origin: run.origin,
      status: run.status,
    }))).toEqual([
      { prompt: "/help", origin: "framework_synthetic", status: "completed" },
      { prompt: " Δ/next not exact", origin: "lark_user_synthetic", status: "completed" },
      { prompt: "/next ordinary synthetic prompt", origin: "lark_user_synthetic", status: "completed" },
      { prompt: "/status", origin: "lark_user_synthetic", status: "completed" },
      { prompt: "ΔLGS failure notice", origin: "lark_user_synthetic", status: "completed" },
    ]);
  });
});
