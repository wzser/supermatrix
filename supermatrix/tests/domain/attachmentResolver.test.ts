import { describe, expect, test } from "vitest";
import { resolveAttachments } from "../../src/domain/attachmentResolver.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { AttachmentRef } from "../../src/ports/BindingStore.ts";

const sess = asSessionId("s1");

function att(overrides: Partial<AttachmentRef>): AttachmentRef {
  return {
    id: "a",
    sessionId: sess,
    kind: "file",
    localPath: asAbsolutePath("/tmp/a.pdf"),
    originalName: "a.pdf",
    uploadedAt: asTimestamp(1),
    ...overrides,
  };
}

describe("resolveAttachments", () => {
  test("current-message attachments always included", () => {
    const now = att({ originalName: "now.pdf", uploadedAt: asTimestamp(9) });
    const out = resolveAttachments({ prompt: "hi", current: [now], history: [] });
    expect(out).toEqual([now]);
  });

  test("explicit filename match in prompt picks from history", () => {
    const old = att({ id: "a1", originalName: "report.pdf", uploadedAt: asTimestamp(1) });
    const out = resolveAttachments({
      prompt: "look at report.pdf",
      current: [],
      history: [old],
    });
    expect(out).toEqual([old]);
  });

  test("type hint picks most recent of that kind", () => {
    const oldImg = att({ id: "a1", kind: "image", originalName: "old.png", uploadedAt: asTimestamp(1) });
    const newImg = att({ id: "a2", kind: "image", originalName: "new.png", uploadedAt: asTimestamp(5) });
    const out = resolveAttachments({
      prompt: "这张图片什么意思",
      current: [],
      history: [oldImg, newImg],
    });
    expect(out).toEqual([newImg]);
  });

  test("no match returns empty", () => {
    const old = att({ id: "a1", originalName: "report.pdf", uploadedAt: asTimestamp(1) });
    const out = resolveAttachments({ prompt: "hello", current: [], history: [old] });
    expect(out).toEqual([]);
  });
});
