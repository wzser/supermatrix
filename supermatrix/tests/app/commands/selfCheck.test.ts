import { describe, expect, it } from "vitest";
import { createSelfCheckHandler } from "../../../src/app/commands/selfCheck.ts";
import type { CheckResult } from "../../../src/app/bootSelfCheck/types.ts";
import { asLarkGroupId } from "../../../src/domain/ids.ts";
import type { InboundMessage } from "../../../src/ports/LarkGateway.ts";

function fakeMsg(): InboundMessage {
  return {
    groupId: asLarkGroupId("root-group"),
    userId: "root-user",
    // Other InboundMessage fields are not read by the handler; add empty defaults.
  } as InboundMessage;
}

describe("/selfcheck handler", () => {
  it("runs checks and returns rendered report as replyText", async () => {
    const handler = createSelfCheckHandler({
      runChecks: async (): Promise<CheckResult[]> => [
        { name: "local-deps", status: "ok" },
        { name: "supervisor-presence", status: "warn", message: "bare run under zsh" },
      ],
    });
    const result = await handler({ msg: fakeMsg(), scope: "root", args: {} });
    expect("replyText" in result).toBe(true);
    if ("replyText" in result) {
      expect(result.replyText).toContain("SuperMatrix 自检报告");
      expect(result.replyText).toContain("✅ local-deps");
      expect(result.replyText).toContain("⚠️ supervisor-presence");
    }
  });

  it("returns report with only ok entries when system is healthy", async () => {
    const handler = createSelfCheckHandler({
      runChecks: async () => [
        { name: "local-deps", status: "ok" },
        { name: "scheduler-health", status: "ok", detail: { tasks: 10 } },
      ],
    });
    const result = await handler({ msg: fakeMsg(), scope: "root", args: {} });
    expect("replyText" in result && result.replyText).toContain("✅ local-deps");
  });
});
