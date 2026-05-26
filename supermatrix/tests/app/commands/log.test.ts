import { describe, expect, test } from "vitest";
import { createLogHandler } from "../../../src/app/commands/log.ts";
import { UserError } from "../../../src/domain/errors.ts";
import { asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import type { CrossSessionComm } from "../../../src/ports/BindingStore.ts";

const TARGET_ID = asSessionId("sess_target");

function msg(text = "/log") {
  return {
    groupId: asLarkGroupId("oc_target"),
    messageId: "m1",
    userId: "u1",
    text,
    attachments: [],
    receivedAtMs: 0,
  };
}

type CommInput = {
  id: string;
  fromSessionId: string;
  prompt: string;
  createdAt: number;
  kind?: CrossSessionComm["kind"];
  childSessionId?: string | null;
  childModel?: string | null;
  status?: CrossSessionComm["status"];
  resultPreview?: string | null;
  finalMessage?: string | null;
  messageRunId?: CrossSessionComm["messageRunId"];
  errorMessage?: string | null;
  finishedAt?: CrossSessionComm["finishedAt"];
  bitableRecordId?: string | null;
  syncedAt?: CrossSessionComm["syncedAt"];
  clientRequestId?: string | null;
};

function comm(input: CommInput): CrossSessionComm {
  return {
    id: input.id,
    fromSessionId: asSessionId(input.fromSessionId),
    toSessionId: TARGET_ID,
    kind: input.kind ?? "spawn",
    prompt: input.prompt,
    childSessionId: input.childSessionId ?? null,
    childModel: input.childModel ?? null,
    status: input.status ?? "completed",
    resultPreview: input.resultPreview ?? null,
    finalMessage: input.finalMessage ?? null,
    messageRunId: input.messageRunId ?? null,
    errorMessage: input.errorMessage ?? null,
    finishedAt: input.finishedAt ?? null,
    createdAt: asTimestamp(input.createdAt),
    bitableRecordId: input.bitableRecordId ?? null,
    syncedAt: input.syncedAt ?? null,
    clientRequestId: input.clientRequestId ?? null,
  };
}

describe("createLogHandler", () => {
  test("user scope lists the current session's 10 latest inbound injections with truncated previews", async () => {
    const calls: Array<{ sessionId: string; direction: string; limit: number | undefined }> = [];
    const store = {
      listCrossSessionComms: async (sessionId: any, direction: any, limit?: number) => {
        calls.push({ sessionId, direction, limit });
        return [
          comm({
            id: "comm_2",
            fromSessionId: "sess_watchdog",
            kind: "resume_main",
            prompt: `${"a".repeat(151)} tail`,
            createdAt: 1_700_000_002_000,
          }),
          comm({
            id: "comm_1",
            fromSessionId: "sess_scheduler",
            prompt: "check the queue",
            createdAt: 1_700_000_001_000,
          }),
        ];
      },
      findSessionById: async (id: any) => {
        if (id === "sess_watchdog") return { name: "watchdog" };
        if (id === "sess_scheduler") return { name: "scheduler" };
        if (id === TARGET_ID) return { name: "target" };
        return null;
      },
      findSessionByName: async () => null,
    };
    const handler = createLogHandler({
      store: store as any,
      resolveUserGroupSession: async () => ({ id: TARGET_ID, name: "target" }),
    });

    const result = await handler({ msg: msg(), scope: "user", args: {} });

    expect(calls).toEqual([{ sessionId: TARGET_ID, direction: "to", limit: 10 }]);
    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("最近 2 条注入 target 的信息");
    expect(result.replyText).toContain("watchdog");
    expect(result.replyText).toContain("resume_main");
    expect(result.replyText).toContain("2023-11-14");
    expect(result.replyText).toContain(`${"a".repeat(150)}...`);
    expect(result.replyText).not.toContain("tail");
    expect(result.replyText).toContain("scheduler");
    expect(result.replyText).toContain("spawn");
    expect(result.replyText).toContain("check the queue");
  });

  test("user scope rejects unbound groups with UserError", async () => {
    const handler = createLogHandler({
      store: {} as any,
      resolveUserGroupSession: async () => null,
    });

    await expect(handler({ msg: msg(), scope: "user", args: {} })).rejects.toThrow(UserError);
  });

  test("root scope resolves an explicit session name", async () => {
    const store = {
      findSessionByName: async (name: string) => (name === "target" ? { id: TARGET_ID, name: "target" } : null),
      listCrossSessionComms: async () => [],
      findSessionById: async () => null,
    };
    const handler = createLogHandler({ store: store as any });

    const result = await handler({ msg: msg("/log target"), scope: "root", args: { name: "target" } });

    if (!("replyText" in result)) throw new Error("expected replyText");
    expect(result.replyText).toContain("暂无注入 target 的记录");
  });
});
