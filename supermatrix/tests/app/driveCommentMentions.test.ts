import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildDriveCommentMentionDedupeKey,
  buildDriveCommentResponseLogId,
  buildDriveCommentTargetPrompt,
  createDriveCommentMentionProcessor,
  dispatchDriveCommentScript,
  expandDriveCommentScriptArgv,
  resolveDriveCommentMentionRoute,
  routeDriveCommentMention,
  type DriveCommentMentionRequest,
  type DriveCommentScriptDispatchInput,
} from "../../src/app/driveCommentMentions.ts";
import type { DriveCommentMentionRecord, ResultSinkAttempt, SpawnAsyncItemRecord } from "../../src/ports/BindingStore.ts";
import type { DriveCommentSource } from "../../src/ports/LarkGateway.ts";
import { asAbsolutePath, asMessageRunId, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { Session } from "../../src/domain/session.ts";

function req(text: string): DriveCommentMentionRequest {
  return {
    source: {
      kind: "drive_comment",
      eventId: "evt_1",
      fileToken: "doc_token",
      fileType: "docx",
      commentId: "comment_1",
      fromUserId: "ou_user",
    },
    text,
    quote: "被评论的正文片段",
    threadReplies: [],
  };
}

const sweepStoreStubs = {
  async findDriveCommentMention() {
    return null;
  },
  async listResultSinkAttemptsBySpawn() {
    return [];
  },
  async listSpawnAsyncItemsByCallerSession() {
    return [];
  },
  async closeSpawnAsyncItemConsumed() {
    return false;
  },
};

function mentionRecord(source: DriveCommentSource): DriveCommentMentionRecord {
  return {
    dedupeKey: buildDriveCommentMentionDedupeKey(source),
    eventId: source.eventId,
    fileToken: source.fileToken,
    fileType: source.fileType,
    commentId: source.commentId,
    replyId: source.replyId ?? null,
    fromUserId: source.fromUserId ?? null,
    targetSession: "todomaster",
    matchedRule: "intent:todo",
    status: "processing",
    resultText: null,
    errorMessage: null,
    createdAt: asTimestamp(10_000),
    updatedAt: asTimestamp(10_000),
    finishedAt: null,
  };
}

function queuedAsyncItem(
  overrides: Partial<SpawnAsyncItemRecord> = {},
  clientRequestId = buildDriveCommentMentionDedupeKey(req("ignored").source),
): SpawnAsyncItemRecord {
  return {
    ref: "spawnq_1",
    commId: "comm_1",
    callerSession: "pinglunmaster",
    targetSession: "todomaster",
    failedPhase: "communication",
    failureKind: "spawn_not_started",
    attemptCount: 0,
    status: "waiting_child",
    verdict: null,
    verdictReason: null,
    lastAttemptAt: null,
    childSessionId: null,
    messageRunId: null,
    commStatus: "completed",
    finalMessage: "送达确认：canary-fcdf55e 已收到",
    errorMessage: null,
    clientRequestId,
    originRunId: null,
    createdAt: asTimestamp(10_000),
    updatedAt: asTimestamp(10_000),
    ...overrides,
  };
}

describe("routeDriveCommentMention", () => {
  test("routes explicit target before keyword classes", () => {
    expect(routeDriveCommentMention(req("交给查数记录一下广告花费"))).toMatchObject({
      target: "dataquery",
      matchedRule: "explicit:dataquery",
    });
  });

  test("routes todo requests to todomaster", () => {
    expect(routeDriveCommentMention(req("帮我记一个待办，下周跟进这个供应商"))).toMatchObject({
      target: "todomaster",
      matchedRule: "intent:todo",
    });
  });

  test("routes data queries to dataquery", () => {
    expect(routeDriveCommentMention(req("查一下这个 ASIN 最近 7 天销量和转化率"))).toMatchObject({
      target: "dataquery",
      matchedRule: "intent:dataquery",
    });
  });

  test("routes business knowledge questions to business-knowledge", () => {
    expect(routeDriveCommentMention(req("这个流程的判断标准是什么"))).toMatchObject({
      target: "business-knowledge",
      matchedRule: "intent:business-knowledge",
    });
  });

  test("routes business knowledge questions before overlapping data keywords", () => {
    expect(routeDriveCommentMention(req("库存规则是什么"))).toMatchObject({
      target: "business-knowledge",
      matchedRule: "intent:business-knowledge",
    });
  });

  test("falls back to pinglunmaster when no deterministic rule matches", () => {
    expect(routeDriveCommentMention(req("这段话帮我看看"))).toMatchObject({
      target: "pinglunmaster",
      matchedRule: "fallback:self",
    });
  });

  test("fails closed for a Bitable data-looking comment without current record context", () => {
    expect(routeDriveCommentMention({
      source: {
        ...req("ignored").source,
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
      },
      text: "经营表 fba可售 0可售asin 父ASIN日表/汇总表",
      threadReplies: [],
    })).toEqual({
      target: "pinglunmaster",
      matchedRule: "safety:missing-bitable-context",
      reason: expect.stringContaining("record_id"),
    });
  });
});

describe("resolveDriveCommentMentionRoute registry predicates", () => {
  const registry = {
    async load() {
      return {
        version: 1 as const,
        routes: [{
          id: "todo-comments",
          enabled: true,
          source: {
            fileToken: "base_token",
            fileType: "bitable" as const,
            tableId: "tbl_todo",
          },
          triggers: [{
            id: "agent-todo-comment",
            priority: 100,
            match: { all: ["边界补充"] },
            recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
            sopRef: "sop/mention/todo.md",
          }],
        }],
      };
    },
    async loadSop() {
      return { name: "todo", targetSession: "tobedone", body: "处理 todo 评论" };
    },
  };

  test("requires the configured table and every record field condition", async () => {
    const request: DriveCommentMentionRequest = {
      source: {
        ...req("ignored").source,
        fileToken: "base_token",
        fileType: "bitable",
        tableId: "tbl_todo",
      },
      text: "@SuperMatrix 边界补充",
      threadReplies: [],
      bitableRecord: { recordId: "rec_1", fields: { "Todo owner alias": "tobedone" } },
    };

    await expect(resolveDriveCommentMentionRoute(request, registry)).resolves.toMatchObject({
      kind: "registered",
      route: { target: "tobedone", matchedRule: "registry:todo-comments:agent-todo-comment" },
    });

    await expect(resolveDriveCommentMentionRoute({
      ...request,
      source: { ...request.source, tableId: "tbl_other" },
    }, registry)).resolves.toMatchObject({
      kind: "standard",
      route: { matchedRule: "fallback:self" },
    });

    await expect(resolveDriveCommentMentionRoute({
      ...request,
      bitableRecord: { recordId: "rec_1", fields: { "Todo owner alias": "" } },
    }, registry)).resolves.toMatchObject({
      kind: "standard",
      route: { matchedRule: "fallback:self" },
    });
  });

  test("matches the production source/table/record fixture before dataquery", async () => {
    const registry = {
      async load() {
        return {
          version: 1 as const,
          routes: [{
            id: "todolist-agent-todo-comments",
            ownerSession: "tobedone",
            source: {
              fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
              fileType: "bitable" as const,
              tableId: "tblREDACTEDTABLEID",
            },
            triggers: [{
              id: "agent-todo-record-comment",
              priority: 100,
              match: {
                all: ["\"Todo owner alias\":\""],
                none: ["\"Todo owner alias\":\"\""],
              },
              recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
              sopRef: "sop/mention/todolist-agent-todo-comment.md",
            }],
          }],
        };
      },
      async loadSop() {
        return { name: "todolist-agent-todo-comment", targetSession: "tobedone", body: "合并当前 todo 评论" };
      },
    };
    const request: DriveCommentMentionRequest = {
      source: {
        ...req("ignored").source,
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSCvk4eUxc",
      },
      text: "经营表 fba可售 0可售asin 父ASIN日表/汇总表",
      threadReplies: [],
      bitableRecord: {
        recordId: "recvrSCvk4eUxc",
        fields: {
          "序号": 419,
          "Todo owner alias": "product-tracker",
          "内容": "父ASIN日表/汇总表",
          "交付/进展": "待处理",
        },
      },
    };

    await expect(resolveDriveCommentMentionRoute(request, registry)).resolves.toMatchObject({
      kind: "registered",
      route: { target: "tobedone", matchedRule: "registry:todolist-agent-todo-comments:agent-todo-record-comment" },
    });
  });

  test("keeps registry routes without record conditions compatible with missing Bitable context", async () => {
    const request: DriveCommentMentionRequest = {
      source: {
        ...req("ignored").source,
        fileToken: "base_token",
        fileType: "bitable",
      },
      text: "@SuperMatrix 更新状态，并记录反馈",
      threadReplies: [],
    };
    const registry = {
      async load() {
        return {
          version: 1 as const,
          routes: [{
            id: "growth-diagnosis",
            ownerSession: "amzdata",
            source: { fileToken: "base_token", fileType: "bitable" as const },
            triggers: [
              { id: "update-status", priority: 100, match: { any: ["更新状态"] }, sopRef: "sop/update-status.md" },
              { id: "record-feedback", priority: 100, match: { any: ["记录反馈"] }, sopRef: "sop/record-feedback.md" },
            ],
          }],
        };
      },
      async loadSop() {
        throw new Error("should not load an ambiguous SOP");
      },
    };

    await expect(resolveDriveCommentMentionRoute(request, registry)).resolves.toMatchObject({
      kind: "ambiguous",
      route: { target: "pinglunmaster", matchedRule: "registry:ambiguous" },
    });
  });
});

describe("buildDriveCommentTargetPrompt", () => {
  test("includes source, text, quote, and reply contract", () => {
    const prompt = buildDriveCommentTargetPrompt(req("帮我记一下这个风险"), {
      target: "todomaster",
      reason: "matched todo keyword: 记一下",
      matchedRule: "intent:todo",
    });

    expect(prompt).toContain("[Drive comment mention]");
    expect(prompt).toContain("file_token: doc_token");
    expect(prompt).toContain("[Comment text]");
    expect(prompt).toContain("帮我记一下这个风险");
    expect(prompt).toContain("[Quoted context]");
    expect(prompt).toContain("被评论的正文片段");
    expect(prompt).toContain("[Reply contract]");
    expect(prompt).toContain("Return a concise answer suitable for posting back as a Feishu comment reply.");
  });

  test("includes the target record URL and prior comment thread for child sessions", () => {
    const request: DriveCommentMentionRequest = {
      source: {
        kind: "drive_comment",
        eventId: "evt_1",
        fileToken: "base_token",
        fileType: "bitable",
        commentId: "comment_1",
        replyId: "reply_2",
        fromUserId: "ou_user",
        url: "https://jxs9pwkdvwn.feishu.cn/record/SMh9rOMSuewguhcVbtrcSjFknlf",
      },
      text: "@SuperMatrix 查一下这条记录",
      quote: "记录 7",
      threadReplies: [
        "@SuperMatrix 前一条问题",
        "上一轮回复内容",
      ],
    };

    const prompt = buildDriveCommentTargetPrompt(request, {
      target: "dataquery",
      reason: "matched data query intent keyword",
      matchedRule: "intent:dataquery",
    });

    expect(prompt).toContain("[Target resource]");
    expect(prompt).toContain("target_kind: bitable_record");
    expect(prompt).toContain(
      "target_url: https://jxs9pwkdvwn.feishu.cn/record/SMh9rOMSuewguhcVbtrcSjFknlf",
    );
    expect(prompt).toContain("[Prior comment thread]");
    expect(prompt).toContain("@SuperMatrix 前一条问题\n---\n上一轮回复内容");
  });

  test("includes the source and complete current record in the target prompt", () => {
    const request: DriveCommentMentionRequest = {
      source: {
        ...req("ignored").source,
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        tableId: "tblREDACTEDTABLEID",
        recordId: "recvrSCvk4eUxc",
      },
      text: "经营表 fba可售 0可售asin 父ASIN日表/汇总表",
      threadReplies: [],
      bitableRecord: {
        recordId: "recvrSCvk4eUxc",
        fields: { "序号": 419, "Todo owner alias": "product-tracker", "内容": "父ASIN日表/汇总表" },
      },
    };
    const prompt = buildDriveCommentTargetPrompt(request, {
      target: "tobedone",
      matchedRule: "registry:todolist-agent-todo-comments:agent-todo-record-comment",
      reason: "registered source",
    });
    expect(prompt).toContain("table_id: tblREDACTEDTABLEID");
    expect(prompt).toContain("source_record_id: recvrSCvk4eUxc");
    expect(prompt).toContain("record_id: recvrSCvk4eUxc");
    expect(prompt).toContain("\"Todo owner alias\": \"product-tracker\"");
    expect(prompt).toContain("\"序号\": 419");
  });
});

function session(id: string, name: string): Session {
  return {
    id: asSessionId(id),
    name,
    alias: "",
    avatar: "",
    category: "平台",
    fpManaged: null,
    scope: "user",
    backend: "codex",
    model: "gpt-5.4",
    effort: null,
    thinking: false,
    modelLocked: false,
    workdir: asAbsolutePath(`/tmp/${name}`),
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
    createdAt: asTimestamp(1),
    updatedAt: asTimestamp(1),
  };
}

describe("createDriveCommentMentionProcessor", () => {
  test("does not dispatch or send a success-shaped reply when Bitable context is missing", async () => {
    const caller = session("sess_pinglun", "pinglunmaster");
    const replies: unknown[] = [];
    const spawns: unknown[] = [];
    const finishes: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const claims: unknown[] = [];
    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) { return name === "pinglunmaster" ? caller : null; },
        async claimDriveCommentMention(input: unknown) { claims.push(input); return true; },
        async finishDriveCommentMention(input: unknown) { finishes.push(input); },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) { responseLogFinishes.push(input); },
      },
      lark: {
        async getDriveCommentContext() { return { text: "经营表 fba可售 0可售asin", threadReplies: [] }; },
        async replyToDriveComment(input: unknown) { replies.push(input); },
        async createDriveComment() { throw new Error("should not fallback"); },
      },
      childSession: {
        async spawnChild(input: unknown) { spawns.push(input); throw new Error("must not spawn"); },
      },
    });

    await processor.handle({
      ...req("ignored").source,
      eventId: "evt_prod_bitable_comment_7673408506963233765",
      fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
      fileType: "bitable",
      tableId: "tblREDACTEDTABLEID",
      recordId: "recvrSCvk4eUxc",
      commentId: "7673408506963233765",
      replyId: "7673408506980043721",
    });

    expect(spawns).toEqual([]);
    expect(claims[0]).toMatchObject({
      targetSession: "pinglunmaster",
      matchedRule: "safety:missing-bitable-context",
    });
    expect((replies[0] as { text: string }).text).toContain("未能安全确认当前 Bitable 记录上下文");
    expect((replies[0] as { text: string }).text).toContain("未派发 dataquery");
    expect((replies[0] as { text: string }).text).not.toContain("收到");
    expect((replies[0] as { text: string }).text).not.toContain("按此口径处理");
    expect(responseLogFinishes[0]).toMatchObject({ responseStatus: "skipped" });
    expect(finishes[0]).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("missing Bitable context") });
  });

  test("uses a registered source trigger and SOP before the standard flow", async () => {
    const amzdata = session("sess_amzdata", "amzdata");
    const caller = session("sess_pinglun", "pinglunmaster");
    const claims: unknown[] = [];
    const spawns: unknown[] = [];
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1,
            routes: [
              {
                id: "growth-diagnosis",
                enabled: true,
                ownerSession: "amzdata",
                source: {
                  fileToken: "base_token",
                  fileType: "bitable",
                  tableId: "tbl_growth",
                },
                triggers: [
                  {
                    id: "update-status",
                    priority: 100,
                    match: { all: ["更新状态"] },
                    sopRef: "sop/mention/update-growth-status.md",
                  },
                ],
              },
            ],
          };
        },
        async loadSop(sopRef: string) {
          expect(sopRef).toBe("sop/mention/update-growth-status.md");
          return {
            name: "update-growth-status",
            targetSession: "amzdata",
            replyTemplate: "状态更新完成：{{result}}",
            body: "把评论、目标记录链接、历史评论和关键信息投递给增长天王，并要求他更新诊断状态。",
          };
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "amzdata" ? amzdata : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention(input: unknown) {
          claims.push(input);
          return true;
        },
        async finishDriveCommentMention() {},
        async recordResponseLog() {},
        async finishResponseLog() {},
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 更新状态：已完成",
            quote: "诊断结果记录",
            threadReplies: ["前面已经确认库存正常"],
            bitableRecord: {
              recordId: "rec_1",
              fields: { ASIN: "B001", Status: "处理中" },
            },
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          return {
            session: amzdata,
            finalMessage: "增长天王已更新",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_1"),
          };
        },
      },
    });

    const source = {
      ...req("ignored").source,
      fileToken: "base_token",
      fileType: "bitable" as const,
      tableId: "tbl_growth",
      recordId: "rec_1",
      url: "https://jxs9pwkdvwn.feishu.cn/record/rec_1",
    };
    await processor.handle(source);

    expect(claims[0]).toMatchObject({
      targetSession: "amzdata",
      matchedRule: "registry:growth-diagnosis:update-status",
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      parentId: amzdata.id,
      clientRequestId: buildDriveCommentMentionDedupeKey(source),
    });
    const prompt = (spawns[0] as { prompt: string }).prompt;
    expect(prompt).toContain("[Mention registry SOP]");
    expect(prompt).toContain("registry_entry: growth-diagnosis");
    expect(prompt).toContain("trigger_id: update-status");
    expect(prompt).toContain("sop_ref: sop/mention/update-growth-status.md");
    expect(prompt).toContain("target_url: https://jxs9pwkdvwn.feishu.cn/record/rec_1");
    expect(prompt).toContain("前面已经确认库存正常");
    expect(prompt).toContain("把评论、目标记录链接、历史评论和关键信息投递给增长天王");
    expect(replies).toEqual([{ source, text: "状态更新完成：增长天王已更新" }]);
  });

  test("routes tobedone when the loader recovers table and record identity", async () => {
    const tobedone = session("sess_tobedone", "tobedone");
    const caller = session("sess_pinglun", "pinglunmaster");
    const claims: unknown[] = [];
    const spawns: unknown[] = [];
    const replies: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1 as const,
            routes: [{
              id: "todolist-agent-todo-comments",
              enabled: true,
              ownerSession: "tobedone",
              delivery: { type: "session", sessionName: "tobedone" },
              source: {
                fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
                fileType: "bitable" as const,
                tableId: "tblREDACTEDTABLEID",
              },
              triggers: [{
                id: "agent-todo-record-comment",
                priority: 100,
                match: { all: ["\"Todo owner alias\":\""] },
                recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
                sopRef: "sop/mention/todolist-agent-todo-comment.md",
              }],
            }],
          };
        },
        async loadSop() {
          return {
            name: "todolist-agent-todo-comment",
            targetSession: "tobedone",
            replyTemplate: "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执",
            body: "合并当前 todo 评论",
          };
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "tobedone" ? tobedone : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention(input: unknown) {
          claims.push(input);
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
        async listResultSinkAttemptsBySpawn(spawnCommId: string) {
          expect(spawnCommId).toBe("comm_todo_route");
          return [{
            id: "sink_comm_todo_route_0",
            spawnCommId,
            childSessionId: tobedone.id,
            messageRunId: asMessageRunId("mr_todo_route"),
            sinkIndex: 0,
            sinkKind: "parent_continuation_inject",
            status: "delivered" as const,
            note: null,
            errorMessage: null,
            createdAt: asTimestamp(10_000),
          }];
        },
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 请继续跟进 416",
            threadReplies: ["上一轮评论上下文"],
            bitableRecord: {
              tableId: "tblREDACTEDTABLEID",
              recordId: "recvrSqY2qbks1",
              fields: { "序号": 416, "Todo owner alias": "product-tracker" },
            },
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          return {
            session: tobedone,
            finalMessage: "已吸收评论",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_todo_route"),
            spawnCommId: "comm_todo_route",
          };
        },
      },
    });

    await processor.handle({
      ...req("ignored").source,
      fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
      fileType: "bitable",
      commentId: "7673460608817253339",
      replyId: "7673460608838208480",
      fromUserId: "ou_REDACTEDOPENID",
    });

    expect(claims[0]).toMatchObject({
      targetSession: "tobedone",
      matchedRule: "registry:todolist-agent-todo-comments:agent-todo-record-comment",
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      parentId: tobedone.id,
      callerInvocation: "sync_inline",
      resultSinks: [{ kind: "parent_continuation_inject", parentSessionId: tobedone.id }],
    });
    expect(replies).toEqual([]);
    expect(responseLogFinishes).toEqual([{
      responseId: buildDriveCommentResponseLogId({
        ...req("ignored").source,
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        commentId: "7673460608817253339",
        replyId: "7673460608838208480",
        fromUserId: "ou_REDACTEDOPENID",
      }, asTimestamp(10_000)),
      responseStatus: "skipped",
      responseText: "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执",
      responseAt: asTimestamp(10_000),
      now: asTimestamp(10_000),
    }]);
    expect(finishes).toEqual([{
      dedupeKey: buildDriveCommentMentionDedupeKey({
        ...req("ignored").source,
        fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
        fileType: "bitable",
        commentId: "7673460608817253339",
        replyId: "7673460608838208480",
        fromUserId: "ou_REDACTEDOPENID",
      }),
      status: "completed",
      resultText: "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执",
      now: asTimestamp(10_000),
    }]);
    const prompt = (spawns[0] as { prompt: string }).prompt;
    expect(prompt).toContain("table_id: tblREDACTEDTABLEID");
    expect(prompt).toContain("source_record_id: recvrSqY2qbks1");
    expect(prompt).toContain("record_id: recvrSqY2qbks1");
    expect(prompt).toContain('"序号": 416');
    expect(prompt).toContain("@SuperMatrix 请继续跟进 416");
    expect(prompt).toContain("from_user_id: ou_REDACTEDOPENID");
    expect(prompt).toContain("上一轮评论上下文");
  });

  test("replies with the fixed SOP ack when registered session delivery is queued", async () => {
    const tobedone = session("sess_tobedone", "tobedone");
    const caller = session("sess_pinglun", "pinglunmaster");
    const source = {
      ...req("ignored").source,
      fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
      fileType: "bitable" as const,
      tableId: "tblREDACTEDTABLEID",
      commentId: "comment_queued",
      replyId: "reply_queued",
    };
    const ack = "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执";
    const spawns: unknown[] = [];
    const replies: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];
    const consumed: unknown[] = [];
    let sinkAttempts: ResultSinkAttempt[] = [];
    const mention = {
      ...mentionRecord(source),
      matchedRule: "registry:todolist-agent-todo-comments:agent-todo-record-comment",
    };

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1 as const,
            routes: [{
              id: "todolist-agent-todo-comments",
              enabled: true,
              ownerSession: "tobedone",
              delivery: { type: "session" as const, sessionName: "tobedone" },
              source: {
                fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
                fileType: "bitable" as const,
                tableId: "tblREDACTEDTABLEID",
              },
              triggers: [{
                id: "agent-todo-record-comment",
                priority: 100,
                match: { all: ["\"Todo owner alias\":\""] },
                recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
                sopRef: "sop/mention/todolist-agent-todo-comment.md",
              }],
            }],
          };
        },
        async loadSop() {
          return {
            name: "todolist-agent-todo-comment",
            targetSession: "tobedone",
            replyTemplate: ack,
            body: "合并当前 todo 评论",
          };
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "tobedone" ? tobedone : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async findDriveCommentMention() {
          return mention;
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
        async listResultSinkAttemptsBySpawn(_spawnCommId: string): Promise<ResultSinkAttempt[]> {
          return sinkAttempts;
        },
        async listSpawnAsyncItemsByCallerSession() {
          return [queuedAsyncItem({
            commId: "comm_todo_ack",
            finalMessage: "child final must not be posted",
          }, mention.dedupeKey)];
        },
        async closeSpawnAsyncItemConsumed(ref: string, reason: string, now: number) {
          consumed.push({ ref, reason, now });
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 补充这条 todo 的边界",
            threadReplies: [],
            bitableRecord: {
              tableId: "tblREDACTEDTABLEID",
              recordId: "record_queued",
              fields: { "Todo owner alias": "tobedone" },
            },
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          return {
            status: "queued" as const,
            ref: "spawnq_todo_ack",
            commId: "comm_todo_ack",
            spawnCommId: "comm_todo_ack",
            parentId: tobedone.id,
            queuedAt: asTimestamp(10_000),
            ttlSec: 3600,
          };
        },
      },
    });

    await processor.handle(source);

    expect(spawns[0]).toMatchObject({
      resultSinks: [{ kind: "parent_continuation_inject", parentSessionId: tobedone.id }],
    });
    expect(replies).toEqual([]);
    expect(responseLogFinishes).toEqual([]);
    expect(finishes).toEqual([]);

    sinkAttempts = [{
      id: "sink_comm_todo_ack_0",
      spawnCommId: "comm_todo_ack",
      childSessionId: tobedone.id,
      messageRunId: asMessageRunId("mr_todo_ack"),
      sinkIndex: 0,
      sinkKind: "parent_continuation_inject",
      status: "delivered" as const,
      note: null,
      errorMessage: null,
      createdAt: asTimestamp(20_000),
    }];

    await expect(processor.sweepQueuedMentions()).resolves.toBe(1);
    expect(replies).toEqual([]);
    expect(consumed).toEqual([{
      ref: "spawnq_1",
      reason: "drive comment session delivery completed",
      now: asTimestamp(10_000),
    }]);
    expect(responseLogFinishes).toEqual([{
      responseId: buildDriveCommentResponseLogId(source, asTimestamp(10_000)),
      responseStatus: "skipped",
      responseText: ack,
      responseAt: asTimestamp(10_000),
      now: asTimestamp(10_000),
    }]);
    expect(finishes).toEqual([{
      dedupeKey: mention.dedupeKey,
      status: "completed",
      resultText: ack,
      now: asTimestamp(10_000),
    }]);
  });

  test("does not complete a registered route when sync continuation delivery failed", async () => {
    const tobedone = session("sess_tobedone", "tobedone");
    const caller = session("sess_pinglun", "pinglunmaster");
    const source = {
      ...req("ignored").source,
      fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
      fileType: "bitable" as const,
      tableId: "tblREDACTEDTABLEID",
      commentId: "comment_sync_failed",
      replyId: "reply_sync_failed",
    };
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1 as const,
            routes: [{
              id: "todolist-agent-todo-comments",
              enabled: true,
              ownerSession: "tobedone",
              delivery: { type: "session" as const, sessionName: "tobedone" },
              source: {
                fileToken: source.fileToken,
                fileType: "bitable" as const,
                tableId: source.tableId,
              },
              triggers: [{
                id: "agent-todo-record-comment",
                priority: 100,
                match: { all: ["\"Todo owner alias\":\""] },
                recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
                sopRef: "sop/mention/todolist-agent-todo-comment.md",
              }],
            }],
          };
        },
        async loadSop() {
          return {
            name: "todolist-agent-todo-comments",
            targetSession: "tobedone",
            replyTemplate: "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执",
            body: "合并当前 todo 评论",
          };
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "tobedone" ? tobedone : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
        async listResultSinkAttemptsBySpawn(spawnCommId: string) {
          expect(spawnCommId).toBe("comm_sync_failed");
          return [{
            id: "sink_comm_sync_failed_0",
            spawnCommId,
            childSessionId: tobedone.id,
            messageRunId: asMessageRunId("mr_sync_failed"),
            sinkIndex: 0,
            sinkKind: "parent_continuation_inject",
            status: "failed" as const,
            note: "delivery failed",
            errorMessage: "parent busy",
            createdAt: asTimestamp(10_000),
          }];
        },
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 补充这条 todo",
            threadReplies: [],
            bitableRecord: {
              tableId: source.tableId,
              recordId: "record_sync_failed",
              fields: { "Todo owner alias": "tobedone" },
            },
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          return {
            session: tobedone,
            finalMessage: "child final must not be posted",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_sync_failed"),
            spawnCommId: "comm_sync_failed",
          };
        },
      },
    });

    await processor.handle(source);

    expect(replies).toEqual([]);
    expect(responseLogFinishes).toEqual([{
      responseId: buildDriveCommentResponseLogId(source, asTimestamp(10_000)),
      responseStatus: "failed",
      responseText: "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执",
      responseAt: asTimestamp(10_000),
      responseError: "parent busy",
      now: asTimestamp(10_000),
    }]);
    expect(finishes).toEqual([{
      dedupeKey: buildDriveCommentMentionDedupeKey(source),
      status: "failed",
      errorMessage: "parent busy",
      now: asTimestamp(10_000),
    }]);
  });

  test("replies with an ambiguity message when same-priority registry triggers match", async () => {
    const caller = session("sess_pinglun", "pinglunmaster");
    const spawns: unknown[] = [];
    const replies: unknown[] = [];
    const finishes: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1,
            routes: [
              {
                id: "growth-diagnosis",
                enabled: true,
                ownerSession: "amzdata",
                source: { fileToken: "base_token", fileType: "bitable" },
                triggers: [
                  {
                    id: "update-status",
                    priority: 100,
                    match: { any: ["更新状态"] },
                    sopRef: "sop/mention/update-growth-status.md",
                  },
                  {
                    id: "record-feedback",
                    priority: 100,
                    match: { any: ["记录反馈"] },
                    sopRef: "sop/mention/record-growth-feedback.md",
                  },
                ],
              },
            ],
          };
        },
        async loadSop() {
          throw new Error("should not load an ambiguous SOP");
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog() {},
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 更新状态，并记录反馈",
            threadReplies: [],
            bitableRecord: {
              recordId: "rec_1",
              fields: { "Todo owner alias": "amzdata" },
            },
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          throw new Error("should not spawn ambiguous trigger");
        },
      },
    });

    const source = {
      ...req("ignored").source,
      fileToken: "base_token",
      fileType: "bitable" as const,
      tableId: "tbl_growth",
      recordId: "rec_1",
    };
    await processor.handle(source);

    expect(spawns).toEqual([]);
    expect((replies[0] as { text: string }).text).toContain("命中多个处理方式");
    expect((replies[0] as { text: string }).text).toContain("update-status");
    expect((replies[0] as { text: string }).text).toContain("record-feedback");
    expect(finishes[0]).toMatchObject({
      dedupeKey: buildDriveCommentMentionDedupeKey(source),
      status: "completed",
    });
  });

  test("uses the standard flow when a registry exists but the source is not registered", async () => {
    const todomaster = session("sess_todo", "todomaster");
    const caller = session("sess_pinglun", "pinglunmaster");
    const claims: unknown[] = [];
    const spawns: unknown[] = [];
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: {
        async load() {
          return {
            version: 1,
            routes: [
              {
                id: "registered-source",
                enabled: true,
                ownerSession: "amzdata",
                source: { fileToken: "another_token", fileType: "bitable" },
                triggers: [
                  {
                    id: "update-status",
                    priority: 100,
                    match: { any: ["更新状态"] },
                    sopRef: "sop/mention/update-growth-status.md",
                  },
                ],
              },
            ],
          };
        },
        async loadSop() {
          throw new Error("should not load SOP for an unregistered source");
        },
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "todomaster" ? todomaster : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention(input: unknown) {
          claims.push(input);
          return true;
        },
        async finishDriveCommentMention() {},
        async recordResponseLog() {},
        async finishResponseLog() {},
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "@SuperMatrix 帮我记一个待办",
            threadReplies: [],
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          return {
            session: todomaster,
            finalMessage: "已记录",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_1"),
          };
        },
      },
    });

    const source = {
      ...req("ignored").source,
      fileToken: "doc_token",
      fileType: "docx" as const,
    };
    await processor.handle(source);

    expect(claims[0]).toMatchObject({
      targetSession: "todomaster",
      matchedRule: "intent:todo",
    });
    expect(spawns).toHaveLength(1);
    expect((spawns[0] as { prompt: string }).prompt).toContain("[Drive comment mention]");
    expect((spawns[0] as { prompt: string }).prompt).not.toContain("[Mention registry SOP]");
    expect(replies).toEqual([{ source, text: "已记录" }]);
  });

  test("claims, spawns the routed target, and replies inline with the child result", async () => {
    const todomaster = session("sess_todo", "todomaster");
    const caller = session("sess_pinglun", "pinglunmaster");
    const claims: unknown[] = [];
    const finishes: unknown[] = [];
    const responseLogs: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const spawns: unknown[] = [];
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "todomaster" ? todomaster : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention(input: unknown) {
          claims.push(input);
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog(input: unknown) {
          responseLogs.push(input);
        },
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "帮我记一个待办，下周跟进这个供应商",
            quote: "被评论的正文片段",
            threadReplies: ["之前的评论"],
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild(input: unknown) {
          spawns.push(input);
          return {
            session: todomaster,
            finalMessage: "已记录",
            backendSessionId: null,
            messageRunId: asMessageRunId("mr_1"),
          };
        },
      },
    });

    const source = req("ignored").source;
    await processor.handle(source);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      dedupeKey: buildDriveCommentMentionDedupeKey(source),
      targetSession: "todomaster",
      matchedRule: "intent:todo",
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      parentId: todomaster.id,
      backend: "codex",
      model: "gpt-5.4",
      workdir: todomaster.workdir,
      type: "one_shot_delegation",
      requestedBy: caller.id,
      triggerKind: "eventbus_subscriber",
      callerInvocation: "sync_inline",
      resultSinks: [{ kind: "http_response" }],
      senderId: "ou_user",
      clientRequestId: buildDriveCommentMentionDedupeKey(source),
    });
    expect((spawns[0] as { prompt: string }).prompt).toContain("被评论的正文片段");
    expect((spawns[0] as { prompt: string }).prompt).toContain("target_url: https://www.feishu.cn/docx/doc_token");
    expect((spawns[0] as { prompt: string }).prompt).toContain("[Prior comment thread]");
    expect((spawns[0] as { prompt: string }).prompt).toContain("之前的评论");
    expect(replies).toEqual([{ source, text: "已记录" }]);
    expect(responseLogs).toHaveLength(1);
    expect(responseLogs[0]).toMatchObject({
      responseId: expect.stringMatching(/^pm-doc_comment-[a-f0-9]{8}-10$/),
      source: "doc_comment",
      sourceRef: "docx:doc_token:comment_1:root",
      sourceUrl: "https://www.feishu.cn/docx/doc_token",
      mentioner: "ou_user",
      mentionedAt: asTimestamp(10_000),
      triggerText: "帮我记一个待办，下周跟进这个供应商",
      createdAt: asTimestamp(10_000),
    });
    expect(responseLogFinishes).toEqual([
      {
        responseId: (responseLogs[0] as { responseId: string }).responseId,
        responseStatus: "sent",
        responseText: "已记录",
        responseAt: asTimestamp(10_000),
        now: asTimestamp(10_000),
      },
    ]);
    expect(finishes).toEqual([
      {
        dedupeKey: buildDriveCommentMentionDedupeKey(source),
        status: "completed",
        resultText: "已记录",
        now: asTimestamp(10_000),
      },
    ]);
  });

  test("skips spawn and reply when the mention was already claimed", async () => {
    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention() {},
        async recordResponseLog() {
          throw new Error("should not log duplicate");
        },
        async finishResponseLog() {
          throw new Error("should not finish duplicate log");
        },
      },
      lark: {
        async getDriveCommentContext() {
          return { text: "帮我记一个待办", threadReplies: [] };
        },
        async replyToDriveComment() {
          throw new Error("should not reply duplicate");
        },
        async createDriveComment() {
          throw new Error("should not fallback duplicate");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("should not spawn duplicate");
        },
      },
    });

    await processor.handle(req("ignored").source);
  });

  test("logs a failed response when delegated handling fails", async () => {
    const todomaster = session("sess_todo", "todomaster");
    const caller = session("sess_pinglun", "pinglunmaster");
    const responseLogs: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "todomaster" ? todomaster : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention() {},
        async recordResponseLog(input: unknown) {
          responseLogs.push(input);
        },
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
      },
      lark: {
        async getDriveCommentContext() {
          return {
            text: "帮我记一个待办",
            quote: "被评论的正文片段",
            threadReplies: [],
          };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("boom");
        },
      },
    });

    const source = req("ignored").source;
    await processor.handle(source);

    expect(responseLogs).toHaveLength(1);
    expect(replies).toEqual([{ source, text: "处理失败：boom" }]);
    expect(responseLogFinishes).toEqual([
      {
        responseId: (responseLogs[0] as { responseId: string }).responseId,
        responseStatus: "failed",
        responseText: "处理失败：boom",
        responseAt: asTimestamp(20_000),
        responseError: "boom",
        now: asTimestamp(20_000),
      },
    ]);
  });
});

