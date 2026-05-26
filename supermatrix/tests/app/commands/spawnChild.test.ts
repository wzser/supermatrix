import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSpawnChildHandler } from "../../../src/app/commands/spawnChild.ts";
import { UserError } from "../../../src/domain/errors.ts";
import {
  asAbsolutePath,
  asLarkGroupId,
  asMessageRunId,
  asSessionId,
  asTimestamp,
} from "../../../src/domain/ids.ts";
import type { Session } from "../../../src/domain/session.ts";
import type { SpawnChildResult } from "../../../src/app/childSession.ts";
import { createFakeBindingStore } from "../../fakes/fakeBindingStore.ts";
import { resetCodexModelCatalogForTests } from "../../../src/ports/CodexModelCatalog.ts";

function msg(groupId: string, text: string) {
  return {
    groupId: asLarkGroupId(groupId),
    messageId: "m",
    userId: "u",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

function makeResult(name: string, finalMessage: string): SpawnChildResult {
  return {
    session: {
      id: asSessionId("sess_child_1"),
      name,
      alias: "",
      avatar: "", category: "", fpManaged: null,
      scope: "child",
      backend: "claude",
      model: null,
      effort: null,
      thinking: false,
      modelLocked: false,
      workdir: asAbsolutePath("/ws/target"),
      backendSessionId: null,
      chatName: null,
      purpose: "",
      status: "deleted",
      parentId: asSessionId("sess_target"),
      depth: 1,
      inactivityTimeoutS: null,
      maxRuntimeS: null,
      childType: null,
      triggerKind: null,
      postIdentity: null,
      callerInvocation: null,
      continuationHook: null,
      capabilityPayload: null,
      createdAt: asTimestamp(1000),
      updatedAt: asTimestamp(2000),
    },
    finalMessage,
    backendSessionId: null,
    messageRunId: asMessageRunId("mr_test_1"),
  };
}

const TARGET_SESSION: Session = {
  id: asSessionId("sess_target"),
  name: "supermatrix-root",
  alias: "",
  avatar: "", category: "", fpManaged: null,
  scope: "user",
  backend: "claude",
  model: "claude-opus-4-7",
  effort: null,
  thinking: false,
  modelLocked: false,
  workdir: asAbsolutePath("/ws/target"),
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
  createdAt: asTimestamp(1000),
  updatedAt: asTimestamp(1000),
};

describe("/spawn handler", () => {
  beforeEach(() => {
    resetCodexModelCatalogForTests([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
      "gpt-5.2",
    ]);
  });

  test("routes result to parent session's bound group by default", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    store.seedBinding({
      groupId: asLarkGroupId("oc_target_group"),
      sessionId: TARGET_SESSION.id,
      createdAt: asTimestamp(1000),
    });

    const childResult = makeResult("child_supermatrix-root_abc123", "task done");
    const spawnChild = vi.fn(async () => childResult);
    const sendMessage = vi.fn(async () => {});

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage },
    });

    const result = await handler({
      args: { name: "supermatrix-root", prompt: "do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root do something"),
    });

    // Result sent to target group, not console
    expect(sendMessage).toHaveBeenCalledWith(
      asLarkGroupId("oc_target_group"),
      expect.stringContaining("task done"),
    );

    // Root group gets a short ack
    expect(result).toHaveProperty("replyText");
    if ("replyText" in result) {
      expect(result.replyText).toContain("已完成");
      expect(result.replyText).toContain("结果已发送到目标群");
    }
  });

  test("inherits target model when --model is omitted and backend matches", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    const spawnChild = vi.fn(async () => makeResult("child_supermatrix-root_abc123", "task done"));

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage: vi.fn(async () => {}) },
    });

    await handler({
      args: { name: "supermatrix-root", prompt: "do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root do something"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-opus-4-7" }),
    );
  });

  test("resolves --model alias against selected backend", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    const spawnChild = vi.fn(async () => makeResult("child_supermatrix-root_abc123", "task done"));

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage: vi.fn(async () => {}) },
    });

    await handler({
      args: { name: "supermatrix-root", prompt: "--model sonnet do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root --model sonnet do something"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        prompt: "do something",
      }),
    );
  });

  test("does not inherit target model when --backend switches backend and --model is omitted", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    const spawnChild = vi.fn(async () => makeResult("child_supermatrix-root_abc123", "task done"));

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage: vi.fn(async () => {}) },
    });

    await handler({
      args: { name: "supermatrix-root", prompt: "--backend codex do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root --backend codex do something"),
    });

    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        model: null,
      }),
    );
  });

  test("rejects unknown codex --model before spawning", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    const spawnChild = vi.fn(async () => makeResult("child_supermatrix-root_abc123", "task done"));

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage: vi.fn(async () => {}) },
    });

    await expect(
      handler({
        args: { name: "supermatrix-root", prompt: "--backend codex --model gpt-5.3 do something" },
        scope: "root",
        msg: msg("oc_console", "/spawn supermatrix-root --backend codex --model gpt-5.3 do something"),
      }),
    ).rejects.toThrow('未知 codex 模型 "gpt-5.3"');
    expect(spawnChild).not.toHaveBeenCalled();
  });

  test("routes result to --reply-to group when specified", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    store.seedBinding({
      groupId: asLarkGroupId("oc_target_group"),
      sessionId: TARGET_SESSION.id,
      createdAt: asTimestamp(1000),
    });

    const childResult = makeResult("child_supermatrix-root_abc123", "task done");
    const spawnChild = vi.fn(async () => childResult);
    const sendMessage = vi.fn(async () => {});

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage },
    });

    await handler({
      args: {
        name: "supermatrix-root",
        prompt: "--reply-to oc_watchdog do something",
      },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root --reply-to oc_watchdog do something"),
    });

    // Result sent to explicit reply-to group
    expect(sendMessage).toHaveBeenCalledWith(
      asLarkGroupId("oc_watchdog"),
      expect.stringContaining("task done"),
    );

    // Prompt passed to spawnChild should have --reply-to stripped
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "do something" }),
    );
  });

  test("falls back gracefully when parent has no binding", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    // No binding seeded

    const childResult = makeResult("child_supermatrix-root_abc123", "task done");
    const spawnChild = vi.fn(async () => childResult);
    const sendMessage = vi.fn(async () => {});

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage },
    });

    const result = await handler({
      args: { name: "supermatrix-root", prompt: "do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root do something"),
    });

    // No lark message sent (no target group found)
    expect(sendMessage).not.toHaveBeenCalled();

    // Root group still gets the ack (without "结果已发送")
    if ("replyText" in result) {
      expect(result.replyText).toContain("已完成");
      expect(result.replyText).not.toContain("结果已发送到目标群");
    }
  });

  test("rejects non-root scope", async () => {
    const store = createFakeBindingStore();
    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild: vi.fn() },
      lark: { sendMessage: vi.fn() },
    });
    await expect(
      handler({
        args: { name: "foo", prompt: "bar" },
        scope: "user",
        msg: msg("oc_user", "/spawn foo bar"),
      }),
    ).rejects.toThrow(UserError);
  });

  test("rejects unknown session", async () => {
    const store = createFakeBindingStore();
    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild: vi.fn() },
      lark: { sendMessage: vi.fn() },
    });
    await expect(
      handler({
        args: { name: "nonexistent", prompt: "bar" },
        scope: "root",
        msg: msg("oc_root", "/spawn nonexistent bar"),
      }),
    ).rejects.toThrow(UserError);
  });

  test("rejects when --reply-to leaves empty prompt", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild: vi.fn() },
      lark: { sendMessage: vi.fn() },
    });
    await expect(
      handler({
        args: { name: "supermatrix-root", prompt: "--reply-to oc_watchdog" },
        scope: "root",
        msg: msg("oc_root", "/spawn supermatrix-root --reply-to oc_watchdog"),
      }),
    ).rejects.toThrow(UserError);
  });

  test("truncates long result to 200 chars in forwarded message", async () => {
    const store = createFakeBindingStore();
    store.seedSession(TARGET_SESSION);
    store.seedBinding({
      groupId: asLarkGroupId("oc_target_group"),
      sessionId: TARGET_SESSION.id,
      createdAt: asTimestamp(1000),
    });

    const longMsg = "x".repeat(300);
    const childResult = makeResult("child_supermatrix-root_abc123", longMsg);
    const spawnChild = vi.fn(async () => childResult);
    const sendMessage = vi.fn(async () => {});

    const handler = createSpawnChildHandler({
      store,
      childSession: { spawnChild },
      lark: { sendMessage },
    });

    await handler({
      args: { name: "supermatrix-root", prompt: "do something" },
      scope: "root",
      msg: msg("oc_console", "/spawn supermatrix-root do something"),
    });

    const sentText = (sendMessage.mock.calls[0] as unknown as [unknown, string])[1];
    expect(sentText).toContain("...");
    // 200 chars of content + "..." + prefix
    expect(sentText.length).toBeLessThan(300);
  });
});
