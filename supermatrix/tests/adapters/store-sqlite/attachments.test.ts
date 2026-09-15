import { describe, expect, test } from "vitest";
import { asAbsolutePath, asLarkGroupId, asSessionId, asTimestamp } from "../../../src/domain/ids.ts";
import { createTempStore } from "./helpers.ts";

const BASE = {
  name: "foo",
  scope: "user" as const,
  backend: "claude" as const,
  workdir: asAbsolutePath("/tmp/ws/foo"),
  purpose: "",
  createdAt: asTimestamp(1_700_000_000_000),
};

describe("SqliteBindingStore attachments", () => {
  test("recordAttachment then list", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      const att = await store.recordAttachment({
        sessionId: asSessionId("s1"),
        kind: "image",
        localPath: asAbsolutePath("/tmp/ws/foo/.attachments/a.png"),
        originalName: "a.png",
        mimeType: "image/png",
        uploadedAt: asTimestamp(1_700_000_100_000),
      });
      expect(att.id).toBeTruthy();
      const list = await store.listSessionAttachments(asSessionId("s1"));
      expect(list).toHaveLength(1);
      expect(list[0].originalName).toBe("a.png");
    } finally {
      await cleanup();
    }
  });

  test("list ordered by uploaded_at DESC", async () => {
    const { store, cleanup } = await createTempStore();
    try {
      await store.createSessionWithBinding(
        { id: asSessionId("s1"), ...BASE },
        asLarkGroupId("oc_1")
      );
      await store.recordAttachment({
        sessionId: asSessionId("s1"),
        kind: "file",
        localPath: asAbsolutePath("/tmp/a.pdf"),
        originalName: "a.pdf",
        uploadedAt: asTimestamp(1_700_000_100_000),
      });
      await store.recordAttachment({
        sessionId: asSessionId("s1"),
        kind: "file",
        localPath: asAbsolutePath("/tmp/b.pdf"),
        originalName: "b.pdf",
        uploadedAt: asTimestamp(1_700_000_200_000),
      });
      const list = await store.listSessionAttachments(asSessionId("s1"));
      expect(list.map((a) => a.originalName)).toEqual(["b.pdf", "a.pdf"]);
    } finally {
      await cleanup();
    }
  });
});