describe("createDriveCommentMentionProcessor queued spawn handling", () => {
  test("queued spawn is async delivery: no failure reply, mention stays processing", async () => {
    const todomaster = session("sess_todo", "todomaster");
    const caller = session("sess_pinglun", "pinglunmaster");
    const claims: unknown[] = [];
    const replies: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          return name === "todomaster" ? todomaster : name === "pinglunmaster" ? caller : null;
        },
        async claimDriveCommentMention(input: unknown) {
          claims.push(input);
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
      },
      lark: {
        async getDriveCommentContext() {
          return { text: "帮我记一个待办", threadReplies: [] };
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          return {
            status: "queued" as const,
            ref: "spawnq_1",
            commId: "comm_1",
            spawnCommId: "comm_1",
            parentId: todomaster.id,
            queuedAt: asTimestamp(10_000),
            ttlSec: 3600,
          };
        },
      },
    });

    const source = req("ignored").source;
    await processor.handle(source);

    expect(claims).toHaveLength(1);
    expect(replies).toEqual([]);
    expect(responseLogFinishes).toEqual([]);
    expect(finishes).toEqual([]);
  });

  test("sweep writes the queued child final message back to the thread and settles logs", async () => {
    const source = req("ignored").source;
    const dedupeKey = buildDriveCommentMentionDedupeKey(source);
    const mentions = [mentionRecord(source)];
    const consumed: unknown[] = [];
    const replies: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async findDriveCommentMention(key: string) {
          return mentions.find((m) => m.dedupeKey === key) ?? null;
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
        async listSpawnAsyncItemsByCallerSession() {
          return [queuedAsyncItem({ finalMessage: "送达确认：canary-fcdf55e 已收到" }, dedupeKey)];
        },
        async closeSpawnAsyncItemConsumed(ref: string, reason: string, now: number) {
          consumed.push({ ref, reason, now });
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          throw new Error("sweep must not read comment context");
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("sweep must not spawn");
        },
      },
    });

    expect(await processor.sweepQueuedMentions()).toBe(1);
    expect(replies).toEqual([{ source, text: "送达确认：canary-fcdf55e 已收到" }]);
    expect(consumed).toEqual([
      { ref: "spawnq_1", reason: "drive comment reply delivered", now: asTimestamp(20_000) },
    ]);
    expect(responseLogFinishes).toEqual([
      {
        responseId: buildDriveCommentResponseLogId(source, asTimestamp(10_000)),
        responseStatus: "sent",
        responseText: "送达确认：canary-fcdf55e 已收到",
        responseAt: asTimestamp(20_000),
        now: asTimestamp(20_000),
      },
    ]);
    expect(finishes).toEqual([
      {
        dedupeKey,
        status: "completed",
        resultText: "送达确认：canary-fcdf55e 已收到",
        now: asTimestamp(20_000),
      },
    ]);
  });

  test("sweep is idempotent: settled mentions are not replied to twice", async () => {
    const source = req("ignored").source;
    const dedupeKey = buildDriveCommentMentionDedupeKey(source);
    let mention = mentionRecord(source);
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention() {
          mention = { ...mention, status: "completed", resultText: "送达确认：canary-fcdf55e 已收到" };
        },
        async findDriveCommentMention() {
          return mention;
        },
        async recordResponseLog() {},
        async finishResponseLog() {},
        async listSpawnAsyncItemsByCallerSession() {
          return [queuedAsyncItem({}, dedupeKey)];
        },
        async closeSpawnAsyncItemConsumed() {
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          throw new Error("sweep must not read comment context");
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("sweep must not spawn");
        },
      },
    });

    expect(await processor.sweepQueuedMentions()).toBe(1);
    expect(await processor.sweepQueuedMentions()).toBe(0);
    expect(replies).toHaveLength(1);
  });

  test("sweep never replies to items this processor already consumed", async () => {
    const source = req("ignored").source;
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention() {
          throw new Error("must not settle an already-consumed item");
        },
        async findDriveCommentMention() {
          return mentionRecord(source);
        },
        async recordResponseLog() {},
        async finishResponseLog() {
          throw new Error("must not settle an already-consumed item");
        },
        async listSpawnAsyncItemsByCallerSession() {
          return [queuedAsyncItem({ status: "closed", verdict: "caller_consumed" })];
        },
        async closeSpawnAsyncItemConsumed() {
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          throw new Error("sweep must not read comment context");
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("sweep must not spawn");
        },
      },
    });

    expect(await processor.sweepQueuedMentions()).toBe(0);
    expect(replies).toEqual([]);
  });

  test("sweep skips items whose comm is still pending", async () => {
    const source = req("ignored").source;
    const replies: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention() {
          throw new Error("must not settle a pending comm");
        },
        async findDriveCommentMention() {
          return mentionRecord(source);
        },
        async recordResponseLog() {},
        async finishResponseLog() {
          throw new Error("must not settle a pending comm");
        },
        async listSpawnAsyncItemsByCallerSession() {
          return [queuedAsyncItem({ commStatus: "pending", finalMessage: null })];
        },
        async closeSpawnAsyncItemConsumed() {
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          throw new Error("sweep must not read comment context");
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("sweep must not spawn");
        },
      },
    });

    expect(await processor.sweepQueuedMentions()).toBe(0);
    expect(replies).toEqual([]);
  });

  test("sweep marks mention failed when the queued comm failed", async () => {
    const source = req("ignored").source;
    const dedupeKey = buildDriveCommentMentionDedupeKey(source);
    const replies: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const finishes: unknown[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(20_000) },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return session("sess_todo", "todomaster");
        },
        async claimDriveCommentMention() {
          return false;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async findDriveCommentMention() {
          return mentionRecord(source);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
        async listSpawnAsyncItemsByCallerSession() {
          return [
            queuedAsyncItem({
              commStatus: "failed",
              finalMessage: null,
              errorMessage: "spawn queue item spawnq_1 expired after 3600s before dispatch",
            }, dedupeKey),
          ];
        },
        async closeSpawnAsyncItemConsumed() {
          return true;
        },
      },
      lark: {
        async getDriveCommentContext() {
          throw new Error("sweep must not read comment context");
        },
        async replyToDriveComment(input: unknown) {
          replies.push(input);
        },
        async createDriveComment() {
          throw new Error("should not fallback");
        },
      },
      childSession: {
        async spawnChild() {
          throw new Error("sweep must not spawn");
        },
      },
    });

    expect(await processor.sweepQueuedMentions()).toBe(1);
    expect(replies).toEqual([
      { source, text: "处理失败：spawn queue item spawnq_1 expired after 3600s before dispatch" },
    ]);
    expect(responseLogFinishes).toEqual([
      {
        responseId: buildDriveCommentResponseLogId(source, asTimestamp(10_000)),
        responseStatus: "failed",
        responseText: "处理失败：spawn queue item spawnq_1 expired after 3600s before dispatch",
        responseAt: asTimestamp(20_000),
        responseError: "spawn queue item spawnq_1 expired after 3600s before dispatch",
        now: asTimestamp(20_000),
      },
    ]);
    expect(finishes).toEqual([
      {
        dedupeKey,
        status: "failed",
        errorMessage: "spawn queue item spawnq_1 expired after 3600s before dispatch",
        now: asTimestamp(20_000),
      },
    ]);
  });
});

