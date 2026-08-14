// tests/adapters/backend-kimi/askUserPermission.test.ts

import { describe, expect, test } from "vitest";
import type { RequestPermissionRequest } from "@zed-industries/agent-client-protocol";
import {
  isAskUserQuestionPermission,
  parseAskUserQuestionPermission,
} from "../../../src/adapters/backend-kimi/askUserPermission.ts";

// Verbatim shape recorded from kimi-code 0.27.0 by
// scripts/repair/probe-kimi-askuser.mjs.
function probeParams(): RequestPermissionRequest {
  return {
    sessionId: "session_x",
    toolCall: {
      toolCallId: "0:tool_SIy3vf5wzVNT6JdE9srQGMKD",
      title: "AskUserQuestion",
      content: [
        {
          type: "content",
          content: { text: "测试：选哪个方案？", type: "text" },
        },
      ],
    },
    options: [
      { kind: "allow_once", name: "方案A", optionId: "q0_opt_0" },
      { kind: "allow_once", name: "方案B", optionId: "q0_opt_1" },
      { kind: "reject_once", name: "Skip", optionId: "q0_skip" },
    ],
  } as RequestPermissionRequest;
}

describe("isAskUserQuestionPermission", () => {
  test("matches on toolCall.title === AskUserQuestion", () => {
    expect(isAskUserQuestionPermission(probeParams())).toBe(true);
  });

  test("rejects ordinary tool consent requests", () => {
    const params = probeParams();
    params.toolCall = { toolCallId: "t1", title: "Bash" };
    expect(isAskUserQuestionPermission(params)).toBe(false);
  });
});

describe("parseAskUserQuestionPermission", () => {
  test("extracts question text and allow_once options, drops Skip", () => {
    const parsed = parseAskUserQuestionPermission(probeParams());
    expect(parsed).not.toBeNull();
    expect(parsed!.question).toBe("测试：选哪个方案？");
    expect(parsed!.options).toEqual([
      { label: "方案A", value: "q0_opt_0", description: "方案A" },
      { label: "方案B", value: "q0_opt_1", description: "方案B" },
    ]);
  });

  test("returns null for non-AskUserQuestion requests", () => {
    const params = probeParams();
    params.toolCall = { toolCallId: "t1", title: "Bash" };
    expect(parseAskUserQuestionPermission(params)).toBeNull();
  });

  test("returns null when no question text is carried", () => {
    const params = probeParams();
    params.toolCall = { toolCallId: "t1", title: "AskUserQuestion", content: [] };
    expect(parseAskUserQuestionPermission(params)).toBeNull();
  });

  test("returns null when only the Skip option is present", () => {
    const params = probeParams();
    params.options = [{ kind: "reject_once", name: "Skip", optionId: "q0_skip" }];
    expect(parseAskUserQuestionPermission(params)).toBeNull();
  });

  test("returns null when options exceed the card's 5-button limit", () => {
    const params = probeParams();
    params.options = Array.from({ length: 6 }, (_, i) => ({
      kind: "allow_once" as const,
      name: `选项${i}`,
      optionId: `q0_opt_${i}`,
    }));
    expect(parseAskUserQuestionPermission(params)).toBeNull();
  });
});
