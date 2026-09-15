import { describe, expect, test, vi } from "vitest";
import {
  fallbackChildCompletionSummary,
  miniMaxChildCompletionSummaryProvider,
  normalizeShortSummary,
} from "../../src/app/childCompletionSummary.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { ChildCompletionNoticeInput } from "../../src/app/childCompletionNotice.ts";
import type { Session } from "../../src/domain/session.ts";

function childSession(): Session {
  return {
    id: asSessionId("sess_child_123"),
    name: "child_amz-sql_f601f0",
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
    commId: "comm_e6f601f0_1780385100024",
    callerSessionId: asSessionId("sess_caller"),
    childSession: childSession(),
    completedAt: asTimestamp(0),
    finalMessage: [
      "operation: `lingxing-awd-satellite-cargo-hourly`",
      "status: `success`",
      "目标表已更新：`dwd.lingxing_awd_satellite_cargo_snapshot_d`，`row_count=139`",
    ].join("\n"),
  };
}

describe("childCompletionSummary", () => {
  test("normalizes MiniMax output and caps it at 15 visible chars", () => {
    expect(normalizeShortSummary("<think>推理</think>\n标题：更新AWD卫星仓快照数据。")).toBe(
      "更新AWD卫星仓快照数据",
    );
    expect(
      normalizeShortSummary(
        '<think>没有正文。Thus I will output "灵星卫星货运小时同步完成".</think>\n\n',
      ),
    ).toBe("灵星卫星货运小时同步完成");
    expect(
      normalizeShortSummary(
        '<think>候选标题 "灵星卫星仓快照更新"</think>\n\n执行完成',
      ),
    ).toBe("灵星卫星仓快照更新");
    expect(normalizeShortSummary("这是一个超过十五个字的子任务概括")).toBe("这是一个超过十五个字的子任务概");
  });

  test("asks MiniMax for a short child completion summary", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      fetchCalls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "更新AWD卫星仓快照" } }],
        }),
        { status: 200 },
      );
    });
    const provider = miniMaxChildCompletionSummaryProvider({
      apiKey: "test-key",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      timeoutMs: 1000,
      fetchFn,
    });

    await expect(provider(noticeInput())).resolves.toBe("更新AWD卫星仓快照");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.minimaxi.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    const body = JSON.parse(String(fetchCalls[0]?.init?.body)) as {
      messages: Array<{ content: string }>;
      max_tokens: number;
    };
    expect(body.max_tokens).toBe(512);
    expect(body.messages[0]?.content).toContain("15个汉字以内");
    expect(body.messages[0]?.content).toContain("lingxing-awd-satellite-cargo-hourly");
  });

  test("falls back to deterministic context when MiniMax summary is too thin", async () => {
    expect(fallbackChildCompletionSummary(noticeInput())).toBe("更新AWD卫星仓");
    const fetchFn: typeof fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "快照" } }],
        }),
        { status: 200 },
      ),
    );
    const provider = miniMaxChildCompletionSummaryProvider({
      apiKey: "test-key",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2.7",
      timeoutMs: 1000,
      fetchFn,
    });

    await expect(provider(noticeInput())).resolves.toBe("更新AWD卫星仓");
  });
});