describe("expandDriveCommentScriptArgv", () => {
  test("substitutes only the controlled event identity placeholders", () => {
    expect(expandDriveCommentScriptArgv({
      argv: ["python3", "scripts/pipeline/comment_intake.py", "--comment-id", "{{comment_id}}", "--record-id", "{{record_id}}"],
      commentId: "comment_1",
      recordId: "rec_1",
    })).toEqual([
      "python3",
      "scripts/pipeline/comment_intake.py",
      "--comment-id",
      "comment_1",
      "--record-id",
      "rec_1",
    ]);
  });

  test("rejects any placeholder that would carry free comment text", () => {
    expect(() => expandDriveCommentScriptArgv({
      argv: ["python3", "intake.py", "--text", "{{comment_text}}"],
      commentId: "comment_1",
    })).toThrow(/unknown placeholder/u);
  });
});

describe("dispatchDriveCommentScript", () => {
  test("timeout_ms bounds start confirmation only; the child outlives it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drive-comment-script-"));
    try {
      const marker = join(dir, "done.txt");
      const code = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok"), 400)`;
      const receipt = await dispatchDriveCommentScript({
        argv: [process.execPath, "-e", code],
        cwd: dir,
        timeoutMs: 60,
        commentId: "comment_lifetime",
      });
      expect(receipt.pid).toBeGreaterThan(0);

      // Well past timeout_ms the child must still be running: dispatch_only
      // does not own (or cap) the lifetime of the work it started.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => process.kill(receipt.pid, 0)).not.toThrow();

      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(existsSync(marker)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a start failure surfaces as a dispatch failure instead of a receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drive-comment-script-"));
    try {
      await expect(dispatchDriveCommentScript({
        argv: [join(dir, "no-such-binary"), "--comment-id", "{{comment_id}}"],
        cwd: dir,
        timeoutMs: 2_000,
        commentId: "comment_missing",
      })).rejects.toThrow(/script delivery dispatch failed/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createDriveCommentMentionProcessor script delivery", () => {
  const ack = "已转交 tobedone 盘点流程处理，方案更新后会在本线程回执";

  function scriptDeliverySource() {
    return {
      ...req("ignored").source,
      fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
      fileType: "bitable" as const,
      tableId: "tblREDACTEDTABLEID",
      commentId: "comment_script",
      replyId: "reply_script",
    };
  }

  function scriptRegistry() {
    return {
      async load() {
        return {
          version: 1 as const,
          routes: [{
            id: "todolist-agent-todo-comments",
            enabled: true,
            ownerSession: "tobedone",
            delivery: {
              type: "script" as const,
              argv: [
                "python3",
                "scripts/pipeline/comment_intake.py",
                "--comment-id",
                "{{comment_id}}",
                "--record-id",
                "{{record_id}}",
              ],
              cwd: "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/tobedone",
              timeoutMs: 30_000,
            },
            source: {
              fileToken: "NFRabnLOJaldfVsWKbjcuR07nKe",
              fileType: "bitable" as const,
              tableId: "tblREDACTEDTABLEID",
            },
            triggers: [{
              id: "agent-todo-record-comment",
              priority: 100,
              match: { all: ["\"Todo owner alias\":\""] },
              recordFieldConditions: [{ field: "Todo owner alias", operator: "non_empty_string" as const }],
              sopRef: "sop/mention/todolist-agent-todo-comment.md",
            }],
          }],
        };
      },
      async loadSop() {
        return {
          name: "todolist-agent-todo-comment",
          targetSession: "tobedone",
          replyTemplate: ack,
          body: "合并当前 todo 评论",
        };
      },
    };
  }

  function scriptLark(replies: unknown[]) {
    return {
      async getDriveCommentContext() {
        return {
          text: "@SuperMatrix 补充这条 todo 的边界",
          threadReplies: [],
          bitableRecord: {
            tableId: "tblREDACTEDTABLEID",
            recordId: "record_script",
            fields: { "Todo owner alias": "tobedone" },
          },
        };
      },
      async replyToDriveComment(input: unknown) {
        replies.push(input);
      },
      async createDriveComment() {
        throw new Error("should not fallback");
      },
    };
  }

  test("dispatches the script, replies the fixed ack, and never wakes a session", async () => {
    const source = scriptDeliverySource();
    const replies: unknown[] = [];
    const finishes: unknown[] = [];
    const responseLogFinishes: unknown[] = [];
    const lookups: string[] = [];
    const dispatched: DriveCommentScriptDispatchInput[] = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: scriptRegistry(),
      scriptDispatcher: async (input) => {
        dispatched.push(input);
        return { pid: 4242 };
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName(name: string) {
          lookups.push(name);
          return null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention(input: unknown) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: unknown) {
          responseLogFinishes.push(input);
        },
      },
      lark: scriptLark(replies),
      childSession: {
        async spawnChild() {
          throw new Error("script delivery must not spawn a session");
        },
      },
    });

    await processor.handle(source);

    expect(dispatched).toEqual([{
      argv: [
        "python3",
        "scripts/pipeline/comment_intake.py",
        "--comment-id",
        "{{comment_id}}",
        "--record-id",
        "{{record_id}}",
      ],
      cwd: "/Users/LOCAL_USER/SuperMatrixRuntime/workspaces/tobedone",
      timeoutMs: 30_000,
      commentId: "comment_script",
      recordId: "record_script",
    }]);
    expect(lookups).toEqual([]);
    expect(replies).toEqual([{ source, text: ack }]);
    expect(responseLogFinishes).toEqual([{
      responseId: buildDriveCommentResponseLogId(source, asTimestamp(10_000)),
      responseStatus: "sent",
      responseText: ack,
      responseAt: asTimestamp(10_000),
      now: asTimestamp(10_000),
    }]);
    expect(finishes).toEqual([{
      dedupeKey: buildDriveCommentMentionDedupeKey(source),
      status: "completed",
      resultText: ack,
      now: asTimestamp(10_000),
    }]);
  });

  test("a failed dispatch never sends the ack and marks the mention failed", async () => {
    const source = scriptDeliverySource();
    const replies: Array<{ text: string }> = [];
    const finishes: Array<Record<string, unknown>> = [];
    const responseLogFinishes: Array<Record<string, unknown>> = [];

    const processor = createDriveCommentMentionProcessor({
      callerSessionName: "pinglunmaster",
      clock: { now: () => asTimestamp(10_000) },
      mentionRegistry: scriptRegistry(),
      scriptDispatcher: async () => {
        throw new Error("script delivery dispatch failed: spawn ENOENT");
      },
      store: {
        ...sweepStoreStubs,
        async findSessionByName() {
          return null;
        },
        async claimDriveCommentMention() {
          return true;
        },
        async finishDriveCommentMention(input: Record<string, unknown>) {
          finishes.push(input);
        },
        async recordResponseLog() {},
        async finishResponseLog(input: Record<string, unknown>) {
          responseLogFinishes.push(input);
        },
      },
      lark: scriptLark(replies),
      childSession: {
        async spawnChild() {
          throw new Error("script delivery must not spawn a session");
        },
      },
    });

    await processor.handle(source);

    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).not.toContain(ack);
    expect(replies[0]!.text).toContain("处理失败");
    expect(responseLogFinishes[0]).toMatchObject({ responseStatus: "failed" });
    expect(finishes).toEqual([{
      dedupeKey: buildDriveCommentMentionDedupeKey(source),
      status: "failed",
      errorMessage: "script delivery dispatch failed: spawn ENOENT",
      now: asTimestamp(10_000),
    }]);
  });
});
