import { describe, expect, test, vi } from "vitest";
import {
  createChildCompletionNotifier,
  renderChildCompletionNotice,
  type ChildCompletionNoticeInput,
} from "../../src/app/childCompletionNotice.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asSessionId,
  asTimestamp,
} from "../../src/domain/ids.ts";
import type { Binding } from "../../src/domain/binding.ts";
import type { Session } from "../../src/domain/session.ts";

function childSession(): Session {
  return {
    id: asSessionId("sess_child_123"),
    name: "child_deepautosearch_123",
    alias: "",
    avatar: "",
    category: "",
    fpManaged: null,
    scope: "child",
    backend: "codex",
    model: null,
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath("/tmp/child"),
    backendSessionId: null,
    chatName: null,
    purpose: "",
    status: "deleted",
    parentId: asSessionId("sess_target"),
    depth: 1,
    inactivityTimeoutS: null,
    maxRuntimeS: null,
    childType: "one_shot_delegation",
    triggerKind: "session",
    postIdentity: null,
    callerInvocation: null,
    continuationHook: null,
    capabilityPayload: null,
    createdAt: asTimestamp(0),
    updatedAt: asTimestamp(0),
  };
}

function noticeInput(): ChildCompletionNoticeInput {
  return {
    commId: "comm_abc_1779936000000",
    callerSessionId: asSessionId("sess_caller"),
    childSession: childSession(),
    completedAt: asTimestamp(Date.UTC(2026, 4, 28, 1, 42, 44)),
  };
}

describe("childCompletionNotice", () => {
  test("renders a short completion notice without the child result body", () => {
    expect(renderChildCompletionNotice(noticeInput())).toBe(
      [
        "comm_abc_1779936000000",
        "2026-05-28 09:42:44 CST",
        "子 session child_deepautosearch_123 已执行完成。",
      ].join("\n"),
    );
  });

  test("renders a MiniMax short summary when available", () => {
    expect(renderChildCompletionNotice(noticeInput(), "更新AWD快照")).toBe(
      [
        "comm_abc_1779936000000",
        "2026-05-28 09:42:44 CST",
        "子 session child_deepautosearch_123 已执行完成。",
        "内容概括：更新AWD快照",
      ].join("\n"),
    );
  });

  test("sends the notice to the caller binding as bot", async () => {
    const groupId = asLarkGroupId("oc_caller");
    const binding: Binding = {
      groupId,
      sessionId: asSessionId("sess_caller"),
      createdAt: asTimestamp(0),
    };
    const sendMessage = vi.fn(async () => {});
    const summaryProvider = vi.fn(async () => "同步元数据");
    const notifier = createChildCompletionNotifier({
      store: {
        async findBySession() {
          return binding;
        },
      },
      lark: { sendMessage },
      summaryProvider,
    });

    const input = { ...noticeInput(), finalMessage: "done" };
    await notifier(input);

    expect(summaryProvider).toHaveBeenCalledWith(input);
    expect(sendMessage).toHaveBeenCalledWith(
      groupId,
      renderChildCompletionNotice(input, "同步元数据"),
      "bot",
    );
  });

  test("keeps sending the notice when summary provider fails", async () => {
    const groupId = asLarkGroupId("oc_caller");
    const binding: Binding = {
      groupId,
      sessionId: asSessionId("sess_caller"),
      createdAt: asTimestamp(0),
    };
    const sendMessage = vi.fn(async () => {});
    const warn = vi.fn();
    const notifier = createChildCompletionNotifier({
      store: {
        async findBySession() {
          return binding;
        },
      },
      lark: { sendMessage },
      summaryProvider: async () => {
        throw new Error("MiniMax down");
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(() => {
          throw new Error("not used");
        }),
      },
    });

    await notifier({ ...noticeInput(), finalMessage: "done" });

    expect(warn).toHaveBeenCalledWith(
      "child completion summary failed",
      expect.objectContaining({ err: "MiniMax down" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      groupId,
      renderChildCompletionNotice(noticeInput()),
      "bot",
    );
  });

});
