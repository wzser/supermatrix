import { describe, expect, test } from "vitest";
import { asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

describe("sqlite drive comment mention dedupe", () => {
  test("claim is idempotent and finish stores the target result", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      const first = await store.claimDriveCommentMention({
        dedupeKey: "doc_token:comment_1",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
        targetSession: "todomaster",
        matchedRule: "intent:todo",
        now: asTimestamp(1000),
      });
      const duplicate = await store.claimDriveCommentMention({
        dedupeKey: "doc_token:comment_1",
        eventId: "evt_1_retry",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
        targetSession: "dataquery",
        matchedRule: "intent:dataquery",
        now: asTimestamp(1001),
      });

      expect(first).toBe(true);
      expect(duplicate).toBe(false);

      await store.finishDriveCommentMention({
        dedupeKey: "doc_token:comment_1",
        status: "completed",
        resultText: "已记录",
        now: asTimestamp(2000),
      });

      await expect(store.findDriveCommentMention("doc_token:comment_1")).resolves.toMatchObject({
        dedupeKey: "doc_token:comment_1",
        eventId: "evt_1",
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        fromUserId: "ou_user",
        targetSession: "todomaster",
        matchedRule: "intent:todo",
        status: "completed",
        resultText: "已记录",
        errorMessage: null,
        createdAt: 1000,
        updatedAt: 2000,
        finishedAt: 2000,
      });
    } finally {
      await cleanup();
    }
  });

  test("response log is local authoritative and tracks mirror state separately", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.recordResponseLog({
        responseId: "pm-doc_comment-deadbeef-1",
        source: "doc_comment",
        sourceRef: "docx:doc_token:comment_1:root",
        sourceUrl: "https://example.test/doc",
        mentioner: "ou_user",
        mentionedAt: asTimestamp(1000),
        triggerText: "帮我记一个待办",
        createdAt: asTimestamp(1000),
      });

      await expect(store.findResponseLog("pm-doc_comment-deadbeef-1")).resolves.toMatchObject({
        responseId: "pm-doc_comment-deadbeef-1",
        source: "doc_comment",
        sourceRef: "docx:doc_token:comment_1:root",
        sourceUrl: "https://example.test/doc",
        mentioner: "ou_user",
        mentionedAt: 1000,
        triggerText: "帮我记一个待办",
        responseText: null,
        responseStatus: "deferred",
        mirrorStatus: "pending",
        mirrorRecordId: null,
        mirrorRetryCount: 0,
      });

      await store.finishResponseLog({
        responseId: "pm-doc_comment-deadbeef-1",
        responseStatus: "sent",
        responseText: "已记录",
        responseAt: asTimestamp(2000),
        now: asTimestamp(2000),
      });
      await store.markResponseLogMirrorOk("pm-doc_comment-deadbeef-1", "rec_1", asTimestamp(3000));

      await expect(store.findResponseLog("pm-doc_comment-deadbeef-1")).resolves.toMatchObject({
        responseStatus: "sent",
        responseText: "已记录",
        responseAt: 2000,
        mirrorStatus: "ok",
        mirrorRecordId: "rec_1",
        mirrorSyncedAt: 3000,
        mirrorError: null,
      });
    } finally {
      await cleanup();
    }
  });
});
