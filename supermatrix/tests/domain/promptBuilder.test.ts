import { describe, expect, test } from "vitest";
import { buildPromptWithAttachments } from "../../src/domain/promptBuilder.ts";
import { asAbsolutePath, asSessionId, asTimestamp } from "../../src/domain/ids.ts";
import type { AttachmentRef } from "../../src/ports/BindingStore.ts";

function att(overrides: Partial<AttachmentRef>): AttachmentRef {
  return {
    id: "a",
    sessionId: asSessionId("s1"),
    kind: "file",
    localPath: asAbsolutePath("/ws/foo/.attachments/a.pdf"),
    originalName: "a.pdf",
    uploadedAt: asTimestamp(1),
    ...overrides,
  };
}

describe("buildPromptWithAttachments", () => {
  test("no attachments leaves prompt unchanged", () => {
    const out = buildPromptWithAttachments("hello", [], "/ws/foo");
    expect(out).toBe("hello");
  });

  test("image attachments append a Read instruction for viewing", () => {
    const out = buildPromptWithAttachments(
      "see this image",
      [att({ kind: "image", originalName: "a.png", localPath: asAbsolutePath("/ws/foo/.attachments/a.png") })],
      "/ws/foo"
    );
    expect(out).toContain("see this image");
    expect(out).toContain("Read");
    expect(out).toContain("图片");
    expect(out).toContain("./.attachments/a.png");
    expect(out).toContain("a.png");
  });

  test("file attachments append a Read instruction", () => {
    const out = buildPromptWithAttachments("check this", [att({})], "/ws/foo");
    expect(out).toContain("check this");
    expect(out).toContain("Read");
    expect(out).toContain("./.attachments");
    expect(out).toContain("a.pdf");
  });

  test("mixed image + file attachments produce both sections", () => {
    const out = buildPromptWithAttachments(
      "review",
      [
        att({ kind: "image", originalName: "shot.png", localPath: asAbsolutePath("/ws/foo/.attachments/shot.png") }),
        att({ kind: "file", originalName: "doc.pdf" }),
      ],
      "/ws/foo"
    );
    expect(out).toContain("图片");
    expect(out).toContain("shot.png");
    expect(out).toContain("文件");
    expect(out).toContain("doc.pdf");
  });
});
